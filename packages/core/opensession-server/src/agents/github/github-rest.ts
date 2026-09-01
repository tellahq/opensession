/**
 * Write-capable GitHub REST helpers for the github PR agent. The Slack agent's
 * `githubApi` is read-shaped (GET only); these add method + body and the specific
 * calls the review/fix/simplify behaviors need: the single updating summary
 * comment, formal reviews with inline comments, and label removal.
 *
 * Auth: a short-lived App installation token, resolved per call so expiry
 * refresh is transparent and missing authority fails closed.
 */
import { fetchWithTimeout } from "../../server/shared/fetch-with-timeout";
import {
  defaultRepo,
  githubBotLogins,
  isGithubBotLogin,
  personaName,
} from "../../server/config";
import {
  githubConfiguredCredential,
  githubToken,
} from "../../server/github-app";
import {
  ghRateLimited,
  isGhRateLimitMsg,
  noteGhRateLimited,
} from "../../server/github-limit";
import { noteGithubGraphqlCall } from "../../server/github-budget";
/** The PR agent's target — the instance's default repo (config-driven). */
export const GITHUB_REPO = defaultRepo().ghRepo;
/** The bot account our token posts as — used to recognise our own comments/events. */
export const BOT_LOGIN = githubBotLogins()[0] || "";
/** Hidden markers the agent stamps on the comments it posts. */
export const REVIEW_MARKER = "<!-- os-review -->";
const REVIEW_OUTDATED_MARKER = "<!-- os-review-outdated -->";
export const REPLY_MARKER = "<!-- os-reply -->";
export const AUTOFIX_MARKER = "<!-- os-autofix -->";
export const SIMPLIFY_MARKER = "<!-- os-simplify -->";
export const ADVERSARIAL_MARKER = "<!-- os-adversarial -->";

export const OWN_MARKERS = [
  REVIEW_MARKER,
  REVIEW_OUTDATED_MARKER,
  REPLY_MARKER,
  AUTOFIX_MARKER,
  SIMPLIFY_MARKER,
  ADVERSARIAL_MARKER,
];

/** Whether a comment is the unfinished review placeholder for this head. */
export function isReviewProgressForHead(
  body: string,
  headSha: string,
): boolean {
  if (!body.startsWith(REVIEW_MARKER)) return false;
  const match = body.match(/🔄 Reviewing(?: `([0-9a-f]{7,40})`)?…/i);
  if (!match) return false;
  const shownSha = match[1];
  return (
    !shownSha ||
    Boolean(headSha && headSha.toLowerCase().startsWith(shownSha.toLowerCase()))
  );
}

export function githubConfigured(): boolean {
  return githubConfiguredCredential();
}

interface GithubResult<T = any> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

export async function githubRequest<T = any>(
  method: string,
  path: string,
  body?: unknown,
): Promise<GithubResult<T>> {
  const token = await githubToken({ write: true });
  if (!token)
    return {
      ok: false,
      status: 0,
      data: null,
      error: "GitHub App credential unavailable",
    };
  try {
    // Timeout matters here: these calls run while holding a per-PR lock with
    // no TTL — a hung fetch would block that PR until the next restart.
    const resp = await fetchWithTimeout(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data: any = null;
    const text = await resp.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!resp.ok) {
      const error =
        (data && (data.message || data.error)) || `GitHub ${resp.status}`;
      console.warn(`[github] ${method} ${path} → ${resp.status}: ${error}`);
      if (
        (resp.status === 403 || resp.status === 429) &&
        (resp.headers.get("x-ratelimit-remaining") === "0" ||
          isGhRateLimitMsg(String(error)))
      ) {
        const resetHeader = resp.headers.get("x-ratelimit-reset");
        if (resetHeader)
          noteGhRateLimited("github-rest", Number(resetHeader) * 1000, "rest");
        else noteGhRateLimited("github-rest", undefined, "rest");
      }
      return { ok: false, status: resp.status, data, error };
    }
    return { ok: true, status: resp.status, data };
  } catch (e: any) {
    console.warn(`[github] ${method} ${path} error:`, e);
    return { ok: false, status: 0, data: null, error: e.message || String(e) };
  }
}

/**
 * GraphQL request (the REST API can't resolve review threads). Same App auth as
 * the REST helper. Returns the `data` object, or null on any error.
 */
async function githubGraphQL<T = any>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T | null> {
  const token = await githubToken({ write: true });
  if (!token) return null;
  if (ghRateLimited()) return null;
  const started = Date.now();
  try {
    const resp = await fetchWithTimeout("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: variables || {} }),
    });
    const json: any = await resp.json().catch(() => null);
    if (!resp.ok || !json || json.errors) {
      noteGithubGraphqlCall(
        "github-agent:review-threads",
        Date.now() - started,
        false,
      );
      const msg =
        json?.errors?.map((e: any) => e.message).join("; ") ||
        `GitHub GraphQL ${resp.status}`;
      console.warn(`[github] graphql → ${resp.status}: ${msg}`);
      if (
        json?.errors?.some((e: any) => e.type === "RATE_LIMITED") ||
        isGhRateLimitMsg(msg)
      ) {
        noteGhRateLimited("github-graphql");
      }
      return null;
    }
    noteGithubGraphqlCall(
      "github-agent:review-threads",
      Date.now() - started,
      true,
    );
    return json.data as T;
  } catch (e: any) {
    noteGithubGraphqlCall(
      "github-agent:review-threads",
      Date.now() - started,
      false,
    );
    console.warn(`[github] graphql error:`, e);
    return null;
  }
}

// ── Single updating summary comment ──────────────────────────

interface IssueComment {
  id: number;
  body: string;
  user: { login: string };
}

/** Fetch a single issue comment's body. */
export async function getComment(
  commentId: number,
  ghRepo: string = GITHUB_REPO,
): Promise<IssueComment | null> {
  const r = await githubRequest<IssueComment>(
    "GET",
    `/repos/${ghRepo}/issues/comments/${commentId}`,
  );
  return r.ok && r.data ? r.data : null;
}

async function listIssueComments(
  prNumber: number,
  ghRepo: string,
): Promise<IssueComment[]> {
  const list = await githubRequest<IssueComment[]>(
    "GET",
    `/repos/${ghRepo}/issues/${prNumber}/comments?per_page=100`,
  );
  return list.ok && Array.isArray(list.data) ? list.data : [];
}

/** Find the current (active, not-outdated) agent review comment id, if any. */
export async function findActiveReviewComment(
  prNumber: number,
  ghRepo: string = GITHUB_REPO,
): Promise<number | null> {
  const mine = (await listIssueComments(prNumber, ghRepo))
    .reverse()
    .find(
      (c) => typeof c.body === "string" && c.body.startsWith(REVIEW_MARKER),
    );
  return mine ? mine.id : null;
}

/** Recover a progress POST that succeeded just before its id was persisted. */
export async function findReviewProgressComment(
  prNumber: number,
  headSha: string,
  ghRepo: string = GITHUB_REPO,
): Promise<number | null> {
  const mine = (await listIssueComments(prNumber, ghRepo))
    .reverse()
    .find(
      (c) =>
        typeof c.body === "string" && isReviewProgressForHead(c.body, headSha),
    );
  return mine ? mine.id : null;
}

/** Collapse a prior review comment under a "Outdated review" <details> and re-mark it. */
export async function supersedeReviewComment(
  commentId: number,
  ghRepo: string = GITHUB_REPO,
): Promise<void> {
  const old = await getComment(commentId, ghRepo);
  if (!old?.body) return;
  let inner = old.body
    .replace(REVIEW_MARKER, "")
    .replace(REVIEW_OUTDATED_MARKER, "")
    .trim();
  const detailsMatch = inner.match(
    /<details>[\s\S]*?<summary>[\s\S]*?<\/summary>\s*([\s\S]*?)<\/details>/i,
  );
  if (detailsMatch) inner = detailsMatch[1].trim(); // avoid nesting details on re-supersede
  const collapsed = `${REVIEW_OUTDATED_MARKER}\n<details>\n<summary>🕙 Outdated review — superseded by a newer review below</summary>\n\n${inner}\n\n</details>`;
  await githubRequest(
    "PATCH",
    `/repos/${ghRepo}/issues/comments/${commentId}`,
    { body: collapsed },
  );
}

export interface ReviewCommentInfo {
  id: number;
  path: string;
  line: number | null;
  body: string;
  login: string;
  outdated: boolean;
}

/** List the inline review comments on a PR (for auto-fix to address + reply to). Newest first. */
async function listReviewComments(
  prNumber: number,
  ghRepo: string = GITHUB_REPO,
): Promise<ReviewCommentInfo[]> {
  const r = await githubRequest<any[]>(
    "GET",
    `/repos/${ghRepo}/pulls/${prNumber}/comments?per_page=100`,
  );
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data
    .map((c) => ({
      id: c.id,
      path: c.path,
      // `line` is null once a comment goes outdated (the line changed/disappeared).
      line: typeof c.line === "number" ? c.line : null,
      body: typeof c.body === "string" ? c.body : "",
      login: c.user?.login || "",
      outdated: c.line == null && c.original_line != null,
    }))
    .reverse();
}

export interface ReviewInfo {
  login: string;
  body: string;
  state: string;
}

/** List the formal reviews on a PR that carry a summary body (Greptile/human/agent). */
async function listReviews(
  prNumber: number,
  ghRepo: string = GITHUB_REPO,
): Promise<ReviewInfo[]> {
  const r = await githubRequest<any[]>(
    "GET",
    `/repos/${ghRepo}/pulls/${prNumber}/reviews?per_page=100`,
  );
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data
    .filter((rv) => typeof rv.body === "string" && rv.body.trim())
    .map((rv) => ({
      login: rv.user?.login || "",
      body: rv.body,
      state: rv.state || "",
    }));
}

/** Reply within a review-comment thread (inline @mention replies). */
export async function replyToReviewComment(
  prNumber: number,
  commentId: number,
  body: string,
  ghRepo: string = GITHUB_REPO,
): Promise<boolean> {
  const r = await githubRequest(
    "POST",
    `/repos/${ghRepo}/pulls/${prNumber}/comments/${commentId}/replies`,
    { body },
  );
  return r.ok;
}

/** Post a plain (non-marker) comment on the PR — used for fix/simplify status. */
export async function postIssueComment(
  prNumber: number,
  body: string,
  ghRepo: string = GITHUB_REPO,
): Promise<number | null> {
  const created = await githubRequest<IssueComment>(
    "POST",
    `/repos/${ghRepo}/issues/${prNumber}/comments`,
    { body },
  );
  return created.ok && created.data ? created.data.id : null;
}

/** Edit an existing comment (status comments edited in place across fix iterations). */
export async function editIssueComment(
  commentId: number,
  body: string,
  ghRepo: string = GITHUB_REPO,
): Promise<boolean> {
  const r = await githubRequest(
    "PATCH",
    `/repos/${ghRepo}/issues/comments/${commentId}`,
    { body },
  );
  return r.ok;
}

/**
 * Edit `reuseId` if given and still editable, else post a new comment. Returns the
 * comment id. Used so a run reuses its own progress comment within the run (and on
 * restart recovery) but a fresh trigger — which passes no reuseId — posts a new one.
 */
export async function postOrEditComment(
  prNumber: number,
  reuseId: number | undefined,
  body: string,
  ghRepo: string = GITHUB_REPO,
): Promise<number | null> {
  if (reuseId) {
    if (await editIssueComment(reuseId, body, ghRepo)) return reuseId;
  }
  return postIssueComment(prNumber, body, ghRepo);
}

// ── Formal review with inline comments ───────────────────────

export interface ReviewInlineComment {
  path: string;
  line: number;
  side?: "RIGHT" | "LEFT";
  body: string;
}

/**
 * Submit a formal PR review (event COMMENT) carrying inline comments anchored to
 * diff lines. GitHub auto-outdates these as the code changes — no manual cleanup.
 * Comments whose path/line aren't on the diff make the whole call fail, so callers
 * should pre-validate against the patch; we also retry without comments on failure
 * so the summary review still posts.
 */
export async function submitReview(
  prNumber: number,
  commitId: string,
  body: string,
  comments: ReviewInlineComment[],
  ghRepo: string = GITHUB_REPO,
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    commit_id: commitId,
    event: "COMMENT",
    body,
    comments: comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side || "RIGHT",
      body: c.body,
    })),
  };
  const r = await githubRequest(
    "POST",
    `/repos/${ghRepo}/pulls/${prNumber}/reviews`,
    payload,
  );
  if (r.ok) return true;
  if (comments.length) {
    // Inline anchors can be rejected (line not in diff) — fall back to a body-only review.
    const r2 = await githubRequest(
      "POST",
      `/repos/${ghRepo}/pulls/${prNumber}/reviews`,
      {
        commit_id: commitId,
        event: "COMMENT",
        body,
      },
    );
    return r2.ok;
  }
  return false;
}

// ── Review thread resolution (GraphQL) ───────────────────────

/** Hidden marker the auto-fixer stamps on its "Fixed in <sha>" thread replies. */
export const FIXED_REPLY_MARKER = "<!-- os-fixed -->";

export interface ReviewThreadComment {
  login: string;
  body: string;
  /** 👍 / 👎 reaction counts (feedback signal for the review filter). */
  plus?: number;
  minus?: number;
}

export interface ReviewThread {
  /** GraphQL node id — the handle `resolveReviewThread` needs. */
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  /** File the thread is anchored to (null for a file-level/detached thread). */
  path: string | null;
  /** Current head-side line the thread anchors to (null once outdated). */
  line: number | null;
  /** login of the thread's first (root) comment author. */
  rootAuthor: string;
  /** Every comment in the thread, oldest first (root + replies). */
  comments: ReviewThreadComment[];
}

/**
 * List a PR's review threads with their resolve/outdated state and comments — the
 * bridge REST doesn't expose. Used to find threads the fixer replied "Fixed in
 * <sha>" to (so we can resolve them) and to sweep stale outdated bot threads.
 */
export async function listReviewThreads(
  prNumber: number,
  ghRepo: string = GITHUB_REPO,
): Promise<ReviewThread[]> {
  const data = await githubGraphQL<any>(
    `query($owner:String!,$name:String!,$number:Int!){
      repository(owner:$owner,name:$name){
        pullRequest(number:$number){
          reviewThreads(first:100){
            nodes{
              id isResolved isOutdated path line
              comments(first:100){ nodes{ author{login} body reactionGroups{ content reactors{ totalCount } } } }
            }
          }
        }
      }
    }`,
    {
      owner: ghRepo.split("/")[0],
      name: ghRepo.split("/")[1],
      number: prNumber,
    },
  );
  const nodes = data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.map((t: any) => {
    const comments = (t.comments?.nodes || []).map((c: any) => {
      const groups: any[] = Array.isArray(c.reactionGroups)
        ? c.reactionGroups
        : [];
      const count = (content: string) =>
        groups.find((g) => g?.content === content)?.reactors?.totalCount || 0;
      return {
        login: c.author?.login || "",
        body: typeof c.body === "string" ? c.body : "",
        plus: count("THUMBS_UP"),
        minus: count("THUMBS_DOWN"),
      };
    });
    return {
      id: t.id,
      isResolved: !!t.isResolved,
      isOutdated: !!t.isOutdated,
      path: typeof t.path === "string" ? t.path : null,
      line: typeof t.line === "number" ? t.line : null,
      rootAuthor: comments[0]?.login || "",
      comments,
    };
  });
}

/** Mark a single review thread resolved by its node id. */
export async function resolveReviewThread(threadId: string): Promise<boolean> {
  const data = await githubGraphQL<any>(
    `mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }`,
    { id: threadId },
  );
  return !!data?.resolveReviewThread?.thread?.isResolved;
}

/** A thread the auto-fixer addressed: it left a "Fixed in <sha>" reply (not the root). */
function threadWasFixed(t: ReviewThread): boolean {
  return t.comments
    .slice(1)
    .some(
      (c) =>
        isGithubBotLogin(c.login) &&
        (c.body.includes(FIXED_REPLY_MARKER) ||
          /(^|\s)fixed in\b/i.test(c.body)),
    );
}

/**
 * Resolve the review threads the auto-fixer addressed — detected by its own "Fixed
 * in <sha>" reply left in the thread (which the fix prompt instructs it to post).
 * This ties resolution to a genuine fix reply, so "I intentionally didn't act" notes
 * (which don't say "Fixed in") are left open for a human. When `alsoOutdatedBotThreads`
 * is set, also resolves any still-open thread rooted by our own bot account that GitHub
 * already marked outdated (its finding moved/vanished with the diff) — safe cleanup
 * that never touches human threads. Idempotent: already-resolved threads are skipped.
 * Returns the number of threads resolved.
 */
export async function resolveAddressedThreads(
  prNumber: number,
  alsoOutdatedBotThreads = false,
  ghRepo: string = GITHUB_REPO,
): Promise<number> {
  const threads = await listReviewThreads(prNumber, ghRepo);
  if (!threads.length) return 0;
  let resolved = 0;
  for (const t of threads) {
    if (t.isResolved) continue;
    const staleBot =
      alsoOutdatedBotThreads && t.isOutdated && isGithubBotLogin(t.rootAuthor);
    if (!threadWasFixed(t) && !staleBot) continue;
    if (await resolveReviewThread(t.id)) resolved++;
  }
  return resolved;
}

// ── Open-PR listing (reconcile sweep) ────────────────────────

export interface OpenPrSummary {
  number: number;
  title: string;
  headRef: string;
  headSha: string;
  draft: boolean;
  labels: string[];
  updatedAt: string;
  createdAt: string;
  /** full_name of the head repo — differs from the base repo on fork PRs. */
  headRepoFullName: string;
  authorLogin: string;
}

/** Open PRs on a repo, most recently updated first (one page — the sweep only
 *  cares about recent activity). */
export async function listOpenPrs(
  ghRepo: string = GITHUB_REPO,
): Promise<OpenPrSummary[]> {
  const r = await githubRequest<any[]>(
    "GET",
    `/repos/${ghRepo}/pulls?state=open&sort=updated&direction=desc&per_page=50`,
  );
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data
    .filter((pr) => pr && typeof pr.number === "number" && pr.head?.ref)
    .map((pr) => ({
      number: pr.number,
      title: typeof pr.title === "string" ? pr.title : `PR #${pr.number}`,
      headRef: pr.head.ref,
      headSha: pr.head.sha || "",
      draft: !!pr.draft,
      labels: (pr.labels || []).map((l: any) => l?.name).filter(Boolean),
      updatedAt: pr.updated_at || "",
      createdAt: pr.created_at || "",
      headRepoFullName: pr.head?.repo?.full_name || "",
      authorLogin: pr.user?.login || "",
    }));
}

// ── Labels ───────────────────────────────────────────────────

/** Remove a label from a PR (action labels are cleared when the action completes). */
export async function removeLabel(
  prNumber: number,
  label: string,
  ghRepo: string = GITHUB_REPO,
): Promise<boolean> {
  const r = await githubRequest(
    "DELETE",
    `/repos/${ghRepo}/issues/${prNumber}/labels/${encodeURIComponent(label)}`,
  );
  // 404 = label already gone; treat as success.
  return r.ok || r.status === 404;
}

/**
 * All open review feedback on the PR, formatted for a fix prompt — inline
 * comments AND review summaries, from EVERY reviewer (the agent, Greptile, humans),
 * each tagged with its author so the agent addresses them all (not just the agent's,
 * not just CI). Skips outdated inline comments and the agent's own boilerplate review
 * body. Returns "" when there's nothing. Shared by auto-fix and the review handoff.
 */
export async function fetchReviewFindings(
  prNumber: number,
  ghRepo?: string,
): Promise<string> {
  const [comments, reviews] = await Promise.all([
    listReviewComments(prNumber, ghRepo),
    listReviews(prNumber, ghRepo),
  ]);
  const lines: string[] = [];
  for (const c of comments.filter((c) => !c.outdated && c.line != null)) {
    // `comment <id>` lets the agent reply in that thread after fixing.
    lines.push(
      `- [@${c.login} · comment ${c.id}] ${c.path}:${c.line} — ${c.body.replace(/\s+/g, " ").trim().slice(0, 400)}`,
    );
  }
  for (const rv of reviews) {
    // Skip the agent's own short review boilerplate. Inline comments already
    // carry its findings.
    if (
      isGithubBotLogin(rv.login) &&
      rv.body.trim().startsWith(`${personaName()} review`)
    )
      continue;
    const state = rv.state
      ? ` ${rv.state.toLowerCase().replace(/_/g, " ")}`
      : "";
    lines.push(
      `- [@${rv.login} review${state}] ${rv.body.replace(/\s+/g, " ").trim().slice(0, 600)}`,
    );
  }
  return lines.join("\n");
}
