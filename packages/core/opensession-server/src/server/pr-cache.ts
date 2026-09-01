/**
 * GitHub PR bulk cache — repo id → branch → rich PR info, extracted verbatim
 * from sessions.ts. Owns the 60s batched refresh (with ETag change probes and
 * rate-limit backoff), the on-disk snapshot, close/merge tombstones and review
 * mutations that keep the cache coherent between sweeps, the webhook
 * write-through, and the derived queue views (getOpenPrs / getRecentPrs /
 * getRecentPrsForPerson). sessions.ts re-exports the public surface so
 * existing consumers keep importing from there; getAllSessions consumes
 * getPrsByRepo/prsBySessionRef/footerPrsFor/lastReviewSummary directly.
 * Live state parks on globalThis (same keys as before the extraction) so hot
 * reloads keep it.
 */
import { chmodSync, readFileSync } from "fs";
import { statePath } from "./paths";
import { githubLoginToPersonKey, githubLoginFor } from "./shared/user-mappings";
import { configuredRepos, githubBotLogins } from "./config";
import {
  isLockHeld,
  readPrState,
  type LastReviewState,
} from "../agents/github/state";
import { ghRateLimited } from "./github-limit";
import {
  ghJson,
  hostRepoId,
  prHostFor,
  type BulkPr,
  type PrHostCapabilities,
} from "./pr-host";
import { writeJsonAtomic } from "./shared/atomic-write";
import {
  cachedReviewTeamLogins,
  fetchReviewTeamLogins,
  reviewRequestPersonKeys,
  type ReviewRequestRef,
} from "./github-review-requests";
import type { UnifiedSession, OsReviewSummary } from "./types";

// PR cache: branch → rich PR info, refreshed every 60s. A single batched
// `gh pr list` carries everything the Reviews table renders as columns
// (diffstat, review decision, author), so the list never has to N+1 fetch per
// PR — only the detail pane does. The bulk cache carries NO CI checks: the
// statusCheckRollup bulk query cost ~111 GraphQL points per refresh (rollup
// cost scales with check runs) and alone exhausted the 5000/hr GraphQL quota
// — real checks come from the cheap per-PR detail query (pr-info.ts).
interface PrChecksSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
}
export interface PrInfo {
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  number: number;
  title: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  checks: PrChecksSummary;
  /** Current head SHA, so a stored review verdict can be told apart from one
   *  the branch has since moved past. Absent on rows from an older snapshot. */
  headRefOid?: string;
  /** MERGEABLE | CONFLICTING | UNKNOWN — GitHub's async conflict probe. */
  mergeable: string;
  /** Person keys ("kent") of teammates with a pending review request. */
  reviewRequested: string[];
  /** Person keys whose latest submitted PR review stands (approved /
   *  changes requested / commented). Populated for open PRs only. */
  reviewedBy: string[];
  /** Assignee GitHub logins — bot-authored PRs carry the requester here. */
  assignees: string[];
  /** Session id parsed out of the PR body's attribution footer, when the PR
   *  was opened from a session (see sessionRefFromPrBody). Parsed from the
   *  open-PR query only (only that query carries the body); after the PR
   *  closes, the refresh carries the ref forward from the previous row. */
  sessionRef?: string;
}

/**
 * The session id out of the attribution footer every session-opened PR carries
 * ("Started by … in [this session](<public base URL>/session/<id>)",
 * written by pi-runner/system-prompt). This is how a session finds the
 * PRs it opened on branches it doesn't own — a second branch of its own repo,
 * or a repo it never attached.
 *
 * Deliberately anchored on the footer's link text: a body that merely links to
 * some session in passing must not claim the PR for it.
 */
export function sessionRefFromPrBody(
  body: string | null | undefined,
): string | undefined {
  const m = body?.match(
    /\[this [^\]]*session\]\((?:https?:\/\/[^)\s]+?)?\/session\/([A-Za-z0-9._-]+)/i,
  );
  return m?.[1];
}
function prRepos() {
  return Object.values(configuredRepos())
    .filter((repo) => hostRepoId(repo) && repo.prCache !== false)
    .map((repo) => ({
      id: repo.id,
      // The host-side repo identifier (field keeps its historical name — it
      // keys probe cursors and cache tombstones): GitHub owner/name, or the
      // code.storage repo id for host: "codestorage" rows.
      ghRepo: hostRepoId(repo),
      openLimit: repo.prCacheOpenLimit ?? 100,
      recentLimit: repo.prCacheRecentLimit ?? 500,
      host: prHostFor(repo),
      // GitHub-API-backed repos share gh's rate-limit backoff; code.storage
      // tokens are self-signed (no shared quota), so the sweep's
      // ghRateLimited() gates must not freeze those rows.
      ghBacked: repo.host !== "codestorage",
    }));
}

// repo id → branch → PR info. Keyed per repo so the same branch name in two
// repos (multi-repo sessions share branch names) never collides.
let prCache: { data: Map<string, Map<string, PrInfo>>; ts: number } = {
  data: new Map(),
  ts: 0,
};
const PR_CACHE_TTL = 60_000;
// How long a merged/closed row survives in the bulk cache after the sweep's
// queries stop returning it (see the carry-forward in refreshPrCacheInner).
const PR_CARRY_FORWARD_MS = 180 * 24 * 60 * 60 * 1000;
let prRefreshPromise: Promise<Set<string>> | null = null;
const prCloseState: {
  generation: number;
  closed: Map<string, number>;
  merged: Map<string, number>;
} = ((globalThis as any).__opensessionPrCloseState ??= {
  generation: 0,
  closed: new Map(),
  merged: new Map(),
});
// A hot reload can hand back an object parked before `merged` existed.
prCloseState.merged ??= new Map();
type CachedReviewMutation = {
  generation: number;
  person: string;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
};
const prReviewState: {
  generation: number;
  reviews: Map<string, CachedReviewMutation>;
  /** PRs whose review requests were withdrawn in OS1 → the generation at
   *  which that happened, same staleness guard the reviews above use. */
  cleared: Map<string, number>;
} = ((globalThis as any).__opensessionPrReviewState ??= {
  generation: 0,
  reviews: new Map(),
  cleared: new Map(),
});
// A hot reload can hand back an object parked before `cleared` existed.
prReviewState.cleared ??= new Map();

function closeTombstoneKey(ghRepo: string, number: number): string {
  return `${ghRepo}#${number}`;
}

/** A merge tombstone for a branch whose PR number we don't know — the cache
 *  had no row for it. Deliberately a different shape from closeTombstoneKey so
 *  the two can share `prCloseState.merged`: a branch literally named "#123"
 *  keys as `owner/repo@#123`, never as `owner/repo#123`. */
function mergedBranchTombstoneKey(ghRepo: string, branch: string): string {
  return `${ghRepo}@${branch}`;
}

function reviewMutationKey(
  ghRepo: string,
  number: number,
  person: string,
): string {
  return `${ghRepo}#${number}#${person}`;
}

// The cache is also snapshotted to disk after every successful refresh and
// seeded from there on boot. Without this, a restart during a GitHub outage or
// rate-limit window boots with an empty cache that no refresh can fill, and the
// sidebar's PR queue silently vanishes (2026-07-22). ts stays 0 so the first
// access still refreshes immediately; the snapshot only serves as stale data.
// Resolved per call (not a module-load const) so a snapshot written after the
// state root changed — a test's scratch HOME, a demo instance's state dir —
// is read from the right place by an explicit loadPrCacheSnapshot() call.
const prCacheFile = () => statePath(".opensession-pr-cache.json");
const PR_CACHE_VERSION = 5;
const DURABLE_CACHE_MAX_AGE_MS = 30 * 60_000;
const probeEtags = new Map<string, string>(); // ghRepo → last seen ETag
const lastFullRefresh = new Map<string, number>(); // repo id → epoch ms
/**
 * Seed the bulk cache from its on-disk snapshot. Runs once at module load;
 * also exported because a demo instance writes its snapshot at the END of
 * boot (startDemo), long after this module was evaluated — without a reseed
 * the demo PR exists on disk but never in memory, so the PR panel and Home's
 * PR rows stay empty (2026-08-05).
 */
export function loadPrCacheSnapshot(): void {
  try {
    const parsed = JSON.parse(readFileSync(prCacheFile(), "utf8"));
    const raw: Record<string, Record<string, PrInfo>> = [
      2,
      3,
      4,
      PR_CACHE_VERSION,
    ].includes(parsed?.version) && parsed?.repos
      ? parsed.repos
      : parsed;
    prCache.data = new Map(
      Object.entries(raw).map(([repo, byBranch]) => [
        repo,
        new Map(Object.entries(byBranch)),
      ]),
    );
    // Older snapshots either used smaller history windows or predate expanded
    // team review requests. Keep their stale rows available, but skip refresh
    // timestamps so the current shape refills immediately.
    if (parsed?.version === PR_CACHE_VERSION) {
      const now = Date.now();
      let durableRepos = 0;
      const repos = prRepos();
      for (const repo of repos) {
        if (!prCache.data.has(repo.id)) continue;
        if (parsed.recentLimits?.[repo.id] !== repo.recentLimit) continue;
        if (parsed.openLimits?.[repo.id] !== repo.openLimit) continue;
        const etag = parsed.probeEtags?.[repo.ghRepo];
        if (typeof etag === "string" && etag) probeEtags.set(repo.ghRepo, etag);
        const refreshedAt = parsed.lastFullRefresh?.[repo.id];
        if (
          typeof refreshedAt === "number" &&
          Number.isFinite(refreshedAt) &&
          refreshedAt > 0 &&
          refreshedAt <= now + 60_000
        ) {
          lastFullRefresh.set(repo.id, refreshedAt);
          if (now - refreshedAt < DURABLE_CACHE_MAX_AGE_MS) durableRepos++;
        }
      }
      // Keep the snapshot hot across a restart only when every configured repo is
      // represented with the current query bounds and a recent full refresh.
      // Otherwise first access reconciles immediately, preserving multi-repo correctness.
      if (repos.length > 0 && durableRepos === repos.length) prCache.ts = now;
    }
  } catch {}
}
loadPrCacheSnapshot();

function persistPrCache(data: Map<string, Map<string, PrInfo>>) {
  try {
    const obj: Record<string, Record<string, PrInfo>> = {};
    for (const [repo, byBranch] of data)
      obj[repo] = Object.fromEntries(byBranch);
    writeJsonAtomic(
      prCacheFile(),
      {
        version: PR_CACHE_VERSION,
        repos: obj,
        recentLimits: Object.fromEntries(
          prRepos().map((repo) => [repo.id, repo.recentLimit]),
        ),
        openLimits: Object.fromEntries(
          prRepos().map((repo) => [repo.id, repo.openLimit]),
        ),
        probeEtags: Object.fromEntries(probeEtags),
        lastFullRefresh: Object.fromEntries(lastFullRefresh),
      },
      false,
    );
    chmodSync(prCacheFile(), 0o600);
  } catch (e) {
    console.error("Failed to persist PR cache:", e);
  }
}

/** Keep the repo-wide PR queue coherent after a human closes a PR in OS1. */
export function markCachedPrClosed(ghRepo: string, number: number): void {
  prCloseState.generation++;
  prCloseState.closed.set(
    closeTombstoneKey(ghRepo, number),
    prCloseState.generation,
  );
  const repoId = prRepos().find((repo) => repo.ghRepo === ghRepo)?.id;
  if (!repoId) return;
  const byBranch = prCache.data.get(repoId);
  if (!byBranch) return;
  for (const [branch, pr] of byBranch) {
    if (pr.number !== number) continue;
    // In place, like every other write-through here: an in-flight sweep holds
    // this inner Map as its `stale` reference and re-installs that same object
    // on its skip paths, so the mutation reaches both. Never swap in a copy.
    byBranch.set(branch, {
      ...pr,
      state: "CLOSED",
      updatedAt: new Date().toISOString(),
    });
    prCache.ts = Date.now();
    persistPrCache(prCache.data);
    return;
  }
}

/**
 * Keep the repo-wide PR queue coherent after a human merges a PR in OS1 — the
 * merge counterpart of markCachedPrClosed. Without it the row keeps its
 * pre-merge OPEN state (green "ready to merge" instead of purple "Done") until
 * the throttled bulk sweep or a GitHub webhook catches up, because
 * getPrsByRepo is stale-while-revalidate: invalidating the sessions cache
 * rebuilds the list off the same unrefreshed PR data.
 */
export function markCachedPrMerged(ghRepo: string, branch: string): void {
  // Record the overlay BEFORE any lookup can bail, exactly as the close path
  // does: a merge on a branch the cache has no row for (the stack-merge loop
  // in routes/pr.ts walks layers owned by other sessions, which are the ones
  // most likely to be missing) must still beat an in-flight sweep's pre-merge
  // OPEN row. Keyed by branch here because the PR number is only knowable
  // from the cached row; applyPrCloseTombstones checks both key shapes.
  prCloseState.generation++;
  prCloseState.merged.set(
    mergedBranchTombstoneKey(ghRepo, branch),
    prCloseState.generation,
  );
  const repoId = prRepos().find((repo) => repo.ghRepo === ghRepo)?.id;
  if (!repoId) return;
  const byBranch = prCache.data.get(repoId);
  const pr = byBranch?.get(branch);
  if (!byBranch || !pr) return;
  prCloseState.merged.set(
    closeTombstoneKey(ghRepo, pr.number),
    prCloseState.generation,
  );
  // Mutates the LIVE inner Map in place, deliberately: a sweep already in
  // flight holds this same object as its `stale` reference and re-installs it
  // unchanged on its skip paths, so the write is visible through both. Never
  // swap in a fresh Map here.
  byBranch.set(branch, {
    ...pr,
    state: "MERGED",
    isDraft: false,
    updatedAt: new Date().toISOString(),
  });
  prCache.ts = Date.now();
  persistPrCache(prCache.data);
}

/**
 * Keep the sidebar's repo-wide PR cache coherent after a review submitted in
 * OS1. The bulk GitHub sweep is intentionally throttled and can otherwise keep
 * a completed request visible for up to 30 minutes.
 */
export function markCachedPrReviewed(
  ghRepo: string,
  branch: string,
  person: string,
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
): void {
  const reviewer = person.trim().toLowerCase();
  if (!reviewer) return;
  const repoId = prRepos().find((repo) => repo.ghRepo === ghRepo)?.id;
  if (!repoId) return;
  const byBranch = prCache.data.get(repoId);
  if (!byBranch) return;
  const pr = byBranch.get(branch);
  if (!pr) return;
  prReviewState.generation++;
  prReviewState.reviews.set(reviewMutationKey(ghRepo, pr.number, reviewer), {
    generation: prReviewState.generation,
    person: reviewer,
    event,
  });
  byBranch.set(branch, applyCachedReview(pr, reviewer, event));
  prCache.ts = Date.now();
  persistPrCache(prCache.data);
}

/**
 * Keep the sidebar's repo-wide PR cache coherent after OS1 withdraws every
 * pending review request on a PR (the info panel's "Clear review request",
 * which also clears GitHub's own Reviewers list). Same reasoning as
 * markCachedPrReviewed: the bulk sweep is throttled, so without this the chip
 * keeps reporting reviewers that are already gone for up to 30 minutes.
 */
export function markCachedPrReviewRequestsCleared(
  ghRepo: string,
  branch: string,
): void {
  const repoId = prRepos().find((repo) => repo.ghRepo === ghRepo)?.id;
  if (!repoId) return;
  const byBranch = prCache.data.get(repoId);
  const pr = byBranch?.get(branch);
  if (!byBranch || !pr) return;
  prReviewState.generation++;
  prReviewState.cleared.set(
    reviewMutationKey(ghRepo, pr.number, "*"),
    prReviewState.generation,
  );
  byBranch.set(branch, { ...pr, reviewRequested: [] });
  prCache.ts = Date.now();
  persistPrCache(prCache.data);
}

function applyCachedReview(
  pr: PrInfo,
  person: string,
  event: CachedReviewMutation["event"],
): PrInfo {
  return {
    ...pr,
    reviewDecision:
      event === "APPROVE"
        ? "APPROVED"
        : event === "REQUEST_CHANGES"
          ? "CHANGES_REQUESTED"
          : pr.reviewDecision,
    reviewRequested: pr.reviewRequested.filter(
      (reviewer) => reviewer !== person,
    ),
    reviewedBy: pr.reviewedBy.includes(person)
      ? pr.reviewedBy
      : [...pr.reviewedBy, person],
  };
}

function applyPrCloseTombstones(
  data: Map<string, Map<string, PrInfo>>,
  refreshGeneration: number,
  authoritativeRepos: Set<string>,
): void {
  for (const tombstones of [prCloseState.closed, prCloseState.merged])
    for (const [key, generation] of tombstones) {
      // A refresh that began after this close/merge AND actually re-queried
      // the repo is authoritative. Earlier refreshes retain the tombstone so
      // their pre-close OPEN result cannot win the race; so do sweeps that
      // skipped this repo entirely (rate limit, unchanged probe, failed open
      // query), which never observed the close at all. Same authority rule
      // the review mutations below use.
      // Two key shapes live in these maps: `owner/repo#<number>` from
      // closeTombstoneKey, and `owner/repo@<branch>` from
      // mergedBranchTombstoneKey (a merge recorded before any cached row
      // named the number). Cut at whichever separator comes first — a
      // ghRepo holds neither character, a branch may hold "@".
      const cut = key.search(/[#@]/);
      const ghRepo = cut === -1 ? key : key.slice(0, cut);
      const repoId = prRepos().find((repo) => repo.ghRepo === ghRepo)?.id;
      if (
        generation <= refreshGeneration &&
        repoId &&
        authoritativeRepos.has(repoId)
      )
        tombstones.delete(key);
    }
  for (const repo of prRepos()) {
    const byBranch = data.get(repo.id);
    if (!byBranch) continue;
    for (const [branch, pr] of byBranch) {
      const key = closeTombstoneKey(repo.ghRepo, pr.number);
      // Merged wins: GitHub reports a merged PR as closed too. A merge of a
      // branch the cache had no row for is tombstoned by branch instead of
      // number, so check that shape too — this sweep is the first to see
      // which PR the branch had.
      if (
        prCloseState.merged.has(key) ||
        prCloseState.merged.has(mergedBranchTombstoneKey(repo.ghRepo, branch))
      )
        byBranch.set(branch, { ...pr, state: "MERGED", isDraft: false });
      else if (prCloseState.closed.has(key))
        byBranch.set(branch, { ...pr, state: "CLOSED" });
    }
  }
}

/** Test seam: the overlay pass a sweep applies to its freshly fetched rows,
 *  without spending a real sweep to get there. */
export function __applyPrCloseTombstonesForTest(
  data: Map<string, Map<string, PrInfo>>,
  refreshGeneration: number,
  authoritativeRepos: Set<string> = new Set(),
): void {
  applyPrCloseTombstones(data, refreshGeneration, authoritativeRepos);
}

/** The cached head branch of an open PR, by number — lets webhook events that
 *  carry only a PR number (issue_comment on a PR) resolve the branch the
 *  detail cache is keyed by. */
export function cachedPrBranchByNumber(
  ghRepo: string,
  number: number,
): string | undefined {
  const repoId = prRepos().find(
    (repo) => repo.ghRepo.toLowerCase() === ghRepo.toLowerCase(),
  )?.id;
  const byBranch = repoId ? prCache.data.get(repoId) : undefined;
  if (!byBranch) return undefined;
  for (const [branch, pr] of byBranch) if (pr.number === number) return branch;
  return undefined;
}

// Webhook write-throughs can burst (a push lands synchronize + several check
// events within seconds) — debounce the disk snapshot instead of rewriting it
// per delivery. The in-memory cache is always current; the snapshot only
// matters across restarts.
let prCachePersistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePrCachePersist() {
  if (prCachePersistTimer) return;
  prCachePersistTimer = setTimeout(() => {
    prCachePersistTimer = null;
    persistPrCache(prCache.data);
  }, 5_000);
}

/**
 * Write-through from a GitHub webhook delivery (dispatched by pr-webhook.ts).
 * A `pull_request` payload carries the full PR object, so the bulk-cache row
 * is patched/created without spending any GitHub quota; a
 * `pull_request_review` payload applies the reviewer's verdict through the
 * same mutation the OS1 review UI uses. Fields the payloads don't carry
 * (aggregate review data, checks) keep their cached values until the next
 * bulk sweep. Deliberately does NOT touch prCache.ts: the sweep cadence and
 * its ETag probe stay the authoritative reconciliation loop.
 */
export function applyPrWebhookToBulkCache(
  ghRepo: string,
  event: string,
  payload: any,
): void {
  const hookRepo = prRepos().find(
    (repo) => repo.ghRepo.toLowerCase() === ghRepo.toLowerCase(),
  );
  if (!hookRepo) return;
  const repoId = hookRepo.id;
  // Tombstone keys are built from the configured spelling everywhere else
  // (applyPrCloseTombstones reads them back off prRepos()), and a webhook
  // delivery can carry a different casing.
  const canonicalGhRepo = hookRepo.ghRepo;

  if (event === "pull_request_review") {
    const branch: string | undefined = payload?.pull_request?.head?.ref;
    const person = githubLoginToPersonKey(payload?.review?.user?.login);
    const state = String(payload?.review?.state || "").toUpperCase();
    const reviewEvent =
      state === "APPROVED"
        ? ("APPROVE" as const)
        : state === "CHANGES_REQUESTED"
          ? ("REQUEST_CHANGES" as const)
          : state === "COMMENTED"
            ? ("COMMENT" as const)
            : null;
    if (branch && person && reviewEvent)
      markCachedPrReviewed(canonicalGhRepo, branch, person, reviewEvent);
    return;
  }

  if (event !== "pull_request") return;
  const pr = payload?.pull_request;
  const branch: string | undefined = pr?.head?.ref;
  if (!pr || typeof pr.number !== "number" || !branch) return;
  let byBranch = prCache.data.get(repoId);
  if (!byBranch) {
    byBranch = new Map();
    prCache.data.set(repoId, byBranch);
  }
  const prev = byBranch.get(branch);
  const owner = ghRepo.split("/")[0] || "";
  const reviewRequests: ReviewRequestRef[] = [
    ...(Array.isArray(pr.requested_reviewers) ? pr.requested_reviewers : []),
    ...(Array.isArray(pr.requested_teams) ? pr.requested_teams : []),
  ];
  const requestedTeamSlugs = reviewRequests
    .map((request) => request.slug?.toLowerCase())
    .filter((slug): slug is string => !!slug);
  const teamLoginsBySlug = new Map<string, string[]>();
  for (const slug of requestedTeamSlugs) {
    const logins = cachedReviewTeamLogins(owner, slug);
    if (logins) teamLoginsBySlug.set(slug, logins);
  }
  const unresolvedTeam = requestedTeamSlugs.some(
    (slug) => !teamLoginsBySlug.has(slug),
  );
  const state: PrInfo["state"] =
    pr.merged || pr.merged_at
      ? "MERGED"
      : pr.state === "closed"
        ? "CLOSED"
        : "OPEN";
  // Record the same close/merge overlay the OS1 write-throughs
  // (markCachedPrClosed / markCachedPrMerged) register, so a bulk sweep
  // already in flight when this delivery lands cannot revert the row to its
  // pre-close OPEN state. An OPEN payload drops a standing CLOSED tombstone
  // instead, since the PR is demonstrably open again, but never the MERGED
  // one: GitHub cannot reopen a merged PR, so an OPEN delivery there is an
  // out-of-order one that must not resurrect it.
  const closeKey = closeTombstoneKey(canonicalGhRepo, pr.number);
  if (state === "MERGED") {
    prCloseState.generation++;
    prCloseState.merged.set(closeKey, prCloseState.generation);
  } else if (state === "CLOSED") {
    prCloseState.generation++;
    prCloseState.closed.set(closeKey, prCloseState.generation);
  } else {
    prCloseState.closed.delete(closeKey);
  }
  byBranch.set(branch, {
    url: pr.html_url || prev?.url || "",
    state,
    number: pr.number,
    title: pr.title || prev?.title || "",
    isDraft: !!pr.draft,
    additions:
      typeof pr.additions === "number" ? pr.additions : prev?.additions || 0,
    deletions:
      typeof pr.deletions === "number" ? pr.deletions : prev?.deletions || 0,
    changedFiles:
      typeof pr.changed_files === "number"
        ? pr.changed_files
        : prev?.changedFiles || 0,
    reviewDecision: prev?.reviewDecision || "",
    author: pr.user?.login || prev?.author || "",
    createdAt: pr.created_at || prev?.createdAt || "",
    updatedAt: pr.updated_at || new Date().toISOString(),
    checks: prev?.checks || { total: 0, passed: 0, failed: 0, pending: 0 },
    // REST payloads carry mergeable as true/false/null (computed async).
    mergeable:
      pr.mergeable === true
        ? "MERGEABLE"
        : pr.mergeable === false
          ? "CONFLICTING"
          : prev?.mergeable || "UNKNOWN",
    reviewRequested: [
      ...new Set([
        ...reviewRequestPersonKeys(
          reviewRequests,
          teamLoginsBySlug,
          pr.user?.login,
        ),
        ...(unresolvedTeam ? prev?.reviewRequested || [] : []),
      ]),
    ],
    reviewedBy: prev?.reviewedBy || [],
    assignees: Array.isArray(pr.assignees)
      ? pr.assignees
          .map((a: any) => a?.login)
          .filter((l: any): l is string => !!l)
      : prev?.assignees || [],
    sessionRef: sessionRefFromPrBody(pr.body) ?? prev?.sessionRef,
  });
  schedulePrCachePersist();
  if (unresolvedTeam) {
    void Promise.all(
      requestedTeamSlugs.map((slug) => fetchReviewTeamLogins(owner, slug)),
    ).then((teamLogins) => {
      const current = byBranch?.get(branch);
      if (!current || current.number !== pr.number) return;
      const hydratedTeams = new Map<string, string[]>();
      for (const [index, slug] of requestedTeamSlugs.entries()) {
        const logins = teamLogins[index];
        if (logins) hydratedTeams.set(slug, logins);
      }
      const resolved = reviewRequestPersonKeys(
        reviewRequests,
        hydratedTeams,
        pr.user?.login,
      );
      current.reviewRequested = [
        ...new Set([
          ...resolved,
          ...(teamLogins.some((logins) => logins === null)
            ? current.reviewRequested
            : []),
        ]),
      ];
      schedulePrCachePersist();
    });
  }
}

// Rate-limit backoff is shared across ALL GitHub callers (github-limit.ts):
// when any caller reports exhaustion, this refresh pauses too and keeps
// serving its stale (possibly disk-seeded) snapshot until GitHub's reset.

// ── Cheap change detection for the bulk refresh ──────────────────────────────
// Before burning the expensive bulk list calls (the notifier drives a refresh
// every minute around the clock, even with zero users), ask the host's cheap
// change probe (PrHost.changedSince — for GitHub a conditional REST GET whose
// 304s don't count against the rate limit, so an idle instance polls for
// free) whether anything changed at all. Some mutations may not bump a PR's
// updatedAt, so a full refresh still runs at least every PROBE_MAX_SKIP_MS as
// a safety net.
// Coalesce changes in these active repos: their cursors can change many times
// per minute, while one full sweep costs hundreds of GraphQL points. The probe
// still notices changes every minute, but the full refresh runs at most every
// 10m. The 30m maximum catches rare mutations that do not change `updated_at`
// at all.
const MIN_FULL_REFRESH_MS = 10 * 60_000;
const PROBE_MAX_SKIP_MS = 30 * 60_000;

// GitHub only populates a PR's `reviewDecision` when branch protection *requires*
// a review. A repo with no such rule answers reviewDecision "" even
// after a teammate approves — which left approved-but-unmerged PRs stuck in the
// sidebar's "Awaiting review" band forever (it clears only on APPROVED or MERGED).
// Derive an effective decision from the actual latest review per reviewer,
// matching GitHub's own precedence: any outstanding CHANGES_REQUESTED blocks,
// otherwise any APPROVED counts. COMMENTED / DISMISSED / PENDING don't decide.
// Used only as a fallback — a real reviewDecision (branch-protected repos) wins.
function deriveReviewDecision(
  latestReviews: Array<{ state?: string }> | undefined,
): string {
  let approved = false;
  for (const r of latestReviews || []) {
    const s = (r.state || "").toUpperCase();
    if (s === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
    if (s === "APPROVED") approved = true;
  }
  return approved ? "APPROVED" : "";
}

// Stale-while-revalidate: never block the event loop on gh (it takes ~10s on
// fusion, which used to freeze every agent in the process).
export function getPrsByRepo(): Map<string, Map<string, PrInfo>> {
  if (Date.now() - prCache.ts >= PR_CACHE_TTL) void refreshPrCache();
  return prCache.data;
}

/** The bot credential's GitHub account — PRs the bot opens without a per-user
 *  token are authored by it (mirrors analytics.ts's BOT_LOGINS). */
/**
 * PRs grouped by the session id in their attribution footer, keyed session id →
 * refs. Only PRs authored by the bot or a teammate count: a PR body is editable
 * by anyone with write access, and a PR that claims a session becomes actionable
 * (mergeable) from that session's Review tab, so an unattributable author is not
 * allowed to attach itself.
 */
export function prsBySessionRef(
  prsByRepo: Map<string, Map<string, PrInfo>>,
): Map<string, Array<{ repo: string; branch: string; pr: PrInfo }>> {
  const out = new Map<
    string,
    Array<{ repo: string; branch: string; pr: PrInfo }>
  >();
  for (const [repoId, byBranch] of prsByRepo)
    for (const [branch, pr] of byBranch) {
      if (!pr.sessionRef) continue;
      if (
        !githubBotLogins().includes(pr.author.toLowerCase()) &&
        !githubLoginToPersonKey(pr.author)
      )
        continue;
      const list = out.get(pr.sessionRef);
      if (list) list.push({ repo: repoId, branch, pr });
      else out.set(pr.sessionRef, [{ repo: repoId, branch, pr }]);
    }
  return out;
}

/** The footer-linked PRs claiming this session, under its id or any alias. */
export function footerPrsFor(
  bySessionRef: Map<
    string,
    Array<{ repo: string; branch: string; pr: PrInfo }>
  >,
  session: UnifiedSession,
): Array<{ repo: string; branch: string; pr: PrInfo }> {
  const out: Array<{ repo: string; branch: string; pr: PrInfo }> = [];
  for (const id of [session.id, ...(session.aliasIds || [])])
    for (const found of bySessionRef.get(id) || []) out.push(found);
  return out;
}

export function refreshPrCache(): Promise<Set<string>> {
  if (prRefreshPromise) return prRefreshPromise;
  prRefreshPromise = refreshPrCacheInner().finally(() => {
    prRefreshPromise = null;
  });
  return prRefreshPromise;
}

async function refreshPrCacheInner(): Promise<Set<string>> {
  const refreshGeneration = prCloseState.generation;
  const reviewRefreshGeneration = prReviewState.generation;
  const freshRepos = new Set<string>();
  const reviewAuthoritativeRepos = new Set<string>();
  if (ghRateLimited() && prRepos().every((repo) => repo.ghBacked)) {
    // Rate-limited — keep serving the stale snapshot, don't burn calls. Only
    // a full stop when every polled repo is GitHub-backed: code.storage repos
    // have no shared GitHub quota and proceed through the per-repo gate below.
    prCache.ts = Date.now();
    return freshRepos;
  }
  try {
    // A session's branch is matched against open PRs, so we must see EVERY open
    // PR — not just the newest N (the host's listOpenPrs is authoritative for
    // the live set; listRecentPrs covers recently merged/closed for the
    // Reviews "merged" view + sessions whose PR just landed). The BulkPr row
    // shape and the GitHub `gh pr list` queries live in pr-host.ts.
    const next = new Map<string, Map<string, PrInfo>>();
    // The sweep only owns the repos it polls (prRepos: a ghRepo, prCache not
    // disabled). Rows for any OTHER repo — a repo opted out of the bulk cache,
    // or a demo instance's synthetic repo whose PR snapshot was seeded from
    // disk — are carried forward untouched; rebuilding from the polled repos
    // alone silently dropped them on the first refresh after boot.
    const polled = new Set(prRepos().map((repo) => repo.id));
    for (const [repoId, byBranch] of prCache.data)
      if (!polled.has(repoId)) next.set(repoId, byBranch);
    // Keep repos and their two queries sequential. Besides lowering burst cost,
    // this lets a rate-limit response stop the remaining sweep immediately.
    for (const repo of prRepos()) {
      // Skip both GraphQL calls entirely when the conditional REST probe says
      // nothing changed since the last full refresh (bounded by the safety-net
      // interval): an unchanged snapshot is by definition current, so the repo
      // still counts as fresh for notification consumers.
      // `stale` ALIASES the live inner Map, and the skip paths below re-install
      // that same object rather than a copy. That aliasing is load-bearing: a
      // close/merge/review write-through landing while this sweep runs mutates
      // the live Map in place, and only because the object is shared does the
      // mutation survive into `next`. Don't clone it here or on the skips.
      const stale = prCache.data.get(repo.id);
      // The GitHub backoff is a GitHub-API concern: it must not stall
      // code.storage repos, whose calls never touch that quota.
      if (repo.ghBacked && ghRateLimited()) {
        if (stale) next.set(repo.id, stale);
        continue;
      }
      const refreshAge = Date.now() - (lastFullRefresh.get(repo.id) || 0);
      if (stale && refreshAge < PROBE_MAX_SKIP_MS) {
        const probe = await repo.host.changedSince(
          repo.ghRepo,
          probeEtags.get(repo.ghRepo),
        );
        if (probe.cursor) probeEtags.set(repo.ghRepo, probe.cursor);
        if (!probe.changed) {
          next.set(repo.id, stale);
          freshRepos.add(repo.id);
          continue;
        }
        if (refreshAge < MIN_FULL_REFRESH_MS) {
          next.set(repo.id, stale);
          continue;
        }
      }
      // Re-checked after the probe: the probe itself can flag a fresh backoff.
      if (repo.ghBacked && ghRateLimited()) {
        if (stale) next.set(repo.id, stale);
        continue;
      }
      const openPrs = await repo.host.listOpenPrs(repo.ghRepo, {
        limit: repo.openLimit,
      });

      if (!openPrs) {
        // The open list is authoritative. A successful recent-history query
        // cannot prove an open PR disappeared, so preserve this repo's stale
        // snapshot and do not let notification consumers compare against it.
        if (stale) next.set(repo.id, stale);
        continue;
      }
      reviewAuthoritativeRepos.add(repo.id);
      const owner = repo.ghRepo.split("/")[0] || "";
      const requestedTeamSlugs = [
        ...new Set(
          openPrs.flatMap((pr) =>
            (pr.reviewRequests || [])
              .map((request) => request.slug?.toLowerCase())
              .filter((slug): slug is string => !!slug),
          ),
        ),
      ];
      const teamLoginsBySlug = new Map<string, string[]>();
      await Promise.all(
        requestedTeamSlugs.map(async (slug) => {
          const logins = await fetchReviewTeamLogins(owner, slug);
          if (logins) teamLoginsBySlug.set(slug, logins);
        }),
      );
      const recentAll = await repo.host.listRecentPrs(repo.ghRepo, {
        limit: repo.recentLimit,
      });
      freshRepos.add(repo.id);
      lastFullRefresh.set(repo.id, Date.now());

      const reviewByNumber = new Map<number, string>();
      const reviewedByNumber = new Map<number, string[]>();
      for (const r of openPrs) {
        const decision = deriveReviewDecision(r.latestReviews);
        if (decision) reviewByNumber.set(r.number, decision);
        // Teammates whose latest submitted review stands (approve / changes /
        // comment) — lets the sidebar tell "you already gave your review" apart
        // from "still on you" instead of only seeing the aggregate decision.
        const people = new Set<string>();
        for (const rev of r.latestReviews || []) {
          const s = (rev.state || "").toUpperCase();
          if (
            s !== "APPROVED" &&
            s !== "CHANGES_REQUESTED" &&
            s !== "COMMENTED"
          )
            continue;
          const p = githubLoginToPersonKey(rev.author?.login);
          if (p) people.add(p);
        }
        if (people.size) reviewedByNumber.set(r.number, [...people]);
      }

      const toInfo = (pr: BulkPr): PrInfo => ({
        url: pr.url,
        state: pr.state as PrInfo["state"],
        number: pr.number,
        title: pr.title || "",
        isDraft: !!pr.isDraft,
        additions: pr.additions || 0,
        deletions: pr.deletions || 0,
        changedFiles: pr.changedFiles || 0,
        reviewDecision:
          pr.reviewDecision || reviewByNumber.get(pr.number) || "",
        author: pr.author?.login || pr.author?.name || "",
        createdAt: pr.createdAt || "",
        updatedAt: pr.updatedAt || "",
        // Always empty in the bulk cache (see PR_REPO_LIMITS comment) — the UI
        // treats zero checks as "no known CI blocker"; the detail pane has the
        // real rollup.
        checks: { total: 0, passed: 0, failed: 0, pending: 0 },
        headRefOid: pr.headRefOid || undefined,
        mergeable: pr.mergeable || "UNKNOWN",
        reviewRequested: reviewRequestPersonKeys(
          pr.reviewRequests || [],
          teamLoginsBySlug,
          pr.author?.login,
        ),
        reviewedBy: reviewedByNumber.get(pr.number) || [],
        assignees: (pr.assignees || [])
          .map((a) => a.login)
          .filter((l): l is string => !!l),
        sessionRef: sessionRefFromPrBody(pr.body),
      });

      // Seed with recent closed/merged (newest-first → keep the first per branch),
      // then let open PRs override: an open PR is the authoritative state for a
      // branch even if an older closed PR reused the same head ref.
      const map = new Map<string, PrInfo>();
      if (!recentAll && stale) {
        for (const [branch, pr] of stale) {
          if (pr.state !== "OPEN") map.set(branch, pr);
        }
      }
      for (const pr of recentAll || []) {
        if (!map.has(pr.headRefName)) map.set(pr.headRefName, toInfo(pr));
      }
      for (const pr of openPrs || []) {
        map.set(pr.headRefName, toInfo(pr));
      }
      if (stale) {
        // Merged/closed rows the queries no longer return still matter: the
        // recent window is finite, so once a merged PR ages out of it, its
        // session would flip from "Merged" to "no PR". Non-OPEN states are
        // terminal (a reopen re-enters the authoritative open query), so carry
        // them forward, with an update-age cap to bound cache growth. Prior
        // OPEN rows are deliberately not carried: the open query is
        // authoritative that they're gone, and just-closed ones arrive via
        // recentAll (sort:updated) or the webhook write-through.
        for (const [branch, prev] of stale) {
          if (map.has(branch) || prev.state === "OPEN") continue;
          const age = Date.now() - (Date.parse(prev.updatedAt || "") || 0);
          if (age < PR_CARRY_FORWARD_MS) map.set(branch, prev);
        }
        // The PR body (and thus the session-attribution footer) is only
        // fetched on the open-PR query, so a "discovered" PR would lose its
        // sessionRef — and unlink from its session — the first sweep after it
        // merges. Inherit the ref from the previous row of the same PR.
        for (const [branch, pr] of map) {
          if (pr.sessionRef) continue;
          const prev = stale.get(branch);
          if (prev?.sessionRef && prev.number === pr.number) {
            map.set(branch, { ...pr, sessionRef: prev.sessionRef });
          }
        }
      }
      next.set(repo.id, map);
    }
    // A close can land while this slow GitHub sweep is in flight. Preserve the
    // mutation over any pre-close OPEN row the sweep already fetched.
    applyPrCloseTombstones(next, refreshGeneration, reviewAuthoritativeRepos);
    for (const [key, mutation] of prReviewState.reviews) {
      const [ghRepo, numberText] = key.split("#");
      const repoId = prRepos().find((repo) => repo.ghRepo === ghRepo)?.id;
      if (
        mutation.generation <= reviewRefreshGeneration &&
        repoId &&
        reviewAuthoritativeRepos.has(repoId)
      ) {
        prReviewState.reviews.delete(key);
        continue;
      }
      const byBranch = repoId ? next.get(repoId) : undefined;
      if (!byBranch) continue;
      const number = Number(numberText);
      for (const [branch, pr] of byBranch) {
        if (pr.number !== number) continue;
        byBranch.set(
          branch,
          applyCachedReview(pr, mutation.person, mutation.event),
        );
        break;
      }
    }
    // Withdrawn review requests, held over the same way: the sweep may have
    // fetched this PR before the clear reached GitHub.
    for (const [key, generation] of prReviewState.cleared) {
      const [ghRepo, numberText] = key.split("#");
      const repoId = prRepos().find((repo) => repo.ghRepo === ghRepo)?.id;
      if (
        generation <= reviewRefreshGeneration &&
        repoId &&
        reviewAuthoritativeRepos.has(repoId)
      ) {
        prReviewState.cleared.delete(key);
        continue;
      }
      const byBranch = repoId ? next.get(repoId) : undefined;
      if (!byBranch) continue;
      const number = Number(numberText);
      for (const [branch, pr] of byBranch) {
        if (pr.number !== number) continue;
        byBranch.set(branch, { ...pr, reviewRequested: [] });
        break;
      }
    }
    prCache = { data: next, ts: Date.now() };
    if (freshRepos.size) persistPrCache(next);
    // A PR that just went MERGEABLE → CONFLICTING wakes the one session that
    // owns it. GitHub fires no webhook for a mergeability change, so this sweep
    // is where the event comes from (agents/github/pr-conflict.ts). Imported
    // lazily to keep the session-control/worktree graph out of this module.
    if (freshRepos.size && process.env.OPENSESSION_PR_CONFLICTS !== "0") {
      void import("../agents/github/pr-conflict")
        .then(({ scanConflictTransitions, notifyConflictedPrSession }) => {
          for (const event of scanConflictTransitions(next, freshRepos))
            void notifyConflictedPrSession(event);
        })
        .catch((e) => console.error("[github] PR conflict scan failed:", e));
    }
  } catch (e) {
    console.error("Failed to fetch PRs:", e);
    prCache.ts = Date.now(); // back off on failure too
  }
  return freshRepos;
}

/**
 * Every open PR across the covered repos (prRepos() — from the same batched
 * cache the session enrichment uses), each attributed to a teammate when its
 * GitHub author maps to one via the identity table. Bot-authored PRs
 * (opened by the configured agent account) fall back to the
 * first teammate assignee (sessions instruct the agent to `--assignee` the
 * requester); with neither, `person` is null and the frontend attributes
 * through the session that opened them. Powers the sidebar's Open PRs
 * section, which must show a person's PRs even when no Open Session session
 * exists for them — e.g. PRs opened from another tool (Conductor, local CLI)
 * under their own account.
 */
export interface OpenPrEntry {
  repo: string;
  branch: string;
  url: string;
  number: number;
  title: string;
  isDraft: boolean;
  reviewDecision: string;
  author: string;
  /** Web user-picker key ("kent"), or null when the author isn't a teammate. */
  person: string | null;
  createdAt: string;
  updatedAt: string;
  checks: PrChecksSummary;
  /** MERGEABLE | CONFLICTING | UNKNOWN — GitHub's async conflict probe. */
  mergeable: string;
  /** Person keys of teammates with a pending review request on this PR. */
  reviewRequested: string[];
  /** An automated Open Session review is still running for this PR. */
  reviewActive: boolean;
  /** What the last automated review concluded, so the queue can show the
   *  score without opening the PR. Absent until one has run. */
  osReview?: OsReviewSummary;
  /** What the repo's PR host supports (GitHub: everything) — one shared
   *  object per repo, so the list UI can hide host-less surfaces per row. */
  capabilities?: PrHostCapabilities;
}

export interface RecentPrEntry extends Omit<
  OpenPrEntry,
  "reviewActive" | "osReview"
> {
  state: "OPEN" | "MERGED" | "CLOSED";
  additions: number;
  deletions: number;
  /** The session named by the trusted attribution footer, when there is one. */
  sessionId?: string;
}

/** Only trusted authors may turn a PR-body link into an in-app session route. */
function trustedPrSessionId(
  pr: Pick<PrInfo, "author" | "sessionRef">,
): string | undefined {
  if (!pr.sessionRef) return undefined;
  const author = pr.author.toLowerCase();
  return githubBotLogins().includes(author) || githubLoginToPersonKey(author)
    ? pr.sessionRef
    : undefined;
}

/** The recent repo-wide PR window, including PRs created outside Open Session. */
export function getRecentPrs(): RecentPrEntry[] {
  const out: RecentPrEntry[] = [];
  for (const [repoId, byBranch] of getPrsByRepo()) {
    const repoCfg = configuredRepos()[repoId];
    // GitHub is the client default. Only alternate hosts need to repeat a
    // capability object on every row.
    const capabilities =
      repoCfg?.host === "codestorage"
        ? prHostFor(repoCfg).capabilities
        : undefined;
    for (const [branch, pr] of byBranch) {
      out.push({
        capabilities,
        repo: repoId,
        branch,
        url: pr.url,
        number: pr.number,
        title: pr.title,
        state: pr.state,
        isDraft: pr.isDraft,
        reviewDecision: pr.reviewDecision,
        author: pr.author,
        person:
          githubLoginToPersonKey(pr.author) ??
          pr.assignees
            .map((login) => githubLoginToPersonKey(login))
            .find((person): person is string => !!person) ??
          null,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        additions: pr.additions,
        deletions: pr.deletions,
        checks: pr.checks,
        mergeable: pr.mergeable,
        reviewRequested: pr.reviewRequested,
        sessionId: trustedPrSessionId(pr),
      });
    }
  }
  return out.sort((a, b) =>
    (b.updatedAt || "").localeCompare(a.updatedAt || ""),
  );
}

const personPrCache = new Map<string, { data: RecentPrEntry[]; ts: number }>();
const PERSON_PR_CACHE_TTL = 10 * 60_000;

/** Complete PR history for one teammate, fetched on demand for Home's person view. */
export async function getRecentPrsForPerson(
  person: string,
): Promise<RecentPrEntry[]> {
  const key = person.trim().toLowerCase();
  const cached = personPrCache.get(key);
  if (cached && Date.now() - cached.ts < PERSON_PR_CACHE_TTL)
    return cached.data;
  const login = githubLoginFor(key);
  if (!login) return [];

  type PersonPr = {
    headRefName: string;
    url: string;
    state: "OPEN" | "MERGED" | "CLOSED";
    number: number;
    title: string;
    isDraft: boolean;
    additions: number;
    deletions: number;
    author?: { login?: string; name?: string };
    createdAt: string;
    updatedAt: string;
    assignees?: Array<{ login?: string }>;
    body?: string;
  };
  const fields =
    "headRefName,url,state,number,title,isDraft,additions,deletions,author,createdAt,updatedAt,assignees,body";
  const out = new Map(
    getRecentPrs()
      .filter((pr) => pr.person === key)
      .map((pr) => [pr.url, pr]),
  );
  let complete = true;
  for (const repo of prRepos()) {
    // Author search is a gh-ism; code.storage has no user accounts to search.
    if (configuredRepos()[repo.id]?.host === "codestorage") continue;
    const prs = await ghJson<PersonPr[]>([
      "pr",
      "list",
      "--repo",
      repo.ghRepo,
      "--state",
      "all",
      "--search",
      `author:${login} OR assignee:${login}`,
      "--limit",
      "1000",
      "--json",
      fields,
    ]);
    if (!prs) {
      complete = false;
      continue;
    }
    for (const pr of prs || []) {
      const author = pr.author?.login || pr.author?.name || "";
      const assignees = (pr.assignees || [])
        .map((entry) => entry.login || "")
        .filter(Boolean);
      const sessionRef = sessionRefFromPrBody(pr.body);
      out.set(pr.url, {
        repo: repo.id,
        branch: pr.headRefName,
        url: pr.url,
        number: pr.number,
        title: pr.title,
        state: pr.state,
        isDraft: pr.isDraft,
        reviewDecision: "",
        author,
        person:
          githubLoginToPersonKey(author) ??
          assignees.map(githubLoginToPersonKey).find(Boolean) ??
          null,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        additions: pr.additions,
        deletions: pr.deletions,
        checks: { total: 0, passed: 0, failed: 0, pending: 0 },
        mergeable: "UNKNOWN",
        reviewRequested: [],
        sessionId: trustedPrSessionId({ author, sessionRef }),
      });
    }
  }
  const data = [...out.values()].sort((a, b) =>
    (b.updatedAt || "").localeCompare(a.updatedAt || ""),
  );
  if (complete) personPrCache.set(key, { data, ts: Date.now() });
  return data;
}

/**
 * The stored review verdict, marked stale when the PR's head has moved past the
 * SHA it describes. A head we don't know (older cache snapshot, before
 * headRefOid was cached) is never called stale — an unwarranted "stale" badge
 * on a current review is the more misleading of the two errors.
 */
export function lastReviewSummary(
  last: LastReviewState | undefined,
  headRefOid: string | undefined,
): OsReviewSummary | undefined {
  if (!last) return undefined;
  return {
    verdict: last.verdict,
    confidence: last.confidence,
    findings: last.findings,
    blocking: last.blocking,
    stale: !!headRefOid && !!last.sha && headRefOid !== last.sha,
    at: last.at,
  };
}

/** Live automated-review state for one PR, shared by the queue and PR detail
 * surfaces so the same score and staleness rules are rendered everywhere. */
export function getPrReviewStatus(
  prNumber: number,
  ghRepo: string | undefined,
  headRefOid: string | undefined,
): { reviewActive: boolean; osReview?: OsReviewSummary } {
  const state = readPrState(prNumber, ghRepo);
  return {
    reviewActive:
      state?.activeRun?.kind === "review" ||
      isLockHeld("review", prNumber, ghRepo),
    osReview: lastReviewSummary(state?.lastReview, headRefOid),
  };
}

export function getOpenPrs(): OpenPrEntry[] {
  const out: OpenPrEntry[] = [];
  for (const [repoId, byBranch] of getPrsByRepo()) {
    const repoCfg = configuredRepos()[repoId];
    const ghRepo = repoCfg?.ghRepo;
    const capabilities =
      repoCfg?.host === "codestorage"
        ? prHostFor(repoCfg).capabilities
        : undefined;
    for (const [branch, pr] of byBranch) {
      if (pr.state !== "OPEN") continue;
      const review = getPrReviewStatus(pr.number, ghRepo, pr.headRefOid);
      out.push({
        capabilities,
        repo: repoId,
        branch,
        url: pr.url,
        number: pr.number,
        title: pr.title,
        isDraft: pr.isDraft,
        reviewDecision: pr.reviewDecision,
        author: pr.author,
        person:
          githubLoginToPersonKey(pr.author) ??
          pr.assignees
            .map((l) => githubLoginToPersonKey(l))
            .find((p): p is string => !!p) ??
          null,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        checks: pr.checks,
        mergeable: pr.mergeable,
        reviewRequested: pr.reviewRequested,
        ...review,
      });
    }
  }
  return out.sort((a, b) =>
    (b.updatedAt || "").localeCompare(a.updatedAt || ""),
  );
}
