import type { SessionPrRef, UnifiedSession } from "./types";
import { defaultRepo, githubBotLogins } from "./config";
import type { PrInfo } from "./pr-cache";
import { peekWorkspace, type Workspace } from "./workspaces";

/** The PR branch `session` can take from `workspace`, or null. Never across
 *  repos: a session in another repo would resolve to a branch absent there. */
function inheritedBranch(
  session: UnifiedSession,
  workspace: Workspace | null | undefined,
): string | null {
  if (!workspace?.branch) return null;
  if (session.repo && workspace.repo && session.repo !== workspace.repo)
    return null;
  return workspacePrHead(workspace) ?? workspace.branch;
}

/**
 * The PR head a PR-backed workspace names, or null when it has no PR. A PR
 * workspace materialized by its review checkout can carry the derived
 * `<head>-os-review` branch instead of the head (the PR cache never has a PR
 * on that branch), so resolve on the head it was derived from.
 */
export function workspacePrHead(workspace: Workspace): string | null {
  if (workspace.prNumber == null || !workspace.branch) return null;
  return workspace.branch.replace(/-os-review$/, "");
}

/**
 * The branch a session's PR surfaces (tab, sidebar glyph, Reviews row) resolve on.
 *
 * A workspace owns the branch; a session with none of its own inherits it.
 * Ask-style sessions are filed into a workspace and share its checkout on disk but
 * store no `branch`, so without the fallback they resolved to no PR at all —
 * one tab of a workspace offered "Create PR" while its sibling showed the
 * workspace's connected PR.
 *
 * Legacy GitHub review sessions invert that: they store their local `*-os-review`
 * checkout as the session branch, and the PR-backed workspace retains the real
 * head branch, so the workspace wins over the session there. A user-made tab in
 * the same PR workspace inherits that derived checkout as its own branch too,
 * so it resolves the same way; otherwise it showed "No PR open" beside the
 * review tab that showed the PR.
 *
 * Pass `workspace` to reuse an already-read record (see {@link prWorkspaceReader});
 * leaving it `undefined` reads it, `null` opts out of the lookup entirely.
 */
export function sessionPrBranch(
  session: UnifiedSession,
  workspace?: Workspace | null,
): string | null {
  const parent =
    workspace === undefined && session.workspaceId
      ? peekWorkspace(session.workspaceId)
      : workspace;
  const prHead = parent ? workspacePrHead(parent) : null;
  const reviewCheckout =
    session.automation === "github-pr-review" ||
    (!!prHead && session.branch === `${prHead}-os-review`);
  if (reviewCheckout) return prHead ?? session.branch;
  return session.branch || inheritedBranch(session, parent);
}

/**
 * A memoized workspace reader for callers that resolve many sessions at once
 * (the `getAllSessions` PR enrichment). Reads the memory projection, which the
 * list path warms before assembling; one workspace holds many sessions, so the
 * memo keeps the lookups to one per workspace. Sessions that can't inherit a
 * branch skip the read entirely — {@link sessionPrBranch} never consults the
 * workspace for those.
 */
export function prWorkspaceReader(): (s: UnifiedSession) => Workspace | null {
  const cache = new Map<string, Workspace | null>();
  return (session) => {
    if (!session.workspaceId) return null;
    if (
      session.branch &&
      session.automation !== "github-pr-review" &&
      !session.branch.endsWith("-os-review")
    )
      return null;
    let workspace = cache.get(session.workspaceId);
    if (workspace === undefined)
      cache.set(
        session.workspaceId,
        (workspace = peekWorkspace(session.workspaceId)),
      );
    return workspace;
  };
}

function prRefKey(ref: Pick<SessionPrRef, "repo" | "branch">): string {
  return `${ref.repo}\u0000${ref.branch}`;
}

function flatPrRef(session: UnifiedSession): SessionPrRef | null {
  // The flat fields were resolved through sessionPrBranch, so the ref must
  // name that branch too: a tab on a `<head>-os-review` checkout otherwise
  // projects a primary ref on the review branch, and the PR routes then look
  // up a PR that branch never had.
  const branch = sessionPrBranch(session);
  if ((!session.prUrl && session.prNumber == null) || !branch) return null;
  return {
    repo: session.repo || defaultRepo().id,
    branch,
    source: "primary",
    url: session.prUrl,
    state: session.prState,
    number: session.prNumber,
    title: session.prTitle,
    isDraft: session.prIsDraft,
    reviewDecision: session.prReviewDecision,
    additions: session.prAdditions,
    deletions: session.prDeletions,
    checks: session.prChecks,
  };
}

export type FooterPrMatch = { repo: string; branch: string; pr: PrInfo };

/** Restore PRs discovered from attribution footers on a materialized row. */
export function mergeFooterPrRefs(
  session: UnifiedSession,
  matches: readonly FooterPrMatch[],
): SessionPrRef[] {
  const refs = [...(session.prs || [])];
  for (const { repo, branch, pr } of matches) {
    const current = refs.findIndex(
      (ref) => ref.repo === repo && ref.branch === branch,
    );
    const discovered: SessionPrRef = {
      repo,
      branch,
      source: "discovered",
      url: pr.url,
      state: pr.state,
      number: pr.number,
      title: pr.title,
      isDraft: pr.isDraft,
      reviewDecision: pr.reviewDecision,
      mergeable: pr.mergeable,
      additions: pr.additions,
      deletions: pr.deletions,
      checks: pr.checks,
    };
    if (current < 0) refs.push(discovered);
    else {
      const existing = refs[current]!;
      refs[current] = { ...discovered, source: existing.source };
    }
  }
  return refs;
}

function isBotLogin(login: string, bots: readonly string[]): boolean {
  const lower = login.toLowerCase();
  return (
    bots.includes(lower) || lower.endsWith("[bot]") || lower.endsWith("-bot")
  );
}

/**
 * The teammate a PR is for. A bot-authored PR (the instance's own GitHub
 * identity opening it from a session) carries the person who asked for it as
 * its assignee, and that is who is waiting on a review of it, not the bot.
 * Computed here once so every client shows the same face.
 */
export function prRequesterLogin(
  pr: Pick<PrInfo, "author" | "assignees">,
): string | undefined {
  const bots = githubBotLogins().map((login) => login.toLowerCase());
  const author = pr.author?.trim();
  if (author && !isBotLogin(author, bots)) return author;
  return (
    (pr.assignees || []).find((login) => !isBotLogin(login, bots)) ||
    author ||
    undefined
  );
}

/** Refresh the PR fields omitted by targeted native-session reads. */
export function enrichSessionPrRefs(
  session: UnifiedSession,
  context: {
    defaultRepoId: string;
    prsByRepo: ReadonlyMap<string, ReadonlyMap<string, PrInfo>>;
    footerMatches: readonly FooterPrMatch[];
  },
): UnifiedSession {
  const branch = sessionPrBranch(session);
  const currentPr = branch
    ? context.prsByRepo.get(session.repo || context.defaultRepoId)?.get(branch)
    : undefined;
  const prs = mergeFooterPrRefs(session, context.footerMatches);
  return {
    ...session,
    ...(currentPr
      ? {
          prUrl: currentPr.url,
          prState: currentPr.state,
          prMergeable: currentPr.mergeable,
          prNumber: currentPr.number,
          prTitle: currentPr.title,
          prIsDraft: currentPr.isDraft,
          prAdditions: currentPr.additions,
          prDeletions: currentPr.deletions,
          prChangedFiles: currentPr.changedFiles,
          prReviewDecision: currentPr.reviewDecision,
          prReviewRequested: currentPr.reviewRequested,
          prReviewedBy: currentPr.reviewedBy,
          prAuthor: currentPr.author,
          prRequester: prRequesterLogin(currentPr),
          prUpdatedAt: currentPr.updatedAt,
          prChecks: currentPr.checks,
        }
      : {}),
    ...(prs.length ? { prs } : {}),
  };
}

function mergePrRef(owned: SessionPrRef, shared: SessionPrRef): SessionPrRef {
  // Keep how THIS session owns the target, but take any richer cache fields a
  // sibling received. The same PR can be primary here and linked there.
  return {
    ...shared,
    ...owned,
    source: owned.source,
    url: owned.url ?? shared.url,
    state: owned.state ?? shared.state,
    number: owned.number ?? shared.number,
    title: owned.title ?? shared.title,
    isDraft: owned.isDraft ?? shared.isDraft,
    reviewDecision: owned.reviewDecision ?? shared.reviewDecision,
    additions: owned.additions ?? shared.additions,
    deletions: owned.deletions ?? shared.deletions,
    checks: owned.checks ?? shared.checks,
  };
}

/**
 * Make a workspace's PR collection available from every one of its tabs.
 *
 * PR discovery and cache enrichment start from sessions because branches and
 * attribution footers live there. Review, the workspace summary, and the phone
 * PR chip are workspace surfaces, though: switching chats must not make a PR
 * disappear merely because the newly selected session did not discover it.
 *
 * Each session keeps its own primary/attached/linked ownership. PRs contributed
 * only by siblings are projected as discovered refs, which also makes the
 * existing session-scoped PR routes authorize that explicit repo+branch target.
 * A bare attached branch is not proof of a PR and is therefore not shared.
 */
export function shareWorkspacePrRefs(sessions: UnifiedSession[]): void {
  const groups = new Map<string, UnifiedSession[]>();
  for (const session of sessions) {
    if (!session.workspaceId) continue;
    const group = groups.get(session.workspaceId);
    if (group) group.push(session);
    else groups.set(session.workspaceId, [session]);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const shared = new Map<string, SessionPrRef>();
    for (const session of group) {
      const flat = flatPrRef(session);
      const own = flat ? [...(session.prs || []), flat] : session.prs || [];
      for (const ref of own) {
        if (
          ref.source === "attached" &&
          ref.number == null &&
          !ref.url &&
          !ref.state
        )
          continue;
        const key = prRefKey(ref);
        const existing = shared.get(key);
        shared.set(key, existing ? mergePrRef(existing, ref) : ref);
      }
    }
    if (shared.size === 0) continue;

    for (const session of group) {
      const refs = [...(session.prs || [])];
      const flat = flatPrRef(session);
      if (flat && !refs.some((ref) => prRefKey(ref) === prRefKey(flat)))
        refs.unshift(flat);
      const positions = new Map(
        refs.map((ref, index) => [prRefKey(ref), index] as const),
      );
      for (const ref of shared.values()) {
        const key = prRefKey(ref);
        const index = positions.get(key);
        if (index === undefined) {
          positions.set(key, refs.length);
          refs.push({ ...ref, source: "discovered" });
        } else {
          refs[index] = mergePrRef(refs[index]!, ref);
        }
      }
      if (refs.length > 0) session.prs = refs;
    }
  }
}

/**
 * Add a workspace projection to one authoritative session without mutating it.
 *
 * Detail and PR routes load one session actor, while workspace PRs come from
 * the bounded materialized workspace index. Include the indexed copy of the
 * same session: it may carry derived footer PRs that are intentionally absent
 * from the durable actor record.
 */
export function projectWorkspacePrRefs(
  session: UnifiedSession,
  workspaceSessions: readonly UnifiedSession[],
): UnifiedSession {
  if (!session.workspaceId) return session;
  const projected: UnifiedSession = {
    ...session,
    ...(session.prs ? { prs: [...session.prs] } : {}),
  };
  const members = workspaceSessions
    .filter((candidate) => candidate.workspaceId === session.workspaceId)
    .map((candidate) => ({
      ...candidate,
      ...(candidate.prs ? { prs: [...candidate.prs] } : {}),
    }));
  shareWorkspacePrRefs([projected, ...members]);
  return projected;
}
