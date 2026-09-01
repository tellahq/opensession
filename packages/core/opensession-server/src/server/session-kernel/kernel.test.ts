import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  SESSION_KERNEL_SCHEMA_VERSION,
  SESSION_KERNEL_MAX_CREATION_EFFECT_RECEIPTS,
  SessionKernelStore,
  __setSessionKernelStoreForTest,
  activeSessionKernels,
  clearSessionKernel,
  durableSessionCommand,
  passivateIdleSessionKernels,
  DeliveryOwnedMap,
  type CreationOpeningEffectItem,
  deliveryInterruptForAnchor,
  sessionKernel,
  tombstoneSessionKernel,
  targetForDeliveryInterrupt,
  targetForTurnCancel,
} from ".";

let store: SessionKernelStore;
let previous: SessionKernelStore | undefined;

beforeEach(() => {
  store = new SessionKernelStore(":memory:");
  previous = __setSessionKernelStoreForTest(store);
});

afterEach(() => {
  __setSessionKernelStoreForTest(previous);
  store.close();
});

test("tracked schema version matches the store reader", async () => {
  expect(
    Number(
      readFileSync(join(import.meta.dir, "schema-version"), "utf8").trim(),
    ),
  ).toBe(SESSION_KERNEL_SCHEMA_VERSION);
});

test("refuses an unsafe schema downgrade", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-kernel-newer-schema-"));
  const path = join(dir, "kernel.sqlite");
  const newer = new Database(path);
  newer.exec(`PRAGMA user_version = ${SESSION_KERNEL_SCHEMA_VERSION + 1}`);
  newer.close();
  try {
    expect(() => new SessionKernelStore(path)).toThrow("newer than supported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("active command recovery uses the selective status index", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-kernel-active-index-"));
  const path = join(dir, "kernel.sqlite");
  const durableStore = new SessionKernelStore(path);
  durableStore.close();
  const db = new Database(path, { readonly: true });
  try {
    const plan = db
      .query(`EXPLAIN QUERY PLAN
				SELECT request_id, type, status, replay_safe
				FROM session_kernel_commands
				WHERE session_id = ?
				  AND status IN ('pending', 'processing', 'indeterminate')`)
      .all("indexed-session") as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "idx_skc_active_session_status",
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-only mirrors observe later WAL commits and cannot mutate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-kernel-read-mirror-"));
  const path = join(dir, "kernel.sqlite");
  const writer = new SessionKernelStore(path);
  const mirror = new SessionKernelStore(path, { readonly: true });
  try {
    expect(mirror.deliverySnapshot("mirror").queued).toEqual([]);
    writer.setDeliverySlot("mirror", "queued", [{ id: "committed" }]);
    expect(mirror.deliverySnapshot("mirror").queued).toEqual([
      { id: "committed" },
    ]);
    expect(() =>
      mirror.setDeliverySlot("mirror", "queued", [{ id: "forbidden" }]),
    ).toThrow();
  } finally {
    mirror.close();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session lanes refresh change sequences written through another lane", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-kernel-lane-sequence-"));
  const path = join(dir, "kernel.sqlite");
  const sessionLane = new SessionKernelStore(path);
  const catalogLane = new SessionKernelStore(path);
  try {
    expect(
      sessionLane.applyRunEvent({
        sessionId: "cross-lane-sequence",
        event: "prompt",
        runKey: "run-one",
      }),
    ).toMatchObject({ accepted: true, state: { changeSeq: 1 } });
    expect(
      catalogLane.appendChange("cross-lane-sequence", "catalog_lane_mutation"),
    ).toBe(2);
    expect(
      sessionLane.applyRunEvent({
        sessionId: "cross-lane-sequence",
        event: "run_registered",
        runKey: "run-one",
      }),
    ).toMatchObject({ accepted: true, state: { changeSeq: 3 } });
    expect(
      sessionLane
        .changesSince("cross-lane-sequence", 0)
        .map((change) => change.changeSeq),
    ).toEqual([1, 2, 3]);
  } finally {
    catalogLane.close();
    sessionLane.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("durable cancel and interrupt receipts restore their original command target", async () => {
  expect(
    targetForTurnCancel(
      {
        cancelId: "stop:request-one",
        phase: "settled",
        outcome: "confirmed",
        runId: "dispatch-one",
        runGeneration: 7,
        requeueIds: [],
        source: "test",
      },
      "stop:request-one",
    ),
  ).toEqual({ runId: "dispatch-one", generation: 7 });
  expect(targetForTurnCancel(undefined, "stop:request-one")).toBeUndefined();
  expect(
    targetForDeliveryInterrupt(
      {
        interruptId: "interrupt-one",
        phase: "confirmed",
        runGeneration: 8,
        dispatchId: "dispatch-two",
        anchorId: "request-two",
      },
      "request-two",
    ),
  ).toEqual({ runId: "dispatch-two", generation: 8 });
  expect(targetForDeliveryInterrupt(undefined, "request-two")).toBeUndefined();
  expect(
    deliveryInterruptForAnchor(
      {
        revision: 1,
        queued: [],
        dispatch: {
          interrupt: {
            interruptId: "interrupt-two",
            phase: "confirmed",
            runGeneration: 9,
            dispatchId: "dispatch-three",
            anchorId: "request-three",
          },
        },
        steered: [],
        pendingSteers: [],
        updatedAt: 1,
      },
      "request-three",
    ),
  ).toMatchObject({
    interruptId: "interrupt-two",
    dispatchId: "dispatch-three",
  });
});

test("boot maintenance compacts change history in bounded batches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-kernel-maintenance-"));
  const path = join(dir, "kernel.sqlite");
  const initial = new SessionKernelStore(path);
  initial.close();
  const seed = new Database(path);
  const insert = seed.query(
    `INSERT INTO session_kernel_changes
		 (session_id, change_seq, kind, payload, created_at)
		 VALUES (?, ?, 'test', '{}', ?)`,
  );
  seed.transaction(() => {
    for (let changeSeq = 1; changeSeq <= 5_501; changeSeq += 1)
      insert.run("busy", changeSeq, changeSeq);
  })();
  seed.close();
  const compacting = new SessionKernelStore(path);
  try {
    expect(compacting.maintain()).toBe(true);
    expect(compacting.maintain()).toBe(true);
    expect(compacting.maintain()).toBe(false);
  } finally {
    compacting.close();
  }
  const inspect = new Database(path, { readonly: true });
  try {
    expect(
      (
        inspect
          .query("SELECT COUNT(*) AS count FROM session_kernel_changes")
          .get() as {
          count: number;
        }
      ).count,
    ).toBe(5_000);
  } finally {
    inspect.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema 6 upgrades create autonomous creation, delivery and ask state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-kernel-schema-"));
  const path = join(dir, "kernel.sqlite");
  const legacy = new Database(path);
  legacy.exec("PRAGMA user_version = 6");
  legacy.close();
  const upgraded = new SessionKernelStore(path);
  try {
    expect(upgraded.stats().schemaVersion).toBe(SESSION_KERNEL_SCHEMA_VERSION);
    upgraded.setDeliverySlot("upgrade", "queued", [
      { id: "queued", content: "kept" },
    ]);
    upgraded.setAskRecord("upgrade", {
      questionId: "ask",
      questions: [],
    });
    expect(upgraded.deliverySnapshot("upgrade").queued).toHaveLength(1);
    expect(upgraded.askSnapshot("upgrade")).toMatchObject({
      questionId: "ask",
    });
    expect(
      upgraded.applyCreationEvent({
        sessionId: "upgrade",
        identity: "create-request",
        event: "plan",
      }),
    ).toMatchObject({ accepted: true, to: "planned" });
  } finally {
    upgraded.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SessionKernel", () => {
  test("fails closed replay but accepts exact settlement after actor restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-kernel-projection-crash-"));
    const path = join(dir, "kernel.sqlite");
    let durableStore = new SessionKernelStore(path);
    try {
      expect(
        durableStore.requestGatewayCommand({
          sessionId: "projection-crash",
          requestId: "write-one",
          operation: "session_file_updated",
        }),
      ).toEqual({ status: "execute" });
      durableStore.close();
      durableStore = new SessionKernelStore(path);
      expect(
        durableStore.command("projection-crash", "write-one"),
      ).toMatchObject({
        status: "indeterminate",
        error: "actor restarted after execution began",
      });
      expect(() =>
        durableStore.requestGatewayCommand({
          sessionId: "projection-crash",
          requestId: "write-one",
          operation: "session_file_updated",
        }),
      ).toThrow("actor restarted after execution began");

      expect(
        durableStore.completeGatewayCommand({
          sessionId: "projection-crash",
          requestId: "write-one",
          operation: "session_file_updated",
          result: "written",
        }),
      ).toBe("written");
      expect(
        durableStore.command("projection-crash", "write-one"),
      ).toMatchObject({
        status: "completed",
        result: "written",
      });

      expect(
        durableStore.requestGatewayCommand({
          sessionId: "projection-crash",
          requestId: "write-two",
          operation: "session_file_updated",
        }),
      ).toEqual({ status: "execute" });
      durableStore.close();
      durableStore = new SessionKernelStore(path);
      durableStore.failGatewayCommand({
        sessionId: "projection-crash",
        requestId: "write-two",
        operation: "session_file_updated",
        error: "destination rejected the write",
        retryable: false,
      });
      expect(
        durableStore.command("projection-crash", "write-two"),
      ).toMatchObject({
        status: "failed",
        error: "destination rejected the write",
      });
    } finally {
      durableStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("abandons a stranded gateway settlement when safely releasing quarantine", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-kernel-gateway-repair-"));
    const path = join(dir, "kernel.sqlite");
    let durableStore = new SessionKernelStore(path);
    try {
      expect(
        durableStore.requestGatewayCommand({
          sessionId: "projection-repair",
          requestId: "write-one",
          operation: "session_file_updated",
        }),
      ).toEqual({ status: "execute" });
      durableStore.close();
      durableStore = new SessionKernelStore(path);
      expect(
        durableStore.requestSubmitPromptCommand({
          sessionId: "projection-repair",
          requestId: "delivery-recovery",
          identity: { content: "follow up", attachmentsHash: "none" },
        }),
      ).toEqual({ status: "execute" });
      durableStore.setRunState({
        sessionId: "projection-repair",
        state: "running",
        event: "prompt",
        currentRunId: "live-run",
      });
      const outcomeEffect = durableStore.enqueueOutbox(
        "projection-repair",
        "turn_outcome_project",
        { projectionId: "outcome:live-run" },
        "outcome:live-run",
      );
      durableStore.enqueueOutbox(
        "projection-repair",
        "turn_cancel",
        {
          cancelId: "cancel:live-run",
          dispatchId: "live-run",
          runGeneration: 1,
        },
        "cancel:live-run",
      );
      const oldDeadEffect = durableStore.enqueueOutbox(
        "projection-repair",
        "human_ask_deliver",
        { askId: "old-dead-ask", skipUi: false },
        "old-dead-ask",
      );
      for (let attempt = 0; attempt < 20; attempt += 1)
        durableStore.noteOutboxFailure(oldDeadEffect, "already abandoned", 20);
      durableStore.quarantineSession(
        "projection-repair",
        "actor restarted after execution began",
        "gateway:complete",
      );

      expect(
        durableStore.quarantinedSession("projection-repair"),
      ).toMatchObject({
        repairable: true,
      });
      expect(durableStore.releaseQuarantine("projection-repair")).toBe(true);
      expect(
        durableStore.quarantinedSession("projection-repair"),
      ).toBeUndefined();
      expect(
        durableStore.command("projection-repair", "write-one"),
      ).toMatchObject({
        status: "failed",
        retryable: false,
      });
      expect(
        durableStore.command("projection-repair", "delivery-recovery"),
      ).toMatchObject({
        status: "failed",
        replaySafe: true,
        retryable: true,
      });
      expect(durableStore.pendingOutbox(Date.now(), 10)).toContainEqual(
        expect.objectContaining({
          id: outcomeEffect,
          kind: "turn_outcome_project",
        }),
      );
      // Releasing the gateway fence does not invent a terminal run outcome. The
      // still-owned run can now finish its ordinary settlement in the same session.
      expect(durableStore.runState("projection-repair")).toMatchObject({
        state: "running",
        currentRunId: "live-run",
      });
    } finally {
      durableStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps unrelated pending effects fail-closed during gateway repair", () => {
    store.enqueueOutbox(
      "effect-repair",
      "human_ask_deliver",
      { askId: "ask-one", skipUi: false },
      "ask-one",
    );
    store.quarantineSession(
      "effect-repair",
      "actor restarted after execution began",
      "gateway:complete",
    );
    expect(store.quarantinedSession("effect-repair")).toMatchObject({
      repairable: false,
    });
    expect(store.releaseQuarantine("effect-repair")).toBe(false);
  });

  test("accepts an exact replay-safe completion from a caller that survived actor restart", () => {
    const dir = mkdtempSync(
      join(tmpdir(), "session-kernel-gateway-settlement-"),
    );
    const path = join(dir, "kernel.sqlite");
    let durableStore = new SessionKernelStore(path);
    const input = {
      sessionId: "gateway-settlement",
      requestId: "command-one",
      operation: "websocket_command" as const,
      identity: { command: "cancel", targetRunId: "run-one" },
    };
    try {
      expect(durableStore.requestGatewayCommand(input)).toEqual({
        status: "execute",
      });
      durableStore.close();
      durableStore = new SessionKernelStore(path);
      expect(
        durableStore.command(input.sessionId, input.requestId),
      ).toMatchObject({
        status: "failed",
        replaySafe: true,
        retryable: true,
      });
      expect(
        durableStore.completeGatewayCommand({
          ...input,
          result: { cancelled: true },
        }),
      ).toEqual({ cancelled: true });
    } finally {
      durableStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("re-admits only destination-idempotent gateway work after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-kernel-gateway-replay-"));
    const path = join(dir, "kernel.sqlite");
    let durableStore = new SessionKernelStore(path);
    const input = {
      sessionId: "gateway-replay",
      requestId: "command-one",
      operation: "websocket_command" as const,
      identity: { command: "cancel", targetRunId: "run-one" },
    };
    try {
      expect(durableStore.requestGatewayCommand(input)).toEqual({
        status: "execute",
      });
      durableStore.close();
      durableStore = new SessionKernelStore(path);
      expect(durableStore.requestGatewayCommand(input)).toEqual({
        status: "execute",
      });
    } finally {
      durableStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("re-admits only the narrow destination transcript operation after restart", () => {
    const dir = mkdtempSync(
      join(tmpdir(), "session-kernel-transcript-destination-"),
    );
    const path = join(dir, "kernel.sqlite");
    let durableStore = new SessionKernelStore(path);
    const input = {
      sessionId: "destination-replay",
      requestId: "transcript-destination:append-one",
      operation: "transcript_destination_append" as const,
      identity: {
        digest: "digest-one",
        fence: { runId: "run", turnId: "turn", generation: 1 },
      },
    };
    try {
      expect(durableStore.requestGatewayCommand(input)).toEqual({
        status: "execute",
      });
      durableStore.close();
      durableStore = new SessionKernelStore(path);
      expect(durableStore.requestGatewayCommand(input)).toEqual({
        status: "execute",
      });
      expect(() =>
        durableStore.requestGatewayCommand({
          ...input,
          identity: { ...input.identity, digest: "changed" },
        }),
      ).toThrow("reused with another payload");
    } finally {
      durableStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a session tombstone fences a stale destination append after receipt cleanup", () => {
    const sessionId = "deleted-transcript-destination";
    store.tombstoneSession(sessionId);
    expect(() =>
      store.requestGatewayCommand({
        sessionId,
        requestId: "transcript-destination:stale",
        operation: "transcript_destination_append",
        identity: { digest: "stale" },
      }),
    ).toThrow(`Session ${sessionId} was deleted`);
  });

  test("deduplicates deletion before and after its permanent tombstone", async () => {
    const input = {
      sessionId: "delete-once",
      requestId: "delete:delete-once",
      operation: "delete_session" as const,
      identity: { cleanWorktree: true },
    };
    expect(store.requestGatewayCommand(input)).toEqual({ status: "execute" });
    expect(store.requestGatewayCommand(input)).toEqual({
      status: "in_progress",
    });
    store.tombstoneSession(input.sessionId);
    expect(store.requestGatewayCommand(input)).toEqual({
      status: "completed",
      result: { status: 200, body: { ok: true } },
      duplicate: true,
    });
  });

  test("replays typed submit-prompt results under one immutable identity", async () => {
    const input = {
      sessionId: "typed-submit",
      requestId: "delivery-one",
      identity: { content: "hello", attachmentsHash: "none" },
    };
    expect(store.requestSubmitPromptCommand(input)).toEqual({
      status: "execute",
    });
    expect(store.requestSubmitPromptCommand(input)).toEqual({
      status: "in_progress",
    });
    expect(() =>
      store.requestSubmitPromptCommand({
        ...input,
        identity: { content: "changed", attachmentsHash: "none" },
      }),
    ).toThrow("reused with another payload");
    const result = {
      status: "queued",
      message: "Queued behind the current run.",
      deliveryId: input.requestId,
    };
    expect(
      store.completeSubmitPromptCommand({
        sessionId: input.sessionId,
        requestId: input.requestId,
        result,
      }),
    ).toEqual(result);
    expect(store.requestSubmitPromptCommand(input)).toEqual({
      status: "completed",
      result,
      duplicate: true,
    });
  });

  test("adopts a queued submit after a crash before command completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-kernel-submit-replay-"));
    const path = join(dir, "kernel.sqlite");
    let durableStore = new SessionKernelStore(path);
    const input = {
      sessionId: "submit-replay",
      requestId: "delivery-replay",
      identity: { content: "hello", attachmentsHash: "none" },
    };
    try {
      expect(durableStore.requestSubmitPromptCommand(input)).toEqual({
        status: "execute",
      });
      durableStore.setDeliverySlot(input.sessionId, "queued", [
        { id: input.requestId, content: "hello" },
      ]);
      durableStore.close();
      durableStore = new SessionKernelStore(path);
      expect(durableStore.requestSubmitPromptCommand(input)).toEqual({
        status: "execute",
      });
      expect(durableStore.deliverySnapshot(input.sessionId).queued).toEqual([
        { id: input.requestId, content: "hello" },
      ]);
      const result = {
        status: "queued",
        message: "Queued behind the current run.",
        deliveryId: input.requestId,
      };
      durableStore.completeSubmitPromptCommand({
        sessionId: input.sessionId,
        requestId: input.requestId,
        result,
      });
      expect(durableStore.requestSubmitPromptCommand(input)).toEqual({
        status: "completed",
        result,
        duplicate: true,
      });
    } finally {
      durableStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts and repairs exact submit settlements across an actor restart", () => {
    const dir = mkdtempSync(
      join(tmpdir(), "session-kernel-submit-settlement-"),
    );
    const path = join(dir, "kernel.sqlite");
    let durableStore = new SessionKernelStore(path);
    const input = {
      sessionId: "submit-settlement",
      requestId: "delivery-settlement",
      identity: { content: "hello", attachmentsHash: "none" },
    };
    try {
      expect(
        durableStore.requestGatewayCommand({
          sessionId: input.sessionId,
          requestId: "older-transcript-write",
          operation: "transcript_append",
        }),
      ).toEqual({ status: "execute" });
      expect(durableStore.requestSubmitPromptCommand(input)).toEqual({
        status: "execute",
      });
      durableStore.close();
      durableStore = new SessionKernelStore(path);
      expect(
        durableStore.command(input.sessionId, input.requestId),
      ).toMatchObject({
        status: "failed",
        replaySafe: true,
        retryable: true,
      });
      expect(
        durableStore.completeSubmitPromptCommand({
          sessionId: input.sessionId,
          requestId: input.requestId,
          result: { status: "queued" },
        }),
      ).toEqual({ status: "queued" });

      const recovery = { ...input, requestId: "delivery-recovery" };
      expect(durableStore.requestSubmitPromptCommand(recovery)).toEqual({
        status: "execute",
      });
      durableStore.quarantineSession(
        input.sessionId,
        "actor restarted before execution admission",
        "delivery:complete_submit_command",
      );
      expect(durableStore.quarantinedSession(input.sessionId)).toMatchObject({
        repairable: true,
      });
      expect(durableStore.releaseQuarantine(input.sessionId)).toBe(true);
      expect(
        durableStore.command(input.sessionId, recovery.requestId),
      ).toMatchObject({
        status: "failed",
        replaySafe: true,
        retryable: true,
      });
      expect(
        durableStore.command(input.sessionId, "older-transcript-write"),
      ).toMatchObject({
        status: "failed",
        replaySafe: false,
        retryable: false,
      });
      expect(durableStore.requestSubmitPromptCommand(recovery)).toEqual({
        status: "execute",
      });
    } finally {
      durableStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("turns pre-execution pending admission into a durable retry receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-kernel-pending-restart-"));
    const path = join(dir, "kernel.sqlite");
    const firstStore = new SessionKernelStore(path);
    firstStore.acceptCommand({
      sessionId: "pending-restart",
      requestId: "accepted-not-started",
      type: "session_file_updated",
      payload: { value: 1 },
    });
    firstStore.close();
    const recovered = new SessionKernelStore(path);
    try {
      expect(
        recovered.command("pending-restart", "accepted-not-started"),
      ).toMatchObject({
        status: "failed",
        replaySafe: true,
        retryable: true,
        error: "actor restarted before execution admission",
      });
      expect(recovered.stats()).toMatchObject({
        pendingCommands: 0,
        indeterminateCommands: 0,
        oldestPendingCommandAt: undefined,
      });
    } finally {
      recovered.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("backfills pre-policy processing receipts as replay-safe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-kernel-policy-migration-"));
    const path = join(dir, "kernel.sqlite");
    const db = new Database(path);
    db.exec(`
			CREATE TABLE session_kernel_commands (
				session_id TEXT NOT NULL, request_id TEXT NOT NULL, type TEXT NOT NULL,
				payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
				PRIMARY KEY (session_id, request_id)
			);
		`);
    db.run(
      `INSERT INTO session_kernel_commands
			 (session_id, request_id, type, payload, status, created_at, updated_at)
			 VALUES ('legacy', 'request', 'submit_prompt', '{}', 'processing', 1, 1)`,
    );
    db.close();
    const migrated = new SessionKernelStore(path);
    try {
      expect(migrated.command("legacy", "request")).toMatchObject({
        status: "failed",
        replaySafe: true,
        retryable: true,
      });
    } finally {
      migrated.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("promotes replay policy without changing request identity", async () => {
    store.acceptCommand({
      sessionId: "promote",
      requestId: "same",
      type: "submit",
      payload: { value: 1 },
    });
    const promoted = store.acceptCommand({
      sessionId: "promote",
      requestId: "same",
      type: "submit",
      payload: { value: 1 },
      replaySafe: true,
    });
    expect(promoted.replaySafe).toBe(true);
  });

  test("fails closed on interrupted work that was not declared replay-safe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-kernel-indeterminate-"));
    const path = join(dir, "kernel.sqlite");
    const firstStore = new SessionKernelStore(path);
    firstStore.acceptCommand({
      sessionId: "uncertain",
      requestId: "physical",
      type: "physical_write",
    });
    firstStore.markProcessing("uncertain", "physical");
    firstStore.close();
    const secondStore = new SessionKernelStore(path);
    try {
      expect(secondStore.command("uncertain", "physical")).toMatchObject({
        status: "indeterminate",
        retryable: false,
      });
      expect(secondStore.stats()).toMatchObject({
        pendingCommands: 0,
        indeterminateCommands: 1,
        oldestPendingCommandAt: undefined,
      });
      expect(secondStore.stats().oldestIndeterminateCommandAt).toBeNumber();
    } finally {
      secondStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stale run cannot retake ownership from the current generation", async () => {
    const { transitionRunState } = await import("../run-state");
    const id = `fence-${crypto.randomUUID()}`;
    try {
      await transitionRunState(id, "prompt");
      await transitionRunState(id, "run_registered", { run_key: "run-new" });
      const generation = sessionKernel(id).runStateProjection().generation;
      await transitionRunState(id, "run_registered", { run_key: "run-old" });
      expect(sessionKernel(id).runStateProjection()).toMatchObject({
        state: "running",
        currentRunId: "run-new",
        generation,
      });
    } finally {
      clearSessionKernel(id);
    }
  });

  test("keeps deletion tombstones permanent", async () => {
    store.tombstoneSession("deleted-forever");
    expect(
      store.isTombstoned(
        "deleted-forever",
        Date.now() + 365 * 24 * 60 * 60_000,
      ),
    ).toBe(true);
  });

  test("rejects a run event after a writable preflight races deletion", () => {
    const sessionId = "deleted-before-run-event";
    expect(store.isTombstoned(sessionId)).toBe(false);
    store.tombstoneSession(sessionId);
    expect(() => store.applyRunEvent({ sessionId, event: "prompt" })).toThrow(
      `Session ${sessionId} was deleted`,
    );
    expect(store.runState(sessionId).state).toBe("idle");
  });

  test("persists run state and monotonic change sequence", async () => {
    const kernel = sessionKernel("s1");
    expect(kernel.runStateProjection().state).toBe("idle");
    expect(
      store.setRunState({ sessionId: "a", state: "starting", event: "prompt" })
        .changeSeq,
    ).toBe(1);
    const running = store.setRunState({
      sessionId: "a",
      state: "running",
      event: "run_registered",
      generation: 1,
      currentRunId: "run-1",
    });
    expect(running).toMatchObject({
      state: "running",
      generation: 1,
      currentRunId: "run-1",
      changeSeq: 2,
    });
  });

  test("reduces and fences run events in one actor-store transaction", async () => {
    expect(
      store.applyRunEvent({ sessionId: "fsm", event: "prompt" }),
    ).toMatchObject({
      accepted: true,
      from: "idle",
      to: "starting",
    });
    expect(
      store.applyRunEvent({
        sessionId: "fsm",
        event: "run_registered",
        runKey: "run-1",
      }),
    ).toMatchObject({
      accepted: true,
      state: { state: "running", currentRunId: "run-1", generation: 1 },
    });
    expect(
      store.applyRunEvent({
        sessionId: "fsm",
        event: "run_registered",
        runKey: "stale",
      }),
    ).toMatchObject({
      accepted: false,
      reason: "stale_run",
      state: { currentRunId: "run-1", generation: 1, changeSeq: 2 },
    });
    expect(store.changesSince("fsm", 0)).toHaveLength(2);
  });

  test("owns creation transitions and rejects stale effect results", async () => {
    store.applyCreationEvent({
      sessionId: "create-opening-requires-effect",
      identity: "request-direct",
      event: "plan",
    });
    store.applyCreationEvent({
      sessionId: "create-opening-requires-effect",
      identity: "request-direct",
      event: "preparation_started",
    });
    expect(
      store.applyCreationEvent({
        sessionId: "create-opening-requires-effect",
        identity: "request-direct",
        event: "opening_dispatched",
      }),
    ).toMatchObject({ accepted: false, reason: "invalid_effect" });

    expect(
      store.applyCreationEvent({
        sessionId: "create-fsm",
        identity: "request-one",
        event: "plan",
      }),
    ).toMatchObject({
      accepted: true,
      to: "planned",
      state: { generation: 1, changeSeq: 1 },
    });
    expect(
      store.applyCreationEvent({
        sessionId: "create-fsm",
        identity: "request-one",
        event: "preparation_started",
        nextEffectId: "wrong-fence",
        effect: {
          kind: "creation_workspace_prepare",
          effectKey: "wrong-fence",
          payload: {
            creationIdentity: "another-request",
            creationGeneration: 1,
            workspaceId: "workspace-one",
            dedupeKey: "creation:workspace-one",
            name: "Workspace one",
            createdBy: "Alice",
            mode: "adopt_or_create",
          },
        },
      }),
    ).toMatchObject({
      accepted: false,
      reason: "invalid_effect",
      state: { state: "planned", changeSeq: 1 },
    });
    expect(
      store.applyCreationEvent({
        sessionId: "create-fsm",
        identity: "request-one",
        event: "preparation_started",
        nextEffectId: "prepare-one",
        effect: {
          kind: "creation_workspace_prepare",
          effectKey: "prepare-one",
          payload: {
            creationIdentity: "request-one",
            creationGeneration: 1,
            workspaceId: "workspace-one",
            dedupeKey: "creation:workspace-one",
            name: "Workspace one",
            createdBy: "Alice",
            mode: "adopt_or_create",
          },
        },
      }),
    ).toMatchObject({
      accepted: true,
      from: "planned",
      to: "preparing",
      state: { currentEffectId: "prepare-one", changeSeq: 2 },
    });
    expect(
      store.applyCreationEvent({
        sessionId: "create-fsm",
        identity: "request-one",
        event: "opening_dispatched",
        nextEffectId: "opening-one",
      }),
    ).toMatchObject({
      accepted: false,
      reason: "stale_effect",
      state: { state: "preparing", currentEffectId: "prepare-one" },
    });
    expect(
      store.applyCreationEvent({
        sessionId: "create-fsm",
        identity: "request-one",
        event: "opening_dispatched",
        effectId: "stale-prepare",
        nextEffectId: "opening-one",
      }),
    ).toMatchObject({
      accepted: false,
      reason: "stale_effect",
      state: { state: "preparing", currentEffectId: "prepare-one" },
    });
    expect(
      store.applyCreationEvent({
        sessionId: "create-fsm",
        identity: "request-one",
        event: "opening_dispatched",
        effectId: "prepare-one",
        nextEffectId: "opening-one",
        effect: {
          kind: "creation_opening_turn",
          effectKey: "opening-one",
          payload: {
            creationIdentity: "request-one",
            creationGeneration: 1,
            openingPromptEntryId: "entry-one",
            runId: "run-one",
            runGeneration: 1,
            mode: "adopt_or_launch",
          },
        },
      }),
    ).toMatchObject({
      accepted: false,
      reason: "invalid_opening_plan",
    });
    expect(
      store.applyCreationEvent({
        sessionId: "create-fsm",
        identity: "request-one",
        event: "opening_dispatched",
        effectId: "prepare-one",
        openingPlan: { id: "create-fsm", openingPrompt: "durable" },
        nextEffectId: "opening-one",
        effect: {
          kind: "creation_opening_turn",
          effectKey: "opening-one",
          payload: {
            creationIdentity: "request-one",
            creationGeneration: 1,
            openingPromptEntryId: "entry-one",
            runId: "run-one",
            runGeneration: 1,
            mode: "adopt_or_launch",
          },
        },
      }),
    ).toMatchObject({
      accepted: true,
      to: "opening_dispatched",
      state: {
        currentEffectId: "opening-one",
        openingPlan: { id: "create-fsm", openingPrompt: "durable" },
        changeSeq: 3,
      },
    });
    expect(
      store.applyCreationEvent({
        sessionId: "create-fsm",
        identity: "request-one",
        event: "succeeded",
        effectId: "opening-one",
      }),
    ).toMatchObject({
      accepted: true,
      to: "ready",
      state: {
        currentEffectId: undefined,
        openingPlan: undefined,
        changeSeq: 4,
      },
    });
    expect(
      store.applyCreationEvent({
        sessionId: "create-fsm",
        identity: "request-two",
        event: "plan",
      }),
    ).toMatchObject({
      accepted: false,
      reason: "identity_mismatch",
    });
    expect(store.changesSince("create-fsm", 0)).toHaveLength(4);
    expect(store.pendingOutbox()).toMatchObject([
      { kind: "creation_workspace_prepare", effectKey: "prepare-one" },
      { kind: "creation_opening_turn", effectKey: "opening-one" },
    ]);
  });

  test("settles an actor opening from an exactly journaled local recovery", async () => {
    const sessionId = "local-opening-recovery";
    const identity = "local-opening-request";
    const promptEntryId = "local-opening-prompt";
    const effectId = `opening:${promptEntryId}`;
    expect(
      store.applyCreationEvent({ sessionId, identity, event: "plan" }).accepted,
    ).toBe(true);
    const preparationEffectId = "local-opening-preparation";
    expect(
      store.applyCreationEvent({
        sessionId,
        identity,
        event: "preparation_started",
        nextEffectId: preparationEffectId,
        effect: {
          kind: "creation_workspace_prepare",
          effectKey: preparationEffectId,
          payload: {
            creationIdentity: identity,
            creationGeneration: 1,
            workspaceId: "local-opening-workspace",
            dedupeKey: "local-opening-dedupe",
            name: "Local opening",
            createdBy: "Alice",
            mode: "adopt_or_create",
          },
        },
      }).accepted,
    ).toBe(true);
    expect(
      store.applyCreationEvent({
        sessionId,
        identity,
        event: "opening_dispatched",
        effectId: preparationEffectId,
        openingPlan: { id: sessionId, openingPrompt: "durable" },
        nextEffectId: effectId,
        effect: {
          kind: "creation_opening_turn",
          effectKey: effectId,
          payload: {
            creationIdentity: identity,
            creationGeneration: 1,
            openingPromptEntryId: promptEntryId,
            runId: `opening:${sessionId}:${promptEntryId}`,
            runGeneration: 1,
            mode: "adopt_or_launch",
          },
        },
      }).accepted,
    ).toBe(true);
    const { settleRecoveredCreationOpening } = await import("../run-session");
    expect(await settleRecoveredCreationOpening(sessionId, promptEntryId)).toBe(
      true,
    );
    const settled = store.creationState(sessionId);
    expect(settled?.state).toBe("ready");
    expect(settled?.completedEffectIds).toContain(effectId);
  });

  test("settles an exactly cancelled recovered opening without reviving it", async () => {
    const sessionId = "local-opening-cancel-recovery";
    const identity = "local-opening-cancel-request";
    const promptEntryId = "local-opening-cancel-prompt";
    const effectId = `opening:${promptEntryId}`;
    const runId = "rh-local-opening-cancel";
    store.applyCreationEvent({ sessionId, identity, event: "plan" });
    store.applyCreationEvent({
      sessionId,
      identity,
      event: "preparation_started",
    });
    store.applyCreationEvent({
      sessionId,
      identity,
      event: "opening_dispatched",
      openingPlan: { id: sessionId, openingPrompt: "cancel durable" },
      nextEffectId: effectId,
      effect: {
        kind: "creation_opening_turn",
        effectKey: effectId,
        payload: {
          creationIdentity: identity,
          creationGeneration: 1,
          openingPromptEntryId: promptEntryId,
          runId: `opening:${sessionId}:${promptEntryId}`,
          runGeneration: 1,
          mode: "adopt_or_launch",
        },
      },
    });
    store.applyRunEvent({ sessionId, event: "prompt", runKey: runId });
    const run = store.runState(sessionId);
    store.prepareTurnCancel({
      sessionId,
      cancelId: `stop:${runId}`,
      expectedRunId: runId,
      expectedGeneration: run.generation,
      dispatchId: runId,
      requeueIds: [],
      source: "test",
    });
    const { settleRecoveredCreationOpening } = await import("../run-session");
    expect(
      await settleRecoveredCreationOpening(
        sessionId,
        promptEntryId,
        undefined,
        runId,
      ),
    ).toBe(true);
    expect(store.creationState(sessionId)).toMatchObject({
      state: "cancelled",
      completedEffectIds: [effectId],
    });
  });

  test("derives an executor-compatible physical host id for opening recovery", async () => {
    const { runnerOpeningHostId } = await import("../session-create");
    const first = runnerOpeningHostId("logical-opening", 3);
    expect(first).toMatch(
      /^rh-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(runnerOpeningHostId("logical-opening", 3)).toBe(first);
    expect(runnerOpeningHostId("logical-opening", 4)).not.toBe(first);
  });

  test("settles a recovered opening when its journal retires after durable turn completion", async () => {
    const sessionId = `local-opening-retired-${crypto.randomUUID()}`;
    const identity = `local-opening-request-${crypto.randomUUID()}`;
    const promptEntryId = `local-opening-prompt-${crypto.randomUUID()}`;
    const effectId = `opening:${promptEntryId}`;
    const runId = `rh-opening-${crypto.randomUUID()}`;
    const item: CreationOpeningEffectItem = {
      id: 1,
      effectId: `${sessionId}:creation_opening_turn:${effectId}`,
      effectKey: effectId,
      sessionId,
      kind: "creation_opening_turn",
      payload: {
        creationIdentity: identity,
        creationGeneration: 1,
        openingPromptEntryId: promptEntryId,
        runId: `opening:${sessionId}:${promptEntryId}`,
        runGeneration: 1,
        mode: "adopt_or_launch",
      },
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: Date.now(),
    };
    store.claimDeliveryDispatch({
      sessionId,
      items: [{ id: "opening", content: "start" }],
      promptEntryId,
      kind: "create",
    });
    store.applyCreationEvent({ sessionId, identity, event: "plan" });
    store.applyCreationEvent({
      sessionId,
      identity,
      event: "preparation_started",
    });
    store.applyCreationEvent({
      sessionId,
      identity,
      event: "opening_dispatched",
      openingPlan: { id: sessionId, openingPrompt: "start" },
      nextEffectId: effectId,
      effect: {
        kind: item.kind,
        effectKey: item.effectKey,
        payload: item.payload,
      },
    });
    store.applyRunEvent({ sessionId, event: "prompt", runKey: runId });
    const { journalClear, journalSet } = await import("../run-journal");
    const { executeCreationOpeningEffect } = await import("../session-create");
    try {
      await journalSet({
        runKey: runId,
        hostId: runId,
        osSessionId: sessionId,
        promptEntryId,
        cwd: "/tmp",
        model: "pi/openai/gpt-5.6-sol",
        kind: "create",
        startedAt: new Date().toISOString(),
      });
      const settling = executeCreationOpeningEffect(item);
      await Bun.sleep(20);
      store.applyRunEvent({ sessionId, event: "turn_end", runKey: runId });
      journalClear(runId);
      await Promise.race([
        settling,
        Bun.sleep(2_000).then(() => {
          throw new Error("recovered opening did not reconcile");
        }),
      ]);
      expect(store.creationState(sessionId)).toMatchObject({
        state: "ready",
        completedEffectIds: [effectId],
      });
      expect(store.deliverySnapshot(sessionId).dispatch).toBeUndefined();
    } finally {
      journalClear(runId);
    }
  });

  test("clears an accepted creation effect so replay is a stale no-op", async () => {
    const sessionId = "create-result-replay";
    const identity = "request-result-replay";
    expect(
      store.applyCreationEvent({ sessionId, identity, event: "plan" }).accepted,
    ).toBe(true);
    expect(
      store.applyCreationEvent({
        sessionId,
        identity,
        event: "preparation_started",
        nextEffectId: "workspace-result-replay",
        effect: {
          kind: "creation_workspace_prepare",
          effectKey: "workspace-result-replay",
          payload: {
            creationIdentity: identity,
            creationGeneration: 1,
            workspaceId: "ws-result-replay",
            dedupeKey: "creation:result-replay",
            name: "Result replay",
            createdBy: "Alice",
            mode: "adopt_or_create",
          },
        },
      }).accepted,
    ).toBe(true);
    expect(
      store.applyCreationEvent({
        sessionId,
        identity,
        event: "preparation_started",
        effectId: "workspace-result-replay",
      }),
    ).toMatchObject({
      accepted: true,
      state: {
        state: "preparing",
        currentEffectId: undefined,
        completedEffectIds: ["workspace-result-replay"],
      },
    });
    expect(
      store.applyCreationEvent({
        sessionId,
        identity,
        event: "preparation_started",
        effectId: "workspace-result-replay",
      }),
    ).toMatchObject({ accepted: false, reason: "stale_effect" });
    const [settledEffect] = store.pendingOutbox();
    store.ackOutbox(settledEffect.id);
    expect(
      store.applyCreationEvent({
        sessionId,
        identity,
        event: "preparation_started",
        nextEffectId: "workspace-result-replay",
        effect: {
          kind: "creation_workspace_prepare",
          effectKey: "workspace-result-replay",
          payload: {
            creationIdentity: identity,
            creationGeneration: 1,
            workspaceId: "ws-result-replay",
            dedupeKey: "creation:result-replay",
            name: "Result replay",
            createdBy: "Alice",
            mode: "adopt_or_create",
          },
        },
      }),
    ).toMatchObject({ accepted: false, reason: "invalid_effect" });
    expect(store.pendingOutbox()).toHaveLength(0);
  });

  test("persists completed creation effect receipts across actor-store restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-kernel-create-receipt-"));
    const path = join(dir, "kernel.sqlite");
    let durableStore = new SessionKernelStore(path);
    try {
      const sessionId = "create-receipt-restart";
      const identity = "request-receipt-restart";
      durableStore.applyCreationEvent({ sessionId, identity, event: "plan" });
      durableStore.applyCreationEvent({
        sessionId,
        identity,
        event: "preparation_started",
        nextEffectId: "workspace-receipt-restart",
        effect: {
          kind: "creation_workspace_prepare",
          effectKey: "workspace-receipt-restart",
          payload: {
            creationIdentity: identity,
            creationGeneration: 1,
            workspaceId: "ws-receipt-restart",
            dedupeKey: "creation:receipt-restart",
            name: "Receipt restart",
            createdBy: "Alice",
            mode: "adopt_or_create",
          },
        },
      });
      durableStore.applyCreationEvent({
        sessionId,
        identity,
        event: "preparation_started",
        effectId: "workspace-receipt-restart",
      });
      durableStore.close();
      durableStore = new SessionKernelStore(path);
      expect(durableStore.creationState(sessionId)).toMatchObject({
        state: "preparing",
        currentEffectId: undefined,
        completedEffectIds: ["workspace-receipt-restart"],
      });
    } finally {
      durableStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("persists opening recovery input with its effect and clears it terminally", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-kernel-opening-plan-"));
    const path = join(dir, "kernel.sqlite");
    let durableStore = new SessionKernelStore(path);
    try {
      const sessionId = "create-opening-plan-restart";
      const identity = "request-opening-plan-restart";
      const effectId = "opening:entry-restart";
      const openingPlan = {
        id: sessionId,
        openingPrompt: "survives actor restart",
        openingPromptEntryId: "entry-restart",
      };
      durableStore.applyCreationEvent({ sessionId, identity, event: "plan" });
      durableStore.applyCreationEvent({
        sessionId,
        identity,
        event: "preparation_started",
      });
      durableStore.applyCreationEvent({
        sessionId,
        identity,
        event: "plan",
        planPatch: { resolved: openingPlan },
      });
      expect(durableStore.creationState(sessionId)?.setupPlan).toEqual({
        resolved: openingPlan,
      });
      expect(
        durableStore.applyCreationEvent({
          sessionId,
          identity,
          event: "opening_dispatched",
          openingPlan,
          nextEffectId: effectId,
          effect: {
            kind: "creation_opening_turn",
            effectKey: effectId,
            payload: {
              creationIdentity: identity,
              creationGeneration: 1,
              openingPromptEntryId: "entry-restart",
              runId: `opening:${sessionId}:entry-restart`,
              runGeneration: 1,
              mode: "adopt_or_launch",
            },
          },
        }),
      ).toMatchObject({ accepted: true });
      durableStore.close();
      durableStore = new SessionKernelStore(path);
      expect(durableStore.creationState(sessionId)).toMatchObject({
        setupPlan: undefined,
        openingPlan,
      });
      durableStore.applyCreationEvent({
        sessionId,
        identity,
        event: "succeeded",
        effectId,
      });
      expect(
        durableStore.creationState(sessionId)?.openingPlan,
      ).toBeUndefined();
    } finally {
      durableStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("settles a cancelled opening effect and fences its late success", async () => {
    const sessionId = "create-opening-cancelled";
    const identity = "request-opening-cancelled";
    const effectId = "opening:entry-cancelled";
    store.applyCreationEvent({ sessionId, identity, event: "plan" });
    store.applyCreationEvent({
      sessionId,
      identity,
      event: "preparation_started",
    });
    expect(
      store.applyCreationEvent({
        sessionId,
        identity,
        event: "opening_dispatched",
        openingPlan: { id: sessionId, openingPrompt: "cancel me" },
        nextEffectId: effectId,
        effect: {
          kind: "creation_opening_turn",
          effectKey: effectId,
          payload: {
            creationIdentity: identity,
            creationGeneration: 1,
            openingPromptEntryId: "entry-cancelled",
            runId: `opening:${sessionId}:entry-cancelled`,
            runGeneration: 1,
            mode: "adopt_or_launch",
          },
        },
      }),
    ).toMatchObject({ accepted: true });
    expect(
      store.applyCreationEvent({
        sessionId,
        identity,
        event: "cancelled",
        effectId,
      }),
    ).toMatchObject({
      accepted: true,
      to: "cancelled",
      state: {
        currentEffectId: undefined,
        openingPlan: undefined,
        completedEffectIds: [effectId],
      },
    });
    expect(
      store.applyCreationEvent({
        sessionId,
        identity,
        event: "succeeded",
        effectId,
      }),
    ).toMatchObject({ accepted: false, reason: "stale_effect" });
  });

  test("rejects creation effect capacity before accepting more work", async () => {
    const sessionId = "create-receipt-capacity";
    const identity = "request-receipt-capacity";
    store.applyCreationEvent({ sessionId, identity, event: "plan" });
    for (
      let index = 0;
      index < SESSION_KERNEL_MAX_CREATION_EFFECT_RECEIPTS;
      index += 1
    ) {
      const effectId = `workspace-capacity-${index}`;
      expect(
        store.applyCreationEvent({
          sessionId,
          identity,
          event: "preparation_started",
          nextEffectId: effectId,
          effect: {
            kind: "creation_workspace_prepare",
            effectKey: effectId,
            payload: {
              creationIdentity: identity,
              creationGeneration: 1,
              workspaceId: `ws-capacity-${index}`,
              dedupeKey: `creation:capacity-${index}`,
              name: "Capacity",
              createdBy: "Alice",
              mode: "adopt_or_create",
            },
          },
        }).accepted,
      ).toBe(true);
      expect(
        store.applyCreationEvent({
          sessionId,
          identity,
          event: "preparation_started",
          effectId,
        }).accepted,
      ).toBe(true);
    }
    const outboxBefore = store.pendingOutbox(Date.now(), 10_000).length;
    expect(
      store.applyCreationEvent({
        sessionId,
        identity,
        event: "preparation_started",
        nextEffectId: "workspace-over-capacity",
        effect: {
          kind: "creation_workspace_prepare",
          effectKey: "workspace-over-capacity",
          payload: {
            creationIdentity: identity,
            creationGeneration: 1,
            workspaceId: "ws-over-capacity",
            dedupeKey: "creation:over-capacity",
            name: "Over capacity",
            createdBy: "Alice",
            mode: "adopt_or_create",
          },
        },
      }),
    ).toMatchObject({
      accepted: false,
      reason: "effect_receipt_capacity",
    });
    expect(store.pendingOutbox(Date.now(), 10_000)).toHaveLength(outboxBefore);
  });

  test("rolls creation state back when its durable effect cannot commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-kernel-create-crash-"));
    const path = join(dir, "kernel.sqlite");
    const crashStore = new SessionKernelStore(path);
    try {
      expect(
        crashStore.applyCreationEvent({
          sessionId: "create-crash",
          identity: "request-crash",
          event: "plan",
        }).accepted,
      ).toBe(true);
      const injector = new Database(path);
      injector.exec(`CREATE TRIGGER inject_creation_effect_crash
				BEFORE INSERT ON session_kernel_outbox
				WHEN NEW.kind = 'creation_workspace_prepare'
				BEGIN SELECT RAISE(ABORT, 'injected effect commit crash'); END`);
      injector.close();
      expect(() =>
        crashStore.applyCreationEvent({
          sessionId: "create-crash",
          identity: "request-crash",
          event: "preparation_started",
          nextEffectId: "workspace-crash",
          effect: {
            kind: "creation_workspace_prepare",
            effectKey: "workspace-crash",
            payload: {
              creationIdentity: "request-crash",
              creationGeneration: 1,
              workspaceId: "workspace-crash",
              dedupeKey: "creation:workspace-crash",
              name: "Workspace crash",
              createdBy: "Alice",
              mode: "adopt_or_create",
            },
          },
        }),
      ).toThrow("injected effect commit crash");
      expect(crashStore.creationState("create-crash")).toMatchObject({
        state: "planned",
        changeSeq: 1,
      });
      expect(crashStore.pendingOutbox()).toHaveLength(0);
      expect(crashStore.changesSince("create-crash", 0)).toHaveLength(1);
    } finally {
      crashStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("claims and restores a delivery batch atomically", async () => {
    store.setDeliverySlot("delivery", "queued", [
      { id: "one", content: "first" },
      { id: "two", content: "second" },
    ]);
    const claimed = store.claimDeliveryDispatch({
      sessionId: "delivery",
      items: [{ id: "one", content: "first" }],
      promptEntryId: "entry-one",
      requireQueued: true,
    });
    expect(claimed.promptEntryId).toBe("entry-one");
    expect(store.deliverySnapshot("delivery")).toMatchObject({
      queued: [{ id: "two", content: "second" }],
      dispatch: {
        promptEntryId: "entry-one",
        items: [{ id: "one", content: "first" }],
      },
    });
    expect(store.failDeliveryDispatch("delivery", "stale-entry")).toBe(false);
    expect(store.failDeliveryDispatch("delivery", "entry-one")).toBe(true);
    expect(store.deliverySnapshot("delivery")).toMatchObject({
      queued: [
        { id: "one", content: "first" },
        { id: "two", content: "second" },
      ],
    });
    expect(store.deliverySnapshot("delivery").dispatch).toBeUndefined();
  });

  test("retires a terminal creation dispatch before a later prompt drains", async () => {
    const sessionId = "failed-opening-follow-up";
    const identity = "failed-opening-request";
    const promptEntryId = "failed-opening-prompt";
    const effectId = `opening:${promptEntryId}`;
    store.claimDeliveryDispatch({
      sessionId,
      items: [{ id: "opening", content: "start" }],
      promptEntryId,
      kind: "create",
    });
    store.applyCreationEvent({ sessionId, identity, event: "plan" });
    store.applyCreationEvent({
      sessionId,
      identity,
      event: "preparation_started",
    });
    store.applyCreationEvent({
      sessionId,
      identity,
      event: "opening_dispatched",
      openingPlan: { id: sessionId, openingPrompt: "start" },
      nextEffectId: effectId,
      effect: {
        kind: "creation_opening_turn",
        effectKey: effectId,
        payload: {
          creationIdentity: identity,
          creationGeneration: 1,
          openingPromptEntryId: promptEntryId,
          runId: `opening:${sessionId}:${promptEntryId}`,
          runGeneration: 1,
          mode: "adopt_or_launch",
        },
      },
    });
    store.setDeliverySlot(sessionId, "queued", [
      { id: "follow-up", content: "try again" },
    ]);
    expect(() =>
      store.claimNextDeliveryDispatch({
        sessionId,
        promptEntryId: "too-early",
      }),
    ).toThrow("A prompt dispatch is already active");
    expect(
      store.applyCreationEvent({
        sessionId,
        identity,
        event: "failed",
        effectId,
      }),
    ).toMatchObject({ accepted: true, to: "failed" });

    // Explicit settlement must observe and clear its own completed creation
    // dispatch instead of the generic stale-dispatch repair clearing it first.
    expect(store.ackDeliveryDispatch(sessionId, promptEntryId)).toBe(true);
    expect(store.deliverySnapshot(sessionId).dispatch).toBeUndefined();

    // If the process died before that explicit ack, the first later send still
    // repairs the retained dispatch so the follow-up cannot remain parked.
    store.claimDeliveryDispatch({
      sessionId,
      items: [{ id: "opening", content: "start" }],
      promptEntryId,
      kind: "create",
    });
    store.setDeliverySlot(sessionId, "queued", [
      { id: "follow-up", content: "try again" },
    ]);
    expect(store.deliverySnapshot(sessionId).dispatch).toBeUndefined();
    expect(
      store.claimNextDeliveryDispatch({
        sessionId,
        promptEntryId: "unused-fallback-entry",
      }),
    ).toMatchObject({
      kind: "deliver",
      promptEntryId: "follow-up",
      items: [{ id: "follow-up", content: "try again" }],
    });
  });

  test("uses a fresh fallback identity when several messages form one turn", async () => {
    store.setDeliverySlot("batched-delivery", "queued", [
      { id: "first", content: "one" },
      { id: "second", content: "two" },
    ]);
    expect(
      store.claimNextDeliveryDispatch({
        sessionId: "batched-delivery",
        promptEntryId: "batch-entry",
      }),
    ).toMatchObject({
      kind: "deliver",
      promptEntryId: "batch-entry",
      items: [{ id: "first" }, { id: "second" }],
    });
  });

  test("selects and claims the next queue batch in one actor transaction", async () => {
    store.setDeliverySlot("next-delivery", "queued", [
      { id: "held", content: "wait", hold: true },
      {
        id: "solo",
        promptEntryId: "stable-solo-entry",
        content: "send now",
        hold: true,
      },
    ]);
    expect(
      store.claimNextDeliveryDispatch({
        sessionId: "next-delivery",
        promptEntryId: "unused-entry",
        stillWorking: true,
      }),
    ).toMatchObject({ kind: "hold", heldCount: 2 });
    expect(store.deliverySnapshot("next-delivery").queued).toHaveLength(2);
    store.prepareDeliveryInterrupt({
      sessionId: "next-delivery",
      interruptId: "interrupt-next-delivery",
      anchorId: "solo",
      dispatchId: "run-owner",
      soloId: "solo",
    });
    store.settleDeliveryInterrupt({
      sessionId: "next-delivery",
      interruptId: "interrupt-next-delivery",
      outcome: "confirmed",
    });
    expect(
      store.claimNextDeliveryDispatch({
        sessionId: "next-delivery",
        promptEntryId: "solo-entry",
        stillWorking: true,
      }),
    ).toMatchObject({
      kind: "deliver",
      promptEntryId: "stable-solo-entry",
      items: [
        {
          id: "solo",
          promptEntryId: "stable-solo-entry",
          content: "send now",
          hold: true,
        },
      ],
    });
    expect(store.deliverySnapshot("next-delivery")).toMatchObject({
      queued: [{ id: "held", content: "wait", hold: true }],
      dispatch: {
        promptEntryId: "stable-solo-entry",
        items: [
          {
            id: "solo",
            promptEntryId: "stable-solo-entry",
            content: "send now",
            hold: true,
          },
        ],
      },
    });
  });

  test("rolls an unabortable steered receipt back to its durable slot", async () => {
    store.setDeliverySlot("steered-interrupt", "steered", [
      { id: "before", content: "before" },
      { id: "target", content: "accepted but unread" },
      { id: "after", content: "after" },
    ]);
    store.prepareDeliveryInterrupt({
      sessionId: "steered-interrupt",
      interruptId: "steered-interrupt-one",
      anchorId: "target",
      dispatchId: "run-owner",
      soloId: "target",
    });
    expect(store.deliverySnapshot("steered-interrupt")).toMatchObject({
      queued: [{ id: "target" }],
      steered: [{ id: "before" }, { id: "after" }],
      interrupt: { source: { slot: "steered", index: 1 } },
    });
    store.settleDeliveryInterrupt({
      sessionId: "steered-interrupt",
      interruptId: "steered-interrupt-one",
      outcome: "not_aborted",
    });
    expect(store.deliverySnapshot("steered-interrupt")).toMatchObject({
      queued: [],
      steered: [{ id: "before" }, { id: "target" }, { id: "after" }],
    });
    expect(
      store.deliverySnapshot("steered-interrupt").interrupt,
    ).toBeUndefined();
  });

  test("does not transfer an interrupt to an earlier retry group", async () => {
    store.setDeliverySlot("interrupt-behind-retry", "queued", [
      { id: "retry", retryDispatchId: "older-entry", content: "retry first" },
      { id: "anchor", content: "interrupt target", hold: true },
    ]);
    store.prepareDeliveryInterrupt({
      sessionId: "interrupt-behind-retry",
      interruptId: "interrupt-behind-retry",
      anchorId: "anchor",
      dispatchId: "run-owner",
      soloId: "anchor",
    });
    store.settleDeliveryInterrupt({
      sessionId: "interrupt-behind-retry",
      interruptId: "interrupt-behind-retry",
      outcome: "confirmed",
    });
    expect(
      store.claimNextDeliveryDispatch({
        sessionId: "interrupt-behind-retry",
        promptEntryId: "unused",
        stillWorking: true,
      }),
    ).toMatchObject({
      kind: "deliver",
      promptEntryId: "older-entry",
      interrupted: false,
      items: [{ id: "retry" }],
    });
    expect(
      store.deliverySnapshot("interrupt-behind-retry").interrupt,
    ).toMatchObject({ anchorId: "anchor" });
    store.ackDeliveryDispatch("interrupt-behind-retry", "older-entry");
    expect(
      store.claimNextDeliveryDispatch({
        sessionId: "interrupt-behind-retry",
        promptEntryId: "anchor-entry",
        stillWorking: true,
      }),
    ).toMatchObject({
      kind: "deliver",
      interrupted: true,
      items: [{ id: "anchor" }],
    });
  });

  test("does not apply a solo interrupt after its target is removed", async () => {
    store.setDeliverySlot("stale-solo-interrupt", "queued", [
      { id: "removed", content: "interrupt target", hold: true },
      { id: "other", content: "still held", hold: true },
    ]);
    store.prepareDeliveryInterrupt({
      sessionId: "stale-solo-interrupt",
      interruptId: "interrupt-stale-solo-interrupt",
      anchorId: "removed",
      dispatchId: "run-owner",
      soloId: "removed",
    });
    store.setDeliverySlot("stale-solo-interrupt", "queued", [
      { id: "other", content: "still held", hold: true },
    ]);
    expect(
      store.claimNextDeliveryDispatch({
        sessionId: "stale-solo-interrupt",
        promptEntryId: "must-not-deliver",
        stillWorking: true,
      }),
    ).toMatchObject({ kind: "hold", heldCount: 1 });
    expect(
      store.deliverySnapshot("stale-solo-interrupt").interrupt,
    ).toBeUndefined();
  });

  test("cancels an admitted starting dispatch before its journal registers", async () => {
    store.applyRunEvent({ sessionId: "cancel-starting", event: "prompt" });
    const generation = store.runState("cancel-starting").generation;
    expect(
      store.prepareTurnCancel({
        sessionId: "cancel-starting",
        cancelId: "cancel-starting",
        expectedRunId: "dispatch-starting",
        expectedGeneration: generation,
        dispatchId: "dispatch-starting",
        requeueIds: [],
        source: "test",
      }),
    ).toMatchObject({
      cancel: { phase: "prepared", runId: "dispatch-starting" },
      runState: { state: "stopped" },
    });
    expect(store.pendingOutbox(Date.now(), 10, ["turn_cancel"])).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ dispatchId: "dispatch-starting" }),
      }),
    ]);
    const { isUserStopped, liftUserStop } = await import("../queue-state");
    expect(await isUserStopped("cancel-starting")).toBe(true);
    await liftUserStop("cancel-starting");
    expect(store.runState("cancel-starting").state).toBe("idle");
    expect(await isUserStopped("cancel-starting")).toBe(true);
    expect(
      store.applyRunEvent({
        sessionId: "cancel-starting",
        event: "run_registered",
        runKey: "dispatch-starting",
      }),
    ).toMatchObject({ accepted: false, reason: "stale_run" });
    store.settleTurnCancel({
      sessionId: "cancel-starting",
      cancelId: "cancel-starting",
      outcome: "confirmed",
    });
    expect(await isUserStopped("cancel-starting")).toBe(false);
    expect(
      store.applyRunEvent({
        sessionId: "cancel-starting",
        event: "prompt",
        runKey: "dispatch-successor",
      }),
    ).toMatchObject({
      accepted: true,
      state: { state: "starting", currentRunId: "dispatch-successor" },
    });
    expect(
      store.applyRunEvent({
        sessionId: "cancel-starting",
        event: "run_registered",
        runKey: "dispatch-successor",
      }),
    ).toMatchObject({
      accepted: true,
      state: { state: "running", currentRunId: "dispatch-successor" },
    });
    expect(
      store.applyRunEvent({
        sessionId: "cancel-starting",
        event: "turn_end",
        runKey: "dispatch-starting",
      }),
    ).toMatchObject({
      accepted: false,
      reason: "stale_run",
      state: { state: "running", currentRunId: "dispatch-successor" },
    });
  });

  test("durably projects one exact terminal outcome through the actor outbox", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-kernel-outcome-"));
    const path = join(dir, "kernel.sqlite");
    const first = new SessionKernelStore(path);
    let effectId = -1;
    let generation = -1;
    try {
      first.applyRunEvent({
        sessionId: "outcome-restart",
        event: "prompt",
        runKey: "run-one",
      });
      first.applyRunEvent({
        sessionId: "outcome-restart",
        event: "run_registered",
        runKey: "run-one",
      });
      generation = first.runState("outcome-restart").generation;
      first.applyRunEvent({
        sessionId: "outcome-restart",
        event: "run_failed",
        runKey: "run-one",
      });
      const input = {
        sessionId: "outcome-restart",
        projectionId: "outcome:run-one",
        runId: "run-one",
        runGeneration: generation,
        errorMessage: "terminal failure",
        engineSessionId: "engine-one",
        noticePersisted: false,
        noticeLabel: "Run failed",
        projectedAt: "2026-08-24T18:00:00.000Z",
      } as const;
      expect(first.prepareTurnOutcomeProjection(input)).toMatchObject({
        phase: "pending",
        runId: "run-one",
        runGeneration: generation,
      });
      expect(first.prepareTurnOutcomeProjection(input)).toMatchObject({
        phase: "pending",
      });
      expect(() =>
        first.prepareTurnOutcomeProjection({
          ...input,
          errorMessage: "crossed payload",
        }),
      ).toThrow("reused with another payload");
      const [effect] = first.pendingOutbox(Date.now(), 10);
      effectId = effect.id;
      expect(effect).toMatchObject({
        kind: "turn_outcome_project",
        effectKey: "outcome:run-one",
        payload: {
          projectionId: "outcome:run-one",
          runId: "run-one",
          runGeneration: generation,
          errorMessage: "terminal failure",
          projectedAt: "2026-08-24T18:00:00.000Z",
        },
      });
    } finally {
      first.close();
    }

    const recovered = new SessionKernelStore(path);
    try {
      recovered.applyRunEvent({
        sessionId: "outcome-restart",
        event: "prompt",
        runKey: "run-two",
      });
      recovered.applyRunEvent({
        sessionId: "outcome-restart",
        event: "run_registered",
        runKey: "run-two",
      });
      const secondGeneration = recovered.runState("outcome-restart").generation;
      recovered.applyRunEvent({
        sessionId: "outcome-restart",
        event: "turn_end",
        runKey: "run-two",
      });
      expect(
        recovered.prepareTurnOutcomeProjection({
          sessionId: "outcome-restart",
          projectionId: "outcome:run-two",
          runId: "run-two",
          runGeneration: secondGeneration,
          errorMessage: null,
          noticePersisted: false,
          projectedAt: "2026-08-24T18:01:00.000Z",
        }),
      ).toMatchObject({ phase: "pending", runGeneration: secondGeneration });
      const secondEffect = recovered
        .pendingOutbox(Date.now(), 10)
        .find((item) => item.effectKey === "outcome:run-two");
      expect(secondEffect).toBeDefined();
      expect(
        recovered.beginTurnOutcomeProjection({
          sessionId: "outcome-restart",
          projectionId: "outcome:run-two",
          runGeneration: secondGeneration,
        }),
      ).toBe("wait");
      expect(
        recovered.beginTurnOutcomeProjection({
          sessionId: "outcome-restart",
          projectionId: "outcome:run-one",
          runGeneration: generation,
        }),
      ).toBe("execute");
      expect(
        recovered.settleTurnOutcomeProjection({
          sessionId: "outcome-restart",
          projectionId: "outcome:run-one",
          runGeneration: generation,
        }),
      ).toBe(true);
      expect(
        recovered.beginTurnOutcomeProjection({
          sessionId: "outcome-restart",
          projectionId: "outcome:run-one",
          runGeneration: generation,
        }),
      ).toBe("completed");
      recovered.ackOutbox(effectId);
      expect(recovered.pendingOutbox(Date.now(), 10)).toEqual([
        expect.objectContaining({ effectKey: "outcome:run-two" }),
      ]);
      expect(
        recovered.prepareTurnOutcomeProjection({
          sessionId: "outcome-restart",
          projectionId: "outcome:run-one",
          runId: "run-one",
          runGeneration: generation,
          errorMessage: "terminal failure",
          engineSessionId: "engine-one",
          noticePersisted: false,
          noticeLabel: "Run failed",
          projectedAt: "2026-08-24T18:00:00.000Z",
        }),
      ).toMatchObject({ phase: "completed" });
      expect(
        recovered.settleTurnOutcomeProjection({
          sessionId: "outcome-restart",
          projectionId: "outcome:run-two",
          runGeneration: secondGeneration,
        }),
      ).toBe(true);
      recovered.ackOutbox(secondEffect?.id ?? -1);
      expect(recovered.pendingOutbox(Date.now(), 10)).toEqual([]);

      expect(
        recovered.prepareTurnOutcomeProjection({
          sessionId: "outcome-restart",
          projectionId: "outcome:stale-run-one",
          runId: "run-one",
          runGeneration: generation,
          errorMessage: null,
          noticePersisted: false,
          projectedAt: "2026-08-24T18:01:00.000Z",
        }),
      ).toBe("stale");
      expect(
        recovered.beginTurnOutcomeProjection({
          sessionId: "outcome-restart",
          projectionId: "missing",
          runGeneration: generation,
        }),
      ).toBe("missing");

      const deadSession = "outcome-dead-predecessor";
      recovered.applyRunEvent({
        sessionId: deadSession,
        event: "prompt",
        runKey: "dead-run-one",
      });
      recovered.applyRunEvent({
        sessionId: deadSession,
        event: "run_registered",
        runKey: "dead-run-one",
      });
      const deadGeneration = recovered.runState(deadSession).generation;
      recovered.applyRunEvent({
        sessionId: deadSession,
        event: "run_failed",
        runKey: "dead-run-one",
      });
      recovered.prepareTurnOutcomeProjection({
        sessionId: deadSession,
        projectionId: "outcome:dead-run-one",
        runId: "dead-run-one",
        runGeneration: deadGeneration,
        errorMessage: "old failure",
        noticePersisted: false,
        projectedAt: "2026-08-24T18:02:00.000Z",
      });
      const deadEffect = recovered
        .pendingOutbox(Date.now(), 10)
        .find((item) => item.effectKey === "outcome:dead-run-one");
      expect(deadEffect).toBeDefined();
      expect(
        recovered.noteOutboxFailure(deadEffect?.id ?? -1, "poison", 1),
      ).toMatchObject({ deadLetteredNow: true });
      recovered.applyRunEvent({
        sessionId: deadSession,
        event: "prompt",
        runKey: "dead-run-two",
      });
      recovered.applyRunEvent({
        sessionId: deadSession,
        event: "run_registered",
        runKey: "dead-run-two",
      });
      const newerGeneration = recovered.runState(deadSession).generation;
      recovered.applyRunEvent({
        sessionId: deadSession,
        event: "turn_end",
        runKey: "dead-run-two",
      });
      recovered.prepareTurnOutcomeProjection({
        sessionId: deadSession,
        projectionId: "outcome:dead-run-two",
        runId: "dead-run-two",
        runGeneration: newerGeneration,
        errorMessage: null,
        noticePersisted: false,
        projectedAt: "2026-08-24T18:03:00.000Z",
      });
      expect(
        recovered.beginTurnOutcomeProjection({
          sessionId: deadSession,
          projectionId: "outcome:dead-run-two",
          runGeneration: newerGeneration,
        }),
      ).toBe("execute");
      expect(
        recovered.settleTurnOutcomeProjection({
          sessionId: deadSession,
          projectionId: "outcome:dead-run-two",
          runGeneration: newerGeneration,
        }),
      ).toBe(true);
      expect(recovered.retryDeadOutbox(deadEffect?.id ?? -1)).toBe(true);
      expect(
        recovered.beginTurnOutcomeProjection({
          sessionId: deadSession,
          projectionId: "outcome:dead-run-one",
          runGeneration: deadGeneration,
        }),
      ).toBe("missing");
      expect(
        recovered.settleTurnOutcomeProjection({
          sessionId: deadSession,
          projectionId: "outcome:dead-run-one",
          runGeneration: deadGeneration,
        }),
      ).toBe(false);

      const cancelledSession = "outcome-cancelled-predecessor";
      recovered.applyRunEvent({
        sessionId: cancelledSession,
        event: "prompt",
        runKey: "cancelled-run",
      });
      recovered.applyRunEvent({
        sessionId: cancelledSession,
        event: "run_registered",
        runKey: "cancelled-run",
      });
      const cancelledGeneration =
        recovered.runState(cancelledSession).generation;
      recovered.prepareTurnCancel({
        sessionId: cancelledSession,
        cancelId: "cancel-outcome",
        expectedRunId: "cancelled-run",
        expectedGeneration: cancelledGeneration,
        dispatchId: "cancelled-run",
        requeueIds: [],
        source: "test",
      });
      recovered.settleTurnCancel({
        sessionId: cancelledSession,
        cancelId: "cancel-outcome",
        outcome: "confirmed",
      });
      expect(
        recovered.prepareTurnOutcomeProjection({
          sessionId: cancelledSession,
          projectionId: "outcome:cancelled-run",
          runId: "cancelled-run",
          runGeneration: cancelledGeneration,
          errorMessage: "must not project",
          noticePersisted: false,
          projectedAt: "2026-08-24T18:04:00.000Z",
        }),
      ).toBe("stale");
    } finally {
      recovered.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("durably prepares, retries, and generation-fences explicit turn cancellation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-kernel-cancel-"));
    const path = join(dir, "kernel.sqlite");
    const first = new SessionKernelStore(path);
    try {
      first.applyRunEvent({ sessionId: "cancel-restart", event: "prompt" });
      first.applyRunEvent({
        sessionId: "cancel-restart",
        event: "run_registered",
        runKey: "run-one",
      });
      first.setDeliverySlot("cancel-restart", "queued", [
        { id: "already-queued", content: "later" },
      ]);
      first.setDeliverySlot("cancel-restart", "steered", [
        { id: "landed", content: "already landed" },
        { id: "unconfirmed", content: "return me" },
      ]);
      const generation = first.runState("cancel-restart").generation;
      expect(
        first.prepareTurnCancel({
          sessionId: "cancel-restart",
          cancelId: "cancel-one",
          expectedRunId: "run-one",
          expectedGeneration: generation,
          dispatchId: "run-one",
          requeueIds: ["unconfirmed"],
          source: "test",
        }),
      ).toMatchObject({
        cancel: {
          phase: "prepared",
          runId: "run-one",
          runGeneration: generation,
        },
        runState: { state: "stopped", generation },
      });
      expect(
        first.prepareTurnCancel({
          sessionId: "cancel-restart",
          cancelId: "cancel-one",
          expectedRunId: "run-one",
          expectedGeneration: generation,
          dispatchId: "run-one",
          requeueIds: ["unconfirmed"],
          source: "test",
        }),
      ).toMatchObject({ cancel: { phase: "prepared" } });
      expect(() =>
        first.prepareTurnCancel({
          sessionId: "cancel-restart",
          cancelId: "cancel-one",
          expectedRunId: "run-one",
          expectedGeneration: generation,
          dispatchId: "run-one",
          requeueIds: ["unconfirmed"],
          source: "another-source",
        }),
      ).toThrow("reused with another payload");
      expect(first.runState("cancel-restart")).toMatchObject({
        state: "stopped",
        generation,
        currentRunId: undefined,
      });
      expect(first.deliverySnapshot("cancel-restart")).toMatchObject({
        queued: [
          { id: "unconfirmed", content: "return me" },
          { id: "already-queued", content: "later" },
        ],
        steered: [],
      });
      expect(first.pendingOutbox(Date.now(), 10)).toEqual([
        expect.objectContaining({
          kind: "turn_cancel",
          effectKey: "cancel-one",
          payload: expect.objectContaining({ runGeneration: generation }),
        }),
      ]);
    } finally {
      first.close();
    }

    const beforePhysicalCancel = new SessionKernelStore(path);
    try {
      const cancel = beforePhysicalCancel.turnSnapshot("cancel-restart").cancel;
      expect(cancel).toMatchObject({
        phase: "prepared",
        cancelId: "cancel-one",
      });
      expect(
        beforePhysicalCancel.beginTurnCancelEffect({
          sessionId: "cancel-restart",
          cancelId: "cancel-one",
          runGeneration: cancel?.runGeneration ?? -1,
        }),
      ).toBe("execute");
    } finally {
      beforePhysicalCancel.close();
    }

    const duringPhysicalCancel = new SessionKernelStore(path);
    try {
      const cancel = duringPhysicalCancel.turnSnapshot("cancel-restart").cancel;
      expect(cancel).toMatchObject({ phase: "executing" });
      expect(
        duringPhysicalCancel.beginTurnCancelEffect({
          sessionId: "cancel-restart",
          cancelId: "cancel-one",
          runGeneration: cancel?.runGeneration ?? -1,
        }),
      ).toBe("retry");
      duringPhysicalCancel.applyRunEvent({
        sessionId: "cancel-restart",
        event: "prompt",
      });
      duringPhysicalCancel.applyRunEvent({
        sessionId: "cancel-restart",
        event: "run_registered",
        runKey: "run-two",
      });
      expect(
        duringPhysicalCancel.beginTurnCancelEffect({
          sessionId: "cancel-restart",
          cancelId: "cancel-one",
          runGeneration: cancel?.runGeneration ?? -1,
        }),
      ).toBe("adopt_confirmed");
      expect(
        duringPhysicalCancel.settleTurnCancel({
          sessionId: "cancel-restart",
          cancelId: "cancel-one",
          outcome: "confirmed",
        }),
      ).toBe(true);
      expect(
        duringPhysicalCancel.turnSnapshot("cancel-restart").cancel,
      ).toMatchObject({
        phase: "settled",
        outcome: "confirmed",
      });
      expect(
        duringPhysicalCancel.beginTurnCancelEffect({
          sessionId: "cancel-restart",
          cancelId: "cancel-one",
          runGeneration: cancel?.runGeneration ?? -1,
        }),
      ).toBe("settled");
      const successor = duringPhysicalCancel.runState("cancel-restart");
      duringPhysicalCancel.prepareTurnCancel({
        sessionId: "cancel-restart",
        cancelId: "cancel-two",
        expectedRunId: "run-two",
        expectedGeneration: successor.generation,
        dispatchId: "run-two",
        requeueIds: [],
        source: "test",
      });
      expect(
        duringPhysicalCancel.beginTurnCancelEffect({
          sessionId: "cancel-restart",
          cancelId: "cancel-one",
          runGeneration: cancel?.runGeneration ?? -1,
        }),
      ).toBe("missing");
      expect(
        duringPhysicalCancel.settleTurnCancel({
          sessionId: "cancel-restart",
          cancelId: "cancel-one",
          outcome: "confirmed",
        }),
      ).toBe(false);
    } finally {
      duringPhysicalCancel.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recovers prepared and claimed interrupts across crashes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-kernel-interrupt-"));
    const path = join(dir, "kernel.sqlite");
    const first = new SessionKernelStore(path);
    try {
      first.setDeliverySlot("restart-interrupt", "queued", [
        { id: "held", content: "deliver after restart", hold: true },
      ]);
      first.prepareDeliveryInterrupt({
        sessionId: "restart-interrupt",
        interruptId: "interrupt-restart-interrupt",
        anchorId: "held",
        dispatchId: "run-owner",
      });
      expect(first.stats().pendingOutbox).toBe(1);
    } finally {
      first.close();
    }

    const recoveredBeforeCancel = new SessionKernelStore(path);
    try {
      const interrupt =
        recoveredBeforeCancel.deliverySnapshot("restart-interrupt").interrupt;
      expect(interrupt).toMatchObject({ phase: "prepared", anchorId: "held" });
      expect(
        recoveredBeforeCancel.claimNextDeliveryDispatch({
          sessionId: "restart-interrupt",
          promptEntryId: "must-wait-for-cancel",
          stillWorking: true,
        }),
      ).toMatchObject({ kind: "hold" });
      expect(
        recoveredBeforeCancel.beginDeliveryInterruptEffect({
          sessionId: "restart-interrupt",
          interruptId: "interrupt-restart-interrupt",
          runGeneration: interrupt?.runGeneration ?? -1,
        }),
      ).toBe("execute");
    } finally {
      recoveredBeforeCancel.close();
    }

    const recoveredDuringCancel = new SessionKernelStore(path);
    try {
      const interrupt =
        recoveredDuringCancel.deliverySnapshot("restart-interrupt").interrupt;
      expect(interrupt).toMatchObject({ phase: "executing" });
      expect(
        recoveredDuringCancel.beginDeliveryInterruptEffect({
          sessionId: "restart-interrupt",
          interruptId: "interrupt-restart-interrupt",
          runGeneration: interrupt?.runGeneration ?? -1,
        }),
      ).toBe("retry");
      expect(
        recoveredDuringCancel.settleDeliveryInterrupt({
          sessionId: "restart-interrupt",
          interruptId: "interrupt-restart-interrupt",
          outcome: "confirmed",
        }),
      ).toBe(true);
      expect(
        recoveredDuringCancel.beginDeliveryInterruptEffect({
          sessionId: "restart-interrupt",
          interruptId: "interrupt-restart-interrupt",
          runGeneration: interrupt?.runGeneration ?? -1,
        }),
      ).toBe("confirmed");
      expect(
        recoveredDuringCancel.claimNextDeliveryDispatch({
          sessionId: "restart-interrupt",
          promptEntryId: "unused-restart-entry",
          stillWorking: true,
        }),
      ).toMatchObject({
        kind: "deliver",
        promptEntryId: "held",
        interrupted: true,
      });
    } finally {
      recoveredDuringCancel.close();
    }

    const recoveredAfterClaim = new SessionKernelStore(path);
    try {
      expect(
        recoveredAfterClaim.failDeliveryDispatch("restart-interrupt", "held"),
      ).toBe(true);
      expect(
        recoveredAfterClaim.deliverySnapshot("restart-interrupt").interrupt,
      ).toMatchObject({ phase: "confirmed", anchorId: "held" });
      expect(
        recoveredAfterClaim.claimNextDeliveryDispatch({
          sessionId: "restart-interrupt",
          promptEntryId: "retry-entry",
          stillWorking: true,
        }),
      ).toMatchObject({
        kind: "deliver",
        promptEntryId: "held",
        interrupted: true,
      });
      const claimedInterrupt = (
        recoveredAfterClaim.deliverySnapshot("restart-interrupt").dispatch as {
          interrupt?: { runGeneration: number };
        }
      ).interrupt;
      expect(
        recoveredAfterClaim.beginDeliveryInterruptEffect({
          sessionId: "restart-interrupt",
          interruptId: "interrupt-restart-interrupt",
          runGeneration: claimedInterrupt?.runGeneration ?? -1,
        }),
      ).toBe("confirmed");
    } finally {
      recoveredAfterClaim.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reuses a failed multi-item dispatch identity", async () => {
    store.setDeliverySlot("failed-multi-dispatch", "queued", [
      { id: "one", content: "first" },
      { id: "two", content: "second" },
    ]);
    expect(
      store.claimNextDeliveryDispatch({
        sessionId: "failed-multi-dispatch",
        promptEntryId: "stable-batch-entry",
      }),
    ).toMatchObject({
      kind: "deliver",
      promptEntryId: "stable-batch-entry",
      items: [{ id: "one" }, { id: "two" }],
    });
    expect(
      store.failDeliveryDispatch("failed-multi-dispatch", "stable-batch-entry"),
    ).toBe(true);
    const restored = store.deliverySnapshot("failed-multi-dispatch").queued;
    store.setDeliverySlot("failed-multi-dispatch", "queued", [
      ...restored,
      { id: "later", content: "must stay later" },
    ]);
    store.prepareDeliveryInterrupt({
      sessionId: "failed-multi-dispatch",
      interruptId: "interrupt-failed-multi-dispatch",
      anchorId: "two",
      dispatchId: "run-owner",
      soloId: "two",
    });
    store.settleDeliveryInterrupt({
      sessionId: "failed-multi-dispatch",
      interruptId: "interrupt-failed-multi-dispatch",
      outcome: "confirmed",
    });
    expect(
      store.claimNextDeliveryDispatch({
        sessionId: "failed-multi-dispatch",
        promptEntryId: "replacement-must-not-win",
      }),
    ).toMatchObject({
      kind: "deliver",
      promptEntryId: "stable-batch-entry",
      items: [
        {
          id: "one",
          promptEntryId: "stable-batch-entry",
          retryDispatchId: "stable-batch-entry",
        },
        { id: "two", retryDispatchId: "stable-batch-entry" },
      ],
    });
    expect(store.deliverySnapshot("failed-multi-dispatch").queued).toEqual([
      { id: "later", content: "must stay later" },
    ]);

    expect(
      store.failDeliveryDispatch("failed-multi-dispatch", "stable-batch-entry"),
    ).toBe(true);
    store.setDeliverySlot(
      "failed-multi-dispatch",
      "queued",
      store
        .deliverySnapshot("failed-multi-dispatch")
        .queued.filter((item) => (item as { id?: string }).id !== "one"),
    );
    store.prepareDeliveryInterrupt({
      sessionId: "failed-multi-dispatch",
      interruptId: "interrupt-failed-multi-dispatch",
      anchorId: "two",
      dispatchId: "run-owner",
      soloId: "two",
    });
    store.settleDeliveryInterrupt({
      sessionId: "failed-multi-dispatch",
      interruptId: "interrupt-failed-multi-dispatch",
      outcome: "confirmed",
    });
    expect(
      store.claimNextDeliveryDispatch({
        sessionId: "failed-multi-dispatch",
        promptEntryId: "replacement-still-must-not-win",
      }),
    ).toMatchObject({
      kind: "deliver",
      promptEntryId: "stable-batch-entry",
      items: [{ id: "two", retryDispatchId: "stable-batch-entry" }],
    });
  });

  test("recovers an ambiguous prepared steer without duplicate queue delivery", async () => {
    store.setRunState({
      sessionId: "steer-recovery",
      state: "running",
      event: "run_registered",
      currentRunId: "run-one",
      generation: 1,
    });
    const target = { token: "token-one", runId: "run-one", generation: 1 };
    store.setDeliverySlot("steer-recovery", "queued", [
      { id: "steer-one", content: "fold me in" },
    ]);
    expect(
      store.prepareSteerDelivery("steer-recovery", "steer-one", target),
    ).toMatchObject({ id: "steer-one" });
    expect(store.deliverySnapshot("steer-recovery")).toMatchObject({
      queued: [],
      pendingSteers: [{ item: { id: "steer-one" }, index: 0 }],
    });
    expect(store.settlePendingSteers()).toBe(1);
    expect(store.deliverySnapshot("steer-recovery")).toMatchObject({
      queued: [],
      pendingSteers: [],
      steered: [{ id: "steer-one", content: "fold me in" }],
    });
    expect(
      store.requeueSteerDeliveries("steer-recovery", [
        { id: "steer-one", content: "fold me in" },
      ]),
    ).toBe(1);
    expect(store.deliverySnapshot("steer-recovery")).toMatchObject({
      queued: [{ id: "steer-one", content: "fold me in" }],
      steered: [],
    });
  });

  test("does not accept a prepared steer after run ownership changes", () => {
    const sessionId = "steer-owner-swap";
    const oldTarget = { token: "token-old", runId: "run-old", generation: 1 };
    store.setRunState({
      sessionId,
      state: "running",
      event: "run_registered",
      currentRunId: oldTarget.runId,
      generation: oldTarget.generation,
    });
    store.setDeliverySlot(sessionId, "queued", [{ id: "steer-one" }]);
    expect(
      store.prepareSteerDelivery(sessionId, "steer-one", oldTarget),
    ).toMatchObject({ id: "steer-one" });
    store.setRunState({
      sessionId,
      state: "running",
      event: "run_registered",
      currentRunId: "run-new",
      generation: 2,
    });

    expect(store.acceptSteerDelivery(sessionId, "steer-one", oldTarget)).toBe(
      false,
    );
    expect(store.deliverySnapshot(sessionId)).toMatchObject({
      queued: [],
      steered: [],
      pendingSteers: [{ target: oldTarget }],
    });
    expect(store.rejectSteerDelivery(sessionId, "steer-one", oldTarget)).toBe(
      true,
    );
    expect(store.deliverySnapshot(sessionId)).toMatchObject({
      queued: [{ id: "steer-one" }],
      steered: [],
      pendingSteers: [],
    });
  });

  test("batches compatibility effects in one store transaction", async () => {
    expect(
      store.enqueueOutboxMany("compatibility", [
        { kind: "one", payload: { n: 1 }, effectKey: "a" },
        { kind: "two", payload: { n: 2 }, effectKey: "b" },
      ]),
    ).toHaveLength(2);
    expect(store.pendingOutbox().map((effect) => effect.effectKey)).toEqual([
      "a",
      "b",
    ]);
  });

  test("actor-owned delivery maps isolate nested mutable values", async () => {
    const map = new DeliveryOwnedMap<Array<{ nested: { values: string[] } }>>(
      "queued",
    );
    const source = [{ nested: { values: ["a"] } }];
    await map.set("nested-session", source);
    source[0].nested.values.push("source");
    const read = map.get("nested-session")!;
    read[0].nested.values.push("reader");
    expect(map.get("nested-session")?.[0].nested.values).toEqual(["a"]);
  });

  test("read projections do not activate dormant sessions", async () => {
    const projection = new DeliveryOwnedMap<string>("queued");
    expect(projection.get("dormant")).toBeUndefined();
    expect(activeSessionKernels()).toHaveLength(0);
  });
});

describe("SessionKernel durable runtime", () => {
  test("admits opening projections beyond the eight-turn engine limit", async () => {
    const { drainSessionKernelRuntime, waitForSessionKernelRuntimeIdle } =
      await import("./runtime");
    const { ensureCreationEffectExecutors } =
      await import("./creation-effect-executors");
    const { replaceSessionEffectExecutorForTest } =
      await import("./effect-executors");
    ensureCreationEffectExecutors();
    let started = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const unregister = replaceSessionEffectExecutorForTest(
      "creation_opening_turn",
      async () => {
        started += 1;
        await blocked;
      },
    );
    try {
      for (let index = 0; index < 9; index += 1) {
        const sessionId = `opening-admission-${index}`;
        const entryId = `entry-${index}`;
        store.enqueueOutbox(
          sessionId,
          "creation_opening_turn",
          {
            creationIdentity: `identity-${index}`,
            creationGeneration: 1,
            openingPromptEntryId: entryId,
            runId: `opening:${sessionId}:${entryId}`,
            runGeneration: 1,
            mode: "adopt_or_launch",
          },
          `effect-${index}`,
        );
      }
      await drainSessionKernelRuntime();
      await Bun.sleep(10);
      expect(started).toBe(9);
    } finally {
      release();
      await waitForSessionKernelRuntimeIdle();
      unregister();
    }
  });

  test("fires a durable timer once and removes it after acknowledgement", async () => {
    const {
      drainSessionKernelRuntime,
      registerSessionTimerHandler,
      waitForSessionKernelRuntimeIdle,
    } = await import("./runtime");
    let calls = 0;
    const unregister = registerSessionTimerHandler("test_timer", () => {
      calls += 1;
    });
    try {
      sessionKernel("timer-session").scheduleTimer({
        timerId: "wake",
        kind: "test_timer",
        dueAt: Date.now() - 1,
        payload: { value: 1 },
      });
      await drainSessionKernelRuntime();
      await waitForSessionKernelRuntimeIdle();
      await drainSessionKernelRuntime();
      expect(calls).toBe(1);
      expect(store.timer("timer-session", "wake")).toBeUndefined();
    } finally {
      unregister();
    }
  });

  test("retires a timer without replay after actor completion survives a crash", async () => {
    store.scheduleTimer({
      sessionId: "timer-complete-crash",
      timerId: "wake",
      kind: "test_timer",
      dueAt: Date.now() - 1,
      payload: { value: 1 },
    });
    const timer = store.timer("timer-complete-crash", "wake")!;
    expect(store.beginTimerExecution(timer)).toBe("execute");
    store.completeCommand(
      timer.sessionId,
      `timer:${timer.timerId}:${timer.token}`,
      true,
    );
    expect(store.timer(timer.sessionId, timer.timerId)).toBeDefined();
    expect(store.beginTimerExecution(timer)).toBe("completed");
    expect(store.timer(timer.sessionId, timer.timerId)).toBeUndefined();
  });

  test("replays a timer when the actor did not commit handler completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-kernel-timer-replay-"));
    const path = join(dir, "kernel.sqlite");
    let durableStore = new SessionKernelStore(path);
    try {
      durableStore.scheduleTimer({
        sessionId: "timer-before-completion",
        timerId: "wake",
        kind: "test_timer",
        dueAt: 1,
        payload: null,
      });
      const timer = durableStore.timer("timer-before-completion", "wake")!;
      expect(durableStore.beginTimerExecution(timer)).toBe("execute");
      durableStore.close();
      durableStore = new SessionKernelStore(path);
      expect(durableStore.beginTimerExecution(timer)).toBe("execute");
    } finally {
      durableStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accounts timer runtime failures once per observed attempt", async () => {
    store.scheduleTimer({
      sessionId: "timer-runtime-failure",
      timerId: "wake",
      kind: "test_timer",
      dueAt: Date.now() - 1,
      payload: null,
    });
    const timer = store.timer("timer-runtime-failure", "wake")!;
    expect(
      store.recordTimerRuntimeFailure({
        ...timer,
        error: "actor completion failed",
        maxAttempts: 20,
        observedAttempts: 0,
      }),
    ).toEqual({ updated: true, deadLetteredNow: false });
    expect(
      store.recordTimerRuntimeFailure({
        ...timer,
        error: "same failure",
        maxAttempts: 20,
        observedAttempts: 0,
      }),
    ).toEqual({ updated: false, deadLetteredNow: false });
    expect(store.timer(timer.sessionId, timer.timerId)?.attempts).toBe(1);
  });

  test("stale timer settlement cannot mutate a replacement generation", async () => {
    const sessionId = "timer-stale-settlement";
    store.scheduleTimer({
      sessionId,
      timerId: "wake",
      kind: "test_timer",
      dueAt: 1,
      payload: "first",
    });
    const first = store.timer(sessionId, "wake")!;
    expect(store.beginTimerExecution(first)).toBe("execute");
    store.scheduleTimer({
      sessionId,
      timerId: "wake",
      kind: "test_timer",
      dueAt: 1,
      payload: "second",
    });
    const replacement = store.timer(sessionId, "wake")!;
    expect(store.completeTimerExecution(first)).toBe(false);
    expect(
      store.recordTimerRuntimeFailure({
        ...first,
        error: "stale",
        maxAttempts: 20,
        observedAttempts: 0,
      }),
    ).toEqual({ updated: false, deadLetteredNow: false });
    expect(store.timer(sessionId, "wake")).toMatchObject({
      token: replacement.token,
      payload: "second",
      attempts: 0,
    });
  });

  test("same-id same-time replacement gets a distinct firing receipt", async () => {
    const { fireSessionTimer, registerSessionTimerHandler } =
      await import("./runtime");
    const sessionId = "timer-replacement";
    const dueAt = Date.now() - 1;
    let calls = 0;
    const unregister = registerSessionTimerHandler("replace_timer", () => {
      calls += 1;
    });
    try {
      sessionKernel(sessionId).scheduleTimer({
        timerId: "wake",
        kind: "replace_timer",
        dueAt,
        payload: 1,
      });
      const first = store.timer(sessionId, "wake")!;
      await fireSessionTimer(first);
      sessionKernel(sessionId).scheduleTimer({
        timerId: "wake",
        kind: "replace_timer",
        dueAt,
        payload: 1,
      });
      const second = store.timer(sessionId, "wake")!;
      expect(second.token).not.toBe(first.token);
      await fireSessionTimer(second);
      expect(calls).toBe(2);
    } finally {
      unregister();
    }
  });

  test("stale timer failure cannot back off a replacement generation", async () => {
    store.scheduleTimer({
      sessionId: "stale-failure",
      timerId: "same",
      kind: "test",
      dueAt: 1,
      payload: 1,
    });
    const stale = store.timer("stale-failure", "same")!;
    store.scheduleTimer({
      sessionId: "stale-failure",
      timerId: "same",
      kind: "test",
      dueAt: 1,
      payload: 2,
    });
    expect(
      store.noteTimerFailure("stale-failure", "same", "old", 20, stale.token),
    ).toEqual({ updated: false, deadLetteredNow: false });
    expect(store.timer("stale-failure", "same")).toMatchObject({
      payload: 2,
      attempts: 0,
    });
  });

  test("re-enters replay-safe timer handlers after ordinary failures", async () => {
    const {
      drainSessionKernelRuntime,
      registerSessionTimerHandler,
      waitForSessionKernelRuntimeIdle,
    } = await import("./runtime");
    let calls = 0;
    const unregister = registerSessionTimerHandler("retry_timer", () => {
      calls += 1;
      if (calls === 1) throw new Error("ordinary delivery failure");
    });
    try {
      sessionKernel("retry-timer").scheduleTimer({
        timerId: "wake",
        kind: "retry_timer",
        dueAt: Date.now() - 1,
        payload: null,
      });
      await drainSessionKernelRuntime();
      await waitForSessionKernelRuntimeIdle();
      await Bun.sleep(1_050);
      await drainSessionKernelRuntime();
      await waitForSessionKernelRuntimeIdle();
      expect(calls).toBe(2);
      expect(store.timer("retry-timer", "wake")).toBeUndefined();
    } finally {
      unregister();
    }
  });

  test("backs off failed timers instead of refiring every runtime tick", async () => {
    sessionKernel("timer-backoff").scheduleTimer({
      timerId: "wake",
      kind: "missing",
      dueAt: Date.now() - 1,
      payload: null,
    });
    store.noteTimerFailure("timer-backoff", "wake", "temporary");
    expect(store.dueTimers()).toHaveLength(0);
    expect(store.timer("timer-backoff", "wake")).toMatchObject({
      attempts: 1,
      lastError: "temporary",
    });
  });

  test("dead-letters poison timers after bounded attempts", async () => {
    sessionKernel("timer-poison").scheduleTimer({
      timerId: "wake",
      kind: "broken",
      dueAt: Date.now() - 1,
      payload: null,
    });
    for (let attempt = 0; attempt < 20; attempt++)
      store.noteTimerFailure("timer-poison", "wake", "still broken", 20);
    expect(store.dueTimers(Date.now() + 60 * 60_000)).toHaveLength(0);
    expect(store.stats().deadLetteredTimers).toBe(1);
    expect(store.retryDeadTimer("timer-poison", "wake")).toBe(true);
    expect(store.dueTimers(Date.now() + 60 * 60_000)).toHaveLength(1);
  });

  test("unknown durable kinds cannot starve registered work", async () => {
    const {
      drainSessionKernelRuntime,
      registerSessionTimerHandler,
      waitForSessionKernelRuntimeIdle,
    } = await import("./runtime");
    const { replaceSessionEffectExecutorForTest } =
      await import("./effect-executors");
    for (let i = 0; i < 120; i++) {
      store.enqueueOutbox(`unknown-${i}`, "future_effect", null, String(i));
      store.scheduleTimer({
        sessionId: `unknown-${i}`,
        timerId: "future",
        kind: "future_timer",
        dueAt: Date.now() - 1,
        payload: null,
      });
    }
    store.enqueueOutbox(
      "known",
      "human_ask_deliver",
      { askId: "known", skipUi: false },
      "known",
    );
    store.scheduleTimer({
      sessionId: "known",
      timerId: "known",
      kind: "known_timer",
      dueAt: Date.now() - 1,
      payload: null,
    });
    let effects = 0;
    let timers = 0;
    const unregisterEffect = replaceSessionEffectExecutorForTest(
      "human_ask_deliver",
      () => {
        effects += 1;
      },
    );
    const unregisterTimer = registerSessionTimerHandler("known_timer", () => {
      timers += 1;
    });
    try {
      await drainSessionKernelRuntime();
      await waitForSessionKernelRuntimeIdle();
      expect(effects).toBe(1);
      expect(timers).toBe(1);
    } finally {
      unregisterEffect();
      unregisterTimer();
    }
  });

  test("dead-letters a poison outbox effect after its bounded attempts", async () => {
    const id = store.enqueueOutbox("poison", "notify", null, "one");
    for (let attempt = 0; attempt < 20; attempt++)
      store.noteOutboxFailure(id, "still broken", 20);
    expect(store.pendingOutbox(Date.now() + 60 * 60_000)).toHaveLength(0);
    expect(store.stats().pendingOutbox).toBe(0);
    expect(store.stats().deadLetteredOutbox).toBe(1);
    expect(store.discardDeadOutbox(id)).toBe(true);
    expect(store.stats().deadLetteredOutbox).toBe(0);
  });

  test("dead-lettered creation effects fail their actor lifecycle", async () => {
    const { CreationEffectIndeterminateError, ensureCreationEffectExecutors } =
      await import("./creation-effect-executors");
    const { drainSessionKernelRuntime, waitForSessionKernelRuntimeIdle } =
      await import("./runtime");
    const { replaceSessionEffectExecutorForTest } =
      await import("./effect-executors");
    ensureCreationEffectExecutors();
    store.applyCreationEvent({
      sessionId: "creation-dead",
      identity: "identity-dead",
      event: "plan",
    });
    store.applyCreationEvent({
      sessionId: "creation-dead",
      identity: "identity-dead",
      event: "preparation_started",
      nextEffectId: "sandbox:dead",
      effect: {
        kind: "creation_sandbox_prepare",
        effectKey: "sandbox:dead",
        payload: {
          creationIdentity: "identity-dead",
          creationGeneration: 1,
          provider: "modal",
          sandboxKey: "creation-dead",
          mode: "adopt_or_create",
        },
      },
    });
    const unregister = replaceSessionEffectExecutorForTest(
      "creation_sandbox_prepare",
      () => {
        throw new CreationEffectIndeterminateError("ambiguous sandbox");
      },
    );
    try {
      await drainSessionKernelRuntime();
      await waitForSessionKernelRuntimeIdle();
      expect(store.creationState("creation-dead")).toMatchObject({
        state: "failed",
        currentEffectId: undefined,
        completedEffectIds: ["sandbox:dead"],
      });
      expect(store.stats().deadLetteredOutbox).toBe(1);
    } finally {
      unregister();
    }
  });

  test("re-admits only pre-execution branch compatibility false positives", async () => {
    const sharedPayload = {
      creationIdentity: "creation-one",
      creationGeneration: 1,
      project: "opensession",
      branch: "feature",
      worktreePath: "/srv/opensession",
      isolated: false,
      mode: "adopt_or_create",
    };
    const matching = store.enqueueOutbox(
      "shared-session",
      "creation_branch_prepare",
      sharedPayload,
      "shared-branch",
    );
    const ordinary = store.enqueueOutbox(
      "ordinary-session",
      "creation_branch_prepare",
      { ...sharedPayload, worktreePath: "/srv/ordinary" },
      "ordinary-branch",
    );
    const legacyEmptyBase = store.enqueueOutbox(
      "legacy-session",
      "creation_branch_prepare",
      {
        ...sharedPayload,
        project: "tella-fusion",
        worktreePath: "/srv/tella-fusion-feature",
        baseBranch: "",
      },
      "legacy-empty-base",
    );
    const differentFailure = store.enqueueOutbox(
      "different-session",
      "creation_branch_prepare",
      sharedPayload,
      "different-failure",
    );
    const ownEffect = (
      sessionId: string,
      effectKey: string,
      payload: Record<string, unknown>,
    ) => {
      store.applyCreationEvent({
        sessionId,
        identity: String(payload.creationIdentity),
        event: "plan",
      });
      store.applyCreationEvent({
        sessionId,
        identity: String(payload.creationIdentity),
        event: "preparation_started",
        nextEffectId: effectKey,
        effect: {
          kind: "creation_branch_prepare",
          effectKey,
          payload: payload as any,
        },
      });
    };
    ownEffect("shared-session", "shared-branch", sharedPayload);
    ownEffect("ordinary-session", "ordinary-branch", {
      ...sharedPayload,
      worktreePath: "/srv/ordinary",
    });
    ownEffect("legacy-session", "legacy-empty-base", {
      ...sharedPayload,
      project: "tella-fusion",
      worktreePath: "/srv/tella-fusion-feature",
      baseBranch: "",
    });
    ownEffect("different-session", "different-failure", sharedPayload);
    store.noteOutboxFailure(
      matching,
      "Worktree destination /srv/opensession exists without a registered branch",
      1,
    );
    store.noteOutboxFailure(
      ordinary,
      "Worktree destination /srv/ordinary exists without a registered branch",
      1,
    );
    store.noteOutboxFailure(
      legacyEmptyBase,
      "Invalid creation_branch_prepare effect payload: baseBranch",
      1,
    );
    store.noteOutboxFailure(differentFailure, "credential unavailable", 1);

    expect(
      store.retryCompatibleCreationBranchDeadLetters([
        { project: "opensession", worktreePath: "/srv/opensession" },
      ]),
    ).toEqual([
      {
        id: matching,
        sessionId: "shared-session",
        reason: "shared_checkout_destination_adoptable",
      },
      {
        id: legacyEmptyBase,
        sessionId: "legacy-session",
        reason: "legacy_empty_base_branch",
      },
    ]);
    expect(
      store.pendingOutbox(Date.now() + 1_000).map((item) => item.id),
    ).toEqual([matching, legacyEmptyBase]);
    expect(store.stats().deadLetteredOutbox).toBe(2);
  });

  test("retries an outbox effect until it succeeds", async () => {
    const { drainSessionKernelRuntime, waitForSessionKernelRuntimeIdle } =
      await import("./runtime");
    const { replaceSessionEffectExecutorForTest } =
      await import("./effect-executors");
    let calls = 0;
    const unregister = replaceSessionEffectExecutorForTest(
      "human_ask_deliver",
      () => {
        calls += 1;
        if (calls === 1) throw new Error("temporary");
      },
    );
    try {
      await sessionKernel("outbox-session").enqueueEffect("human_ask_deliver", {
        askId: "retry",
        skipUi: false,
      });
      await drainSessionKernelRuntime();
      await waitForSessionKernelRuntimeIdle();
      expect(store.pendingOutbox(Date.now() + 2_000)).toHaveLength(1);
      await Bun.sleep(1_050);
      await drainSessionKernelRuntime();
      await waitForSessionKernelRuntimeIdle();
      expect(calls).toBe(2);
      expect(store.pendingOutbox()).toHaveLength(0);
    } finally {
      unregister();
    }
  });
});
