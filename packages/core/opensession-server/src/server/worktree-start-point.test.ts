import { getConfigAsync } from "./config";
import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";

/**
 * New branches follow origin's default branch, not the registered checkout's
 * stale local copy. Explicit feature bases retain unpushed local work.
 * Runs against real temporary repositories, with no network access.
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
  await getConfigAsync();
  process.env.OPENSESSION_WORKTREES_DIR = join(root, "worktrees");
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

describe("createWorktree start point", () => {
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

    const unstacked = await createWorktree("unstacked-session", "scratch");
    expect(await git(unstacked, "rev-parse", "HEAD")).toBe(remoteHead);
    expect(await git(repoDir, "rev-parse", "main")).not.toBe(remoteHead);
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

  test("default bases ignore a diverged local main without changing the checkout", async () => {
    await commit(repoDir, "local.txt", "local default branch work");
    const localHead = await git(repoDir, "rev-parse", "HEAD");
    const remoteHead = await git(publisherDir, "rev-parse", "main");
    expect(localHead).not.toBe(remoteHead);
    writeFileSync(join(repoDir, "a.txt"), "uncommitted checkout edit\n");
    await git(repoDir, "add", "a.txt");
    writeFileSync(join(repoDir, "untracked.txt"), "untracked checkout edit\n");
    const status = await git(repoDir, "status", "--porcelain");
    const staged = await git(repoDir, "diff", "--cached");
    const existingHead = await git(repoDir, "rev-parse", "stack-base");

    const { createWorktree } = await import("./worktree");
    for (const [branch, base] of [
      ["default-implicit", undefined],
      ["default-explicit", "main"],
    ] as const) {
      const wtPath = await createWorktree(branch, "scratch", { base });
      expect(await git(wtPath, "rev-parse", "HEAD")).toBe(remoteHead);
      expect(await git(repoDir, "rev-parse", "HEAD")).toBe(localHead);
      expect(await git(repoDir, "branch", "--show-current")).toBe("main");
      expect(await git(repoDir, "status", "--porcelain")).toBe(status);
      expect(await git(repoDir, "diff", "--cached")).toBe(staged);
      expect(await git(repoDir, "rev-parse", "stack-base")).toBe(existingHead);
    }
  });
});

test.each([undefined, "main", "feature/stack"])(
  "materialization preserves the requested base %s",
  async (baseBranch) => {
    // Capture the actor boundary; the tests above exercise Git itself.
    const { actorWorktreeMaterializer } = await import("./session-create");
    const intents = await import("./session-kernel/creation-intents");
    const boundary = new Error("branch intent captured");
    const request = spyOn(intents, "requestCreationBranch").mockRejectedValue(
      boundary,
    );
    try {
      const input = {
        sessionId: "os-worktree-base",
        identity: "create-worktree-base",
        project: "scratch",
        branch: "new-session",
        worktreePath: "/worktrees/acme-new-session",
        isolated: true,
        ...(baseBranch ? { baseBranch } : {}),
      };
      await expect(actorWorktreeMaterializer(input)()).rejects.toThrow(
        boundary,
      );
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]![0]).toMatchObject(input);
      expect(request.mock.calls[0]![0].baseBranch).toBe(baseBranch);
    } finally {
      request.mockRestore();
    }
  },
);
