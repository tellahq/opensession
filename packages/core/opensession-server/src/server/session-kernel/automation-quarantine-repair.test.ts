/**
 * Two things are proved here:
 *
 * 1. The deadlock is real. A session quarantined by the wedge detector with
 *    `run_state:running` reports `repairable: false` and `releaseQuarantine`
 *    refuses it, so no explicit operator release can recover these sessions.
 * 2. The offline repair fixes the CAUSE and lets the UNMODIFIED release
 *    succeed, while every session that cannot produce durable terminal proof
 *    keeps its fence.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionKernelStore } from "./store";
import {
  ORPHANED_RUN_QUARANTINE_REASON,
  inspectAutomationQuarantine,
  repairSettledAutomationQuarantines,
  settledAutomationQuarantineEvidence,
  type AutomationLedgerStatus,
} from "./automation-quarantine-repair";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** A stranded automation session, exactly as the wedge detector leaves it. */
function fixture(
  sessions: Array<{
    sessionId: string;
    state?: string;
    reason?: string;
    commandKind?: string;
  }>,
): string {
  const root = mkdtempSync(join(tmpdir(), "automation-quarantine-repair-"));
  roots.push(root);
  const centralPath = join(root, "session-kernel.sqlite");
  const store = new SessionKernelStore(centralPath);
  for (const session of sessions) {
    store.setRunState({
      sessionId: session.sessionId,
      state: session.state ?? "running",
      event: "run_registered",
      currentRunId: `rh-${session.sessionId}`,
    });
    store.quarantineSession(
      session.sessionId,
      session.reason ?? ORPHANED_RUN_QUARANTINE_REASON,
      session.commandKind ?? `run_state:${session.state ?? "running"}`,
    );
  }
  store.close();
  return centralPath;
}

const ledger =
  (entries: Record<string, AutomationLedgerStatus>) => (sessionId: string) =>
    entries[sessionId];
const noJournal = () => false;

describe("the stranded state is genuinely unrecoverable online", () => {
  test("a run_state fence reports repairable:false and refuses release", () => {
    const centralPath = fixture([{ sessionId: "stranded" }]);
    const store = new SessionKernelStore(centralPath);
    try {
      // What GET /api/system/session-kernel/dead-letters surfaces.
      expect(store.quarantinedSession("stranded")?.repairable).toBe(false);
      // And the reducer refuses, so an explicit operator release is a no-op.
      expect(store.releaseQuarantine("stranded")).toBe(false);
      expect(store.quarantinedSession("stranded")).toBeTruthy();
    } finally {
      store.close();
    }
  });

  test("the unsettled run state is what blocks the release", () => {
    const centralPath = fixture([{ sessionId: "stranded" }]);
    const store = new SessionKernelStore(centralPath);
    try {
      expect(
        store.quarantineRepairEvidence("stranded", "run_state:running"),
      ).toBe(false);
      // Settling the FSM is the whole difference: no fence logic changes.
      store.setRunState({
        sessionId: "stranded",
        state: "idle",
        event: "turn_end",
      });
      expect(
        store.quarantineRepairEvidence("stranded", "run_state:running"),
      ).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("durable terminal evidence", () => {
  const base = {
    quarantine: {
      reason: ORPHANED_RUN_QUARANTINE_REASON,
      commandKind: "run_state:running",
    },
    runState: "running",
    ledgerStatus: "ok" as AutomationLedgerStatus,
    journalBusy: false,
  };

  test("accepts a completed automation run with no owner", () => {
    expect(settledAutomationQuarantineEvidence(base)).toEqual({
      repairable: true,
      settleAs: "idle",
      event: "turn_end",
    });
  });

  test("settles a failed automation run as failed", () => {
    expect(
      settledAutomationQuarantineEvidence({ ...base, ledgerStatus: "error" }),
    ).toEqual({ repairable: true, settleAs: "failed", event: "run_failed" });
  });

  test("refuses without a terminal ledger verdict", () => {
    expect(
      settledAutomationQuarantineEvidence({ ...base, ledgerStatus: "running" })
        .repairable,
    ).toBe(false);
    expect(
      settledAutomationQuarantineEvidence({ ...base, ledgerStatus: undefined })
        .repairable,
    ).toBe(false);
  });

  test("refuses while the run journal still owns the session", () => {
    expect(
      settledAutomationQuarantineEvidence({ ...base, journalBusy: true })
        .repairable,
    ).toBe(false);
  });

  test("refuses any quarantine that is not the ownership wedge", () => {
    expect(
      settledAutomationQuarantineEvidence({
        ...base,
        quarantine: {
          reason: "Outbox 7 crossed session ownership",
          commandKind: "core:ack_outbox",
        },
      }).repairable,
    ).toBe(false);
    expect(
      settledAutomationQuarantineEvidence({
        ...base,
        quarantine: {
          reason: ORPHANED_RUN_QUARANTINE_REASON,
          commandKind: "gateway:complete",
        },
      }).repairable,
    ).toBe(false);
  });

  test("only applies edges the run-state machine actually defines", () => {
    // `idle` has no turn_end edge: settling it would be a double teardown.
    expect(
      settledAutomationQuarantineEvidence({ ...base, runState: "idle" })
        .repairable,
    ).toBe(false);
    // A human-blocked ask is not an owner-less run and has its own edge rules.
    expect(
      settledAutomationQuarantineEvidence({ ...base, runState: "ask_blocked" }),
    ).toEqual({ repairable: true, settleAs: "idle", event: "turn_end" });
  });
});

describe("offline repair", () => {
  test("settles and releases a completed automation session", () => {
    const centralPath = fixture([{ sessionId: "auto-done" }]);
    const result = repairSettledAutomationQuarantines({
      centralPath,
      ledgerStatus: ledger({ "auto-done": "ok" }),
      journalBusy: noJournal,
    });

    expect(result.repaired).toEqual([
      {
        sessionId: "auto-done",
        ledgerStatus: "ok",
        from: "running",
        to: "idle",
        released: true,
      },
    ]);
    const store = new SessionKernelStore(centralPath);
    try {
      expect(store.quarantinedSession("auto-done")).toBeUndefined();
      expect(store.runState("auto-done").state).toBe("idle");
      // A settled run must not keep claiming a physical owner.
      expect(store.runState("auto-done").currentRunId).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("a dry run changes nothing", () => {
    const centralPath = fixture([{ sessionId: "auto-done" }]);
    const result = repairSettledAutomationQuarantines({
      centralPath,
      dryRun: true,
      ledgerStatus: ledger({ "auto-done": "ok" }),
      journalBusy: noJournal,
    });

    expect(result.repaired[0]).toMatchObject({ to: "idle", released: false });
    const store = new SessionKernelStore(centralPath);
    try {
      expect(store.quarantinedSession("auto-done")).toBeTruthy();
      expect(store.runState("auto-done").state).toBe("running");
    } finally {
      store.close();
    }
  });

  test("leaves every unproven quarantine fenced", () => {
    const centralPath = fixture([
      { sessionId: "auto-done" },
      { sessionId: "auto-still-running" },
      { sessionId: "auto-owned" },
      { sessionId: "not-an-automation" },
      {
        sessionId: "other-fence",
        reason: "actor restarted before acknowledgement",
        commandKind: "gateway:complete",
      },
    ]);
    const result = repairSettledAutomationQuarantines({
      centralPath,
      ledgerStatus: ledger({
        "auto-done": "ok",
        "auto-still-running": "running",
        "auto-owned": "ok",
        "other-fence": "ok",
      }),
      journalBusy: (id) => id === "auto-owned",
    });

    expect(result.scanned).toBe(5);
    expect(result.repaired.map((r) => r.sessionId)).toEqual(["auto-done"]);
    expect(result.skipped.map((s) => s.sessionId).sort()).toEqual([
      "auto-owned",
      "auto-still-running",
      "not-an-automation",
      "other-fence",
    ]);
    const store = new SessionKernelStore(centralPath);
    try {
      for (const id of [
        "auto-still-running",
        "auto-owned",
        "not-an-automation",
        "other-fence",
      ]) {
        expect(store.quarantinedSession(id)).toBeTruthy();
        expect(store.runState(id).state).toBe("running");
      }
    } finally {
      store.close();
    }
  });

  test("is idempotent", () => {
    const centralPath = fixture([{ sessionId: "auto-done" }]);
    const inputs = {
      centralPath,
      ledgerStatus: ledger({ "auto-done": "ok" }),
      journalBusy: noJournal,
    };
    repairSettledAutomationQuarantines(inputs);
    const second = repairSettledAutomationQuarantines(inputs);

    expect(second.scanned).toBe(0);
    expect(second.repaired).toEqual([]);
  });

  test("inspection reports the verdict without mutating anything", () => {
    const centralPath = fixture([{ sessionId: "auto-done" }]);
    const verdict = inspectAutomationQuarantine(centralPath, "auto-done", {
      ledgerStatus: ledger({ "auto-done": "ok" }),
      journalBusy: noJournal,
    });

    expect(verdict).toMatchObject({ quarantined: true, repairable: true });
    const store = new SessionKernelStore(centralPath);
    try {
      expect(store.quarantinedSession("auto-done")).toBeTruthy();
    } finally {
      store.close();
    }
  });
});
