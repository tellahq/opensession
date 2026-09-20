import { getConfigAsync } from "./config";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ownedWorktreeHeadBranch,
  catalogWorktreeOwnership,
} from "./session-branch-ownership";

const root = await mkdtemp(join(tmpdir(), "session-branch-ownership-"));
const priorConfig = process.env.OPENSESSION_CONFIG;
const priorWorktrees = process.env.OPENSESSION_WORKTREES_DIR;
const main = join(root, "main");
const worktrees = join(root, "worktrees");
process.env.OPENSESSION_CONFIG = join(root, "config.json");
await getConfigAsync();
delete process.env.OPENSESSION_WORKTREES_DIR;
await writeFile(
  process.env.OPENSESSION_CONFIG,
  JSON.stringify({
    paths: { worktreesDir: worktrees },
    repos: { app: { repo: main } },
  }),
);

async function head(dir: string, ref: string) {
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".git", "HEAD"), ref);
}

afterAll(async () => {
  if (priorConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else {
    process.env.OPENSESSION_CONFIG = priorConfig;
    await getConfigAsync();
  }
  if (priorWorktrees === undefined)
    delete process.env.OPENSESSION_WORKTREES_DIR;
  else process.env.OPENSESSION_WORKTREES_DIR = priorWorktrees;
  await rm(root, { recursive: true, force: true });
});

describe("targeted asynchronous branch ownership refresh", () => {
  test("bulk ownership uses only catalog paths and fails closed for unknown locations", () => {
    const owns = catalogWorktreeOwnership(
      {
        app: {
          id: "app",
          repo: main,
          wtPrefix: "app",
          label: "App",
          defaultBranch: "main",
          ghRepo: "org/app",
        },
      },
      worktrees,
    );
    expect(owns(main)).toBeNull();
    expect(owns(join(worktrees, "app-ask-checkout"))).toBeNull();
    expect(owns("/remote/worktree")).toBeNull();
    expect(owns(join(worktrees, "unknown-feature"))).toBeNull();
    expect(owns(join(worktrees, "app-feature", "nested"))).toBeNull();
    const feature = join(worktrees, "app-feature");
    for (let i = 0; i < 10_000; i++) expect(owns(feature)).toBe(feature);
  });

  test("never adopts shared main/ask HEAD, including a symlink", async () => {
    await head(main, "ref: refs/heads/shared\n");
    const ask = join(worktrees, "app-ask-checkout");
    await head(ask, "ref: refs/heads/ask\n");
    const alias = join(root, "alias");
    await symlink(main, alias);
    expect(await ownedWorktreeHeadBranch(main)).toBeNull();
    expect(await ownedWorktreeHeadBranch(ask)).toBeNull();
    expect(await ownedWorktreeHeadBranch(alias)).toBeNull();
  });

  test("reads one isolated checkout and follows its relative git pointer", async () => {
    const dir = join(worktrees, "app-feature");
    const gitDir = join(main, ".git", "worktrees", "feature");
    await mkdir(gitDir, { recursive: true });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, ".git"),
      "gitdir: ../../main/.git/worktrees/feature\n",
    );
    await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/renamed-by-agent\n");
    expect(await ownedWorktreeHeadBranch(dir)).toBe("renamed-by-agent");
    await writeFile(join(gitDir, "HEAD"), "a".repeat(40) + "\n");
    expect(await ownedWorktreeHeadBranch(dir)).toBeNull();
    expect(await ownedWorktreeHeadBranch(join(root, "missing"))).toBeNull();
    expect(await ownedWorktreeHeadBranch(null)).toBeNull();
  });
});
