/**
 * The closed sessions a workspace offers in its tab strip's history menu.
 *
 * Two sources, because neither is complete on its own. The client polls the
 * LIVE slice only (see session-slices), so the sessions it holds in memory
 * carry no archived rows except the ones archived in this browser a moment
 * ago; the workspace-scoped fetch
 * (`?archived=only&slim=1&workspace=<id>`) has the rest, but is a beat behind
 * whatever just happened here.
 *
 * So merge them with the in-memory row winning: it is fresher, and it is
 * full-fat rather than a slim index row. A session present in memory and NOT
 * archived was restored here, so a stale fetched copy of it is dropped rather
 * than resurrecting the row until the next refetch.
 *
 * Membership is `inWorkspaceGroup` from the protocol package, the same rule
 * the server filters with.
 */

import {
  hasWorkspaceGroup,
  inWorkspaceGroup,
  type WorkspaceGroup,
} from "@tellahq/opensession-protocol/workspace-group";
import type { UnifiedSession } from "./types";

export interface WorkspaceArchiveInput extends WorkspaceGroup {
  /** Every session the client holds, live plus anything archived here. */
  sessions: readonly UnifiedSession[];
  /** Rows from the workspace-scoped archived fetch, if it has landed. */
  fetched?: readonly UnifiedSession[];
  /** The open session keeps a live tab even when archived, so it never lists. */
  excludeId?: string | null;
}

/** This workspace's archived sessions, newest activity first. */
export function workspaceArchivedSessions(
  input: WorkspaceArchiveInput,
): UnifiedSession[] {
  const { sessions, fetched, excludeId, workspaceId, worktreeDir } = input;
  const group: WorkspaceGroup = { workspaceId, worktreeDir };
  if (!hasWorkspaceGroup(group)) return [];
  const wanted = (s: UnifiedSession) =>
    s.id !== excludeId && inWorkspaceGroup(s, group);
  const known = new Map(sessions.map((s) => [s.id, s] as const));
  const rows = sessions.filter((s) => s.archived && wanted(s));
  for (const s of fetched ?? [])
    if (!known.has(s.id) && wanted(s)) rows.push(s);
  return rows.sort((a, b) =>
    (b.lastActivity || "").localeCompare(a.lastActivity || ""),
  );
}
