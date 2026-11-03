/**
 * A session's review request: who is asked to review it, and whether they
 * signed off. One implementation shared by `PUT /api/sessions/:id/review`
 * (the info panel's Reviewer picker) and the opensession-sessions MCP tools,
 * so a request made by an agent mirrors onto GitHub and notifies exactly
 * like one made in the UI.
 */

import type { GithubCredential } from "./github-auth";
import { reviewTeamDirectory, reviewTeamFor, teamDirectory } from "./people";
import { prHostFor } from "./pr-host";
import {
  editPrReviewers,
  isNoPrError,
  prMetaForBranch,
  prReviewerSpecs,
} from "./pr-info";
import { markPrReviewNotified } from "./pr-review-notifications";
import {
  getReviewRequest,
  setReviewAccepted,
  setReviewRequest,
  type ReviewRequest,
} from "./review-requests";
import { publishSessionChange } from "./session-cache";
import { executeSessionProjection } from "./session-projection-executor";
import { resolvePrTarget } from "./session-repos";
import { markCachedPrReviewRequestsCleared } from "./sessions";
import { githubLoginFor } from "./shared/user-mappings";
import type { UnifiedSession } from "./types";
import { getRepo } from "./worktree";

export type ReviewFailure = {
  ok: false;
  status: 400 | 403 | 502;
  error: string;
};
export type ReviewResult = { ok: true } | ReviewFailure;

/** Error text when a GitHub mutation needs a person's own connection. */
export const GITHUB_CREDENTIAL_REQUIRED =
  "Connect your GitHub account before changing a pull request.";

/**
 * Stored keys a request may live under. A unified session can inherit a
 * request stored before deduplication under one of its historical ids, so
 * every read and mutation covers those too.
 */
function reviewAliases(session: UnifiedSession, sessionId: string): string[] {
  return [
    ...(session.aliasIds || []),
    ...(session.id === sessionId ? [] : [sessionId]),
  ];
}

export function sessionReviewRequest(
  session: UnifiedSession,
  sessionId: string = session.id,
): ReviewRequest | null {
  return (
    getReviewRequest(session.id, reviewAliases(session, sessionId)) ?? null
  );
}

/**
 * The picker's canonical value for `ref`: a teammate's first name or a review
 * team's GitHub spec, matched case-insensitively against first name, full
 * name, GitHub login, or team name. Null when it names nobody.
 */
export function resolveReviewer(ref: string): string | null {
  const key = ref.trim().toLowerCase();
  if (!key) return null;
  const team = reviewTeamFor(key);
  if (team) return team.github;
  const person = teamDirectory().find(
    (p) =>
      p.name.toLowerCase() === key ||
      p.fullName.toLowerCase() === key ||
      p.github?.toLowerCase() === key,
  );
  return person?.name ?? null;
}

/** Everyone a review can be requested from, for error messages and pickers. */
export function reviewerChoices(): string[] {
  return [
    ...teamDirectory().map((p) => p.name),
    ...reviewTeamDirectory().map((t) => t.github),
  ];
}

/**
 * Accept (the reviewer signs off) or reopen the current request. Keeps the
 * assignment and never touches GitHub's Reviewers list. Buzzes the asker on
 * accept unless they reviewed it themself.
 */
export async function acceptSessionReview(
  session: UnifiedSession,
  sessionId: string,
  accept: boolean,
  by: string,
): Promise<ReviewResult> {
  const aliases = reviewAliases(session, sessionId);
  const existing = getReviewRequest(session.id, aliases);
  if (!existing)
    return { ok: false, status: 400, error: "No review request to accept" };
  await setReviewAccepted(
    session.id,
    accept ? { by: by || "someone", at: new Date().toISOString() } : null,
    aliases,
  );
  await publishSessionChange(session.id);
  if (accept && existing.by && existing.by.toLowerCase() !== by.toLowerCase()) {
    void (async () => {
      try {
        const { notifyUser, sessionSubject, sessionUrl } =
          await import("./notifications");
        await notifyUser(existing.by, {
          kind: "review_done",
          subject: sessionSubject(sessionId, session),
          reason: `${by || "Someone"} reviewed it`,
          actor: by || undefined,
          url: sessionUrl(sessionId),
        });
      } catch {}
    })();
  }
  return { ok: true };
}

/**
 * Set, swap, or clear (`reviewer` empty) a session's review request.
 *
 * Mirrors the change onto the PR's GitHub Reviewers list first, so an auth or
 * API failure cannot leave the two disagreeing, then stores it and notifies
 * the reviewer. `credential` is the acting person's GitHub credential, or null
 * when they have none; a null credential only blocks when a PR exists.
 */
export async function setSessionReviewer(opts: {
  session: UnifiedSession;
  sessionId: string;
  reviewer: string;
  by: string;
  repo?: string;
  credential: GithubCredential | null;
}): Promise<ReviewResult> {
  const { session, sessionId, reviewer, by, credential } = opts;
  const aliases = reviewAliases(session, sessionId);
  const prevReviewer = getReviewRequest(session.id, aliases)?.to;
  const reviewTeam = reviewTeamFor(reviewer);
  const previousReviewTeam = reviewTeamFor(prevReviewer);
  // Setting a reviewer adds them, re-assigning swaps, clearing removes. Only
  // for sessions with a branch/PR whose reviewer maps to a GitHub login; the
  // phone buzz below always fires regardless.
  const addLogin = reviewer
    ? reviewTeam?.github || githubLoginFor(reviewer)
    : null;
  const removeLogin =
    prevReviewer && prevReviewer !== reviewer
      ? previousReviewTeam?.github ||
        (/^[\w.-]+\/[\w.-]+$/.test(prevReviewer)
          ? prevReviewer
          : githubLoginFor(prevReviewer))
      : null;
  const target = await resolvePrTarget(session, opts.repo);
  // Hosts without a reviewer concept (code.storage) have nothing to mirror
  // onto; the internal request stands on its own there.
  const hostReviewers = target
    ? prHostFor(getRepo(target.repoId)).capabilities.reviewers
    : false;
  // Whether the reviewer actually reached GitHub's list: false when there was
  // no PR to mirror onto, which the push marker below depends on.
  let mirroredToGithub = false;
  // Clearing a session with no request of its own withdraws GitHub's own
  // pending requests instead: the chip reports those as the same "somebody is
  // waiting on you" state, and this is the only way to take one down from
  // here. Read as the service identity, so a clear with nothing on GitHub to
  // remove never demands a personal credential.
  const removeSpecs = new Set(removeLogin ? [removeLogin] : []);
  if (!reviewer && !prevReviewer && target && hostReviewers) {
    const specs = await prReviewerSpecs(target.branch, target.ghRepo).catch(
      () => null,
    );
    for (const spec of specs || []) removeSpecs.add(spec);
  }
  if (target && hostReviewers && (addLogin || removeSpecs.size)) {
    // `target` comes from branch metadata alone, so most sessions reaching
    // here have nothing on GitHub to change. Ask before refusing, so an
    // expired GitHub connection can't take the internal request down with
    // it. Fails closed: if we can't establish there's no PR, we still refuse.
    if (!credential) {
      const existing = await prMetaForBranch(
        target.branch,
        target.ghRepo,
      ).catch(() => "unknown" as const);
      if (existing !== null)
        return { ok: false, status: 403, error: GITHUB_CREDENTIAL_REQUIRED };
    } else {
      const mirrored = await editPrReviewers(
        target.branch,
        { add: addLogin, remove: [...removeSpecs] },
        target.ghRepo,
        credential,
      ).catch((e: any) => ({ error: e?.message || String(e) }));
      // `gh pr edit` answering "no pull requests found" is an answer, not a
      // failure: nothing to mirror, so the local request stands on its own.
      // Every other error still blocks, so a PR that DOES exist can never
      // silently disagree with the request stored here.
      if ("error" in mirrored) {
        if (!isNoPrError(mirrored.error))
          return { ok: false, status: 502, error: mirrored.error };
      } else mirroredToGithub = true;
    }
  }
  await executeSessionProjection(sessionId, "review_request", () =>
    setReviewRequest(
      session.id,
      reviewer
        ? {
            to: reviewTeam?.github || reviewer,
            ...(reviewTeam ? { recipients: reviewTeam.members } : {}),
            by: by || "someone",
            at: new Date().toISOString(),
          }
        : null,
      aliases,
    ),
  );
  // The chip's GitHub fallback reads the bulk PR cache, which the throttled
  // sweep only refills every 10-30 minutes. Without a write-through, a clear
  // that did reach GitHub still leaves the reviewers on screen.
  if (!reviewer && mirroredToGithub && target)
    markCachedPrReviewRequestsCleared(target.ghRepo, target.branch);
  await publishSessionChange(session.id);
  if (reviewer) {
    // Only suppress the watcher's own push when the request really landed on
    // GitHub; marking a skipped mirror would swallow a later genuine one.
    if (mirroredToGithub && target && addLogin) {
      for (const recipient of reviewTeam?.members || [reviewer])
        markPrReviewNotified(target.ghRepo, target.branch, recipient);
    }
    // Best-effort phone buzz; never let a push hiccup fail the request.
    void (async () => {
      try {
        const { notifyUser, sessionSubject, sessionUrl } =
          await import("./notifications");
        await Promise.all(
          (reviewTeam?.members || [reviewer]).map((recipient) =>
            notifyUser(recipient, {
              kind: "review_requested",
              subject: sessionSubject(sessionId, session),
              reason: `${by || "Someone"} asked for your review`,
              actor: by || undefined,
              url: sessionUrl(sessionId),
            }),
          ),
        );
      } catch {}
    })();
  }
  return { ok: true };
}
