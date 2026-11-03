import { isAgentEngineBusy } from "./agent-runner";
import { activeRunRecords } from "./run-journal";
import {
  ORPHANED_RUN_STATES,
  sessionRunStateProjection,
  sessionRunStateSnapshot,
  type DurableSessionQuarantine,
  type OrphanedRunProof,
} from "./session-kernel";
import {
  hasPendingOpening,
  hasSessionRunningHold,
} from "./session-state-events";

/** The wedge detector's reason for fencing a run nothing owns. */
export const ORPHANED_RUN_QUARANTINE_REASON =
  "The active run no longer has a live execution owner or recovery claim";

/**
 * Whether nothing in this gateway owns the session's run: no live or
 * recovering engine, no run journal record naming the session or its run, no
 * pending opening and no background hold. This is the evidence the wedge
 * detector uses to fence the session.
 */
export function runHasNoLiveOwner(
  sessionId: string,
  aliases: Array<string | null | undefined> = [],
  runId?: string,
): boolean {
  const ids = [sessionId, ...aliases].filter((id): id is string => !!id);
  if (isAgentEngineBusy(...ids)) return false;
  if (hasPendingOpening(sessionId) || hasSessionRunningHold(sessionId))
    return false;
  const owned = new Set(runId ? [...ids, runId] : ids);
  return !activeRunRecords().some((record) =>
    [
      record.osSessionId,
      record.claudeSessionId,
      record.runKey,
      record.hostId,
    ].some((id) => !!id && owned.has(id)),
  );
}

/**
 * Proof for `releaseSessionQuarantine` that the session's unsettled run is
 * unowned. It reads the durable run state, because the gateway projection only
 * knows decisions made since this process booted. The actor settles the run
 * only if it still has the state and run id seen here, so a run that takes
 * over in between is never touched.
 */
export async function orphanedRunProof(
  sessionId: string,
  aliases: Array<string | null | undefined> = [],
): Promise<OrphanedRunProof | undefined> {
  const run = await sessionRunStateSnapshot(sessionId);
  if (!ORPHANED_RUN_STATES.has(run.state)) return undefined;
  if (!runHasNoLiveOwner(sessionId, aliases, run.currentRunId))
    return undefined;
  return run.currentRunId
    ? { state: run.state, runId: run.currentRunId }
    : { state: run.state };
}

/** Synchronous display check: whether Repair can settle this fence's run.
 * The release re-derives the proof from durable state before acting. */
export function orphanedRunRepairable(
  quarantine: DurableSessionQuarantine,
  aliases: Array<string | null | undefined> = [],
): boolean {
  const unsettled =
    quarantine.reason === ORPHANED_RUN_QUARANTINE_REASON ||
    ORPHANED_RUN_STATES.has(
      sessionRunStateProjection(quarantine.sessionId).state,
    );
  return unsettled && runHasNoLiveOwner(quarantine.sessionId, aliases);
}
