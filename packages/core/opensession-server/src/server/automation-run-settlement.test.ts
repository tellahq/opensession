/**
 * Regression cover for the automation lifecycle split-brain:
 * `automation last ok` while the session stays `running` and unrecoverable.
 *
 * Automation turns execute in a detached run host. The host journals
 * `run_registered` (session FSM → `running`) and, when it ends, only clears its
 * journal — settling the VISIBLE run is the consumer's job, exactly as
 * run-session.ts, session-create.ts and the GitHub agent already do. When
 * runAutomation skipped that step, a perfectly successful run left the session
 * `running` with no live execution owner, so the ownership watchdog paused it
 * for safety while the automation ledger recorded `last ok`, and send/cancel
 * were refused as quarantined.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import {
  settleAutomationLaunchFailure,
  settleAutomationRunState,
} from "./automations";
import {
  clearRunState,
  getRunState,
  isRunStateUnsettled,
  transitionRunState,
} from "./run-state";
import {
  applyRunOutcomeProjection,
  findSession,
  runErrors,
  runStateRequiresLiveOwner,
  SESSIONS_DIR,
  updateSessionFile,
} from "./session-cache";
import { sessionKernel } from "./session-kernel";

const silent = () => {};
const sid = () => `automation-settlement-${crypto.randomUUID()}`;
const created: string[] = [];
/** The physical run id whichever backend journals for this turn. */
const runKeyFor = (id: string) => `rh-${id}`;

/** Terminal outcome projections the settlement issued. Production routes these
 *  to recordRunOutcome, which writes runErrors and the session file's
 *  lastRunError — the only sources the session APIs read. */
const projected: Array<{
  sessionId: string;
  errorMessage: string | null;
  runId?: string;
  runGeneration?: number;
  projectionId?: string;
}> = [];
const deps = {
  emit: silent,
  project: async (
    sessionId: string,
    errorMessage: string | null,
    opts?: { runId?: string; runGeneration?: number; projectionId?: string },
  ) => {
    projected.push({
      sessionId,
      errorMessage,
      runId: opts?.runId,
      runGeneration: opts?.runGeneration,
      projectionId: opts?.projectionId,
    });
  },
};

/** Put the session where a journaled detached automation host leaves it. */
async function hostedAutomationRunning(id: string): Promise<void> {
  created.push(id);
  await transitionRunState(
    id,
    "run_registered",
    { run_key: runKeyFor(id), kind: "automation" },
    silent,
  );
  expect(getRunState(id)).toBe("running");
}

afterEach(async () => {
  projected.length = 0;
  for (const id of created.splice(0)) {
    runErrors.delete(id);
    const sessionPath = `${SESSIONS_DIR}/${id}.json`;
    if (existsSync(sessionPath)) unlinkSync(sessionPath);
    await clearRunState(id);
  }
});

describe("automation run settlement", () => {
  test("a completed automation turn leaves no owner-less running session", async () => {
    const id = sid();
    await hostedAutomationRunning(id);

    // The exact reported state: the host has retired, nothing owns the run,
    // and the FSM still claims `running` — the ownership watchdog's
    // quarantine precondition ("no live execution owner or recovery claim").
    expect(runStateRequiresLiveOwner(getRunState(id))).toBe(true);

    await settleAutomationRunState(id, null, true, runKeyFor(id), deps);

    expect(getRunState(id)).toBe("idle");
    expect(isRunStateUnsettled(getRunState(id))).toBe(false);
    expect(runStateRequiresLiveOwner(getRunState(id))).toBe(false);
  });

  test("a declared or streamed failure settles as failed, not running", async () => {
    const id = sid();
    await hostedAutomationRunning(id);

    await settleAutomationRunState(
      id,
      "RUN STATUS: failed",
      true,
      runKeyFor(id),
      deps,
    );

    expect(getRunState(id)).toBe("failed");
    expect(isRunStateUnsettled(getRunState(id))).toBe(false);
  });

  test("a stream that ended without a terminal event keeps the safety fence", async () => {
    const id = sid();
    await hostedAutomationRunning(id);

    // Nothing proved what this run did, so it must stay owned and pausable.
    // Settling here would retire a fence that exists for unverified effects.
    await settleAutomationRunState(id, null, false, runKeyFor(id), deps);

    expect(getRunState(id)).toBe("running");
    expect(isRunStateUnsettled(getRunState(id))).toBe(true);
  });

  test("a late settlement cannot retire a successor's run", async () => {
    const id = sid();
    await hostedAutomationRunning(id);

    // Stop retires this automation's run, then a new prompt claims the
    // session. The automation's hosted generator is still draining and its
    // settlement lands only now — against a run it does not own.
    await transitionRunState(id, "cancel", { run_key: runKeyFor(id) }, silent);
    await transitionRunState(id, "prompt", { run_key: "rh-successor" }, silent);
    await transitionRunState(
      id,
      "run_registered",
      { run_key: "rh-successor" },
      silent,
    );
    expect(getRunState(id)).toBe("running");

    await settleAutomationRunState(id, null, true, runKeyFor(id), deps);

    // The actor's stale-run fence rejected it, so the successor keeps its turn.
    expect(getRunState(id)).toBe("running");

    // The successor's own settlement still works.
    await settleAutomationRunState(id, null, true, "rh-successor", deps);
    expect(getRunState(id)).toBe("idle");
  });

  test("settling an already-settled session emits no double teardown", async () => {
    const id = sid();
    await hostedAutomationRunning(id);
    await settleAutomationRunState(id, null, true, runKeyFor(id), deps);

    const events: Record<string, unknown>[] = [];
    projected.length = 0;
    await settleAutomationRunState(id, null, true, runKeyFor(id), {
      ...deps,
      emit: (event) => events.push(event),
    });

    expect(events).toEqual([]);
    // A no-op settlement must not re-project either.
    expect(projected).toEqual([]);
    expect(getRunState(id)).toBe("idle");
  });

  test("runAutomation settles the session before claiming the ledger outcome", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "automations.ts"),
      "utf8",
    );
    const runAutomation = source.indexOf(
      "export async function runAutomation(",
    );
    const terminalFlag = source.indexOf(
      "sawTerminalEvent = true",
      runAutomation,
    );
    const settleSession = source.indexOf(
      "await settleAutomationRunState(",
      terminalFlag,
    );
    const settleLedger = source.indexOf(
      "settleRun(automation.id, bksId,",
      settleSession,
    );
    expect(terminalFlag).toBeGreaterThan(0);
    expect(settleSession).toBeGreaterThan(terminalFlag);
    expect(settleLedger).toBeGreaterThan(settleSession);
  });

  test("settlement happens inside the loop, before the journal wrapper clears", () => {
    // Requesting the generator's NEXT item is what resumes the journal
    // wrapper, and every wrapper clears this run's recovery journal in its
    // `finally` on normal source completion. Settling only after the loop
    // leaves a window where the session is `running` with no journal record
    // left to recover it. So the settlement must sit inside the loop body,
    // between the terminal-event capture and the loop's closing brace.
    const source = readFileSync(
      resolve(import.meta.dir, "automations.ts"),
      "utf8",
    );
    const loopStart = source.indexOf("for await (const event of events) {");
    const streamDrained = source.indexOf(
      "errorMsg = declaredRunFailure(textTail)",
    );
    const terminalCapture = source.indexOf(
      'if (event.type === "error") {',
      loopStart,
    );
    const inLoopSettle = source.indexOf(
      "await settleAutomationRunState(",
      loopStart,
    );
    expect(loopStart).toBeGreaterThan(0);
    expect(terminalCapture).toBeGreaterThan(loopStart);
    expect(inLoopSettle).toBeGreaterThan(terminalCapture);
    // Still inside the loop: it precedes the post-loop drain line.
    expect(inLoopSettle).toBeLessThan(streamDrained);
  });

  test("a stream with no terminal event records error, not ok", () => {
    // Parity with session-create.ts, which throws "Opening run ended without a
    // terminal event" for exactly this shape, and with every journal wrapper,
    // which records journalRecordAbnormalCompletion instead of clearing so
    // boot recovery reports a failure. runAutomation used to fall through with
    // an empty errorMsg: outputs delivered for a turn that produced nothing,
    // ledger `ok`, session still unsettled — the same split-brain this module
    // exists to remove.
    const source = readFileSync(
      resolve(import.meta.dir, "automations.ts"),
      "utf8",
    );
    const drained = source.indexOf("errorMsg = declaredRunFailure(textTail)");
    const abnormal = source.indexOf(
      "if (!errorMsg && !sawTerminalEvent)",
      drained,
    );
    expect(abnormal).toBeGreaterThan(drained);
    expect(source).toContain('errorMsg = "Run ended without a terminal event"');
    // The ledger verdict and the output delivery both read errorMsg, so the
    // correction has to land before either of them.
    for (const consumer of [
      "await deliverAutomationOutputs({",
      "settleRun(automation.id, bksId,",
      "recordAutomationIntentTerminal(bksId,",
    ]) {
      expect(source.indexOf(consumer, drained)).toBeGreaterThan(abnormal);
    }
  });

  test("an abnormal completion still keeps the session's safety fence", async () => {
    const id = sid();
    await hostedAutomationRunning(id);

    // The ledger now records an error for this shape, but the run state must
    // NOT be settled from here: nothing proved what the turn did, the journal
    // still carries its terminalFailure, and boot recovery owns settling it.
    await settleAutomationRunState(
      id,
      "Run ended without a terminal event",
      false,
      runKeyFor(id),
      deps,
    );

    expect(getRunState(id)).toBe("running");
    expect(isRunStateUnsettled(getRunState(id))).toBe(true);
  });

  test("a usage-exhausted done becomes a failure before the run settles", () => {
    // Dying on usage limits with no account left reports as a `done` carrying
    // `usageLimitExhausted`, not an `error`. An automation with
    // `fallbackModel: "none"` gets that event unfiltered, because
    // runAgentInner yields runOnModel directly instead of routing it into the
    // fallback walk. Both other consumers of the hosted path convert the shape
    // into a failure; without the same conversion the ledger records `ok`,
    // outputs are delivered for a turn that never ran, and the session settles
    // `turn_end` instead of `failed`.
    const source = readFileSync(
      resolve(import.meta.dir, "automations.ts"),
      "utf8",
    );
    const loopStart = source.indexOf("for await (const event of events) {");
    const doneBranch = source.indexOf(
      'if (event.type === "done") {',
      loopStart,
    );
    const conversion = source.indexOf(
      "if (event.usageLimitExhausted)",
      doneBranch,
    );
    const inLoopSettle = source.indexOf(
      "await settleAutomationRunState(",
      loopStart,
    );
    expect(doneBranch).toBeGreaterThan(loopStart);
    expect(conversion).toBeGreaterThan(doneBranch);
    // The conversion has to precede the settlement, or the run state is
    // decided before the failure is known.
    expect(conversion).toBeLessThan(inLoopSettle);
    expect(source).toContain(
      'errorMsg = event.result || "Usage limit reached on every account"',
    );
  });

  test("an exhausted run settles as failed, matching the ledger", async () => {
    const id = sid();
    await hostedAutomationRunning(id);

    // What the loop now passes for a usage-exhausted `done`: the same
    // non-null message the ledger records as `error`.
    await settleAutomationRunState(
      id,
      "Usage limit reached on every account",
      true,
      runKeyFor(id),
      deps,
    );

    expect(getRunState(id)).toBe("failed");
    expect(isRunStateUnsettled(getRunState(id))).toBe(false);
  });

  test("a terminal failure is projected, not only moved in the FSM", async () => {
    const id = sid();
    await hostedAutomationRunning(id);

    await settleAutomationRunState(
      id,
      "Usage limit reached on every account",
      true,
      runKeyFor(id),
      deps,
    );

    // The session APIs read lastRunError from runErrors and the session file,
    // both written by recordRunOutcome. Reaching `failed` without that
    // projection leaves a run that cannot explain itself to any consumer.
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      sessionId: id,
      errorMessage: "Usage limit reached on every account",
      runId: runKeyFor(id),
      // Durable identity: these three route the outcome through the actor's
      // turn-outcome executor instead of a best-effort direct write.
      projectionId: `outcome:${runKeyFor(id)}`,
    });
    expect(typeof projected[0]!.runGeneration).toBe("number");
  });

  test("the projected generation is the one this run owned", async () => {
    const id = sid();
    await hostedAutomationRunning(id);
    const owned = sessionKernel(id).runStateProjection().generation;

    await settleAutomationRunState(id, null, true, runKeyFor(id), deps);

    // Captured before the transition. Reading it afterwards would race a
    // successor claiming the session, and the executor fences on this value.
    expect(projected[0]!.runGeneration).toBe(owned);
  });

  test("a clean turn projects a null outcome, clearing any earlier failure", async () => {
    const id = sid();
    await hostedAutomationRunning(id);

    await settleAutomationRunState(id, null, true, runKeyFor(id), deps);

    expect(getRunState(id)).toBe("idle");
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      sessionId: id,
      errorMessage: null,
      runId: runKeyFor(id),
      projectionId: `outcome:${runKeyFor(id)}`,
    });
  });

  test("a stale settlement projects nothing onto the successor", async () => {
    const id = sid();
    await hostedAutomationRunning(id);
    await transitionRunState(id, "cancel", { run_key: runKeyFor(id) }, silent);
    await transitionRunState(id, "prompt", { run_key: "rh-successor" }, silent);
    await transitionRunState(
      id,
      "run_registered",
      { run_key: "rh-successor" },
      silent,
    );

    await settleAutomationRunState(
      id,
      "late failure",
      true,
      runKeyFor(id),
      deps,
    );

    // The actor rejected the transition, so the outcome must not be stamped
    // onto whoever owns the session now.
    expect(getRunState(id)).toBe("running");
    expect(projected).toEqual([]);
  });

  test("a failed ledger save cannot strand a proven-ownerless launch", async () => {
    const id = sid();
    await hostedAutomationRunning(id);

    const failure = settleAutomationLaunchFailure(
      id,
      runKeyFor(id),
      "spawn failed",
      () => {
        // settleRun calls saveAutomation synchronously. Reproduce that write
        // failing after launch absence has been proved.
        throw new Error("saveAutomation failed");
      },
      {
        hasActiveRun: () => false,
        isLiveEngineBusy: () => false,
        ...deps,
      },
    );

    await expect(failure).rejects.toThrow("saveAutomation failed");
    expect(getRunState(id)).toBe("failed");
    expect(isRunStateUnsettled(getRunState(id))).toBe(false);
    expect(projected).toHaveLength(1);
  });

  test("an ambiguous launch remains fenced", async () => {
    const id = sid();
    await hostedAutomationRunning(id);
    let ledgerSettled = false;

    await settleAutomationLaunchFailure(
      id,
      runKeyFor(id),
      "launch response lost",
      () => {
        ledgerSettled = true;
      },
      {
        hasActiveRun: () => true,
        isLiveEngineBusy: () => false,
        ...deps,
      },
    );

    expect(ledgerSettled).toBe(true);
    expect(getRunState(id)).toBe("running");
    expect(projected).toEqual([]);
  });

  test("the native session is durable before any backend can launch", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "automations.ts"),
      "utf8",
    );
    const persistDefinition = source.indexOf("const persistSession = (");
    const prelaunchPersist = source.indexOf(
      'await persistSession("");',
      persistDefinition,
    );
    const backendDispatch = source.indexOf(
      "let events: AsyncGenerator<StreamEvent>;",
      prelaunchPersist,
    );
    const loopStart = source.indexOf(
      "for await (const event of events) {",
      backendDispatch,
    );

    expect(persistDefinition).toBeGreaterThan(0);
    expect(prelaunchPersist).toBeGreaterThan(persistDefinition);
    expect(backendDispatch).toBeGreaterThan(prelaunchPersist);
    expect(loopStart).toBeGreaterThan(backendDispatch);
  });

  test("intent recovery persists the replacement Executor id", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "automations.ts"),
      "utf8",
    );
    const persistDefinition = source.indexOf("const persistSession = (");
    const existingFields = source.indexOf("...existing,", persistDefinition);
    const authoritativeSandbox = source.indexOf(
      "Intent recovery reuses the session id",
      existingFields,
    );
    const prelaunchPersist = source.indexOf(
      'await persistSession("");',
      authoritativeSandbox,
    );

    expect(existingFields).toBeGreaterThan(persistDefinition);
    expect(authoritativeSandbox).toBeGreaterThan(existingFields);
    expect(prelaunchPersist).toBeGreaterThan(authoritativeSandbox);
  });

  test("a terminal event before init persists its error before immediate projection", async () => {
    const id = sid();
    created.push(id);
    mkdirSync(SESSIONS_DIR, { recursive: true });
    const sessionPath = `${SESSIONS_DIR}/${id}.json`;
    expect(existsSync(sessionPath)).toBe(false);

    // runAutomation creates this native file before dispatching the backend.
    // Only then can the host journal run_registered and emit a terminal event.
    await updateSessionFile(id, () => ({
      id,
      claudeSessionId: "",
      branch: "main",
      worktreeDir: "/tmp",
      createdBy: "Regression automation (automation)",
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    }));
    await transitionRunState(
      id,
      "run_registered",
      { run_key: runKeyFor(id), kind: "automation" },
      silent,
    );

    await settleAutomationRunState(
      id,
      "failed before init",
      true,
      runKeyFor(id),
      {
        emit: silent,
        // Execute the actor-outbox destination before returning to the event
        // loop, which reproduces the race where init never created a file.
        project: (sessionId, errorMessage, opts) =>
          applyRunOutcomeProjection(
            sessionId,
            errorMessage,
            { ...opts, noticePersisted: true },
            true,
          ),
      },
    );

    expect(getRunState(id)).toBe("failed");
    const written = JSON.parse(readFileSync(sessionPath, "utf8"));
    expect(written.lastRunError?.message).toBe("failed before init");

    // Restart drops the process-local map. The session API must still recover
    // the error from the native file.
    runErrors.delete(id);
    expect(findSession(id)?.lastRunError?.message).toBe("failed before init");
  });

  test("nothing that can reject runs between the terminal event and settlement", () => {
    // The outer catch settles the LEDGER but cannot settle the session: the
    // run-state variables are scoped to the try. So every fallible step of the
    // completion tail — session persistence, output delivery, the ledger — has
    // to come after settlement, or a rejection reinstates the owner-less
    // running session this module exists to prevent.
    const source = readFileSync(
      resolve(import.meta.dir, "automations.ts"),
      "utf8",
    );
    // Anchor past the event loop: `persistSession` is also called on `init`.
    const streamDrained = source.indexOf(
      "errorMsg = declaredRunFailure(textTail)",
    );
    expect(streamDrained).toBeGreaterThan(0);
    const settleSession = source.indexOf(
      "await settleAutomationRunState(",
      streamDrained,
    );
    expect(settleSession).toBeGreaterThan(streamDrained);
    for (const fallible of [
      "await persistSession(engineSessionId);",
      "await deliverAutomationOutputs({",
      "settleRun(automation.id, bksId,",
    ]) {
      expect(source.indexOf(fallible, streamDrained)).toBeGreaterThan(
        settleSession,
      );
    }
  });

  test("every automation backend journals the run id the settlement fences on", () => {
    // The fence only holds if the id passed to settlement is the same one the
    // backend journals as `run_registered` — that is what becomes the actor's
    // `currentRunId`. All three dispatch paths must carry it, and every
    // settlement call site must pass it.
    const source = readFileSync(
      resolve(import.meta.dir, "automations.ts"),
      "utf8",
    );
    expect(source).toContain("const automationRunKey = `rh-${randomUUIDv7()}`");
    // Sandboxed runs journal spec.hostId; both gateway paths journal startToken.
    expect(source).toContain("hostId: automationRunKey");
    expect(source.match(/startToken: automationRunKey/g)).toHaveLength(2);
    // All three paths carry the same key: terminal event, post-loop safety
    // net, and definitive launch failure.
    expect(source).toContain("await settleAutomationLaunchFailure(");
    expect(
      source.match(/^\s*automationRunKey,\n/gm)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
  });
});
