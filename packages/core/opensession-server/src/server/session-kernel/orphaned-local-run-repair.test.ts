import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionKernelStore } from "./store";
import { SessionKernelStoreHost } from "./store-host";
import { ORPHANED_RUN_QUARANTINE_REASON } from "./automation-quarantine-repair";
import {
  settleStoppedLocalRun,
  stoppedLocalRunJournalProof,
} from "./orphaned-local-run-repair";
import { journalOwnsSession } from "../../../../../../scripts/repair-orphaned-local-runs";

const hostId = "rh-12345678-example";
const unit = `bks-run-${hostId}.service`;
const terminalMessage = "[host rh-12345678] run ended: done";
function line(at: number, message: string, pid = "101", fromUnit = unit) {
  return JSON.stringify({
    __REALTIME_TIMESTAMP: String(at * 1000),
    MESSAGE: message,
    _PID: pid,
    _SYSTEMD_UNIT: fromUnit,
  });
}
function journal(at: number) {
  return [
    line(at, terminalMessage),
    line(at + 1, `${unit}: Deactivated successfully.`, "1", "init.scope"),
  ].join("\n");
}
const stores: SessionKernelStore[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(
  reason = ORPHANED_RUN_QUARANTINE_REASON,
  kind = "run_state:running",
) {
  const store = new SessionKernelStore(":memory:");
  stores.push(store);
  const sessionId = "os-example";
  store.setRunState({
    sessionId,
    state: "running",
    event: "run_registered",
    currentRunId: hostId,
    generation: 3,
  });
  store.quarantineSession(sessionId, reason, kind);
  const expected = store.runState(sessionId);
  return {
    store,
    sessionId,
    expected,
    proof: stoppedLocalRunJournalProof(
      hostId,
      Date.parse(expected.since),
      journal(Date.now() + 1),
    ),
    journalBusy: false,
    hostInactive: true,
    cgroupEmpty: true,
    dryRun: false,
  };
}

describe("stopped host evidence", () => {
  test("requires a host terminal event and a later systemd exit", () => {
    expect(stoppedLocalRunJournalProof(hostId, 10, journal(20))).toEqual({
      hostId,
      terminalAt: 20,
      exitedAt: 21,
      outcome: "done",
    });
    expect(
      stoppedLocalRunJournalProof(hostId, 10, line(20, terminalMessage)),
    ).toBeUndefined();
    expect(
      stoppedLocalRunJournalProof(
        hostId,
        10,
        line(21, `${unit}: Deactivated successfully.`, "1", "init.scope"),
      ),
    ).toBeUndefined();
  });
  test("refuses a forged manager line, foreign unit, old receipt, and restart", () => {
    expect(
      stoppedLocalRunJournalProof(
        hostId,
        10,
        [
          line(20, terminalMessage),
          line(21, `${unit}: Deactivated successfully.`),
        ].join("\n"),
      ),
    ).toBeUndefined();
    expect(
      stoppedLocalRunJournalProof("rh-foreign", 10, journal(20)),
    ).toBeUndefined();
    expect(
      stoppedLocalRunJournalProof(hostId, 30, journal(20)),
    ).toBeUndefined();
    expect(
      stoppedLocalRunJournalProof(
        hostId,
        10,
        `${journal(20)}\n${line(22, `Started ${unit} - Open Session run host`, "1", "init.scope")}`,
      ),
    ).toBeUndefined();
    expect(
      stoppedLocalRunJournalProof(hostId, 10, `${journal(20)}\nnot json`),
    ).toBeUndefined();
  });
});

describe("offline run reconciliation", () => {
  test("settles only the proven host and ordinary release then succeeds", () => {
    const input = fixture();
    expect(input.store.releaseQuarantine(input.sessionId)).toBe(false);
    expect(settleStoppedLocalRun(input)).toMatchObject({ status: "settled" });
    expect(input.store.runState(input.sessionId)).toMatchObject({
      state: "failed",
      generation: 3,
      currentRunId: undefined,
    });
    expect(input.store.releaseQuarantine(input.sessionId)).toBe(true);
    expect(input.store.quarantinedSession(input.sessionId)).toBeUndefined();
  });
  test("dry run leaves all durable state unchanged", () => {
    const input = fixture();
    expect(settleStoppedLocalRun({ ...input, dryRun: true })).toMatchObject({
      status: "eligible",
    });
    expect(input.store.runState(input.sessionId)).toEqual(input.expected);
    expect(input.store.quarantinedSession(input.sessionId)?.repairable).toBe(
      false,
    );
  });
  test("refuses absent evidence and any possible live owner", () => {
    for (const patch of [
      { proof: undefined },
      { journalBusy: true },
      { hostInactive: false },
      { cgroupEmpty: false },
    ]) {
      const input = fixture();
      expect(settleStoppedLocalRun({ ...input, ...patch }).status).toBe(
        "skipped",
      );
      expect(input.store.runState(input.sessionId)).toEqual(input.expected);
    }
  });
  test("rejects a changed generation, run id, revision, and foreign fence", () => {
    for (const patch of [
      { generation: 9 },
      { currentRunId: "rh-successor" },
      { changeSeq: 99 },
    ]) {
      const input = fixture();
      expect(
        settleStoppedLocalRun({
          ...input,
          expected: { ...input.expected, ...patch },
        }).status,
      ).toBe("skipped");
      expect(input.store.runState(input.sessionId)).toEqual(input.expected);
    }
    const input = fixture("ambiguous physical operation", "gateway:complete");
    expect(settleStoppedLocalRun(input).status).toBe("skipped");
  });
  test("a pending external effect keeps its fence after run settlement", () => {
    const input = fixture();
    input.store.enqueueOutbox(
      input.sessionId,
      "human_ask_deliver",
      { askId: "keep" },
      "keep-effect",
    );
    expect(settleStoppedLocalRun(input).status).toBe("settled");
    expect(input.store.releaseQuarantine(input.sessionId)).toBe(false);
    expect(input.store.quarantinedSession(input.sessionId)).toBeDefined();
  });
  test("keeps queued prompts intact", () => {
    const input = fixture();
    input.store.setDeliverySlot(input.sessionId, "queued", [
      { id: "keep", text: "do not lose this" },
    ]);
    const before = input.store.deliverySnapshot(input.sessionId);
    input.expected = input.store.runState(input.sessionId);
    expect(settleStoppedLocalRun(input).status).toBe("settled");
    expect(input.store.deliverySnapshot(input.sessionId)).toEqual(before);
  });
  test("repairs the isolated actor and catalog projection, surviving reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "orphaned-local-run-"));
    roots.push(root);
    const centralPath = join(root, "session-kernel.sqlite");
    const isolatedRoot = join(root, "sessions");
    const central = new SessionKernelStore(centralPath);
    central.setRunState({
      sessionId: "os-isolated",
      state: "running",
      event: "run_registered",
      currentRunId: hostId,
    });
    central.close();
    let host = new SessionKernelStoreHost(centralPath, isolatedRoot);
    try {
      host.migrateLegacySessions(10);
      host.quarantineSession(
        "os-isolated",
        ORPHANED_RUN_QUARANTINE_REASON,
        "run_state:running",
      );
      const store = host.storeForSession("os-isolated");
      const expected = store.runState("os-isolated");
      expect(
        settleStoppedLocalRun({
          store,
          sessionId: "os-isolated",
          expected,
          proof: stoppedLocalRunJournalProof(
            hostId,
            Date.parse(expected.since),
            journal(Date.now() + 1),
          ),
          journalBusy: false,
          hostInactive: true,
          cgroupEmpty: true,
          dryRun: false,
        }).status,
      ).toBe("settled");
      host.refreshSessionProjections("os-isolated");
      expect(host.call("releaseQuarantine", ["os-isolated"])).toBe(true);
      host.close();
      host = new SessionKernelStoreHost(centralPath, isolatedRoot);
      expect(host.call("runState", ["os-isolated"])).toMatchObject({
        state: "failed",
      });
      expect(host.quarantinedSession("os-isolated")).toBeUndefined();
    } finally {
      host.close();
    }
  });
});

test("gateway journal ownership is fail-closed and includes recovery aliases", () => {
  expect(journalOwnsSession({}, "os-example", hostId)).toBe(false);
  expect(
    journalOwnsSession(
      { run: { runKey: "other", osSessionId: "os-example", claimedAt: "now" } },
      "os-example",
      hostId,
    ),
  ).toBe(true);
  expect(
    journalOwnsSession({ run: { runKey: hostId } }, "os-example", hostId),
  ).toBe(true);
  expect(() => journalOwnsSession(null, "os-example")).toThrow();
  expect(() => journalOwnsSession({ run: {} }, "os-example")).toThrow();
  expect(() =>
    journalOwnsSession(
      { run: { runKey: "other", osSessionId: {} } },
      "os-example",
    ),
  ).toThrow();
});
