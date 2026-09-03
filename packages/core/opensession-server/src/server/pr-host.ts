/**
 * The PR-host seam. Every per-PR operation (details/diff/comment/review/
 * merge/close/…) and the bulk PR-list refresh go through a PrHost, so GitHub
 * (gh CLI, the reference implementation — thin delegation to pr-info.ts,
 * zero behavior change) and code.storage (no PR concept: branch-vs-default
 * review, merged via the merge API) can serve the same routes.
 *
 * Host methods take the host-side repo identifier string (`ghRepo`
 * "owner/name" for GitHub; the code.storage repo id for csPrHost) — the same
 * string call sites already pass to pr-info.ts. Pure snapshot helpers with no
 * host round-trip (cachedPrDetailsForSession, reconcilePrDetails) stay in
 * pr-info.ts and are host-agnostic.
 */
import type { Repo } from "./config";
import {
  resolveGithubCredential,
  serviceGithubCredential,
  type GithubCredential,
} from "./github-auth";
import {
  botGhToken,
  ghRateLimited,
  isGhRateLimitMsg,
  noteGhRateLimited,
} from "./github-limit";
import {
  closePr,
  editPrReviewers,
  getPrDetails,
  getPrDetailsFresh,
  getPrDiff,
  invalidatePrInfo,
  mergePr,
  postPrComment,
  prMetaForBranch,
  submitPrReview,
  updatePrBody,
} from "./pr-info";
import type {
  MergeMethod,
  MutationPrMeta,
  PrCommentInput,
  PrDetails,
  PrDiffData,
  PrHostCapabilities,
  PrReviewInput,
} from "./pr-contract";
export type { PrHostCapabilities } from "./pr-contract";
import { fetchWithTimeout } from "./shared/fetch-with-timeout";
import { noteGithubGraphqlCall } from "./github-budget";

/** One row of the bulk `gh pr list` refresh (sessions.ts). `latestReviews`
 *  and `body` are only populated by listOpenPrs — see the field comments. */
export interface BulkPr {
  headRefName: string;
  headRefOid?: string;
  url: string;
  state: string;
  number: number;
  title: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string;
  author?: { login?: string; name?: string };
  updatedAt: string;
  createdAt: string;
  reviewRequests?: Array<{ login?: string; name?: string; slug?: string }>;
  assignees?: Array<{ login?: string }>;
  // MERGEABLE | CONFLICTING | UNKNOWN. GitHub computes this asynchronously,
  // so a freshly-pushed PR reads UNKNOWN until the background probe lands —
  // the 60s SWR refresh picks up the real value. `mergeable` is a cheap PR
  // enum (unlike statusCheckRollup), so it's safe to add to the bulk list;
  // mergeStateStatus is NOT a `gh pr list` field (detail-only), don't add it.
  mergeable?: string;
  // Only requested on the open-PR query (listOpenPrs), absent on the recent
  // window.
  latestReviews?: Array<{ state?: string; author?: { login?: string } }>;
  // Ditto: the body is only read for its session-attribution footer and is
  // never cached (toInfo keeps the parsed id, drops the text), so paying
  // for it across the much larger recent-history window buys nothing.
  body?: string;
}

const BULK_FIELDS =
  "headRefName,headRefOid,url,state,number,title,isDraft,additions,deletions,changedFiles,reviewDecision,author,createdAt,updatedAt,reviewRequests,assignees,mergeable";

export interface PrHost {
  readonly capabilities: PrHostCapabilities;

  // ── Per-PR operations (the pr-info.ts surface) ────────────────────────────
  getPrDetails(branch: string, repo: string): Promise<PrDetails | null>;
  /** Bypasses any stale-while-revalidate cache — action completion gates. */
  getPrDetailsFresh(branch: string, repo: string): Promise<PrDetails | null>;
  getPrDiff(
    branch: string,
    repo: string,
    maxPatchBytes?: number,
  ): Promise<PrDiffData | null>;
  /** Cheap "does this branch have a PR, and which one" lookup. */
  prMetaForBranch(
    branch: string,
    repo: string,
    credential?: GithubCredential,
  ): Promise<MutationPrMeta | null>;
  postPrComment(
    branch: string,
    input: PrCommentInput,
    repo: string,
    credential?: GithubCredential,
  ): Promise<{ ok: true; url?: string } | { error: string }>;
  submitPrReview(
    branch: string,
    input: PrReviewInput,
    repo: string,
    credential?: GithubCredential,
  ): Promise<{ ok: true; url?: string } | { error: string }>;
  mergePr(
    branch: string,
    opts: { method?: MergeMethod; deleteBranch?: boolean; force?: boolean },
    repo: string,
    credential?: GithubCredential,
  ): Promise<{ ok: true; url?: string } | { error: string }>;
  closePr(
    branch: string,
    repo: string,
    credential?: GithubCredential,
  ): Promise<{ ok: true; url?: string; number: number } | { error: string }>;
  editPrReviewers(
    branch: string,
    opts: { add?: string | null; remove?: string | null },
    repo: string,
    credential?: GithubCredential,
  ): Promise<{ ok: true } | { error: string }>;
  updatePrBody(
    branch: string,
    mutate: (body: string) => string,
    repo: string,
  ): Promise<{ ok: true; number: number; url: string } | { error: string }>;
  /** Drop cached details/diff for a branch (webhook/mutation write-through). */
  invalidatePrInfo(repo: string, branch: string): void;

  // ── Bulk operations (the sessions.ts PR-cache refresh) ────────────────────
  /** Every open PR (authoritative for the live set), with latestReviews and
   *  body. null = the query failed (rate limit etc.) — keep the stale rows. */
  listOpenPrs(repo: string, opts: { limit: number }): Promise<BulkPr[] | null>;
  /** The recently-updated window across all states (merged/closed history). */
  listRecentPrs(
    repo: string,
    opts: { limit: number },
  ): Promise<BulkPr[] | null>;
  /** Cheap change probe before the expensive list calls. `cursor` is opaque
   *  per host (GitHub: the conditional-GET ETag; a 304 costs no rate limit).
   *  Failures read as changed so a real refresh still runs. */
  changedSince(
    repo: string,
    cursor?: string,
  ): Promise<{ changed: boolean; cursor?: string }>;
}

/** Run `gh` and parse its JSON output; null on any failure (also flags shared
 *  rate-limit backoff). Moved from sessions.ts — same behavior. */
export async function ghJson<T>(
  args: string[],
  consumer = "gh-json",
): Promise<T | null> {
  if (ghRateLimited()) return null;
  const started = Date.now();
  let ok = false;
  try {
    // `--repo owner/name` selects the installation that serves the call.
    const repoFlag = args.indexOf("--repo");
    const repo = repoFlag >= 0 ? args[repoFlag + 1] : undefined;
    const credential = await resolveGithubCredential(
      serviceGithubCredential,
      repo ? { repo } : {},
    );
    const proc = Bun.spawn(["gh", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...credential.env },
    });
    const [raw, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if ((await proc.exited) !== 0) {
      if (isGhRateLimitMsg(err)) noteGhRateLimited("pr-cache");
      return null;
    }
    if (!raw.trim()) return null;
    ok = true;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  } finally {
    noteGithubGraphqlCall(consumer, Date.now() - started, ok);
  }
}

export const githubPrHost: PrHost = {
  capabilities: {
    checks: true,
    reviewers: true,
    viewedState: true,
    stacks: true,
    reviewComments: true,
    prCreate: true,
    images: true,
    commitNotes: false,
  },

  getPrDetails: (branch, repo) => getPrDetails(branch, repo),
  getPrDetailsFresh: (branch, repo) => getPrDetailsFresh(branch, repo),
  getPrDiff: (branch, repo, maxPatchBytes) =>
    getPrDiff(branch, repo, maxPatchBytes),
  prMetaForBranch: (branch, repo, credential) =>
    prMetaForBranch(branch, repo, credential),
  postPrComment: (branch, input, repo, credential) =>
    postPrComment(branch, input, repo, credential),
  submitPrReview: (branch, input, repo, credential) =>
    submitPrReview(branch, input, repo, credential),
  mergePr: (branch, opts, repo, credential) =>
    mergePr(branch, opts, repo, credential),
  closePr: (branch, repo, credential) => closePr(branch, repo, credential),
  editPrReviewers: (branch, opts, repo, credential) =>
    editPrReviewers(branch, opts, repo, credential),
  updatePrBody: (branch, mutate, repo) => updatePrBody(branch, mutate, repo),
  invalidatePrInfo: (repo, branch) => invalidatePrInfo(repo, branch),

  // A session's branch is matched against open PRs, so this must see EVERY
  // open PR — not just the newest N (fusion carries 200+ at a time; a single
  // `--state all` window silently dropped older open ones). latestReviews is
  // cheap (~2 GraphQL points across the full open window) and lets review
  // state need no third query; the body is only read for its
  // session-attribution footer.
  listOpenPrs: (repo, opts) =>
    ghJson<BulkPr[]>(
      [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--limit",
        String(opts.limit),
        "--json",
        `${BULK_FIELDS},latestReviews,body`,
      ],
      "pr-cache:list-open",
    ),
  // sort:updated-desc, not gh's default creation order: a PR created long ago
  // that merges today must enter this window immediately, or the sweep drops
  // its row and the session renders as having no PR at all.
  listRecentPrs: (repo, opts) =>
    ghJson<BulkPr[]>(
      [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "all",
        "--search",
        "sort:updated-desc",
        "--limit",
        String(opts.limit),
        "--json",
        BULK_FIELDS,
      ],
      "pr-cache:list-recent",
    ),

  // Conditional GET (If-None-Match) on the most recently updated PR: 304 =
  // the repo's PR set is untouched, and GitHub documents that 304s on
  // conditional requests don't count against the rate limit, so an idle
  // instance polls for free. Moved from sessions.ts (repoPrsUnchanged) —
  // the caller keeps owning cursor persistence.
  async changedSince(repo, cursor) {
    const token = await botGhToken({ repo });
    if (!token) return { changed: true, cursor };
    try {
      const resp = await fetchWithTimeout(
        `https://api.github.com/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=1`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(cursor ? { "If-None-Match": cursor } : {}),
          },
        },
      );
      if (resp.status === 304) return { changed: false, cursor };
      if (resp.ok) {
        const fresh = resp.headers.get("etag");
        await resp.text().catch(() => {}); // drain so the socket frees
        return { changed: true, cursor: fresh || cursor };
      }
      const body = await resp.text().catch(() => "");
      if (
        (resp.status === 403 || resp.status === 429) &&
        (resp.headers.get("x-ratelimit-remaining") === "0" ||
          isGhRateLimitMsg(body))
      ) {
        const reset = Number(resp.headers.get("x-ratelimit-reset")) * 1000;
        noteGhRateLimited(
          "pr-cache-rest",
          Number.isFinite(reset) ? reset : undefined,
          "rest",
        );
      }
      return { changed: true, cursor };
    } catch {
      return { changed: true, cursor };
    }
  },
};

/** code.storage: no CI, no reviewer accounts, no viewed state, no stacks, no
 *  image-blob API — but "PRs" (branch-vs-default reviews) can be created, and
 *  review comments work, backed by git notes on the branch's commits
 *  (codestorage/pr-host.ts), as do commit-note annotations. Shared with the
 *  csPrHost implementation so the lazy dispatch below can answer capabilities
 *  without loading it. */
export const CODESTORAGE_CAPABILITIES: PrHostCapabilities = {
  checks: false,
  reviewers: false,
  viewedState: false,
  stacks: false,
  reviewComments: true,
  prCreate: true,
  images: false,
  commitNotes: true,
};

// The code.storage host loads lazily: GitHub-only instances never import it,
// and this module typechecks against the interface while codestorage/pr-host
// is built out in parallel.
let csHostPromise: Promise<PrHost> | null = null;
function csHost(): Promise<PrHost> {
  return (csHostPromise ??= import("./codestorage/pr-host").then(
    (m) => m.csPrHost,
  ));
}

const codestoragePrHost: PrHost = {
  capabilities: CODESTORAGE_CAPABILITIES,
  getPrDetails: async (branch, repo) =>
    (await csHost()).getPrDetails(branch, repo),
  getPrDetailsFresh: async (branch, repo) =>
    (await csHost()).getPrDetailsFresh(branch, repo),
  getPrDiff: async (branch, repo, maxPatchBytes) =>
    (await csHost()).getPrDiff(branch, repo, maxPatchBytes),
  prMetaForBranch: async (branch, repo, credential) =>
    (await csHost()).prMetaForBranch(branch, repo, credential),
  postPrComment: async (branch, input, repo, credential) =>
    (await csHost()).postPrComment(branch, input, repo, credential),
  submitPrReview: async (branch, input, repo, credential) =>
    (await csHost()).submitPrReview(branch, input, repo, credential),
  mergePr: async (branch, opts, repo, credential) =>
    (await csHost()).mergePr(branch, opts, repo, credential),
  closePr: async (branch, repo, credential) =>
    (await csHost()).closePr(branch, repo, credential),
  editPrReviewers: async (branch, opts, repo, credential) =>
    (await csHost()).editPrReviewers(branch, opts, repo, credential),
  updatePrBody: async (branch, mutate, repo) =>
    (await csHost()).updatePrBody(branch, mutate, repo),
  // Sync signature over a lazy module: fire-and-forget is correct here —
  // invalidation is advisory and the cs host owns its own caches.
  invalidatePrInfo: (repo, branch) => {
    void csHost()
      .then((host) => host.invalidatePrInfo(repo, branch))
      .catch(() => {});
  },
  listOpenPrs: async (repo, opts) => (await csHost()).listOpenPrs(repo, opts),
  listRecentPrs: async (repo, opts) =>
    (await csHost()).listRecentPrs(repo, opts),
  changedSince: async (repo, cursor) =>
    (await csHost()).changedSince(repo, cursor),
};

/** The PR host for a registered repo. Default (and everything today): GitHub. */
export function prHostFor(repo: Repo): PrHost {
  return repo.host === "codestorage" ? codestoragePrHost : githubPrHost;
}

/** The host-side repo identifier PrHost methods take: GitHub `owner/name`, or
 *  the code.storage repo id. Empty string when the repo has none configured. */
export function hostRepoId(repo: Repo): string {
  return repo.host === "codestorage" ? repo.csRepo || "" : repo.ghRepo;
}
