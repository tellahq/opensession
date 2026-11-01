/**
 * Turn-end glue for direct-ship tracking (direct-ship.ts): pick the sessions
 * that ship directly, run one reconcile pass on their own worktree, save what
 * it found on the session, and archive the workspace when the repository
 * asks for it. Only the session's own worktree and its indexed workspace
 * members are touched; nothing here scans sessions.
 */

import { canonicalPath, getRepo, sessionRepoId } from "./worktree";
import { hasRemoteWorkspace } from "./sandbox";
import { updateSessionFile } from "./session-cache";
import { findPrSessionAsync } from "./session-pr-lookup";
import { sessionShipMode } from "./session-repos";
import { reconcileDirectShips } from "./direct-ship";
import {
  githubCredentialForLogin,
  githubCredentialForRun,
} from "./github-auth";
import { broadcastToSession } from "./ws-hub";
import type { UnifiedSession } from "./types";

/** Whether this session's branch ships straight to the default branch. */
export function tracksDirectShips(session: UnifiedSession): boolean {
  if (session.mode !== "code" || !session.worktreeDir || !session.branch)
    return false;
  if (session.automation || session.automationId) return false;
  if (session.automationDescendantPolicy) return false;
  if (hasRemoteWorkspace(session)) return false;
  const repoId = sessionRepoId(session);
  if (!repoId) return false;
  let repo;
  try {
    repo = getRepo(repoId);
  } catch {
    return false;
  }
  // A shared checkout is the default branch already, used by every session
  // there: its pushes cannot be attributed to one workspace.
  if (canonicalPath(session.worktreeDir) === canonicalPath(repo.repo))
    return false;
  if (session.branch === repo.defaultBranch) return false;
  return sessionShipMode(session, repo).mode === "direct";
}

async function archiveWorkspace(session: UnifiedSession): Promise<string[]> {
  const [archive, store, cache, projection] = await Promise.all([
    import("./archive"),
    import("./session-list-store"),
    import("./session-cache"),
    import("./session-projection-executor"),
  ]);
  const members = session.workspaceId
    ? await store.indexedWorkspaceMembers(session.workspaceId)
    : [session];
  const live = cache.enrichSessionRuntime(members.map((row) => ({ ...row })));
  const archived: UnifiedSession[] = [];
  for (const member of live) {
    if (member.archived || archive.isArchivedId(member.id)) continue;
    // The session whose turn just ended is done; a sibling still running is
    // someone's live work and keeps the workspace open for it.
    if (member.id !== session.id && member.isRunning) return [];
  }
  for (const member of live) {
    if (member.archived || archive.isArchivedId(member.id)) continue;
    await projection.executeArchiveOverrideProjection(member.id, () =>
      archive.setArchived(member.id, true, "auto"),
    );
    await cache.publishSessionChange(member.id);
    archived.push(member);
  }
  await archive.unpinArchivedSessions(archived, live);
  return archived.map((member) => member.id);
}

/**
 * After a clean turn of a direct-mode session: record a push of its HEAD to
 * the default branch, confirm it on the remote, and archive the workspace
 * once it is shipped and the repository opted in (`archiveShipped`).
 */
export async function trackDirectShipAfterTurn(
  sessionId: string,
): Promise<void> {
  // PR-aware, so a branch that opened a PR stops being tracked as direct.
  const session = await findPrSessionAsync(sessionId);
  if (!session || !tracksDirectShips(session)) return;
  const repo = getRepo(sessionRepoId(session)!);
  const env = session.createdByLogin
    ? githubCredentialForLogin(session.createdByLogin)?.env
    : githubCredentialForRun(session.createdBy || session.startedBy)?.env;
  const outcome = await reconcileDirectShips({ session, repo, env });
  if (outcome.changed) {
    await updateSessionFile(session.id, (data) => ({
      ...data,
      directShips: outcome.ships,
    }));
    console.log(
      `[direct-ship] ${session.id} ${repo.id}/${session.branch}: ${outcome.ships
        .slice(-1)
        .map(
          (ship) =>
            `${ship.sha.slice(0, 9)}${ship.shippedAt ? " shipped" : " pushed"}`,
        )
        .join("")}`,
    );
    // The same nudge a branch push sends: open viewers refetch git surfaces.
    broadcastToSession(session.id, {
      type: "git_pushed",
      sessionId: session.id,
      repo: repo.id,
    });
  }
  if (outcome.archive) {
    const archived = await archiveWorkspace(session);
    if (archived.length)
      console.log(
        `[direct-ship] ${session.id} shipped → archived ${archived.join(", ")}`,
      );
  }
}
