import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  utimesSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";

/**
 * createWorktree branch-collision tolerance: a create attempt killed
 * mid-flight (restart drain) can leave the BRANCH created with no worktree;
 * the retry used to die on `fatal: a branch named '…' already exists`
 * (seen live on a real session). An orphan branch with zero unique
 * commits and no registered worktree is adopted; a branch with real commits
 * still fails loudly.
 *
 * Runs against a scratch repo via the OPENSESSION_CONFIG / OPENSESSION_WORKTREES_DIR
 * seams (config loader caches by path+mtime, env read per call).
 */

const ENV_KEYS = ["OPENSESSION_CONFIG", "OPENSESSION_WORKTREES_DIR"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

let root: string;
let repoDir: string;
let originDir: string;
let emptyRepoDir: string;
let emptyOriginDir: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await $`git -C ${cwd} ${args}`.quiet();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bks-wt-adopt-"));
  originDir = join(root, "origin.git");
  repoDir = join(root, "repo");
  emptyOriginDir = join(root, "empty-origin.git");
  emptyRepoDir = join(root, "empty-repo");
  await $`git init --bare -b main ${originDir}`.quiet();
  await $`git init -b main ${repoDir}`.quiet();
  await git(repoDir, "config", "user.email", "test@test");
  await git(repoDir, "config", "user.name", "test");
  writeFileSync(join(repoDir, "a.txt"), "hello\n");
  await git(repoDir, "add", "a.txt");
  await git(repoDir, "commit", "-m", "init");
  await git(repoDir, "remote", "add", "origin", originDir);
  await git(repoDir, "push", "-u", "origin", "main");
  await $`git init --bare -b main ${emptyOriginDir}`.quiet();
  await $`git init -b main ${emptyRepoDir}`.quiet();
  await git(emptyRepoDir, "remote", "add", "origin", emptyOriginDir);

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
        empty: {
          repo: emptyRepoDir,
          wtPrefix: "empty",
          defaultBranch: "main",
          ghRepo: "test/empty",
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

describe("createWorktree for an empty repository", () => {
  test("initializes a local base and creates the first session worktree", async () => {
    const { createWorktree } = await import("./worktree");
    const wtPath = await createWorktree("build-site", "empty");

    expect(existsSync(join(wtPath, ".git"))).toBe(true);
    expect(
      (await $`git -C ${wtPath} branch --show-current`.text()).trim(),
    ).toBe("build-site");
    expect(
      (await $`git -C ${wtPath} rev-list --count HEAD`.text()).trim(),
    ).toBe("1");
    expect((await $`git -C ${emptyRepoDir} rev-parse main`.text()).trim()).toBe(
      (await $`git -C ${wtPath} rev-parse HEAD`.text()).trim(),
    );
    expect(
      (await $`git -C ${emptyRepoDir} ls-remote --heads origin`.text()).trim(),
    ).toBe("");
  });
});

describe("createWorktree branch-collision adoption", () => {
  test("adopts an orphan branch with zero unique commits", async () => {
    const { createWorktree } = await import("./worktree");
    // Simulate the killed first attempt: branch exists at origin/main, no worktree.
    await git(repoDir, "branch", "orphan-branch", "origin/main");

    const wtPath = await createWorktree("orphan-branch", "scratch");
    expect(existsSync(join(wtPath, ".git"))).toBe(true);
    const head = (
      await $`git -C ${wtPath} branch --show-current`.text()
    ).trim();
    expect(head).toBe("orphan-branch");
  });

  test("still fails loudly when the branch has unique commits", async () => {
    const { createWorktree } = await import("./worktree");
    // A branch with real work on it (one commit past origin/main), no worktree.
    await git(repoDir, "branch", "has-work", "origin/main");
    await git(repoDir, "checkout", "has-work");
    writeFileSync(join(repoDir, "b.txt"), "work\n");
    await git(repoDir, "add", "b.txt");
    await git(repoDir, "commit", "-m", "real work");
    await git(repoDir, "checkout", "main");

    await expect(createWorktree("has-work", "scratch")).rejects.toThrow(
      /already exists/,
    );
    expect(existsSync(join(root, "worktrees", "scratch-has-work"))).toBe(false);
  });

  test("plain create still works (no collision)", async () => {
    const { createWorktree } = await import("./worktree");
    const wtPath = await createWorktree("fresh-branch", "scratch");
    const head = (
      await $`git -C ${wtPath} branch --show-current`.text()
    ).trim();
    expect(head).toBe("fresh-branch");
  });
});

describe("resolveUniqueBranch", () => {
  test("passes through a name with no ref collision", async () => {
    const { resolveUniqueBranch } = await import("./worktree");
    expect(await resolveUniqueBranch("brand-new-name", "scratch")).toBe(
      "brand-new-name",
    );
  });

  test("bumps when the name is a directory of an existing ref", async () => {
    const { resolveUniqueBranch } = await import("./worktree");
    // `git worktree add -b test` can't create refs/heads/test while
    // refs/heads/test/foo exists (the reported failure). Expect a -2 bump.
    await git(repoDir, "branch", "test/foo", "origin/main");
    expect(await resolveUniqueBranch("test", "scratch")).toBe("test-2");
  });

  test("bumps on an exact-name collision, skipping taken suffixes", async () => {
    const { resolveUniqueBranch } = await import("./worktree");
    await git(repoDir, "branch", "dup", "origin/main");
    await git(repoDir, "branch", "dup-2", "origin/main");
    expect(await resolveUniqueBranch("dup", "scratch")).toBe("dup-3");
  });
});

describe("worktree revival", () => {
  test("revives a deleted local branch from its remote branch", async () => {
    const { reviveWorktree } = await import("./worktree");
    await git(repoDir, "checkout", "-b", "remote-revival", "origin/main");
    writeFileSync(join(repoDir, "remote.txt"), "remote work\n");
    await git(repoDir, "add", "remote.txt");
    await git(repoDir, "commit", "-m", "remote work");
    await git(repoDir, "push", "origin", "remote-revival");
    await git(repoDir, "checkout", "main");
    await git(repoDir, "branch", "-D", "remote-revival");

    const wtPath = await reviveWorktree("remote-revival", "scratch");
    expect(existsSync(join(wtPath, "remote.txt"))).toBe(true);
  });

  test("ignores a stale tracking ref when the remote branch is gone", async () => {
    const { reviveWorktree } = await import("./worktree");
    await git(repoDir, "branch", "stale-remote", "origin/main");
    await git(
      repoDir,
      "update-ref",
      "refs/remotes/origin/stale-remote",
      "refs/heads/stale-remote",
    );
    await git(repoDir, "branch", "-D", "stale-remote");

    const wtPath = await reviveWorktree("stale-remote", "scratch");
    expect((await $`git -C ${wtPath} rev-parse HEAD`.text()).trim()).toBe(
      (await $`git -C ${repoDir} rev-parse origin/main`.text()).trim(),
    );
  });

  test("reports the checkout that already owns the branch", async () => {
    const { reviveWorktree } = await import("./worktree");
    const ownerPath = join(root, "worktrees", "scratch-owned-branch-os-review");
    await git(repoDir, "branch", "owned-branch", "origin/main");
    await git(repoDir, "worktree", "add", ownerPath, "owned-branch");

    await expect(reviveWorktree("owned-branch", "scratch")).rejects.toThrow(
      new RegExp(`already checked out at ${ownerPath}`),
    );
    expect(existsSync(join(root, "worktrees", "scratch-owned-branch"))).toBe(
      false,
    );
  });
});

describe("review worktree reuse", () => {
  test("restores its dedicated branch after another session switched it", async () => {
    const { createReviewWorktreeForPrHead } = await import("./worktree");
    await git(repoDir, "checkout", "-b", "review-head", "origin/main");
    await git(repoDir, "push", "origin", "review-head");
    await git(repoDir, "checkout", "main");

    const wtPath = await createReviewWorktreeForPrHead(
      "review-head",
      "scratch",
      "main",
    );
    await git(wtPath, "switch", "-C", "review-head", "origin/review-head");
    writeFileSync(join(wtPath, "a.txt"), "dirty review checkout\n");
    expect(
      (await $`git -C ${wtPath} branch --show-current`.text()).trim(),
    ).toBe("review-head");

    await createReviewWorktreeForPrHead("review-head", "scratch", "main");
    expect(
      (await $`git -C ${wtPath} branch --show-current`.text()).trim(),
    ).toBe("review-head-os-review");
    expect(await Bun.file(join(wtPath, "a.txt")).text()).toBe("hello\n");
  });

  test("recovers an unheld stale index lock before resetting the review checkout", async () => {
    const { createReviewWorktreeForPrHead } = await import("./worktree");
    await git(repoDir, "checkout", "main");
    await git(repoDir, "checkout", "-b", "review-stale-lock", "origin/main");
    await git(repoDir, "push", "origin", "review-stale-lock");
    await git(repoDir, "checkout", "main");

    const wtPath = await createReviewWorktreeForPrHead(
      "review-stale-lock",
      "scratch",
      "main",
    );
    const gitdir = readFileSync(join(wtPath, ".git"), "utf8")
      .replace(/^gitdir:\s*/, "")
      .trim();
    const lockPath = join(gitdir, "index.lock");
    writeFileSync(lockPath, "");
    const staleAt = new Date(Date.now() - 10 * 60_000);
    utimesSync(lockPath, staleAt, staleAt);

    await createReviewWorktreeForPrHead("review-stale-lock", "scratch", "main");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("recreates a half-initialized review checkout left by a killed Git process", async () => {
    const { createReviewWorktreeForPrHead } = await import("./worktree");
    await git(repoDir, "checkout", "main");
    await git(
      repoDir,
      "checkout",
      "-b",
      "review-half-initialized",
      "origin/main",
    );
    await git(repoDir, "push", "origin", "review-half-initialized");
    await git(repoDir, "checkout", "main");

    const wtPath = await createReviewWorktreeForPrHead(
      "review-half-initialized",
      "scratch",
      "main",
    );
    const gitdir = readFileSync(join(wtPath, ".git"), "utf8")
      .replace(/^gitdir:\s*/, "")
      .trim();
    await git(wtPath, "read-tree", "--empty");
    await git(repoDir, "checkout", "review-half-initialized");
    writeFileSync(join(repoDir, "a.txt"), "updated\n");
    await git(repoDir, "add", "a.txt");
    await git(repoDir, "commit", "-m", "update review head");
    await git(repoDir, "push", "origin", "review-half-initialized");
    await git(repoDir, "checkout", "main");
    await git(repoDir, "worktree", "lock", "--reason", "initializing", wtPath);
    const lockPath = join(gitdir, "index.lock");
    writeFileSync(lockPath, "");
    const staleAt = new Date(Date.now() - 10 * 60_000);
    utimesSync(lockPath, staleAt, staleAt);

    await createReviewWorktreeForPrHead(
      "review-half-initialized",
      "scratch",
      "main",
    );

    expect((await $`git -C ${wtPath} status --porcelain`.text()).trim()).toBe(
      "",
    );
    expect(
      (await $`git -C ${wtPath} branch --show-current`.text()).trim(),
    ).toBe("review-half-initialized-os-review");
    expect(await Bun.file(join(wtPath, "a.txt")).text()).toBe("updated\n");
    expect(
      await $`git -C ${repoDir} worktree list --porcelain`.text(),
    ).not.toContain(`worktree ${wtPath}\nlocked`);
  });
});
