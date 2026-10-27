/**
 * Archive or unarchive one session the way the sidebar does. Shared by the
 * POST /api/sessions/:id/archive route and the opensession-sessions
 * archive tools, so an agent's archive stops runs, drops pins and clears
 * Plain file flags exactly like a click in the UI.
 */
import { currentAgentRunToken, isAgentSessionBusy } from "./agent-runner";
import { setArchived, unpinArchivedSessions } from "./archive";
import { audit } from "./audit";
import { clearSessionFileArchive } from "./plain-archive";
import { requestTurnCancel } from "./run-session";
import {
  getSessionListSnapshotAsync,
  publishSessionChange,
} from "./session-cache";
import { sessionKernel } from "./session-kernel";
import { executeArchiveOverrideProjection } from "./session-projection-executor";
import type { UnifiedSession } from "./types";

export async function setSessionArchivedState(
  session: UnifiedSession,
  archived: boolean,
): Promise<{ stoppedRun: boolean }> {
  const sessionId = session.id;
  // Archiving means "I'm done with this" — so stop an owned in-flight
  // run rather than leaving an orphaned turn burning tokens after the
  // session already reads as archived. Only runs owned by this process
  // (busyHere) are stoppable; external/CLI runs can't be reached from
  // here. Graceful Esc-style stop (fall back to hard cancel for runs
  // with no interrupt support) keeps the transcript clean and resumable
  // on unarchive.
  let stoppedRun = false;
  if (
    archived &&
    isAgentSessionBusy(
      session.claudeSessionId,
      session.codexThreadId,
      sessionId,
    )
  ) {
    const target = sessionKernel(sessionId).runStateProjection();
    const targetRunId =
      target.currentRunId ||
      (target.state === "starting" || target.state === "preparing"
        ? currentAgentRunToken(sessionId)
        : undefined);
    if (targetRunId) {
      try {
        await requestTurnCancel(sessionId, session, {
          cancelId: `archive-stop:${sessionId}:${targetRunId}:${target.generation}`,
          expectedRunId: targetRunId,
          expectedGeneration: target.generation,
          source: "archive",
        });
        audit({
          msg: "run_cancelled",
          session_id: sessionId,
          source: "archive",
        });
        stoppedRun = true;
      } catch {
        // The actor fences cancels by run id + generation; losing the race
        // (the run settled between our busy check and prepare) throws out
        // of requestTurnCancel. That must not fail the archive — the usual
        // case is the run having finished anyway.
      }
    }
  }
  await executeArchiveOverrideProjection(sessionId, () =>
    setArchived(sessionId, archived),
  );
  // Plain done-tickets are archived via a file-level flag, not the
  // registry; clearing only the registry would leave them archived. On
  // unarchive, also clear the file flag so the session returns to "My
  // sessions".
  if (!archived) clearSessionFileArchive(sessionId);
  await publishSessionChange(sessionId);
  if (archived) {
    // setArchived drops the plain id pin; also drop legacy alias-id pins,
    // and the workspace pin once its last live session is archived (else the
    // row resurfaces in Pinned when a new session joins the workspace).
    await unpinArchivedSessions([session], await getSessionListSnapshotAsync());
  }
  return { stoppedRun };
}
