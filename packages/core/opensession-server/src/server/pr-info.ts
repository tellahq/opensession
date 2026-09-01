/**
 * PR details for a session branch via the gh CLI, Devin-style "PR" tab.
 * Cached per branch for 5 minutes (stale-while-revalidate) to keep the UI snappy
 * without hammering GitHub; snapshotted to disk so restarts keep last-good
 * data; and wired into the shared rate-limit gate (github-limit.ts) so a
 * throttled quota serves stale snapshots instead of errors.
 */
import { homeDir } from "./paths";
import { statePath } from "./paths";
import {
  configuredIntegration,
  configuredRepos,
  configuredServer,
  defaultRepo,
} from "./config";
import { $ } from "bun";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "fs";
import { audited } from "./audit";
import {
  ghRateLimited,
  noteGhRateLimited,
  isGhRateLimitMsg,
} from "./github-limit";
import {
  resolveGithubCredential,
  serviceGithubCredential,
  type GithubCredential,
} from "./github-auth";
import { githubToken } from "./github-app";
import { reviewRequestRemovalSpecs } from "./github-review-requests";
import { noteGithubGraphqlCall } from "./github-budget";
import { getPrStack, unmergedLayersBelow } from "./pr-stack";
import type {
  MergeMethod,
  MutationPrMeta,
  PrCheck,
  PrCommentInput,
  PrDetails,
  PrDiffData,
  PrFile,
  PrReviewInput,
  PrReviewer,
  PrStaging,
} from "./pr-contract";
import type { UnifiedSession } from "./types";
export type {
  MergeMethod,
  MutationPrMeta,
  PrCheck,
  PrComment,
  PrCommentInput,
  PrCommit,
  PrCommitNote,
  PrDetails,
  PrDiffData,
  PrFile,
  PrReviewComment,
  PrReviewEvent,
  PrReviewInput,
  PrReviewer,
  PrStaging,
} from "./pr-contract";

export type PrAutomationDetails = PrDetails;

/**
 * Minimum PR metadata needed to acknowledge and queue event-driven work.
 * REST on purpose: review and @mention intake must remain available when the
 * installation's independently-metered GraphQL bucket is empty.
 */
export async function getPrAutomationDetails(
  selector: string,
  repo: string = DEFAULT_REPO(),
): Promise<PrAutomationDetails | null> {
  if (ghRateLimited("rest")) throw new Error(GH_REST_RATE_LIMIT_MESSAGE);
  const token = await githubToken();
  if (!token)
    throw new Error("The selected GitHub bot credential is unavailable");
  const numeric = /^\d+$/.test(selector);
  const path = numeric
    ? `/repos/${repo}/pulls/${selector}`
    : `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${repo.split("/")[0]}:${selector}`)}&per_page=1`;
  const started = Date.now();
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "opensession",
    },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => null)) as any;
  console.log(
    `[github-budget] lane=rest consumer=pr-automation status=${response.status} durationMs=${Date.now() - started} remaining=${response.headers.get("x-ratelimit-remaining") || "unknown"}`,
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    const message = String(body?.message || `GitHub REST ${response.status}`);
    if (
      (response.status === 403 || response.status === 429) &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        isGhRateLimitMsg(message))
    ) {
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      noteGhRateLimited(
        "pr-automation",
        Number.isFinite(reset) ? reset : undefined,
        "rest",
      );
    }
    throw new Error(prApiErrorMessage(message));
  }
  const pr = Array.isArray(body) ? body[0] : body;
  if (!pr) return null;
  const key = cacheKey(repo, pr.head?.ref || selector);
  const cached = cache.get(key)?.data;
  const state: PrDetails["state"] = pr.merged_at
    ? "MERGED"
    : pr.state === "open"
      ? "OPEN"
      : "CLOSED";
  return {
    ...(cached || {
      number: pr.number,
      title: "",
      url: "",
      state,
      isDraft: false,
      baseRefName: "",
      headRefName: "",
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      reviewDecision: "",
      author: "",
      body: "",
      checks: [],
      comments: [],
      commits: [],
      files: [],
      reviewers: [],
      mergeable: "UNKNOWN",
      mergeStateStatus: "",
      staging: null,
    }),
    number: pr.number,
    title: pr.title || `PR #${pr.number}`,
    url: pr.html_url || "",
    state,
    isDraft: !!pr.draft,
    baseRefName: pr.base?.ref || "",
    headRefName: pr.head?.ref || "",
    headRefOid: pr.head?.sha || "",
    headRepo: pr.head?.repo?.full_name || cached?.headRepo,
    additions: Number(pr.additions) || cached?.additions || 0,
    deletions: Number(pr.deletions) || cached?.deletions || 0,
    changedFiles: Number(pr.changed_files) || cached?.changedFiles || 0,
    author: pr.user?.login || "",
    body: typeof pr.body === "string" ? pr.body : cached?.body || "",
    mergeable:
      pr.mergeable === true
        ? "MERGEABLE"
        : pr.mergeable === false
          ? "CONFLICTING"
          : cached?.mergeable || "UNKNOWN",
  };
}

export function latestWorkflowChecks(checks: PrCheck[]): PrCheck[] {
  const latest = new Map<string, PrCheck>();
  const statusContexts: PrCheck[] = [];

  for (const check of checks) {
    if (!check.workflowName || !check.startedAt) {
      statusContexts.push(check);
      continue;
    }

    const key = `${check.workflowName}\0${check.name}`;
    const previous = latest.get(key);
    if (!previous?.startedAt || check.startedAt > previous.startedAt)
      latest.set(key, check);
  }

  return [...statusContexts, ...latest.values()];
}

/**
 * Turn the bulk session snapshot into the minimum honest PR detail response.
 * This keeps PR surfaces coherent when the richer GitHub query is unavailable.
 */
export function cachedPrDetailsForSession(
  session: UnifiedSession,
  repoId: string,
  branch: string,
): PrDetails | null {
  const ref = (session.prs || []).find(
    (candidate) =>
      candidate.repo === repoId &&
      candidate.branch === branch &&
      candidate.number != null &&
      candidate.url &&
      candidate.state,
  );
  const primary =
    repoId === (session.repo || defaultRepo().id) && branch === session.branch;
  const number = ref?.number ?? (primary ? session.prNumber : undefined);
  const url = ref?.url ?? (primary ? session.prUrl : undefined);
  const state = ref?.state ?? (primary ? session.prState : undefined);
  // MERGED is irreversible. OPEN/CLOSED snapshots can be stale (a closed PR
  // may reopen), and synthesizing their missing checks could expose bad actions.
  if (number == null || !url || state !== "MERGED") return null;

  return {
    number,
    title: ref?.title || (primary ? session.prTitle : "") || `PR #${number}`,
    url,
    state,
    isDraft: ref?.isDraft ?? (primary ? !!session.prIsDraft : false),
    baseRefName: "",
    headRefName: branch,
    additions: ref?.additions ?? (primary ? session.prAdditions : 0) ?? 0,
    deletions: ref?.deletions ?? (primary ? session.prDeletions : 0) ?? 0,
    changedFiles: primary ? (session.prChangedFiles ?? 0) : 0,
    reviewDecision:
      ref?.reviewDecision || (primary ? session.prReviewDecision : "") || "",
    author: primary ? session.prAuthor || "" : "",
    body: "",
    checks: [],
    comments: [],
    commits: [],
    files: [],
    reviewers: [],
    mergeable: primary ? session.prMergeable || "UNKNOWN" : "UNKNOWN",
    mergeStateStatus: "",
    staging: null,
  };
}

/** An irreversible bulk merge must not regress from a stale detail-cache row. */
export function reconcilePrDetails(
  details: PrDetails | null,
  cached: PrDetails | null,
): PrDetails | null {
  if (!details) return cached;
  if (
    cached &&
    details.number === cached.number &&
    details.state !== "MERGED" &&
    cached.state === "MERGED"
  ) {
    return { ...details, state: "MERGED", isDraft: false };
  }
  return details;
}

function parseStaging(
  comments: Array<{ body?: string }> | undefined,
): PrStaging | null {
  const github = configuredIntegration("github");
  const marker =
    typeof github.previewCommentMarker === "string"
      ? github.previewCommentMarker
      : "";
  const service =
    typeof github.previewTableService === "string"
      ? github.previewTableService
      : "";
  if (!marker || !service) return null;
  const escapedService = service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const row = new RegExp(
    `^\\|\\s*${escapedService}\\s*\\|\\s*([^|]+?)\\s*\\|\\s*\\[[^\\]]*\\]\\((https?:\\/\\/[^)\\s]+)\\)`,
    "m",
  );
  for (const c of comments || []) {
    if (!c.body?.includes(marker)) continue;
    const m = c.body.match(row);
    if (m) return { status: m[1], url: m[2], embeddable: embeddableFor(m[2]) };
  }
  return null;
}

// Whether a preview environment opts into being embedded in the review iframe.
// Probed out-of-band — a plain GET of the deploy,
// reading the CSP header — and cached, so the PR fetch never blocks on it and a
// deploy that predates the fusion change simply reads back false (the UI then
// shows the launch panel, exactly as before). Best-effort: any failure → false.
const EMBED_TTL = 300_000;
const embedCache = new Map<string, { ok: boolean; ts: number }>();
const embedInflight = new Set<string>();

async function probeEmbeddable(url: string): Promise<void> {
  if (embedInflight.has(url)) return;
  embedInflight.add(url);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "os1-embed-probe" },
      signal: AbortSignal.timeout(5000),
    });
    const csp = res.headers.get("content-security-policy") || "";
    const uiHost = new URL(configuredServer().publicBaseUrl).hostname;
    const escaped = uiHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ok = new RegExp(`frame-ancestors[^;]*\\b${escaped}\\b`, "i").test(
      csp,
    );
    embedCache.set(url, { ok, ts: Date.now() });
  } catch {
    embedCache.set(url, { ok: false, ts: Date.now() });
  } finally {
    embedInflight.delete(url);
  }
}

/** Sync read of the embed-probe cache; kicks a background refresh when stale. */
function embeddableFor(url: string): boolean {
  const hit = embedCache.get(url);
  if (!hit || Date.now() - hit.ts >= EMBED_TTL) void probeEmbeddable(url);
  return hit?.ok ?? false;
}

/** Changed files, biggest churn first, so the panel leads with the meat. */
function buildFiles(
  files:
    | Array<{ path?: string; additions?: number; deletions?: number }>
    | undefined,
): PrFile[] {
  return (files || [])
    .filter((f) => f.path)
    .map((f) => ({
      path: f.path as string,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
    }))
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
}

/**
 * Merge the provider's `latestReviews` (people who submitted a review) with
 * `reviewRequests` (requested but not yet reviewed → PENDING) into one list.
 * A submitted review wins over a pending request for the same person. Requested
 * teams have no `login`, only a `name`/`slug`, and are flagged `isTeam`.
 */
function buildReviewers(
  latest: Array<{ author?: { login?: string }; state?: string }> | undefined,
  requests: Array<{ login?: string; slug?: string; name?: string }> | undefined,
): PrReviewer[] {
  const byLogin = new Map<string, PrReviewer>();
  for (const r of latest || []) {
    const login = r.author?.login;
    const state = r.state as PrReviewer["state"] | undefined;
    // DISMISSED/PENDING sneak in via the API; only surface real outcomes here.
    if (!login || !state) continue;
    if (
      state !== "APPROVED" &&
      state !== "CHANGES_REQUESTED" &&
      state !== "COMMENTED"
    )
      continue;
    const prev = byLogin.get(login);
    // Keep the strongest signal if someone appears twice (approve > changes > comment).
    const rank = (s: string) =>
      s === "CHANGES_REQUESTED" ? 3 : s === "APPROVED" ? 2 : 1;
    if (!prev || rank(state) > rank(prev.state))
      byLogin.set(login, { login, state });
  }
  for (const r of requests || []) {
    const login = r.login || r.slug || r.name;
    if (!login) continue;
    if (byLogin.has(login)) continue;
    byLogin.set(login, { login, state: "PENDING", isTeam: !r.login });
  }
  // Requesters/blockers first (they gate the merge), approvers next.
  const rank = (s: string) =>
    s === "CHANGES_REQUESTED"
      ? 0
      : s === "PENDING"
        ? 1
        : s === "COMMENTED"
          ? 2
          : 3;
  return [...byLogin.values()].sort((a, b) => rank(a.state) - rank(b.state));
}

const DEFAULT_REPO = () => defaultRepo().ghRepo;
const cache = new Map<string, { data: PrDetails | null; ts: number }>();
// 5 min: the detail pane and staging/status pollers tolerate that staleness,
// and each open session tab runs several independent /pr pollers — a short
// TTL made nearly every tick spawn a real `gh pr view` into the shared
// GraphQL budget (2026-07-23). Action gates that must not act on stale data
// use getPrDetailsFresh, which bypasses this cache entirely.
const TTL = 5 * 60_000;
// A durable snapshot is deliberately allowed to stay stale during the first
// ten minutes of a process. Webhooks and the bulk REST/ETag cache keep
// open/merge state coherent; delaying rich GraphQL revalidation prevents a
// restart loop from replaying one expensive detail query per open UI/session.
const RESTART_REFRESH_GRACE_MS = 10 * 60_000;
const detailsSnapshotLoadedAt = Date.now();

export function shouldRefreshPrDetails(
  entryTs: number,
  now = Date.now(),
  loadedAt = detailsSnapshotLoadedAt,
): boolean {
  if (now - entryTs < TTL) return false;
  return now - loadedAt >= RESTART_REFRESH_GRACE_MS;
}

// The details cache is snapshotted to disk (debounced) and seeded on boot —
// without this, a restart during a GitHub outage or rate-limit window boots
// with an empty cache and the PR panel shows a dead error instead of the
// last-good snapshot (same failure mode the bulk cache fixed on 2026-07-22).
// Entries keep their original ts, so everything seeds as stale: served
// immediately while a background refresh runs. The diff cache is NOT
// persisted — patches are big and cheap to refetch.
const DETAILS_CACHE_FILE = statePath(".opensession-pr-details-cache.json");
/** Seed the details cache from disk. Also exported for demo instances, whose
 *  snapshot is written at the end of boot — see loadPrCacheSnapshot(). */
export function loadPrDetailsSnapshot(): void {
  try {
    const raw: Record<string, { data: PrDetails | null; ts: number }> =
      JSON.parse(readFileSync(DETAILS_CACHE_FILE, "utf8"));
    for (const [k, v] of Object.entries(raw)) cache.set(k, v);
  } catch {}
}
loadPrDetailsSnapshot();

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const cutoff = Date.now() - 7 * 24 * 3600_000; // drop long-dead branches
      const obj: Record<string, { data: PrDetails | null; ts: number }> = {};
      for (const [k, v] of cache) if (v.ts > cutoff) obj[k] = v;
      writeFileSync(DETAILS_CACHE_FILE, JSON.stringify(obj));
    } catch {}
  }, 5_000);
}

// Caches are keyed by `<repo>\0<branch>` so the same branch name in different
// repos (multi-repo sessions share a branch name) never collides.
const cacheKey = (repo: string, branch: string) => `${repo}\u0000${branch}`;

const diffCache = new Map<string, { data: PrDiffData | null; ts: number }>();

/**
 * Pin a PR patch into the diff cache. For the demo dataset only: its PR does
 * not exist on GitHub, and unlike the details cache the diff cache is never
 * snapshotted to disk, so the Review page's "Files changed" tab would always
 * fail its live fetch. The entry is stamped far in the future so the TTL never
 * expires it into a doomed `gh` call.
 */
export function seedPrDiff(
  repo: string,
  branch: string,
  data: PrDiffData,
): void {
  diffCache.set(cacheKey(repo, branch), {
    data: {
      ...data,
      diffVersion:
        data.diffVersion ??
        createHash("sha256")
          .update(data.baseRefOid ?? "")
          .update("\0")
          .update(data.headRefOid)
          .digest("base64url"),
    },
    ts: Number.MAX_SAFE_INTEGER,
  });
}
const diffInflight: Map<string, Promise<PrDiffData | null>> = ((
  globalThis as any
).__prDiffInflight ??= new Map());

async function selectedGhEnv(
  opts: { write?: boolean } = {},
): Promise<Record<string, string>> {
  const token = await githubToken(opts);
  if (!token)
    throw new Error("The selected GitHub bot credential is unavailable");
  return { GH_TOKEN: token, GITHUB_TOKEN: token };
}

function spawnGh(args: string[], credential: GithubCredential, stdin?: "pipe") {
  return Bun.spawn(["gh", ...args], {
    ...(stdin ? { stdin } : {}),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...credential.env },
  });
}

async function processPrefix(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  abort: () => void,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = limit + 1 - size;
    if (remaining > 0) chunks.push(value.subarray(0, remaining));
    size += value.byteLength;
    if (size > limit) {
      abort();
      return {
        text: Buffer.concat(chunks).subarray(0, limit).toString("utf8"),
        truncated: true,
      };
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated: false };
}

function completePatchPrefix(
  text: string,
  truncated: boolean,
): { patch: string; skippedFiles: number } {
  if (!truncated) return { patch: text, skippedFiles: 0 };
  const boundary = text.lastIndexOf("\ndiff --git ");
  return {
    patch: boundary > 0 ? text.slice(0, boundary + 1) : "",
    skippedFiles: 1,
  };
}

async function boundedCommandPatch(
  argv: string[],
  limit: number,
  env: Record<string, string> = {},
): Promise<{ patch: string; skippedFiles: number }> {
  const child = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [output, error] = await Promise.all([
    processPrefix(child.stdout, limit, () => child.kill()),
    processPrefix(child.stderr, 64 * 1024, () => child.kill()),
  ]);
  const code = await child.exited;
  if (code !== 0 && !output.truncated)
    throw new Error(error.text.trim() || `${argv[0]} failed`);
  return completePatchPrefix(output.text, output.truncated);
}

/** Exported for pr-webhook.ts: a GitHub webhook delivery for this branch
 *  drops the cached details/diff so the next fetch re-reads GitHub instead of
 *  waiting out the 5-min TTL. */
export function invalidatePrInfo(repo: string, branch: string): void {
  const key = cacheKey(repo, branch);
  cache.delete(key);
  diffCache.delete(key);
}

/**
 * The cheap "does this branch have a PR, and which one" lookup. Callers that
 * only need the number/url/state (stack linking, merge gates) use this instead
 * of getPrDetails, which pulls checks, files, comments and the stack too.
 */
export async function prMetaForBranch(
  branch: string,
  repo: string = DEFAULT_REPO(),
  credential: GithubCredential = serviceGithubCredential,
): Promise<MutationPrMeta | null> {
  return getMutationPrMeta(branch, repo, credential);
}

async function getMutationPrMeta(
  branch: string,
  repo: string,
  credential: GithubCredential,
): Promise<MutationPrMeta | null> {
  const resolvedCredential = await resolveGithubCredential(credential);
  const proc = spawnGh(
    [
      "pr",
      "view",
      branch,
      "--repo",
      repo,
      "--json",
      "number,headRefOid,state,isDraft,url",
    ],
    resolvedCredential,
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    if (isNoPrError(err)) return null;
    throw new Error(prApiErrorMessage(err));
  }
  return JSON.parse(out) as MutationPrMeta;
}

export async function getPrDiff(
  branch: string,
  repo: string = DEFAULT_REPO(),
  maxPatchBytes?: number,
): Promise<PrDiffData | null> {
  const key = cacheKey(repo, branch);
  const hit = maxPatchBytes ? undefined : diffCache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;
  const inflightKey = maxPatchBytes ? `${key}\0bounded:${maxPatchBytes}` : key;
  const running = diffInflight.get(inflightKey);
  if (running) return running;
  // Known backoff window: stale answer if we have one, fast friendly failure
  // if we don't — never a doomed gh spawn.
  if (ghRateLimited("rest")) {
    if (hit) return hit.data;
    throw new Error(GH_REST_RATE_LIMIT_MESSAGE);
  }

  const refresh = (async () => {
    try {
      const token = await githubToken();
      if (!token)
        throw new Error("The selected GitHub bot credential is unavailable");
      const headers = {
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "opensession",
      };
      const readMeta = async (): Promise<{
        number: number;
        headRefOid: string;
        baseRefName: string;
        baseRefOid: string;
      }> => {
        const numeric = /^\d+$/.test(branch);
        const path = numeric
          ? `/repos/${repo}/pulls/${branch}`
          : `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${repo.split("/")[0]}:${branch}`)}&per_page=1`;
        const response = await fetch(`https://api.github.com${path}`, {
          headers: { ...headers, Accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(10_000),
        });
        const body = (await response.json().catch(() => null)) as any;
        if (!response.ok)
          throw new Error(
            String(body?.message || `GitHub REST ${response.status}`),
          );
        const pr = Array.isArray(body) ? body[0] : body;
        if (!pr) throw new Error("no pull requests found");
        return {
          number: pr.number,
          headRefOid: pr.head?.sha || "",
          baseRefName: pr.base?.ref || "",
          baseRefOid: pr.base?.sha || "",
        };
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const meta = await readMeta();
        let patch: string;
        let skippedFiles = 0;
        try {
          const controller = new AbortController();
          const response = await fetch(
            `https://api.github.com/repos/${repo}/pulls/${meta.number}`,
            {
              headers: { ...headers, Accept: "application/vnd.github.v3.diff" },
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(30_000),
              ]),
            },
          );
          if (!response.ok)
            throw new Error(
              await response
                .text()
                .catch(() => `GitHub REST ${response.status}`),
            );
          if (!response.body)
            throw new Error("GitHub returned an empty PR diff");
          if (maxPatchBytes) {
            const bounded = await processPrefix(
              response.body,
              maxPatchBytes,
              () => controller.abort(),
            );
            const complete = completePatchPrefix(
              bounded.text,
              bounded.truncated,
            );
            patch = complete.patch;
            skippedFiles = complete.skippedFiles;
          } else {
            patch = await response.text();
          }
        } catch (diffErr: any) {
          // GitHub refuses API diffs over 300 files; reconstruct from the same
          // snapshotted refs in the configured local checkout.
          const dmsg = String(diffErr?.stderr || diffErr?.message || diffErr);
          if (!/maximum number of files/i.test(dmsg)) throw diffErr;
          console.warn(
            `[pr-info] PR #${meta.number} diff >300 files; using local merge-base diff`,
          );
          try {
            const local = await localPrDiffPatch(repo, meta, maxPatchBytes);
            patch = local.patch;
            skippedFiles = local.skippedFiles;
          } catch (localErr: any) {
            console.warn(
              `[pr-info] local diff fallback failed: ${String(localErr?.stderr || localErr?.message || localErr).slice(0, 300)}`,
            );
            throw localErr;
          }
        }
        const verified = await readMeta();
        if (
          verified.headRefOid !== meta.headRefOid ||
          verified.baseRefOid !== meta.baseRefOid
        )
          continue;
        const data = {
          number: meta.number,
          baseRefOid: meta.baseRefOid,
          headRefOid: meta.headRefOid,
          patch,
          diffVersion: createHash("sha256")
            .update(meta.baseRefOid ?? meta.baseRefName)
            .update("\0")
            .update(meta.headRefOid)
            .digest("base64url"),
          ...(skippedFiles ? { skippedFiles } : {}),
        };
        if (!maxPatchBytes) diffCache.set(key, { data, ts: Date.now() });
        return data;
      }
      throw new Error("Pull request changed while loading its diff");
    } catch (e: any) {
      const msg = String(e?.stderr || e?.message || e).slice(0, 300);
      if (!isNoPrError(msg)) {
        if (isGhRateLimitMsg(msg))
          noteGhRateLimited("pr-diff", undefined, "rest");
        console.warn(`[pr-info] gh pr diff ${branch} (${repo}) failed: ${msg}`);
        if (hit) return hit.data; // stale beats an error
        throw new Error(prApiErrorMessage(msg));
      }
      diffCache.set(key, { data: null, ts: Date.now() });
      return null;
    }
  })().finally(() => diffInflight.delete(inflightKey));
  diffInflight.set(inflightKey, refresh);
  return refresh;
}

/** Merge-base patch computed from the repo's local checkout — the fallback
 *  when GitHub's API refuses the diff (>300 files). Fetches the base branch
 *  and the PR head ref so both sides exist locally, then diffs exactly what
 *  `gh pr diff` would have returned. */
async function localPrDiffPatch(
  ghRepo: string,
  meta: { number: number; headRefOid: string; baseRefName: string },
  maxPatchBytes?: number,
): Promise<{ patch: string; skippedFiles: number }> {
  const local = Object.values(configuredRepos()).find(
    (r) => r.ghRepo?.toLowerCase() === ghRepo.toLowerCase(),
  )?.repo;
  if (!local) throw new Error(`no local checkout configured for ${ghRepo}`);
  const headRef = `pull/${meta.number}/head`;
  await $`git -C ${local} fetch -q origin ${meta.baseRefName} ${headRef}`.quiet();
  const base = `origin/${meta.baseRefName}`;
  if (maxPatchBytes)
    return boundedCommandPatch(
      ["git", "-C", local, "diff", `${base}...${meta.headRefOid}`],
      maxPatchBytes,
    );
  return {
    patch: await $`git -C ${local} diff ${base}...${meta.headRefOid}`
      .quiet()
      .text(),
    skippedFiles: 0,
  };
}

/** Post a PR comment — inline review comment when path+line given, else a general comment. */
export async function postPrComment(
  branch: string,
  input: PrCommentInput,
  repo: string = DEFAULT_REPO(),
  credential: GithubCredential = serviceGithubCredential,
): Promise<{ ok: true; url?: string } | { error: string }> {
  try {
    credential = await resolveGithubCredential(credential, { write: true });
    if (input.path && input.line) {
      const meta = await getMutationPrMeta(branch, repo, credential);
      if (!meta) return { error: "No PR found for this branch" };
      const args = [
        "api",
        "-X",
        "POST",
        `repos/${repo}/pulls/${meta.number}/comments`,
        "-f",
        `body=${input.body}`,
        "-f",
        `commit_id=${meta.headRefOid}`,
        "-f",
        `path=${input.path}`,
        "-F",
        `line=${input.line}`,
        "-f",
        `side=${input.side || "RIGHT"}`,
      ];
      if (input.startLine && input.startLine !== input.line) {
        args.push("-F", `start_line=${input.startLine}`);
        args.push(
          "-f",
          `start_side=${input.startSide || input.side || "RIGHT"}`,
        );
      }
      const proc = spawnGh(args, credential);
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0)
        return { error: ghApiErrorMessage(out, err, "gh api failed") };
      const url = (() => {
        try {
          return JSON.parse(out).html_url as string;
        } catch {
          return undefined;
        }
      })();
      invalidatePrInfo(repo, branch);
      return { ok: true, url };
    }

    const proc = spawnGh(
      ["pr", "comment", branch, "--repo", repo, "--body", input.body],
      credential,
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0)
      return { error: (err || "gh pr comment failed").slice(0, 300) };
    invalidatePrInfo(repo, branch);
    return { ok: true, url: out.trim() || undefined };
  } catch (e: any) {
    return { error: e.message || String(e) };
  }
}

/**
 * Submit a single GitHub review bundling all pending inline comments, GitHub's
 * native review flow (POST .../pulls/{n}/reviews). The whole batch posts at once
 * with one event (comment / approve / request changes) instead of each inline
 * comment landing as a loose standalone comment. Audited since approving or
 * requesting changes affects the PR's merge state.
 */
export async function submitPrReview(
  branch: string,
  input: PrReviewInput,
  repo: string = DEFAULT_REPO(),
  credential: GithubCredential = serviceGithubCredential,
): Promise<{ ok: true; url?: string } | { error: string }> {
  credential = await resolveGithubCredential(credential, { write: true });
  if (!input.comments.length && !input.body?.trim()) {
    return { error: "Nothing to submit" };
  }

  const meta = await getMutationPrMeta(branch, repo, credential).catch(
    (e: any) => ({
      error: e?.message || String(e),
    }),
  );
  if (!meta) return { error: "No PR found for this branch" };
  if ("error" in meta) return meta;

  const payload = {
    commit_id: meta.headRefOid,
    event: input.event,
    ...(input.body?.trim() ? { body: input.body.trim() } : {}),
    comments: input.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side || "RIGHT",
      ...(c.startLine && c.startLine !== c.line
        ? {
            start_line: c.startLine,
            start_side: c.startSide || c.side || "RIGHT",
          }
        : {}),
      body: c.body,
    })),
  };

  return audited(
    {
      context: "reviews",
      action: "pr_review",
      args: {
        branch,
        number: meta.number,
        event: input.event,
        comments: input.comments.length,
        credential: credential.principal,
      },
    },
    async () => {
      const proc = spawnGh(
        [
          "api",
          "-X",
          "POST",
          `repos/${repo}/pulls/${meta.number}/reviews`,
          "--input",
          "-",
        ],
        credential,
        "pipe",
      );
      proc.stdin.write(JSON.stringify(payload));
      await proc.stdin.end();
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0)
        return { error: ghApiErrorMessage(out, err, "gh api failed") } as const;
      const url = (() => {
        try {
          return JSON.parse(out).html_url as string;
        } catch {
          return undefined;
        }
      })();
      invalidatePrInfo(repo, branch);
      return { ok: true, url } as const;
    },
  );
}

/** Close an open PR without merging it. Human-triggered from the Reviews UI. */
export async function closePr(
  branch: string,
  repo: string = DEFAULT_REPO(),
  credential: GithubCredential = serviceGithubCredential,
): Promise<{ ok: true; url?: string; number: number } | { error: string }> {
  credential = await resolveGithubCredential(credential, { write: true });
  const pr = await getMutationPrMeta(branch, repo, credential);
  if (!pr) return { error: "No PR found for this branch" };
  if (pr.state !== "OPEN")
    return { error: `PR #${pr.number} is ${pr.state.toLowerCase()}, not open` };

  return audited(
    {
      context: "reviews",
      action: "pr_close",
      args: {
        branch,
        number: pr.number,
        credential: credential.principal,
      },
    },
    async () => {
      const proc = spawnGh(
        ["pr", "close", String(pr.number), "--repo", repo],
        credential,
      );
      const [, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0)
        return { error: (err || "gh pr close failed").slice(0, 300) } as const;
      cache.delete(cacheKey(repo, branch));
      diffCache.delete(cacheKey(repo, branch));
      return { ok: true, url: pr.url, number: pr.number } as const;
    },
  );
}

/**
 * Merge a branch's PR via the gh CLI — human-triggered from the Reviews view
 * (the agent never merges on its own; this is a UI affordance for the operator).
 * Defaults to squash. Audited as `reviews/pr_merge` since it mutates the repo.
 */
export async function mergePr(
  branch: string,
  opts: { method?: MergeMethod; deleteBranch?: boolean; force?: boolean } = {},
  repo: string = DEFAULT_REPO(),
  credential: GithubCredential = serviceGithubCredential,
): Promise<{ ok: true; url?: string } | { error: string }> {
  credential = await resolveGithubCredential(credential, { write: true });
  const pr = await getMutationPrMeta(branch, repo, credential);
  if (!pr) return { error: "No PR found for this branch" };
  if (pr.state !== "OPEN")
    return { error: `PR #${pr.number} is ${pr.state.toLowerCase()}, not open` };
  if (pr.isDraft)
    return { error: `PR #${pr.number} is a draft — mark it ready first` };

  // Stack order: a layer merges into the one below it, so it can't land while
  // a lower layer is still open. GitHub enforces this itself — verified live
  // against stack #5404 on 2026-07-30, where mergePullRequest answered "must
  // be merged sequentially using the stack merge API" — so this gate exists
  // for the message, not the protection: it names the blocking PR instead of
  // surfacing a raw GraphQL error. `force` skips our check only; GitHub still
  // refuses, so there is no way to merge a stack out of order from here.
  // Taking several layers at once is a different operation — mergePrStack()
  // (GitHub's atomic stack merge), which the "Merge stack" action calls.
  if (!opts.force) {
    const stack = await getPrStack(repo, pr.number, credential);
    const below = stack ? unmergedLayersBelow(stack) : [];
    if (below.length)
      return {
        error:
          `PR #${pr.number} is layer ${stack!.position} of stack #${stack!.number} and ` +
          `${below.length === 1 ? "the layer" : "the layers"} below ${below.length === 1 ? "is" : "are"} still open (` +
          `${below.map((l) => `#${l.number}`).join(", ")}). Merge the stack instead, ` +
          "which lands every layer up to this one at once.",
      };
  }

  const method = opts.method || "squash";
  const flag =
    method === "merge"
      ? "--merge"
      : method === "rebase"
        ? "--rebase"
        : "--squash";

  return audited(
    {
      context: "reviews",
      action: "pr_merge",
      args: {
        branch,
        number: pr.number,
        method,
        deleteBranch: !!opts.deleteBranch,
        credential: credential.principal,
      },
    },
    async () => {
      const args = ["pr", "merge", String(pr.number), "--repo", repo, flag];
      if (opts.deleteBranch) args.push("--delete-branch");
      const proc = spawnGh(args, credential);
      const [, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0)
        return { error: (err || "gh pr merge failed").slice(0, 300) } as const;
      // Drop cached PR/diff so the UI reflects the merge on the next poll.
      cache.delete(cacheKey(repo, branch));
      diffCache.delete(cacheKey(repo, branch));
      return { ok: true, url: pr.url } as const;
    },
  );
}

/**
 * Add and/or remove GitHub reviewers on the PR for `branch` (best-effort — the
 * caller ignores the result on failure). Mirrors the Open Session review-request
 * chip onto GitHub's own Reviewers list: setting a reviewer in the info panel
 * also `--add-reviewer`s them, re-assigning removes the old and adds the new,
 * and clearing removes them. `remove` takes a list so a clear can also withdraw
 * requests made on GitHub itself. `gh pr edit` takes the branch as the PR selector,
 * so no separate lookup is needed; a branch with no open PR just errors.
 */
export async function editPrReviewers(
  branch: string,
  opts: { add?: string | null; remove?: string | string[] | null },
  repo: string = DEFAULT_REPO(),
  credential: GithubCredential = serviceGithubCredential,
): Promise<{ ok: true } | { error: string }> {
  credential = await resolveGithubCredential(credential, { write: true });
  const args = ["pr", "edit", branch, "--repo", repo];
  if (opts.add) args.push("--add-reviewer", opts.add);
  // A list, because withdrawing a request made on GitHub rather than here can
  // mean several reviewers at once (see prReviewerSpecs).
  const removals = (
    Array.isArray(opts.remove) ? opts.remove : [opts.remove]
  ).filter((person): person is string => !!person && person !== opts.add);
  for (const person of removals) args.push("--remove-reviewer", person);
  if (args.length === 4) return { ok: true }; // nothing to do
  try {
    const proc = spawnGh(args, credential);
    const [, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0)
      return { error: (err || "gh pr edit failed").slice(0, 300) };
    cache.delete(cacheKey(repo, branch)); // reviewRequests changed
    return { ok: true };
  } catch (e: any) {
    return { error: e.message || String(e) };
  }
}

/**
 * The PR's pending review requests as `--remove-reviewer` specs: user logins,
 * and `owner/team-slug` for a team request. This is what lets the info panel
 * withdraw a request made on GitHub itself, which Open Session has no local
 * record of. Person keys can't stand in: a team request is expanded to its
 * members' keys for display (github-review-requests.ts), and removing a member
 * never withdraws the team's request. `null` when the branch has no PR.
 */
export async function prReviewerSpecs(
  branch: string,
  repo: string = DEFAULT_REPO(),
  credential: GithubCredential = serviceGithubCredential,
): Promise<string[] | null> {
  credential = await resolveGithubCredential(credential);
  const proc = spawnGh(
    ["pr", "view", branch, "--repo", repo, "--json", "reviewRequests"],
    credential,
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    if (isNoPrError(err)) return null;
    throw new Error(prApiErrorMessage(err));
  }
  return reviewRequestRemovalSpecs(
    JSON.parse(out || "{}")?.reviewRequests || [],
    repo.split("/")[0] || "",
  );
}

/**
 * Rewrite the PR description through a mutator over the current body — used by
 * the walkthrough mirror to splice its managed section in place. Reads the
 * live body first (never a cached one: humans edit descriptions) and writes
 * via REST (PATCH pulls/{n} with an --input file so markdown/quotes/newlines
 * survive shell-free). NOT `gh pr edit`: its GraphQL preamble resolves org
 * teams and needs read:org, which the installation and device-flow
 * OAuth tokens carry: it fails unconditionally on private org repos (verified
 * live on a private org repo; same class as the label-edit
 * gotcha).
 */
export async function updatePrBody(
  branch: string,
  mutate: (body: string) => string,
  repo: string = DEFAULT_REPO(),
): Promise<{ ok: true; number: number; url: string } | { error: string }> {
  try {
    const ghEnv = await selectedGhEnv({ write: true });
    const view = Bun.spawn(
      ["gh", "pr", "view", branch, "--repo", repo, "--json", "body,number,url"],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...ghEnv } },
    );
    const [out, viewErr, viewCode] = await Promise.all([
      new Response(view.stdout).text(),
      new Response(view.stderr).text(),
      view.exited,
    ]);
    if (viewCode !== 0)
      return { error: (viewErr || "gh pr view failed").slice(0, 300) };
    const pr = JSON.parse(out) as { body: string; number: number; url: string };
    const next = mutate(pr.body || "");
    if (next === (pr.body || ""))
      return { ok: true, number: pr.number, url: pr.url };
    const tmp = `/tmp/opensession-pr-body-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    await Bun.write(tmp, JSON.stringify({ body: next }));
    try {
      const edit = Bun.spawn(
        [
          "gh",
          "api",
          "-X",
          "PATCH",
          `repos/${repo}/pulls/${pr.number}`,
          "--input",
          tmp,
        ],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...ghEnv } },
      );
      const [, editErr, editCode] = await Promise.all([
        new Response(edit.stdout).text(),
        new Response(edit.stderr).text(),
        edit.exited,
      ]);
      if (editCode !== 0)
        return {
          error: (editErr || "gh api pulls PATCH failed").slice(0, 300),
        };
    } finally {
      await Bun.file(tmp)
        .unlink()
        .catch(() => {});
    }
    cache.delete(cacheKey(repo, branch)); // body changed
    return { ok: true, number: pr.number, url: pr.url };
  } catch (e: any) {
    return { error: e.message || String(e) };
  }
}

// One in-flight `gh pr view` per branch — concurrent panels share the promise
// instead of stacking subprocesses.
const inflight = new Map<string, Promise<PrDetails | null>>();

/**
 * Stale-while-revalidate: a fresh cache entry answers directly; an EXPIRED one
 * still answers immediately (the status header shouldn't block ~1s on a GitHub
 * round-trip every 30s) while the refresh runs in the background and lands for
 * the next poll. Only a branch with no cache at all waits on gh. During a
 * rate-limit window, ANY cached answer (even a stale "no PR") is served
 * without spawning gh; when a refresh fails outright, a stale snapshot still
 * beats surfacing an error to the panel.
 */
export async function getPrDetails(
  branch: string,
  repo: string = DEFAULT_REPO(),
): Promise<PrDetails | null> {
  const key = cacheKey(repo, branch);
  const hit = cache.get(key);
  if (hit && !shouldRefreshPrDetails(hit.ts)) return hit.data;
  // Known backoff window: serve any cached answer, and with nothing cached
  // fail fast with the friendly message rather than spawning a doomed gh call.
  if (ghRateLimited()) {
    if (hit) return hit.data;
    throw new Error(GH_RATE_LIMIT_MESSAGE);
  }

  let refresh = inflight.get(key);
  if (!refresh) {
    refresh = fetchPrDetails(branch, repo)
      .then((data) => {
        cache.set(key, { data, ts: Date.now() });
        schedulePersist();
        return data;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, refresh);
  }
  if (hit?.data) {
    void refresh.catch(() => {});
    return hit.data;
  }
  return refresh.catch((e) => {
    if (hit) return hit.data;
    throw e;
  });
}

/** Bypass the UI's stale-while-revalidate cache for action completion gates. */
export async function getPrDetailsFresh(
  branch: string,
  repo: string = DEFAULT_REPO(),
): Promise<PrDetails | null> {
  // A completion gate must not act on stale data, so during a rate-limit
  // window it fails fast with the friendly message instead of burning a call.
  if (ghRateLimited()) throw new Error(GH_RATE_LIMIT_MESSAGE);
  const data = await fetchPrDetails(branch, repo);
  cache.set(cacheKey(repo, branch), { data, ts: Date.now() });
  schedulePersist();
  return data;
}

/** True for "this branch/number has no PR" — a real answer, not a failure. */
export function isNoPrError(msg: string): boolean {
  return /no pull requests found|Could not resolve to a PullRequest/i.test(msg);
}

export const GH_RATE_LIMIT_MESSAGE =
  "GitHub's API rate limit has been reached. Try again after it resets.";
export const GH_REST_RATE_LIMIT_MESSAGE =
  "GitHub REST is rate-limited. This pull request action will retry after it resets.";

export function prApiErrorMessage(msg: string): string {
  if (/rate limit/i.test(msg)) return GH_RATE_LIMIT_MESSAGE;
  if (/authentication|bad credentials|requires authentication/i.test(msg))
    return "GitHub authentication failed. Check the GitHub connection.";
  if (/resource not accessible/i.test(msg))
    return "The GitHub App is missing a permission for this API. Check its installation permissions.";
  return "GitHub's pull request API is unavailable right now.";
}

/**
 * Turn a failed `gh api` call into something the person reading it can act on.
 *
 * GitHub puts the real reason for a 422 in `errors[]` ("Line could not be
 * resolved"), but gh's error line stops at the top-level `message` — so its
 * stderr is the useless "gh: Unprocessable Entity (HTTP 422)" while the
 * response body, which gh prints on stdout even when it exits non-zero, holds
 * the detail. Read the body first and keep stderr as the fallback.
 */
export function ghApiErrorMessage(
  out: string,
  err: string,
  fallback: string,
): string {
  const body = (() => {
    try {
      return JSON.parse(out.trim());
    } catch {
      return null;
    }
  })();
  const detail = Array.isArray(body?.errors)
    ? body.errors
        .map((e: any) =>
          typeof e === "string"
            ? e
            : // A per-error `message` is the human sentence; without one, the
              // shape has to be assembled from the resource/field/code triple.
              e?.message ||
              [e?.resource, e?.field, e?.code].filter(Boolean).join(" "),
        )
        .filter(Boolean)
        .join("; ")
    : "";
  // "Unprocessable Entity" is the bare status name, so it adds nothing once
  // errors[] is in hand; a real message ("Validation Failed") still leads.
  const message =
    typeof body?.message === "string" &&
    !/^unprocessable entity$/i.test(body.message)
      ? body.message
      : "";
  const base = [message, detail].filter(Boolean).join(": ");
  const msg = (base || err.trim() || fallback).slice(0, 300);
  // The anchor failures are the ones people hit, and the reason is never the
  // comment itself: the diff moved under it.
  return /could not be resolved/i.test(detail)
    ? `${msg}. The comment no longer matches the PR's current diff. Reload the diff and add it again.`
    : msg;
}

function isPermanentPrApiError(msg: string): boolean {
  // "Resource not accessible" = the token lacks a permission (e.g. Checks:read
  // for statusCheckRollup) — retrying only burns GraphQL quota.
  return /rate limit|authentication|bad credentials|requires authentication|resource not accessible/i.test(
    msg,
  );
}

// The App permission set includes Checks: read, so every PR details query asks
// for the rollup and fails visibly if the installation is misconfigured.
async function fetchPrDetails(
  branch: string,
  repo: string,
): Promise<PrDetails | null> {
  let data: PrDetails | null = null;
  try {
    // Under load GitHub sporadically aborts the GraphQL response mid-stream
    // ("stream error: … CANCEL; received from peer") — that's transient, and
    // treating it as "no PR" broke PR actions (PR #4910). Retry transient
    // failures; a genuine "no pull requests found" stays a fast null.
    let raw = "";
    const selectedEnv = await selectedGhEnv();
    for (let attempt = 1; ; attempt++) {
      const baseFields =
        "number,title,url,state,isDraft,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,reviewDecision,author,body,mergeable,mergeStateStatus,comments,commits,files,latestReviews,reviewRequests";
      const fields = `${baseFields},statusCheckRollup`;
      const queryStarted = Date.now();
      try {
        raw = await $`gh pr view ${branch} --repo ${repo} --json ${fields}`
          .env({ ...process.env, ...selectedEnv })
          .quiet()
          .text();
        noteGithubGraphqlCall(
          "pr-info:details",
          Date.now() - queryStarted,
          true,
        );
        break;
      } catch (e: any) {
        noteGithubGraphqlCall(
          "pr-info:details",
          Date.now() - queryStarted,
          false,
        );
        const msg = String(e?.stderr || e?.message || e).slice(0, 300);
        if (isNoPrError(msg) || isPermanentPrApiError(msg) || attempt >= 3)
          throw e;
        console.warn(
          `[pr-info] gh pr view ${branch} (${repo}) attempt ${attempt} failed, retrying: ${msg}`,
        );
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
    const pr = JSON.parse(raw);
    data = {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      reviewDecision: pr.reviewDecision || "",
      author: pr.author?.login || "",
      body: pr.body || "",
      checks: latestWorkflowChecks(
        (pr.statusCheckRollup || []).map((c: any) => ({
          name: c.name || c.context || "check",
          status: c.status || (c.state ? "COMPLETED" : ""),
          conclusion: c.conclusion || c.state || "",
          url: c.detailsUrl || c.targetUrl || undefined,
          startedAt: c.startedAt || undefined,
          completedAt: c.completedAt || undefined,
          workflowName: c.workflowName || undefined,
        })),
      ),
      comments: (pr.comments || [])
        .filter((c: any) => String(c.body || "").trim())
        .map((c: any) => ({
          author: c.author?.login || c.author?.name || "",
          body: String(c.body || ""),
          url: c.url || undefined,
          createdAt: c.createdAt || undefined,
        })),
      commits: (pr.commits || []).map((commit: any) => ({
        oid: commit.oid || "",
        messageHeadline: commit.messageHeadline || "Commit",
        messageBody: commit.messageBody || undefined,
        authoredDate: commit.authoredDate || commit.committedDate || undefined,
        author:
          commit.authors?.[0]?.login ||
          commit.authors?.[0]?.name ||
          commit.author?.login ||
          commit.author?.name ||
          "Unknown",
      })),
      files: buildFiles(pr.files),
      reviewers: buildReviewers(pr.latestReviews, pr.reviewRequests),
      mergeable: pr.mergeable || "UNKNOWN",
      mergeStateStatus: pr.mergeStateStatus || "",
      staging: parseStaging(pr.comments),
    };
    // Stacks live in GraphQL only (no `gh pr view --json stack`), so this is a
    // second call — paid once per cache miss, and never fatal: getPrStack
    // swallows its own failures and answers null.
    data.stack = await getPrStack(repo, pr.number);
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || e).slice(0, 300);
    if (!isNoPrError(msg)) {
      if (isGhRateLimitMsg(msg)) noteGhRateLimited("pr-info");
      console.warn(`[pr-info] gh pr view ${branch} (${repo}) failed: ${msg}`);
      throw new Error(prApiErrorMessage(msg));
    }
    data = null;
  }

  return data;
}
