/**
 * Archive a workspace's sessions, hiding the ones shown here right away.
 *
 * A sidebar workspace row renders only some of its sessions: PR reviews and
 * other automation runs, workers and anything outside the current lens are
 * left out. Archiving just the rendered ones left the rest live, so the
 * workspace never went away. When every session belongs to one workspace, the
 * server archives the whole workspace instead, and any shown session the
 * server's live list missed is archived on its own. Only the sessions that
 * actually failed are put back.
 */

import type { UnifiedSession } from "./types";

export interface ArchiveWorkspaceSessionsDeps {
  patch: (id: string, patch: Partial<UnifiedSession>) => void;
  archiveSession: (id: string) => Promise<void>;
  archiveWorkspace: (
    workspaceId: string,
  ) => Promise<{ archived: string[]; failed: string[] }>;
  rememberArchived: (ids: string[]) => void;
  dropStalePins: (sessions: UnifiedSession[]) => void;
  refreshSessions: () => void;
}

/** Resolves false when nothing was archived. */
export async function archiveWorkspaceSessions(
  sessions: UnifiedSession[],
  deps: ArchiveWorkspaceSessionsDeps,
): Promise<boolean> {
  const hide = (id: string) =>
    deps.patch(id, { archived: true, archivedReason: "manual" });
  const unhide = (id: string) =>
    deps.patch(id, { archived: false, archivedReason: undefined });
  for (const session of sessions) hide(session.id);

  const archiveEach = async (ids: string[]) => {
    const results = await Promise.allSettled(ids.map(deps.archiveSession));
    return {
      archived: ids.filter((_, i) => results[i]?.status === "fulfilled"),
      failed: ids.filter((_, i) => results[i]?.status === "rejected"),
    };
  };

  const workspaceId = sessions[0]?.workspaceId;
  const oneWorkspace =
    !!workspaceId && sessions.every((s) => s.workspaceId === workspaceId);
  let archived: string[];
  let failed: string[];
  try {
    if (oneWorkspace) {
      ({ archived, failed } = await deps.archiveWorkspace(workspaceId));
      const shown = new Set(sessions.map((s) => s.id));
      // Hide the members this client did not show (reviews, workers) too.
      for (const id of archived) if (!shown.has(id)) hide(id);
      const handled = new Set([...archived, ...failed]);
      const rest = await archiveEach(
        [...shown].filter((id) => !handled.has(id)),
      );
      archived = [...archived, ...rest.archived];
      failed = [...failed, ...rest.failed];
    } else {
      ({ archived, failed } = await archiveEach(sessions.map((s) => s.id)));
    }
  } catch (error) {
    console.error("Archive workspace failed:", error);
    for (const session of sessions) unhide(session.id);
    return false;
  }

  for (const id of failed) unhide(id);
  if (failed.length)
    console.error("Archive workspace failed for:", failed.join(", "));
  // One entry for the whole row, so ⌘Z restores the workspace in one press.
  if (archived.length) deps.rememberArchived(archived);
  const done = new Set(archived);
  deps.dropStalePins(sessions.filter((s) => done.has(s.id)));
  deps.refreshSessions();
  return archived.length > 0 || failed.length === 0;
}
