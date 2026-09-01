/**
 * code.storage PR host. There is no PR concept on the host: a "PR" (change
 * request) is any non-default branch, reviewed as the branch-vs-default diff
 * (branches/diff API) and landed via the merge API. The `repo` argument on
 * every method is the code.storage repo id (Repo.csRepo), not a GitHub
 * owner/name.
 *
 * PR identity: DTOs key on a numeric PR number, so each branch gets a stable
 * synthetic one — 32-bit FNV-1a of the branch name, masked positive — and the
 * number↔branch mapping is re-derived from the live branch list, never
 * persisted.
 *
 * Comments and reviews have no host concept either, so they're backed by git
 * notes on a dedicated ref (COMMENTS_REF): each comment is one branch-tagged
 * JSON line appended to the note on the branch's tip commit at post time, and
 * details reads aggregate the ref's notes by branch tag back into the flat
 * PrComment conversation (so a force-push or merge-base advance can't orphan
 * them). A review is just a comment with a verdict prefix.
 * Reviewer lists/checks/stacks stay unsupported: those methods answer a clear
 * error and the capability flags (CODESTORAGE_CAPABILITIES) hide the surfaces.
 */
import { audited } from "../audit";
import { createHash } from "node:crypto";
import { codeStorageConfig, configuredRepos, personaName } from "../config";
import type { GithubCredential } from "../github-auth";
import type {
  MutationPrMeta,
  PrComment,
  PrCommit,
  PrCommitNote,
  PrDetails,
  PrDiffData,
  PrFile,
} from "../pr-contract";
import { CODESTORAGE_CAPABILITIES, type BulkPr, type PrHost } from "../pr-host";
import {
  deleteBranch,
  getBranchDiff,
  getCommit,
  getNote,
  getRepo as getCsRepo,
  listBranches,
  listCommits,
  listFiles,
  listNotesRefs,
  mergeBranch,
  previewMerge,
  writeNote,
  type CsBranch,
  type CsBranchDiff,
  type CsCommit,
} from "./client";

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable synthetic PR number for a branch: 32-bit FNV-1a, masked positive.
 *  Zero is reserved as "no PR" all over the DTOs, so it maps to 1. */
export function csPrNumber(branch: string): number {
  return fnv1a(branch) & 0x7fffffff || 1;
}

// code.storage has no web UI to deep-link a branch review, so PR urls point at
// the repo on the org's git host — a real location, just not a review page.
function csUrl(repoId: string): string {
  const org = codeStorageConfig()?.org || "org";
  return `https://${org}.code.storage/${repoId}`;
}

const unsupported = (what: string) =>
  ({
    error: `${what} isn't supported on code.storage — it has no pull requests, only branches`,
  }) as const;

const errorMessage = (e: unknown): string => (e as any)?.message || String(e);

// ── Light caches ─────────────────────────────────────────────────────────────
// The UI polls details/diff every ~30s per open tab; a short TTL keeps that
// from hammering the API without the full SWR machinery pr-info.ts needs for
// GitHub's rate limits (code.storage tokens are self-signed — no shared quota).

const TTL = 60_000;
const cacheKey = (repo: string, branch: string) => `${repo}\u0000${branch}`;
const detailsCache = new Map<string, { data: PrDetails | null; ts: number }>();
const diffCache = new Map<string, { data: PrDiffData | null; ts: number }>();
const detailsInflight = new Map<string, Promise<PrDetails | null>>();
const diffInflight = new Map<string, Promise<PrDiffData | null>>();

const REPO_TTL = 10 * 60_000;
const defaultBranchCache = new Map<string, { name: string; ts: number }>();
async function defaultBranchOf(repoId: string): Promise<string> {
  const configured = Object.values(configuredRepos()).find(
    (repo) => repo.host === "codestorage" && repo.csRepo === repoId,
  )?.defaultBranch;
  if (configured) return configured;
  const hit = defaultBranchCache.get(repoId);
  if (hit && Date.now() - hit.ts < REPO_TTL) return hit.name;
  const info = await getCsRepo(repoId);
  const name = info.default_branch || "main";
  defaultBranchCache.set(repoId, { name, ts: Date.now() });
  return name;
}

const BRANCHES_TTL = 15_000;
const branchesCache = new Map<string, { branches: CsBranch[]; ts: number }>();
const branchesInflight = new Map<string, Promise<CsBranch[]>>();
function branchesFor(
  repoId: string,
  maxAgeMs = BRANCHES_TTL,
): Promise<CsBranch[]> {
  const hit = branchesCache.get(repoId);
  if (hit && Date.now() - hit.ts < maxAgeMs)
    return Promise.resolve(hit.branches);
  let p = branchesInflight.get(repoId);
  if (!p) {
    p = listBranches(repoId)
      .then((branches) => {
        branchesCache.set(repoId, { branches, ts: Date.now() });
        return branches;
      })
      .finally(() => branchesInflight.delete(repoId));
    branchesInflight.set(repoId, p);
  }
  return p;
}

async function findBranch(
  repoId: string,
  branch: string,
  fresh = false,
): Promise<CsBranch | null> {
  const branches = await branchesFor(repoId, fresh ? 0 : BRANCHES_TTL);
  return branches.find((b) => b.name === branch) ?? null;
}

/** The branch's current tip SHA; null when the branch doesn't exist (or the
 *  default branch — never a PR). Mutation preflight for the comment paths —
 *  reads the branch list fresh so a comment isn't appended to a tip the
 *  cache doesn't know was just replaced. */
async function branchTipSha(
  repoId: string,
  branch: string,
): Promise<string | null> {
  if (branch === (await defaultBranchOf(repoId))) return null;
  const head =
    (await branchesFor(repoId, 0)).find((b) => b.name === branch) ?? null;
  if (!head) return null;
  if (head.head_sha) return head.head_sha;
  const tip = await getCommit(repoId, branch).catch(() => null);
  return tip?.sha || null;
}

// Which notes namespaces exist at all, and their tip SHAs (one refs-list call
// per repo per TTL): most repos have none, and this collapses the per-commit
// note fetches below to zero requests in that common case. A failed listing
// PROPAGATES (and is never cached): "the notes backend is unreachable" must
// surface as an error, not render as an empty conversation that then sits in
// the details cache looking like "no comments".
const notesRefsCache = new Map<
  string,
  { refs: Map<string, string>; ts: number }
>();
async function existingNotesRefs(repoId: string): Promise<Map<string, string>> {
  const hit = notesRefsCache.get(repoId);
  if (hit && Date.now() - hit.ts < TTL) return hit.refs;
  const refs = new Map(
    (await listNotesRefs(repoId)).map(
      (r) => [r.ref.replace(/^refs\/notes\//, ""), r.sha] as const,
    ),
  );
  notesRefsCache.set(repoId, { refs, ts: Date.now() });
  return refs;
}

function invalidate(repoId: string, branch: string): void {
  const key = cacheKey(repoId, branch);
  detailsCache.delete(key);
  diffCache.delete(key);
  branchesCache.delete(repoId);
  notesRefsCache.delete(repoId);
}

// ── Shaping helpers ──────────────────────────────────────────────────────────

function splitMessage(message: string | undefined): {
  headline: string;
  body: string;
} {
  const text = (message || "").trim();
  const nl = text.indexOf("\n");
  if (nl === -1) return { headline: text, body: "" };
  return {
    headline: text.slice(0, nl).trim(),
    body: text.slice(nl + 1).trim(),
  };
}

/** Commits on the branch since the merge base (newest first, capped one page). */
async function branchCommits(
  repoId: string,
  branch: string,
  mergeBaseSha: string | undefined,
): Promise<CsCommit[]> {
  const page = await listCommits(repoId, { branch, limit: 50 });
  const out: CsCommit[] = [];
  for (const commit of page.commits) {
    if (mergeBaseSha && commit.sha === mergeBaseSha) break;
    out.push(commit);
  }
  return out;
}

/** Changed files (inline + size-filtered), biggest churn first like GitHub's. */
function buildFiles(diff: CsBranchDiff): PrFile[] {
  return [
    ...diff.files.map((f) => ({
      path: f.path,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
    })),
    ...(diff.filtered_files || []).map((f) => ({
      path: f.path,
      additions: 0,
      deletions: 0,
    })),
  ].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
}

function toPrCommit(commit: CsCommit): PrCommit {
  const { headline, body } = splitMessage(commit.message);
  return {
    oid: commit.sha,
    messageHeadline: headline || "Commit",
    messageBody: body || undefined,
    authoredDate: commit.date || undefined,
    author: commit.author_name || "Unknown",
  };
}

/** Small concurrency pool for the per-branch calls in the bulk list. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// code.storage has no user accounts — the acting identity is the credential's
// principal (or the instance persona), used as comment author and, slugged
// into a noreply address, as the author the merge/notes APIs require.
function actingPrincipal(credential?: GithubCredential): string {
  return credential?.principal?.replace(/^user:/, "") || personaName();
}

function mergeAuthor(credential?: GithubCredential): {
  name: string;
  email: string;
} {
  const name = actingPrincipal(credential);
  const slug =
    name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "opensession";
  return { name, email: `${slug}@noreply.code.storage` };
}

/** A branch whose tip IS the merge base is fully contained in the default
 *  branch — merged (fast-forward or via merge commit), nothing ahead. */
function isMergedBranch(
  headSha: string | undefined,
  diff: CsBranchDiff,
): boolean {
  return !!headSha && diff.merge_base_sha === headSha;
}

// ── Notes-backed comments ────────────────────────────────────────────────────

/** The dedicated notes ref review comments live in. Each comment is one JSON
 *  line (CsCommentLine) appended to the note on the branch tip at post time. */
const COMMENTS_REF = "opensession-comments";

/** Note namespaces surfaced as commit annotations in the commits tab. The
 *  comments ref is deliberately not one of them — those render as the
 *  conversation, not as raw notes. */
const COMMIT_NOTE_REFS = ["commits", "reviews", "ci"];

interface CsCommentLine {
  id: string;
  /** Acting credential principal at post time. */
  author: string;
  body: string;
  createdAt: string;
  /** Branch the comment was posted on — the aggregation key, so a comment
   *  survives its commit being orphaned (force-push, rebase, merge-base
   *  advance, >1-page histories). Absent on legacy lines, which are matched
   *  by commit reachability instead. */
  branch?: string;
  /** File anchor for inline review comments (threading is flat). */
  path?: string;
  line?: number;
}

/** Append comments to the note on a commit — one JSON line each, framed with
 *  newlines on both sides so successive appends stay one-per-line whatever
 *  separator (if any) the server inserts between note bodies. `append`
 *  creates the note when absent. */
function appendComments(
  repoId: string,
  sha: string,
  comments: CsCommentLine[],
  credential?: GithubCredential,
): Promise<unknown> {
  return writeNote(repoId, {
    sha,
    note: `\n${comments.map((comment) => JSON.stringify(comment)).join("\n")}\n`,
    action: "append",
    ref: COMMENTS_REF,
    author: mergeAuthor(credential),
  });
}

/** Parse note text back into comment lines. Anyone with git:write can push
 *  arbitrary bytes onto the notes ref, so every field is validated — a line
 *  with a non-string createdAt/author (or any other malformed shape) must
 *  degrade, never crash the conversation render. */
function parseCommentLines(note: string): CsCommentLine[] {
  const out: CsCommentLine[] = [];
  for (const raw of note.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.body !== "string"
      )
        continue;
      out.push({
        id: typeof parsed.id === "string" ? parsed.id : "",
        author: typeof parsed.author === "string" ? parsed.author : "",
        body: parsed.body,
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
        ...(typeof parsed.branch === "string" && parsed.branch
          ? { branch: parsed.branch }
          : {}),
        ...(typeof parsed.path === "string" && parsed.path
          ? { path: parsed.path }
          : {}),
        ...(typeof parsed.line === "number" && Number.isFinite(parsed.line)
          ? { line: parsed.line }
          : {}),
      });
    } catch {}
  }
  return out;
}

/** Flatten a stored comment into the PrComment conversation shape. Inline
 *  comments keep their anchor as a `path:line` prefix (threads stay flat). */
function toStoredComment(comment: CsCommentLine): PrComment {
  const anchor = comment.path
    ? `\`${comment.path}${comment.line ? `:${comment.line}` : ""}\` — `
    : "";
  return {
    author: comment.author || "",
    body: anchor + comment.body,
    createdAt: comment.createdAt || undefined,
  };
}

/** Hard cap on annotated commits read per repo — a runaway ref stops costing
 *  requests here; older anchors past the cap drop out with a warning. */
const MAX_COMMENT_NOTES = 500;

/**
 * Every comment line in the repo's COMMENTS_REF, tagged with the commit each
 * note is anchored to. The notes ref's tip is itself a commit whose tree
 * names every annotated object (fanout dirs collapse to the sha), so listing
 * that tree finds comments even on commits a force-push orphaned or a merge
 * base left behind — commits-since-merge-base can't. Cached by the notes
 * ref's tip SHA: any note write moves it, so the cache self-invalidates.
 * Failures propagate (see existingNotesRefs) — never an empty answer.
 */
const commentLinesCache = new Map<
  string,
  { refSha: string; lines: (CsCommentLine & { sha: string })[] }
>();
async function allCommentLines(
  repoId: string,
  refSha: string,
): Promise<(CsCommentLine & { sha: string })[]> {
  const hit = commentLinesCache.get(repoId);
  if (hit && hit.refSha === refSha) return hit.lines;
  const entries = await listFiles(repoId, { ref: refSha, recursive: true });
  const shas = entries
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path.replace(/\//g, ""))
    .filter((sha) => /^[0-9a-f]{40,64}$/.test(sha));
  if (shas.length > MAX_COMMENT_NOTES)
    console.warn(
      `[cs-pr] ${repoId}: ${shas.length} commented commits in ${COMMENTS_REF}; reading newest ${MAX_COMMENT_NOTES}`,
    );
  const notes = await mapLimit(
    shas.slice(0, MAX_COMMENT_NOTES),
    4,
    async (sha) => ({
      sha,
      note: await getNote(repoId, sha, COMMENTS_REF),
    }),
  );
  const lines = notes.flatMap(({ sha, note }) =>
    note ? parseCommentLines(note.note).map((line) => ({ ...line, sha })) : [],
  );
  commentLinesCache.set(repoId, { refSha, lines });
  return lines;
}

/**
 * The branch's conversation, oldest first: lines that carry a `branch` tag
 * match by name (immune to history rewrites); legacy untagged lines match by
 * the reachable-commit set they were readable through before.
 */
async function commentsFor(
  repoId: string,
  branch: string,
  shas: string[],
): Promise<PrComment[]> {
  const refSha = (await existingNotesRefs(repoId)).get(COMMENTS_REF);
  if (!refSha) return [];
  const reachable = new Set(shas);
  const lines = (await allCommentLines(repoId, refSha)).filter((line) =>
    line.branch ? line.branch === branch : reachable.has(line.sha),
  );
  lines.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  return lines.map(toStoredComment);
}

/** Commit annotations for the commits tab: notes in the common namespaces,
 *  fetched per displayed commit (concurrency-capped, best-effort — failures
 *  read as no note, so the field just stays absent). */
async function commitNotesFor(
  repoId: string,
  shas: string[],
): Promise<Map<string, PrCommitNote[]>> {
  const out = new Map<string, PrCommitNote[]>();
  const existing = await existingNotesRefs(repoId);
  const refs = COMMIT_NOTE_REFS.filter((ref) => existing.has(ref));
  if (!shas.length || !refs.length) return out;
  const jobs = shas.flatMap((sha) => refs.map((ref) => ({ sha, ref })));
  const notes = await mapLimit(jobs, 6, async ({ sha, ref }) => ({
    sha,
    ref,
    note: await getNote(repoId, sha, ref).catch(() => null),
  }));
  for (const { sha, ref, note } of notes) {
    const text = note?.note.trim();
    if (!text) continue;
    const list = out.get(sha) ?? [];
    list.push({ ref, text });
    out.set(sha, list);
  }
  return out;
}

// ── The branch → PR-shape reads ──────────────────────────────────────────────

async function fetchDetails(
  branch: string,
  repoId: string,
): Promise<PrDetails | null> {
  const base = await defaultBranchOf(repoId);
  // The default branch is what everything merges INTO — it is never a PR.
  if (branch === base) return null;
  const head = await findBranch(repoId, branch);
  if (!head) return null;

  const diff = await getBranchDiff(repoId, base, branch);
  const commits = await branchCommits(repoId, branch, diff.merge_base_sha);
  const tip =
    commits[0] ??
    (head.head_sha
      ? await getCommit(repoId, head.head_sha).catch(() => null)
      : null);
  // A tip contained in the default branch = the change landed. The host keeps
  // no merged/closed distinction (a deleted branch is simply gone), so a
  // surviving fully-merged branch honestly reads MERGED, not OPEN.
  const merged = isMergedBranch(head.head_sha, diff);
  // Conflict probe — best-effort: an UNKNOWN answer just defers to the merge.
  let mergeable = "UNKNOWN";
  if (!merged)
    try {
      const preview = await previewMerge(repoId, branch, base);
      if (preview.status === "clean") mergeable = "MERGEABLE";
      else if (preview.status === "conflicted") mergeable = "CONFLICTING";
    } catch {}

  // Notes reads: the conversation aggregates the repo's comment notes by
  // branch tag (legacy untagged lines match through this reachable-commit
  // set — for a merged branch the posted-on tip is the merge base, outside
  // `commits`, hence the head_sha add), and the commits tab gets per-commit
  // annotations from the common namespaces.
  const noteShas = commits.map((commit) => commit.sha);
  if (head.head_sha && !noteShas.includes(head.head_sha))
    noteShas.push(head.head_sha);
  const [comments, commitNotes] = await Promise.all([
    commentsFor(repoId, branch, noteShas),
    commitNotesFor(
      repoId,
      commits.map((commit) => commit.sha),
    ),
  ]);

  const { headline, body } = splitMessage(tip?.message);
  const files = buildFiles(diff);
  return {
    number: csPrNumber(branch),
    title: headline || branch,
    url: csUrl(repoId),
    state: merged ? "MERGED" : "OPEN",
    isDraft: false,
    baseRefName: base,
    headRefName: branch,
    headRefOid: head.head_sha || tip?.sha,
    additions:
      diff.stats?.additions ?? files.reduce((n, f) => n + f.additions, 0),
    deletions:
      diff.stats?.deletions ?? files.reduce((n, f) => n + f.deletions, 0),
    changedFiles:
      (diff.stats?.files ?? diff.files.length) +
      (diff.filtered_files?.length || 0),
    reviewDecision: "",
    author: tip?.author_name || "",
    body,
    checks: [],
    comments,
    // Oldest first, like gh; notes attach only where a namespace has one.
    commits: [...commits].reverse().map((commit) => {
      const notes = commitNotes.get(commit.sha);
      return notes?.length
        ? { ...toPrCommit(commit), notes }
        : toPrCommit(commit);
    }),
    files,
    reviewers: [],
    mergeable,
    mergeStateStatus: "",
    staging: null,
  };
}

async function fetchDiff(
  branch: string,
  repoId: string,
  maxPatchBytes?: number,
): Promise<PrDiffData | null> {
  const base = await defaultBranchOf(repoId);
  if (branch === base) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const [head, baseHead] = await Promise.all([
      findBranch(repoId, branch, true),
      findBranch(repoId, base, true),
    ]);
    if (!head) return null;
    const diff = await getBranchDiff(repoId, base, branch);
    const [verifiedHead, verifiedBase] = await Promise.all([
      findBranch(repoId, branch, true),
      findBranch(repoId, base, true),
    ]);
    if (
      verifiedHead?.head_sha !== head.head_sha ||
      verifiedBase?.head_sha !== baseHead?.head_sha
    )
      continue;
    // Size-filtered files have no inline content and are absent from the patch.
    let patch = diff.files
      .map((f) => (f.raw.endsWith("\n") ? f.raw : `${f.raw}\n`))
      .join("");
    const omitted = diff.filtered_files || [];
    let boundedFiles = 0;
    if (maxPatchBytes && Buffer.byteLength(patch) > maxPatchBytes) {
      const prefix = Buffer.from(patch)
        .subarray(0, maxPatchBytes)
        .toString("utf8");
      const boundary = prefix.lastIndexOf("\ndiff --git ");
      patch = boundary > 0 ? prefix.slice(0, boundary + 1) : "";
      boundedFiles = 1;
    }
    const baseRefOid = diff.merge_base_sha || baseHead?.head_sha;
    const version = createHash("sha256")
      .update(baseRefOid ?? base)
      .update("\0")
      .update(head.head_sha || "");
    return {
      number: csPrNumber(branch),
      baseRefOid,
      headRefOid: head.head_sha || "",
      patch,
      diffVersion: version.digest("base64url"),
      ...(omitted.length + boundedFiles
        ? { skippedFiles: omitted.length + boundedFiles }
        : {}),
    };
  }
  throw new Error("Change request changed while loading its diff");
}

function cachedFetch<T>(
  cache: Map<string, { data: T; ts: number }>,
  inflight: Map<string, Promise<T>>,
  key: string,
  fresh: boolean,
  fetch: () => Promise<T>,
): Promise<T> {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.ts < TTL)
    return Promise.resolve(hit.data);
  let p = inflight.get(key);
  if (!p) {
    p = fetch()
      .then((data) => {
        cache.set(key, { data, ts: Date.now() });
        return data;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/**
 * Resolve a branch name or synthetic PR number to the link-a-PR row shape
 * (session-repos.ts linkPr — the code.storage counterpart of its `gh pr
 * view`). Numbers resolve by hashing every live branch; null = no such
 * branch-PR.
 */
export async function csPrView(
  repoId: string,
  selector: { number?: number; branch?: string },
): Promise<{
  branch: string;
  number: number;
  url: string;
  title: string;
} | null> {
  try {
    const base = await defaultBranchOf(repoId);
    const branches = (await branchesFor(repoId)).filter((b) => b.name !== base);
    const match = selector.branch
      ? branches.find((b) => b.name === selector.branch)
      : branches.find((b) => csPrNumber(b.name) === selector.number);
    if (!match) return null;
    const tip = match.head_sha
      ? await getCommit(repoId, match.head_sha).catch(() => null)
      : null;
    return {
      branch: match.name,
      number: csPrNumber(match.name),
      url: csUrl(repoId),
      title: splitMessage(tip?.message).headline,
    };
  } catch {
    return null;
  }
}

// ── The PrHost ───────────────────────────────────────────────────────────────

export const csPrHost: PrHost = {
  capabilities: CODESTORAGE_CAPABILITIES,

  getPrDetails: (branch, repo) =>
    cachedFetch(
      detailsCache,
      detailsInflight,
      cacheKey(repo, branch),
      false,
      () => fetchDetails(branch, repo),
    ),
  getPrDetailsFresh: (branch, repo) =>
    cachedFetch(
      detailsCache,
      detailsInflight,
      cacheKey(repo, branch),
      true,
      () => fetchDetails(branch, repo),
    ),
  getPrDiff: (branch, repo, maxPatchBytes) =>
    maxPatchBytes
      ? fetchDiff(branch, repo, maxPatchBytes)
      : cachedFetch(
          diffCache,
          diffInflight,
          cacheKey(repo, branch),
          false,
          () => fetchDiff(branch, repo),
        ),

  async prMetaForBranch(branch, repo): Promise<MutationPrMeta | null> {
    const base = await defaultBranchOf(repo);
    if (branch === base) return null;
    const head = await findBranch(repo, branch);
    if (!head) return null;
    return {
      number: csPrNumber(branch),
      headRefOid: head.head_sha || "",
      state: "OPEN",
      isDraft: false,
      url: csUrl(repo),
    };
  },

  // One comment = one JSON line appended to the note on the current branch
  // tip. Inline anchors (path/line) are carried in the line; the flat
  // conversation renders them as a prefix.
  async postPrComment(branch, input, repo, credential) {
    try {
      const tipSha = await branchTipSha(repo, branch);
      if (!tipSha) return { error: "No PR found for this branch" };
      await appendComments(
        repo,
        tipSha,
        [
          {
            id: crypto.randomUUID(),
            author: actingPrincipal(credential),
            body: input.body,
            createdAt: new Date().toISOString(),
            branch,
            ...(input.path ? { path: input.path } : {}),
            ...(input.line ? { line: input.line } : {}),
          },
        ],
        credential,
      );
      invalidate(repo, branch);
      return { ok: true, url: csUrl(repo) };
    } catch (e) {
      return { error: errorMessage(e).slice(0, 300) };
    }
  },

  // A review is stored the same way: the summary becomes a comment with a
  // verdict prefix (APPROVE/REQUEST_CHANGES), each inline comment its own
  // line. Nothing on the host tracks approval state — the verdict is purely
  // conversational. Audited like the GitHub review path.
  async submitPrReview(branch, input, repo, credential) {
    try {
      if (!input.comments.length && !input.body?.trim()) {
        return { error: "Nothing to submit" };
      }
      const tipSha = await branchTipSha(repo, branch);
      if (!tipSha) return { error: "No PR found for this branch" };
      const author = actingPrincipal(credential);
      const createdAt = new Date().toISOString();
      const lines: CsCommentLine[] = [];
      const summary = input.body?.trim() || "";
      const verdict = input.event === "COMMENT" ? "" : input.event;
      if (verdict || summary) {
        lines.push({
          id: crypto.randomUUID(),
          author,
          body: verdict
            ? summary
              ? `${verdict}: ${summary}`
              : verdict
            : summary,
          createdAt,
          branch,
        });
      }
      for (const comment of input.comments) {
        lines.push({
          id: crypto.randomUUID(),
          author,
          body: comment.body,
          createdAt,
          branch,
          path: comment.path,
          line: comment.line,
        });
      }
      return await audited(
        {
          context: "reviews",
          action: "pr_review",
          args: {
            host: "codestorage",
            branch,
            number: csPrNumber(branch),
            event: input.event,
            comments: input.comments.length,
            credential: credential?.principal,
          },
        },
        async () => {
          try {
            await appendComments(repo, tipSha, lines, credential);
          } catch (e) {
            return { error: errorMessage(e).slice(0, 300) } as const;
          }
          invalidate(repo, branch);
          return { ok: true, url: csUrl(repo) } as const;
        },
      );
    } catch (e) {
      return { error: errorMessage(e).slice(0, 300) };
    }
  },

  editPrReviewers: async () => unsupported("Requesting reviewers"),
  updatePrBody: async () => unsupported("Editing a PR description"),

  async mergePr(branch, opts, repo, credential) {
    try {
      const base = await defaultBranchOf(repo);
      if (branch === base)
        return { error: "That's the default branch — nothing to merge" };
      const head = await findBranch(repo, branch);
      if (!head) return { error: "No PR found for this branch" };
      if (opts.method === "rebase")
        return {
          error:
            "Rebase merges aren't supported on code.storage — use squash or merge",
        };
      const method = opts.method || "squash";
      return await audited(
        {
          context: "reviews",
          action: "pr_merge",
          args: {
            host: "codestorage",
            branch,
            number: csPrNumber(branch),
            method,
            // Host semantics (see below): the source branch is always deleted
            // after a merge, whatever deleteBranch flag the route passed.
            deleteBranch: true,
            credential: credential?.principal,
          },
        },
        async () => {
          try {
            await mergeBranch(repo, {
              sourceBranch: branch,
              targetBranch: base,
              strategy: "merge",
              ...(method === "squash" ? { squash: true } : {}),
              author: mergeAuthor(credential),
            });
          } catch (e) {
            return { error: errorMessage(e).slice(0, 300) } as const;
          }
          // Host semantics: on code.storage the branch IS the change request,
          // so a merged change whose branch survives would re-list as an open
          // PR (listOpenPrs is authoritative for the live set). Delete the
          // source branch regardless of the route's deleteBranch flag — the
          // flag keeps its GitHub meaning unchanged, where a merged PR stays
          // merged either way. Best-effort: listOpenPrs also skips
          // fully-merged branches, so a failed delete can't reopen the row.
          await deleteBranch(repo, branch).catch(() => {});
          invalidate(repo, branch);
          return { ok: true, url: csUrl(repo) } as const;
        },
      );
    } catch (e) {
      return { error: errorMessage(e).slice(0, 300) };
    }
  },

  // "Close without merging" — the branch IS the PR, so closing deletes it
  // (nothing else on the host marks a branch as not-under-review).
  async closePr(branch, repo, credential) {
    try {
      const base = await defaultBranchOf(repo);
      if (branch === base)
        return { error: "That's the default branch — it can't be closed" };
      const head = await findBranch(repo, branch);
      if (!head) return { error: "No PR found for this branch" };
      const number = csPrNumber(branch);
      return await audited(
        {
          context: "reviews",
          action: "pr_close",
          args: {
            host: "codestorage",
            branch,
            number,
            credential: credential?.principal,
          },
        },
        async () => {
          try {
            await deleteBranch(repo, branch);
          } catch (e) {
            return { error: errorMessage(e).slice(0, 300) } as const;
          }
          invalidate(repo, branch);
          return { ok: true, url: csUrl(repo), number } as const;
        },
      );
    } catch (e) {
      return { error: errorMessage(e).slice(0, 300) };
    }
  },

  invalidatePrInfo: (repo, branch) => invalidate(repo, branch),

  // Every non-default branch with reviewable changes, shaped as an open PR.
  // Per-branch failures skip just that branch (one slow/huge diff must not
  // null the whole list), but when EVERY branch fails — the API being down —
  // the answer is null so the sweep keeps its stale rows.
  async listOpenPrs(repo, opts) {
    try {
      const base = await defaultBranchOf(repo);
      const branches = (await branchesFor(repo))
        .filter((b) => b.name !== base)
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
        .slice(0, opts.limit);
      let failed = 0;
      const rows = await mapLimit(
        branches,
        4,
        async (b): Promise<BulkPr | null> => {
          try {
            const [diff, tip] = await Promise.all([
              getBranchDiff(repo, base, b.name),
              b.head_sha ? getCommit(repo, b.head_sha) : Promise.resolve(null),
            ]);
            // Fully-merged branches (tip is the merge base — zero commits
            // ahead) and empty-diff branches (e.g. squash-merged, or freshly
            // cut) are not open changes: without this filter a merge whose
            // branch deletion failed, or an externally merged branch, would
            // re-list as an open PR forever.
            if (isMergedBranch(b.head_sha, diff)) return null;
            if (!diff.files.length && !(diff.filtered_files?.length || 0))
              return null;
            const { headline, body } = splitMessage(tip?.message);
            return {
              headRefName: b.name,
              headRefOid: b.head_sha,
              url: csUrl(repo),
              state: "OPEN",
              number: csPrNumber(b.name),
              title: headline || b.name,
              isDraft: false,
              additions: diff.stats?.additions ?? 0,
              deletions: diff.stats?.deletions ?? 0,
              changedFiles:
                (diff.stats?.files ?? diff.files.length) +
                (diff.filtered_files?.length || 0),
              reviewDecision: "",
              author: tip ? { name: tip.author_name } : undefined,
              updatedAt: tip?.date || b.created_at || "",
              createdAt: b.created_at || tip?.date || "",
              // The tip commit's body, so a session-attribution footer written
              // into the commit message still links the branch to its session.
              body,
            };
          } catch (e) {
            failed++;
            console.warn(
              `[cs-pr] listOpenPrs ${repo}: branch ${b.name} skipped: ${errorMessage(e).slice(0, 200)}`,
            );
            return null;
          }
        },
      );
      if (branches.length && failed === branches.length) return null;
      return rows.filter((row): row is BulkPr => row !== null);
    } catch (e) {
      console.warn(
        `[cs-pr] listOpenPrs ${repo} failed: ${errorMessage(e).slice(0, 200)}`,
      );
      return null;
    }
  },

  // Deleted branches leave no history to list — merged/closed rows survive
  // only via the sweep's carry-forward of mutation write-throughs. An empty
  // (successful) answer keeps that carry-forward running.
  listRecentPrs: async () => [],

  // The (branch, tip) set is the change cursor: any push, new branch, or
  // deletion changes its fingerprint. Failures read as changed so a real
  // refresh still runs.
  async changedSince(repo, cursor) {
    try {
      const branches = await branchesFor(repo, 0);
      const sig = branches
        .map((b) => `${b.name}@${b.head_sha || ""}`)
        .sort()
        .join("\n");
      const fresh = `${fnv1a(sig).toString(16)}:${sig.length.toString(16)}`;
      return { changed: fresh !== cursor, cursor: fresh };
    } catch {
      return { changed: true, cursor };
    }
  },
};
