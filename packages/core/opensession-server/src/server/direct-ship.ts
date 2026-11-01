/**
 * Track a change shipped straight to the default branch (direct ship mode).
 *
 * A PR announces itself: GitHub says when it merged. A direct push does not,
 * so after each clean turn of a direct-mode session we read the evidence git
 * already keeps. `git push origin HEAD:refs/heads/<default>` updates the
 * remote-tracking ref and writes an "update by push" reflog entry; when that
 * entry's commit is this worktree's HEAD, this workspace shipped it. The
 * entry before it is where the default branch stood, so the commits between
 * the two are the ones the push added.
 *
 * A recorded push is then confirmed against the remote (`ls-remote`), so a
 * push that was later rewritten away is never shown as shipped. Once
 * confirmed, the workspace reads as shipped, its sessions can be archived the
 * way merged-PR sessions are (repo `archiveShipped`), and the open session
 * offers the shipped-change Slack composer.
 *
 * Detection, commit selection and the archive decision are pure; the git
 * calls go through `ShipGitDeps` so tests can drive them without a remote.
 */

import { existsSync } from "fs";
import type { DirectShip, UnifiedSession } from "./types";

/** Newest first, as `git reflog` prints it. */
export interface ReflogEntry {
  sha: string;
  subject: string;
}

/** Commits recorded per ship; a longer push keeps its oldest. */
export const MAX_SHIP_COMMITS = 50;
/** Ships kept per session; older ones fall off. */
export const MAX_DIRECT_SHIPS = 20;
/** How far back the reflog is read. A turn rarely pushes more than once. */
export const REFLOG_DEPTH = 30;

/** `git reflog --format=%H%x09%gs` → entries, newest first. */
export function parseReflog(output: string): ReflogEntry[] {
  const entries: ReflogEntry[] = [];
  for (const line of output.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const sha = line.slice(0, tab).trim();
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) continue;
    entries.push({ sha, subject: line.slice(tab + 1).trim() });
  }
  return entries;
}

const isPushEntry = (entry: ReflogEntry) =>
  entry.subject === "update by push" ||
  entry.subject.startsWith("update by push");

/**
 * The push of `head` to the default branch, when the reflog shows one and it
 * has not been recorded yet. Only an entry whose commit IS this worktree's
 * HEAD counts: sibling worktrees of the same repository share the
 * remote-tracking ref, and their pushes must not be attributed here.
 */
export function detectDirectPush(input: {
  head: string;
  reflog: readonly ReflogEntry[];
  recorded: readonly Pick<DirectShip, "sha">[];
}): { sha: string; previousSha?: string } | null {
  if (!input.head) return null;
  if (input.recorded.some((ship) => ship.sha === input.head)) return null;
  const index = input.reflog.findIndex(
    (entry) => entry.sha === input.head && isPushEntry(entry),
  );
  if (index < 0) return null;
  const previous = input.reflog[index + 1];
  return {
    sha: input.head,
    ...(previous && previous.sha !== input.head
      ? { previousSha: previous.sha }
      : {}),
  };
}

/** Keep at most MAX_SHIP_COMMITS, oldest first, from `rev-list --reverse`. */
export function shipCommits(revList: string): string[] {
  return revList
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{40,64}$/i.test(line))
    .slice(0, MAX_SHIP_COMMITS);
}

/** Append (or replace by sha) and keep the newest MAX_DIRECT_SHIPS. */
export function mergeDirectShips(
  current: readonly DirectShip[] | undefined,
  next: DirectShip,
): DirectShip[] {
  const rest = (current || []).filter((ship) => ship.sha !== next.sha);
  return [...rest, next].slice(-MAX_DIRECT_SHIPS);
}

/** The latest ship that is confirmed on the remote's default branch. */
export function latestShipped(
  ships: readonly DirectShip[] | undefined,
): DirectShip | undefined {
  return [...(ships || [])].reverse().find((ship) => !!ship.shippedAt);
}

/**
 * Archive the workspace once it has nothing left to ship: the confirmed push
 * is the worktree's HEAD, nothing is uncommitted, and the repository opted in.
 * A later commit, or any uncommitted work, means the workspace is still busy.
 */
export function shouldArchiveShipped(input: {
  optedIn: boolean;
  ship: Pick<DirectShip, "sha" | "shippedAt">;
  head: string;
  clean: boolean;
}): boolean {
  return (
    input.optedIn &&
    !!input.ship.shippedAt &&
    input.ship.sha === input.head &&
    input.clean
  );
}

// ── Git side ─────────────────────────────────────────────────────────────

export interface GitResult {
  code: number;
  stdout: string;
}

export interface ShipGitDeps {
  git(
    dir: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<GitResult>;
  now(): string;
}

async function spawnGit(
  dir: string,
  args: string[],
  env?: Record<string, string>,
): Promise<GitResult> {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), 30_000);
  try {
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return { code, stdout };
  } finally {
    clearTimeout(timer);
  }
}

export const defaultShipGitDeps: ShipGitDeps = {
  git: spawnGit,
  now: () => new Date().toISOString(),
};

async function gitOut(
  deps: ShipGitDeps,
  dir: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string | null> {
  const result = await deps.git(dir, args, env);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Look for a new push of HEAD to `target` and describe it. */
export async function findNewDirectShip(
  input: {
    dir: string;
    repo: string;
    branch: string;
    target: string;
    recorded: readonly DirectShip[];
  },
  deps: ShipGitDeps = defaultShipGitDeps,
): Promise<DirectShip | null> {
  const head = await gitOut(deps, input.dir, ["rev-parse", "HEAD"]);
  if (!head) return null;
  const reflog = await gitOut(deps, input.dir, [
    "reflog",
    "show",
    "--format=%H%x09%gs",
    "-n",
    String(REFLOG_DEPTH),
    `refs/remotes/origin/${input.target}`,
    "--",
  ]);
  if (!reflog) return null;
  const push = detectDirectPush({
    head,
    reflog: parseReflog(reflog),
    recorded: input.recorded,
  });
  if (!push) return null;
  const revList = await gitOut(deps, input.dir, [
    "rev-list",
    "--reverse",
    `--max-count=${MAX_SHIP_COMMITS}`,
    push.sha,
    ...(push.previousSha ? [`^${push.previousSha}`] : []),
    "--",
  ]);
  return {
    repo: input.repo,
    branch: input.branch,
    target: input.target,
    sha: push.sha,
    ...(push.previousSha ? { previousSha: push.previousSha } : {}),
    commits: revList ? shipCommits(revList) : [push.sha],
    pushedAt: deps.now(),
  };
}

/**
 * Whether the remote's default branch contains `sha` now. Null when the
 * remote could not be asked (offline, no credential): try again later.
 */
export async function remoteContains(
  input: { dir: string; target: string; sha: string },
  env: Record<string, string> | undefined,
  deps: ShipGitDeps = defaultShipGitDeps,
): Promise<boolean | null> {
  const ref = `refs/heads/${input.target}`;
  const listed = await gitOut(
    deps,
    input.dir,
    ["ls-remote", "origin", ref],
    env,
  );
  if (listed === null) return null;
  const remoteSha = listed.split(/\s+/)[0] || "";
  if (!/^[0-9a-f]{40,64}$/i.test(remoteSha)) return false;
  if (remoteSha === input.sha) return true;
  // The remote moved on. It still contains the push when the push is an
  // ancestor of its tip; fetch the tip first if this clone has not seen it.
  const known = await deps.git(input.dir, [
    "cat-file",
    "-e",
    `${remoteSha}^{commit}`,
  ]);
  if (known.code !== 0) {
    const fetched = await deps.git(
      input.dir,
      ["fetch", "--quiet", "origin", input.target],
      env,
    );
    if (fetched.code !== 0) return null;
  }
  const ancestor = await deps.git(input.dir, [
    "merge-base",
    "--is-ancestor",
    input.sha,
    remoteSha,
  ]);
  return ancestor.code === 0;
}

/** Whether the worktree has uncommitted or untracked work. */
async function worktreeClean(deps: ShipGitDeps, dir: string): Promise<boolean> {
  const status = await gitOut(deps, dir, ["status", "--porcelain"]);
  return status === "";
}

export interface DirectShipContext {
  session: Pick<
    UnifiedSession,
    "id" | "branch" | "worktreeDir" | "directShips"
  >;
  repo: { id: string; defaultBranch: string; archiveShipped?: boolean };
  env?: Record<string, string>;
}

export interface DirectShipOutcome {
  ships: DirectShip[];
  /** Something was recorded or confirmed this pass. */
  changed: boolean;
  /** The workspace is done and the repository wants it archived. */
  archive: boolean;
}

/**
 * One pass for a direct-mode session: record a new push of HEAD, confirm any
 * unconfirmed ship against the remote, and say whether to archive.
 */
export async function reconcileDirectShips(
  ctx: DirectShipContext,
  deps: ShipGitDeps = defaultShipGitDeps,
): Promise<DirectShipOutcome> {
  const { session, repo } = ctx;
  let ships = [...(session.directShips || [])];
  const dir = session.worktreeDir;
  if (!dir || !session.branch || !existsSync(dir))
    return { ships, changed: false, archive: false };
  let changed = false;
  const fresh = await findNewDirectShip(
    {
      dir,
      repo: repo.id,
      branch: session.branch,
      target: repo.defaultBranch,
      recorded: ships,
    },
    deps,
  );
  if (fresh) {
    ships = mergeDirectShips(ships, fresh);
    changed = true;
  }
  // Confirm the newest few pending ships; older pending ones were rewritten
  // away or are long settled, and asking about them costs a round trip each.
  const pending = ships.filter((ship) => !ship.shippedAt).slice(-3);
  let newlyShipped: DirectShip | undefined;
  for (const ship of pending) {
    const contained = await remoteContains(
      { dir, target: ship.target, sha: ship.sha },
      ctx.env,
      deps,
    );
    if (!contained) continue;
    const confirmed = { ...ship, shippedAt: deps.now() };
    ships = ships.map((candidate) =>
      candidate.sha === ship.sha ? confirmed : candidate,
    );
    newlyShipped = confirmed;
    changed = true;
  }
  if (!newlyShipped || !repo.archiveShipped)
    return { ships, changed, archive: false };
  const head = (await gitOut(deps, dir, ["rev-parse", "HEAD"])) || "";
  const archive = shouldArchiveShipped({
    optedIn: true,
    ship: newlyShipped,
    head,
    clean: await worktreeClean(deps, dir),
  });
  return { ships, changed, archive };
}
