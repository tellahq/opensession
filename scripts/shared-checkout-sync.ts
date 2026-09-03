#!/usr/bin/env bun
/**
 * Fast-forward the shared checkout's branch to its remote without touching
 * anyone's uncommitted work.
 *
 * `git pull --ff-only` refuses the shared checkout as soon as one dirty file
 * overlaps an upstream commit, and the checkout rules forbid stash, reset, and
 * discarding other sessions' edits. Sessions then either rebase only their
 * own commit or commit from a throwaway worktree, and local `main` silently
 * falls behind for everyone. This tool is the sanctioned way to move `main`:
 *
 *  - paths that are clean locally follow upstream as in a normal fast-forward;
 *  - paths whose local content already equals upstream (an edit that landed
 *    from elsewhere) simply become clean;
 *  - paths with a genuine local edit get that edit three-way merged onto the
 *    new upstream content, separately for the index and the worktree, so
 *    staged and unstaged work stay distinct. The pre-merge file is copied to
 *    `.git/shared-checkout-sync/<timestamp>/` first;
 *  - paths whose edit conflicts with upstream are left exactly as they are and
 *    listed in the report. Their owner must reapply the edit by hand.
 *
 * The branch ref is moved last with a compare-and-swap, so a concurrent commit
 * cannot be lost. Untracked files, ignored files, and other branches are never
 * touched. Exit 0 when synced and clean, 2 when synced but conflicts remain,
 * 1 when the tool refused to act.
 *
 * Usage: bun scripts/shared-checkout-sync.ts [--dry-run] [--remote origin]
 */

import {
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

interface Options {
  cwd: string;
  dryRun: boolean;
  remote: string;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface UpstreamChange {
  path: string;
  status: "A" | "M" | "D" | "T";
  oldMode: string;
  newMode: string;
  oldBlob: string | null;
  newBlob: string | null;
}

interface IndexEntry {
  mode: string;
  blob: string;
  stage: number;
}

type Plan =
  | { kind: "follow"; change: UpstreamChange }
  | { kind: "landed"; change: UpstreamChange }
  | { kind: "noop"; change: UpstreamChange }
  | { kind: "remove"; change: UpstreamChange }
  | {
      kind: "rebase";
      change: UpstreamChange;
      index: { mode: string; blob: string } | null;
      worktree: Uint8Array | null;
    }
  | { kind: "conflict"; change: UpstreamChange; reason: string };

const NULL_BLOB = "0000000000000000000000000000000000000000";

function parseArgs(argv: string[]): Options {
  const options: Options = {
    cwd: process.cwd(),
    dryRun: false,
    remote: "origin",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--remote" && argv[i + 1]) {
      options.remote = argv[i + 1]!;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: bun scripts/shared-checkout-sync.ts [--dry-run] [--remote <name>]",
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return options;
}

function git(
  cwd: string,
  args: string[],
  input?: Uint8Array | string,
): GitResult {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function gitBytes(cwd: string, args: string[]): Uint8Array {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return new Uint8Array(result.stdout);
}

function must(
  cwd: string,
  args: string[],
  input?: Uint8Array | string,
): string {
  const result = git(cwd, args, input);
  if (result.code !== 0)
    throw new Error(
      `git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`,
    );
  return result.stdout;
}

function refuse(message: string): never {
  console.error(`shared-checkout-sync: ${message}`);
  process.exit(1);
}

function nulList(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function upstreamChanges(
  cwd: string,
  from: string,
  to: string,
): UpstreamChange[] {
  const raw = must(cwd, [
    "diff-tree",
    "-r",
    "--no-renames",
    "--raw",
    "-z",
    from,
    to,
  ]);
  const tokens = raw.split("\0");
  const changes: UpstreamChange[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = tokens[i]!;
    const path = tokens[i + 1]!;
    if (!meta.startsWith(":")) continue;
    const [oldMode, newMode, oldBlob, newBlob, statusToken] = meta
      .slice(1)
      .split(" ");
    const status = statusToken?.[0];
    if (status !== "A" && status !== "M" && status !== "D" && status !== "T")
      throw new Error(`unexpected diff status ${statusToken} for ${path}`);
    changes.push({
      path,
      status,
      oldMode: oldMode!,
      newMode: newMode!,
      oldBlob: oldBlob === NULL_BLOB ? null : oldBlob!,
      newBlob: newBlob === NULL_BLOB ? null : newBlob!,
    });
  }
  return changes;
}

function indexEntries(cwd: string): Map<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>();
  for (const line of nulList(must(cwd, ["ls-files", "-s", "-z"]))) {
    const tab = line.indexOf("\t");
    const [mode, blob, stage] = line.slice(0, tab).split(" ");
    entries.set(line.slice(tab + 1), {
      mode: mode!,
      blob: blob!,
      stage: Number(stage),
    });
  }
  return entries;
}

function blobOfFile(cwd: string, path: string): string {
  return must(cwd, ["hash-object", "--", path]).trim();
}

function blobContent(cwd: string, blob: string): Uint8Array {
  return gitBytes(cwd, ["cat-file", "blob", blob]);
}

/** Three-way merge with git's own algorithm. Null means a textual conflict or
 *  a binary file: the caller leaves that path alone. */
function threeWayMerge(
  cwd: string,
  scratch: string,
  base: Uint8Array,
  ours: Uint8Array,
  theirs: Uint8Array,
): Uint8Array | null {
  const baseFile = join(scratch, "base");
  const oursFile = join(scratch, "ours");
  const theirsFile = join(scratch, "theirs");
  writeFileSync(baseFile, base);
  writeFileSync(oursFile, ours);
  writeFileSync(theirsFile, theirs);
  const result = Bun.spawnSync({
    cmd: [
      "git",
      "merge-file",
      "-p",
      "-L",
      "local edit",
      "-L",
      "previous main",
      "-L",
      "origin/main",
      oursFile,
      baseFile,
      theirsFile,
    ],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? new Uint8Array(result.stdout) : null;
}

function planChange(
  cwd: string,
  scratch: string,
  change: UpstreamChange,
  index: Map<string, IndexEntry>,
  worktreeDiffersFromOld: Set<string>,
  indexDiffersFromOld: Set<string>,
): Plan {
  const entry = index.get(change.path);
  const absolute = join(cwd, change.path);
  let stat: ReturnType<typeof lstatSync> | null = null;
  try {
    stat = lstatSync(absolute);
  } catch {
    stat = null;
  }

  if (entry && entry.stage !== 0)
    return { kind: "conflict", change, reason: "unmerged index entry" };

  if (change.status === "A" && !entry) {
    if (!stat) return { kind: "follow", change };
    if (stat.isFile() && blobOfFile(cwd, change.path) === change.newBlob)
      return { kind: "landed", change };
    return {
      kind: "conflict",
      change,
      reason: "an untracked local file differs from the new upstream file",
    };
  }

  if (!entry) {
    // Removed from the index locally. If upstream removed it too the removal
    // has landed; an untracked leftover is never ours to touch.
    if (change.status === "D") return { kind: "noop", change };
    return {
      kind: "conflict",
      change,
      reason: "the path is staged for deletion locally",
    };
  }

  const indexClean = !indexDiffersFromOld.has(change.path);
  const worktreeClean = !worktreeDiffersFromOld.has(change.path);
  if (indexClean && worktreeClean)
    return change.status === "D"
      ? { kind: "remove", change }
      : { kind: "follow", change };

  if (change.status === "D")
    return {
      kind: "conflict",
      change,
      reason: "upstream deleted a file that has local edits",
    };
  if (change.status === "T" || entry.mode === "120000" || !stat?.isFile())
    return {
      kind: "conflict",
      change,
      reason: "type or symlink change with local edits",
    };

  const indexAtNew = entry.blob === change.newBlob;
  const worktreeBlob = blobOfFile(cwd, change.path);
  const worktreeAtNew = worktreeBlob === change.newBlob;
  if (indexAtNew && worktreeAtNew) return { kind: "landed", change };

  // A path added upstream that a session had already staged merges against
  // an empty base, exactly as git treats a both-added file.
  const base = change.oldBlob
    ? blobContent(cwd, change.oldBlob)
    : new Uint8Array();
  const theirs = blobContent(cwd, change.newBlob!);
  let mergedIndex: { mode: string; blob: string } | null = null;
  if (!indexAtNew) {
    if (indexClean)
      mergedIndex = { mode: change.newMode, blob: change.newBlob! };
    else {
      const merged = threeWayMerge(
        cwd,
        scratch,
        base,
        blobContent(cwd, entry.blob),
        theirs,
      );
      if (!merged)
        return {
          kind: "conflict",
          change,
          reason: "staged edit conflicts with upstream",
        };
      mergedIndex = {
        mode: change.newMode,
        blob: must(cwd, ["hash-object", "-w", "--stdin"], merged).trim(),
      };
    }
  }
  let mergedWorktree: Uint8Array | null = null;
  if (!worktreeAtNew) {
    if (worktreeClean) mergedWorktree = theirs;
    else {
      const merged = threeWayMerge(
        cwd,
        scratch,
        base,
        readFileSync(absolute),
        theirs,
      );
      if (!merged)
        return {
          kind: "conflict",
          change,
          reason: "local edit conflicts with upstream",
        };
      mergedWorktree = merged;
    }
  }
  return {
    kind: "rebase",
    change,
    index: mergedIndex,
    worktree: mergedWorktree,
  };
}

function ageLabel(path: string): string {
  try {
    const ms = Date.now() - lstatSync(path).mtimeMs;
    const hours = ms / 3_600_000;
    if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} min old`;
    if (hours < 48) return `${Math.round(hours)} h old`;
    return `${Math.round(hours / 24)} d old`;
  } catch {
    return "missing";
  }
}

function acquireLock(gitDir: string): () => void {
  const lockPath = join(gitDir, "shared-checkout-sync.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // Already gone.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(lockPath, "utf8").trim());
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive) refuse(`another sync (pid ${pid}) is running`);
      unlinkSync(lockPath);
    }
  }
  refuse("could not take the sync lock");
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const toplevel = git(options.cwd, ["rev-parse", "--show-toplevel"]);
  if (toplevel.code !== 0) refuse("not inside a git checkout");
  const cwd = toplevel.stdout.trim();
  const gitDir = must(cwd, ["rev-parse", "--absolute-git-dir"]).trim();
  const branchResult = git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (branchResult.code !== 0) refuse("HEAD is detached; nothing to sync");
  const branch = branchResult.stdout.trim();
  const upstream = `${options.remote}/${branch}`;

  const fetch = git(cwd, ["fetch", options.remote, "--prune", "--quiet"]);
  if (fetch.code !== 0) refuse(`fetch failed: ${fetch.stderr.trim()}`);

  const oldHead = must(cwd, [
    "rev-parse",
    "--verify",
    `refs/heads/${branch}`,
  ]).trim();
  const upstreamResult = git(cwd, [
    "rev-parse",
    "--verify",
    `refs/remotes/${upstream}`,
  ]);
  if (upstreamResult.code !== 0) refuse(`${upstream} does not exist`);
  const newHead = upstreamResult.stdout.trim();

  if (oldHead === newHead) {
    console.log(
      `shared-checkout-sync: ${branch} already at ${upstream} (${newHead.slice(0, 10)})`,
    );
    return 0;
  }
  const oldIsAncestor =
    git(cwd, ["merge-base", "--is-ancestor", oldHead, newHead]).code === 0;
  if (!oldIsAncestor) {
    const newIsAncestor =
      git(cwd, ["merge-base", "--is-ancestor", newHead, oldHead]).code === 0;
    refuse(
      newIsAncestor
        ? `${branch} is ahead of ${upstream}: push the local commits first`
        : `${branch} and ${upstream} have diverged: rebase the local commits onto ${upstream} first`,
    );
  }

  const releaseLock = acquireLock(gitDir);
  const scratch = mkdtempSync(join(tmpdir(), "shared-checkout-sync-"));
  try {
    const changes = upstreamChanges(cwd, oldHead, newHead);
    const index = indexEntries(cwd);
    const worktreeDiffersFromOld = new Set(
      nulList(must(cwd, ["diff", "--name-only", "-z", oldHead, "--"])),
    );
    const indexDiffersFromOld = new Set(
      nulList(
        must(cwd, ["diff", "--cached", "--name-only", "-z", oldHead, "--"]),
      ),
    );
    const plans = changes.map((change) =>
      planChange(
        cwd,
        scratch,
        change,
        index,
        worktreeDiffersFromOld,
        indexDiffersFromOld,
      ),
    );

    const follow = plans.filter((plan) => plan.kind === "follow");
    const remove = plans.filter((plan) => plan.kind === "remove");
    const landed = plans.filter((plan) => plan.kind === "landed");
    const rebase = plans.filter(
      (plan): plan is Extract<Plan, { kind: "rebase" }> =>
        plan.kind === "rebase",
    );
    const conflicts = plans.filter(
      (plan): plan is Extract<Plan, { kind: "conflict" }> =>
        plan.kind === "conflict",
    );
    const noop = plans.filter((plan) => plan.kind === "noop");
    const commitCount = must(cwd, [
      "rev-list",
      "--count",
      `${oldHead}..${newHead}`,
    ]).trim();

    console.log(
      `shared-checkout-sync: ${branch} ${oldHead.slice(0, 10)} -> ${upstream} ${newHead.slice(0, 10)} (${commitCount} commits, ${changes.length} paths)`,
    );
    console.log(
      `  follow upstream: ${follow.length + remove.length}   already landed: ${landed.length + noop.length}   local edits rebased: ${rebase.length}   conflicts left untouched: ${conflicts.length}`,
    );

    if (options.dryRun) {
      for (const plan of rebase) console.log(`  rebase   ${plan.change.path}`);
      for (const plan of conflicts)
        console.log(`  conflict ${plan.change.path}: ${plan.reason}`);
      console.log("  dry run: nothing changed");
      return conflicts.length ? 2 : 0;
    }

    const pathspec = (items: Plan[]) =>
      items.map((plan) => plan.change.path).join("\0");
    if (follow.length || landed.length)
      must(
        cwd,
        [
          "checkout",
          newHead,
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
          "--",
        ],
        pathspec([...follow, ...landed]),
      );
    if (remove.length)
      must(
        cwd,
        [
          "rm",
          "--quiet",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
          "--",
        ],
        pathspec(remove),
      );

    let backupDir: string | null = null;
    for (const plan of rebase) {
      const absolute = join(cwd, plan.change.path);
      if (plan.worktree) {
        backupDir ??= join(
          gitDir,
          "shared-checkout-sync",
          new Date().toISOString().replace(/[:.]/g, "-"),
        );
        const backup = join(backupDir, plan.change.path);
        mkdirSync(dirname(backup), { recursive: true });
        copyFileSync(absolute, backup);
      }
      if (plan.index)
        must(cwd, [
          "update-index",
          "--cacheinfo",
          `${plan.index.mode},${plan.index.blob},${plan.change.path}`,
        ]);
      if (plan.worktree) writeFileSync(absolute, plan.worktree);
    }

    must(cwd, [
      "update-ref",
      "-m",
      `shared-checkout-sync: fast-forward to ${upstream}`,
      `refs/heads/${branch}`,
      newHead,
      oldHead,
    ]);

    for (const plan of rebase)
      console.log(
        `  rebased  ${plan.change.path} (${ageLabel(join(cwd, plan.change.path))})`,
      );
    if (backupDir) console.log(`  pre-merge copies: ${backupDir}`);
    if (
      changes.some(
        (change) =>
          change.path === "bun.lock" || change.path.endsWith("package.json"),
      )
    )
      console.log(
        "  dependencies changed upstream: run bun install --frozen-lockfile before bun run check",
      );
    if (conflicts.length) {
      console.log(
        `  ${conflicts.length} local edit(s) still sit on the previous base. Their owner must reapply them onto the current content before staging; staging them as they are would revert upstream work:`,
      );
      for (const plan of conflicts)
        console.log(
          `  conflict ${plan.change.path} (${ageLabel(join(cwd, plan.change.path))}): ${plan.reason}`,
        );
      return 2;
    }
    console.log(
      `  ${branch} is current and every local edit sits on the new base`,
    );
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    releaseLock();
  }
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(
      `shared-checkout-sync: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
