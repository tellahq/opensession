/**
 * Offline repair for automation sessions stranded by the missing settlement
 * that `settleAutomationRunState` now prevents.
 *
 * Those sessions are deadlocked by design, and the deadlock is correct:
 *
 * - The wedge detector quarantined them with `run_state:<state>` because the
 *   FSM claimed a run with no live owner.
 * - `quarantineRepairEvidence` refuses to release while the FSM is in an
 *   unsettled state, so the fence reports `repairable: false`.
 * - The actor fences every session mutation except `quarantineSession` and
 *   `releaseQuarantine`, so nothing online can settle the FSM either.
 *
 * The fix is to repair the CAUSE rather than weaken the fence: settle the run
 * state offline, after which the existing `releaseQuarantine` passes on its own
 * unmodified merits. Every other evidence check — ambiguous commands, claimed
 * timers, pending effects — still runs and still fails closed. No production
 * code path changes, and generic `run_state` quarantine keeps its full
 * strength for every session that cannot produce the proof below.
 */
import { type DurableSessionQuarantine, type DurableRunState } from "./store";
import { SessionKernelStoreHost } from "./store-host";
import { nextRunState, type RunState } from "./run-state-machine";

/** The exact wedge-detector reason. Any other quarantine is out of scope. */
export const ORPHANED_RUN_QUARANTINE_REASON =
  "The active run no longer has a live execution owner or recovery claim";

export type AutomationLedgerStatus = "running" | "ok" | "error";

export interface AutomationQuarantineEvidence {
  quarantine: Pick<DurableSessionQuarantine, "reason" | "commandKind">;
  runState: string;
  /** The automation ledger's own verdict for this session's run. */
  ledgerStatus?: AutomationLedgerStatus;
  /** Whether any run-journal record still names this session. */
  journalBusy: boolean;
}

export type AutomationQuarantineVerdict =
  | { repairable: true; settleAs: RunState; event: "turn_end" | "run_failed" }
  | { repairable: false; reason: string };

/**
 * Durable proof that an automation run is terminal and unowned.
 *
 * Every clause is a fail-closed conjunct. In particular the ledger must have
 * already recorded a terminal verdict for THIS session: that is the durable
 * receipt that `runAutomation` drained its engine stream and reached its
 * completion tail, which is exactly the state the missing settlement stranded.
 * A ledger still reading `running` proves nothing and is left alone.
 */
export function settledAutomationQuarantineEvidence(
  input: AutomationQuarantineEvidence,
): AutomationQuarantineVerdict {
  if (input.quarantine.reason !== ORPHANED_RUN_QUARANTINE_REASON)
    return { repairable: false, reason: "quarantine reason is not the wedge" };
  if (!input.quarantine.commandKind.startsWith("run_state:"))
    return { repairable: false, reason: "quarantine is not a run-state fence" };
  if (!input.ledgerStatus)
    return { repairable: false, reason: "no automation ledger entry" };
  if (input.ledgerStatus === "running")
    return { repairable: false, reason: "automation ledger is still running" };
  // A journal record is a live owner or a recovery claim. Either way the run
  // may still execute, and settling it would let a successor overlap it.
  if (input.journalBusy)
    return { repairable: false, reason: "run journal still owns this session" };
  const event = input.ledgerStatus === "error" ? "run_failed" : "turn_end";
  // Only a legal FSM edge. This never invents a state the machine would refuse;
  // it applies the settlement the completed run should have applied itself.
  const settleAs = nextRunState(input.runState as RunState, event);
  if (!settleAs)
    return {
      repairable: false,
      reason: `no ${event} edge from ${input.runState}`,
    };
  return { repairable: true, settleAs, event };
}

export interface AutomationQuarantineRepair {
  sessionId: string;
  ledgerStatus: "ok" | "error";
  from: string;
  to: string;
  released: boolean;
}

export interface AutomationQuarantineRepairResult {
  dryRun: boolean;
  scanned: number;
  repaired: AutomationQuarantineRepair[];
  skipped: Array<{ sessionId: string; reason: string }>;
}

export interface AutomationQuarantineRepairInputs {
  /** Terminal ledger verdict per automation session id. */
  ledgerStatus: (sessionId: string) => AutomationLedgerStatus | undefined;
  /** Whether the run journal still names this session. */
  journalBusy: (sessionId: string) => boolean;
}

/**
 * Settle and release every automation session that can prove the state above.
 *
 * Runs against a stopped instance (the caller asserts that), so it may open the
 * kernel store host directly. It walks the quarantine catalog only — never the
 * placement table and never every actor database — so it stays inside the
 * ownership invariants even though it is an offline job.
 */
export function repairSettledAutomationQuarantines(
  options: {
    centralPath: string;
    isolatedRoot?: string;
    dryRun?: boolean;
    pageSize?: number;
  } & AutomationQuarantineRepairInputs,
): AutomationQuarantineRepairResult {
  const host = new SessionKernelStoreHost(
    options.centralPath,
    options.isolatedRoot,
  );
  const result: AutomationQuarantineRepairResult = {
    dryRun: options.dryRun === true,
    scanned: 0,
    repaired: [],
    skipped: [],
  };
  const pageSize = options.pageSize ?? 100;
  try {
    const quarantines: DurableSessionQuarantine[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = host.call("quarantinedSessions", [
        pageSize,
        offset,
      ]) as DurableSessionQuarantine[];
      quarantines.push(...page);
      if (page.length < pageSize) break;
    }
    for (const quarantine of quarantines) {
      result.scanned += 1;
      const sessionId = quarantine.sessionId;
      const runState = host.call("runState", [sessionId]) as DurableRunState;
      const verdict = settledAutomationQuarantineEvidence({
        quarantine,
        runState: runState.state,
        ledgerStatus: options.ledgerStatus(sessionId),
        journalBusy: options.journalBusy(sessionId),
      });
      if (!verdict.repairable) {
        result.skipped.push({ sessionId, reason: verdict.reason });
        continue;
      }
      const ledgerStatus = options.ledgerStatus(sessionId) as "ok" | "error";
      if (options.dryRun) {
        result.repaired.push({
          sessionId,
          ledgerStatus,
          from: runState.state,
          to: verdict.settleAs,
          released: false,
        });
        continue;
      }
      host.call("setRunState", [
        {
          sessionId,
          state: verdict.settleAs,
          event: verdict.event,
          detail: { source: "offline_automation_quarantine_repair" },
        },
      ]);
      // The unmodified release. It re-derives its own evidence, so a session
      // carrying anything else unproven still refuses here.
      const released = host.call("releaseQuarantine", [sessionId]) as boolean;
      result.repaired.push({
        sessionId,
        ledgerStatus,
        from: runState.state,
        to: verdict.settleAs,
        released,
      });
    }
  } finally {
    host.close();
  }
  return result;
}

/**
 * Read-only helper for operators inspecting a single session's evidence.
 *
 * Routes through the store host, exactly as the repair does. Opening the
 * central database directly reads the wrong store for an actor-isolated
 * session: its quarantine row and run state live in that session's own
 * database, and the catalog holds only a sparse projection. A direct central
 * read therefore reports a live fence as "session is not quarantined", and
 * even when the catalog does carry the row it cannot recompute `repairable`
 * from the isolated store's own evidence the way the host does.
 */
export function inspectAutomationQuarantine(
  centralPath: string,
  sessionId: string,
  inputs: AutomationQuarantineRepairInputs,
  isolatedRoot?: string,
): AutomationQuarantineVerdict & { quarantined: boolean } {
  const host = new SessionKernelStoreHost(centralPath, isolatedRoot);
  try {
    const quarantine = host.call("quarantinedSession", [sessionId]) as
      | DurableSessionQuarantine
      | undefined;
    if (!quarantine)
      return {
        quarantined: false,
        repairable: false,
        reason: "session is not quarantined",
      };
    const runState = host.call("runState", [sessionId]) as DurableRunState;
    return {
      quarantined: true,
      ...settledAutomationQuarantineEvidence({
        quarantine,
        runState: runState.state,
        ledgerStatus: inputs.ledgerStatus(sessionId),
        journalBusy: inputs.journalBusy(sessionId),
      }),
    };
  } finally {
    host.close();
  }
}
