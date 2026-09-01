import { request } from "./request";
import type {
  UnifiedSession,
  OsReview,
  PrDetails,
  PrDiffResponse,
  PrHostCapabilities,
  ReviewGuideData,
} from "../types";

/** One open PR from the batched repo-wide list (session or not). */
export interface OpenPr {
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
  checks: { total: number; passed: number; failed: number; pending: number };
  /** MERGEABLE | CONFLICTING | UNKNOWN — the provider's conflict probe. */
  mergeable?: string;
  /** Person keys of teammates with a pending review request on this PR. */
  reviewRequested?: string[];
  /** An automated Open Session review is still running for this PR. */
  reviewActive?: boolean;
  /** What the last automated review concluded. Absent until one has run. */
  osReview?: OsReview;
  /** What the repo's PR host supports; absent means everything (GitHub). */
  capabilities?: PrHostCapabilities;
}

/** Every open PR in the repo, attributed to teammates by GitHub author. */
export async function fetchOpenPrs(): Promise<OpenPr[]> {
  const data = await request<{ prs: OpenPr[] }>("/open-prs", {
    label: "Failed to fetch open PRs",
  });
  return data?.prs || [];
}

export interface RecentPr extends OpenPr {
  state: "OPEN" | "MERGED" | "CLOSED";
  additions: number;
  deletions: number;
  /** The Open Session session that created this PR, when attributed. */
  sessionId?: string;
}

/** Recent PRs across repos, including PRs merged outside Open Session. */
export async function fetchRecentPrs(
  person?: string,
  options: { days?: number; limit?: number } = {},
): Promise<RecentPr[]> {
  const query = new URLSearchParams();
  if (person) query.set("person", person);
  if (options.days) query.set("days", String(options.days));
  if (options.limit) query.set("limit", String(options.limit));
  const suffix = query.size ? `?${query}` : "";
  const data = await request<{ prs: RecentPr[] }>(`/recent-prs${suffix}`, {
    label: "Failed to fetch recent PRs",
  });
  return data?.prs || [];
}

/** One PR from the same open + archived history that powers the PRs page. */
export async function fetchRecentPr(
  repo: string,
  number: number,
): Promise<RecentPr | null> {
  const query = new URLSearchParams({ repo, number: String(number) });
  const data = await request<{ prs: RecentPr[] }>(`/recent-prs?${query}`, {
    label: "Failed to fetch PR",
  });
  return data?.prs?.[0] || null;
}

/** One commit on the default branch of a repo that ships without PRs. */
export interface RecentCommit {
  repo: string;
  sha: string;
  title: string;
  url?: string;
  author: string;
  person: string | null;
  committedAt: string;
  additions: number;
  deletions: number;
  /** The session that wrote it, when the server can name one. */
  sessionId?: string;
}

/** One page of the commit feed: the window served, and whether older history
 *  remains to ask for. */
export interface RecentCommitPage {
  commits: RecentCommit[];
  days: number;
  hasMore: boolean;
}

/**
 * Recent commits for repos with no pull requests (Open Session's own repo),
 * from the last `days`. The server clamps the window to what it reads and
 * says whether anything older is left, so a caller can stop offering to widen
 * a feed that has already reached the end of the history.
 */
export async function fetchRecentCommits(
  days?: number,
): Promise<RecentCommitPage> {
  const suffix = days ? `?days=${days}` : "";
  const data = await request<RecentCommitPage>(`/recent-commits${suffix}`, {
    label: "Failed to fetch recent commits",
  });
  return {
    commits: data?.commits || [],
    days: data?.days || days || 0,
    hasMore: !!data?.hasMore,
  };
}

/** The commit a transcript's sha names, read off the checkout. */
export interface CommitDetails extends RecentCommit {
  /** What git abbreviates to in that repo; `sha` is always the full 40. */
  shortSha: string;
  body?: string;
  filesChanged: number;
  /** Whether it is on the repo's default branch, i.e. whether it shipped. */
  onDefaultBranch: boolean;
  /** That branch's name, so the card can say "on main". */
  defaultBranch: string;
}

/**
 * One commit by sha. `repo` is where the sha was written and is searched
 * first, but the answer names the repo it was found in: prose crosses repos,
 * and the reference should point at the one that actually holds it. Null when
 * no checkout has it, which is a reference we cannot answer rather than an
 * error worth showing.
 */
export async function fetchCommit(
  sha: string,
  repo?: string,
): Promise<CommitDetails | null> {
  const query = new URLSearchParams({ sha });
  if (repo) query.set("repo", repo);
  return (
    (await request<CommitDetails | null>(`/commit?${query}`, {
      label: "Failed to fetch commit",
    })) ?? null
  );
}

export async function fetchDiff(
  sessionId: string,
): Promise<import("../types").SessionDiffResponse> {
  return request<import("../types").SessionDiffResponse>(
    `/sessions/${encodeURIComponent(sessionId)}/diff`,
    { label: "Failed to fetch diff" },
  );
}

export async function fetchCodeFlow(
  sessionId: string,
  repo: string,
): Promise<import("../types").CodeFlowResult | null> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/code-flow?repo=${encodeURIComponent(repo)}`,
    { label: "Failed to analyze code flow" },
  );
}

export async function fetchDiffGroups(
  sessionId: string,
  repo: string,
  files: import("../types").DiffFile[],
  patch: string,
): Promise<{ groups: import("../types").DiffFileGroup[] | null }> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/diff-groups`, {
    method: "POST",
    body: { repo, files, patch },
    label: "Failed to organize changed files",
  });
}

export async function fetchPrDiffGroups(
  sessionId: string,
  files: import("../types").PrFile[],
  patch: string,
  repo?: string,
  branch?: string,
): Promise<{ groups: import("../types").DiffFileGroup[] | null }> {
  const qs = prTargetQs(repo, branch);
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/pr-diff-groups${qs}`,
    {
      method: "POST",
      body: { files, patch },
      label: "Failed to organize changed files",
    },
  );
}

/**
 * Discard one file's changes in a session worktree (hover action on a diff
 * row). Resets the file to its base-branch state so it drops out of the diff.
 * `repo` targets an attached repo; omit for the primary. Destructive.
 */
export async function discardDiffFile(
  sessionId: string,
  path: string,
  repo?: string,
  oldPath?: string,
): Promise<void> {
  await request(`/sessions/${encodeURIComponent(sessionId)}/discard-file`, {
    method: "POST",
    body: { path, ...(repo ? { repo } : {}), ...(oldPath ? { oldPath } : {}) },
    label: "Failed to discard file",
  });
}

/** One comment inside a provider-native code review thread. */
export interface PrReviewThreadComment {
  login: string;
  body: string;
}

/** A resolved inline review conversation, rendered collapsed below its file. */
export interface PrReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  rootAuthor: string;
  comments: PrReviewThreadComment[];
}

/** Resolved code-review threads for one pull request. */
export async function fetchPrReviewThreads(
  repo: string | undefined,
  number: number,
): Promise<PrReviewThread[]> {
  const qs = new URLSearchParams({ number: String(number) });
  if (repo) qs.set("repo", repo);
  const data = await request<{ threads: PrReviewThread[] }>(
    `/pr-review-threads?${qs}`,
    { label: "Failed to load resolved comments" },
  );
  return data?.threads || [];
}

/** The viewer's GitHub "Viewed" file state on a PR (review canvas checkboxes). */
export async function fetchPrViewedFiles(
  repo: string | undefined,
  number: number,
  user?: string,
): Promise<{ prId: string; viewed: string[] }> {
  const qs = new URLSearchParams({ number: String(number) });
  if (repo) qs.set("repo", repo);
  if (user) qs.set("user", user);
  return request(`/pr-viewed-files?${qs}`, {
    label: "Failed to load viewed files",
  });
}

/** Mark/unmark one PR file as viewed on GitHub for the current viewer. */
export async function setPrFileViewed(
  prId: string,
  path: string,
  viewed: boolean,
  user?: string,
): Promise<void> {
  await request(`/pr-viewed-files`, {
    method: "POST",
    body: { prId, path, viewed, user },
    label: "Failed to update viewed state",
  });
}

/** Full text of one file at a PR revision, proxied so private repos work. */
export async function fetchPrFile(
  repo: string | undefined,
  ref: string,
  path: string,
): Promise<string> {
  const qs = new URLSearchParams({ ref, path });
  if (repo) qs.set("repo", repo);
  const data = await request<{ content: string }>(`/pr-file?${qs}`, {
    label: "Failed to load file",
  });
  return data.content;
}

/** Full text of one worktree file (Changes-tab edit mode). `side: "base"` reads
 *  the pre-change version from the merge base; `null` = file absent on that side. */
export async function fetchWorktreeFile(
  sessionId: string,
  path: string,
  repo?: string,
  side: "new" | "base" = "new",
): Promise<string | null> {
  const qs = new URLSearchParams({ path, side });
  if (repo) qs.set("repo", repo);
  const data = await request<{ content: string | null }>(
    `/sessions/${encodeURIComponent(sessionId)}/worktree-file?${qs}`,
    { label: "Failed to load file" },
  );
  return data.content;
}

/** Write one worktree file's full contents (Changes-tab edit-mode save). */
export async function saveWorktreeFile(
  sessionId: string,
  path: string,
  content: string,
  repo?: string,
): Promise<void> {
  await request(`/sessions/${encodeURIComponent(sessionId)}/worktree-file`, {
    method: "POST",
    body: { path, content, ...(repo ? { repo } : {}) },
    label: "Failed to save file",
  });
}

/** Query string targeting one of a session's PRs: `repo` (a repo id) targets an
 *  attached repo's PR, `repo`+`branch` a linked PR; both omitted = primary. */
function prTargetQs(repo?: string, branch?: string) {
  const params = new URLSearchParams();
  if (repo) params.set("repo", repo);
  if (branch) params.set("branch", branch);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function fetchPr(
  sessionId: string,
  repo?: string,
  branch?: string,
): Promise<PrDetails | null> {
  const qs = prTargetQs(repo, branch);
  return request(`/sessions/${encodeURIComponent(sessionId)}/pr${qs}`, {
    label: "Failed to fetch PR",
  });
}

/** Local git state (ahead/behind, dirty tree) for the status header. */
export async function fetchGitStatus(sessionId: string, repo?: string) {
  const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
  return request<import("../types").GitStatusInfo | null>(
    `/sessions/${encodeURIComponent(sessionId)}/git-status${qs}`,
    { label: "Failed to fetch git status" },
  );
}

/** Push the session's branch (sets upstream on first push). */
export async function gitPushApi(sessionId: string, repo?: string) {
  return request<{ ok: true }>(
    `/sessions/${encodeURIComponent(sessionId)}/git-push`,
    { method: "POST", body: repo ? { repo } : {} },
  );
}

/** Update the session checkout. The branch's own upstream is pulled
 * fast-forward-only; `fromBase` merges origin/<default branch>. */
export async function gitPullApi(
  sessionId: string,
  repo?: string,
  fromBase?: boolean,
) {
  return request<{ ok: true }>(
    `/sessions/${encodeURIComponent(sessionId)}/git-pull`,
    {
      method: "POST",
      body: { ...(repo ? { repo } : {}), ...(fromBase ? { base: true } : {}) },
    },
  );
}

export async function fetchPrDiff(
  sessionId: string,
  repo?: string,
  branch?: string,
): Promise<PrDiffResponse | null> {
  const qs = prTargetQs(repo, branch);
  return request(`/sessions/${encodeURIComponent(sessionId)}/pr-diff${qs}`, {
    label: "Failed to fetch PR diff",
  });
}

export async function fetchPrCodeFlow(
  sessionId: string,
  repo?: string,
  branch?: string,
): Promise<import("../types").CodeFlowResult | null> {
  const qs = prTargetQs(repo, branch);
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/pr-code-flow${qs}`,
    { label: "Failed to analyze code flow" },
  );
}

/** AI review guide for the PR's Guide view — slow on first call per head commit. */
export async function fetchReviewGuide(
  sessionId: string,
  repo?: string,
  branch?: string,
): Promise<ReviewGuideData | null> {
  const qs = prTargetQs(repo, branch);
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/review-guide${qs}`,
    {
      label: "Failed to fetch review guide",
    },
  );
}

/** Link a PR to a session by URL (shows beside the branch-derived PRs). */
export async function linkPrApi(sessionId: string, url: string) {
  type LinkedPr = NonNullable<
    import("../types").UnifiedSession["linkedPrs"]
  >[number];
  return request<{ ok: true; linked: LinkedPr; all: LinkedPr[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/link-pr`,
    { method: "POST", body: { url }, label: "Failed to link PR" },
  );
}

/** Drop a linked PR from a session (the link only — the PR is untouched). */
export async function unlinkPrApi(
  sessionId: string,
  repo: string,
  branch: string,
) {
  type LinkedPr = NonNullable<
    import("../types").UnifiedSession["linkedPrs"]
  >[number];
  return request<{ ok: true; all: LinkedPr[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/unlink-pr`,
    { method: "POST", body: { repo, branch }, label: "Failed to unlink PR" },
  );
}

/** Session-less PR details for the sidebar's PR preview (keyed by repo+branch). */
export async function fetchPrPreview(
  repo: string,
  branch: string,
): Promise<PrDetails | null> {
  return request(
    `/pr-preview?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`,
    { label: "Failed to fetch PR" },
  );
}

export async function fetchPrPreviewDiff(
  repo: string,
  branch: string,
): Promise<PrDiffResponse | null> {
  return request(
    `/pr-preview-diff?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`,
    { label: "Failed to fetch PR diff" },
  );
}

export async function fetchPrPreviewCodeFlow(
  repo: string,
  branch: string,
): Promise<import("../types").CodeFlowResult | null> {
  return request(
    `/pr-preview-code-flow?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`,
    { label: "Failed to analyze code flow" },
  );
}

/** Session-less review guide for the PR preview's Guide tab (slow on first call per head commit). */
export async function fetchPrPreviewGuide(
  repo: string,
  branch: string,
): Promise<ReviewGuideData | null> {
  return request(
    `/pr-preview-guide?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`,
    { label: "Failed to fetch review guide" },
  );
}

export async function submitPrReviewApi(
  sessionId: string,
  payload: {
    user: string;
    event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
    summary?: string;
    repo?: string;
    branch?: string;
    comments: Array<{
      text: string;
      path: string;
      line: number;
      startLine?: number;
      side?: "RIGHT" | "LEFT";
      startSide?: "RIGHT" | "LEFT";
    }>;
  },
) {
  const result = await request<{ ok: true; url?: string }>(
    `/sessions/${encodeURIComponent(sessionId)}/pr-review`,
    { method: "POST", body: payload },
  );
  window.dispatchEvent(new Event(PR_REVIEW_SUBMITTED_EVENT));
  return result;
}

export const PR_REVIEW_SUBMITTED_EVENT = "opensession:pr-review-submitted";

export async function submitPrPreviewReviewApi(
  repo: string,
  branch: string,
  payload: Parameters<typeof submitPrReviewApi>[1],
) {
  const result = await request<{ ok: true; url?: string }>(
    "/pr-preview-review",
    {
      method: "POST",
      body: { ...payload, repo, branch },
    },
  );
  window.dispatchEvent(new Event(PR_REVIEW_SUBMITTED_EVENT));
  return result;
}

export async function mergePrApi(
  sessionId: string,
  method: "squash" | "merge" | "rebase" = "squash",
  repo?: string,
  branch?: string,
) {
  return request<{ ok: true; url?: string }>(
    `/sessions/${encodeURIComponent(sessionId)}/pr-merge`,
    {
      method: "POST",
      body: {
        method,
        ...(repo ? { repo } : {}),
        ...(branch ? { branch } : {}),
      },
    },
  );
}

/**
 * Register this session's PR and the one it was stacked on as a GitHub stack.
 * Both PRs must already exist; the server refuses rather than opening one.
 */
export async function linkPrStackApi(sessionId: string) {
  return request<{ ok: true }>(
    `/sessions/${encodeURIComponent(sessionId)}/pr-stack`,
    { method: "POST", body: {} },
  );
}

/**
 * Merge every layer of this PR's stack up to and including it, atomically.
 * `merged` comes back with the numbers that landed. Separate from mergePrApi
 * because it is a different GitHub operation, not a flag on the same one.
 */
export async function mergePrStackApi(
  sessionId: string,
  method: "squash" | "merge" | "rebase" = "squash",
  repo?: string,
  branch?: string,
) {
  return request<{ ok: true; merged: number[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/pr-stack-merge`,
    {
      method: "POST",
      body: {
        method,
        ...(repo ? { repo } : {}),
        ...(branch ? { branch } : {}),
      },
    },
  );
}

export async function mergePrPreviewApi(
  repo: string,
  branch: string,
  method: "squash" | "merge" | "rebase" = "squash",
) {
  return request<{ ok: true; url?: string }>("/pr-preview-merge", {
    method: "POST",
    body: { repo, branch, method },
  });
}

export async function closePrApi(
  sessionId: string,
  repo?: string,
  branch?: string,
) {
  const result = await request<{ ok: true; url?: string }>(
    `/sessions/${encodeURIComponent(sessionId)}/pr-close`,
    {
      method: "POST",
      body: {
        ...(repo ? { repo } : {}),
        ...(branch ? { branch } : {}),
      },
    },
  );
  notifyPrClosed({ repo, branch, url: result.url });
  return result;
}

export async function closePrPreviewApi(repo: string, branch: string) {
  const result = await request<{ ok: true; url?: string }>(
    "/pr-preview-close",
    {
      method: "POST",
      body: { repo, branch },
    },
  );
  notifyPrClosed({ repo, branch, url: result.url });
  return result;
}

export const PR_CLOSED_EVENT = "opensession:pr-closed";

export interface PrClosedDetail {
  repo?: string;
  branch?: string;
  url?: string;
}

function notifyPrClosed(detail: PrClosedDetail) {
  window.dispatchEvent(new CustomEvent(PR_CLOSED_EVENT, { detail }));
}

/** GitHub PR agent behaviors (the opensession-* PR labels) fired straight from the
    info panel: review / auto-fix / simplify / adversarial. */
export type PrAgentAction = "review" | "autofix" | "simplify" | "adversarial";

export async function triggerPrActionApi(
  sessionId: string,
  kind: PrAgentAction,
  user: string,
  repo?: string,
) {
  return request<{
    ok: boolean;
    message?: string;
    url?: string;
    bksId?: string;
    error?: string;
    /** Auto-fix opens a live session in the workspace instead of a headless PR run.
		    The caller navigates into bksId rather than showing a PR status note. */
    openSession?: boolean;
    /** The persisted run session, so the caller can open it without waiting for
		    the next sessions poll. */
    session?: UnifiedSession | null;
  }>(`/sessions/${encodeURIComponent(sessionId)}/pr-action`, {
    method: "POST",
    body: { kind, user, ...(repo ? { repo } : {}) },
  });
}

export async function cancelPrReviewApi(
  sessionId: string,
  user: string,
  repo?: string,
): Promise<{ ok: boolean; cancelled: boolean }> {
  return request<{ ok: boolean; cancelled: boolean }>(
    `/sessions/${encodeURIComponent(sessionId)}/pr-action`,
    {
      method: "POST",
      body: { kind: "cancel-review", user, ...(repo ? { repo } : {}) },
      label: "Couldn't cancel the review",
    },
  );
}
