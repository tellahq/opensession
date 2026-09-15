import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";

/**
 * Where a session's branch starts when the caller names a base. Every session
 * passes its repository's default branch, and the repository's local copy of
 * that branch is not canonical: the shared tella-fusion checkout sat on a
 * feature branch for three days while its local `main` stood still, and every
 * new session started 50 commits behind the `origin/main` that had just been
 * fetched. A stacked worktree off a session branch with unpushed commits must
 * still start from the local branch.
 *
 * Runs against a scratch repo via OPENSESSION_CONFIG / OPENSESSION_WORKTREES_DIR.
 */

const ENV_KEYS = ["OPENSESSION_CONFIG", "OPENSESSION_WORKTREES_DIR"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

let root: string;
let originDir: string;
let repoDir: string;
let publisherDir: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await $`git -C ${cwd} ${args}`.quiet().text()).trim();
}

async function commit(cwd: string, file: string, message: string) {
  writeFileSync(join(cwd, file), `${message}\n`);
  await git(cwd, "add", file);
  await git(cwd, "commit", "-q", "-m", message);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bks-wt-start-"));
  originDir = join(root, "origin.git");
  repoDir = join(root, "repo");
  publisherDir = join(root, "publisher");
  await $`git init --bare -b main ${originDir}`.quiet();
  for (const dir of [repoDir, publisherDir]) {
    await $`git init -b main ${dir}`.quiet();
    await git(dir, "config", "user.email", "test@test");
    await git(dir, "config", "user.name", "test");
    await git(dir, "remote", "add", "origin", originDir);
  }
  await commit(repoDir, "a.txt", "init");
  await git(repoDir, "push", "-q", "-u", "origin", "main");
  await git(publisherDir, "pull", "-q", "origin", "main");

  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      repos: {
        scratch: {
          repo: repoDir,
          wtPrefix: "scratch",
          defaultBranch: "main",
          ghRepo: "test/scratch",
        },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = join(root, "config.json");
  process.env.OPENSESSION_WORKTREES_DIR = join(root, "worktrees");
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

describe("createWorktree start point for a named base", () => {
  test("a stale local default branch loses to origin/<default>", async () => {
    // Somebody else lands a commit; this checkout's local main never moves.
    await commit(publisherDir, "b.txt", "landed elsewhere");
    await git(publisherDir, "push", "-q", "origin", "main");
    const remoteHead = await git(publisherDir, "rev-parse", "HEAD");
    expect(await git(repoDir, "rev-parse", "main")).not.toBe(remoteHead);

    const { createWorktree } = await import("./worktree");
    const wtPath = await createWorktree("fresh-session", "scratch", {
      base: "main",
    });

    expect(await git(wtPath, "rev-parse", "HEAD")).toBe(remoteHead);
    expect(await git(wtPath, "branch", "--show-current")).toBe("fresh-session");
  });

  test("a local base with unpushed commits still wins", async () => {
    await git(repoDir, "branch", "stack-base", "origin/main");
    await git(repoDir, "checkout", "-q", "stack-base");
    await commit(repoDir, "c.txt", "unpushed work");
    await git(repoDir, "checkout", "-q", "main");
    // origin knows an older stack-base.
    await git(
      repoDir,
      "push",
      "-q",
      "origin",
      "stack-base~1:refs/heads/stack-base",
    );
    const localHead = await git(repoDir, "rev-parse", "stack-base");

    const { createWorktree } = await import("./worktree");
    const wtPath = await createWorktree("stacked", "scratch", {
      base: "stack-base",
    });

    expect(await git(wtPath, "rev-parse", "HEAD")).toBe(localHead);
  });

  test("a stray local branch named origin/<default> does not break creation", async () => {
    // `git fetch origin main:origin/main` creates refs/heads/origin/main. A
    // bare `origin/main` is then ambiguous: rev-parse silently answers with
    // the local branch and `worktree add -b` refuses outright. That one typo
    // took every new session and automation on the shared checkout down.
    await commit(publisherDir, "e.txt", "landed after the stray branch");
    await git(publisherDir, "push", "-q", "origin", "main");
    const remoteHead = await git(publisherDir, "rev-parse", "HEAD");
    await git(repoDir, "fetch", "-q", "origin", "main");
    await git(repoDir, "branch", "origin/main", "main");
    expect(await git(repoDir, "rev-parse", "refs/heads/origin/main")).not.toBe(
      remoteHead,
    );

    try {
      const { createWorktree } = await import("./worktree");
      const fromDefault = await createWorktree("after-stray", "scratch");
      expect(await git(fromDefault, "rev-parse", "HEAD")).toBe(remoteHead);
      const fromBase = await createWorktree("after-stray-base", "scratch", {
        base: "main",
      });
      expect(await git(fromBase, "rev-parse", "HEAD")).toBe(remoteHead);
    } finally {
      await git(repoDir, "branch", "-D", "origin/main");
    }
  });

  test("a remote-only base starts from origin/<base>", async () => {
    await git(publisherDir, "checkout", "-q", "-b", "remote-only");
    await commit(publisherDir, "d.txt", "remote only");
    await git(publisherDir, "push", "-q", "origin", "remote-only");
    const remoteHead = await git(publisherDir, "rev-parse", "HEAD");

    const { createWorktree } = await import("./worktree");
    const wtPath = await createWorktree("on-remote-only", "scratch", {
      base: "remote-only",
    });

    expect(await git(wtPath, "rev-parse", "HEAD")).toBe(remoteHead);
  });
});
