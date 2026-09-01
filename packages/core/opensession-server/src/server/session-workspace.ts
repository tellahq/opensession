/**
 * The "every session lives in exactly one workspace" invariant.
 *
 * Workspaces (workspaces.ts) are what the sidebar's main list renders. A session
 * carrying no `workspaceId` used to fall through to a *synthesized* row — grouped
 * by shared worktree, else one row per session — so the sidebar had to model two
 * kinds of row forever. Instead, every session that surfaces without a workspace
 * is filed into one here, at the single choke point where the unified session
 * list is assembled (`getAllSessions`).
 *
 * Why the read choke point rather than each creation path: sessions arrive from
 * five of them (UI create, spawned children, the Slack loop, the Linear loop,
 * un-archiving), and two write their session files without this server ever
 * seeing the create. Enforcing it where every session is read means no path can
 * regress the invariant — including ones added later. The creation paths that
 * *can* mint still do (ws-handlers, session-control-wiring): they know the
 * better name and can hook it up to the generated-title rename.
 *
 * The assignment is applied in-memory on the same scan and persisted right
 * after, so a brand-new session never spends a poll interval row-less.
 *
 * Grouping fidelity: sessions sharing an ISOLATED worktree land in ONE workspace —
 * the same rule the sidebar used to group its `wt:` rows, so no row fragments
 * when this lands. Sessions on the same non-default BRANCH of a repo also land
 * in one workspace even across different worktrees (workspaceForBranch below) —
 * the Slack loop and PR automations run one branch in separate worktrees, and
 * worktree grouping alone split them into parallel workspaces. A shared
 * checkout (a repo's live main checkout or its pinned ask checkout) is owned
 * by nobody: every session there gets its own workspace.
 *
 * Automation runs are the deliberate exception. They live in the Automations
 * band, not the Workspaces list, and minting a workspace for each of the ~1100
 * live runs would bury every real one in the pickers. A run gets a workspace
 * only when something files it into one (automations.ts ticket filing), and a
 * *claimed* run is the one case the sidebar still renders without a workspace.
 *
 * Desk sessions (desk.ts) are the second exception, for the same reason: the
 * Desk is summoned as an overlay, never listed. Filing it minted a workspace
 * named "Desk" per user — invisible on its own (the sidebar skips desk
 * sessions), but the workers the Desk spawns inherited that workspace id and
 * resurrected the row, so the Desk surfaced in the Workspaces list wearing its
 * own delegated work. A Desk session stays workspace-less for life; its
 * children each get their own (session-control-wiring.ts).
 */

import {
  createWorkspace,
  findWorkspaceByBranch,
  findWorkspaceByWorktree,
  getWorkspace,
  updateWorkspace,
  workspaceName,
  type Workspace,
} from "./workspaces";
import { getRepo, isSharedCheckoutDir } from "./worktree";
import type { UnifiedSession } from "./types";

/**
 * Assignments whose file write hasn't landed yet. The persist is async and the
 * session scan re-runs every couple of seconds, so without this a session would
 * be minted a second (and third) workspace before its first one hit disk. Parked
 * on globalThis so a hot reload doesn't lose the in-flight assignments.
 */
const pending: Map<string, string> = ((
  globalThis as unknown as {
    __ocPendingSessionWorkspaces?: Map<string, string>;
  }
).__ocPendingSessionWorkspaces ??= new Map());

/**
 * The worktree this session *owns*, or null. Shared checkouts don't count —
 * ownership is meaningless there (see isSharedCheckoutDir / findWorkspaceByWorktree).
 */
export function ownedWorktree(dir: string | null | undefined): string | null {
  return dir && !isSharedCheckoutDir(dir) ? dir : null;
}

/**
 * The workspace already working this session's repo + branch, or null. This is
 * what unites sessions that share a BRANCH but not a worktree: the Slack loop,
 * the github agent's review/autofix runs, and UI sessions each get their own
 * worktree for the same branch, so worktree adoption alone minted a parallel
 * "work-on-a" workspace next to the PR's — and the PR workspace's tab strip
 * never showed the slack session (2026-08-07). Only sessions that OWN a
 * worktree qualify: shared-checkout sessions all carry the checkout's branch
 * and deliberately get one workspace each. Default branches never match —
 * legacy sessions carry pre-rename branch/repo names getRepo can't resolve,
 * so unresolvable repos are skipped rather than guessed at.
 */
function workspaceForBranch(session: UnifiedSession): Workspace | null {
  if (!session.branch || !ownedWorktree(session.worktreeDir)) return null;
  try {
    const repo = getRepo(session.repo || undefined);
    if (session.branch === repo.defaultBranch) return null;
    return findWorkspaceByBranch(repo.id, session.branch);
  } catch {
    return null;
  }
}

/**
 * Name a workspace minted around existing sessions, mirroring the names the
 * sidebar used to synthesize: a manual rename wins (explicit user intent),
 * then the shared branch for a worktree group, then the session's own title.
 */
function nameFor(sessions: UnifiedSession[], grouped: boolean): string {
  const renamed = sessions.find((c) => c.titleOverridden);
  const name = grouped
    ? renamed?.title || sessions[0].branch || sessions[0].title
    : renamed?.title || sessions[0].title || sessions[0].branch;
  return (name || "Session").slice(0, 120);
}

/**
 * How many provisional names to settle per scan. Each one is a read plus a
 * write, and every workspace minted before this landed needs one (766 of the
 * 4,886 on disk, 2026-08-17), so the back-fill drains over a few polls rather
 * than in one long scan. New ones arrive at most one per created session.
 */
const NAME_BUDGET = 40;

/**
 * Settle a workspace still wearing the name it was minted with before its
 * session had a real title.
 *
 * `nameFor`'s last resort is the session's `branch`, which for a Slack thread
 * session is not a branch at all: it is the raw `<channel>-<threadTs>` key the
 * session is keyed by. The Slack loop generates the proper title a second or
 * two later (handlers.ts), by which time this workspace has already been
 * minted at the read choke point — and that path only ever renamed the
 * SESSION, so the workspace kept the key for life and the sidebar, the tab
 * strip, the pickers and Slack's own unfurls all showed it.
 *
 * So the name follows the session's title until the title lands. The trigger
 * is the workspace still being named after that raw key, which stops being
 * true the moment either this or a person renames it — so it fires exactly
 * once per workspace and a manual rename is never overwritten. A workspace
 * named after a real git branch is untouched: the key is `<source>-<name>`
 * matched against the session's own id, which no branch name can spell.
 */
export function settleProvisionalNames(sessions: UnifiedSession[]): void {
  let budget = NAME_BUDGET;
  for (const session of sessions) {
    if (budget <= 0) return;
    if (!session.workspaceId || !session.title) continue;
    const name = workspaceName(session.workspaceId);
    // The one name that can only have come from the fallback: this session's
    // own key. A titleless session's title IS that key too (scanSlackSessions
    // falls back to `branch` as well), so it reads as "no better name yet".
    if (!name || session.id !== `${session.source}-${name}`) continue;
    if (session.title === name) continue;
    budget--;
    try {
      updateWorkspace(session.workspaceId, { name: session.title });
    } catch (e) {
      console.error(
        `[session-workspace] failed to name ${session.workspaceId}:`,
        e,
      );
    }
  }
}

/** Persist the session → workspace link (create-if-absent; a concurrent filing wins). */
function persist(sessionId: string, workspaceId: string): void {
  // Lazy import: session-cache imports sessions.ts, which imports this module.
  // Deliberately NOT touchNativeSession — that bumps lastActivity, which
  // would shoot every back-filled session to the top of the sidebar.
  void import("./session-cache")
    .then(({ updateSessionFile }) =>
      updateSessionFile(sessionId, (data) =>
        data.workspaceId ? data : { ...data, workspaceId },
      ),
    )
    .catch(() => {});
}

/**
 * File every workspace-less session into a workspace, minting one where needed.
 * Mutates `sessions` in place (the caller's freshly assembled list) and writes
 * the link through best-effort — never throws, never blocks the scan.
 */
export function ensureSessionWorkspaces(sessions: UnifiedSession[]): void {
  // Never file from a test process: bun test runs every suite in ONE process,
  // so a fixture session listed by any test would get filed through whatever
  // dirs the module snapshots captured — for years of full-suite runs that
  // minted fixture workspaces ("Review cache test", demo sessions, …) into
  // the operator's LIVE ~/.opensession-workspaces (observed 2026-08-04). Same
  // guard shape as run-rpc.ts's test gate; prod never runs NODE_ENV=test.
  if (process.env.NODE_ENV === "test" || /\.test\.tsx?$/.test(Bun.main || ""))
    return;
  // A workspace already filed may still be wearing the name it was minted
  // with before its session had a title. Runs whether or not anything needs
  // filing this scan.
  settleProvisionalNames(sessions);
  // Archived sessions don't render, so they don't need one until they come back:
  // the same sweep files them on the scan right after an un-archive.
  const orphans = sessions.filter(
    (s) => !s.workspaceId && !s.archived && !s.automation && !s.desk,
  );
  if (orphans.length === 0) return;

  const fresh: UnifiedSession[] = [];
  for (const session of orphans) {
    const inflight = pending.get(session.id);
    // Drop a stale entry if the workspace was deleted out from under us, so the
    // session gets a new one instead of pointing at nothing.
    if (inflight && getWorkspace(inflight)) session.workspaceId = inflight;
    else {
      if (inflight) pending.delete(session.id);
      fresh.push(session);
    }
  }
  if (fresh.length === 0) return;

  // One workspace per owned worktree; every other session is its own workspace.
  const groups = new Map<string, UnifiedSession[]>();
  for (const session of fresh) {
    const dir = ownedWorktree(session.worktreeDir);
    const key = dir ? `wt:${dir}` : `session:${session.id}`;
    const list = groups.get(key);
    if (list) list.push(session);
    else groups.set(key, [session]);
  }

  for (const [key, group] of groups) {
    const dir = key.startsWith("wt:") ? key.slice(3) : null;
    group.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
    try {
      // Adopt the workspace that already owns this worktree — then the one
      // already working this branch — before minting a second one over it
      // (a sibling session may be filed there already).
      const workspace =
        (dir ? findWorkspaceByWorktree(dir) : null) ??
        workspaceForBranch(group[0]) ??
        createWorkspace({
          name: nameFor(group, !!dir),
          repo: group[0].repo,
          createdBy: group[0].startedBy || "Anonymous",
          createdAt: group[0].createdAt,
          ...(group[0].branch ? { branch: group[0].branch } : {}),
          ...(dir ? { worktreeDir: dir } : {}),
        });
      for (const session of group) {
        session.workspaceId = workspace.id;
        pending.set(session.id, workspace.id);
        persist(session.id, workspace.id);
      }
    } catch (e) {
      // A session with no workspace is still better than a failed scan.
      console.error(`[session-workspace] failed to file ${group[0]?.id}:`, e);
    }
  }
}
