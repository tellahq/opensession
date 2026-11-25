/**
 * Workspace checkpoints for Sandbox sessions.
 *
 * A Sandbox's disk is the only copy of the session's uncommitted work, and a
 * provider can lose, expire, or replace that disk. After every clean turn the
 * session pushes a checkpoint to origin: one synthetic commit whose parent is
 * the branch tip and whose tree is the working tree (tracked changes and
 * untracked files that are not ignored), reachable from
 * `refs/opensession/checkpoints/<session id>`. It is a hidden ref: GitHub
 * shows it nowhere, `git fetch` never pulls it, and it costs no host storage.
 *
 * Restoring the checkpoint anywhere (a rebuilt Sandbox, another provider, a
 * worktree on this machine) is `reset --hard <commit>` followed by
 * `reset --mixed <commit>^`: the branch lands on the same tip with the same
 * uncommitted changes. Every restore is that uniform because the checkpoint
 * commit exists even when the tree was clean.
 *
 * What never enters a checkpoint: ignored files, the repository's private seed
 * files (`.agents/environment.json`), and `.ports.conf`, which describes
 * processes on the machine that wrote it. The GitHub App credential used for
 * the push lives only in the push command's environment; the origin remote
 * stays credential-free.
 *
 * Every checkpoint of a session runs on that session's lifecycle lane
 * (lifecycle-lane.ts): one at a time, in request order, and a turn does not
 * start while one is in flight. Two captures can therefore never race each
 * other's force-push, and the recorded commit is always the one the hidden
 * ref points at. A checkpoint is labeled with the branch the checkout is
 * actually on, read inside the Sandbox by the script itself (the agent may
 * have renamed or switched branches during the turn, and the session record
 * follows the checkout, not the other way round); it is only ever restored
 * onto that branch, and every restore checks it. Deletion of a session runs
 * on the same lane, so a queued operation that finds no session left is a
 * no-op instead of resurrecting the hidden ref.
 */

import { $ } from "bun";
import { githubServiceCredentialEnv } from "../github-app";
import { findSessionAsync, touchNativeSessionStrict } from "../session-cache";
import { withSessionLifecycleLane } from "./lifecycle-lane";
import type { SandboxCheckpointRecord, UnifiedSession } from "../types";
import {
  getRepo,
  isSharedCheckoutDir,
  withClaimedBranchWorktree,
  type Repo,
} from "../worktree";
import { pathExists } from "./async-fs";
import {
  checkpointRestoreScript,
  GIT_REFRESH_INDEX,
  loadRemoteWorkspaceSeedFiles,
  shellQuoteWord,
} from "./adapters/bootstrap";
import { isRemoteSandboxProvider } from "./config";
import type { Sandbox } from "./provider";

const CHECKPOINT_TIMEOUT_MS = 5 * 60_000;
const OPENSESSION_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Open Session",
  GIT_AUTHOR_EMAIL: "opensession@localhost",
  GIT_COMMITTER_NAME: "Open Session",
  GIT_COMMITTER_EMAIL: "opensession@localhost",
};

export function checkpointRef(sessionId: string): string {
  return `refs/opensession/checkpoints/${sessionId}`;
}

/**
 * The session's recorded checkpoint when it can be restored for the session
 * as it stands now, that is, when it was taken on the session's current
 * branch. A session can switch branches after a checkpoint (a failed turn
 * takes no new one); restoring the old record then would move the new branch
 * onto an unrelated tip and tree, so such a record is not restorable.
 */
export function restorableCheckpoint(
  session: Pick<UnifiedSession, "branch" | "sandboxCheckpoint">,
): SandboxCheckpointRecord | undefined {
  const checkpoint = session.sandboxCheckpoint;
  return checkpoint && checkpoint.branch === session.branch
    ? checkpoint
    : undefined;
}

/** Only a GitHub-hosted repository can hold a checkpoint: the push uses the
 * workspace's GitHub App credential and a hidden ref on that origin. */
export function checkpointCapable(
  repo: Pick<Repo, "host" | "ghRepo">,
): boolean {
  return repo.host !== "codestorage" && Boolean(repo.ghRepo);
}

/** Git environment for one push or fetch of the hidden ref from inside a
 * Sandbox or a host worktree. The token rides in the environment and is
 * answered by an inline helper, never written to argv, a remote URL, or the
 * repository's configuration. Null when the workspace has no credential. */
async function checkpointGitEnv(
  repo: Repo,
): Promise<Record<string, string> | null> {
  const token = (await githubServiceCredentialEnv(repo.ghRepo)).GH_TOKEN;
  if (!token) return null;
  return {
    GH_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_1:
      '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f',
    ...OPENSESSION_GIT_IDENTITY,
  };
}

/** Paths a checkpoint must leave out, repo-relative. */
async function excludedPaths(repo: Repo): Promise<string[]> {
  const seeded = (await loadRemoteWorkspaceSeedFiles(repo)).map(
    (file) => file.path,
  );
  return [".ports.conf", ...seeded];
}

/**
 * The script that builds and pushes the checkpoint. Reads its inputs from the
 * environment so nothing session-specific is interpolated into shell text
 * except the excluded paths, which are quoted. The branch it reports is the
 * one the checkout is on right now, never the caller's idea of it. Prints
 * one line: `detached` when HEAD is on no branch, `default <branch>` when it
 * is on the repository's default branch (`OS_DEFAULT_BRANCH`), both without
 * pushing; `unchanged <head> <tree> <branch>` when the last checkpoint
 * already holds this exact state on this branch; else
 * `pushed <commit> <head> <tree> <branch>`.
 */
export function checkpointScript(excluded: string[]): string {
  const rm = excluded.length
    ? `git rm -r --cached -q --ignore-unmatch -- ${excluded.map(shellQuoteWord).join(" ")} >/dev/null 2>&1 || true\n`
    : "";
  return [
    "set -eu",
    'cd "$OS_CWD"',
    "branch=$(git branch --show-current)",
    'if [ -z "$branch" ]; then echo detached; exit 0; fi',
    'if [ "$branch" = "${OS_DEFAULT_BRANCH:-}" ]; then echo "default $branch"; exit 0; fi',
    "head=$(git rev-parse --verify HEAD^{commit})",
    "idx=$(mktemp)",
    // Start from a copy of the checkout's own index: its stat data lets
    // `git add -A` rehash only what changed (seconds to milliseconds on a
    // large checkout; a fresh index hashes every file). Entries marked
    // assume-unchanged or skip-worktree would hide changes, so a checkout
    // with any falls back to building the index from HEAD.
    "real_idx=$(git rev-parse --git-path index)",
    'if [ -s "$real_idx" ] && ! git ls-files -v | grep -q "^[a-zS]"; then cp "$real_idx" "$idx"; else rm -f "$idx"; fi',
    'export GIT_INDEX_FILE="$idx"',
    'if [ ! -s "$idx" ]; then git read-tree "$head"; fi',
    "git add -A -- .",
    rm.trimEnd(),
    "tree=$(git write-tree)",
    "unset GIT_INDEX_FILE",
    'rm -f "$idx"',
    'if [ "$head" = "${OS_LAST_HEAD:-}" ] && [ "$tree" = "${OS_LAST_TREE:-}" ] && [ "$branch" = "${OS_LAST_BRANCH:-}" ]; then',
    '  echo "unchanged $head $tree $branch"; exit 0',
    "fi",
    'commit=$(printf \'Open Session checkpoint\\n\\nSession: %s\\nBranch: %s\\nHead: %s\\n\' "$OS_SESSION" "$branch" "$head" | git commit-tree "$tree" -p "$head")',
    'git push --force --quiet origin "$commit:$OS_REF"',
    'echo "pushed $commit $head $tree $branch"',
  ]
    .filter(Boolean)
    .join("\n");
}

/** The ref a landing leaves on the commit it landed: the next landing
 *  starts from that tree instead of from the branch tip, and a landing of
 *  the commit already there does nothing. */
export const LANDED_REF = "refs/opensession/landed";

/**
 * Shell that lands a checkout on a checkpoint whatever branch it is on: for
 * a Portal Sandbox (portal-sandbox.ts) or a GPU job machine (gpu-jobs.ts),
 * whose checkout is nobody's work and only ever mirrors the session's
 * checkpoints. Fetch the hidden ref, verify it is the recorded commit, make
 * the tracked files the checkpoint's tree, put `branch` on the checkpoint's
 * parent, and leave the checkpointed tree as uncommitted changes there,
 * exactly as the restore script does. Unlike the restore script it refuses
 * nothing: a renamed or switched branch simply lands here too.
 *
 * Built for checkouts that run a file watcher (a dev server) and for the
 * machines' partial clones (`--filter=blob:none`):
 *
 *  - Only files whose content changes are rewritten. The index is first set
 *    to the tree the previous landing left (`LANDED_REF`, stat data kept),
 *    so a file the session changed before and has not touched since is
 *    recognised as unchanged, and a file the previous checkpoint added and
 *    this one lacks is removed even though the branch never tracked it.
 *  - No blob of the checkpoint's parent is read. `reset --mixed <parent>`
 *    did (a lazy fetch per landing, and a fatal error once the remote no
 *    longer had it); the branch is moved with update-ref and the index
 *    rebuilt with a one-tree `read-tree -m`, which compares object ids only
 *    and keeps the stat data of every path the two trees share. Should that
 *    step fail anyway (a crash was seen in `reset --mixed` that could not be
 *    explained or reproduced), a plain `read-tree` gives the same end state
 *    and git rehashes the files lazily later.
 *  - The landing does nothing (no fetch, no reset) when the checkout is
 *    already on that checkpoint, and prints `unchanged`.
 *  - `clean` (default) deletes untracked files that are not ignored, except
 *    `keep`, so a new job starts on exactly the checkpoint. Without it,
 *    untracked files the checkpoint never had (a running job's scratch
 *    files) stay; files an earlier checkpoint put there and this one does
 *    not have are still removed.
 *
 * Prints `unchanged`, or `landed` followed by one line per path whose
 * content differs from the previous landing (`landed ?` when there was no
 * previous landing to compare with).
 */
export function checkpointLandScript(
  ref: string,
  commit: string,
  branch: string,
  keep: string[] = [],
  options: { clean?: boolean } = {},
): string {
  const exclude = keep.map((path) => `-e ${shellQuoteWord(path)}`).join(" ");
  const c = shellQuoteWord(commit);
  const b = shellQuoteWord(branch);
  return [
    "set -e",
    STALE_INDEX_LOCK_CLEANUP,
    STALE_TMP_PACK_CLEANUP,
    // No automatic gc or maintenance in the middle of a landing.
    'git() { command git -c gc.auto=0 -c maintenance.auto=false "$@"; }',
    `prev=$(git rev-parse -q --verify '${LANDED_REF}^{commit}' 2>/dev/null || true)`,
    `if [ "$prev" = ${c} ] && [ "$(git branch --show-current)" = ${b} ] && [ "$(git rev-parse -q --verify HEAD)" = "$(git rev-parse -q --verify "$prev^")" ]; then echo unchanged; exit 0; fi`,
    `git fetch --no-tags --quiet origin ${shellQuoteWord(`+${ref}:refs/opensession/checkpoint`)}`,
    `test "$(git rev-parse --verify 'refs/opensession/checkpoint^{commit}')" = ${c}`,
    'if [ -n "$prev" ]; then git read-tree --reset "$prev" || prev=; fi',
    GIT_REFRESH_INDEX,
    "git read-tree --reset -u refs/opensession/checkpoint",
    ...(options.clean === false ? [] : [`git clean -fdq ${exclude}`.trimEnd()]),
    `git update-ref ${shellQuoteWord(`refs/heads/${branch}`)} 'refs/opensession/checkpoint^'`,
    `git symbolic-ref HEAD ${shellQuoteWord(`refs/heads/${branch}`)}`,
    "git read-tree --reset 'refs/opensession/checkpoint^' || { echo 'read-tree --reset failed; rebuilding the index without stat data' >&2; git read-tree 'refs/opensession/checkpoint^'; }",
    `if [ -n "$prev" ]; then changed=$(git diff-tree -r --name-only "$prev" refs/opensession/checkpoint); else changed='?'; fi`,
    `git update-ref ${LANDED_REF} refs/opensession/checkpoint`,
    "git update-ref -d refs/opensession/checkpoint",
    'printf "landed\\n%s\\n" "$changed"',
  ].join("\n");
}

/** Interrupted fetches leave `tmp_pack_*` files (hundreds of MB on a large
 *  repository) that git never removes. One untouched for an hour belongs to
 *  no running fetch. */
export const STALE_TMP_PACK_CLEANUP =
  'find "$(git rev-parse --git-path objects/pack)" -maxdepth 1 -name "tmp_*" -mmin +60 -delete 2>/dev/null || true';

/** What a landing did: nothing (the checkout was already there), or landed
 *  with the paths whose content changed (`null` when unknown). */
export type LandOutcome =
  | { state: "unchanged" }
  | { state: "landed"; changed: string[] | null };

export function parseLandOutput(stdout: string): LandOutcome {
  const lines = stdout.split("\n");
  const at = lines.findLastIndex(
    (line) => line === "landed" || line === "unchanged",
  );
  if (at < 0) return { state: "landed", changed: null };
  if (lines[at] === "unchanged") return { state: "unchanged" };
  const rest = lines.slice(at + 1).filter(Boolean);
  return {
    state: "landed",
    changed: rest.length === 1 && rest[0] === "?" ? null : rest,
  };
}

const LAND_RETRY_DELAY_MS = 2_000;

/** A git that crashed or was killed mid-landing (a timed-out command, a
 *  segfault under memory pressure) leaves `index.lock` behind, and every
 *  later landing then fails with "File exists". Nothing else in a Portal
 *  Sandbox's checkout writes the index, so a lock no running git holds, or
 *  one older than five minutes, is stale. */
export const STALE_INDEX_LOCK_CLEANUP =
  'lock="$(git rev-parse --git-dir)/index.lock" && ' +
  '{ ! test -e "$lock" || ' +
  "{ command -v pgrep >/dev/null 2>&1 && pgrep -x git >/dev/null 2>&1 && " +
  'test -z "$(find "$lock" -mmin +5 2>/dev/null)"; } || rm -f "$lock"; }';

/**
 * Land a checkpoint in a Sandbox whose checkout mirrors the session (a
 * Portal Sandbox, a GPU job machine). The token rides in the command's
 * environment as for a push; the Sandbox's origin stays credential-free.
 * Throws when the workspace has no credential or git refuses.
 */
export async function landCheckpointInSandbox(
  repoId: string | undefined,
  sandbox: Sandbox,
  checkpoint: Pick<SandboxCheckpointRecord, "ref" | "commit" | "branch">,
  options: { clean?: boolean } = {},
): Promise<LandOutcome> {
  const repo = getRepo(repoId);
  const env = await checkpointGitEnv(repo);
  if (!env) throw new Error("the workspace has no GitHub credential");
  const script = checkpointLandScript(
    checkpoint.ref,
    checkpoint.commit,
    checkpoint.branch,
    await excludedPaths(repo),
    options,
  );
  const land = () =>
    sandbox.exec(["bash", "-c", script], {
      env,
      timeoutMs: CHECKPOINT_TIMEOUT_MS,
    });
  // The landing is idempotent, so one retry absorbs a transient failure: a
  // provider command plane that hiccuped, or a git that crashed and left
  // its lock behind.
  let result = await land();
  if (result.exitCode !== 0) {
    await Bun.sleep(LAND_RETRY_DELAY_MS);
    result = await land();
  }
  if (result.exitCode !== 0)
    throw new Error(
      `could not land checkpoint ${checkpoint.commit.slice(0, 12)} in ${sandbox.id}: ` +
        `${(result.stderr || result.stdout).trim().slice(0, 300)}`,
    );
  return parseLandOutput(result.stdout);
}

export type CheckpointOutcome =
  | { state: "pushed" | "unchanged"; checkpoint: SandboxCheckpointRecord }
  | { state: "skipped"; reason: string };

type CheckpointSession = Pick<
  UnifiedSession,
  "id" | "repo" | "branch" | "worktreeDir" | "sandbox" | "sandboxCheckpoint"
>;

/** Runs the checkpoint script somewhere and returns its exit code and output:
 * inside a Sandbox (`sandbox.exec`) or on this machine (`bun`'s shell). */
type ScriptRunner = (
  script: string,
  env: Record<string, string>,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * One checkpoint on the session's lane. Callers pass the session record as
 * it stands once the lane is theirs (a queued caller's own copy may be
 * stale). `unchanged` needs no write; `pushed` becomes the session's
 * `sandboxCheckpoint` before the lane is released, so the next checkpoint
 * and the next turn both see it. The record is labeled with the branch the
 * checkout is actually on; when that is not the session record's branch
 * (the agent renamed or switched it, which run-session can only notice for a
 * checkout on this machine), the session record follows in the same write,
 * so the checkpoint restores onto, and later publication targets, the
 * branch the work is really on. For the same reason nothing here decides
 * from the record alone whether the checkout is on the default branch: a
 * session recorded on `main` whose agent switched to a feature branch
 * would otherwise never get a checkpoint. The script looks and says.
 */
async function runCheckpoint(
  session: CheckpointSession,
  cwd: string,
  run: ScriptRunner,
): Promise<CheckpointOutcome> {
  if (!session.branch) return { state: "skipped", reason: "no branch" };
  const repo = getRepo(session.repo);
  if (!checkpointCapable(repo))
    return { state: "skipped", reason: "repository is not on GitHub" };
  const env = await checkpointGitEnv(repo);
  if (!env) return { state: "skipped", reason: "no GitHub credential" };
  const ref = checkpointRef(session.id);
  const last = session.sandboxCheckpoint;
  const result = await run(checkpointScript(await excludedPaths(repo)), {
    ...env,
    OS_CWD: cwd,
    OS_REF: ref,
    OS_SESSION: session.id,
    OS_DEFAULT_BRANCH: repo.defaultBranch,
    OS_LAST_HEAD: last?.ref === ref ? last.head : "",
    OS_LAST_TREE: last?.ref === ref ? last.tree : "",
    OS_LAST_BRANCH: last?.ref === ref ? last.branch : "",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `checkpoint push failed: ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
    );
  }
  const line = result.stdout.trim().split("\n").at(-1) || "";
  const [state, ...parts] = line.split(/\s+/);
  if (state === "detached")
    return { state: "skipped", reason: "checkout is on a detached HEAD" };
  if (state === "default")
    return { state: "skipped", reason: "session is on the default branch" };
  if (state === "unchanged" && last?.ref === ref && parts[2] === last.branch)
    return { state: "unchanged", checkpoint: last };
  if (state !== "pushed" || parts.length < 4)
    throw new Error(`checkpoint produced no result: ${line.slice(0, 200)}`);
  const branch = parts[3]!;
  const checkpoint: SandboxCheckpointRecord = {
    ref,
    commit: parts[0]!,
    head: parts[1]!,
    tree: parts[2]!,
    branch,
    at: new Date().toISOString(),
  };
  const patch =
    branch === session.branch
      ? { sandboxCheckpoint: checkpoint }
      : { sandboxCheckpoint: checkpoint, branch };
  await touchNativeSessionStrict(session.id, patch);
  console.log(
    `[sandbox] ${session.id}: checkpoint ${checkpoint.commit.slice(0, 12)} on ${ref}` +
      (branch === session.branch
        ? ""
        : ` (checkout is on ${branch}, record said ${session.branch}; record updated)`),
  );
  return { state: "pushed", checkpoint };
}

/**
 * Push the session's current workspace state from its Sandbox to origin and
 * record it on the session. Never throws for an expected limitation (no
 * branch, no GitHub credential, codestorage repo); a git failure does.
 * Serialized on the session's lifecycle lane, which is claimed synchronously
 * here; `sandbox` may be a resolver that is only called once the lane is
 * ours, with the session record as it stands then. A resolver that yields
 * null (no reachable Sandbox) makes the checkpoint a no-op `skipped`, and so
 * does a session that was deleted while the request waited: the caller's
 * copy of the record is never used in its place.
 */
export function checkpointSessionWorkspace(
  session: CheckpointSession,
  sandbox: Sandbox | ((current: CheckpointSession) => Promise<Sandbox | null>),
): Promise<CheckpointOutcome> {
  return withSessionLifecycleLane(session.id, async () => {
    const current = await findSessionAsync(session.id);
    if (!current) return { state: "skipped", reason: "session was deleted" };
    if (!isRemoteSandboxProvider(current.sandbox?.provider))
      return { state: "skipped", reason: "not a Sandbox session" };
    const target =
      typeof sandbox === "function" ? await sandbox(current) : sandbox;
    if (!target) return { state: "skipped", reason: "Sandbox not reachable" };
    const cwd = target.cwd || current.worktreeDir;
    if (!cwd) return { state: "skipped", reason: "no workspace" };
    return runCheckpoint(current, cwd, (script, env) =>
      target.exec(["bash", "-c", script], {
        env,
        timeoutMs: CHECKPOINT_TIMEOUT_MS,
      }),
    );
  });
}

/**
 * The same checkpoint from a worktree on this machine, for a session moving
 * INTO a Sandbox: its uncommitted work travels with it instead of staying
 * behind. A shared checkout is never checkpointed (the tree is everyone's).
 */
export function checkpointHostWorkspace(
  session: Omit<CheckpointSession, "sandbox">,
  dir: string,
): Promise<CheckpointOutcome> {
  return withSessionLifecycleLane(session.id, async () => {
    if (!(await pathExists(dir)))
      return { state: "skipped", reason: "no worktree" };
    if (await isSharedCheckoutDir(dir))
      return { state: "skipped", reason: "shared checkout" };
    const current = await findSessionAsync(session.id);
    if (!current) return { state: "skipped", reason: "session was deleted" };
    return runCheckpoint(
      { ...current, sandbox: undefined },
      dir,
      async (script, env) => {
        const result = await $`bash -c ${script}`
          .env({ ...process.env, ...env })
          .quiet()
          .nothrow();
        return {
          exitCode: result.exitCode,
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
        };
      },
    );
  });
}

/**
 * Materialize a worktree for `branch` on this machine and restore the
 * checkpoint into it: the branch ends on the checkpoint's head with the
 * checkpointed changes uncommitted. Works whether or not origin has ever seen
 * the branch, because the checkpoint commit carries the branch tip.
 *
 * The restore is `reset --hard`, so it must never land in a checkout that
 * holds someone else's work. Finding, creating, and rewriting the checkout
 * happen as one step under the repository's git lock
 * (`withClaimedBranchWorktree`), so two restores of the same branch cannot
 * both see it free: the first creates and fills the worktree, the second
 * finds it occupied. An occupied checkout is refused, with one exception:
 * the detaching session's own former worktree (`ownWorktreeDir`) is
 * re-adopted when that is provably lossless, that is, its tree is clean and
 * its tip is an ancestor of the checkpoint. Anything else, including a dirty
 * tree of the session's own, is left for a person to look at. A local branch
 * this machine already had without a worktree (left behind by an earlier
 * cleanup, possibly with commits that were never pushed) is restored onto
 * only when the checkpoint extends its tip, for the same reason; only a
 * branch created for this restore, from origin or the default branch, may be
 * reset to the checkpoint outright, because nothing on this machine is lost
 * that way. A checkpoint taken on another branch than `branch` is refused
 * before anything happens.
 */
export async function restoreCheckpointToHostWorktree(
  repo: Repo,
  branch: string,
  checkpoint: Pick<SandboxCheckpointRecord, "ref" | "commit" | "branch">,
  ownWorktreeDir?: string,
): Promise<string> {
  if (checkpoint.branch !== branch)
    throw new Error(
      `the checkpoint was taken on branch ${checkpoint.branch}, but this session is on ${branch}; it cannot be restored here`,
    );
  const env = await checkpointGitEnv(repo);
  if (!env) throw new Error("no GitHub credential to fetch the checkpoint");
  return withClaimedBranchWorktree(
    branch,
    repo.id,
    env,
    async ({ path: dir, created, createdBranch }) => {
      if (!created) {
        if (dir !== ownWorktreeDir || (await isSharedCheckoutDir(dir)))
          throw new Error(
            `branch ${branch} is already checked out at ${dir} on this machine, and restoring the checkpoint there would overwrite its files. Move or remove that checkout first.`,
          );
        const dirty = (
          await $`git -C ${dir} status --porcelain`.quiet().nothrow().text()
        ).trim();
        if (dirty)
          throw new Error(
            `this session's former worktree at ${dir} has uncommitted changes that the checkpoint would overwrite. Commit, stash, or discard them there first.`,
          );
      }
      const script = `cd ${shellQuoteWord(dir)} && ${checkpointRestoreScript(
        checkpoint.ref,
        checkpoint.commit,
        { branch, onlyForward: !createdBranch },
      )}`;
      const result = await $`bash -c ${script}`
        .env({ ...process.env, ...env })
        .quiet()
        .nothrow();
      if (result.exitCode !== 0) {
        throw new Error(
          `checkpoint restore failed: ${result.stderr.toString().trim().slice(0, 400)}`,
        );
      }
      return dir;
    },
  );
}

/** Remove the hidden ref when a session is deleted. Best effort; an archived
 * session keeps its checkpoint because that may be the only copy of its work. */
export async function deleteSessionCheckpoint(
  session: Pick<UnifiedSession, "id" | "repo" | "sandboxCheckpoint">,
): Promise<void> {
  const checkpoint = session.sandboxCheckpoint;
  if (!checkpoint) return;
  let repo: Repo;
  try {
    repo = getRepo(session.repo);
  } catch {
    return;
  }
  if (!checkpointCapable(repo)) return;
  const env = await checkpointGitEnv(repo);
  if (!env) return;
  const result =
    await $`git -C ${repo.repo} push --quiet origin --delete ${checkpoint.ref}`
      .env({ ...process.env, ...env })
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) {
    console.warn(
      `[sandbox] ${session.id}: could not delete ${checkpoint.ref}: ${result.stderr.toString().trim().slice(0, 200)}`,
    );
  }
}
