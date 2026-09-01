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
import { readFileSync } from "fs";
import { resolve } from "path";
import { settleAutomationRunState } from "./automations";
import {
  clearRunState,
  getRunState,
  isRunStateUnsettled,
  transitionRunState,
} from "./run-state";
import { runStateRequiresLiveOwner } from "./session-cache";

const silent = () => {};
const sid = () => `automation-settlement-${crypto.randomUUID()}`;
const created: string[] = [];

/** Put the session where a journaled detached automation host leaves it. */
async function hostedAutomationRunning(id: string): Promise<void> {
  created.push(id);
  await transitionRunState(
    id,
    "run_registered",
    { run_key: `rh-${id}`, kind: "automation" },
    silent,
  );
  expect(getRunState(id)).toBe("running");
}

afterEach(async () => {
  for (const id of created.splice(0)) await clearRunState(id);
});

describe("automation run settlement", () => {
  test("a completed automation turn leaves no owner-less running session", async () => {
    const id = sid();
    await hostedAutomationRunning(id);

    // The exact reported state: the host has retired, nothing owns the run,
    // and the FSM still claims `running` — the ownership watchdog's
    // quarantine precondition ("no live execution owner or recovery claim").
    expect(runStateRequiresLiveOwner(getRunState(id))).toBe(true);

    await settleAutomationRunState(id, null, true, silent);

    expect(getRunState(id)).toBe("idle");
    expect(isRunStateUnsettled(getRunState(id))).toBe(false);
    expect(runStateRequiresLiveOwner(getRunState(id))).toBe(false);
  });

  test("a declared or streamed failure settles as failed, not running", async () => {
    const id = sid();
    await hostedAutomationRunning(id);

    await settleAutomationRunState(id, "RUN STATUS: failed", true, silent);

    expect(getRunState(id)).toBe("failed");
    expect(isRunStateUnsettled(getRunState(id))).toBe(false);
  });

  test("a stream that ended without a terminal event keeps the safety fence", async () => {
    const id = sid();
    await hostedAutomationRunning(id);

    // Nothing proved what this run did, so it must stay owned and pausable.
    // Settling here would retire a fence that exists for unverified effects.
    await settleAutomationRunState(id, null, false, silent);

    expect(getRunState(id)).toBe("running");
    expect(isRunStateUnsettled(getRunState(id))).toBe(true);
  });

  test("settling an already-settled session emits no double teardown", async () => {
    const id = sid();
    await hostedAutomationRunning(id);
    await settleAutomationRunState(id, null, true, silent);

    const events: Record<string, unknown>[] = [];
    await settleAutomationRunState(id, null, true, (event) =>
      events.push(event),
    );

    expect(events).toEqual([]);
    expect(getRunState(id)).toBe("idle");
  });

  test("runAutomation settles the session before claiming the ledger outcome", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "automations.ts"),
      "utf8",
    );
    const terminalFlag = source.indexOf("sawTerminalEvent = true");
    const settleSession = source.indexOf(
      "await settleAutomationRunState(bksId,",
    );
    const settleLedger = source.indexOf(
      "settleRun(automation.id, bksId,",
      settleSession,
    );
    expect(terminalFlag).toBeGreaterThan(0);
    expect(settleSession).toBeGreaterThan(terminalFlag);
    expect(settleLedger).toBeGreaterThan(settleSession);
  });
});
