import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ENV_KEYS = ["OPENSESSION_CONFIG", "OPENSESSION_WORKTREES_DIR"] as const;
const saved = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;
let root: string;
let repoDir: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await $`git -C ${cwd} ${args}`.quiet();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "workflow-session-worktrees-"));
  const origin = join(root, "origin.git");
  repoDir = join(root, "repo");
  await $`git init --bare -b main ${origin}`.quiet();
  await $`git init -b main ${repoDir}`.quiet();
  await git(repoDir, "config", "user.email", "test@example.test");
  await git(repoDir, "config", "user.name", "Test");
  writeFileSync(join(repoDir, "base.txt"), "main\n");
  await git(repoDir, "add", "base.txt");
  await git(repoDir, "commit", "-m", "initial");
  await git(repoDir, "remote", "add", "origin", origin);
  await git(repoDir, "push", "-u", "origin", "main");
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      repos: {
        renderer: {
          repo: repoDir,
          wtPrefix: "renderer",
          defaultBranch: "main",
          ghRepo: "tellahq/renderer",
          sharedCheckout: true,
        },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = join(root, "config.json");
  process.env.OPENSESSION_WORKTREES_DIR = join(root, "worktrees");
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

describe("workflow child worktrees", () => {
  test("siblings are isolated and a dependent starts at the pushed foundation tip", async () => {
    const { createWorktree } = await import("./worktree");
    const foundation = await createWorktree("compat-layout", "renderer", {
      base: "main",
      isolated: true,
    });
    writeFileSync(join(foundation, "layout.txt"), "protocol\n");
    await git(foundation, "add", "layout.txt");
    await git(foundation, "commit", "-m", "layout protocol");
    await git(foundation, "push", "-u", "origin", "compat-layout");

    const sibling = await createWorktree("compat-sibling", "renderer", {
      base: "main",
      isolated: true,
    });
    writeFileSync(join(foundation, "private-wip.txt"), "foundation only\n");
    expect(sibling).not.toBe(foundation);
    expect(existsSync(join(sibling, "private-wip.txt"))).toBe(false);

    const dependent = await createWorktree("compat-text", "renderer", {
      base: "compat-layout",
      isolated: true,
    });
    expect(dependent).not.toBe(foundation);
    expect(readFileSync(join(dependent, "layout.txt"), "utf8")).toBe(
      "protocol\n",
    );
    const foundationHead = (
      await $`git -C ${foundation} rev-parse HEAD`.text()
    ).trim();
    const dependentBase = (
      await $`git -C ${dependent} merge-base HEAD compat-layout`.text()
    ).trim();
    expect(dependentBase).toBe(foundationHead);
  });
});
