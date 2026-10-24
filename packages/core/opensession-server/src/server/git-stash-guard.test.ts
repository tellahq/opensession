import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  GIT_STASH_REFUSAL,
  guardedPath,
  installGitStashGuard,
} from "./git-stash-guard";

let root: string;
let binDir: string;

function run(cwd: string, args: string[], guarded: boolean) {
  const env: Record<string, string> = {
    PATH: guarded ? guardedPath(binDir, process.env.PATH) : process.env.PATH!,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "acme",
    GIT_AUTHOR_EMAIL: "acme@example.test",
    GIT_COMMITTER_NAME: "acme",
    GIT_COMMITTER_EMAIL: "acme@example.test",
  };
  const result = Bun.spawnSync(["git", ...args], { cwd, env });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** One repository with two worktrees, each holding its own uncommitted edit,
 * the shape of two sessions in sibling worktrees. */
function twoWorktrees(name: string) {
  const main = join(root, name, "main");
  const sibling = join(root, name, "sibling");
  Bun.spawnSync(["mkdir", "-p", main]);
  run(main, ["init", "-q", "-b", "main"], false);
  writeFileSync(join(main, "a.txt"), "base\n");
  writeFileSync(join(main, "b.txt"), "base\n");
  run(main, ["add", "."], false);
  run(main, ["commit", "-qm", "base"], false);
  run(main, ["worktree", "add", "-q", "-b", "other", sibling], false);
  writeFileSync(join(main, "a.txt"), "main session work\n");
  writeFileSync(join(sibling, "b.txt"), "sibling session work\n");
  return { main, sibling };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "git-stash-guard-"));
  binDir = await installGitStashGuard(join(root, "bin"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("git stash guard", () => {
  test("without the guard, sibling worktrees swap work through the shared stash", () => {
    const { main, sibling } = twoWorktrees("unguarded");
    expect(run(main, ["stash"], false).code).toBe(0);
    expect(run(sibling, ["stash"], false).code).toBe(0);
    expect(run(main, ["stash", "pop"], false).code).toBe(0);
    expect(run(sibling, ["stash", "pop"], false).code).toBe(0);
    // Each worktree now holds the other's edit, and the stash is empty.
    expect(readFileSync(join(main, "b.txt"), "utf8")).toBe(
      "sibling session work\n",
    );
    expect(readFileSync(join(main, "a.txt"), "utf8")).toBe("base\n");
    expect(readFileSync(join(sibling, "a.txt"), "utf8")).toBe(
      "main session work\n",
    );
    expect(run(main, ["stash", "list"], false).stdout).toBe("");
  });

  test("with the guard, the same sequence is refused and work stays put", () => {
    const { main, sibling } = twoWorktrees("guarded");
    for (const [cwd, args] of [
      [main, ["stash"]],
      [sibling, ["stash"]],
      [main, ["stash", "pop"]],
      [sibling, ["stash", "pop"]],
    ] as const) {
      const result = run(cwd, [...args], true);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(GIT_STASH_REFUSAL);
    }
    expect(readFileSync(join(main, "a.txt"), "utf8")).toBe(
      "main session work\n",
    );
    expect(readFileSync(join(main, "b.txt"), "utf8")).toBe("base\n");
    expect(readFileSync(join(sibling, "b.txt"), "utf8")).toBe(
      "sibling session work\n",
    );
    expect(readFileSync(join(sibling, "a.txt"), "utf8")).toBe("base\n");
  });

  test("refuses every stack-changing form, including global options and aliases", () => {
    const { main } = twoWorktrees("forms");
    run(main, ["config", "alias.st", "stash"], false);
    run(main, ["config", "alias.sp", "stash pop"], false);
    for (const args of [
      ["stash", "push", "-m", "x"],
      ["stash", "-u"],
      ["stash", "save"],
      ["stash", "apply"],
      ["stash", "drop"],
      ["stash", "clear"],
      ["stash", "store", "HEAD"],
      ["stash", "branch", "x"],
      ["-C", main, "stash"],
      ["-c", "color.ui=never", "stash", "pop"],
      ["--no-pager", "stash"],
      ["st"],
      ["sp"],
    ]) {
      const result = run(main, args, true);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr).toContain("git stash is disabled");
    }
    expect(readFileSync(join(main, "a.txt"), "utf8")).toBe(
      "main session work\n",
    );
  });

  test("passes read-only stash commands and other git commands through", () => {
    const { main } = twoWorktrees("passthrough");
    run(main, ["config", "alias.sl", "stash list"], false);
    expect(run(main, ["stash", "list"], true).code).toBe(0);
    expect(run(main, ["sl"], true).code).toBe(0);
    expect(run(main, ["stash", "create"], true).stdout).toMatch(/^[0-9a-f]+/);
    const status = run(main, ["status", "--short"], true);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("a.txt");
    expect(run(main, ["-C", main, "log", "--oneline"], true).stdout).toContain(
      "base",
    );
  });
});
