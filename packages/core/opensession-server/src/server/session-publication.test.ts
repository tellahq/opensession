import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  publicationBundleProvider,
  publishSessionBranch,
} from "./session-publication";
import type { UnifiedSession } from "./types";

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0)
    throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function descendant(branch = "compat/layout"): UnifiedSession {
  return {
    id: "os-child",
    title: "Compatibility renderer",
    branch,
    worktreeDir: "/child-controlled/worktree",
    automationDescendantPolicy: {
      automationId: "renderer",
      automationName: "Renderer",
      mcpServers: [],
      repo: "renderer",
      publicationRepo: "tellahq/renderer",
      baseBranch: "main",
      allowedRunners: [],
      publication: "branch-pr-only",
    },
  } as unknown as UnifiedSession;
}

function harness(
  responses: Response[] = [
    Response.json({ html_url: "https://github.com/tellahq/renderer/pull/12" }),
  ],
) {
  const calls: Array<{
    cwd: string;
    args: string[];
    env: Record<string, string>;
  }> = [];
  let exported = 0;
  let tokens = 0;
  const root = mkdtempSync(join(tmpdir(), "publication-test-"));
  return {
    calls,
    get exported() {
      return exported;
    },
    get tokens() {
      return tokens;
    },
    deps: {
      findSession: async () => descendant(),
      exportBundle: async () => {
        exported++;
        expect(tokens).toBe(0);
        return Buffer.from("credential-free-bundle");
      },
      repositoryToken: async () => {
        tokens++;
        return "repository-scoped-token";
      },
      baseCommit: async (repo: string, branch: string, token: string) => {
        expect({ repo, branch, token }).toEqual({
          repo: "tellahq/renderer",
          branch: "main",
          token: "repository-scoped-token",
        });
        return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      },
      runGit: async (
        cwd: string,
        args: string[],
        env: Record<string, string>,
      ) => {
        calls.push({ cwd, args, env });
        return {
          exitCode: 0,
          stdout: args.includes("list-heads")
            ? "0123456789012345678901234567890123456789 refs/heads/compat/layout\n"
            : "",
          stderr: "",
        };
      },
      request: async () =>
        responses.shift() || new Response("missing", { status: 500 }),
      receiptPath: (_sessionId: string, requestId: string) =>
        join(root, `${requestId}.json`),
    },
  };
}

describe("scoped session publication", () => {
  test("routes Runner workspaces remotely and fails closed for unavailable providers", () => {
    expect(
      publicationBundleProvider({
        ...descendant(),
        runner: {
          id: "runner-1",
          name: "Runner",
          workspacePath: "/remote/work",
        },
      }),
    ).toBe("runner");
    expect(publicationBundleProvider(descendant())).toBe("unavailable");
    const local = descendant();
    local.worktreeDir = mkdtempSync(join(tmpdir(), "publication-local-"));
    expect(publicationBundleProvider(local)).toBe("local");
    expect(
      publicationBundleProvider({
        ...local,
        sandbox: {
          provider: "daytona",
          sandboxId: "remote-child",
          lifecycle: "awake",
        },
      }),
    ).toBe("unavailable");
  });

  test("imports credential-free objects and pushes only from a clean server repo", async () => {
    const h = harness();
    const result = await publishSessionBranch("os-child", "request-1", h.deps);
    expect(h.exported).toBe(1);
    const push = h.calls.find((call) => call.args[0] === "push")!;
    expect(push.cwd).not.toBe("/child-controlled/worktree");
    expect(push.args).toEqual([
      "push",
      "https://github.com/tellahq/renderer.git",
      "refs/heads/compat/layout:refs/heads/compat/layout",
    ]);
    expect(push.env.GIT_CONFIG_VALUE_2).toContain("Authorization: Basic");
    for (const call of h.calls.filter((call) => call !== push))
      expect(JSON.stringify(call)).not.toContain("repository-scoped-token");
    expect(result).toEqual({
      repo: "tellahq/renderer",
      branch: "compat/layout",
      baseBranch: "main",
      prUrl: "https://github.com/tellahq/renderer/pull/12",
    });
  });

  test("local export refuses dirty work and a checkout on the wrong branch", async () => {
    const repo = mkdtempSync(join(tmpdir(), "publication-real-repo-"));
    git(repo, "init", "-b", "compat/layout");
    git(repo, "config", "user.email", "test@opensession.invalid");
    git(repo, "config", "user.name", "Open Session test");
    writeFileSync(join(repo, "tracked.txt"), "base\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-m", "base");
    const session = { ...descendant(), worktreeDir: repo };
    let tokens = 0;
    const deps = {
      findSession: async () => session,
      repositoryToken: async () => {
        tokens++;
        return null;
      },
      receiptPath: (_sessionId: string, requestId: string) =>
        join(repo, `${requestId}.json`),
    };

    writeFileSync(join(repo, "tracked.txt"), "dirty\n");
    await expect(
      publishSessionBranch("os-child", "dirty", deps),
    ).rejects.toThrow(/uncommitted changes/);
    expect(tokens).toBe(0);
    git(repo, "restore", "tracked.txt");
    git(repo, "switch", "-c", "other");
    await expect(
      publishSessionBranch("os-child", "wrong-branch", deps),
    ).rejects.toThrow(/not on its owned branch/);
    expect(tokens).toBe(0);
  });

  test("stable request receipt replays without a second export or publication", async () => {
    const h = harness();
    const first = await publishSessionBranch("os-child", "stable", h.deps);
    const second = await publishSessionBranch("os-child", "stable", h.deps);
    expect(second).toEqual(first);
    expect(h.exported).toBe(1);
    expect(h.calls.filter((call) => call.args[0] === "push")).toHaveLength(1);
  });

  test("422 succeeds only for the exact existing owned PR", async () => {
    const exact = harness([
      new Response("invalid", { status: 422 }),
      Response.json([
        {
          html_url: "https://github.com/tellahq/renderer/pull/9",
          head: {
            ref: "compat/layout",
            repo: { full_name: "tellahq/renderer" },
          },
          base: { ref: "main" },
        },
      ]),
    ]);
    expect(
      (await publishSessionBranch("os-child", "exact", exact.deps)).prUrl,
    ).toEndWith("/9");

    const invalid = harness([
      new Response("invalid", { status: 422 }),
      Response.json([
        {
          html_url: "https://github.com/other/repo/pull/1",
          head: { ref: "compat/layout", repo: { full_name: "other/repo" } },
          base: { ref: "main" },
        },
      ]),
    ]);
    await expect(
      publishSessionBranch("os-child", "invalid", invalid.deps),
    ).rejects.toThrow(/failed \(422\)/);
  });

  test("base branch and external sessions fail before bundle export or credentials", async () => {
    const h = harness();
    await expect(
      publishSessionBranch("os-child", "base", {
        ...h.deps,
        findSession: async () => descendant("main"),
      }),
    ).rejects.toThrow(/protected base/);
    expect(h.exported).toBe(0);
    expect(h.tokens).toBe(0);

    await expect(
      publishSessionBranch("os-child", "external", {
        ...h.deps,
        findSession: async () =>
          ({ id: "os-child", branch: "other" }) as UnifiedSession,
      }),
    ).rejects.toThrow(/automation descendant/);
  });

  test("refuses a branch outside the protected base ancestry before push", async () => {
    const h = harness();
    await expect(
      publishSessionBranch("os-child", "unrelated", {
        ...h.deps,
        runGit: async (cwd, args, env) => {
          const result = await h.deps.runGit(cwd, args, env);
          return args[0] === "merge-base" ? { ...result, exitCode: 1 } : result;
        },
      }),
    ).rejects.toThrow(/not descended from the protected base/);
    expect(h.exported).toBe(1);
    expect(h.tokens).toBe(1);
    expect(h.calls.some((call) => call.args[0] === "push")).toBe(false);
  });
});
