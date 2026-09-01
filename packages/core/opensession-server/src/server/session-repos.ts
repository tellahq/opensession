/**
 * Session ↔ repo derivations: which repos a session spans, the per-run
 * system-prompt notes built from that (branch discipline, multi-repo map,
 * memory), PR-target resolution, and the attach/switch-primary repo
 * operations behind the RepoBar + opensession-repos tools.
 */

import {
  createWorktree,
  canonicalPath,
  getRepo,
  listWorktrees,
  prepareAttachedWorktree,
  repoForPath,
  REPOS,
  sessionRepoId,
  sharedCheckoutForNewSessions,
  worktreeHasWork,
} from "./worktree";
import { hasRemoteWorkspace } from "./sandbox";
import type { WorkspaceExecSession } from "./sandbox/workspace-exec";
import { existsSync } from "fs";
import {
  findWorkspaceByWorktree,
  getWorkspace,
  restampWorkspaceWorktree,
  type Workspace,
} from "./workspaces";
import { sessionPrBranch } from "./session-pr-target";
import {
  renderSessionMemoryNote,
  snapshotMemoryNote,
  sessionMemoryScopes,
} from "./session-memory";
import {
  memoryRolloutMode,
  renderAmbientMemoryForPrompt,
  retrieveMemoryForPrompt,
} from "./memory-v2";
import { DESK_NOTE } from "./desk";
import { deskBriefingFor } from "./desk-state";
import { personalOutputStyleNoteFor } from "./personal-output-style";
import { personalPromptNoteFor } from "./personal-prompts";
import { PSTACK_MODE_NOTE } from "./pstack-mode";
import {
  findSession,
  getCachedSessions,
  touchNativeSession,
  updateSessionFile,
} from "./session-cache";
import type {
  AttachedRepo,
  LinkedPr,
  StackedOn,
  UnifiedSession,
} from "./types";
import { defaultRepo } from "./config";
import { hostRepoId } from "./pr-host";

export interface SessionRepoContext {
  repo: string;
  dir: string;
  branch?: string;
  primary: boolean;
}

type SessionRepoCarrier = Pick<
  UnifiedSession,
  "repo" | "worktreeDir" | "branch" | "attachedRepos" | "mode"
>;

/**
 * Resolve a repo worktree carried by a session.
 *
 * Child sessions and workflow agents used to inherit only `worktreeDir`, which
 * is the primary repo. That made an attached-repo review start in the primary
 * checkout and then hit ask-mode's external-directory deny when its prompt
 * referenced the attached worktree. An explicit repo wins; otherwise a prompt
 * that names exactly one carried worktree selects it; ambiguous/no hint keeps
 * the primary for backwards compatibility.
 */
export function resolveSessionRepoContext(
  session: SessionRepoCarrier,
  repoId?: string,
  hint?: string,
): SessionRepoContext | null {
  const primaryRepo = sessionRepoId(session) ?? defaultRepo().id;
  const contexts: SessionRepoContext[] = [
    ...(session.worktreeDir
      ? [
          {
            repo: primaryRepo,
            dir: session.worktreeDir,
            ...(session.branch ? { branch: session.branch } : {}),
            primary: true,
          },
        ]
      : []),
    ...(session.attachedRepos || []).map((attached) => ({
      repo: attached.repo,
      dir: attached.dir,
      branch: attached.branch,
      primary: false,
    })),
  ];

  if (repoId)
    return contexts.find((context) => context.repo === repoId) || null;

  if (hint) {
    const mentioned = contexts.filter(
      (context) =>
        hint.includes(context.dir) || hint.includes(`@${context.repo}:`),
    );
    if (mentioned.length === 1) return mentioned[0];
  }

  return contexts.find((context) => context.primary) || null;
}

/**
 * Branch discipline for interactive code sessions in isolated worktrees. Sessions
 * in one workspace share a single worktree + branch, so each agent must treat
 * that branch as THE branch — sibling commits included. Without this, each
 * sibling session decided the extra commits on the shared branch weren't its own
 * and cherry-picked onto a fresh branch, producing one PR per session instead of
 * one per workspace.
 */
export function buildBranchNote(session: {
  mode?: "ask" | "code" | "scratch";
  branch?: string | null;
  worktreeDir?: string | null;
}): string | undefined {
  if (session.mode === "ask" || !session.branch || !session.worktreeDir)
    return undefined;
  const repo = repoForPath(session.worktreeDir);
  // Shared-checkout repos (opensession) and main-checkout cwds have their own
  // rules; this note is for isolated per-branch worktrees only.
  if (
    sharedCheckoutForNewSessions(repo) ||
    canonicalPath(session.worktreeDir) === canonicalPath(repo.repo)
  )
    return undefined;
  return [
    "## Branch discipline (shared worktree)",
    `You are working in \`${session.worktreeDir}\` on branch \`${session.branch}\`. Other sessions in this workspace share this exact worktree and branch — commits you don't recognize are their work, not noise.`,
    `Stay on \`${session.branch}\`: never create or switch branches, and never rebase away, reset, or cherry-pick around sibling commits. Commit your changes on this branch and push with \`git push -u origin ${session.branch}\`.`,
    repo.host === "codestorage"
      ? `Commit and push your branch with \`git push -u origin ${session.branch}\` — this repo is hosted on Code Storage; there is no gh CLI and no pull requests; a pushed branch IS the change request. Never merge it into the default branch yourself.`
      : `This workspace keeps ONE pull request: if an open PR for \`${session.branch}\` already exists, pushing updates it — do not open another. Only run \`gh pr create\` when the branch has no open PR. For an ordinary (non-stacked) PR, you may merge it yourself once the latest Open Session review covers the current head, reports no blocking findings, marks it safe to merge, and all required checks have passed. Do not merge while the review is stale, pending, or unsatisfied, or while required checks are pending or failing.`,
    repo.host === "codestorage"
      ? "Only deviate from this (a separate branch) when the user explicitly asks for it."
      : "Only deviate from this (separate branch or separate PR) when the user explicitly asks for it.",
  ].join("\n");
}

/**
 * System-prompt note for a session whose worktree was branched off ANOTHER session's
 * branch rather than the trunk (the "stacked worktree" session mode). Its diff is
 * only reviewable against that branch, so its PR must target it — and GitHub's
 * stacked PRs (public preview, 2026-07-30) then give the pair a real stack:
 * each layer reviewed on its own diff, lower layers rebased automatically as
 * they merge. See pr-stack.ts for the read/link surface behind the UI.
 */
export function buildStackNote(session: {
  mode?: "ask" | "code" | "scratch";
  branch?: string | null;
  worktreeDir?: string | null;
  stackedOn?: StackedOn;
}): string | undefined {
  const base = session.stackedOn?.branch;
  if (!base || session.mode !== "code" || !session.branch) return undefined;
  // Code Storage has no PRs and no stacks — the stacked relationship is purely
  // a branch cut from another branch, so the note reduces to push discipline.
  let csHosted = false;
  if (session.worktreeDir) {
    try {
      csHosted = repoForPath(session.worktreeDir).host === "codestorage";
    } catch {}
  }
  if (csHosted) {
    return [
      "## Stacked branch",
      `This branch was cut from \`${base}\` (another session's branch), not from the trunk — its commits sit ON TOP of that work, and a diff against the trunk would show both.`,
      `Commit and push your branch with \`git push -u origin ${session.branch}\` — this repo is hosted on Code Storage; there is no gh CLI and no pull requests; a pushed branch IS the change request. When reviewing the diff, compare against \`${base}\`, not the default branch.`,
      `Never merge \`${base}\` into this branch to "catch up" — it moves under you as its own review updates — and never merge either branch yourself; the human merges.`,
    ].join("\n");
  }
  return [
    "## Stacked branch",
    `This branch was cut from \`${base}\` (another session's branch), not from the trunk — its commits sit ON TOP of that work, and a diff against the trunk would show both.`,
    `Open your PR against that branch: \`gh pr create --base ${base}\`. Never retarget it at the default branch, and never merge \`${base}\` into this branch to "catch up" — it moves under you as its own PR updates.`,
    `Once both PRs exist, register them as a GitHub stack so each is reviewed on its own diff and the bases rebase themselves as layers merge: \`gh stack link <base-PR-url> <your-PR-url>\` (bottom first, run from this worktree). If that reports \`unknown command "stack"\`, don't retry or try to install it — just say so; the PR's base is what matters, and the Stack card in the PR tab links it in one click.`,
    "Never merge either PR — the human merges the stack.",
  ].join("\n");
}

/**
 * System-prompt note describing a session's repos when it spans more than one.
 * Lists the primary worktree + every attached repo with its path/branch and how
 * `@<project>:path` mentions resolve. Returns undefined for single-repo sessions
 * so the prompt stays clean.
 */
export function buildReposNote(session: UnifiedSession): string | undefined {
  const branchNote = [buildBranchNote(session), buildStackNote(session)]
    .filter(Boolean)
    .join("\n\n");
  const attached = session.attachedRepos || [];
  if (!attached.length) return branchNote || undefined;
  const primaryRepo = sessionRepoId(session) ?? defaultRepo().id;
  const lines = [
    "## Repos in this session",
    "This session spans multiple repos. Each is an isolated git worktree — `cd` into the right one to read or edit its files, and commit/push/open PRs in each repo independently (don't edit another repo's shared main checkout).",
    // Canonicalized for the note only — the stored worktreeDir stays literal
    // (see canonicalPath) — so a session that predates a checkout rename
    // points the agent at the path that exists today.
    `- **${primaryRepo}** (primary): ${canonicalPath(session.worktreeDir!)}${session.branch ? ` — branch \`${session.branch}\`` : ""}`,
  ];
  for (const r of attached)
    lines.push(`- **${r.repo}**: ${r.dir} — branch \`${r.branch}\``);
  lines.push(
    "A file mentioned from an attached repo arrives as `@<project>:<path>` — resolve it under that repo's worktree dir above.",
  );
  return [branchNote, lines.join("\n")].filter(Boolean).join("\n\n");
}

/** Repo ids a session spans, primary first — memory scopes + repos note agree on this. */
export function sessionRepoIds(session: UnifiedSession): string[] {
  const primary = sessionRepoId(session) ?? defaultRepo().id;
  return [primary, ...(session.attachedRepos || []).map((r) => r.repo)];
}

/**
 * The full per-session system-prompt note for an interactive run: repos/branch
 * discipline (buildReposNote) + the session's repo/user/team memory. Memory
 * failures never block a run — the note just goes out without it.
 */
export async function buildSessionNote(
  session: UnifiedSession,
  user?: string,
): Promise<string | undefined> {
  return (
    [
      session.presetNote || "",
      session.pstackMode ? PSTACK_MODE_NOTE : "",
      // The standing Desk session gets its concierge charter first — role
      // discipline for the summonable overlay (see desk.ts) — then the
      // user's live state, rebuilt per turn (desk-state.ts) so it can
      // answer "what's happening" without a tool round-trip and won't
      // spawn a worker onto work that's already running.
      session.desk ? DESK_NOTE : "",
      session.desk ? deskBriefingFor(user) : "",
      buildReposNote(session),
      await memoryNoteFor(user, sessionRepoIds(session), session.id),
    ]
      .filter(Boolean)
      .join("\n\n") || undefined
  );
}

/** The per-user prompt sections for a run: output style, personal system
 *  prompt, and repo/user/team memory (with tool guidance). Callers are
 *  interactive paths only; automations pass no user and skip this.
 *  Never throws: a store failure must not block a run, the note just goes out
 *  without that piece. */
export async function memoryNoteFor(
  user: string | undefined,
  repos: string[],
  /** Session the note is for. Given one, the rendered memory block is
   *  snapshotted and the SAME BYTES are reused every turn, so a parallel
   *  session storing a fact in a shared scope cannot invalidate this
   *  session's cached prompt prefix mid-conversation. The session's own
   *  memory writes refresh it (invalidateMemorySnapshot). */
  sessionId?: string,
): Promise<string> {
  const parts: string[] = [
    personalOutputStyleNoteFor(user),
    personalPromptNoteFor(user),
  ];
  try {
    const scopes = sessionMemoryScopes({ user, repos });
    const mode = memoryRolloutMode();
    if (mode === "v2") {
      parts.push(
        await snapshotMemoryNote(
          sessionId,
          async () =>
            (
              await renderAmbientMemoryForPrompt({
                scopeKeys: scopes.map((scope) => scope.key),
                primaryRepoKey: scopes.find((scope) => scope.kind === "repo")
                  ?.key,
              })
            ).text,
        ),
      );
    } else {
      parts.push(
        await snapshotMemoryNote(sessionId, () =>
          renderSessionMemoryNote(scopes, { tools: true }),
        ),
      );
      if (mode === "shadow") {
        void renderAmbientMemoryForPrompt({
          scopeKeys: scopes.map((scope) => scope.key),
          primaryRepoKey: scopes.find((scope) => scope.kind === "repo")?.key,
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.warn("[memory] failed to render session memory note:", e);
  }
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Prompt-matched memory belongs to this turn, not the stable system prefix.
 * It is fenced and context-logged by retrieveMemoryForPrompt.
 */
export async function retrievedMemoryNoteFor(
  query: string,
  user: string | undefined,
  repos: string[],
): Promise<string> {
  const mode = memoryRolloutMode();
  if (mode === "legacy") return "";
  try {
    const scopes = sessionMemoryScopes({ user, repos });
    const result = await retrieveMemoryForPrompt(query, {
      scopeKeys: scopes.map((scope) => scope.key),
      primaryRepoKey: scopes.find((scope) => scope.kind === "repo")?.key,
    });
    return mode === "v2" ? result.text : "";
  } catch (e) {
    console.warn("[memory] failed to retrieve turn memory:", e);
    return "";
  }
}

export interface WorktreeTarget {
  repoId: string;
  dir: string;
  primary: boolean;
  defaultBranch: string;
  /**
   * Whether git can actually act on this checkout: the dir exists on the
   * host, or it's the primary repo of a remote workspace (volume-mode
   * sandbox or runner), where commands route through the session's exec
   * instead of a host path. Attached repos are always host worktrees.
   */
  reachable: boolean;
}

interface ProjectedPrTarget {
  repoId: string;
  branch: string;
  source: "primary" | "attached" | "linked" | "discovered";
}

/**
 * Project every session shape onto one ordered set of PR targets. `prs` is the
 * current derived shape and owns each primary/attached slot it carries. The
 * persisted branch, attached repos, and links fill gaps for legacy sessions
 * and branches that do not have a cached PR yet.
 */
function projectPrTargets(session: UnifiedSession): ProjectedPrTarget[] {
  const targets: ProjectedPrTarget[] = (session.prs || [])
    .filter((ref) => ref.repo && ref.branch)
    .map((ref) => ({
      repoId: ref.repo,
      branch: ref.branch,
      source: ref.source,
    }));
  const primaryBranch = sessionPrBranch(session);
  if (primaryBranch && !targets.some((target) => target.source === "primary")) {
    targets.unshift({
      repoId: sessionRepoId(session) ?? defaultRepo().id,
      branch: primaryBranch,
      source: "primary",
    });
  }
  for (const attached of session.attachedRepos || []) {
    if (
      !targets.some(
        (target) =>
          target.source === "attached" && target.repoId === attached.repo,
      )
    )
      targets.push({
        repoId: attached.repo,
        branch: attached.branch,
        source: "attached",
      });
  }
  for (const linked of session.linkedPrs || []) {
    if (
      !targets.some(
        (target) =>
          target.repoId === linked.repo && target.branch === linked.branch,
      )
    )
      targets.push({
        repoId: linked.repo,
        branch: linked.branch,
        source: "linked",
      });
  }
  return targets;
}

/**
 * Resolve which of a session's checkouts a worktree operation targets. With no
 * `repoId` (or the primary project's id) it's the session's own worktree; an
 * attached project id targets that repo's isolated worktree. Returns null when
 * the session carries no checkout for that id.
 *
 * Every worktree route resolves through here so "which repo, which dir, can I
 * reach it" is answered once: the routes used to inline the same lookup and
 * apply the remote-workspace exception inconsistently, so a volume-mode session
 * had a worktree for diff/status/push/pull and none for image/file reads.
 */
export function resolveWorktreeTarget(
  session: Pick<UnifiedSession, "repo" | "worktreeDir" | "attachedRepos"> &
    WorkspaceExecSession,
  repoId?: string | null,
): WorktreeTarget | null {
  const primaryRepo = sessionRepoId(session) ?? defaultRepo().id;
  const primary = !repoId || repoId === primaryRepo;
  const dir = primary
    ? session.worktreeDir
    : (session.attachedRepos || []).find((r) => r.repo === repoId)?.dir;
  if (!dir) return null;
  const id = primary ? primaryRepo : repoId!;
  return {
    repoId: id,
    dir,
    primary,
    defaultBranch: getRepo(id).defaultBranch,
    reachable: existsSync(dir) || (primary && hasRemoteWorkspace(session)),
  };
}

/**
 * Resolve which host repo + branch a PR operation targets. With no `repo`
 * query (or the primary project's id) it's the session's primary branch; an
 * attached project id targets that repo on its attached branch. Returns null
 * when there's no branch to act on. `ghRepo` is the host-side repo identifier
 * (hostRepoId — GitHub owner/name, or the code.storage repo id).
 */
export function resolvePrTarget(
  session: UnifiedSession,
  repoId?: string | null,
  branch?: string | null,
): { ghRepo: string; branch: string; repoId: string } | null {
  const targets = projectPrTargets(session);
  const target =
    repoId && branch
      ? targets.find(
          (candidate) =>
            candidate.repoId === repoId && candidate.branch === branch,
        )
      : repoId
        ? targets.find(
            (candidate) =>
              candidate.repoId === repoId && candidate.source === "primary",
          ) ||
          targets.find(
            (candidate) =>
              candidate.repoId === repoId && candidate.source === "attached",
          ) ||
          targets.find((candidate) => candidate.repoId === repoId)
        : targets.find((candidate) => candidate.source === "primary");
  if (!target) return null;
  return {
    ghRepo: hostRepoId(getRepo(target.repoId)),
    branch: target.branch,
    repoId: target.repoId,
  };
}

/**
 * The workspace that already owns this worktree, or null. Adopt-don't-duplicate:
 * every create path that's about to wrap a session in a fresh workspace checks here
 * first, so landing on an already-owned worktree joins the existing workspace
 * instead of minting a second one over it. Repo main checkouts never match —
 * they're shared by every native/ask session, so ownership is meaningless there.
 */
export function workspaceOwningWorktree(
  worktreeDir: string | null | undefined,
): Workspace | null {
  if (!worktreeDir) return null;
  const cd = canonicalPath(worktreeDir);
  if (Object.values(REPOS).some((r) => canonicalPath(r.repo) === cd))
    return null;
  return findWorkspaceByWorktree(worktreeDir);
}

/**
 * Attach a secondary repo to a session: create (or reuse) an isolated worktree
 * for `repoId` and record it on the session. The attached branch defaults to
 * the session's primary branch so cross-repo work shares one branch name (and
 * the PRs line up). Re-attaching the same project just updates its entry. Only
 * code sessions on a real worktree can attach — Ask/main-checkout sessions and
 * the primary project itself are rejected.
 */
export async function attachRepo(
  sessionId: string,
  repoId: string,
  branch?: string,
  gitEnv?: Record<string, string>,
): Promise<{ attached: AttachedRepo; all: AttachedRepo[] }> {
  const session = findSession(sessionId);
  if (!session) throw new Error("Session not found");
  if (session.mode === "ask")
    throw new Error("Can't attach a repo to an Ask (read-only) session");
  if (hasRemoteWorkspace(session))
    throw new Error(
      "This session's workspace lives inside its sandbox volume — attached repos aren't supported in volume mode yet (use a bind-mode sandbox or a plain worktree session for multi-repo work)",
    );
  if (!REPOS[repoId]) throw new Error(`Unknown repo "${repoId}"`);
  if (session.repo === repoId)
    throw new Error(`${repoId} is this session's primary repo`);

  const effectiveBranch = (branch || session.branch || "").trim();
  if (!effectiveBranch) {
    throw new Error("No branch to attach on — pass a branch name");
  }

  const attached = await prepareAttachedWorktree(
    repoId,
    effectiveBranch,
    gitEnv,
  );
  // Read-modify-write inside the session-file lock rather than from the
  // snapshot above: cutting the worktree takes as long as a fetch, and a
  // create attaching several repos in a row must not have the last one's list
  // overwrite the ones before it.
  let all: AttachedRepo[] = [];
  await updateSessionFile(sessionId, (data) => {
    all = [
      ...(data.attachedRepos || []).filter((r) => r.repo !== repoId),
      attached,
    ];
    return {
      ...data,
      attachedRepos: all,
      lastActivity: new Date().toISOString(),
    };
  });
  return { attached, all };
}

/**
 * The repos a create asked to work in BESIDES its own — the New-session repo
 * picker's ⌘-click. Validated up front, before anything is persisted, so a
 * pick that can't work fails on the sender's transport instead of birthing a
 * session that quietly does less than it was asked for.
 *
 * Returns the ids in pick order, deduped, with the session's own repo dropped
 * (picking it again is a no-op, not an error). Everything else throws with a
 * message a person can act on. The preparation itself is `attachRepo`, once
 * the session file exists.
 */
export function planCreateAttachRepos(
  requested: unknown,
  primary: string,
  branch: string,
  lookup: (id: string) => AttachCandidate | null = registeredAttachCandidate,
): string[] {
  const wanted = [
    ...new Set(
      (Array.isArray(requested) ? requested : [])
        .map((id) => String(id).trim())
        .filter((id) => id && id !== primary),
    ),
  ];
  if (!wanted.length) return [];
  if (!branch)
    throw new Error(
      "A session that spans repos needs a branch: each extra repo is checked out on it.",
    );
  for (const id of wanted) {
    const candidate = lookup(id);
    if (!candidate) throw new Error(`Unknown repo "${id}"`);
    // Same refusal prepareAttachedWorktree makes, made early: there is no
    // isolated worktree to hand out, only the live checkout every session
    // of that repo is already working in.
    if (candidate.sharedCheckout)
      throw new Error(
        `${candidate.id} shares one checkout, so it can only be a session's own repo — not a second one.`,
      );
    if (branch === candidate.defaultBranch)
      throw new Error(
        `${candidate.id} can't be checked out on ${branch}: that is its own mainline. Give this session a branch name of its own.`,
      );
  }
  return wanted;
}

/** What the plan above needs to know about a repo someone asked to add. */
export interface AttachCandidate {
  id: string;
  defaultBranch: string;
  /** One live checkout shared by every session, so nothing to attach. */
  sharedCheckout: boolean;
}

function registeredAttachCandidate(id: string): AttachCandidate | null {
  if (!REPOS[id]) return null;
  const repo = getRepo(id);
  return {
    id: repo.id,
    defaultBranch: repo.defaultBranch,
    sharedCheckout: sharedCheckoutForNewSessions(repo),
  };
}

/**
 * Switch a session's PRIMARY repo — for when the wrong repo was picked at
 * creation. Clean-only by design: allowed only while the session's worktree has
 * no uncommitted changes and no commits beyond its base, so no work is ever
 * silently stranded (a session that already committed keeps its old repo). The
 * session's branch name is reused in the target repo (keeping any cross-repo
 * PRs aligned); the next prompt runs from the new worktree because
 * runSessionPrompt re-reads `cwd` from `worktreeDir` each turn.
 */
export async function switchPrimaryRepo(
  sessionId: string,
  repoId: string,
  force = false,
  gitEnv?: Record<string, string>,
): Promise<{ repo: string; branch: string; worktreeDir: string }> {
  const session = findSession(sessionId);
  if (!session) throw new Error("Session not found");
  if (session.mode === "ask")
    throw new Error("Ask sessions read the main checkout — nothing to switch");
  if (!REPOS[repoId]) throw new Error(`Unknown repo "${repoId}"`);
  if (session.repo === repoId)
    throw new Error(`${repoId} is already this session's primary repo`);
  // A switch just repoints the session at a different worktree — the old one
  // (branch, commits, uncommitted edits) stays on disk, so nothing is ever
  // destroyed. We still block by default when there's work so the agent-facing
  // switch_repo tool can't silently abandon it; the human UI passes force=true
  // after confirming, since fixing a wrong-repo choice is exactly that case.
  if (
    !force &&
    session.worktreeDir &&
    session.branch &&
    (await worktreeHasWork(session.worktreeDir, session.branch, session.repo))
  )
    throw new Error(
      "This session already has work — switching repos is only allowed on a fresh session",
    );

  const target = getRepo(repoId);
  let wtPath: string;
  let branch: string;
  if (sharedCheckoutForNewSessions(target)) {
    // Open Session: sessions edit the live main checkout on its default branch.
    wtPath = target.repo;
    branch = target.defaultBranch;
  } else {
    branch = (session.branch || "").trim();
    if (!branch) throw new Error("Session has no branch to carry over");
    const worktrees = await listWorktrees(target.id);
    wtPath =
      worktrees.find((w) => w.branch === branch)?.path ||
      (await createWorktree(
        branch,
        target.id,
        gitEnv ? { gitEnv } : undefined,
      ));
  }

  // Drop the target from attached repos if it was attached — it's the primary now.
  const attachedRepos = (session.attachedRepos || []).filter(
    (r) => r.repo !== repoId,
  );
  touchNativeSession(sessionId, {
    repo: target.id,
    worktreeDir: wtPath,
    branch,
    attachedRepos,
  });
  // The session's workspace was minted around the repo we're leaving, and its repo
  // is what the sidebar bands the row under (wsRowRepo) while its branch +
  // worktreeDir are the template a sibling session inherits. Left stamped, the row
  // files under the abandoned repo — the session's own header showing the new one —
  // and a new session in the workspace starts in a worktree the work has left.
  // Re-stamp only when this session is the workspace's sole member and the
  // workspace still points at the worktree being left: with siblings still
  // there, or on a PR/ticket workspace that deliberately names another repo,
  // the stamp isn't ours to move.
  const workspaceId = session.workspaceId;
  if (workspaceId) {
    const ws = getWorkspace(workspaceId);
    const soleMember = !getCachedSessions().some(
      (s) => s.workspaceId === workspaceId && s.id !== sessionId,
    );
    if (
      ws &&
      soleMember &&
      ws.repo === session.repo &&
      (!ws.worktreeDir || ws.worktreeDir === session.worktreeDir)
    )
      restampWorkspaceWorktree(workspaceId, {
        repo: target.id,
        // A shared-checkout repo has no per-session worktree, so the template
        // clears instead of pointing siblings at the live main checkout.
        ...(sharedCheckoutForNewSessions(target)
          ? {}
          : { branch, worktreeDir: wtPath }),
      });
  }
  return { repo: target.id, branch, worktreeDir: wtPath };
}

/** `gh pr view` for one PR — resolves a number or branch to its head branch + label fields. */
async function ghPrView(
  ghRepo: string,
  selector: string,
): Promise<{
  branch: string;
  number: number;
  url: string;
  title: string;
} | null> {
  try {
    const proc = Bun.spawn(
      [
        "gh",
        "pr",
        "view",
        selector,
        "--repo",
        ghRepo,
        "--json",
        "headRefName,number,url,title",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const raw = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0 || !raw.trim()) return null;
    const pr = JSON.parse(raw);
    return {
      branch: pr.headRefName,
      number: pr.number,
      url: pr.url,
      title: pr.title || "",
    };
  } catch {
    return null;
  }
}

/**
 * Link a PR to a session, beyond the ones derived from its branch and attached
 * repos — a follow-up PR on another branch, a related PR in another repo, or
 * one opened outside the session. Accepts a GitHub PR URL, or repo id +
 * number/branch; the PR is resolved via gh so the stored link carries the head
 * branch (the key the whole PR pipeline uses) plus number/url/title for
 * labels. Re-linking an already-linked PR refreshes its entry.
 */
export async function linkPr(
  sessionId: string,
  input: { url?: string; repo?: string; number?: number; branch?: string },
): Promise<{ linked: LinkedPr; all: LinkedPr[] }> {
  const session = findSession(sessionId);
  if (!session) throw new Error("Session not found");

  let repoId = input.repo?.trim();
  let number = input.number;
  let branch = input.branch?.trim();

  if (input.url) {
    const m = input.url.match(
      /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i,
    );
    if (!m)
      throw new Error("Not a GitHub PR URL (…github.com/owner/repo/pull/N)");
    const ghRepo = `${m[1]}/${m[2]}`.toLowerCase();
    const match = Object.values(REPOS).find(
      (r) => r.ghRepo?.toLowerCase() === ghRepo,
    );
    if (!match)
      throw new Error(
        `${m[1]}/${m[2]} isn't a registered repo (known: ${Object.values(REPOS)
          .filter((r) => r.ghRepo)
          .map((r) => r.id)
          .join(", ")})`,
      );
    repoId = match.id;
    number = parseInt(m[3], 10);
  }

  if (!repoId) throw new Error("Pass a PR URL or a repo id");
  const repo = REPOS[repoId];
  const hostRepo = repo ? hostRepoId(repo) : "";
  if (!repo || !hostRepo) throw new Error(`Unknown repo "${repoId}"`);
  if (!number && !branch)
    throw new Error("Pass a PR URL, a PR number, or a branch");

  // Resolve through the host: number → head branch (required — the PR
  // pipeline is branch-keyed), branch → number/url/title (best-effort label
  // enrichment). GitHub asks gh; code.storage resolves the branch (or its
  // synthetic number) against the live branch list.
  const resolved =
    repo.host === "codestorage"
      ? await import("./codestorage/pr-host").then((m) =>
          m.csPrView(hostRepo, number ? { number } : { branch: branch! }),
        )
      : await ghPrView(hostRepo, number ? String(number) : branch!);
  if (number && !resolved)
    throw new Error(`Couldn't find PR #${number} in ${hostRepo}`);
  if (resolved) {
    branch = resolved.branch;
    number = resolved.number;
  }

  const primaryRepo = sessionRepoId(session) ?? defaultRepo().id;
  if (repoId === primaryRepo && branch === session.branch)
    throw new Error("That's this session's own PR — it's already shown");
  if (
    (session.attachedRepos || []).some(
      (r) => r.repo === repoId && r.branch === branch,
    )
  )
    throw new Error(
      `That's the attached ${repoId} repo's PR — it's already shown`,
    );

  const linked: LinkedPr = {
    repo: repoId,
    branch: branch!,
    ...(number ? { number } : {}),
    ...(resolved?.url ? { url: resolved.url } : {}),
    ...(resolved?.title ? { title: resolved.title } : {}),
  };
  const all = [
    ...(session.linkedPrs || []).filter(
      (r) => !(r.repo === repoId && r.branch === branch),
    ),
    linked,
  ];
  touchNativeSession(sessionId, { linkedPrs: all });
  return { linked, all };
}

/** Remove a linked PR from a session (the link only — the PR is untouched). */
export function unlinkPr(
  sessionId: string,
  repoId: string,
  branch: string,
): LinkedPr[] {
  const session = findSession(sessionId);
  if (!session) throw new Error("Session not found");
  const all = (session.linkedPrs || []).filter(
    (r) => !(r.repo === repoId && r.branch === branch),
  );
  touchNativeSession(sessionId, { linkedPrs: all });
  return all;
}
