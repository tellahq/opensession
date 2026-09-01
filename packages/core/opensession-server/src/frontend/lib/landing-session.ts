import type { Workspace, UnifiedSession } from "./types";

/**
 * The Review pane a session surface should foreground by default. PR-backed
 * workspaces used to always land on Review; now the main session leads whenever
 * the workspace has one — Review is the default surface only for session-less
 * PR workspaces (a bare sidebar PR row with no sessions yet).
 */
export function defaultSessionWorkspaceView(
  workspace: Pick<Workspace, "key" | "prNumber"> | null | undefined,
  reviewDismissed: boolean,
  hasLiveSession: boolean,
): "review" | null {
  const prBacked =
    workspace?.prNumber !== undefined || workspace?.key?.startsWith("ghpr-");
  return prBacked && !reviewDismissed && !hasLiveSession ? "review" : null;
}

/**
 * A bare workspace route decides whether it has a session exactly once. Wait
 * for both lists before making that decision: workspaces commonly arrive first,
 * and treating an unfinished session list as empty strands a real workspace on
 * WorkspacePane's session-less Review shell instead of its SessionViewer.
 */
export function workspaceLandingReady(
  workspacesLoaded: boolean,
  sessionsLoading: boolean,
): boolean {
  return workspacesLoaded && !sessionsLoading;
}

/**
 * True for an untouched "New session" shell: never ran a turn (no engine session
 * on any provider), nothing running or queued, and no activity since
 * creation. These rows are minted eagerly by the new-session endpoints so a tab
 * can render instantly; when abandoned they linger as empty shells.
 *
 * `ran` rather than the engine ids: the list carries the answer and not the
 * ids, and an optimistic row this client mints for a just-created tab has
 * neither, which is correct — it hasn't run.
 */
export function sessionNeverRan(s: UnifiedSession): boolean {
  return (
    !s.duplicatedFromSessionId &&
    !s.ran &&
    !s.isRunning &&
    !(s.queuedCount && s.queuedCount > 0) &&
    s.lastActivity === s.createdAt
  );
}

/**
 * A session minted by the PR machinery (review/auto-fix/simplify/… runs) rather
 * than by a person: it supports the workspace's main line of work but is never
 * the conversation that started it.
 */
export function isAutomationSession(s: UnifiedSession): boolean {
  return !!s.automation || s.id.startsWith("bks-ghpr-");
}

/**
 * The workspace's MAIN session from a createdAt-ascending list of its live sessions:
 * the oldest human conversation that actually ran — the session that started
 * the whole thing — with automation sessions (PR review/auto-fix runs) and
 * abandoned never-run shells passed over. Falls back gracefully when the
 * workspace only has automation sessions or shells.
 */
export function mainSession(
  liveOldestFirst: UnifiedSession[],
): UnifiedSession | undefined {
  return (
    liveOldestFirst.find(
      (s) => !isAutomationSession(s) && !sessionNeverRan(s),
    ) ??
    liveOldestFirst.find((s) => !sessionNeverRan(s)) ??
    liveOldestFirst[0]
  );
}

/**
 * The session whose workspace settings seed a new sibling tab. A workspace can
 * have only a Review pane after its last session was closed, so its newest
 * archived session remains a valid source instead of forcing the global composer.
 */
export function newSessionSource(
  current: UnifiedSession | null | undefined,
  liveOldestFirst: UnifiedSession[],
  archivedNewestFirst: UnifiedSession[],
): UnifiedSession | undefined {
  return current ?? mainSession(liveOldestFirst) ?? archivedNewestFirst[0];
}

/**
 * Local-only session shape that lets a Review-only workspace paint its blank
 * tab while the archived source needed by the create endpoint is still loading.
 */
export function workspaceSessionSeed(
  workspace: Workspace,
  startedBy: string,
): UnifiedSession {
  return {
    id: `workspace:${workspace.id}`,
    source: "opensession",
    branch: workspace.branch ?? null,
    worktreeDir: workspace.worktreeDir ?? null,
    startedBy,
    title: "New session",
    lastActivity: workspace.createdAt,
    createdAt: workspace.createdAt,
    isRunning: false,
    workspaceId: workspace.id,
    repo: workspace.repo,
    mode: workspace.repo || workspace.worktreeDir ? "code" : "scratch",
  };
}

/**
 * Keep the workspace's main session at the leading edge while preserving the
 * user's saved order for every sibling session.
 */
export function pinMainSessionFirst(
  liveOldestFirst: UnifiedSession[],
  orderedIds: string[],
): string[] {
  const mainId = mainSession(liveOldestFirst)?.id;
  if (!mainId || !orderedIds.includes(mainId)) return orderedIds;
  return [mainId, ...orderedIds.filter((id) => id !== mainId)];
}

/**
 * The session a workspace surface should land on when navigated without an
 * explicit session id. Prefers the workspace's main session (oldest human
 * conversation that ran — see mainSession); when every live session is an abandoned
 * never-run shell — the real conversations were archived for staleness while
 * an empty "New session" kept the workspace looking alive — falls back to the
 * newest archived conversation so the workspace's history stays reachable. A
 * never-run shell only wins when the workspace has no conversation with
 * content anywhere.
 *
 * `preferredId` — the session last open in this workspace (workspace-last-session.ts)
 * — wins outright while it's still a live session here, so returning to a
 * workspace lands on the tab it was left on.
 */
export function pickLandingSession(
  all: UnifiedSession[],
  workspaceId: string,
  preferredId?: string,
): UnifiedSession | undefined {
  const live = all
    .filter((s) => !s.archived && s.workspaceId === workspaceId)
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  const preferred = preferredId
    ? live.find((s) => s.id === preferredId)
    : undefined;
  if (preferred) return preferred;
  const main = mainSession(live);
  if (main && !sessionNeverRan(main)) return main;
  const archived = all
    .filter(
      (s) => s.archived && s.workspaceId === workspaceId && !sessionNeverRan(s),
    )
    .sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""));
  return archived[0] ?? live[0];
}
