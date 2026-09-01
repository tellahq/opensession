import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getGitStatus,
  gitFailureMessage,
  gitPull,
  gitPush,
  porcelainPaths,
} from "./git-status";
import type { WorkspaceExec } from "./sandbox/workspace-exec";

const roots: string[] = [];

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await $`git -C ${dir} ${args}`.quiet().text()).trim();
}

async function makeRepo(): Promise<{ repo: string; origin: string }> {
  const root = mkdtempSync(join(tmpdir(), "opensession-git-status-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");

  await $`git init --bare -b main ${origin}`.quiet();
  await $`git init -b main ${repo}`.quiet();
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test User");
  writeFileSync(join(repo, "shared.txt"), "initial\n");
  await git(repo, "add", "shared.txt");
  await git(repo, "commit", "-m", "Initial commit");
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "-u", "origin", "main");
  await git(repo, "checkout", "-b", "feature");
  return { repo, origin };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("getGitStatus", () => {
  test("uses a published branch even when a plain push did not configure tracking", async () => {
    const { repo } = await makeRepo();
    writeFileSync(join(repo, "feature.txt"), "feature\n");
    await git(repo, "add", "feature.txt");
    await git(repo, "commit", "-m", "Feature change");
    await git(repo, "push", "origin", "feature");

    expect(
      await git(repo, "config", "--get", "branch.feature.remote").catch(
        () => "",
      ),
    ).toBe("");
    expect(await getGitStatus(repo, "main")).toMatchObject({
      branch: "feature",
      hasUpstream: true,
      ahead: 0,
      behind: 0,
    });

    writeFileSync(join(repo, "feature.txt"), "feature two\n");
    await git(repo, "add", "feature.txt");
    await git(repo, "commit", "-m", "Follow-up");
    expect(await getGitStatus(repo, "main")).toMatchObject({
      hasUpstream: true,
      ahead: 1,
      behind: 0,
    });
  });
});

describe("gitPull from base", () => {
  test("merges base changes into a published feature branch without requiring force-push", async () => {
    const { repo } = await makeRepo();
    writeFileSync(join(repo, "feature.txt"), "feature\n");
    await git(repo, "add", "feature.txt");
    await git(repo, "commit", "-m", "Feature change");
    await git(repo, "push", "-u", "origin", "feature");

    await git(repo, "checkout", "main");
    writeFileSync(join(repo, "base.txt"), "base\n");
    await git(repo, "add", "base.txt");
    await git(repo, "commit", "-m", "Base change");
    await git(repo, "push", "origin", "main");
    await git(repo, "checkout", "feature");

    expect(await gitPull(repo, "main")).toEqual({ ok: true });
    expect(await git(repo, "rev-list", "--count", "HEAD..origin/main")).toBe(
      "0",
    );
    expect(await git(repo, "status", "--porcelain")).toBe("");

    await git(repo, "push", "origin", "feature");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(
      await git(repo, "rev-parse", "origin/feature"),
    );
  });

  test("aborts a conflicting merge and restores the clean feature branch", async () => {
    const { repo } = await makeRepo();
    writeFileSync(join(repo, "shared.txt"), "feature\n");
    await git(repo, "add", "shared.txt");
    await git(repo, "commit", "-m", "Feature edit");
    await git(repo, "push", "-u", "origin", "feature");

    await git(repo, "checkout", "main");
    writeFileSync(join(repo, "shared.txt"), "base\n");
    await git(repo, "add", "shared.txt");
    await git(repo, "commit", "-m", "Base edit");
    await git(repo, "push", "origin", "main");
    await git(repo, "checkout", "feature");
    const before = await git(repo, "rev-parse", "HEAD");

    const result = await gitPull(repo, "main");
    expect(result).toHaveProperty("error");
    expect("error" in result ? result.error : "").toContain(
      "conflicts with main",
    );
    expect(await git(repo, "rev-parse", "HEAD")).toBe(before);
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  });

  test("rejects a dirty worktree without changing it", async () => {
    const { repo } = await makeRepo();
    writeFileSync(join(repo, "shared.txt"), "uncommitted\n");
    const before = await git(repo, "rev-parse", "HEAD");

    expect(await gitPull(repo, "main")).toEqual({
      error: "Commit or discard the uncommitted changes before updating.",
    });
    expect(await git(repo, "rev-parse", "HEAD")).toBe(before);
    expect(await git(repo, "status", "--porcelain")).toContain("shared.txt");
  });
});

describe("gitFailureMessage", () => {
  test("shows Git's final diagnostic instead of fetch progress", () => {
    expect(
      gitFailureMessage(
        "From github.com:tellahq/opensession\n   abc..def  main -> origin/main\nfatal: Not possible to fast-forward, aborting.\n",
        "Git pull failed",
      ),
    ).toBe("Not possible to fast-forward, aborting.");
  });

  test("keeps a useful final line and falls back for empty output", () => {
    expect(
      gitFailureMessage("remote: Permission denied\n", "Git push failed"),
    ).toBe("remote: Permission denied");
    expect(gitFailureMessage("", "Git push failed")).toBe("Git push failed");
  });
});

describe("porcelainPaths", () => {
  test("reads the path past both status columns, staged or not", () => {
    expect(porcelainPaths("M  src/a.ts\n?? src/b.ts\n M src/c.ts")).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });

  test("takes a rename's new path — the old one is gone from disk", () => {
    expect(porcelainPaths("R  src/old.ts -> src/new.ts")).toEqual([
      "src/new.ts",
    ]);
  });

  test("unquotes a path git had to escape", () => {
    expect(porcelainPaths('?? "src/a b\\u00e9.ts"')).toEqual(["src/a bé.ts"]);
  });

  test("ignores blank and truncated lines", () => {
    expect(porcelainPaths("\n\nM  src/a.ts\nM\n")).toEqual(["src/a.ts"]);
  });
});

describe("scoped Git credentials", () => {
  test("passes a credential only to the explicit server-owned operation", async () => {
    const envs: Array<Record<string, string> | undefined> = [];
    const exec = Object.assign(
      async (_cmd: string[], opts?: { env?: Record<string, string> }) => {
        envs.push(opts?.env);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      { sandboxed: false, remote: false },
    ) as WorkspaceExec;

    expect(
      await gitPush("/repo", "feature", exec, { GH_TOKEN: "scoped" }),
    ).toEqual({ ok: true });
    expect(envs).toEqual([{ GH_TOKEN: "scoped" }]);
  });

  test("does not send host credentials to a Runner executor", async () => {
    const envs: Array<Record<string, string> | undefined> = [];
    const exec = Object.assign(
      async (_cmd: string[], opts?: { env?: Record<string, string> }) => {
        envs.push(opts?.env);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      { sandboxed: false, remote: true },
    ) as WorkspaceExec;

    expect(
      await gitPush("/runner/repo", "feature", exec, { GH_TOKEN: "host-only" }),
    ).toEqual({ ok: true });
    expect(envs).toEqual([undefined]);
  });

  test("uses the in-container helper for local Docker pull and push", async () => {
    const envs: Array<Record<string, string> | undefined> = [];
    const exec = Object.assign(
      async (_cmd: string[], opts?: { env?: Record<string, string> }) => {
        envs.push(opts?.env);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      { sandboxed: true, remote: false },
    ) as WorkspaceExec;
    const hostEnv = {
      GH_TOKEN: "scoped",
      GITHUB_TOKEN: "scoped",
      GIT_CONFIG_VALUE_1:
        "!/home/user/.opensession/bin/opensession github-credential",
    };

    expect(await gitPull("/repo", undefined, exec, hostEnv)).toEqual({
      ok: true,
    });
    expect(await gitPush("/repo", "feature", exec, hostEnv)).toEqual({
      ok: true,
    });
    expect(envs).toHaveLength(2);
    for (const env of envs) {
      expect(env).toMatchObject({
        GH_TOKEN: "scoped",
        GITHUB_TOKEN: "scoped",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_VALUE_1: "!gh auth git-credential",
      });
      expect(JSON.stringify(env)).not.toContain("/home/user");
    }
  });
});
