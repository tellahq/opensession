import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionKernelStoreHost } from "./store-host";
import { SessionKernelStore, sessionKernelSessionDbPath } from "./store";

const roots: string[] = [];
function paths() {
  const root = mkdtempSync(join(tmpdir(), "session-kernel-host-"));
  roots.push(root);
  return {
    root,
    central: join(root, "session-kernel.sqlite"),
    isolated: join(root, "sessions"),
  };
}

function runtimeWork(
  host: SessionKernelStoreHost,
  now: number,
  timerKinds: string[],
  effectKinds: string[],
  limit: number,
  additionalOutboxGroups: Array<{ effectKinds: string[]; limit: number }> = [],
  activeOutbox: Array<{ id: number; sessionId: string }> = [],
  activeOutboxRecheckAt = now,
) {
  const catalog = host.runtimeCatalogWork(
    now,
    timerKinds,
    effectKinds,
    limit,
    additionalOutboxGroups,
    activeOutbox,
  );
  const timers = [...catalog.timers];
  const outbox = new Map(catalog.outbox.map((item) => [item.id, item]));
  for (const sessionId of catalog.sessionIds) {
    const work = host.runtimeSessionWork(
      sessionId,
      catalog.sessionIds.length,
      now,
      timerKinds,
      effectKinds,
      limit,
      additionalOutboxGroups,
      activeOutbox,
      activeOutboxRecheckAt,
    );
    timers.push(...work.timers);
    for (const item of work.outbox) outbox.set(item.id, item);
  }
  return { timers: timers.slice(0, limit), outbox: [...outbox.values()] };
}

function failWithSqliteIo(store: SessionKernelStore, method: string): void {
  Object.defineProperty(store, method, {
    configurable: true,
    value: () => {
      const error = new Error("disk I/O error");
      Object.assign(error, { code: "SQLITE_IOERR" });
      throw error;
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("per-session session kernel storage", () => {
  test("claims a new session before writing only its isolated database", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    const state = host.call("setRunState", [
      {
        sessionId: "new-session",
        state: "running",
        event: "prompt",
        currentRunId: "run-one",
      },
    ]);

    expect(state).toMatchObject({ state: "running", currentRunId: "run-one" });
    expect(host.central.hasSessionDurableState("new-session")).toBe(false);
    expect(host.central.sessionPlacement("new-session")).toMatchObject({
      placement: "isolated",
      transcriptAuthority: "actor",
      needsScan: true,
    });
    expect(
      host.storeForSession("new-session").runState("new-session"),
    ).toMatchObject({
      state: "running",
      currentRunId: "run-one",
    });
    host.close();

    const isolated = new SessionKernelStore(
      sessionKernelSessionDbPath("new-session", path.isolated),
    );
    expect(isolated.runState("new-session").state).toBe("running");
    isolated.close();
  });

  test("reports kernel and transcript cache churn separately", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated, 1);
    for (const sessionId of ["cache-one", "cache-one", "cache-two"]) {
      host.call("setRunState", [{ sessionId, state: "idle", event: "seed" }]);
    }
    for (const sessionId of ["cache-one", "cache-one", "cache-two"]) {
      host.transcript({ op: "tail", sessionId, limit: 1 });
    }
    host.recordSqliteBusy(
      Object.assign(new Error("locked"), { code: "SQLITE_BUSY" }),
    );
    host.recordSqliteBusy(new Error("database is locked"));
    host.recordSqliteBusy(new Error("ordinary failure"));

    expect(host.metrics()).toEqual({
      kernelStoreCacheMisses: 2,
      kernelStoreCacheEvictions: 1,
      transcriptStoreCacheMisses: 2,
      transcriptStoreCacheEvictions: 1,
      sqliteBusy: 2,
    });
    host.close();
  });

  test("rejects an oversized transcript before claiming placement", () => {
    const path = paths();
    const sessionId = "oversized-transcript";
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    expect(() =>
      host.transcript({
        op: "append",
        sessionId,
        requestId: "oversized",
        entries: Array.from({ length: 10_001 }, (_, index) => ({
          id: String(index),
          type: "user" as const,
          timestamp: "2026-01-01T00:00:00.000Z",
          content: "x",
        })),
      }),
    ).toThrow("too many entries");
    expect(host.central.sessionPlacement(sessionId)).toBeUndefined();
    host.close();
  });

  test("publishes isolated placement before a new session's first transcript write", () => {
    const path = paths();
    const sessionId = "transcript-first-session";
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    expect(
      host.transcript({
        op: "append",
        sessionId,
        requestId: "append-first",
        entries: [
          {
            id: "first",
            type: "user",
            timestamp: "2026-01-01T00:00:00.000Z",
            content: "hello",
          },
        ],
      }),
    ).toMatchObject({ result: { inserted: 1 } });
    expect(host.central.sessionPlacement(sessionId)).toMatchObject({
      placement: "isolated",
      transcriptAuthority: "actor",
    });
    expect(host.central.hasSessionDurableState(sessionId)).toBe(false);
    host.close();
  });

  test("stores kernel and transcript tables in the same actor database", () => {
    const path = paths();
    const sessionId = "co-located-transcript";
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setRunState", [{ sessionId, state: "idle", event: "seed" }]);

    const appended = host.transcript({
      op: "append",
      sessionId,
      requestId: "append-one",
      entries: [
        {
          id: "entry-one",
          type: "user",
          timestamp: "2026-01-01T00:00:00.000Z",
          content: "hello",
        },
      ],
    });
    expect(appended).toMatchObject({
      replay: false,
      result: { firstSeq: 1, lastSeq: 1, inserted: 1, updated: 0 },
    });
    expect(host.transcript({ op: "tail", sessionId, limit: 10 })).toMatchObject(
      {
        firstSeq: 1,
        lastSeq: 1,
        entries: [{ id: "entry-one", seq: 1 }],
      },
    );
    expect(
      host.transcript({
        op: "append",
        sessionId,
        requestId: "append-one",
        entries: [
          {
            id: "entry-one",
            type: "user",
            timestamp: "2026-01-01T00:00:00.000Z",
            content: "hello",
          },
        ],
      }),
    ).toMatchObject({ replay: true });
    host.close();

    const actorDb = new Database(
      sessionKernelSessionDbPath(sessionId, path.isolated),
      { readonly: true },
    );
    const tables = (
      actorDb
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map(({ name }) => name);
    expect(tables).toContain("session_kernel_state");
    expect(tables).toContain("transcript_events");
    expect(
      actorDb
        .query(
          "SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?",
        )
        .get(sessionId),
    ).toEqual({ count: 1 });
    actorDb.close();

    const catalog = new Database(path.central, { readonly: true });
    expect(
      catalog
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transcript_events'",
        )
        .get(),
    ).toBeNull();
    catalog.close();
  });

  test("fences destination appends to the current run and Agent Host turn", () => {
    const path = paths();
    const sessionId = "destination-fence";
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    const kernel = host.storeForSession(sessionId, true);
    expect(
      kernel.applyRunEvent({
        sessionId,
        event: "prompt",
        runKey: "run-current",
      }).accepted,
    ).toBe(true);
    expect(
      kernel.registerAgentHostPlan({
        op: "register_plan",
        registrationId: "registration-current",
        sessionId,
        runId: "run-current",
        turnId: "turn-current",
        generation: 1,
        planHash: `sha256:${"a".repeat(64)}`,
      }).accepted,
    ).toBe(true);
    const request = {
      op: "append_destination" as const,
      sessionId,
      requestId: "transcript-destination:append-current",
      appendId: "append-current",
      runId: "run-current",
      turnId: "turn-current",
      generation: 1,
      entries: [
        {
          id: "destination-entry",
          type: "assistant" as const,
          timestamp: "2026-01-01T00:00:00.000Z",
          content: "current",
        },
      ],
    };
    expect(host.transcript(request)).toMatchObject({
      result: { firstSeq: 1, lastSeq: 1 },
    });
    expect(
      kernel.applyRunEvent({
        sessionId,
        event: "run_failed",
        runKey: "run-current",
      }).accepted,
    ).toBe(true);
    expect(host.transcript(request)).toMatchObject({ replay: true });
    for (const stale of [
      {
        ...request,
        requestId: "stale-run",
        appendId: "stale-run",
        runId: "run-old",
      },
      {
        ...request,
        requestId: "stale-turn",
        appendId: "stale-turn",
        turnId: "turn-old",
      },
      {
        ...request,
        requestId: "stale-generation",
        appendId: "stale-generation",
        generation: 2,
      },
    ])
      expect(() => host.transcript(stale)).toThrow("fence rejected");
    expect(host.transcript({ op: "count", sessionId })).toBe(1);
    host.close();
  });

  test("keeps a legacy session on the central database without dual writing", () => {
    const path = paths();
    const seed = new SessionKernelStore(path.central);
    seed.setRunState({
      sessionId: "legacy-session",
      state: "idle",
      event: "seed",
    });
    seed.close();

    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setRunState", [
      {
        sessionId: "legacy-session",
        state: "running",
        event: "prompt",
        currentRunId: "legacy-run",
      },
    ]);

    expect(host.central.sessionPlacement("legacy-session")).toBeUndefined();
    expect(host.central.runState("legacy-session")).toMatchObject({
      state: "running",
      currentRunId: "legacy-run",
    });
    host.close();
  });

  test("cuts a legacy session over without dual authority", () => {
    const path = paths();
    const sessionId = "legacy-cutover";
    const seed = new SessionKernelStore(path.central);
    seed.setRunState({
      sessionId,
      state: "running",
      event: "prompt",
      currentRunId: "legacy-run",
    });
    seed.setDeliverySlot(sessionId, "queued", [
      { id: "queued", content: "later" },
    ]);
    seed.scheduleTimer({
      sessionId,
      timerId: "wake",
      kind: "known_timer",
      dueAt: Date.now() - 1,
      payload: { stable: true },
    });
    const outboxId = seed.enqueueOutbox(
      sessionId,
      "known_effect",
      { stable: true },
      "legacy-effect",
    );
    seed.close();

    const host = new SessionKernelStoreHost(path.central, path.isolated);
    expect(host.migrateLegacySessions(1)).toBe(1);
    expect(host.central.sessionPlacement(sessionId)).toMatchObject({
      placement: "isolated",
      transcriptAuthority: "shared",
      needsScan: false,
    });
    expect(() =>
      host.transcript({
        op: "append",
        sessionId,
        requestId: "not-authoritative",
        entries: [
          {
            id: "blocked",
            type: "user",
            timestamp: "2026-01-01T00:00:00.000Z",
            content: "blocked",
          },
        ],
      }),
    ).toThrow("no isolated actor transcript placement");
    expect(host.central.hasSessionDurableState(sessionId)).toBe(false);
    expect(host.central.isolatedOutboxSessionId(outboxId)).toBe(sessionId);
    expect(host.storeForSession(sessionId).runState(sessionId)).toMatchObject({
      state: "running",
      currentRunId: "legacy-run",
    });
    expect(
      host.storeForSession(sessionId).deliverySnapshot(sessionId).queued,
    ).toEqual([{ id: "queued", content: "later" }]);
    expect(
      host.storeForSession(sessionId).timer(sessionId, "wake"),
    ).toBeTruthy();
    expect(host.storeForOutbox(outboxId).outboxSessionId(outboxId)).toBe(
      sessionId,
    );
    expect(host.call("ackOutbox", [outboxId])).toBeUndefined();
    expect(host.central.isolatedOutboxSessionId(outboxId)).toBeUndefined();
    host.close();

    const reopened = new SessionKernelStoreHost(path.central, path.isolated);
    expect(reopened.storeForSession(sessionId).runState(sessionId).state).toBe(
      "running",
    );
    expect(reopened.central.hasSessionDurableState(sessionId)).toBe(false);
    reopened.close();
  });

  test("publishes transcript authority last with an immutable migration receipt", () => {
    const path = paths();
    const sessionId = "transcript-cutover";
    const seed = new SessionKernelStore(path.central);
    seed.setRunState({ sessionId, state: "idle", event: "seed" });
    seed.close();

    const host = new SessionKernelStoreHost(path.central, path.isolated);
    expect(host.migrateLegacySessions(1)).toBe(1);
    expect(host.central.sessionPlacement(sessionId)?.transcriptAuthority).toBe(
      "shared",
    );

    const published = host.central.publishActorTranscriptAuthority(
      sessionId,
      "sha256:verified-target",
    );
    expect(published).toMatchObject({
      transcriptAuthority: "actor",
      transcriptMigrationReceipt: "sha256:verified-target",
    });
    expect(host.central.actorTranscriptSessionIds()).toEqual([sessionId]);
    expect(() =>
      host.central.publishActorTranscriptAuthority(
        sessionId,
        "sha256:other-target",
      ),
    ).toThrow("receipt conflict");

    expect(
      host.central.rollbackActorTranscriptAuthority(sessionId),
    ).toMatchObject({
      transcriptAuthority: "shared",
      transcriptMigrationReceipt: "sha256:verified-target",
    });
    expect(host.central.actorTranscriptSessionIds()).toEqual([]);
    host.close();
  });

  test("global diagnostics never open an unreadable session database", () => {
    const path = paths();
    const first = new SessionKernelStoreHost(path.central, path.isolated);
    first.call("setRunState", [
      {
        sessionId: "broken-session",
        state: "running",
        event: "prompt",
      },
    ]);
    first.call("setRunState", [
      {
        sessionId: "healthy-session",
        state: "running",
        event: "prompt",
      },
    ]);
    first.close();
    writeFileSync(
      sessionKernelSessionDbPath("broken-session", path.isolated),
      "not a sqlite database",
    );

    const recovered = new SessionKernelStoreHost(path.central, path.isolated);
    const cacheMisses = recovered.metrics().kernelStoreCacheMisses;
    expect(recovered.stats()).toMatchObject({
      sessions: 0,
      quarantinedSessions: 0,
    });
    expect(recovered.call("deadLetters", [100, 0])).toMatchObject({
      coverage: {
        quarantines: "catalog_projection",
        timers: "catalog_only",
        outbox: "catalog_only",
      },
    });
    expect(recovered.metrics().kernelStoreCacheMisses).toBe(cacheMisses);
    expect(
      recovered.central.quarantinedSession("broken-session"),
    ).toBeUndefined();
    expect(
      recovered.storeForSession("healthy-session").runState("healthy-session")
        .state,
    ).toBe("running");
    recovered.close();
  });

  test("refuses repair while isolated durable state still has a live run", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setRunState", [
      {
        sessionId: "repair-session",
        state: "running",
        event: "prompt",
      },
    ]);
    failWithSqliteIo(
      host.storeForSession("repair-session"),
      "releaseQuarantine",
    );
    host.central.quarantineSession(
      "repair-session",
      "disk I/O error",
      "runtime:scan",
    );

    expect(host.quarantinedSession("repair-session")).toMatchObject({
      repairable: false,
    });
    expect(host.call("releaseQuarantine", ["repair-session"])).toBe(false);
    expect(host.central.quarantinedSession("repair-session")).toBeDefined();
    expect(
      host.storeForSession("repair-session").runState("repair-session").state,
    ).toBe("running");
    host.close();
  });

  test("repairs only a settled session with no unfinished durable effects", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.central.quarantineSession(
      "settled-repair-session",
      "verified storage interruption",
      "runtime:scan",
    );

    expect(host.quarantinedSession("settled-repair-session")).toMatchObject({
      repairable: true,
    });
    expect(host.call("releaseQuarantine", ["settled-repair-session"])).toBe(
      true,
    );
    expect(host.quarantinedSession("settled-repair-session")).toBeUndefined();
    host.close();
  });

  test("repairs a committed outbox settlement while replay-safe lifecycle work remains", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    const sessionId = "committed-outbox-repair";
    host.call("setRunState", [{ sessionId, state: "idle", event: "seed" }]);
    const settledId = host.call("enqueueOutbox", [
      sessionId,
      "turn_outcome_project",
      { projectionId: "settled" },
      "settled",
    ]) as number;
    const pendingId = host.call("enqueueOutbox", [
      sessionId,
      "turn_outcome_project",
      { projectionId: "pending" },
      "pending",
    ]) as number;

    // Actor reducers settle in the isolated store directly. The central route
    // deliberately remains as durable ownership evidence until maintenance.
    host.storeForSession(sessionId).ackOutbox(settledId);
    host.quarantineSession(
      sessionId,
      `Outbox ${settledId} crossed session ownership`,
      "core:ack_outbox",
    );

    expect(host.central.isolatedOutboxSessionId(settledId)).toBe(sessionId);
    expect(host.quarantinedSession(sessionId)).toMatchObject({
      repairable: true,
    });
    expect(host.call("releaseQuarantine", [sessionId])).toBe(true);
    expect(host.quarantinedSession(sessionId)).toBeUndefined();
    expect(host.storeForSession(sessionId).pendingOutbox()).toEqual([
      expect.objectContaining({ id: pendingId }),
    ]);
    host.close();
  });

  test("does not repair an outbox ownership mismatch without matching route evidence", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    const owner = "actual-outbox-owner";
    const wrongSession = "wrong-outbox-owner";
    host.call("setRunState", [
      { sessionId: owner, state: "idle", event: "seed" },
    ]);
    host.call("setRunState", [
      {
        sessionId: wrongSession,
        state: "idle",
        event: "seed",
      },
    ]);
    const outboxId = host.call("enqueueOutbox", [
      owner,
      "turn_outcome_project",
      { projectionId: "owned" },
      "owned",
    ]) as number;
    host.call("enqueueOutbox", [
      wrongSession,
      "turn_outcome_project",
      { projectionId: "still-pending" },
      "still-pending",
    ]);
    host.quarantineSession(
      wrongSession,
      `Outbox ${outboxId} crossed session ownership`,
      "core:ack_outbox",
    );

    expect(host.quarantinedSession(wrongSession)).toMatchObject({
      repairable: false,
    });
    expect(host.call("releaseQuarantine", [wrongSession])).toBe(false);
    host.close();
  });

  test("contains failures from already-open isolated databases per session", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    for (const sessionId of ["runtime-broken", "healthy-session"]) {
      host.call("setRunState", [
        { sessionId, state: "running", event: "prompt" },
      ]);
    }

    failWithSqliteIo(host.storeForSession("runtime-broken"), "dueTimers");

    expect(() => runtimeWork(host, Date.now(), [], [], 100)).not.toThrow();
    expect(host.quarantinedSession("runtime-broken")).toMatchObject({
      commandKind: "runtime:scan",
    });
    expect(
      host.storeForSession("healthy-session").runState("healthy-session").state,
    ).toBe("running");

    // A failure in the central identity allocator is not misattributed to the
    // isolated session. It must escape so the actor can fail-stop globally.
    failWithSqliteIo(host.central, "allocateIsolatedOutboxId");
    expect(() =>
      host.call("enqueueOutbox", [
        "healthy-session",
        "known_effect",
        null,
        "central-failure",
      ]),
    ).toThrow("disk I/O error");
    expect(host.quarantinedSession("healthy-session")).toBeUndefined();
    host.close();
  });

  test("lazily reactivates a passivated session store", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated, 1);
    host.call("setRunState", [
      {
        sessionId: "first-session",
        state: "running",
        event: "first",
        currentRunId: "first-run",
      },
    ]);
    const firstActivation = host.storeForSession("first-session");

    host.call("setRunState", [
      {
        sessionId: "second-session",
        state: "running",
        event: "second",
        currentRunId: "second-run",
      },
    ]);
    expect(() => firstActivation.command("first-session", "missing")).toThrow();

    expect(
      host.storeForSession("first-session").runState("first-session"),
    ).toMatchObject({ state: "running", currentRunId: "first-run" });
    const cacheMisses = host.metrics().kernelStoreCacheMisses;
    expect(host.stats()).toMatchObject({ sessions: 0, quarantinedSessions: 0 });
    expect(host.metrics().kernelStoreCacheMisses).toBe(cacheMisses);
    host.close();
  });

  test("pages wake candidates in the catalog instead of rotating a fixed prefix", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    for (let index = 0; index < 250; index += 1) {
      const sessionId = `due-${String(index).padStart(3, "0")}`;
      host.central.claimIsolatedSession(sessionId);
      host.central.settleIsolatedSessionWake(sessionId, 0, undefined);
    }
    const first = host.central.isolatedWakeCandidates(Date.now(), 100);
    const second = host.central.isolatedWakeCandidates(
      Date.now(),
      100,
      first.at(-1),
    );
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(100);
    expect(new Set([...first, ...second]).size).toBe(200);
    expect(second[0]).toBe("due-100");
    host.close();
  });

  test("fails closed on conflicting central and isolated outbox routes", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    const id = host.call("enqueueOutbox", [
      "isolated-route-session",
      "known_effect",
      null,
      "isolated-effect",
    ]) as number;
    const central = new Database(path.central);
    central.run(
      `
      INSERT INTO session_kernel_outbox
        (id, effect_id, effect_key, session_id, kind, payload, attempts,
         next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'null', 0, 0, ?)
    `,
      [
        id,
        "central-conflict:known_effect:central-effect",
        "central-effect",
        "central-conflict",
        "known_effect",
        Date.now(),
      ],
    );
    central.close();

    expect(() => host.outboxSessionId(id)).toThrow(
      "conflicting central and isolated route evidence",
    );
    expect(() => host.storeForOutbox(id)).toThrow(
      "conflicting central and isolated route evidence",
    );
    host.close();
  });

  test("keeps sparse global projections current after mutations", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setAskRecord", [
      "cache-session",
      {
        questionId: "ask-one",
        questions: [{ question: "First?" }],
      },
    ]);
    host.call("setDeliverySlot", [
      "cache-session",
      "queued",
      [{ id: "queue-one", content: "First" }],
    ]);

    const asks = host.allAskEntries();
    const deliveries = host.allDeliveryEntries("queued");
    (asks[0]![1] as { questionId: string }).questionId = "caller-mutated";
    (deliveries[0]![1] as Array<{ content: string }>)[0]!.content =
      "caller-mutated";
    expect(host.allAskEntries()[0]![1]).toMatchObject({
      questionId: "ask-one",
    });
    expect(host.allDeliveryEntries("queued")[0]![1]).toMatchObject([
      { id: "queue-one", content: "First" },
    ]);

    Object.defineProperty(host.storeForSession("cache-session"), "askEntries", {
      configurable: true,
      value: () => {
        throw new Error("cached ask entries must not rescan isolated stores");
      },
    });
    Object.defineProperty(
      host.storeForSession("cache-session"),
      "deliveryEntries",
      {
        configurable: true,
        value: () => {
          throw new Error(
            "cached delivery entries must not rescan isolated stores",
          );
        },
      },
    );
    host.call("setRunState", [
      {
        sessionId: "cache-session",
        state: "running",
        event: "cache-test",
      },
    ]);
    expect(host.allAskEntries()[0]![1]).toMatchObject({
      questionId: "ask-one",
    });
    expect(host.allDeliveryEntries("queued")[0]![1]).toMatchObject([
      { id: "queue-one", content: "First" },
    ]);

    host.call("deleteAskRecord", ["cache-session"]);
    host.call("setDeliverySlot", [
      "cache-session",
      "queued",
      [{ id: "queue-two", content: "Second" }],
    ]);
    expect(host.allAskEntries()).toEqual([]);
    expect(host.allDeliveryEntries("queued")[0]![1]).toMatchObject([
      { id: "queue-two", content: "Second" },
    ]);
    host.close();
  });

  test("persists sparse projections across a catalog actor restart", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setAskRecord", [
      "durable-projection",
      {
        questionId: "ask-durable",
        questions: [{ question: "Still there?" }],
      },
    ]);
    host.call("setDeliverySlot", [
      "durable-projection",
      "queued",
      [{ id: "queue-durable", content: "Keep me" }],
    ]);
    expect(host.allAskEntries()).toHaveLength(1);
    host.close();

    const recovered = new SessionKernelStoreHost(path.central, path.isolated);
    Object.defineProperty(
      recovered.storeForSession("durable-projection"),
      "askEntries",
      {
        configurable: true,
        value: () => {
          throw new Error("restart must not scan isolated ask tables");
        },
      },
    );
    Object.defineProperty(
      recovered.storeForSession("durable-projection"),
      "deliveryEntries",
      {
        configurable: true,
        value: () => {
          throw new Error("restart must not scan isolated delivery tables");
        },
      },
    );
    expect(recovered.allAskEntries()[0]).toMatchObject([
      "durable-projection",
      { questionId: "ask-durable" },
    ]);
    expect(recovered.allDeliveryEntries("queued")[0]).toMatchObject([
      "durable-projection",
      [{ id: "queue-durable", content: "Keep me" }],
    ]);
    recovered.close();
  });

  test("lists quarantines from durable projections without scanning isolated stores", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    for (const sessionId of ["quarantine-projection", "unrelated-session"])
      host.call("setRunState", [{ sessionId, state: "idle", event: "seed" }]);
    host.quarantineSession(
      "quarantine-projection",
      "execution ownership became ambiguous",
      "run",
    );
    expect(host.allQuarantinedSessions()).toHaveLength(1);
    host.close();

    const recovered = new SessionKernelStoreHost(path.central, path.isolated);
    Object.defineProperty(recovered, "quarantinedSession", {
      configurable: true,
      value: () => {
        throw new Error(
          "catalog listing must not open authoritative session stores",
        );
      },
    });
    Object.defineProperty(
      recovered.storeForSession("unrelated-session"),
      "quarantinedSessions",
      {
        configurable: true,
        value: () => {
          throw new Error("quarantine listing must not scan unrelated stores");
        },
      },
    );
    expect(recovered.allQuarantinedSessions()).toMatchObject([
      {
        sessionId: "quarantine-projection",
        commandKind: "run",
      },
    ]);
    recovered.close();
  });

  test("publishes projections for new actors without an online backfill sweep", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setRunState", [
      {
        sessionId: "projected-at-claim",
        state: "idle",
        event: "seed",
      },
    ]);

    expect(host.central.isolatedProjectionPendingSessionIds(1)).toEqual([]);
    expect(host.allAskEntries()).toEqual([]);
    expect(host.central.sparseProjectionMigrationComplete()).toBe(true);
    host.close();
  });

  test("settles only isolated stores that contain pending steers", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setRunState", [
      {
        sessionId: "empty-session",
        state: "idle",
        event: "seed",
      },
    ]);
    host.call("setRunState", [
      {
        sessionId: "pending-session",
        state: "running",
        event: "run_registered",
        currentRunId: "run-one",
        generation: 1,
      },
    ]);
    host.call("prepareSteerDelivery", [
      "pending-session",
      "steer-one",
      { token: "token-one", runId: "run-one", generation: 1 },
      { id: "steer-one", content: "recover me" },
    ]);
    Object.defineProperty(
      host.storeForSession("empty-session"),
      "settlePendingSteers",
      {
        configurable: true,
        value: () => {
          throw new Error("empty stores must not enter the mutation sweep");
        },
      },
    );

    expect(host.call("settlePendingSteers", [])).toBe(1);
    expect(
      host
        .storeForSession("pending-session")
        .deliverySnapshot("pending-session"),
    ).toMatchObject({
      pendingSteers: [],
      steered: [{ id: "steer-one", content: "recover me" }],
    });
    host.close();
  });

  test("rejects the retired global creation dead-letter sweep", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setRunState", [
      {
        sessionId: "empty-creation-session",
        state: "idle",
        event: "seed",
      },
    ]);
    expect(() =>
      host.call("retryCompatibleCreationBranchDeadLetters", [[], Date.now()]),
    ).toThrow("Unrouted session kernel store method");
    host.close();
  });

  test("recovers isolated wake work from the durable dirty placement", () => {
    const path = paths();
    const first = new SessionKernelStoreHost(path.central, path.isolated);
    first.call("scheduleTimer", [
      {
        sessionId: "wake-session",
        timerId: "wake",
        kind: "known_timer",
        dueAt: Date.now() - 1,
        payload: { stable: true },
      },
    ]);
    const outboxId = first.call("enqueueOutbox", [
      "wake-session",
      "known_effect",
      { stable: true },
      "effect-one",
    ]) as number;
    expect(outboxId).toBeGreaterThanOrEqual(4_000_000_000_000_000);
    expect(
      first.call("enqueueOutbox", [
        "wake-session",
        "known_effect",
        { stable: true },
        "effect-one",
      ]),
    ).toBe(outboxId);
    expect(first.central.isolatedOutboxRoutes()).toEqual([
      { id: outboxId, sessionId: "wake-session" },
    ]);
    expect(first.central.isolatedOutboxSessionId(outboxId)).toBe(
      "wake-session",
    );
    first.close();

    const recovered = new SessionKernelStoreHost(path.central, path.isolated);
    const work = runtimeWork(
      recovered,
      Date.now(),
      ["known_timer"],
      ["known_effect"],
      10,
    );
    expect(work.timers).toEqual([
      expect.objectContaining({ sessionId: "wake-session", timerId: "wake" }),
    ]);
    expect(work.outbox).toEqual([
      expect.objectContaining({
        id: outboxId,
        sessionId: "wake-session",
        effectKey: "effect-one",
      }),
    ]);

    recovered.call("ackOutbox", [outboxId]);
    expect(recovered.central.isolatedOutboxSessionId(outboxId)).toBeUndefined();
    expect(recovered.storeForSession("wake-session").pendingOutbox()).toEqual(
      [],
    );
    const successorId = recovered.call("enqueueOutbox", [
      "successor-session",
      "known_effect",
      null,
      "effect-two",
    ]) as number;
    expect(successorId).toBeGreaterThan(outboxId);
    expect(recovered.central.isolatedOutboxSessionId(successorId)).toBe(
      "successor-session",
    );
    recovered.close();
  });

  test("fetches separate outbox quotas while opening each actor once", () => {
    const path = paths();
    const first = new SessionKernelStoreHost(path.central, path.isolated);
    const sessionId = "grouped-runtime-work";
    first.call("enqueueOutbox", [
      sessionId,
      "ordinary_effect",
      null,
      "ordinary-one",
    ]);
    first.call("enqueueOutbox", [
      sessionId,
      "creation_opening_turn",
      null,
      "opening-one",
    ]);
    first.call("enqueueOutbox", [
      sessionId,
      "creation_opening_turn",
      null,
      "opening-two",
    ]);
    first.close();

    const recovered = new SessionKernelStoreHost(path.central, path.isolated);
    const work = runtimeWork(
      recovered,
      Date.now(),
      [],
      ["ordinary_effect"],
      1,
      [{ effectKinds: ["creation_opening_turn"], limit: 100 }],
    );

    expect(work.outbox.map((item) => item.kind)).toEqual([
      "ordinary_effect",
      "creation_opening_turn",
      "creation_opening_turn",
    ]);
    expect(recovered.metrics().kernelStoreCacheMisses).toBe(1);

    const recheckAt = Date.now() + 30_000;
    const whileActive = runtimeWork(
      recovered,
      Date.now(),
      [],
      ["ordinary_effect"],
      1,
      [{ effectKinds: ["creation_opening_turn"], limit: 100 }],
      work.outbox.map((item) => ({ id: item.id, sessionId: item.sessionId })),
      recheckAt,
    );
    expect(whileActive.outbox).toEqual([]);
    expect(
      recovered.central.isolatedDueWakeCandidates(recheckAt - 1, 100),
    ).not.toContain(sessionId);
    expect(
      recovered.central.isolatedDueWakeCandidates(recheckAt, 100),
    ).toContain(sessionId);
    recovered.close();
  });

  // Explicit budget: this test creates 24 per-session isolated databases,
  // which is real synchronous disk work (~4s warm locally, ~9s on GitHub's
  // 2-core runner) — the default 5s timeout flags slow hardware, not a hang.
  test("rotates through due isolated work in bounded runtime batches", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    const dueAt = Date.now() - 1;
    for (let index = 0; index < 24; index += 1) {
      host.call("scheduleTimer", [
        {
          sessionId: `bounded-runtime-${index.toString().padStart(2, "0")}`,
          timerId: "wake",
          kind: "known_timer",
          dueAt,
          payload: null,
        },
      ]);
    }

    const passes = Array.from({ length: 12 }, () =>
      runtimeWork(host, Date.now(), ["known_timer"], [], 100),
    );

    expect(passes.every((pass) => pass.timers.length === 4)).toBe(true);
    expect(
      new Set(
        passes.flatMap((pass) => pass.timers.map((timer) => timer.sessionId)),
      ).size,
    ).toBe(24);
    host.close();
  }, 30_000);

  test("discovers recently dirtied actor work ahead of a historical scan backlog", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    const dueAt = Date.now() - 1;
    for (let index = 0; index < 24; index += 1) {
      host.call("scheduleTimer", [
        {
          sessionId: `aaa-historical-${index.toString().padStart(2, "0")}`,
          timerId: "wake",
          kind: "known_timer",
          dueAt,
          payload: null,
        },
      ]);
    }
    host.call("scheduleTimer", [
      {
        sessionId: "zzz-live-create",
        timerId: "wake",
        kind: "known_timer",
        dueAt,
        payload: null,
      },
    ]);

    const first = runtimeWork(host, Date.now(), ["known_timer"], [], 100);
    expect(first.timers.map((timer) => timer.sessionId)).toContain(
      "zzz-live-create",
    );
    host.close();
  }, 30_000);

  test("discovers already-indexed due work ahead of a historical scan backlog", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    const dueAt = Date.now() - 1;
    host.call("scheduleTimer", [
      {
        sessionId: "zzz-overdue-effect",
        timerId: "wake",
        kind: "known_timer",
        dueAt,
        payload: null,
      },
    ]);
    host.central.settleIsolatedSessionWake("zzz-overdue-effect", dueAt);
    for (let index = 0; index < 24; index += 1) {
      host.call("scheduleTimer", [
        {
          sessionId: `aaa-recovery-${index.toString().padStart(2, "0")}`,
          timerId: "wake",
          kind: "known_timer",
          dueAt,
          payload: null,
        },
      ]);
    }

    const first = runtimeWork(host, Date.now(), ["known_timer"], [], 100);
    expect(first.timers.map((timer) => timer.sessionId)).toContain(
      "zzz-overdue-effect",
    );
    host.close();
  }, 30_000);

  test("rotates the priority slice past already-active due actors", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    const dueAt = Date.now() - 1;
    for (let index = 0; index < 6; index += 1) {
      const sessionId = `due-priority-${index.toString().padStart(2, "0")}`;
      host.call("scheduleTimer", [
        {
          sessionId,
          timerId: "wake",
          kind: "known_timer",
          dueAt,
          payload: null,
        },
      ]);
      host.central.settleIsolatedSessionWake(sessionId, dueAt);
    }

    const first = runtimeWork(host, Date.now(), ["known_timer"], [], 100);
    const second = runtimeWork(host, Date.now(), ["known_timer"], [], 100);
    const third = runtimeWork(host, Date.now(), ["known_timer"], [], 100);
    expect(
      new Set([
        ...first.timers.map((timer) => timer.sessionId),
        ...second.timers.map((timer) => timer.sessionId),
        ...third.timers.map((timer) => timer.sessionId),
      ]).size,
    ).toBe(6);
    host.close();
  }, 30_000);
});
