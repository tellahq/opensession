import {
  fetchCommit,
  fetchOpenPrs,
  fetchRecentPr,
  fetchSession,
  type CommitDetails,
  type OpenPr,
  type RecentPr,
} from "./api";
import type { OsReview, UnifiedSession } from "./types";

/**
 * What a transcript chip's hover card knows.
 *
 * Session chips (`os-019f…`) and PR chips (`opensession#128`) are rendered by
 * markdown.ts into an HTML string, so neither can own a popover the way a
 * sidebar row does. One document-level watcher raises a single card off the
 * hovered anchor instead (components/ChipHoverCard.tsx), and this module
 * answers what that card should say.
 *
 * Everything comes from data the app already holds, since the polled session
 * list covers most chips. One lazy, cached fetch behind each kind answers for
 * the rest: a session that has been archived out of the list, and a PR that no
 * loaded session owns. A commit reference is the one kind nothing here already
 * knows, so it is always the fetch (server/commit-lookup.ts reads it off the
 * checkout).
 */

export type ChipTarget =
  | { kind: "session"; key: string; id: string }
  | { kind: "pr"; key: string; repo: string; number: number }
  | { kind: "commit"; key: string; repo?: string; sha: string };

/** The chips a card can be raised on. Each carries the ids the card needs.
 *  A commit reference is not always an anchor: with no GitHub page to open it
 *  renders as a focusable term instead, and the card is all it has to say. */
export const CHIP_SELECTOR =
  "a.session-link[data-session-id], a.pr-ref[data-pr-number], .commit-ref[data-commit-sha]";

/** What the hovered anchor points at, or null when it says too little. */
export function chipTarget(el: HTMLElement): ChipTarget | null {
  const id = el.dataset.sessionId;
  if (id) return { kind: "session", key: `session:${id}`, id };
  const sha = el.dataset.commitSha;
  if (sha) {
    const repo = el.dataset.commitRepo || undefined;
    return { kind: "commit", key: `commit:${repo ?? ""}@${sha}`, repo, sha };
  }
  const repo = el.dataset.prRepo;
  const number = Number(el.dataset.prNumber);
  if (repo && Number.isInteger(number))
    return { kind: "pr", key: `pr:${repo}#${number}`, repo, number };
  return null;
}

/**
 * One PR, assembled from wherever this client already knows it. Shaped to be
 * readable by the PR vocabulary the rest of the app shares: `refTone` and
 * `refState` (lib/pr-refs.ts) take exactly the state/draft/review/checks
 * quartet, so the chip card words a PR the way every other surface does.
 */
export type ChipPr = {
  repo: string;
  number: number;
  title?: string;
  url?: string;
  branch?: string;
  author?: string;
  state?: "OPEN" | "MERGED" | "CLOSED";
  isDraft?: boolean;
  reviewDecision?: string;
  mergeable?: string;
  checks?: { total: number; passed: number; failed: number; pending: number };
  osReview?: OsReview;
  reviewRequested?: string[];
  createdAt?: string;
  updatedAt?: string;
  additions?: number;
  deletions?: number;
  /** The session that opened it, when one of ours did. */
  session?: UnifiedSession;
};

/** The PR as a session in the list knows it: its own branch's PR first, then
 *  the PRs a session merely spans (attached repos, linked, discovered). */
function prFromSessions(
  repo: string,
  number: number,
  sessions: UnifiedSession[],
): ChipPr | null {
  for (const s of sessions) {
    if (s.repo !== repo || s.prNumber !== number) continue;
    return {
      repo,
      number,
      title: s.prTitle,
      url: s.prUrl,
      branch: s.branch || undefined,
      author: s.prAuthor,
      state: s.prState,
      isDraft: s.prIsDraft,
      reviewDecision: s.prReviewDecision,
      mergeable: s.prMergeable,
      checks: s.prChecks,
      osReview: s.prOsReview,
      reviewRequested: s.prReviewRequested,
      updatedAt: s.prUpdatedAt,
      additions: s.prAdditions,
      deletions: s.prDeletions,
      session: s,
    };
  }
  for (const s of sessions) {
    for (const ref of s.prs || []) {
      if (ref.repo !== repo || ref.number !== number) continue;
      return {
        repo,
        number,
        title: ref.title,
        url: ref.url,
        branch: ref.branch,
        state: ref.state,
        isDraft: ref.isDraft,
        reviewDecision: ref.reviewDecision,
        mergeable: ref.mergeable,
        checks: ref.checks,
        additions: ref.additions,
        deletions: ref.deletions,
        session: s,
      };
    }
  }
  return null;
}

/**
 * Everything known about the PR a chip names. The open-PR list is the rich
 * half (review requests and automated review), while recent history is the
 * lifecycle authority and keeps merged/closed PRs available after their
 * workspace leaves the live session list.
 */
export function chipPr(
  repo: string,
  number: number,
  sessions: UnifiedSession[],
  openPrs: OpenPr[],
  recentPrs: RecentPr[] = [],
): ChipPr | null {
  const mine = prFromSessions(repo, number, sessions);
  const open = openPrs.find((p) => p.repo === repo && p.number === number);
  const recent = recentPrs.find((p) => p.repo === repo && p.number === number);
  const terminal =
    recent?.state === "MERGED" || recent?.state === "CLOSED" ? recent : null;
  if (!mine && !open && !recent) return null;
  return {
    repo,
    number,
    title: recent?.title || mine?.title || open?.title,
    url: recent?.url || mine?.url || open?.url,
    branch: recent?.branch || mine?.branch || open?.branch,
    author: recent?.author || mine?.author || open?.author,
    state:
      terminal?.state ??
      mine?.state ??
      recent?.state ??
      (open ? "OPEN" : undefined),
    isDraft: terminal
      ? terminal.isDraft
      : (mine?.isDraft ?? recent?.isDraft ?? open?.isDraft),
    reviewDecision:
      mine?.reviewDecision || recent?.reviewDecision || open?.reviewDecision,
    mergeable: mine?.mergeable || recent?.mergeable || open?.mergeable,
    checks: mine?.checks ?? recent?.checks ?? open?.checks,
    osReview: mine?.osReview ?? open?.osReview ?? recent?.osReview,
    reviewRequested:
      recent?.reviewRequested ?? mine?.reviewRequested ?? open?.reviewRequested,
    createdAt: recent?.createdAt || open?.createdAt,
    updatedAt: recent?.updatedAt || mine?.updatedAt || open?.updatedAt,
    additions: recent?.additions ?? mine?.additions,
    deletions: recent?.deletions ?? mine?.deletions,
    session: mine?.session,
  };
}

/** A card is only worth raising over the chip's own tooltip once it can name
 *  the PR. Numbers and a repo id are what the chip already says. */
export function chipPrIsWorthShowing(pr: ChipPr | null): pr is ChipPr {
  return !!pr?.title;
}

// ── Lazy sources ────────────────────────────────────────────────────────────
//
// Both are hover-driven, so they fetch on first need rather than polling, and
// both cache: a pointer crossing a paragraph of chips must not become a burst
// of requests.

const PRS_TTL_MS = 60_000;
let openPrs: OpenPr[] = [];
let openPrsAt = 0;
let openPrsInFlight: Promise<OpenPr[]> | null = null;
const recentPrs = new Map<string, { pr: RecentPr | null; at: number }>();
const recentPrsInFlight = new Map<string, Promise<RecentPr | null>>();

/** The open PRs already fetched, for the synchronous first look. */
export function cachedOpenPrs(): OpenPr[] {
  return openPrs;
}

export function loadOpenPrs(): Promise<OpenPr[]> {
  if (Date.now() - openPrsAt < PRS_TTL_MS) return Promise.resolve(openPrs);
  if (!openPrsInFlight)
    openPrsInFlight = fetchOpenPrs()
      .then((prs) => {
        openPrs = prs;
        openPrsAt = Date.now();
        return prs;
      })
      .finally(() => {
        openPrsInFlight = null;
      });
  return openPrsInFlight;
}

function recentPrKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/** Recent history already fetched for the synchronous first look on hover. */
export function cachedRecentPr(repo: string, number: number): RecentPr | null {
  return recentPrs.get(recentPrKey(repo, number))?.pr ?? null;
}

export function cachedRecentPrs(): RecentPr[] {
  return [...recentPrs.values()]
    .map(({ pr }) => pr)
    .filter((pr): pr is RecentPr => pr !== null);
}

/** Fold the periodic recent list into the same per-PR cache lazy hover uses. */
export function cacheRecentPrs(prs: RecentPr[]): void {
  const at = Date.now();
  for (const pr of prs)
    recentPrs.set(recentPrKey(pr.repo, pr.number), { pr, at });
}

export function loadRecentPr(
  repo: string,
  number: number,
): Promise<RecentPr | null> {
  const key = recentPrKey(repo, number);
  const cached = recentPrs.get(key);
  if (cached && Date.now() - cached.at < PRS_TTL_MS)
    return Promise.resolve(cached.pr);
  const pending = recentPrsInFlight.get(key);
  if (pending) return pending;
  const request = fetchRecentPr(repo, number)
    .then((pr) => {
      recentPrs.set(key, { pr, at: Date.now() });
      return pr;
    })
    .finally(() => {
      recentPrsInFlight.delete(key);
    });
  recentPrsInFlight.set(key, request);
  return request;
}

// Sessions the list doesn't carry (archived, or someone else's standalone).
// Null is cached too, so a chip pointing at a deleted session does not retry
// on every hover.
const fetchedSessions = new Map<string, UnifiedSession | null>();
const sessionsInFlight = new Map<string, Promise<UnifiedSession | null>>();

export function cachedChipSession(id: string): UnifiedSession | null {
  return fetchedSessions.get(id) ?? null;
}

// Commits. Nothing the app polls carries these, so every reference is a
// lookup, cached hard: a sha is immutable, and a pointer crossing a
// paragraph of them must not become a burst of requests. A miss is cached too:
// 2% of sha-shaped codespans name a commit no checkout here has, and those
// must not retry on every hover.
const fetchedCommits = new Map<string, CommitDetails | null>();
const commitsInFlight = new Map<string, Promise<CommitDetails | null>>();

function commitKey(sha: string, repo?: string): string {
  return `${repo ?? ""}@${sha}`;
}

export function cachedChipCommit(
  sha: string,
  repo?: string,
): CommitDetails | null {
  return fetchedCommits.get(commitKey(sha, repo)) ?? null;
}

/** Whether this sha has already been answered, either way. Distinguishes "not
 *  fetched yet" from "fetched, and no checkout has it". */
export function chipCommitResolved(sha: string, repo?: string): boolean {
  return fetchedCommits.has(commitKey(sha, repo));
}

/**
 * Fold what the lookup learned back into the reference in the page.
 *
 * Two corrections, both of which only the answer can make. The reference was
 * rendered with the repo it was WRITTEN in, which is the right guess almost
 * every time but not always, so a cross-repo sha stops pointing at a 404. And
 * a sha no checkout has drops the affordance markdown.ts gave it: the dotted
 * underline promises a definition, and this one has none.
 */
export function applyChipCommit(
  el: HTMLElement,
  commit: CommitDetails | null,
): void {
  if (!commit) {
    el.dataset.commitUnknown = "";
    return;
  }
  delete el.dataset.commitUnknown;
  if (commit.url && el instanceof HTMLAnchorElement && el.href !== commit.url)
    el.href = commit.url;
}

export function loadChipCommit(
  sha: string,
  repo?: string,
): Promise<CommitDetails | null> {
  const key = commitKey(sha, repo);
  if (fetchedCommits.has(key))
    return Promise.resolve(fetchedCommits.get(key) ?? null);
  const pending = commitsInFlight.get(key);
  if (pending) return pending;
  const request = fetchCommit(sha, repo)
    .catch(() => null)
    .then((commit) => {
      fetchedCommits.set(key, commit);
      return commit;
    })
    .finally(() => {
      commitsInFlight.delete(key);
    });
  commitsInFlight.set(key, request);
  return request;
}

export function loadChipSession(id: string): Promise<UnifiedSession | null> {
  if (fetchedSessions.has(id))
    return Promise.resolve(fetchedSessions.get(id) ?? null);
  const pending = sessionsInFlight.get(id);
  if (pending) return pending;
  const request = fetchSession(id)
    .then((session) => {
      fetchedSessions.set(id, session);
      return session;
    })
    .catch(() => null)
    .finally(() => {
      sessionsInFlight.delete(id);
    });
  sessionsInFlight.set(id, request);
  return request;
}
