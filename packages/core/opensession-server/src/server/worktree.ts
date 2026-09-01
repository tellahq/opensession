import { $ } from "bun";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "fs";
import { resolve as resolvePath } from "path";
import type { UnifiedSession } from "./types";
import { stopPreview } from "./preview";
import {
  canonicalRepoId,
  configuredPaths,
  configuredRepos,
  configuredSelfDev,
  defaultRepo,
  type Repo,
} from "./config";
import { stateDir } from "./paths";

// The Repo type + registry defaults live in config.ts now. Re-exported so existing
// `import { type Repo } from "./worktree"` call sites keep working.
export type { Repo } from "./config";

// Root all per-branch worktrees live under. Env-overridable
// (OPENSESSION_WORKTREES_DIR) → config `paths.worktreesDir` → this VPS's path.
const worktreesDir = () => configuredPaths().worktreesDir;

/**
 * Repos a session can run against — the merged registry, read fresh from config
 * per access. Kept as a `Record`-shaped Proxy (not a plain snapshot) so the
 * many existing `REPOS[id]` / `Object.values(REPOS)` call sites — including
 * ones this module can't touch — stay correct when config adds or overrides
 * a repo without a restart. New code should prefer `configuredRepos()`.
 */
export const REPOS: Record<string, Repo> = new Proxy(
  {} as Record<string, Repo>,
  {
    get: (_t, prop) =>
      typeof prop === "string" ? configuredRepos()[prop] : undefined,
    has: (_t, prop) => typeof prop === "string" && prop in configuredRepos(),
    ownKeys: () => Object.keys(configuredRepos()),
    getOwnPropertyDescriptor: (_t, prop) => {
      if (typeof prop !== "string") return undefined;
      const repo = configuredRepos()[prop];
      return repo
        ? { value: repo, enumerable: true, configurable: true, writable: true }
        : undefined;
    },
  },
);

export function getRepo(id?: string): Repo {
  if (!id) return defaultRepo();
  // A record written before a repo was renamed still names the old id, and it
  // means the same checkout it always did, so resolve through the rename
  // rather than failing on it (canonicalRepoId).
  const repo = configuredRepos()[id] || configuredRepos()[canonicalRepoId(id)];
  if (repo) return repo;
  throw new Error(`Unknown repo "${id}"`);
}

/** Canonicalize a checkout path for identity COMPARISONS only: resolves
 *  symlinks so session files persisted before a checkout rename (old path
 *  kept behind as a symlink) still match the registered repo. Never rewrite a stored worktreeDir with
 *  this — transcript locations hash the recorded string, so canonicalizing
 *  persisted data would orphan old transcripts. */
export function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Infer the repo that owns a checkout/worktree path. */
export function repoForPath(p: string): Repo {
  const repo = repoForPathOrNull(p);
  if (!repo) throw new Error(`No registered repo owns path "${p}"`);
  return repo;
}

/** The repo owning a worktree, read from its `.git` pointer file — git's own
 *  record of the checkout the worktree was cut from, so it is authoritative
 *  where the path convention only guesses. Null when `dir` has no `.git` FILE
 *  (a main checkout's `.git` is a directory, and a reaped worktree has
 *  nothing at all) or when the pointer names an unregistered repo.
 *
 *  `gitdir` is the raw pointer target; worktree-reaper needs it to run
 *  `git worktree remove` through the owning checkout. */
export function repoFromGitPointer(
  dir: string,
): { repo: Repo; gitdir: string } | null {
  let pointer: string;
  try {
    pointer = readFileSync(`${dir}/.git`, "utf8");
  } catch {
    return null;
  }
  const gitdir = pointer.replace(/^gitdir:\s*/, "").trim();
  const ownerPath = canonicalPath(gitdir.split("/.git/worktrees/")[0] ?? "");
  for (const repo of Object.values(configuredRepos())) {
    if (canonicalPath(repo.repo) === ownerPath) return { repo, gitdir };
  }
  return null;
}

/** Like `repoForPath`, but undefined instead of throwing when no registered
 *  repo owns the path — a scratch dir, a sandbox volume, a stale path from a
 *  repo that has since been unregistered. */
export function repoForPathOrNull(p: string): Repo | undefined {
  const cp = canonicalPath(p);
  for (const r of Object.values(configuredRepos())) {
    if (cp === canonicalPath(r.repo)) return r;
  }
  // Ask git before reading the path. `wtPrefix` defaults to the repo id, so
  // two registered repos can have prefix-overlapping ids (`app`, `app-web`)
  // and `<wt>/app-web-<branch>` matches BOTH conventions; the .git pointer
  // does not guess.
  const owner = repoFromGitPointer(cp);
  if (owner) return owner.repo;
  // Fallback for dirs that are no longer on disk — reaped worktrees whose
  // path a session file still records. Longest prefix wins so the answer is
  // the most specific convention that matches, not whichever repo config
  // happened to list first.
  const wtRoot = canonicalPath(worktreesDir());
  let best: Repo | undefined;
  for (const r of Object.values(configuredRepos())) {
    if (!cp.startsWith(`${wtRoot}/${r.wtPrefix}-`)) continue;
    if (!best || r.wtPrefix.length > best.wtPrefix.length) best = r;
  }
  return best;
}

/**
 * Reserved repo id a CREATE passes to mean "this session has no repo".
 *
 * Distinct from omitting the repo, which still means "inherit, else the
 * default" — that is what every agent-created subagent relies on, so silence
 * must never start meaning repo-less. `getRepo("none")` throws, so a sentinel
 * that leaks past a create fails loudly instead of resolving to a checkout.
 */
export const NO_REPO = "none";

/**
 * The repo a session's own work lives in, or undefined when it has none.
 *
 * Repo-less-ness is a property of the session, not of its mode: `scratch`
 * sessions (feed-item workspaces) and repo-less `ask` sessions both have no
 * repo, and a future kind may too. So this asks the path rather than the
 * mode — call sites used to spell the test `mode !== "scratch"`, which
 * resolved every OTHER repo-less session to the default repo and quietly
 * pointed it at a checkout it had nothing to do with.
 *
 * Sessions whose stored `repo` predates that field are still derived from
 * `worktreeDir`. Callers that need a repo no matter what append
 * `?? defaultRepo().id`; callers that can say "no repo" should.
 */
export function sessionRepoId(session: {
  repo?: string;
  worktreeDir?: string | null;
}): string | undefined {
  if (session.repo) return session.repo;
  if (!session.worktreeDir) return undefined;
  return repoForPathOrNull(session.worktreeDir)?.id;
}

/** Is this dir a shared checkout no single session owns — a repo's live main
 *  checkout or its pinned ask checkout? Worktree "ownership" is meaningless
 *  there: the tree is shared by every ask/legacy session, and its parked branch
 *  says nothing about the sessions running in it. */
export function isSharedCheckoutDir(dir: string | null | undefined): boolean {
  if (!dir) return false;
  const cd = canonicalPath(dir);
  for (const r of Object.values(configuredRepos())) {
    if (
      cd === canonicalPath(r.repo) ||
      cd === canonicalPath(`${worktreesDir()}/${r.wtPrefix}-ask-checkout`)
    )
      return true;
  }
  return false;
}

/** Does `repo.sharedCheckout` apply when choosing a NEW session's working
 *  dir? Instance config `selfDev: "worktree"` opts out of the shared-checkout
 *  special case at session-creation time: self-repo sessions then get
 *  isolated per-branch worktrees exactly like every other repo. ONLY the dir
 *  choice for new sessions flips — existing sessions keep whatever dir their
 *  session file records, and `isSharedCheckoutDir` above stays keyed on the
 *  repo property so shared-mode sessions' dirs (and the live checkout's git
 *  guards: commit scoping, no-reset rules, workspace ownership) are still
 *  recognized in either mode. */
export function sharedCheckoutForNewSessions(repo: Repo): boolean {
  return !!repo.sharedCheckout && configuredSelfDev() !== "worktree";
}

/** Apply a person's explicit new-session choice on top of the repository's
 * workspace-wide default. Unknown values are deliberately treated as default
 * so older and non-web clients keep the configured behavior. */
export function sharedCheckoutForSessionCreate(
  repo: Repo,
  checkoutMode: unknown,
): boolean {
  if (checkoutMode === "checkout") return true;
  if (checkoutMode === "worktree") return false;
  return sharedCheckoutForNewSessions(repo);
}

/** Actual HEAD branch of a checkout/worktree, or null (detached/missing). Sync
 *  + cheap (two tiny file reads, no git subprocess): follows the `.git`
 *  file/dir to its HEAD ref. An agent can switch branches inside its worktree
 *  mid-run, so the session record's `branch` is a claim, not a fact — use this
 *  when the actual branch matters (PR lookups, review handoff, merge notify). */
export function worktreeHeadBranch(
  dir: string | null | undefined,
): string | null {
  if (!dir) return null;
  try {
    let gitDir = `${dir}/.git`;
    if (statSync(gitDir).isFile()) {
      const m = readFileSync(gitDir, "utf-8").match(/^gitdir: (.+)$/m);
      if (!m) return null;
      gitDir = resolvePath(dir, m[1].trim());
    }
    const ref = readFileSync(`${gitDir}/HEAD`, "utf-8").match(
      /^ref: refs\/heads\/(.+)$/m,
    );
    return ref ? ref[1].trim() : null;
  } catch {
    return null;
  }
}

// Serialize git operations that mutate the shared repo's worktrees. Concurrent
// `git worktree add` race on `.git/config` ("could not lock config file") when two
// runs create worktrees at once — e.g. two loops triggered together, or a loop plus
// a PR action. This in-process mutex runs them one at a time.
let gitOpChain: Promise<unknown> = Promise.resolve();
export function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = gitOpChain.then(fn, fn);
  gitOpChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

const STALE_REVIEW_INDEX_LOCK_MS = 5 * 60_000;

/**
 * A killed Git command can leave an index.lock in a review worktree forever.
 * Review worktrees are disposable and only OS owns them, but never remove a
 * recent lock or one lsof reports as still held: that would race a real Git
 * operation. If lsof itself cannot positively report an unheld lock, leave it
 * alone and let Git surface its normal error.
 */
async function clearStaleReviewIndexLock(wtPath: string): Promise<boolean> {
  let lockPath: string;
  try {
    const gitdir = readFileSync(`${wtPath}/.git`, "utf8")
      .match(/^gitdir:\s*(.+)$/m)?.[1]
      ?.trim();
    if (!gitdir) return false;
    lockPath = resolvePath(wtPath, gitdir, "index.lock");
  } catch {
    return false;
  }

  if (!existsSync(lockPath)) return true;

  let age: number;
  try {
    age = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return false;
  }
  if (age < STALE_REVIEW_INDEX_LOCK_MS) return false;

  const holders = await $`lsof -t -- ${lockPath}`.quiet().nothrow();
  // lsof exits 1 with no output when no process has the path open. Any other
  // result, including a missing/broken lsof, is deliberately fail-closed.
  if (holders.exitCode !== 1 || holders.stderr.toString().trim()) return false;

  try {
    unlinkSync(lockPath);
    console.warn(`[worktree] removed stale review index lock: ${lockPath}`);
    return true;
  } catch (error) {
    // Another process may have recreated the lock between lsof and unlink.
    // The following Git command remains the authority, so do not hide errors.
    console.warn(
      `[worktree] could not remove stale review index lock ${lockPath}:`,
      error,
    );
    return false;
  }
}

export interface WorktreeInfo {
  branch: string;
  path: string;
}

/**
 * Best-effort dependency install in a fresh worktree — sessions can always run
 * `bun install` themselves. A repo-owned `.agents/setup` hook is preferred;
 * `worktreeSetup` is the instance-level fallback. `depsInstall` then overrides the generic root package install.
 *
 * Interactive create paths fire this WITHOUT awaiting (a large webapp
 * `bun install` is ~20-25s — it was the bulk of the "Waiting for workspace"
 * spinner) so the opening turn starts as soon as the git worktree exists; the
 * agent-facing autofix/followup paths still await it because those runs build
 * immediately. All failure paths are caught + logged here, so a dropped
 * promise never surfaces as an unhandled rejection.
 */
/**
 * Fresh-worktree setup: seed node_modules from the repo's warm template when
 * one is enabled + ready (ideally by adopting a prebuilt spare via rename —
 * see warm-template.ts), then the normal dep install (a fast no-op over a
 * seeded tree). Both halves are best-effort; a cold install is always the
 * fallback.
 */
async function seedAndInstallWorktree(
  repo: Repo,
  wtPath: string,
  branchLabel: string,
): Promise<void> {
  try {
    const { seedWorktreeFromWarmTemplate } = await import("./warm-template");
    await seedWorktreeFromWarmTemplate(repo, wtPath);
  } catch (e) {
    console.warn(
      `[worktree] warm-template seeding failed for ${branchLabel} (continuing):`,
      e,
    );
  }
  await installWorktreeDeps(repo, wtPath, branchLabel);
}

export async function installWorktreeDeps(
  repo: Repo,
  wtPath: string,
  branchLabel: string,
): Promise<void> {
  try {
    // `.agents/setup` — the repo lifecycle provision hook (same dir preview.ts
    // resolves; docs/repo-lifecycle.md).
    const repoSetup = `${wtPath}/.agents/setup`;
    if (existsSync(repoSetup)) {
      await $`bash ${repoSetup}`.cwd(wtPath).quiet();
    } else if (repo.worktreeSetup) {
      await $`sh -c ${repo.worktreeSetup}`.cwd(wtPath).quiet();
    }
    if (repo.depsInstall) {
      await $`sh -c ${repo.depsInstall}`.cwd(wtPath).quiet();
    } else if (await Bun.file(`${wtPath}/package.json`).exists()) {
      await $`bun install`.cwd(wtPath).quiet();
    }
  } catch (e) {
    console.warn(`[worktree] setup failed for ${branchLabel} (continuing):`, e);
  }
}

export async function listWorktrees(repoId?: string): Promise<WorktreeInfo[]> {
  const repo = getRepo(repoId);
  const prefix = `${worktreesDir()}/${repo.wtPrefix}-`;
  try {
    const result =
      await $`git -C ${repo.repo} worktree list --porcelain`.text();
    const worktrees: WorktreeInfo[] = [];
    let currentPath = "";
    let currentBranch = "";

    for (const line of result.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        currentBranch = line.slice("branch refs/heads/".length);
      } else if (line === "") {
        if (currentPath && currentBranch && currentPath.startsWith(prefix)) {
          worktrees.push({ branch: currentBranch, path: currentPath });
        }
        currentPath = "";
        currentBranch = "";
      }
    }

    return worktrees;
  } catch (e) {
    console.error("Failed to list worktrees:", e);
    return [];
  }
}

/** True only when git registers this exact path for this repo and branch. */
export async function isRegisteredWorktree(
  path: string,
  repoId: string,
  branch: string,
): Promise<boolean> {
  const repo = getRepo(repoId);
  const registered = (await listWorktrees(repo.id)).find(
    (worktree) =>
      canonicalPath(worktree.path) === canonicalPath(path) &&
      worktree.branch === branch,
  );
  if (!registered) return false;
  return repoFromGitPointer(path)?.repo.id === repo.id;
}

/**
 * Repo-less scratch directory for "scratch" sessions (feed-item workspaces —
 * the feeds design): media/MCP work like downloading a linked video and
 * running ffmpeg, with full write access but no repo, branch, or PR flow.
 * Keyed by workspace id so a workspace's sibling sessions share downloads
 * (falls back to the session id for workspace-less creates). Never a git
 * repo — repo-derivation call sites must treat scratch sessions as repoless.
 */
export function ensureScratchDir(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "scratch";
  const dir = `${stateDir("scratch")}/${safe}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Stable, pinned checkout for ask-mode (read-only) sessions.
 *
 * Ask sessions used to run in the repo's live main checkout, but that tree's
 * branch is whatever the last flow left checked out — a resumed ask session
 * that had lost its history found the checkout parked on a teammate's PR
 * branch and adopted that PR's review as its own task (2026-07-24). Every
 * non-shared-checkout repo instead gets one `<wtPrefix>-ask-checkout`
 * worktree, detached at origin/<defaultBranch>, that all its ask sessions
 * share (they carry no Write/Edit and a read-only bash allowlist, so
 * concurrent readers are safe). Shared-checkout repos (opensession) keep the
 * live main checkout — self-hosting sessions must read the running code —
 * unless config `selfDev: "worktree"` opts the instance out of self-hosting
 * semantics, in which case they get the pinned ask checkout like everyone else.
 *
 * The tree is re-pinned to origin/<defaultBranch> in the background at most
 * once per ASK_REFRESH_MS so it tracks the default branch instead of
 * drifting; only the first-ever create pays the worktree-add. Detached HEAD
 * means listWorktrees() (branch-keyed) never offers it to code sessions.
 * Falls back to the main checkout if the worktree can't be created, so a git
 * hiccup degrades to the old behavior instead of failing the session.
 */
const askCheckoutRefreshedAt = new Map<string, number>();
const askCheckoutInvalidationVersion = new Map<string, number>();
const askCheckoutAppliedVersion = new Map<string, number>();
const askCheckoutRefreshes = new Map<
  string,
  { version: number; promise: Promise<void> }
>();
const ASK_REFRESH_MS = 5 * 60_000;

/** Force the next Ask session to wait until this repo's read-only checkout is
 * pinned to the newly configured default branch. */
export function invalidateAskCheckoutRefresh(repoId: string): void {
  askCheckoutInvalidationVersion.set(
    repoId,
    (askCheckoutInvalidationVersion.get(repoId) || 0) + 1,
  );
  askCheckoutRefreshedAt.delete(repoId);
}

async function refreshAskCheckoutLocked(
  repo: Repo,
  dir: string,
): Promise<void> {
  const fetch =
    await $`git -C ${dir} fetch origin ${repo.defaultBranch} --quiet`
      .quiet()
      .nothrow();
  if (fetch.exitCode !== 0) {
    throw new Error(
      `Could not fetch ${repo.id}'s default branch ${repo.defaultBranch}: ${fetch.stderr.toString().trim()}`,
    );
  }
  const reset = await $`git -C ${dir} reset --hard origin/${repo.defaultBranch}`
    .quiet()
    .nothrow();
  if (reset.exitCode !== 0) {
    throw new Error(
      `Could not pin ${repo.id}'s Ask checkout to ${repo.defaultBranch}: ${reset.stderr.toString().trim()}`,
    );
  }
}

function refreshAskCheckout(
  repo: Repo,
  dir: string,
  version: number,
): Promise<void> {
  const existing = askCheckoutRefreshes.get(repo.id);
  if (existing && existing.version >= version) return existing.promise;

  const promise = withGitLock(() =>
    refreshAskCheckoutLocked(repo, dir),
  ).finally(() => {
    if (askCheckoutRefreshes.get(repo.id)?.promise === promise) {
      askCheckoutRefreshes.delete(repo.id);
    }
  });
  askCheckoutRefreshes.set(repo.id, { version, promise });
  return promise;
}

export async function ensureAskCheckout(repoId?: string): Promise<string> {
  const repo = getRepo(repoId);
  if (sharedCheckoutForNewSessions(repo)) return repo.repo;
  const dir = `${worktreesDir()}/${repo.wtPrefix}-ask-checkout`;
  const requiredVersion = askCheckoutInvalidationVersion.get(repo.id) || 0;
  if (existsSync(dir)) {
    const last = askCheckoutRefreshedAt.get(repo.id) || 0;
    const force =
      requiredVersion > (askCheckoutAppliedVersion.get(repo.id) || 0);
    if (force || Date.now() - last > ASK_REFRESH_MS) {
      askCheckoutRefreshedAt.set(repo.id, Date.now());
      const refresh = refreshAskCheckout(repo, dir, requiredVersion);
      if (force) {
        await refresh;
        askCheckoutAppliedVersion.set(repo.id, requiredVersion);
      } else {
        void refresh.catch((error) => {
          console.warn(
            `[worktree] Ask checkout refresh failed for ${repo.id}:`,
            error,
          );
        });
      }
    }
    return dir;
  }
  return withGitLock(async () => {
    if (existsSync(dir)) {
      // A sibling may have created the checkout from the previous default
      // while this call was waiting for the Git lock. Apply the generation
      // captured by this call before returning instead of bypassing it.
      if (requiredVersion > (askCheckoutAppliedVersion.get(repo.id) || 0)) {
        await refreshAskCheckoutLocked(repo, dir);
        askCheckoutRefreshedAt.set(repo.id, Date.now());
        askCheckoutAppliedVersion.set(repo.id, requiredVersion);
      }
      return dir;
    }
    await $`git -C ${repo.repo} fetch origin ${repo.defaultBranch} --quiet`.nothrow();
    await $`git -C ${repo.repo} worktree prune`.quiet().nothrow();
    const add =
      await $`git -C ${repo.repo} worktree add --detach ${dir} origin/${repo.defaultBranch}`
        .quiet()
        .nothrow();
    if (add.exitCode !== 0 || !existsSync(dir)) {
      console.error(
        `[worktree] ask-checkout create failed for ${repo.id}: ${add.stderr.toString().trim()}`,
      );
      return repo.repo;
    }
    askCheckoutRefreshedAt.set(repo.id, Date.now());
    askCheckoutAppliedVersion.set(repo.id, requiredVersion);
    void installWorktreeDeps(repo, dir, "ask-checkout");
    return dir;
  });
}

export async function removeWorktree(
  branch: string,
  repoId?: string,
): Promise<void> {
  const repo = getRepo(repoId);
  try {
    const wtPath = `${worktreesDir()}/${repo.wtPrefix}-${branch}`;
    // Stop any running dev server before removing the directory — reads the
    // PGID from .ports/dev-pgid (written by ensure-up.sh) so it works even
    // after a opensession restart or when the server was started by an agent.
    try {
      await stopPreview(wtPath);
    } catch {}
    await $`git -C ${repo.repo} worktree remove ${wtPath} --force`.quiet();
  } catch (e) {
    console.error(`Failed to remove worktree for ${branch}:`, e);
    // Don't throw — session deletion should still succeed
  }
}

// No uncommitted/untracked changes, and every commit reachable from some
// remote ref (covers both pushed branches and branches merged to origin/main).
// Stale remote refs err on the safe side: recently-pushed work looks unpushed.
async function isWorktreeClean(
  wtPath: string,
  branch: string,
): Promise<boolean> {
  const status = await $`git -C ${wtPath} status --porcelain`.text();
  if (status.trim() !== "") return false;
  const unpushed =
    await $`git -C ${wtPath} rev-list ${branch} --not --remotes --count`.text();
  return unpushed.trim() === "0";
}

// True if the worktree has uncommitted changes or commits beyond its base
// branch — i.e. real work that switching the session's primary repo would
// strand. Errs toward "has work" on any git failure so a switch never silently
// throws work away. Used to gate the clean-only primary-repo switch.
export async function worktreeHasWork(
  wtPath: string,
  branch: string,
  repoId?: string,
): Promise<boolean> {
  const repo = getRepo(repoId);
  try {
    const status = await $`git -C ${wtPath} status --porcelain`.text();
    if (status.trim() !== "") return true;
    const ahead =
      await $`git -C ${wtPath} rev-list ${branch} --not origin/${repo.defaultBranch} --count`.text();
    return ahead.trim() !== "" && ahead.trim() !== "0";
  } catch {
    return true;
  }
}

/**
 * Remove worktrees of archived sessions idle for more than `days` days.
 * A worktree survives the sweep if any session sharing its branch is still
 * live (running, unarchived, or recently active), or if it has uncommitted
 * changes or commits that exist on no remote ref — WIP is never deleted.
 * Returns the branches whose worktrees were removed.
 */
export async function sweepArchivedWorktrees(
  sessions: UnifiedSession[],
  days: number,
): Promise<string[]> {
  const cutoff = Date.now() - days * 86_400_000;
  const inUse = new Set<string>();
  const candidates = new Set<string>();

  for (const s of sessions) {
    if (!s.branch) continue;
    const sweepable =
      s.archived && !s.isRunning && new Date(s.lastActivity).getTime() < cutoff;
    if (sweepable && s.worktreeDir) candidates.add(s.branch);
    else if (!sweepable) inUse.add(s.branch);
  }

  const existing = new Map(
    (await listWorktrees()).map((w) => [w.branch, w.path]),
  );
  const removed: string[] = [];

  for (const branch of candidates) {
    if (inUse.has(branch)) continue;
    const wtPath = existing.get(branch);
    if (!wtPath) continue; // worktree already gone
    try {
      if (!(await isWorktreeClean(wtPath, branch))) continue;
      await removeWorktree(branch);
      if (!existsSync(wtPath)) removed.push(branch);
    } catch (e) {
      console.error(`[worktree-sweep] Skipping ${branch}:`, e);
    }
  }

  return removed;
}

/**
 * Recreate a worktree that was cleaned up while its session lives on. Reuses
 * the local branch when it still exists (uncommitted work is gone, but the
 * branch history survives); otherwise starts the branch fresh from main. The
 * path is identical to the original, so claude session resume keeps working
 * (transcripts are keyed by cwd).
 */
export async function reviveWorktree(
  branch: string,
  repoId?: string,
): Promise<string> {
  const repo = getRepo(repoId);
  const wtPath = `${worktreesDir()}/${repo.wtPrefix}-${branch}`;
  if (existsSync(wtPath)) return wtPath;

  return withGitLock(async () => {
    await $`git -C ${repo.repo} worktree prune`.quiet();
    if (existsSync(wtPath)) return wtPath;
    const owner = (await listWorktrees(repo.id)).find(
      (w) => w.branch === branch,
    );
    if (owner) {
      throw new Error(
        `Branch ${JSON.stringify(branch)} is already checked out at ${owner.path}; cannot recreate ${wtPath}`,
      );
    }
    const hasBranch =
      (
        await $`git -C ${repo.repo} show-ref --verify --quiet refs/heads/${branch}`.nothrow()
      ).exitCode === 0;
    let add;
    if (hasBranch) {
      add = await $`git -C ${repo.repo} worktree add ${wtPath} ${branch}`
        .quiet()
        .nothrow();
    } else {
      const fetchBranch =
        await $`git -C ${repo.repo} fetch origin +refs/heads/${branch}:refs/remotes/origin/${branch} --quiet`
          .quiet()
          .nothrow();
      const hasRemote =
        fetchBranch.exitCode === 0 &&
        (
          await $`git -C ${repo.repo} show-ref --verify --quiet refs/remotes/origin/${branch}`.nothrow()
        ).exitCode === 0;
      if (!hasRemote) {
        await $`git -C ${repo.repo} fetch origin ${repo.defaultBranch} --quiet`;
      }
      const startPoint = hasRemote
        ? `origin/${branch}`
        : `origin/${repo.defaultBranch}`;
      add =
        await $`git -C ${repo.repo} worktree add -b ${branch} ${wtPath} ${startPoint}`
          .quiet()
          .nothrow();
    }
    if (add.exitCode !== 0) {
      throw new Error(
        `git worktree add failed for ${JSON.stringify(branch)}: ${add.stderr.toString().trim().slice(0, 300)}`,
      );
    }
    return wtPath;
  });
}

/**
 * Fetch branches, guaranteeing their `origin/<branch>` refs exist afterwards.
 *
 * `git fetch origin <branch>` writes `refs/remotes/origin/<branch>` only when the
 * remote's configured refspec covers it. A single-branch clone — what
 * `git clone --branch X` leaves behind, as
 * `remote.origin.fetch = +refs/heads/X:refs/remotes/origin/X` — updates FETCH_HEAD
 * and nothing else. The fetch then exits 0 while the `origin/<branch>` the callers
 * below hand to `worktree add` never appears, so the add dies with
 * "fatal: invalid reference: origin/<branch>" and EVERY PR review in that repo
 * fails identically (not transiently — retrying on the next push hits it again).
 * Explicit refspecs bypass the remote config. Found on a repo cloned
 * single-branch during node provisioning; `--unshallow` fixes depth, not this.
 */
async function githubServiceGitEnv(ghRepo: string | undefined) {
  const { githubServiceCredentialEnv } = await import("./github-app");
  return { ...process.env, ...(await githubServiceCredentialEnv(ghRepo)) };
}

async function fetchBranchesWithTracking(
  gitDir: string,
  ghRepo: string | undefined,
  ...branches: (string | undefined)[]
): Promise<void> {
  const specs = [...new Set(branches.filter((b): b is string => !!b))].map(
    (b) => `+refs/heads/${b}:refs/remotes/origin/${b}`,
  );
  if (specs.length === 0) return;
  await $`git -C ${gitDir} fetch origin ${specs} --quiet`.env(
    await githubServiceGitEnv(ghRepo),
  );
}

/**
 * Worktree checked out to an EXISTING PR head branch (not branched from main),
 * so commits/pushes land back on that PR. Uses a dedicated `-os` path so it
 * never clobbers a human/Slack worktree on the same branch. On reuse, hard-resets
 * to the freshly fetched PR head (each fix iteration pushes before yielding, so
 * there's no un-pushed local work to lose). Push back with
 * `git push origin HEAD:<headRef>`.
 */
export async function createWorktreeForPrBranch(
  headRef: string,
  repoId?: string,
): Promise<string> {
  const repo = getRepo(repoId);
  const wtPath = `${worktreesDir()}/${repo.wtPrefix}-${headRef}-os`;

  const reused = await withGitLock(async () => {
    await fetchBranchesWithTracking(repo.repo, repo.ghRepo, headRef);
    if (existsSync(wtPath)) {
      await $`git -C ${wtPath} fetch origin ${headRef} --quiet`
        .env(await githubServiceGitEnv(repo.ghRepo))
        .nothrow();
      await $`git -C ${wtPath} reset --hard origin/${headRef}`
        .quiet()
        .nothrow();
      return true;
    }
    await $`git -C ${repo.repo} worktree prune`.quiet();
    await $`git -C ${repo.repo} worktree add ${wtPath} -B ${headRef}-os origin/${headRef}`;
    return false;
  });
  if (reused) return wtPath;

  // Best-effort dep install so checks/builds the agent runs have deps available.
  await seedAndInstallWorktree(repo, wtPath, headRef);

  return wtPath;
}

/**
 * Read-only worktree pinned to a PR's HEAD for review runs. Deliberately
 * separate from the autofix `-os` worktree: autofix pushes trigger
 * re-reviews, so a review sharing that tree would hard-reset it out from
 * under the still-running autofix. Reviews are ask-mode (Read/Grep only, no
 * builds), so there's no dep install — a bare checkout is enough. On reuse it
 * re-pins to the freshly fetched head, which is safe here because nothing
 * else ever writes in this tree. Both head and base are fetched so the review
 * agent can inspect the complete PR with a local three-dot git diff.
 */
export async function createReviewWorktreeForPrHead(
  headRef: string,
  repoId?: string,
  baseRef?: string,
): Promise<string> {
  const repo = getRepo(repoId);
  const wtPath = `${worktreesDir()}/${repo.wtPrefix}-${headRef}-os-review`;
  return withGitLock(async () => {
    await fetchBranchesWithTracking(
      repo.repo,
      repo.ghRepo,
      headRef,
      baseRef || repo.defaultBranch,
    );
    if (existsSync(wtPath)) {
      // A code session recovering from a deleted worktree may have borrowed this
      // path and switched it onto the source branch. Restore review ownership.
      const repairAllowed = await clearStaleReviewIndexLock(wtPath);
      try {
        await $`git -C ${wtPath} switch -C ${headRef}-os-review origin/${headRef}`.quiet();
        await $`git -C ${wtPath} reset --hard origin/${headRef}`.quiet();
        return wtPath;
      } catch (error) {
        // A restart can kill `git worktree add` after it creates the directory
        // but before it finishes the index. That checkout is disposable. Once
        // no active index lock can be present, replace it instead of retrying
        // the same permanently half-initialized directory on every PR push.
        if (!repairAllowed || !(await clearStaleReviewIndexLock(wtPath)))
          throw error;
        console.warn(
          `[worktree] recreating unusable review worktree: ${wtPath}`,
        );
        await $`git -C ${repo.repo} worktree remove --force --force ${wtPath}`.quiet();
        await $`git -C ${repo.repo} worktree prune`.quiet();
      }
    } else {
      await $`git -C ${repo.repo} worktree prune`.quiet();
    }
    await $`git -C ${repo.repo} worktree add ${wtPath} -B ${headRef}-os-review origin/${headRef}`;
    return wtPath;
  });
}

/**
 * Worktree for a FOLLOW-UP branch cut fresh off `baseRef` (a PR's base, e.g.
 * `main`). Used when someone @-mentions the bot asking for a change on a PR that
 * is already merged/closed — you can't push to the old PR, so the work goes on a
 * new branch that opens its own PR. Idempotent: reuses an existing worktree/branch
 * (so a webhook-redelivery replay doesn't fork a second branch) rather than
 * failing on `worktree add -b`.
 */
export async function createWorktreeForFollowup(
  branch: string,
  baseRef: string,
  repoId?: string,
): Promise<string> {
  const repo = getRepo(repoId);
  const existing = (await listWorktrees(repo.id)).find(
    (w) => w.branch === branch,
  );
  if (existing) return existing.path;

  const wtPath = `${worktreesDir()}/${repo.wtPrefix}-${branch}`;
  await withGitLock(async () => {
    await $`git -C ${repo.repo} worktree prune`.quiet();
    if (existsSync(wtPath)) return; // pruned stale registration; dir already usable
    await $`git -C ${repo.repo} fetch origin ${baseRef} --quiet`.nothrow();
    const startPoint =
      (
        await $`git -C ${repo.repo} rev-parse --verify --quiet origin/${baseRef}`.nothrow()
      ).exitCode === 0
        ? `origin/${baseRef}`
        : `origin/${repo.defaultBranch}`;
    await $`git -C ${repo.repo} worktree add -b ${branch} ${wtPath} ${startPoint}`;
  });

  // Best-effort dep install so the follow-up run can build/test, same as siblings.
  await seedAndInstallWorktree(repo, wtPath, branch);

  return wtPath;
}

/**
 * Worktree checked out to an EXISTING branch (a PR's head branch), for
 * interactive sessions opened from a PR row. Unlike `createWorktreeForPrBranch`
 * (the autofix agents' variant) it never hard-resets on reuse — a human may
 * have un-pushed work there — and it checks out the branch itself (not a
 * `-os` copy), so commits/pushes land straight on the PR. Reuses an
 * existing worktree for the branch when one exists; prefers the local branch
 * (it may be ahead of origin), falling back to a fresh tracking branch off
 * `origin/<branch>`. Works for shared-checkout repos too (opensession): a PR
 * branch must never be checked out in the live main checkout, so it always
 * gets an isolated worktree.
 */
export async function createWorktreeForExistingBranch(
  branch: string,
  repoId?: string,
  gitEnv?: Record<string, string>,
): Promise<string> {
  const repo = getRepo(repoId);
  const shell = gitEnv ? $.env({ ...process.env, ...gitEnv }) : $;
  const existing = (await listWorktrees(repo.id)).find(
    (w) => w.branch === branch,
  );
  if (existing) return existing.path;

  const wtPath = `${worktreesDir()}/${repo.wtPrefix}-${branch}`;
  await withGitLock(async () => {
    await $`git -C ${repo.repo} worktree prune`.quiet();
    if (existsSync(wtPath)) return; // pruned stale registration; dir already usable
    await shell`git -C ${repo.repo} fetch origin ${branch} --quiet`.nothrow();
    const hasLocal =
      (
        await $`git -C ${repo.repo} show-ref --verify --quiet refs/heads/${branch}`.nothrow()
      ).exitCode === 0;
    if (hasLocal) {
      await $`git -C ${repo.repo} worktree add ${wtPath} ${branch}`;
    } else {
      await $`git -C ${repo.repo} worktree add -b ${branch} ${wtPath} origin/${branch}`;
    }
  });

  // Best-effort seed + dep install, same as createWorktree — backgrounded so
  // the opening turn isn't held behind a ~20s bun install (interactive path).
  void seedAndInstallWorktree(repo, wtPath, branch);

  return wtPath;
}

/**
 * Resolve a start-point ref for a new worktree branch: prefer a local ref
 * matching `base`, then `origin/<base>`, then `origin/<defaultBranch>`. Used for
 * stacked worktrees that branch off a workspace's existing branch.
 */
async function resolveStartPoint(
  repoDir: string,
  base: string,
  defaultBranch: string,
): Promise<string> {
  if (
    (await $`git -C ${repoDir} rev-parse --verify --quiet ${base}`.nothrow())
      .exitCode === 0
  )
    return base;
  if (
    (
      await $`git -C ${repoDir} rev-parse --verify --quiet origin/${base}`.nothrow()
    ).exitCode === 0
  )
    return `origin/${base}`;
  return `origin/${defaultBranch}`;
}

/**
 * Where a new branch starts: `origin/<defaultBranch>` when the repo has that
 * remote ref, else the local `<defaultBranch>`. A repo with no remote (the
 * scratch repo a release install starts with, or any local-only checkout)
 * still gets worktrees instead of "invalid reference: origin/main".
 */
async function defaultStartPoint(repo: Repo): Promise<string> {
  const remote = `origin/${repo.defaultBranch}`;
  const hasRemote =
    (
      await $`git -C ${repo.repo} rev-parse --verify --quiet ${remote}^{commit}`.nothrow()
    ).exitCode === 0;
  if (hasRemote) return remote;

  const hasLocal =
    (
      await $`git -C ${repo.repo} rev-parse --verify --quiet ${repo.defaultBranch}^{commit}`.nothrow()
    ).exitCode === 0;
  if (hasLocal) return repo.defaultBranch;

  // An empty remote has no commit from which Git can cut a worktree. Give its
  // configured default branch a local root commit so the first session gets a
  // normal linked worktree. This deliberately does not push: publishing the
  // new repository remains an explicit action by the session.
  const anyCommit = (
    await $`git -C ${repo.repo} rev-list --all --max-count=1`.quiet().nothrow()
  ).stdout
    .toString()
    .trim();
  if (!anyCommit) {
    const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const initialCommit = (
      await $`git -C ${repo.repo} -c user.name=${"Open Session"} -c user.email=${"assistant@opensession.dev"} commit-tree ${emptyTree} -m ${"Initial commit"}`.quiet()
    )
      .text()
      .trim();
    await $`git -C ${repo.repo} update-ref refs/heads/${repo.defaultBranch} ${initialCommit}`.quiet();
  }
  return repo.defaultBranch;
}

/**
 * The path `createWorktree(branch, repoId)` will produce, without doing any
 * git work. Lets the create-session flow announce a session (and drop the UI
 * into its empty session) before the slow worktree setup actually runs.
 * `isolated` forces the per-branch worktree path even for shared-checkout
 * repos — the from-PR flow checks out PR branches in isolation, never the
 * live main checkout (matches `createWorktreeForExistingBranch`).
 */
export function worktreePathFor(
  branch: string,
  repoId?: string,
  opts?: { isolated?: boolean },
): string {
  const repo = getRepo(repoId);
  return sharedCheckoutForNewSessions(repo) && !opts?.isolated
    ? repo.repo
    : `${worktreesDir()}/${repo.wtPrefix}-${branch}`;
}

/**
 * Pick a branch name that `git worktree add -b` can actually create, starting
 * from `desired` and bumping (`name`, `name-2`, `name-3`, …) until it clears
 * every existing local branch. Three collision kinds all block creation, and
 * we guard all three because git stores refs as files under `refs/heads/`:
 *   - exact match (`test` when `test` exists),
 *   - `desired` is a directory of an existing ref (`test` when `test/foo`
 *     exists — the reported failure: "cannot lock ref … 'test/…' exists"),
 *   - an existing ref is a directory prefix of `desired` (`test/foo` when a
 *     branch `test` exists).
 * Callers pass slug names (sanitizeBranchSlug maps `/`→`-`), and a suffix bump
 * always clears the first two collisions for a slash-free name; the third only
 * arises for slashed names (not produced here), where a parent branch blocks
 * the whole subtree and no suffix escapes it — we then return `desired` and let
 * the worktree add fail loudly rather than loop.
 * Used by the new-session path so a fresh session never dies on a name clash.
 * Reuse paths (existing worktree for the branch, from-PR, orphan adoption in
 * `createWorktree`) intentionally do NOT go through here — they want the exact
 * name back.
 */
export async function resolveUniqueBranch(
  desired: string,
  repoId?: string,
): Promise<string> {
  const repo = getRepo(repoId);
  // The format literal is interpolated (not written into the template) so Bun's
  // shell parser doesn't choke on the `%(…)` parens.
  const fmt = "%(refname:short)";
  const existing = new Set(
    (
      await $`git -C ${repo.repo} for-each-ref --format=${fmt} refs/heads`
        .nothrow()
        .text()
    )
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean),
  );
  const collides = (name: string) =>
    [...existing].some(
      (b) => b === name || b.startsWith(`${name}/`) || name.startsWith(`${b}/`),
    );
  if (!collides(desired)) return desired;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${desired}-${n}`;
    if (!collides(candidate)) return candidate;
  }
  // Astronomically unlikely; fall back to the desired name and let the worktree
  // add fail loudly rather than loop forever.
  return desired;
}

/**
 * Create a worktree for `branch`. By default it branches from
 * `origin/<defaultBranch>`. Pass `opts.base` (e.g. a workspace's branch) to
 * create a *stacked* worktree branched off that ref instead — this is what lets
 * sessions in a workspace stack PRs on top of the workspace's branch.
 */
export async function createWorktree(
  branch: string,
  repoId?: string,
  opts?: { base?: string; isolated?: boolean; gitEnv?: Record<string, string> },
): Promise<string> {
  const repo = getRepo(repoId);
  const shell = opts?.gitEnv ? $.env({ ...process.env, ...opts.gitEnv }) : $;

  // Shared-checkout repos (opensession) don't get a per-session worktree: the
  // session works in the live main checkout on the default branch so its edits
  // hot-reload in the running server. No branch is created or switched — every
  // session stays on the default branch and commits there.
  // `isolated` opts out and builds a real per-branch worktree even for a
  // shared-checkout repo — unattended code runs (automations) must never work
  // in the live checkout; they ship a PR instead (matches worktreePathFor /
  // createWorktreeForExistingBranch). Config `selfDev: "worktree"` opts the
  // whole instance out the same way (sharedCheckoutForNewSessions).
  if (sharedCheckoutForNewSessions(repo) && !opts?.isolated) return repo.repo;

  const wtPath = `${worktreesDir()}/${repo.wtPrefix}-${branch}`;
  const base = opts?.base;

  await withGitLock(async () => {
    await shell`git -C ${repo.repo} fetch origin ${repo.defaultBranch} --quiet`
      .quiet()
      .nothrow();
    let startPoint = await defaultStartPoint(repo);
    if (base) {
      // Stacked worktree: fetch the base (it may be remote-only), then branch off it.
      await shell`git -C ${repo.repo} fetch origin ${base} --quiet`.nothrow();
      startPoint = await resolveStartPoint(repo.repo, base, repo.defaultBranch);
    }
    const add =
      await $`git -C ${repo.repo} worktree add -b ${branch} ${wtPath} ${startPoint}`
        .quiet()
        .nothrow();
    if (add.exitCode === 0) return;
    // Collision tolerance: a create attempt killed mid-flight (e.g. a restart
    // drain) can leave the BRANCH created but no worktree — the retry then
    // died on "a branch named '…' already exists". Adopt such an orphan
    // branch only when it is provably just a base marker: zero commits of its
    // own on top of the start point and no registered worktree. A branch with
    // unique commits is somebody's work — keep failing loudly, never silently
    // adopt it.
    const stderr = add.stderr.toString();
    const branchExists =
      (
        await $`git -C ${repo.repo} show-ref --verify --quiet refs/heads/${branch}`.nothrow()
      ).exitCode === 0;
    if (branchExists) {
      const ahead = (
        await $`git -C ${repo.repo} rev-list --count ${startPoint}..${branch}`.nothrow()
      ).stdout
        .toString()
        .trim();
      await $`git -C ${repo.repo} worktree prune`.quiet().nothrow();
      const registered = (await listWorktrees(repo.id)).some(
        (w) => w.branch === branch,
      );
      if (ahead === "0" && !registered && !existsSync(wtPath)) {
        console.warn(
          `[worktree] adopting orphan branch ${branch} (0 commits ahead of ${startPoint}, no worktree) — likely a killed create attempt`,
        );
        await $`git -C ${repo.repo} worktree add ${wtPath} ${branch}`;
        return;
      }
    }
    throw new Error(
      `git worktree add -b ${branch} failed: ${stderr.trim().slice(0, 300)}`,
    );
  });

  // Best-effort warm-template seed + dep install — sessions can always run
  // `bun install` themselves. Config `worktreeSetup` / `depsInstall` overrides.
  // Backgrounded (not awaited): the opening
  // turn shouldn't wait ~20s on a webapp bun install it usually doesn't need.
  void seedAndInstallWorktree(repo, wtPath, branch);

  return wtPath;
}

/**
 * Resolve an isolated worktree for attaching a secondary repo to a session,
 * reusing an existing worktree for the branch when one is already checked out.
 * Returns the repo id, branch, and worktree dir. Shared-checkout repos
 * (opensession) can't be attached as an isolated worktree — they'd hand back the
 * live main checkout, so reject them. Under config `selfDev: "worktree"`,
 * createWorktree builds a real isolated tree for them, so the guard lifts.
 */
export async function prepareAttachedWorktree(
  repoId: string,
  branch: string,
  gitEnv?: Record<string, string>,
): Promise<{ repo: string; branch: string; dir: string }> {
  const repo = getRepo(repoId);
  if (sharedCheckoutForNewSessions(repo)) {
    throw new Error(
      `${repo.id} is a shared-checkout repo and can't be attached as an isolated worktree`,
    );
  }
  const existing = (await listWorktrees(repo.id)).find(
    (w) => w.branch === branch,
  );
  const dir =
    existing?.path ||
    (await createWorktree(branch, repo.id, gitEnv ? { gitEnv } : undefined));
  return { repo: repo.id, branch, dir };
}
