import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as mod from "./run-journal";
import * as agent from "./agent-runner";
import { clearRunState, getRunState, transitionRunState } from "./run-state";
import * as shared from "./runner-shared";
import type { StreamEvent } from "./run-events";
import { makeFakeEngine } from "./testing/fake-engine";
import { stripContext } from "./prompt-context";
import { __sessionKernelStoreForTest } from "./session-kernel/kernel";

// __setActiveRunsPathForTest repoints the LIVE ACTIVE_RUNS_PATH binding, so
// agent-runner.ts's own (already-cached, possibly earlier-imported-with-the-
// real-HOME) bare import of ./run-journal picks the scratch path up too —
// unlike a plain env-var-before-import, which only affects whichever test
// file happens to trigger the FIRST bare import of ./run-journal in the
// whole `bun test` process (order-dependent, and this file previously
// journaled into — and read back — the developer's real active-runs.json
// when run as part of the full suite).
let dir: string;
let oldJournal: string;
let oldForceLimit: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "backstage-run-journal-test-"));
  oldForceLimit = process.env.OPENSESSION_FORCE_LIMIT;
  oldJournal = mod.__setActiveRunsPathForTest(join(dir, "active-runs.json"));
});

afterEach(() => {
  agent.__setEngineForTest(null);
  agent.__setLocalHostResumeForTest(null);
  mod.__setActiveRunsPathForTest(oldJournal);
  if (oldForceLimit === undefined) delete process.env.OPENSESSION_FORCE_LIMIT;
  else process.env.OPENSESSION_FORCE_LIMIT = oldForceLimit;
  rmSync(dir, { recursive: true, force: true });
});

describe("run journal", () => {
  it("awaits run registration before journal admission completes", async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const events: string[] = [];
    const registration = mod.journalSet(
      {
        runKey: "awaited-registration",
        osSessionId: "awaited-registration-session",
        cwd: "/tmp",
        startedAt: new Date().toISOString(),
      },
      async (_sessionId, event) => {
        events.push(event);
        started.resolve();
        await gate.promise;
      },
    );
    let completed = false;
    void registration.then(() => {
      completed = true;
    });
    await started.promise;
    expect(completed).toBe(false);
    expect(events).toEqual(["run_registered"]);
    gate.resolve();
    await registration;
    expect(completed).toBe(true);
  });

  it("does not hand out boot records before transition settlement", async () => {
    const record: mod.ActiveRunRecord = {
      runKey: "awaited-boot-transition",
      osSessionId: "awaited-boot-session",
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(dir, "active-runs.json"),
      JSON.stringify({ [record.runKey]: record }),
    );
    const gate = Promise.withResolvers<void>();
    const taking = mod.takeInterruptedRuns(
      [],
      () => true,
      async () => {
        await gate.promise;
      },
    );
    let completed = false;
    void taking.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    gate.resolve();
    expect(await taking).toEqual([record]);

    const rejected: mod.ActiveRunRecord = {
      ...record,
      runKey: "rejected-boot-transition",
      osSessionId: "rejected-boot-session",
    };
    writeFileSync(
      join(dir, "active-runs.json"),
      JSON.stringify({ [rejected.runKey]: rejected }),
    );
    await expect(
      mod.takeInterruptedRuns(
        [],
        () => true,
        async () => {
          throw new Error("boot transition rejected");
        },
      ),
    ).rejects.toThrow("boot transition rejected");
    expect(mod.activeRunRecords()).toContainEqual(
      expect.objectContaining({ runKey: rejected.runKey }),
    );
  });
  it("keeps interrupted and reattaching sessions busy until recovery settles", async () => {
    const sessionId = `recovery-${crypto.randomUUID()}`;
    try {
      await transitionRunState(
        sessionId,
        "boot_journal_found",
        undefined,
        () => {},
      );
      expect(agent.isAgentSessionBusy(sessionId)).toBe(true);
      await transitionRunState(
        sessionId,
        "reattach_start",
        undefined,
        () => {},
      );
      expect(agent.isAgentSessionBusy(sessionId)).toBe(true);
      await transitionRunState(sessionId, "run_failed", undefined, () => {});
      expect(agent.isAgentSessionBusy(sessionId)).toBe(false);
    } finally {
      await clearRunState(sessionId);
    }
  });

  it("settles an exhausted recovery with a visible terminal error", async () => {
    const sessionId = `exhausted-${crypto.randomUUID()}`;
    const runKey = `run-${crypto.randomUUID()}`;
    const startedAt = new Date().toISOString();
    await mod.journalSet({
      runKey,
      osSessionId: sessionId,
      claudeSessionId: `engine-${crypto.randomUUID()}`,
      cwd: "/tmp",
      kind: "prompt-resume",
      resumeAttempts: agent.MAX_BOOT_RESUME_ATTEMPTS,
      firstJournaledAt: startedAt,
      startedAt,
    });
    // Simulate the fresh process: journalSet marked the old process running,
    // while restart recovery rebuilds state from the journal on boot.
    await clearRunState(sessionId);
    expect(agent.isAgentSessionBusy(sessionId)).toBe(true);
    let terminal: StreamEvent | undefined;
    let settlementStarted = false;
    const observerStarted = Promise.withResolvers<void>();
    const observerGate = Promise.withResolvers<void>();
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      const recovery = agent.resumeInterruptedRuns(
        (_id, event) => {
          settlementStarted = true;
          terminal = event;
        },
        undefined,
        undefined,
        undefined,
        async () => {
          observerStarted.resolve();
          await observerGate.promise;
          throw new Error("observer failed");
        },
      );
      await observerStarted.promise;
      expect(settlementStarted).toBe(false);
      expect(agent.isAgentSessionBusy(sessionId)).toBe(true);
      observerGate.resolve();
      expect(await recovery).toEqual([sessionId]);
      expect(terminal).toMatchObject({
        type: "error",
        content:
          "Restart recovery failed twice. Send the prompt again to continue.",
      });
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining("Recovered event observer failed"),
        expect.objectContaining({ message: "observer failed" }),
      );
      expect(agent.isAgentSessionBusy(sessionId)).toBe(false);
      expect(mod.activeRunRecords()).toEqual([]);
    } finally {
      errorLog.mockRestore();
      await clearRunState(sessionId);
    }
  });

  it("leaves a detached GitHub review journal for its posting workflow", async () => {
    const sessionId = `github-review-${crypto.randomUUID()}`;
    const runKey = `rh-${crypto.randomUUID()}`;
    try {
      await mod.journalSet({
        runKey,
        hostId: runKey,
        osSessionId: sessionId,
        prompt: "review this PR",
        cwd: "/tmp",
        kind: "github-review",
        startedAt: new Date().toISOString(),
      });
      await clearRunState(sessionId);

      expect(await agent.resumeInterruptedRuns()).toContain(sessionId);
      expect(mod.activeRunRecords().some((run) => run.runKey === runKey)).toBe(
        true,
      );
    } finally {
      mod.journalClear(runKey);
      await clearRunState(sessionId);
    }
  });

  it("keeps an unclaimed journal owner fenced until recovery proves it absent", async () => {
    const sessionId = `queued-recovery-${crypto.randomUUID()}`;
    const runKey = `run-${crypto.randomUUID()}`;
    try {
      await mod.journalSet({
        runKey,
        osSessionId: sessionId,
        claudeSessionId: `engine-${crypto.randomUUID()}`,
        cwd: "/tmp",
        startedAt: new Date().toISOString(),
      });
      expect(agent.isAgentSessionBusy(sessionId)).toBe(true);

      expect(await agent.cancelAgentRun(sessionId)).toBe(true);

      expect(agent.isAgentSessionBusy(sessionId)).toBe(true);
      expect(mod.activeRunRecords().some((run) => run.runKey === runKey)).toBe(
        true,
      );
    } finally {
      mod.journalClear(runKey);
      await clearRunState(sessionId);
    }
  });

  it("preserves a stopped journal owned by a durable cancel effect", async () => {
    const sessionId = `durable-stop-recovery-${crypto.randomUUID()}`;
    const runKey = `rh-${crypto.randomUUID()}`;
    const store = __sessionKernelStoreForTest();
    try {
      store.applyRunEvent({ sessionId, event: "prompt" });
      store.applyRunEvent({ sessionId, event: "run_registered", runKey });
      const generation = store.runState(sessionId).generation;
      store.prepareTurnCancel({
        sessionId,
        cancelId: `stop:${runKey}`,
        expectedRunId: runKey,
        expectedGeneration: generation,
        dispatchId: runKey,
        requeueIds: [],
        source: "test",
      });
      const recovery = {
        runKey,
        hostId: runKey,
        osSessionId: sessionId,
        cwd: "/tmp",
        startedAt: new Date().toISOString(),
      };
      expect(await agent.durableCancelOwnsRecovery(recovery)).toBe(true);
      store.settleTurnCancel({
        sessionId,
        cancelId: `stop:${runKey}`,
        outcome: "confirmed",
      });
      // A boot after actor settlement still restores the exact cancellation
      // latch before the detached control reconnects.
      expect(await agent.reissueDurableRecoveryCancel(recovery)).toBe(false);
      expect(agent.isAgentSessionCancelled(sessionId, runKey)).toBe(true);
      await mod.journalSet(recovery);
      await mod.journalRecordAbnormalCompletion(recovery);
      expect(mod.activeRunRecords().some((run) => run.runKey === runKey)).toBe(
        false,
      );
    } finally {
      agent.unmarkSessionStarting(sessionId, runKey);
      store.clearSession(sessionId);
    }
  });

  it("retires abnormal ownership when actor settlement wins the reverse race", async () => {
    const sessionId = `cancel-abnormal-reverse-${crypto.randomUUID()}`;
    const runKey = `rh-${crypto.randomUUID()}`;
    const store = __sessionKernelStoreForTest();
    const record: mod.ActiveRunRecord = {
      runKey,
      hostId: runKey,
      osSessionId: sessionId,
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
    };
    try {
      store.applyRunEvent({ sessionId, event: "prompt" });
      store.applyRunEvent({ sessionId, event: "run_registered", runKey });
      const generation = store.runState(sessionId).generation;
      store.prepareTurnCancel({
        sessionId,
        cancelId: `stop:${runKey}`,
        expectedRunId: runKey,
        expectedGeneration: generation,
        dispatchId: runKey,
        requeueIds: [],
        source: "test",
      });
      expect(
        store.beginTurnCancelEffect({
          sessionId,
          cancelId: `stop:${runKey}`,
          runGeneration: generation,
        }),
      ).toBe("execute");
      await mod.journalSet(record);
      await mod.journalRecordAbnormalCompletion(record);
      expect(mod.activeRunRecords().some((run) => run.runKey === runKey)).toBe(
        true,
      );
      store.settleTurnCancel({
        sessionId,
        cancelId: `stop:${runKey}`,
        outcome: "confirmed",
      });
      expect(
        await mod.journalRetireSettledCancelAbnormal(sessionId, runKey),
      ).toBe(true);
      expect(mod.activeRunRecords().some((run) => run.runKey === runKey)).toBe(
        false,
      );
    } finally {
      mod.journalClear(runKey);
      store.clearSession(sessionId);
    }
  });

  it("retires confirmed interrupt abnormal ownership in both race orders", async () => {
    const store = __sessionKernelStoreForTest();
    for (const sourceFirst of [true, false]) {
      const sessionId = `interrupt-abnormal-${sourceFirst}-${crypto.randomUUID()}`;
      const runKey = `rh-${crypto.randomUUID()}`;
      const interruptId = `interrupt-${crypto.randomUUID()}`;
      const record: mod.ActiveRunRecord = {
        runKey,
        hostId: runKey,
        osSessionId: sessionId,
        cwd: "/tmp",
        startedAt: new Date().toISOString(),
      };
      try {
        store.applyRunEvent({ sessionId, event: "prompt" });
        store.applyRunEvent({ sessionId, event: "run_registered", runKey });
        store.setDeliverySlot(sessionId, "queued", [
          { id: "anchor", content: "interrupt now" },
        ]);
        const prepared = store.prepareDeliveryInterrupt({
          sessionId,
          interruptId,
          anchorId: "anchor",
          dispatchId: runKey,
        });
        if (sourceFirst) {
          expect(
            store.beginDeliveryInterruptEffect({
              sessionId,
              interruptId,
              runGeneration: prepared.runGeneration,
            }),
          ).toBe("execute");
          await mod.journalSet(record);
          await mod.journalRecordAbnormalCompletion(record);
          expect(
            mod.activeRunRecords().some((run) => run.runKey === runKey),
          ).toBe(true);
        }
        store.settleDeliveryInterrupt({
          sessionId,
          interruptId,
          outcome: "confirmed",
        });
        if (sourceFirst) {
          expect(
            mod.journalRetireCancelledAbnormalAfterSettlement(
              sessionId,
              runKey,
            ),
          ).toBe(true);
        } else {
          await mod.journalSet(record);
          await mod.journalRecordAbnormalCompletion(record);
        }
        expect(
          mod.activeRunRecords().some((run) => run.runKey === runKey),
        ).toBe(false);
      } finally {
        mod.journalClear(runKey);
        store.clearSession(sessionId);
      }
    }
  });

  it("keeps an active cancelled recovery reserved until its worker exits", async () => {
    const sessionId = `active-recovery-${crypto.randomUUID()}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = makeFakeEngine([{ kind: "clean", gate }]);
    agent.__setEngineForTest(fake.engine);
    await mod.journalSet({
      runKey: `run-${crypto.randomUUID()}`,
      osSessionId: sessionId,
      prompt: "continue",
      cwd: "/tmp",
      model: "claude-fable-5-1",
      startedAt: new Date().toISOString(),
    });
    await clearRunState(sessionId);

    try {
      await agent.resumeInterruptedRuns();
      while (fake.calls.length === 0) await Bun.sleep(5);

      expect(await agent.cancelAgentRun(sessionId)).toBe(true);
      expect(getRunState(sessionId)).toBe("stopped");
      expect(agent.isAgentSessionBusy(sessionId)).toBe(true);

      release();
      while (agent.isAgentSessionBusy(sessionId)) await Bun.sleep(5);

      await agent.markSessionStarting(sessionId);
      expect(getRunState(sessionId)).toBe("starting");
      agent.unmarkSessionStarting(sessionId);
      await transitionRunState(sessionId, "start_aborted", undefined, () => {});
    } finally {
      release();
      await clearRunState(sessionId);
    }
  });

  it("settles a pre-journal terminal against its reserved dispatch token", async () => {
    const sessionId = `pre-journal-terminal-${crypto.randomUUID()}`;
    const token = await agent.markSessionStarting(sessionId);
    try {
      expect(__sessionKernelStoreForTest().runState(sessionId)).toMatchObject({
        state: "starting",
        currentRunId: token,
      });
      await transitionRunState(sessionId, "run_failed", {
        run_key: token,
        source: "pre_journal_failure",
      });
      expect(getRunState(sessionId)).toBe("failed");
    } finally {
      agent.unmarkSessionStarting(sessionId, token);
      await clearRunState(sessionId);
    }
  });

  it("keeps process and actor ownership on the first concurrent preparation", async () => {
    const sessionId = `preparation-winner-${crypto.randomUUID()}`;
    const firstToken = await agent.markSessionStarting(sessionId);
    const secondToken = await agent.markSessionStarting(sessionId);
    const store = __sessionKernelStoreForTest();
    try {
      expect(secondToken).not.toBe(firstToken);
      expect(agent.isAgentSessionCancelled(sessionId, secondToken)).toBe(true);
      expect(agent.currentAgentRunToken(sessionId)).toBe(firstToken);
      expect(store.runState(sessionId)).toMatchObject({
        state: "starting",
        currentRunId: firstToken,
      });
      expect(
        store.prepareTurnCancel({
          sessionId,
          cancelId: `stop:${firstToken}`,
          expectedRunId: firstToken,
          expectedGeneration: store.runState(sessionId).generation,
          dispatchId: firstToken,
          requeueIds: [],
          source: "test",
        }),
      ).toMatchObject({
        cancel: { runId: firstToken, phase: "prepared" },
        runState: { state: "stopped" },
      });
    } finally {
      agent.unmarkSessionStarting(sessionId, firstToken);
      agent.unmarkSessionStarting(sessionId, secondToken);
      store.clearSession(sessionId);
    }
  });

  it("uses one stable physical token without admitting a concurrent duplicate", async () => {
    const sessionId = `stable-preparation-${crypto.randomUUID()}`;
    const stableToken = `rh-opening-${crypto.randomUUID()}`;
    const admitted = await agent.markSessionStarting(sessionId, stableToken);
    const rejected = await agent.markSessionStarting(sessionId, stableToken);
    try {
      expect(admitted).toBe(stableToken);
      expect(rejected).not.toBe(stableToken);
      expect(agent.isAgentSessionCancelled(sessionId, rejected)).toBe(true);
      expect(agent.currentAgentRunToken(sessionId)).toBe(stableToken);
      expect(__sessionKernelStoreForTest().runState(sessionId)).toMatchObject({
        currentRunId: stableToken,
      });
    } finally {
      agent.unmarkSessionStarting(sessionId, rejected);
      agent.unmarkSessionStarting(sessionId, stableToken);
      await clearRunState(sessionId);
    }
  });

  it("replaces an actor start owner only after every physical owner is gone", async () => {
    const sessionId = `actor-preparation-orphan-${crypto.randomUUID()}`;
    const orphanedToken = await agent.markSessionStarting(sessionId);
    agent.unmarkSessionStarting(sessionId, orphanedToken);
    const replacementToken = await agent.markSessionStarting(sessionId);
    try {
      expect(agent.isAgentSessionCancelled(sessionId, replacementToken)).toBe(
        false,
      );
      expect(agent.currentAgentRunToken(sessionId)).toBe(replacementToken);
      expect(__sessionKernelStoreForTest().runState(sessionId)).toMatchObject({
        state: "starting",
        currentRunId: replacementToken,
      });
    } finally {
      agent.unmarkSessionStarting(sessionId, replacementToken);
      await clearRunState(sessionId);
    }
  });

  it("keeps an orphan-looking actor owner when its journal is still live", async () => {
    const sessionId = `actor-preparation-journal-${crypto.randomUUID()}`;
    const ownerToken = await agent.markSessionStarting(sessionId);
    agent.unmarkSessionStarting(sessionId, ownerToken);
    await mod.journalSet({
      runKey: ownerToken,
      osSessionId: sessionId,
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
    });
    const rejectedToken = await agent.markSessionStarting(sessionId);
    try {
      expect(agent.isAgentSessionCancelled(sessionId, rejectedToken)).toBe(
        true,
      );
      expect(agent.currentAgentRunToken(sessionId)).toBeUndefined();
      expect(__sessionKernelStoreForTest().runState(sessionId)).toMatchObject({
        state: "running",
        currentRunId: ownerToken,
      });
    } finally {
      agent.unmarkSessionStarting(sessionId, rejectedToken);
      mod.journalClear(ownerToken);
      await clearRunState(sessionId);
    }
  });

  it("never launches a rejected concurrent preparation before the actor winner", async () => {
    const sessionId = `preparation-engine-winner-${crypto.randomUUID()}`;
    const fake = makeFakeEngine([{ kind: "clean" }]);
    agent.__setEngineForTest(fake.engine);
    const firstToken = await agent.markSessionStarting(sessionId);
    const rejectedToken = await agent.markSessionStarting(sessionId);
    const run = (startToken: string) =>
      agent.runAgent({
        prompt: "continue",
        cwd: "/tmp",
        mcpServers: [],
        model: "claude-fable-5-1",
        fallbackModel: "none",
        journal: { osSessionId: sessionId, kind: "prompt" },
        startToken,
      });
    try {
      for await (const _event of run(rejectedToken)) {
      }
      expect(fake.calls).toHaveLength(0);
      agent.unmarkSessionStarting(sessionId, rejectedToken);
      for await (const _event of run(firstToken)) {
      }
      expect(fake.calls).toHaveLength(1);
      expect(getRunState(sessionId)).toBe("idle");
    } finally {
      agent.unmarkSessionStarting(sessionId, rejectedToken);
      agent.unmarkSessionStarting(sessionId, firstToken);
      await clearRunState(sessionId);
    }
  });

  it("latches Stop while a prompt is still preparing", async () => {
    const sessionId = `preparing-${crypto.randomUUID()}`;
    const fake = makeFakeEngine([{ kind: "clean" }]);
    agent.__setEngineForTest(fake.engine);
    const run = (startToken: string) =>
      agent.runAgent({
        prompt: "continue",
        cwd: "/tmp",
        mcpServers: [],
        model: "claude-fable-5-1",
        fallbackModel: "none",
        journal: { osSessionId: sessionId, kind: "prompt" },
        startToken,
      });

    try {
      const stoppedToken = await agent.markSessionStarting(sessionId);
      expect(await agent.cancelAgentRun(sessionId)).toBe(true);
      const replacementToken = await agent.markSessionStarting(sessionId);
      for await (const _event of run(stoppedToken)) {
      }
      expect(fake.calls).toHaveLength(0);
      agent.unmarkSessionStarting(sessionId, stoppedToken);
      expect(agent.isAgentSessionBusy(sessionId)).toBe(true);

      for await (const _event of run(replacementToken)) {
      }
      expect(fake.calls).toHaveLength(1);
      agent.unmarkSessionStarting(sessionId, replacementToken);
    } finally {
      agent.unmarkSessionStarting(sessionId);
      await clearRunState(sessionId);
    }
  });

  it("latches Stop across concurrent prompt preparations", async () => {
    const sessionId = `concurrent-preparing-${crypto.randomUUID()}`;
    const fake = makeFakeEngine([{ kind: "clean" }]);
    agent.__setEngineForTest(fake.engine);
    const run = (startToken: string) =>
      agent.runAgent({
        prompt: "continue",
        cwd: "/tmp",
        mcpServers: [],
        model: "claude-fable-5-1",
        fallbackModel: "none",
        journal: { osSessionId: sessionId, kind: "prompt" },
        startToken,
      });

    const firstToken = await agent.markSessionStarting(sessionId);
    const secondToken = await agent.markSessionStarting(sessionId);
    try {
      expect(await agent.cancelAgentRun(sessionId)).toBe(true);
      for await (const _event of run(firstToken)) {
      }
      for await (const _event of run(secondToken)) {
      }
      expect(fake.calls).toHaveLength(0);
    } finally {
      agent.unmarkSessionStarting(sessionId, firstToken);
      agent.unmarkSessionStarting(sessionId, secondToken);
      await clearRunState(sessionId);
    }
  });

  it("an old dispatch token cannot cancel a successor using the same session alias", async () => {
    const sessionId = `dispatch-fence-${crypto.randomUUID()}`;
    const fake = makeFakeEngine([{ kind: "clean" }, { kind: "clean" }]);
    agent.__setEngineForTest(fake.engine);
    const run = (startToken: string) =>
      agent.runAgent({
        prompt: "continue",
        cwd: "/tmp",
        mcpServers: [],
        model: "claude-fable-5-1",
        fallbackModel: "none",
        journal: { osSessionId: sessionId, kind: "prompt" },
        startToken,
      });
    const firstToken = await agent.markSessionStarting(sessionId);
    for await (const _event of run(firstToken)) {
    }
    agent.unmarkSessionStarting(sessionId, firstToken);
    const successorToken = await agent.markSessionStarting(sessionId);
    try {
      expect(await agent.cancelAgentRunToken(firstToken)).toBe(false);
      expect(agent.isAgentSessionCancelled(sessionId, successorToken)).toBe(
        false,
      );
      for await (const _event of run(successorToken)) {
      }
      expect(fake.calls).toHaveLength(2);
    } finally {
      agent.unmarkSessionStarting(sessionId, successorToken);
      await clearRunState(sessionId);
    }
  });

  it("confirms an exact cancel without crossing or retiring source ownership", async () => {
    const sessionId = `dispatch-wait-${crypto.randomUUID()}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = makeFakeEngine([{ kind: "clean", gate }]);
    agent.__setEngineForTest(fake.engine);
    const token = await agent.markSessionStarting(sessionId);
    const running = (async () => {
      try {
        for await (const _event of agent.runAgent({
          prompt: "continue",
          cwd: "/tmp",
          mcpServers: [],
          model: "claude-fable-5-1",
          fallbackModel: "none",
          journal: { osSessionId: sessionId, kind: "prompt" },
          startToken: token,
        })) {
        }
      } finally {
        agent.unmarkSessionStarting(sessionId, token);
      }
    })();
    try {
      while (fake.calls.length === 0) await Bun.sleep(1);
      expect(await agent.cancelAgentRunTokenAndWait(token, 1_000)).toBe(true);
      expect(agent.isAgentSessionBusy(sessionId)).toBe(true);
      release();
      await running;
      expect(agent.isAgentSessionBusy(sessionId)).toBe(false);
    } finally {
      release();
      await running;
      agent.unmarkSessionStarting(sessionId, token);
      await clearRunState(sessionId);
    }
  });

  it("does not confirm an unreachable detached dispatch from journal evidence alone", async () => {
    const sessionId = `detached-cancel-${crypto.randomUUID()}`;
    const runKey = `rh-${crypto.randomUUID()}`;
    try {
      await mod.journalSet({
        runKey,
        hostId: runKey,
        osSessionId: sessionId,
        cwd: "/tmp",
        startedAt: new Date().toISOString(),
      });
      await expect(
        agent.cancelAgentRunTokenAndWait(runKey, 10),
      ).rejects.toThrow("Timed out reconciling cancelled dispatch");
      expect(mod.activeRunRecords().some((run) => run.runKey === runKey)).toBe(
        true,
      );
    } finally {
      mod.journalClear(runKey);
      await clearRunState(sessionId);
    }
  });

  it("bridges pending preparations left by the pre-token hot-reload global", async () => {
    const sessionId = `legacy-preparing-${crypto.randomUUID()}`;
    const g = globalThis as any;
    const previousPending = g.__pendingSessionStarts;
    const previousCancelled = g.__cancelledSessionRuns;
    try {
      g.__pendingSessionStarts = new Set([sessionId]);
      g.__cancelledSessionRuns = new Set();
      expect(agent.isAgentSessionBusy(sessionId)).toBe(true);
      expect(await agent.cancelAgentRun(sessionId)).toBe(true);
      expect(g.__cancelledSessionRuns.has(sessionId)).toBe(true);
    } finally {
      g.__pendingSessionStarts = previousPending;
      g.__cancelledSessionRuns = previousCancelled;
      await clearRunState(sessionId);
    }
  });

  it("does not clear a replacement journal that reuses a cancelled recovery run key", async () => {
    const sessionId = `replacement-${crypto.randomUUID()}`;
    const runKey = `engine-${crypto.randomUUID()}`;
    const oldStartedAt = new Date(Date.now() - 1000).toISOString();
    try {
      await mod.journalSet({
        runKey,
        osSessionId: sessionId,
        cwd: "/old",
        startedAt: oldStartedAt,
      });
      const old = mod.activeRunRecords().find((run) => run.runKey === runKey)!;
      mod.journalClear(runKey);
      await mod.journalSet({
        runKey,
        osSessionId: sessionId,
        cwd: "/replacement",
        startedAt: new Date().toISOString(),
      });

      expect(mod.journalClearIfLineage(old)).toBe(false);
      expect(mod.activeRunRecords()).toContainEqual(
        expect.objectContaining({
          runKey,
          osSessionId: sessionId,
          cwd: "/replacement",
        }),
      );
    } finally {
      mod.journalClear(runKey);
      await clearRunState(sessionId);
    }
  });

  it("resets the consecutive recovery fuse after resumed work progresses", async () => {
    const sessionId = `attached-${crypto.randomUUID()}`;
    const runKey = `engine-${crypto.randomUUID()}`;
    const startedAt = new Date().toISOString();
    try {
      await mod.journalSet({
        runKey,
        osSessionId: sessionId,
        cwd: "/tmp",
        startedAt,
      });
      const started = mod.journalStartRecovery(mod.activeRunRecords()[0]);
      expect(started.resumeAttempts).toBe(1);
      expect(started.lastResumeAt).toBeTruthy();

      expect(agent.markRecoveryProgress(started, { type: "init" })).toBe(false);
      expect(started.resumeAttempts).toBe(1);
      expect(agent.markRecoveryProgress(started, { type: "tool_use" })).toBe(
        true,
      );
      expect(started.resumeAttempts).toBe(0);
      expect(started.lastResumeAt).toBeUndefined();
      expect(mod.activeRunRecords()[0].resumeAttempts).toBe(0);

      // A later model fallback re-journals opts captured before the reset.
      // The live journal's healthy state must win over those stale fields.
      await mod.journalSet({
        ...started,
        resumeAttempts: 1,
        lastResumeAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      });
      expect(mod.activeRunRecords()[0].resumeAttempts).toBe(0);
      expect(mod.activeRunRecords()[0].lastResumeAt).toBeUndefined();

      const nextBoot = mod.journalStartRecovery(started);
      expect(nextBoot.resumeAttempts).toBe(1);
    } finally {
      mod.journalClear(runKey);
      await clearRunState(sessionId);
    }
  });

  it("does not reset the recovery fuse on a replacement lineage", async () => {
    const sessionId = `attached-replacement-${crypto.randomUUID()}`;
    const runKey = `engine-${crypto.randomUUID()}`;
    try {
      await mod.journalSet({
        runKey,
        osSessionId: sessionId,
        cwd: "/old",
        startedAt: new Date(Date.now() - 1000).toISOString(),
      });
      const old = mod.journalStartRecovery(mod.activeRunRecords()[0]);
      mod.journalClear(runKey);
      await mod.journalSet({
        runKey,
        osSessionId: sessionId,
        cwd: "/replacement",
        startedAt: new Date().toISOString(),
        resumeAttempts: 2,
      });

      expect(mod.journalMarkRecoveryAttached(old)).toBeUndefined();
      expect(mod.activeRunRecords()[0]).toMatchObject({
        cwd: "/replacement",
        resumeAttempts: 2,
      });
    } finally {
      mod.journalClear(runKey);
      await clearRunState(sessionId);
    }
  });

  it("copies account and reviewer policy into every journal shape", async () => {
    const record = mod.buildRunJournalRecord(
      {
        accountId: "account-1",
        accountStrict: true,
        usageCredits: false,
        prReviewer: "tellahq/platform",
      },
      {
        runKey: "policy",
        cwd: "/tmp",
        claudeSessionId: "engine-policy",
      },
    );
    expect(record).toMatchObject({
      accountId: "account-1",
      accountStrict: true,
      usageCredits: false,
      prReviewer: "tellahq/platform",
    });
  });

  it("settles headless journal-owned runs on their terminal event", async () => {
    const sessionId = `headless-${crypto.randomUUID()}`;
    const fake = makeFakeEngine([{ kind: "clean" }]);
    agent.__setEngineForTest(fake.engine);
    for await (const _event of agent.runAgent({
      prompt: "wake",
      cwd: "/tmp",
      mcpServers: [],
      model: "claude-fable-5-1",
      fallbackModel: "none",
      journal: { osSessionId: sessionId, kind: "goal" },
    })) {
    }
    expect(getRunState(sessionId)).toBe("idle");
    expect(agent.isAgentSessionBusy(sessionId)).toBe(false);
  });

  it("keeps a kind-only run busy for its full outer fallback lifetime", async () => {
    const sessionId = `linear-${crypto.randomUUID()}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = makeFakeEngine([{ kind: "clean", gate }]);
    agent.__setEngineForTest(fake.engine);
    const running = (async () => {
      for await (const _event of agent.runAgent({
        prompt: "triage",
        cwd: "/tmp",
        mcpServers: [],
        model: "claude-fable-5-1",
        fallbackModel: "none",
        journal: { kind: "linear" },
        transcriptSessionId: sessionId,
      })) {
      }
    })();
    try {
      while (fake.calls.length < 1) await Bun.sleep(5);
      expect(agent.isAgentSessionBusy(sessionId)).toBe(true);
      expect(await agent.cancelAgentRun(sessionId)).toBe(true);
    } finally {
      release();
      await running;
    }
    expect(agent.isAgentSessionBusy(sessionId)).toBe(false);
  });

  it("does not let a busy loser settle the winning turn", async () => {
    const sessionId = `busy-loser-${crypto.randomUUID()}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = makeFakeEngine([
      { kind: "clean", gate },
      {
        kind: "events",
        events: [{ type: "error", content: "Session is busy" }],
      },
    ]);
    agent.__setEngineForTest(fake.engine);
    const run = (startToken: string) =>
      agent.runAgent({
        prompt: "run",
        cwd: "/tmp",
        mcpServers: [],
        model: "claude-fable-5-1",
        fallbackModel: "none",
        journal: { osSessionId: sessionId, kind: "prompt" },
        startToken,
      });

    const winnerToken = await agent.markSessionStarting(sessionId);
    const winner = (async () => {
      for await (const _event of run(winnerToken)) {
      }
      agent.unmarkSessionStarting(sessionId, winnerToken);
    })();
    try {
      while (fake.calls.length < 1) await Bun.sleep(5);
      const loserToken = await agent.markSessionStarting(sessionId);
      for await (const _event of run(loserToken)) {
      }
      agent.unmarkSessionStarting(sessionId, loserToken);
      expect(getRunState(sessionId)).toBe("running");

      release();
      await winner;
      expect(getRunState(sessionId)).toBe("idle");
    } finally {
      release();
      await winner;
      agent.unmarkSessionStarting(sessionId);
      await clearRunState(sessionId);
    }
  });

  it("does not notify for a rejected record when the same session will recover", async () => {
    const sessionId = `mixed-recovery-${crypto.randomUUID()}`;
    const startedAt = new Date().toISOString();
    const valid: mod.ActiveRunRecord = {
      runKey: "valid",
      osSessionId: sessionId,
      cwd: "/tmp",
      startedAt,
    };
    const unsafe: mod.ActiveRunRecord = {
      ...valid,
      runKey: "unsafe",
      kind: "prompt-resume-rerun",
    };

    const result = agent.sanitizeInterruptedRuns([unsafe, valid]);

    expect(result.interrupted).toEqual([valid]);
    expect(result.quarantined).toContainEqual({
      run: unsafe,
      reason: "recursive_recovery_kind",
      notify: false,
    });
  });

  it("deduplicates and recovers every valid run while rejecting recursive records", async () => {
    const now = Date.now();
    const records: mod.ActiveRunRecord[] = Array.from(
      { length: 40 },
      (_, i) => ({
        runKey: `run-${i}`,
        osSessionId: `session-${i}`,
        prompt: `prompt ${i}`,
        cwd: "/tmp",
        mcpServers: [],
        kind: "prompt",
        firstJournaledAt: new Date(now - 60_000).toISOString(),
        startedAt: new Date(now - 40_000 + i).toISOString(),
      }),
    );
    records.push({
      ...records[0],
      runKey: "run-0-new",
      startedAt: new Date(now).toISOString(),
    });
    records.push({
      ...records[1],
      runKey: "recursive",
      kind: "prompt-resume-resume",
    });

    const result = agent.sanitizeInterruptedRuns(records, now);
    expect(result.interrupted).toHaveLength(40);
    expect(result.interrupted.some((r) => r.runKey === "run-0")).toBe(false);
    expect(result.interrupted.some((r) => r.runKey === "run-0-new")).toBe(true);
    expect(result.interrupted.some((r) => r.runKey === "recursive")).toBe(
      false,
    );
    expect(
      result.quarantined.some(
        (r) => r.run.runKey === "run-0" && r.reason === "duplicate_session",
      ),
    ).toBe(true);
    expect(
      result.quarantined.some(
        (r) =>
          r.run.runKey === "recursive" &&
          r.reason === "recursive_recovery_kind",
      ),
    ).toBe(true);
  });

  it("recovers the oldest unique runs first so repeated restarts cannot starve them", async () => {
    const now = Date.now();
    const result = agent.sanitizeInterruptedRuns(
      [
        {
          runKey: "newest",
          osSessionId: "newest-session",
          cwd: "/tmp",
          startedAt: new Date(now).toISOString(),
        },
        {
          runKey: "oldest",
          osSessionId: "oldest-session",
          cwd: "/tmp",
          startedAt: new Date(now - 60_000).toISOString(),
        },
      ],
      now,
    );

    expect(result.interrupted.map((run) => run.runKey)).toEqual([
      "oldest",
      "newest",
    ]);
  });

  it("accepts interleaved fallback recovery markers with a bounded durable counter", async () => {
    const now = Date.now();
    const run: mod.ActiveRunRecord = {
      runKey: "interleaved",
      osSessionId: "interleaved-session",
      cwd: "/tmp",
      kind: "create-resume-fallback-resume",
      resumeAttempts: 0,
      firstJournaledAt: new Date(now - 60_000).toISOString(),
      startedAt: new Date(now).toISOString(),
    };
    const result = agent.sanitizeInterruptedRuns([run], now);
    expect(result.interrupted).toEqual([run]);
    expect(result.quarantined).toEqual([]);
  });

  it("rejects expired lineage and exhausted durable resume attempts", async () => {
    const now = Date.now();
    const base: mod.ActiveRunRecord = {
      runKey: "base",
      osSessionId: "session-base",
      cwd: "/tmp",
      startedAt: new Date(now).toISOString(),
      firstJournaledAt: new Date(now).toISOString(),
    };
    const result = agent.sanitizeInterruptedRuns(
      [
        {
          ...base,
          runKey: "attempted",
          osSessionId: "attempted",
          resumeAttempts: agent.MAX_BOOT_RESUME_ATTEMPTS,
        },
        {
          ...base,
          runKey: "expired",
          osSessionId: "expired",
          firstJournaledAt: new Date(
            now - agent.MAX_RECOVERY_AGE_MS - 1,
          ).toISOString(),
        },
      ],
      now,
    );
    expect(result.interrupted).toEqual([]);
    expect(result.quarantined.map((entry) => entry.reason).sort()).toEqual([
      "recovery_expired",
      "resume_attempts_exhausted",
    ]);
  });

  it("keeps recovery kinds and prompts bounded across repeated restarts", async () => {
    expect(agent.recoveryKind("prompt", "resume")).toBe("prompt-resume");
    expect(agent.recoveryKind("prompt-resume", "resume")).toBe("prompt-resume");
    expect(agent.recoveryKind("prompt-resume-rerun", "rerun")).toBe(
      "prompt-rerun",
    );
    expect(agent.recoveryKind("create-resume-fallback", "resume")).toBe(
      "create-resume-fallback",
    );
    expect(agent.recoveryKind("prompt-resume-fallback-resume", "rerun")).toBe(
      "prompt-rerun-fallback",
    );
    const once = agent.resumeContinuationPrompt("original task");
    expect(agent.resumeContinuationPrompt(once)).toBe(once);
    const hidden = agent.restartContinuationPrompt("original task");
    expect(hidden).toContain("original task");
    expect(stripContext(hidden)).toBe("");
    expect(agent.restartContinuationPrompt(hidden)).toBe(hidden);
  });

  it("runs boot recovery with bounded concurrency", async () => {
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 20 }, () => async () => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active--;
    });
    await agent.runRecoveryQueue(tasks);
    expect(peak).toBe(agent.BOOT_RECOVERY_CONCURRENCY);
    expect(active).toBe(0);
  });

  it("yields the gateway between boot recovery admissions", async () => {
    const order: string[] = [];
    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
      order.push("timer");
    }, 0);
    await agent.runRecoveryQueue([
      async () => {
        order.push("first");
      },
      async () => {
        expect(timerFired).toBe(true);
        order.push("second");
      },
    ]);
    expect(order).toEqual(["first", "timer", "second"]);
  });

  it("continues draining recoveries after one worker task throws", async () => {
    let completed = false;
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      await agent.runRecoveryQueue([
        async () => {
          throw new Error("unexpected recovery failure");
        },
        async () => {
          completed = true;
        },
      ]);
      expect(completed).toBe(true);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("preserves human-confirmed tool policy across restart drains", async () => {
    await mod.journalSet({
      runKey: "run-1",
      osSessionId: "bks-1",
      claudeSessionId: "engine-1",
      prompt: "continue",
      cwd: "/tmp",
      mcpServers: [],
      deniedTools: { mcp__danger__delete: "No deletes" },
      publicationPolicy: {
        repo: "tellahq/renderer",
        branch: "main",
        headBranch: "compat/layout",
      },
      confirmTools: { mcp__stripe__create_refund: "Create a refund" },
      model: "pi/openai/gpt-5.6-terra",
      selectedModel: "dial/medium",
      transientFallback: true,
      fallbackModel: "gpt-5.5",
      startedAt: "2026-07-02T00:00:00.000Z",
    });

    const [run] = await mod.takeInterruptedRuns();
    expect(run.confirmTools).toEqual({
      mcp__stripe__create_refund: "Create a refund",
    });
    expect(run.deniedTools).toEqual({ mcp__danger__delete: "No deletes" });
    expect(run.publicationPolicy).toEqual({
      repo: "tellahq/renderer",
      branch: "main",
      headBranch: "compat/layout",
    });
    expect(run.fallbackModel).toBe("gpt-5.5");
    expect(run.selectedModel).toBe("dial/medium");
    expect(run.transientFallback).toBe(true);
    // Returned records carry no claim stamp…
    expect(run.claimedAt).toBeUndefined();
    // …but the on-disk record survives as CLAIMED (not wiped) until the
    // resume outcome re-registers or clears it, so a restart that kills the
    // sweep mid-reattach hands the run to the next boot instead of losing it.
    const [claimed] = mod.activeRunRecords();
    expect(claimed.runKey).toBe("run-1");
    expect(claimed.claimedAt).toBeTruthy();
    // The same process never takes an already-claimed run twice.
    expect(await mod.takeInterruptedRuns()).toEqual([]);
  });

  it("leaves filtered recovery journals unclaimed for a later boot", async () => {
    await mod.journalSet({
      runKey: "quarantined-run",
      osSessionId: "quarantined-session",
      prompt: "preserve me",
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
    });

    expect(await mod.takeInterruptedRuns([], () => false)).toEqual([]);
    const [preserved] = mod.activeRunRecords();
    expect(preserved.runKey).toBe("quarantined-run");
    expect(preserved.claimedAt).toBeUndefined();
  });

  it("defers actor-owned opening journals to the durable effect executor", async () => {
    await mod.journalSet({
      runKey: "opening-run",
      osSessionId: "opening-session",
      promptEntryId: "opening-prompt",
      prompt: "start",
      cwd: "/tmp",
      mcpServers: [],
      startedAt: new Date().toISOString(),
    });
    expect(
      await agent.resumeInterruptedRuns(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        (run) => run.promptEntryId === "opening-prompt",
      ),
    ).toEqual([]);
    expect(mod.activeRunRecords()).toMatchObject([
      { runKey: "opening-run", promptEntryId: "opening-prompt" },
    ]);
  });

  it("adopts a durable abnormal-completion receipt without relaunching", async () => {
    const runKey = "abnormal-opening";
    const record: mod.ActiveRunRecord = {
      runKey,
      osSessionId: "abnormal-session",
      promptEntryId: "abnormal-prompt",
      prompt: "start",
      cwd: "/tmp",
      mcpServers: [],
      startedAt: new Date().toISOString(),
    };
    await mod.journalSet(record);
    await mod.journalRecordAbnormalCompletion(
      record,
      "Opening backend ended without a terminal event",
    );
    let terminal: StreamEvent | undefined;
    expect(
      await agent.resumeInterruptedRuns((_sessionId, event) => {
        terminal = event;
      }),
    ).toEqual(["abnormal-session"]);
    expect(terminal).toMatchObject({
      type: "error",
      content: "Opening backend ended without a terminal event",
    });
    expect(mod.activeRunRecords()).toEqual([]);
  });

  it("moves rejected recovery records into an inspectable quarantine", async () => {
    for (let i = 0; i < 5; i++) {
      await mod.journalSet({
        runKey: `batch-${i}`,
        cwd: "/tmp",
        mcpServers: [],
        startedAt: new Date().toISOString(),
      });
    }
    mod.journalQuarantine([
      {
        run: mod.activeRunRecords().find((run) => run.runKey === "batch-1")!,
        reason: "recovery_expired",
        notify: true,
      },
      {
        run: mod.activeRunRecords().find((run) => run.runKey === "batch-3")!,
        reason: "duplicate_session",
        notify: false,
      },
    ]);
    expect(
      mod
        .activeRunRecords()
        .map((run) => run.runKey)
        .sort(),
    ).toEqual(["batch-0", "batch-2", "batch-4"]);
    const quarantine = await Bun.file(
      join(dir, "active-runs.quarantine.json"),
    ).json();
    expect(
      Object.values(quarantine)
        .map((run: any) => run.quarantineReason)
        .sort(),
    ).toEqual(["duplicate_session", "recovery_expired"]);
  });

  it("quarantines ambiguous Runner admission out of boot recovery", async () => {
    const run: mod.ActiveRunRecord = {
      runKey: "ambiguous-runner-opening",
      osSessionId: "ambiguous-runner-session",
      runnerId: "runner-one",
      hostId: "runner-host-one",
      promptEntryId: "opening-prompt",
      prompt: "start",
      cwd: "/runner/workspace",
      mcpServers: [],
      launchPhase: "launching",
      startedAt: new Date().toISOString(),
    };
    await mod.journalSet(run);
    mod.journalQuarantine([
      { run, reason: "ambiguous_runner_launch", notify: false },
    ]);
    expect(mod.activeRunRecords()).toEqual([]);
    const quarantine = JSON.parse(
      readFileSync(join(dir, "active-runs.quarantine.json"), "utf8"),
    );
    expect(Object.values(quarantine)).toMatchObject([
      {
        runKey: "ambiguous-runner-opening",
        quarantineReason: "ambiguous_runner_launch",
      },
    ]);
  });

  it("preserves first-journaled time while incrementing recovery attempts", async () => {
    const first = new Date(Date.now() - 10_000).toISOString();
    await mod.journalSet({ runKey: "lineage", cwd: "/tmp", startedAt: first });
    const prepared = mod.journalStartRecovery(mod.activeRunRecords()[0]);
    expect(prepared.firstJournaledAt).toBe(first);
    expect(prepared.resumeAttempts).toBe(1);
    expect(prepared.lastResumeAt).toBeTruthy();
    await mod.journalSet({ ...prepared, startedAt: new Date().toISOString() });
    expect(mod.activeRunRecords()[0].firstJournaledAt).toBe(first);
    expect(mod.activeRunRecords()[0].resumeAttempts).toBe(1);
  });

  it("emits recovered run stream events during restart resume", async () => {
    agent.__setEngineForTest(
      makeFakeEngine([{ kind: "usage_exhausted" }]).engine,
    );
    process.env.OPENSESSION_FORCE_LIMIT = "1";
    await mod.journalSet({
      runKey: "run-2",
      kind: "prompt",
      osSessionId: "bks-2",
      claudeSessionId: "engine-2",
      prompt: "continue",
      cwd: "/tmp",
      model: "claude-fable-5-1",
      startedAt: new Date().toISOString(),
    });

    let resolveTerminal!: (value: { id?: string; event?: StreamEvent }) => void;
    const terminal = new Promise<{ id?: string; event?: StreamEvent }>(
      (resolve) => {
        resolveTerminal = resolve;
      },
    );
    const observed = new Promise<{ id: string; event: unknown }>(
      async (resolve) => {
        const resumed = await agent.resumeInterruptedRuns(
          (id, event) => resolveTerminal({ id, event }),
          undefined,
          undefined,
          undefined,
          (id: string, event: unknown) => {
            const type = (event as { type?: string })?.type;
            if (type === "done" || type === "error") resolve({ id, event });
          },
        );
        expect(resumed).toEqual(["bks-2"]);
      },
    );

    const result = await Promise.race([
      observed,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("resume event callback timed out")),
          1000,
        ),
      ),
    ]);

    expect(result).toMatchObject({
      id: "bks-2",
      event: {
        type: "done",
        provider: "pi",
        model: "pi/anthropic/claude-fable-5-1",
        usageLimitExhausted: true,
      },
    });
    await expect(terminal).resolves.toMatchObject({
      id: "bks-2",
      event: {
        type: "done",
        usageLimitExhausted: true,
      },
    });
  });

  it("recognizes malformed recovered tool-output envelopes without matching real answers", async () => {
    expect(
      agent.recoveredResultNeedsContinuation({
        type: "done",
        sessionId: "engine-1",
        result: "[your bash cd /tmp && ffmpeg ...]:\n=== raw ssim output ===",
        provider: "pi",
        model: "pi/anthropic/claude-opus-5",
      }),
    ).toBe(true);
    // MCP tool ids must match too — 2026-07-29: a turn recited fabricated
    // `[your tella_create_source]:` results the builtin-name regex missed.
    expect(
      agent.recoveredResultNeedsContinuation({
        type: "done",
        sessionId: "engine-1",
        result:
          '[your tella_create_source]:\n{"source":{"id":"src_fabricated"}}',
        provider: "pi",
        model: "pi/anthropic/claude-opus-5",
      }),
    ).toBe(true);
    expect(
      agent.recoveredResultNeedsContinuation({
        type: "done",
        sessionId: "engine-1",
        result: "The proxy GOP is 60 frames, or two seconds at 30fps.",
        provider: "pi",
        model: "pi/anthropic/claude-opus-5",
      }),
    ).toBe(false);
    // Prose that merely mentions the envelope shape mid-answer stays a
    // real answer — the match is anchored to the start of the text.
    expect(
      agent.recoveredResultNeedsContinuation({
        type: "done",
        sessionId: "engine-1",
        result:
          "The leak shape starts with `[your bash …]:` in assistant text.",
        provider: "pi",
        model: "pi/anthropic/claude-opus-5",
      }),
    ).toBe(false);
    expect(
      agent.recoveredResultNeedsContinuation({
        type: "done",
        sessionId: "engine-1",
        result: "Done! (no text output)",
        provider: "pi",
        model: "pi/anthropic/claude-opus-5",
      }),
    ).toBe(true);
  });

  it("flags fabricated tool transcripts in assistant text (both observed costumes)", async () => {
    // Costume 1 (2026-07-29 morning): Meridian's result-delivery envelope
    // authored by the model, MCP tool name included.
    expect(
      shared.looksLikeFabricatedToolTranscript(
        '[your tella_create_source]:\n{"source":{"id":"src_fabricated"}}',
      ),
    ).toBe(true);
    // Costume 2 (same day, +1h): UI duration chip + raw tool-input JSON,
    // and todowrite's canonical result string, narrated as text.
    expect(
      shared.looksLikeFabricatedToolTranscript(
        'I\'ll start.\n\n\n– 5s\n{"todos":[{"content":"Find the view","status":"in_progress"}]}',
      ),
    ).toBe(true);
    expect(
      shared.looksLikeFabricatedToolTranscript(
        "Todos have been modified successfully. Ensure that you continue to use the todo list.",
      ),
    ).toBe(true);
    // Costume 3 (2026-07-29 late morning, bks-019fad97): a raw function-call
    // block written as text, invented output inline, turn ended right after.
    expect(
      shared.looksLikeFabricatedToolTranscript(
        'I\'ll trace how the report-back gets injected.\n\n\n<invoke name="Bash">\n<parameter name="command">grep -rn "reportBack" src/agents/slack/sessions-tools.ts | head -40</parameter>\n</invoke>\n\n\n347:      const spawn_task = tool({\n',
      ),
    ).toBe(true);
    // A bare mention of the tag in code discussion (no parameter tag) stays
    // clean.
    expect(
      shared.looksLikeFabricatedToolTranscript(
        'The harness wraps each call in an <invoke name="..."> element.',
      ),
    ).toBe(false);
    // Legit prose stays clean: markdown bullets use ASCII hyphens, and an
    // en-dash duration inside a sentence has no JSON line after it.
    expect(
      shared.looksLikeFabricatedToolTranscript(
        "Here is the plan:\n- 5s timeout for polls\n- retry twice",
      ),
    ).toBe(false);
    expect(
      shared.looksLikeFabricatedToolTranscript(
        "Timings:\n– 5s for boot\nthen the cache warms.",
      ),
    ).toBe(false);
  });
});

describe("restart recovery queue", () => {
  it("frees its boot slot once a recovered engine has started", async () => {
    const gates: Array<() => void> = [];
    const gated = () =>
      new Promise<void>((resolve) => {
        gates.push(resolve);
      });
    // Four gated turns hold every queue slot (BOOT_RECOVERY_CONCURRENCY).
    // The fifth run must not wait for any of the first four full agent turns.
    const fake = makeFakeEngine([
      { kind: "clean", gate: gated() },
      { kind: "clean", gate: gated() },
      { kind: "clean", gate: gated() },
      { kind: "clean", gate: gated() },
      { kind: "clean" },
    ]);
    agent.__setEngineForTest(fake.engine);
    const sessions = Array.from(
      { length: 5 },
      (_, i) => `starved-${i}-${crypto.randomUUID()}`,
    );
    await Promise.all(
      sessions.map(async (sessionId, i) => {
        await mod.journalSet({
          runKey: `run-${sessionId}`,
          osSessionId: sessionId,
          claudeSessionId: `engine-${sessionId}`,
          prompt: "continue",
          cwd: "/tmp",
          model: "claude-fable-5-1",
          startedAt: new Date(Date.now() - i * 1000).toISOString(),
        });
        await clearRunState(sessionId);
      }),
    );
    const terminals: StreamEvent[] = [];
    try {
      await agent.resumeInterruptedRuns((_id, event) => {
        if (event) terminals.push(event);
      });
      // Each fake emits `init` before its gate. That proves the replacement
      // engine is live and should free the queue slot immediately, allowing
      // all five recoveries to start despite four long-running turns.
      while (fake.calls.length < 5) await Bun.sleep(5);
      // Never a failure report for a run whose engine is still working.
      expect(terminals.filter((event) => event.type === "error")).toEqual([]);
    } finally {
      for (const open of gates) open();
      for (const sessionId of sessions) {
        while (agent.isAgentSessionBusy(sessionId)) await Bun.sleep(5);
        await clearRunState(sessionId);
      }
    }
  });
});

describe("restart recovery reattach", () => {
  it("frees its boot slot as soon as a local host attaches, before the next event", async () => {
    const releases = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    let resumeCalls = 0;
    agent.__setLocalHostResumeForTest(async (run) => {
      const index = resumeCalls++;
      return (async function* () {
        await releases[index]!.promise;
        yield {
          type: "done" as const,
          sessionId: run.claudeSessionId,
          provider: "pi",
          model: run.model,
          result: "attached host finished",
        };
      })();
    });
    const snapshots: mod.ActiveRunRecord[] = Array.from(
      { length: 2 },
      (_, i) => ({
        runKey: `rh-${crypto.randomUUID()}`,
        hostId: `host-${crypto.randomUUID()}`,
        osSessionId: `local-host-slot-${i}-${crypto.randomUUID()}`,
        claudeSessionId: `pi-${crypto.randomUUID()}`,
        prompt: "keep running",
        cwd: "/tmp",
        model: "pi/anthropic/claude-sonnet-5",
        kind: "prompt",
        startedAt: new Date(Date.now() - i * 1000).toISOString(),
      }),
    );
    let recovery: Promise<string[]> | undefined;
    try {
      recovery = agent.resumeInterruptedRuns(
        () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        snapshots,
      );
      const deadline = Date.now() + 1_000;
      while (resumeCalls < 2 && Date.now() < deadline) await Bun.sleep(5);
      expect(resumeCalls).toBe(2);
    } finally {
      for (const release of releases) release.resolve();
      await recovery;
      for (const run of snapshots) {
        mod.journalClear(run.runKey);
        await clearRunState(run.osSessionId!);
      }
    }
  });

  it("does not re-prompt when a local host is not proven dead", async () => {
    const sessionId = `local-host-uncertain-${crypto.randomUUID()}`;
    const hostId = `rh-${crypto.randomUUID()}`;
    const fake = makeFakeEngine([{ kind: "clean" }]);
    agent.__setEngineForTest(fake.engine);
    let resumeCalls = 0;
    agent.__setLocalHostResumeForTest(async () => {
      resumeCalls++;
      return "uncertain";
    });
    const snapshotRun: mod.ActiveRunRecord = {
      runKey: hostId,
      hostId,
      osSessionId: sessionId,
      claudeSessionId: `pi-${crypto.randomUUID()}`,
      prompt: "perform this once",
      cwd: "/tmp",
      model: "pi/anthropic/claude-sonnet-5",
      kind: "prompt",
      startedAt: new Date().toISOString(),
    };
    try {
      await agent.resumeInterruptedRuns(
        () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        [snapshotRun],
      );
      while (resumeCalls === 0) await Bun.sleep(5);
      await Bun.sleep(10);
      expect(fake.calls).toHaveLength(0);
      expect(agent.isAgentSessionBusy(sessionId)).toBe(true);
    } finally {
      await clearRunState(sessionId);
    }
  });

  it("restores the immutable steering token while a detached host is attached", async () => {
    const sessionId = `local-host-steer-owner-${crypto.randomUUID()}`;
    const hostId = `rh-${crypto.randomUUID()}`;
    const release = Promise.withResolvers<void>();
    const terminal = Promise.withResolvers<StreamEvent>();
    agent.__setLocalHostResumeForTest(async (run) =>
      (async function* () {
        yield {
          type: "init" as const,
          sessionId: run.claudeSessionId,
          provider: "pi",
          model: run.model,
        };
        await release.promise;
        yield {
          type: "done" as const,
          sessionId: run.claudeSessionId,
          provider: "pi",
          model: run.model,
          result: "attached host finished",
        };
      })(),
    );
    const snapshotRun: mod.ActiveRunRecord = {
      runKey: hostId,
      hostId,
      osSessionId: sessionId,
      claudeSessionId: `pi-${crypto.randomUUID()}`,
      prompt: "keep running",
      cwd: "/tmp",
      model: "pi/anthropic/claude-sonnet-5",
      kind: "prompt",
      startedAt: new Date().toISOString(),
    };
    try {
      await agent.resumeInterruptedRuns(
        (_id, event) => {
          if (event?.type === "done") terminal.resolve(event);
        },
        undefined,
        undefined,
        undefined,
        undefined,
        [snapshotRun],
      );
      expect(agent.currentAgentRunToken(sessionId)).toBe(hostId);
      expect(agent.currentAgentRunToken(snapshotRun.claudeSessionId!)).toBe(
        hostId,
      );
      expect(agent.activeAgentRecoveryRecord(sessionId)).toMatchObject(
        snapshotRun,
      );
      // Recovery can retire the journal before a fallback starts. Its live
      // claim must remain observable so the creation executor does not launch
      // the same opening turn again in this handoff window.
      mod.journalClear(hostId);
      expect(mod.activeRunRecords()).toEqual([]);
      expect(agent.activeAgentRecoveryRecord(hostId)).toMatchObject(
        snapshotRun,
      );
      release.resolve();
      await terminal.promise;
    } finally {
      release.resolve();
      mod.journalClear(hostId);
      await clearRunState(sessionId);
    }
  });

  it("keeps the old lineage when a missing local host falls back in-process", async () => {
    const sessionId = `local-host-fallback-lineage-${crypto.randomUUID()}`;
    const hostId = `rh-${crypto.randomUUID()}`;
    const fake = makeFakeEngine([
      { kind: "error", content: "replacement failed" },
    ]);
    agent.__setEngineForTest(fake.engine);
    agent.__setLocalHostResumeForTest(async () => null);
    const snapshotRun: mod.ActiveRunRecord = {
      runKey: hostId,
      hostId,
      osSessionId: sessionId,
      claudeSessionId: `pi-${crypto.randomUUID()}`,
      prompt: "resume with same lineage",
      cwd: "/tmp",
      model: "pi/anthropic/claude-sonnet-5",
      kind: "prompt",
      startedAt: new Date().toISOString(),
    };
    const terminal = Promise.withResolvers<StreamEvent>();
    try {
      await agent.resumeInterruptedRuns(
        (_id, event) => event && terminal.resolve(event),
        undefined,
        undefined,
        undefined,
        undefined,
        [snapshotRun],
      );
      await expect(terminal.promise).resolves.toMatchObject({
        type: "error",
        content: "replacement failed",
      });
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0].opts.startToken).toBe(hostId);
    } finally {
      mod.journalClear(hostId);
      await clearRunState(sessionId);
    }
  });

  it("does not re-prompt a durably cancelled local host proven absent", async () => {
    const sessionId = `local-host-cancelled-absent-${crypto.randomUUID()}`;
    const hostId = `rh-${crypto.randomUUID()}`;
    const fake = makeFakeEngine([{ kind: "clean" }]);
    agent.__setEngineForTest(fake.engine);
    let resumeCalls = 0;
    agent.__setLocalHostResumeForTest(async () => {
      resumeCalls++;
      return null;
    });
    const snapshotRun: mod.ActiveRunRecord = {
      runKey: hostId,
      hostId,
      osSessionId: sessionId,
      claudeSessionId: `pi-${crypto.randomUUID()}`,
      prompt: "must not run again",
      cwd: "/tmp",
      model: "pi/anthropic/claude-sonnet-5",
      kind: "prompt",
      startedAt: new Date().toISOString(),
    };
    const store = __sessionKernelStoreForTest();
    try {
      store.applyRunEvent({ sessionId, event: "prompt" });
      store.applyRunEvent({
        sessionId,
        event: "run_registered",
        runKey: hostId,
      });
      const generation = store.runState(sessionId).generation;
      store.prepareTurnCancel({
        sessionId,
        cancelId: `stop:${hostId}`,
        expectedRunId: hostId,
        expectedGeneration: generation,
        dispatchId: hostId,
        requeueIds: [],
        source: "test",
      });
      store.settleTurnCancel({
        sessionId,
        cancelId: `stop:${hostId}`,
        outcome: "confirmed",
      });
      await agent.resumeInterruptedRuns(
        () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        [snapshotRun],
      );
      while (resumeCalls === 0) await Bun.sleep(5);
      await Bun.sleep(10);
      expect(fake.calls).toHaveLength(0);
      expect(mod.activeRunRecords().some((run) => run.runKey === hostId)).toBe(
        false,
      );
    } finally {
      mod.journalClear(hostId);
      store.clearSession(sessionId);
    }
  });

  it("consumes terminal host evidence before retiring a stopped delivery-cancel lineage", async () => {
    const sessionId = `local-host-stopped-terminal-${crypto.randomUUID()}`;
    const hostId = `rh-${crypto.randomUUID()}`;
    const fake = makeFakeEngine([{ kind: "clean" }]);
    agent.__setEngineForTest(fake.engine);
    let resumeCalls = 0;
    agent.__setLocalHostResumeForTest(async (run) => {
      resumeCalls++;
      return (async function* () {
        yield {
          type: "done" as const,
          sessionId: run.claudeSessionId,
          provider: "pi",
          model: run.model,
          result: "HOST_COMPLETED_BEFORE_RECOVERY",
        };
      })();
    });
    const snapshotRun: mod.ActiveRunRecord = {
      runKey: hostId,
      hostId,
      osSessionId: sessionId,
      claudeSessionId: `pi-${crypto.randomUUID()}`,
      prompt: "must not run twice",
      cwd: "/tmp",
      model: "pi/anthropic/claude-sonnet-5",
      kind: "prompt",
      startedAt: new Date().toISOString(),
    };
    const terminal = Promise.withResolvers<StreamEvent>();
    const store = __sessionKernelStoreForTest();
    try {
      store.applyRunEvent({ sessionId, event: "prompt" });
      store.applyRunEvent({
        sessionId,
        event: "run_registered",
        runKey: hostId,
      });
      store.applyRunEvent({ sessionId, event: "cancel" });
      await agent.resumeInterruptedRuns(
        (_id, event) => event && terminal.resolve(event),
        undefined,
        undefined,
        undefined,
        undefined,
        [snapshotRun],
      );
      await expect(terminal.promise).resolves.toMatchObject({
        type: "done",
        result: "HOST_COMPLETED_BEFORE_RECOVERY",
      });
      expect(resumeCalls).toBe(1);
      expect(fake.calls).toHaveLength(0);
      expect(mod.activeRunRecords().some((run) => run.runKey === hostId)).toBe(
        false,
      );
    } finally {
      mod.journalClear(hostId);
      store.clearSession(sessionId);
    }
  });

  it("claims a snapshot-only local host before the generic wake can re-prompt", async () => {
    const sessionId = `local-host-snapshot-${crypto.randomUUID()}`;
    const hostId = `rh-${crypto.randomUUID()}`;
    const fake = makeFakeEngine([{ kind: "clean" }]);
    agent.__setEngineForTest(fake.engine);
    let resumeCalls = 0;
    agent.__setLocalHostResumeForTest(async (run) => {
      resumeCalls++;
      return (async function* () {
        yield {
          type: "init" as const,
          sessionId: run.claudeSessionId,
          provider: "pi",
          model: run.model,
        };
        yield {
          type: "done" as const,
          sessionId: run.claudeSessionId,
          provider: "pi",
          model: run.model,
          result: "PI_SURVIVED_RESTART",
        };
      })();
    });
    const snapshotRun: mod.ActiveRunRecord = {
      runKey: hostId,
      hostId,
      osSessionId: sessionId,
      claudeSessionId: `pi-${crypto.randomUUID()}`,
      prompt: "sleep, then finish once",
      promptEntryId: crypto.randomUUID(),
      cwd: "/tmp",
      model: "pi/anthropic/claude-sonnet-5",
      kind: "prompt",
      startedAt: new Date().toISOString(),
    };
    let resolveTerminal!: (event: StreamEvent) => void;
    const terminal = new Promise<StreamEvent>((resolve) => {
      resolveTerminal = resolve;
    });

    try {
      const resumed = await agent.resumeInterruptedRuns(
        (_id, event) => event && resolveTerminal(event),
        undefined,
        undefined,
        undefined,
        undefined,
        [snapshotRun],
      );

      // resumeDrainedSessions receives this set synchronously, before the
      // asynchronous host attach starts, so it cannot launch a generic wake.
      expect(resumed).toEqual([sessionId]);
      await expect(terminal).resolves.toMatchObject({
        type: "done",
        result: "PI_SURVIVED_RESTART",
      });
      expect(resumeCalls).toBe(1);
      expect(fake.calls).toHaveLength(0);
      expect(mod.activeRunRecords()).toEqual([]);
    } finally {
      await clearRunState(sessionId);
    }
  });

  it("does not report a recovery error after another owner settles the run", async () => {
    const sessionId = `local-host-superseded-${crypto.randomUUID()}`;
    const hostId = `rh-${crypto.randomUUID()}`;
    const startedAt = new Date().toISOString();
    const run: mod.ActiveRunRecord = {
      runKey: hostId,
      hostId,
      osSessionId: sessionId,
      claudeSessionId: `pi-${crypto.randomUUID()}`,
      prompt: "finish once",
      cwd: "/tmp",
      model: "pi/anthropic/claude-sonnet-5",
      kind: "prompt",
      firstJournaledAt: startedAt,
      startedAt,
    };
    await mod.journalSet(run);
    await clearRunState(sessionId);
    const streamEnded = Promise.withResolvers<void>();
    agent.__setLocalHostResumeForTest(async () =>
      (async function* () {
        mod.journalClear(hostId);
        await transitionRunState(sessionId, "turn_end", { run_key: hostId });
        streamEnded.resolve();
      })(),
    );
    const terminals: StreamEvent[] = [];

    try {
      expect(
        await agent.resumeInterruptedRuns((_id, event) => {
          if (event) terminals.push(event);
        }),
      ).toEqual([sessionId]);
      await streamEnded.promise;
      await Bun.sleep(10);
      expect(terminals).toEqual([]);
      expect(mod.activeRunRecords()).toEqual([]);
    } finally {
      await clearRunState(sessionId);
    }
  });
});
