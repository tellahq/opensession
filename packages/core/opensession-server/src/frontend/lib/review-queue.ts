import type { UnifiedSession } from "./types";
import type { OpenPr } from "./api";
import { isBotAuthor } from "./pr-comments";
import { FALLBACK_REPO, sessionRepoOr } from "./session-repo";

export type ReviewBucket = "ready" | "attention" | "waiting";
export type ReviewSource = "mine" | "requested" | "automation" | "other";

export type ReviewQueuePr = OpenPr & {
  mergeable?: string;
};

export interface ReviewQueueItem {
  pr: ReviewQueuePr;
  sessionId: string | null;
  source: ReviewSource;
  bucket: ReviewBucket;
  status: string;
}

export function reviewRequestTargetsPerson(
  request: UnifiedSession["reviewRequest"],
  person: string,
): boolean {
  if (!request) return false;
  const key = person.trim().toLowerCase();
  return [request.to, ...(request.recipients || [])].some(
    (target) => target.toLowerCase() === key,
  );
}

export function reviewRowMatchesPersonFilter(
  owner: string,
  requests: Array<UnifiedSession["reviewRequest"]>,
  person: string,
  currentUser: string,
  /**
   * GitHub lists you as a requested reviewer on this row's PR. It reaches your
   * own lens on its own: the row is usually a teammate's, and a GitHub request
   * writes no Open Session review request to match on.
   */
  githubRequestsMe = false,
): boolean {
  if (person === "unassigned") return false;
  if (person === "everyone") return true;
  if (person !== "me") return owner === person;

  const me = currentUser.toLowerCase();
  return (
    owner === me ||
    githubRequestsMe ||
    requests.some(
      (request) =>
        reviewRequestTargetsPerson(request, me) ||
        request?.by.toLowerCase() === me,
    )
  );
}

/**
 * Is `person` (a lowercase person key) a requested reviewer on this row's PR,
 * according to GitHub?
 *
 * This is the other half of a review waiting on you. The info panel's Reviewer
 * picker writes Open Session's own request (`reviewRequest`); being added as a
 * reviewer on the pull request itself writes nothing there at all, so a review
 * somebody asked you for on GitHub used to reach the sidebar only as a
 * standalone PR row — which disappeared the moment you opened it, because
 * opening it mints the workspace row that covers it.
 *
 * GitHub drops a reviewer from this list the instant they submit a review and
 * puts them back on a re-request, so "still listed" is the whole test: the row
 * leaves your band when you have actually reviewed, not when you have looked.
 * Team requests are expanded to their members server-side, so a team ask
 * reaches every member here, exactly as it does in GitHub's own review queue.
 */
export function wsPrRequestsReviewFrom(
  row: { sessions: Pick<UnifiedSession, "prReviewRequested">[] },
  person: string,
): boolean {
  return row.sessions.some((session) =>
    (session.prReviewRequested || []).some(
      (reviewer) => reviewer.toLowerCase() === person,
    ),
  );
}

/**
 * Is this row `person`'s own work, rather than work waiting on their review?
 *
 * A pull request opened from a workspace asks the reviewer team, and the
 * server expands a team ask to its members (`reviewRequestPersonKeys`) minus
 * the PR's GitHub author — which is the bot that opened it, never the person
 * whose session wrote the code. GitHub therefore asks the author of the work
 * to review it, and without this test their live workspace leaves their own
 * status lanes for Needs review the moment their PR opens.
 *
 * The test is the sidebar's own "in the room" rule: the row is yours if you
 * own it or if one of its sessions is a conversation of yours. A PR someone
 * asked you to review mints a session-less workspace row, so it keeps its
 * claim on you until you open a session and work in it.
 */
export function rowIsOwnWork(
  row: {
    owner: string;
    sessions: Pick<UnifiedSession, "automation" | "startedBy">[];
  },
  person: string,
): boolean {
  const key = personKey(person);
  if (row.owner && personKey(row.owner) === key) return true;
  return row.sessions.some(
    (session) =>
      !session.automation &&
      !!session.startedBy &&
      personKey(session.startedBy) === key,
  );
}

export interface ReviewAsker {
  /** Display name, or the GitHub login when the asker isn't a teammate. */
  name: string;
  /** GitHub login, when known — lets the avatar load their picture. */
  login?: string;
  /**
   * The claim came from the pull request rather than the Reviewer picker, so
   * this is its AUTHOR. GitHub does not record who added you as a reviewer,
   * and the author is who is waiting either way — but a label must not say
   * they asked when it only knows they opened it.
   */
  viaPr: boolean;
}

/**
 * Who is waiting on your review of this row, or null when nobody is.
 *
 * Open Session's own request names the person who made it, so it answers
 * first and exactly. A GitHub request falls back to the pull request's
 * author. Both are filtered the same way the Needs review band filters them,
 * so a row that has left the band never still names someone.
 */
export function reviewAskerFor(
  row: {
    sessions: Pick<
      UnifiedSession,
      | "reviewRequest"
      | "prReviewRequested"
      | "prAuthor"
      | "prReviewedBy"
      | "prUpdatedAt"
    >[];
  },
  currentUser: string,
): ReviewAsker | null {
  const me = currentUser.trim().toLowerCase();
  const key = personKey(currentUser);
  for (const session of row.sessions) {
    const request = session.reviewRequest;
    if (
      request?.by &&
      !request.accepted &&
      reviewRequestTargetsPerson(request, me) &&
      !prReviewCompletion(request, session)
    )
      return { name: request.by, viaPr: false };
  }
  for (const session of row.sessions) {
    if (
      session.prAuthor &&
      (session.prReviewRequested || []).some(
        (reviewer) => reviewer.toLowerCase() === key,
      )
    )
      return { name: session.prAuthor, login: session.prAuthor, viaPr: true };
  }
  return null;
}

export function prReviewCompletion(
  request: NonNullable<UnifiedSession["reviewRequest"]>,
  session: Pick<
    UnifiedSession,
    "prUpdatedAt" | "prReviewedBy" | "prReviewRequested"
  >,
): { by: string; at: string } | null {
  if (request.accepted || !session.prUpdatedAt) return null;
  const reviewers = [request.to, ...(request.recipients || [])];
  const reviewedAt = Date.parse(session.prUpdatedAt);
  const requestedAt = Date.parse(request.at);
  if (
    !reviewers.length ||
    !Number.isFinite(reviewedAt) ||
    reviewedAt <= requestedAt
  )
    return null;
  const reviewer = reviewers.find(
    (person) =>
      (session.prReviewedBy || []).some(
        (reviewed) => reviewed.toLowerCase() === person.toLowerCase(),
      ) &&
      !(session.prReviewRequested || []).some(
        (pending) => pending.toLowerCase() === person.toLowerCase(),
      ),
  );
  return reviewer ? { by: reviewer, at: session.prUpdatedAt } : null;
}

// FALLBACK_REPO never equals a real PR repo id, so a repo-less session
// deliberately matches no PR (see lib/session-repo for the fork rationale).
function sessionRepo(session: UnifiedSession): string {
  return sessionRepoOr(session, FALLBACK_REPO);
}

/**
 * One repo + branch as a single map key. The NUL separator can't occur in
 * either half, and the sentinel keeps a missing branch from colliding with an
 * empty one — so key equality means exactly what `a.repo === b.repo &&
 * a.branch === b.branch` meant.
 */
function branchKey(repo: string, branch: string | null | undefined): string {
  return `${repo}\u0000${branch ?? "\u0001"}`;
}

/**
 * Live sessions that OWN a PR's branch, indexed by repo+branch.
 *
 * Built once per queue instead of re-derived per PR. This used to be a
 * predicate run inside `prs.flatMap(sessions.filter(...))` — 270 open PRs
 * against 6,107 sessions is 3.3M calls, and each one re-scanned the session's
 * pr/attached/linked arrays, so a single rebuild blocked the main thread for
 * ~270ms. It reruns on every sessions update (the memo below keys on the
 * `sessions` array, which is a fresh identity each time), which put a
 * multi-hundred-millisecond stall into whatever the reader was doing —
 * scrolling a transcript, most visibly.
 *
 * Ownership is two things, both indexed here. A session normally owns its own
 * repo + branch. But a `github-pr-review` session checks the PR out on a
 * derived `<head>-os-review` branch, so its own branch never equals the PR's
 * head; the server resolves the real head (sessionPrBranch) and records it as
 * that session's `primary` PR ref, so that ref — and only that ref — also
 * counts as owning the branch. Attached, linked and non-primary discovered
 * refs are deliberately NOT ownership.
 *
 * Archived sessions are dropped up front: the only caller wants the newest
 * live owner.
 */
function indexOwnedBranches(
  sessions: UnifiedSession[],
): Map<string, UnifiedSession[]> {
  const index = new Map<string, UnifiedSession[]>();
  for (const session of sessions) {
    if (session.archived) continue;
    // A session can reach the same branch twice (its own, and a primary ref
    // naming it); it should still appear once under that key.
    const keys = new Set<string>([
      branchKey(sessionRepo(session), session.branch),
    ]);
    for (const ref of session.prs || [])
      if (ref.source === "primary") keys.add(branchKey(ref.repo, ref.branch));
    for (const key of keys) {
      const owners = index.get(key);
      if (owners) owners.push(session);
      else index.set(key, [session]);
    }
  }
  return index;
}

function newest(sessions: UnifiedSession[]): UnifiedSession | null {
  return (
    [...sessions].sort((a, b) =>
      (b.lastActivity || "").localeCompare(a.lastActivity || ""),
    )[0] || null
  );
}

function classify(
  pr: ReviewQueuePr,
  source: ReviewSource,
): Pick<ReviewQueueItem, "bucket" | "status"> {
  const checks = pr.checks;
  const decision = (pr.reviewDecision || "").toUpperCase();
  const conflicting = pr.mergeable === "CONFLICTING";
  // No reported checks means no known CI blocker. This matches the merge action
  // elsewhere in the sidebar and avoids parking PRs outside the rollup window.
  const green = checks.failed === 0 && checks.pending === 0;

  if (pr.isDraft) return { bucket: "waiting", status: "Draft" };
  if (conflicting) return { bucket: "attention", status: "Merge conflict" };
  if (checks.failed > 0)
    return {
      bucket: "attention",
      status: `${checks.failed} failing`,
    };
  if (decision === "CHANGES_REQUESTED")
    return { bucket: "attention", status: "Changes requested" };
  if (pr.reviewActive) return { bucket: "waiting", status: "Review running" };
  if (source === "requested")
    return { bucket: "attention", status: "Review requested" };
  if (source === "automation" && decision !== "APPROVED") {
    return green
      ? { bucket: "attention", status: "Review needed" }
      : checks.pending > 0
        ? { bucket: "waiting", status: `${checks.pending} running` }
        : { bucket: "waiting", status: "Checks unknown" };
  }
  if (green && (source === "mine" || decision === "APPROVED")) {
    return {
      bucket: "ready",
      status: decision === "APPROVED" ? "Approved" : "Green",
    };
  }
  if (checks.pending > 0)
    return { bucket: "waiting", status: `${checks.pending} running` };
  if (checks.total === 0)
    return { bucket: "waiting", status: "Checks unknown" };
  return { bucket: "waiting", status: "Awaiting review" };
}

/**
 * The person key a display name maps to ("Kent de Bruin" → "kent") — the same
 * normalization the server applies when it turns GitHub logins into the person
 * keys carried by `prReviewRequested` / `prReviewedBy`.
 */
export function personKey(name: string): string {
  return name.trim().split(/\s+/)[0]?.toLowerCase() || "";
}

/**
 * Build one actionable row per open PR. Source is about why the PR belongs in
 * this person's inbox; bucket is about what they can do with it right now.
 */
export function buildReviewQueue(
  prs: ReviewQueuePr[],
  sessions: UnifiedSession[],
  currentUser: string,
  githubLogin: string | null,
): ReviewQueueItem[] {
  const me = personKey(currentUser);
  const github = githubLogin?.toLowerCase() || "";
  const seen = new Set<string>();
  const items: ReviewQueueItem[] = [];
  const ownersByBranch = indexOwnedBranches(sessions);

  for (const pr of prs) {
    if (!pr.url || seen.has(pr.url)) continue;
    seen.add(pr.url);

    // Only the newest owner is used, below. There used to be a wider
    // `related` pass here (every session touching this PR through any
    // attached/linked/discovered ref) that existed solely to be re-filtered
    // down to these owners — and owning a branch already implies touching
    // it, so it never changed the answer. Dropping it removes a second full
    // scan of every session, per PR.
    const owners = ownersByBranch.get(branchKey(pr.repo, pr.branch)) || [];
    const automation = isBotAuthor(pr.author);
    const requested = (pr.reviewRequested || []).some(
      (person) => person.toLowerCase() === me,
    );
    const mine = !automation && !!github && pr.author.toLowerCase() === github;
    const source: ReviewSource = requested
      ? "requested"
      : automation
        ? "automation"
        : mine
          ? "mine"
          : "other";
    const state = classify(pr, source);

    items.push({
      pr,
      sessionId: newest(owners)?.id || null,
      source,
      ...state,
    });
  }

  return items.sort((a, b) =>
    (b.pr.updatedAt || "").localeCompare(a.pr.updatedAt || ""),
  );
}
