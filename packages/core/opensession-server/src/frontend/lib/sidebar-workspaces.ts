import { prLinksMatch, sessionPrRefs } from "./session-prs";
import type { SessionPrRef, UnifiedSession, Workspace } from "./types";

export function isScratchWorkspace(
  sessions: readonly Pick<UnifiedSession, "mode">[],
): boolean {
  return (
    sessions.length > 0 &&
    sessions.every((session) => session.mode === "scratch")
  );
}

/**
 * The band repo-less Ask workspaces group into, pinned above the projects.
 *
 * A pseudo-band, not a repo: it is never written to the user's `repo-order`
 * pref, never drags, and is never a value of the repo filter. Keeping it out
 * of those keeps a namespace of real repo ids free of a sentinel that a repo
 * could one day be named.
 */
export const ASK_BAND = "__ask__";

/**
 * A workspace of nothing but repo-less Ask sessions — the "Ask" band that
 * sits above the project bands.
 *
 * Both halves are required. `mode` alone would sweep in every repo-scoped ask
 * session, which belongs in its repo's band; `repoLess` alone would sweep in
 * scratch. A workspace that mixes the two is not an Ask workspace and files
 * under its repo as usual.
 *
 * `repoLess`, never `!repo`: thousands of older ask sessions record no repo
 * and still sit in a real checkout, so `!repo` would empty every project band
 * into this one.
 */
export function isAskWorkspace(
  sessions: readonly Pick<UnifiedSession, "mode" | "repoLess">[],
): boolean {
  return (
    sessions.length > 0 &&
    sessions.every((session) => session.mode === "ask" && !!session.repoLess)
  );
}

export function spawnedSessionBelongsInSidebar(
  session: Pick<UnifiedSession, "spawnedBy">,
  needsAttention: boolean,
  claimed: boolean,
): boolean {
  return !session.spawnedBy || needsAttention || claimed;
}

export function sessionShipsDirectlyToMain(
  session: { repo?: string; branch?: string | null },
  directToMainBranches: Readonly<Record<string, string>>,
): boolean {
  const defaultBranch = session.repo
    ? directToMainBranches[session.repo]
    : undefined;
  return (
    !!defaultBranch && (!session.branch || session.branch === defaultBranch)
  );
}

/** Whether every real session in this row uses a shared main checkout. */
export function workspaceRowShipsDirectlyToMain(
  row: {
    sessions: readonly Pick<UnifiedSession, "repo" | "branch">[];
    workspace?: { branch?: string | null; prNumber?: number } | null;
  },
  workspaceRepo: string,
  directToMainBranches: Readonly<Record<string, string>>,
): boolean {
  const workspaceHasCodeTarget =
    !!row.workspace?.branch || row.workspace?.prNumber !== undefined;
  if (!workspaceHasCodeTarget) {
    const repoSessions = row.sessions.filter((session) => !!session.repo);
    if (
      repoSessions.length > 0 &&
      repoSessions.every((session) =>
        sessionShipsDirectlyToMain(session, directToMainBranches),
      )
    )
      return true;
  }

  return sessionShipsDirectlyToMain(
    {
      repo: workspaceRepo,
      branch:
        row.workspace?.branch ||
        row.sessions.find((session) => session.repo === workspaceRepo)?.branch,
    },
    directToMainBranches,
  );
}

/**
 * Whether a session belongs to the sidebar row that is currently open.
 *
 * The server deliberately returns the complete selected row even when a repo,
 * person, or search lens would exclude it. The frontend must preserve that
 * exception while applying its own filters or actions such as “Keep in
 * sidebar” appear to do nothing until the lens is cleared.
 */
export function sessionSharesSelectedSidebarGroup(
  session: Pick<
    UnifiedSession,
    "id" | "aliasIds" | "workspaceId" | "worktreeDir"
  >,
  selected: Pick<
    UnifiedSession,
    "id" | "aliasIds" | "workspaceId" | "worktreeDir"
  > | null,
  selectedWorkspaceId?: string | null,
): boolean {
  if (selectedWorkspaceId && session.workspaceId === selectedWorkspaceId)
    return true;
  if (!selected) return false;
  if (
    session.id === selected.id ||
    session.aliasIds?.includes(selected.id) ||
    selected.aliasIds?.includes(session.id)
  )
    return true;
  if (selected.workspaceId) return session.workspaceId === selected.workspaceId;
  return (
    !!selected.worktreeDir?.includes("/worktrees/") &&
    session.worktreeDir === selected.worktreeDir
  );
}

export interface WorkspaceSubagent {
  session: UnifiedSession;
  /** One for a direct child of workspace work, increasing for nested workers. */
  depth: number;
  /**
   * The worker shares its parent's checkout: same worktree, or no worktree of
   * its own inside the same workspace. It is disposable scaffolding of the
   * parent's run, so the sidebar tracks it (it must never become a top-level
   * row) but does not list it. A worker with a worktree or workspace of its
   * own is separate work and gets a row.
   */
  inline: boolean;
  /**
   * Every PR the worker carries belongs to the root session too. The workspace
   * row already shows that PR, so the worker row does not repeat its icon.
   */
  sharesRootPr: boolean;
}

function subagentIsInline(
  session: Pick<UnifiedSession, "workspaceId" | "worktreeDir">,
  parent: Pick<UnifiedSession, "worktreeDir">,
  root: Pick<UnifiedSession, "workspaceId">,
): boolean {
  if (session.workspaceId && session.workspaceId !== root.workspaceId)
    return false;
  if (session.worktreeDir && session.worktreeDir !== parent.worktreeDir)
    return false;
  return true;
}

function prRefsMatch(left: SessionPrRef, right: SessionPrRef): boolean {
  if (left.url && right.url && prLinksMatch(left.url, right.url)) return true;
  if (
    left.number !== undefined &&
    right.number !== undefined &&
    left.repo === right.repo &&
    left.number === right.number
  )
    return true;
  return (
    !!left.branch &&
    !!right.branch &&
    left.repo === right.repo &&
    left.branch === right.branch
  );
}

function subagentSharesRootPr(
  session: UnifiedSession,
  root: UnifiedSession,
): boolean {
  const own = sessionPrRefs(session);
  if (own.length === 0) return false;
  const rootPrs = sessionPrRefs(root);
  return own.every((pr) => rootPrs.some((rootPr) => prRefsMatch(pr, rootPr)));
}

export function sessionHasOpenPr(session: UnifiedSession): boolean {
  return sessionPrRefs(session).some((pr) => (pr.state ?? "OPEN") === "OPEN");
}

/**
 * The workspace whose sidebar row provides context for an open session.
 *
 * Workers can mint temporary workspaces of their own. Those workspaces power
 * the worker's tools and panes, but the sidebar still nests the worker beneath
 * the root session that spawned it. Follow parent edges to the highest known
 * ancestor instead of letting a worker's temporary workspace become a new
 * top-level selection.
 */
export function sidebarWorkspaceIdForSession(
  sessions: readonly Pick<
    UnifiedSession,
    "id" | "parentSessionId" | "workspaceId"
  >[],
  selected: Pick<
    UnifiedSession,
    "id" | "parentSessionId" | "workspaceId"
  > | null,
): string | null {
  if (!selected) return null;

  const byId = new Map(sessions.map((session) => [session.id, session]));
  byId.set(selected.id, selected);
  let root = selected;
  const seen = new Set([selected.id]);
  while (root.parentSessionId && !seen.has(root.parentSessionId)) {
    const parent = byId.get(root.parentSessionId);
    if (!parent) break;
    seen.add(parent.id);
    root = parent;
  }
  return root.workspaceId ?? null;
}

/**
 * Unarchived child sessions grouped under their root workspace.
 *
 * A worker can mint a temporary workspace of its own, but `parentSessionId`
 * remains the sidebar relationship. Resolve every child to its highest known
 * ancestor so finishing or merging its work cannot turn that temporary
 * workspace into a top-level row. Archiving is the explicit way to remove it.
 */
export function subagentsByWorkspace(
  sessions: readonly UnifiedSession[],
): Map<string, WorkspaceSubagent[]> {
  // The live session list should already be unique. Keeping the last copy of
  // a duplicate makes this helper defensive against an optimistic list merge
  // without ever rendering the same child twice.
  const byId = new Map<string, UnifiedSession>();
  for (const session of sessions) byId.set(session.id, session);

  const groups = new Map<string, WorkspaceSubagent[]>();
  for (const session of byId.values()) {
    if (!session.parentSessionId || session.archived) continue;

    let parentId: string | undefined = session.parentSessionId;
    let root: UnifiedSession | undefined;
    let directParent: UnifiedSession | undefined;
    let depth = 0;
    const seen = new Set([session.id]);
    while (parentId) {
      if (seen.has(parentId)) {
        root = undefined;
        break;
      }
      const parent = byId.get(parentId);
      if (!parent) {
        root = undefined;
        break;
      }
      seen.add(parent.id);
      directParent ??= parent;
      root = parent;
      depth++;
      parentId = parent.parentSessionId;
    }
    if (!root?.workspaceId || !directParent) continue;
    const items = groups.get(root.workspaceId) ?? [];
    items.push({
      session,
      depth,
      inline: subagentIsInline(session, directParent, root),
      sharesRootPr: subagentSharesRootPr(session, root),
    });
    groups.set(root.workspaceId, items);
  }

  for (const items of groups.values())
    items.sort(
      (a, b) =>
        (a.session.createdAt || "").localeCompare(b.session.createdAt || "") ||
        a.session.id.localeCompare(b.session.id),
    );
  return groups;
}

/** Unarchived children owned by one workspace row. */
export function subagentsForWorkspace(
  sessions: readonly UnifiedSession[],
  workspaceId: string | null | undefined,
): WorkspaceSubagent[] {
  if (!workspaceId) return [];
  return subagentsByWorkspace(sessions).get(workspaceId) ?? [];
}

/**
 * Child rows to draw beneath the workspace that is currently selected: only
 * workers with a worktree or workspace of their own. Inline workers stay in
 * the group (so they never surface as top-level rows) but are not listed.
 */
export function subagentsForSelectedWorkspace(
  groups: ReadonlyMap<string, WorkspaceSubagent[]>,
  workspaceId: string | null | undefined,
  selectedWorkspaceId: string | null | undefined,
): WorkspaceSubagent[] {
  if (!workspaceId || workspaceId !== selectedWorkspaceId) return [];
  return (groups.get(workspaceId) ?? []).filter((item) => !item.inline);
}

/** The root session a workspace row should open, never one of its subagents. */
export function workspaceMainSession(row: {
  sessions: readonly UnifiedSession[];
}): UnifiedSession | null {
  if (row.sessions.length === 0) return null;
  const rowSessionIds = new Set(row.sessions.map((session) => session.id));
  return (
    row.sessions.find(
      (session) =>
        !session.parentSessionId || !rowSessionIds.has(session.parentSessionId),
    ) ?? row.sessions[0]
  );
}

/**
 * Which workspace row a selected session belongs to. Usually the row that
 * lists it, but a session the sidebar deliberately keeps out of the rows — an
 * automation run, an unclaimed spawned worker — still belongs to its
 * workspace, so opening one keeps that workspace selected instead of leaving
 * the sidebar with nothing lit up. Falls back to the shared worktree for the
 * runs that carry no workspace.
 */
export function workspaceRowOwnsSession(
  row: {
    key: string;
    workspace: Pick<Workspace, "id"> | null;
    sessions: readonly Pick<UnifiedSession, "id">[];
  },
  selected: Pick<UnifiedSession, "id" | "workspaceId" | "worktreeDir"> | null,
): boolean {
  if (!selected) return false;
  if (row.sessions.some((session) => session.id === selected.id)) return true;
  if (selected.workspaceId) return row.workspace?.id === selected.workspaceId;
  return !!selected.worktreeDir && row.key === `wt:${selected.worktreeDir}`;
}

/** A workspace route can be selected before its first session exists. */
export function workspaceRowOwnsSelection(
  row: Parameters<typeof workspaceRowOwnsSession>[0],
  selectedSession: Parameters<typeof workspaceRowOwnsSession>[1],
  selectedWorkspaceId: string | null,
): boolean {
  return (
    (!!selectedWorkspaceId && row.workspace?.id === selectedWorkspaceId) ||
    workspaceRowOwnsSession(row, selectedSession)
  );
}
