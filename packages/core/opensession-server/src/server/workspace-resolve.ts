/**
 * Shared PR/ticket → Workspace resolution (adopt-don't-duplicate).
 *
 * A PR or Plain support ticket always resolves to exactly ONE workspace, but a
 * workspace can carry MANY PRs (one session can open several: primary branch +
 * attached repos + linked PRs) — so resolution never relies on the `ghpr-` /
 * `plain-` dedupe key alone: it also matches member sessions' PR refs and
 * worktree ownership before minting anything. The key marks provenance of
 * workspaces minted session-less from a PR/ticket (and hides them from the
 * Workspaces band until they gain a session); an adopted user workspace is
 * key-stamped only if it has no key yet.
 *
 * Used by the HTTP resolve endpoint (routes/workspace.ts), create_session /
 * automation session filing, and the github agent's per-PR grouping (run.ts)
 * so the UI and agents can never mint diverging workspaces for the same PR.
 */
import {
  createWorkspace,
  findWorkspaceByKey,
  getWorkspace,
  stampWorkspaceIdentity,
  updateWorkspace,
  type Workspace,
} from "./workspaces";
import { getCachedSessions, updateSessionFile } from "./session-cache";
import { getOpenPrs, getRecentPrs } from "./sessions";
import { workspaceOwningWorktree } from "./session-repos";
import { getRepo, listWorktrees } from "./worktree";
import { prKey } from "../agents/github/constants";
import type { ExternalRef, UnifiedSession } from "./types";
import { isNativeSessionId } from "./paths";

/** Does this session carry the PR (primary branch, attached repo, or link)? */
function sessionMatchesPr(
  s: UnifiedSession,
  repoId: string,
  branch: string,
  number?: number,
): boolean {
  if ((s.repo || getRepo().id) === repoId && !!s.branch && s.branch === branch)
    return true;
  const refMatch = (r: { repo: string; branch?: string; number?: number }) =>
    r.repo === repoId &&
    (r.branch === branch || (number !== undefined && r.number === number));
  return (
    (s.prs || []).some(refMatch) ||
    (s.attachedRepos || []).some(
      (r) => r.repo === repoId && r.branch === branch,
    ) ||
    (s.linkedPrs || []).some(refMatch)
  );
}

/** Newest-first by createdAt (resolution prefers the most recent linkage). */
function newestFirst(sessions: UnifiedSession[]): UnifiedSession[] {
  return [...sessions].sort(
    (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0),
  );
}

function prWorkspaceName(
  number: number | undefined,
  branch: string | undefined,
  title: string | undefined,
): string {
  return number !== undefined
    ? `#${number} ${(title || "").trim()}`.trim().slice(0, 120)
    : `PR ${branch}`.slice(0, 120);
}

/** Upgrade only the exact placeholder minted when PR metadata was incomplete.
 * A person may rename any other PR workspace, and later resolves must preserve it. */
function repairPrWorkspaceName(
  workspace: Workspace,
  number: number | undefined,
  branch: string | undefined,
  title: string | undefined,
): Workspace {
  if (!title?.trim()) return workspace;
  const placeholders = [
    number !== undefined ? `#${number}` : null,
    branch ? `PR ${branch}`.slice(0, 120) : null,
  ];
  if (!placeholders.includes(workspace.name)) return workspace;
  return (
    updateWorkspace(workspace.id, {
      name: prWorkspaceName(number, branch, title),
    }) || workspace
  );
}

/**
 * Backfill `workspaceId` onto matching sessions that aren't filed under any
 * workspace yet (serialized field-scoped writes — a concurrent filing wins;
 * see the transcript-v2 §6 note in session-cache). Best-effort, never throws.
 */
function adoptSiblingSessions(
  workspaceId: string,
  predicate: (s: UnifiedSession) => boolean,
): void {
  for (const s of getCachedSessions()) {
    if (!isNativeSessionId(s.id) || s.workspaceId || s.archived) continue;
    if (!predicate(s)) continue;
    void updateSessionFile(s.id, (data) =>
      data.workspaceId ? data : { ...data, workspaceId },
    ).catch(() => {});
  }
}

/** Serialize concurrent resolves for the same target (double-click guard). */
const inflight = new Map<string, Promise<unknown>>();
async function serialized<T>(
  lockKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = inflight.get(lockKey) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  inflight.set(lockKey, tail);
  try {
    return await run;
  } finally {
    if (inflight.get(lockKey) === tail) inflight.delete(lockKey);
  }
}

export interface ResolvedWorkspace {
  workspace: Workspace;
  created: boolean;
  /**
   * The PR this resolve was about, normalized against the PR caches (a caller
   * with only a number gets the branch back, and the other way round). A
   * workspace carries many PRs, so the caller has to be told WHICH one it
   * asked for to open the review on it: the workspace record's own
   * branch/prNumber is the first PR filed here, not the one just clicked.
   */
  pr?: { repo: string; number?: number; branch?: string };
}

/**
 * A session-less PR workspace still belongs in the active workspace payload
 * while its PR is open. The sidebar resolves a bare PR row before navigating;
 * without this exception the active-only workspace fetch immediately hid the
 * new record and the destination rendered “Workspace not found.”
 */
export function workspaceBacksOpenPr(
  workspace: Pick<Workspace, "repo" | "prNumber" | "branch">,
  openPrs: Array<{ repo: string; number: number; branch: string }>,
  defaultRepoId: string,
): boolean {
  if (workspace.prNumber === undefined && !workspace.branch) return false;
  const repo = workspace.repo || defaultRepoId;
  return openPrs.some(
    (pr) =>
      pr.repo === repo &&
      (workspace.prNumber !== undefined
        ? pr.number === workspace.prNumber
        : pr.branch === workspace.branch),
  );
}

/**
 * Resolve the one workspace for a PR. Lookup order (adopt before create):
 * dedupe key → newest PR-matching session's workspace → worktree owner →
 * mint a session-less `ghpr-` workspace. Returns null when the PR can't be
 * normalized (unknown to the PR cache and the caller gave no branch).
 */
export async function resolvePrWorkspace(input: {
  repoId: string;
  number?: number;
  branch?: string;
  title?: string;
  createdBy: string;
}): Promise<ResolvedWorkspace | null> {
  const repoId = getRepo(input.repoId).id;
  return serialized(
    `pr:${repoId}:${input.number ?? ""}:${input.branch ?? ""}`,
    async () => {
      // Normalize number+branch+title from the PR caches when incomplete.
      let { number, branch, title } = input;
      if (number === undefined || !branch) {
        const match = (p: { repo: string; number: number; branch: string }) =>
          p.repo === repoId &&
          (number !== undefined ? p.number === number : p.branch === branch);
        const pr = getOpenPrs().find(match) || getRecentPrs().find(match);
        if (pr) {
          number = pr.number;
          branch = pr.branch;
          title = title || pr.title;
        }
      }
      if (number === undefined && !branch) return null;

      // Handed back to the caller so it can open the review on THIS PR rather
      // than on whichever one the workspace was minted from.
      const pr = {
        repo: repoId,
        ...(number !== undefined ? { number } : {}),
        ...(branch ? { branch } : {}),
      };

      const key =
        number !== undefined
          ? `ghpr-${prKey(number, getRepo(repoId).ghRepo)}`
          : null;
      const stamp = {
        ...(key ? { key } : {}),
        ...(number !== undefined ? { prNumber: number } : {}),
        ...(branch ? { branch } : {}),
        // The PR's repo travels with its branch. A workspace minted by a session
        // in another repo (cross-repo work through an attached repo) keeps that
        // session's repo otherwise, and the pair then describes a branch that
        // does not exist where it says it does.
        repo: repoId,
      };
      const matches = (s: UnifiedSession) =>
        !!branch && sessionMatchesPr(s, repoId, branch, number);

      // 1. Provenance key (workspaces minted from this PR before).
      const byKey = key ? findWorkspaceByKey(key) : null;
      if (byKey) {
        const stamped = stampWorkspaceIdentity(byKey.id, stamp) || byKey;
        const named = repairPrWorkspaceName(stamped, number, branch, title);
        adoptSiblingSessions(named.id, matches);
        return { workspace: named, created: false, pr };
      }

      // 2. A session already carrying this PR that's filed under a workspace.
      if (branch) {
        for (const s of newestFirst(
          getCachedSessions().filter((x) => !x.archived),
        )) {
          if (!s.workspaceId || !matches(s)) continue;
          const ws = getWorkspace(s.workspaceId);
          if (!ws) continue;
          const stamped = stampWorkspaceIdentity(ws.id, stamp) || ws;
          adoptSiblingSessions(stamped.id, matches);
          return { workspace: stamped, created: false, pr };
        }
        // 3. A workspace owning the PR head branch's worktree.
        const wt = (await listWorktrees(repoId)).find(
          (w) => w.branch === branch,
        );
        const owner = wt ? workspaceOwningWorktree(wt.path) : null;
        if (owner) {
          const stamped = stampWorkspaceIdentity(owner.id, stamp) || owner;
          adoptSiblingSessions(stamped.id, matches);
          return { workspace: stamped, created: false, pr };
        }
      }

      // 4. Mint a session-less PR workspace (no worktreeDir — the first session
      // materializes it via the create_session fromPr path).
      const workspace = createWorkspace({
        name: prWorkspaceName(number, branch, title),
        repo: repoId,
        createdBy: input.createdBy,
        ...(key ? { key } : {}),
        ...(number !== undefined ? { prNumber: number } : {}),
        ...(branch ? { branch } : {}),
      });
      adoptSiblingSessions(workspace.id, matches);
      return { workspace, created: true, pr };
    },
  );
}

/**
 * Resolve the one workspace for a Plain support thread. No Plain API
 * round-trip — the title comes from the clicked sidebar row / automation
 * event. Synchronous so automation filing can use it inline.
 */
export function resolvePlainWorkspace(input: {
  threadId: string;
  title?: string;
  createdBy: string;
}): ResolvedWorkspace {
  const { threadId } = input;
  const key = `plain-${threadId}`;
  const matches = (s: UnifiedSession) => s.plainThreadId === threadId;

  const byKey = findWorkspaceByKey(key);
  if (byKey) {
    adoptSiblingSessions(byKey.id, matches);
    return { workspace: byKey, created: false };
  }

  // A session already triaging this thread that's filed under a workspace
  // (prefer live sessions, newest first — matches resolvePlainTriageSession).
  const all = getCachedSessions().filter(matches);
  for (const s of newestFirst([
    ...all.filter((x) => !x.archived),
    ...all.filter((x) => x.archived),
  ])) {
    if (!s.workspaceId) continue;
    const ws = getWorkspace(s.workspaceId);
    if (!ws) continue;
    const stamped =
      stampWorkspaceIdentity(ws.id, { key, plainThreadId: threadId }) || ws;
    adoptSiblingSessions(stamped.id, matches);
    return { workspace: stamped, created: false };
  }

  const workspace = createWorkspace({
    name: (input.title || "").trim().slice(0, 120) || "Support ticket",
    repo: getRepo().id,
    createdBy: input.createdBy,
    key,
    plainThreadId: threadId,
  });
  adoptSiblingSessions(workspace.id, matches);
  return { workspace, created: true };
}

/**
 * Resolve the one workspace for a generic feed item (a video, …) by its
 * ExternalRef. The generic sibling of resolvePlainWorkspace: dedupe key
 * `<kind>-<id>`, adopt a filed session already carrying the ref, else mint a
 * session-less workspace stamped with the ref (the feeds design).
 */
export function resolveExternalWorkspace(input: {
  ref: ExternalRef;
  createdBy: string;
}): ResolvedWorkspace {
  const { ref } = input;
  const key = `${ref.kind}-${ref.id}`;
  const matches = (s: UnifiedSession) =>
    (s.externalRefs || []).some((r) => r.kind === ref.kind && r.id === ref.id);

  const byKey = findWorkspaceByKey(key);
  if (byKey) {
    adoptSiblingSessions(byKey.id, matches);
    return { workspace: byKey, created: false };
  }

  const all = getCachedSessions().filter(matches);
  for (const s of newestFirst([
    ...all.filter((x) => !x.archived),
    ...all.filter((x) => x.archived),
  ])) {
    if (!s.workspaceId) continue;
    const ws = getWorkspace(s.workspaceId);
    if (!ws) continue;
    const stamped =
      stampWorkspaceIdentity(ws.id, { key, externalRef: ref }) || ws;
    adoptSiblingSessions(stamped.id, matches);
    return { workspace: stamped, created: false };
  }

  // Deliberately repo-less: feed-item workspaces start their sessions in
  // scratch mode (repo-less scratch dir), not in a repo checkout.
  const workspace = createWorkspace({
    name: (ref.title || "").trim().slice(0, 120) || `${ref.kind} ${ref.id}`,
    createdBy: input.createdBy,
    key,
    externalRefs: [ref],
  });
  adoptSiblingSessions(workspace.id, matches);
  return { workspace, created: true };
}
