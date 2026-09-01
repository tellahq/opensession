/**
 * The commit a sha names, read from the checkout.
 *
 * Agents write shas constantly ("this reverts `4ed1ef09`"), and until now they
 * were dead text: to see what one was you left for GitHub and searched. The web
 * transcript turns them into references you can hover (lib/markdown.ts renders
 * the chip, components/ChipHoverCard.tsx raises the card), and this is what
 * answers them.
 *
 * Read from git, not the GitHub API, for the same reasons recent-commits.ts is:
 * it costs no quota, it works for a repo with no `ghRepo`, and it can see work
 * that has not been pushed. That last one matters most here. Worktrees share
 * their repo's object store, so a commit made minutes ago on some other
 * session's branch resolves out of the main checkout, which is exactly the
 * commit a transcript is most likely to be talking about.
 *
 * A sha is only ever read as an object name (`<sha>^{commit}`, hex-validated
 * before it reaches git), never as a revision expression: `HEAD~3`, `main` and
 * `..` are not lookups this answers.
 */
import { $ } from "bun";
import { configuredRepos } from "./config";
import { personKeyForGitAuthor } from "./shared/user-mappings";

export interface CommitLookup {
  /** Repo id, as in `configuredRepos()`. The repo it was FOUND in, which is
   *  not always the one the caller guessed. */
  repo: string;
  /** Full 40-char sha, so a caller can link or compare without re-resolving. */
  sha: string;
  /** What git itself abbreviates to in this repo. */
  shortSha: string;
  title: string;
  /** Message body, clamped: commit bodies carry pasted logs. */
  body?: string;
  author: string;
  /** Web user-picker key ("kent"), or null when the author isn't a teammate. */
  person: string | null;
  committedAt: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  /** GitHub commit page; absent for a repo with no `ghRepo`. */
  url?: string;
  /** Whether it is on the repo's default branch, i.e. whether it shipped. */
  onDefaultBranch: boolean;
  /** That branch's name, so a reader is told "on main" rather than "on the
   *  default branch". */
  defaultBranch: string;
}

/** What may be looked up at all. Git's own floor is 4 characters, but a
 *  reference that short is ambiguous in any real repo and is far more likely to
 *  be a word than a commit. */
const SHA = /^[0-9a-f]{7,40}$/i;

export function isCommitSha(value: string): boolean {
  return SHA.test(value);
}

const FIELD = "\x1f";
const RECORD = "\x1e";
// The body is last and may contain anything, so a record separator closes it
// and the shortstat line follows after.
const FORMAT = `%H${FIELD}%h${FIELD}%an${FIELD}%ae${FIELD}%cI${FIELD}%s${FIELD}%b${RECORD}`;
const BODY_MAX = 400;

/**
 * Parse one `git log -1 --shortstat --format=FORMAT` record. Exported for the
 * test; every call site goes through `lookupCommit`.
 */
export function parseCommitRecord(
  stdout: string,
  repo: { id: string; ghRepo?: string },
): Omit<CommitLookup, "onDefaultBranch" | "defaultBranch"> | null {
  const [head = "", stat = ""] = stdout.split(RECORD);
  const [sha, shortSha, author, email, date, title, ...bodyParts] =
    head.split(FIELD);
  if (!sha || !date) return null;
  // A merge shows no diff, so its stat line is absent and the counts read 0.
  const body = bodyParts.join(FIELD).trim();
  return {
    repo: repo.id,
    sha,
    shortSha: shortSha || sha.slice(0, 8),
    title: (title || "").trim() || sha.slice(0, 8),
    ...(body
      ? { body: body.length > BODY_MAX ? `${body.slice(0, BODY_MAX)}…` : body }
      : {}),
    author: author || "",
    person: personKeyForGitAuthor(author, email),
    committedAt: date,
    filesChanged: Number(stat.match(/(\d+) files? changed/)?.[1] || 0),
    additions: Number(stat.match(/(\d+) insertions?\(\+\)/)?.[1] || 0),
    deletions: Number(stat.match(/(\d+) deletions?\(-\)/)?.[1] || 0),
    ...(repo.ghRepo
      ? { url: `https://github.com/${repo.ghRepo}/commit/${sha}` }
      : {}),
  };
}

// Hovering is the trigger, so lookups arrive in bursts as a pointer crosses a
// paragraph and each one that misses would otherwise walk every checkout. Two
// bounds keep that proportional: one slot pool over all git spawns, and a
// cache in front of them.
const MAX_CONCURRENT_GIT = 4;
let running = 0;
const waiting: Array<() => void> = [];

async function withGitSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_GIT)
    await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** One checkout's answer for one sha. Exported for the test, which drives it
 *  against a real repo rather than a fixture: the format string and the
 *  shortstat line are what this module is, and both are git's to define. */
export async function readCommitAt(
  repo: { id: string; repo: string; ghRepo?: string },
  sha: string,
): Promise<Omit<CommitLookup, "onDefaultBranch" | "defaultBranch"> | null> {
  // `^{commit}` is the type check: a blob or tree sha (agents paste those too)
  // fails here rather than rendering a card full of nothing. An ambiguous
  // abbreviation fails the same way, which is the right answer as well.
  const out = await withGitSlot(() =>
    $`git -C ${repo.repo} log -1 --shortstat --format=${FORMAT} --end-of-options ${`${sha}^{commit}`} --`
      .quiet()
      .nothrow(),
  );
  if (out.exitCode !== 0) return null;
  return parseCommitRecord(out.stdout.toString(), repo);
}

/** Whether the commit is on the branch the repo ships from. The remote's copy
 *  is the truth; a checkout that has never fetched falls back to its own. */
async function onDefaultBranch(
  dir: string,
  defaultBranch: string,
  sha: string,
): Promise<boolean> {
  for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
    const out = await withGitSlot(() =>
      $`git -C ${dir} merge-base --is-ancestor ${sha} ${ref}`.quiet().nothrow(),
    );
    if (out.exitCode === 0) return true;
    // 1 is a real "no"; anything else means the ref isn't there to compare to.
    if (out.exitCode === 1) return false;
  }
  return false;
}

type Entry = { commit: CommitLookup; branchCheckedAt: number };

const CACHE_MAX = 500;
const MISS_TTL_MS = 60_000;
// A commit that has landed stays landed, so only a "not yet" answer expires.
const BRANCH_TTL_MS = 60_000;

const hits = new Map<string, Entry>();
const misses = new Map<string, number>();
const inFlight = new Map<string, Promise<CommitLookup | null>>();

function cacheKey(sha: string, repoHint?: string): string {
  return `${repoHint ?? ""}\u0000${sha.toLowerCase()}`;
}

function remember(key: string, entry: Entry): void {
  hits.set(key, entry);
  if (hits.size > CACHE_MAX) {
    const oldest = hits.keys().next().value;
    if (oldest !== undefined) hits.delete(oldest);
  }
}

/**
 * The commit a sha names, or null when no checkout has it.
 *
 * `repoHint` is where the sha was written (the session's repo in a transcript)
 * and is searched first, but it is only a hint: prose crosses repos, and the
 * answer says which repo actually held the commit so the caller can correct
 * the link it guessed.
 */
export async function lookupCommit(
  sha: string,
  repoHint?: string,
): Promise<CommitLookup | null> {
  if (!isCommitSha(sha)) return null;
  const key = cacheKey(sha, repoHint);

  const cached = hits.get(key);
  if (cached) {
    if (
      cached.commit.onDefaultBranch ||
      Date.now() - cached.branchCheckedAt < BRANCH_TTL_MS
    )
      return cached.commit;
  } else {
    const missedAt = misses.get(key);
    // A sha unknown a minute ago can arrive with the next fetch, so a miss
    // expires. A hit never has to: the object is immutable.
    if (missedAt !== undefined && Date.now() - missedAt < MISS_TTL_MS)
      return null;
    misses.delete(key);
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = resolve(sha, repoHint, cached?.commit)
    .then((commit) => {
      if (commit) remember(key, { commit, branchCheckedAt: Date.now() });
      else misses.set(key, Date.now());
      return commit;
    })
    .catch(() => null)
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

async function resolve(
  sha: string,
  repoHint: string | undefined,
  known: CommitLookup | undefined,
): Promise<CommitLookup | null> {
  const repos = Object.values(configuredRepos()).filter((repo) => repo.repo);
  // Only the branch answer went stale: the commit itself cannot change, so
  // re-reading it would be a spawn spent on a known answer.
  if (known) {
    const repo = repos.find((r) => r.id === known.repo);
    if (!repo) return known;
    return {
      ...known,
      onDefaultBranch: await onDefaultBranch(
        repo.repo,
        known.defaultBranch,
        known.sha,
      ),
    };
  }
  const ordered = [
    ...repos.filter((repo) => repo.id === repoHint),
    ...repos.filter((repo) => repo.id !== repoHint),
  ];
  for (const repo of ordered) {
    const found = await readCommitAt(repo, sha).catch(() => null);
    if (!found) continue;
    const defaultBranch = repo.defaultBranch || "main";
    return {
      ...found,
      defaultBranch,
      onDefaultBranch: await onDefaultBranch(
        repo.repo,
        defaultBranch,
        found.sha,
      ).catch(() => false),
    };
  }
  return null;
}
