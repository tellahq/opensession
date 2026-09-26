import { getConfigAsync } from "./config";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildBranchNote,
  buildReposNote,
  ghPrView,
  planCreateAttachRepos,
  resolvePrTarget,
  resolveSessionRepoContext,
  resolveWorktreeTarget,
} from "./session-repos";
import type { UnifiedSession } from "./types";
import { getRepo } from "./worktree";

const previousConfig = process.env.OPENSESSION_CONFIG;
let configDir = "";

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), "session-repos-config-"));
  const configPath = join(configDir, "config.json");
  process.env.OPENSESSION_CONFIG = configPath;
  await getConfigAsync();
  writeFileSync(
    configPath,
    JSON.stringify({
      paths: { worktreesDir: join(configDir, "worktrees") },
      repos: {
        opensession: {
          repo: process.cwd(),
          sharedCheckout: true,
          default: true,
        },
        "tella-fusion": { repo: join(configDir, "attached") },
        infra: { repo: join(configDir, "infra") },
        direct: {
          repo: join(configDir, "direct"),
          sharedCheckout: true,
          publicationMode: "direct",
          defaultBranch: "trunk",
        },
        storage: {
          repo: join(configDir, "storage"),
          host: "codestorage",
          publicationMode: "direct",
        },
      },
    }),
  );
  await getConfigAsync();
});

afterAll(async () => {
  if (previousConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else {
    process.env.OPENSESSION_CONFIG = previousConfig;
    await getConfigAsync();
  }
  rmSync(configDir, { recursive: true, force: true });
});

const session = {
  repo: "opensession",
  worktreeDir: "/home/ubuntu/projects/opensession",
  branch: "master",
  attachedRepos: [
    {
      repo: "tella-fusion",
      dir: "/home/ubuntu/worktrees/tella-fusion-task",
      branch: "task",
    },
    {
      repo: "infra",
      dir: "/home/ubuntu/worktrees/infra-task",
      branch: "task",
    },
  ],
};

describe("buildBranchNote", () => {
  const directSession = () => ({
    mode: "code" as const,
    branch: "change",
    worktreeDir: join(configDir, "worktrees/direct-change"),
  });

  test("direct publication keeps worktree isolation and safe default-branch pushes", () => {
    const note = buildBranchNote(directSession());
    expect(note).toContain("## Branch discipline (direct publication)");
    expect(note).toContain("git push origin HEAD:refs/heads/trunk");
    expect(note).toContain("git merge-base --is-ancestor origin/trunk HEAD");
    expect(note).toContain("clean index and worktree");
    expect(note).toContain("rebase-merge, rebase-apply, or MERGE_HEAD");
    expect(note).toContain("rerun all required checks on the final candidate");
    expect(note).toContain("Never force-push or delete the default branch");
    expect(note).toContain("this branch already has an open PR");
    expect(note).toContain("If the user explicitly requests a PR");
    expect(note).toContain("grants no additional credentials or permissions");
    expect(note).not.toContain("git push -u origin change");
  });

  test.each([
    { prUrl: "https://github.com/acme/direct/pull/1" },
    { prNumber: 1 },
    {
      prs: [
        {
          repo: "direct",
          branch: "change",
          source: "primary" as const,
          state: "OPEN" as const,
          number: 1,
        },
      ],
    },
    { stackedOn: { repo: "direct", branch: "base" } },
    { existingBranch: true },
    { pstackMode: true },
    { automation: "nightly" },
    {
      automationDescendantPolicy: {} as NonNullable<
        UnifiedSession["automationDescendantPolicy"]
      >,
    },
  ])(
    "explicit PR contexts and automation do not get direct publication: %j",
    (context) => {
      const note = buildBranchNote({ ...directSession(), ...context });
      expect(note).toContain("This workspace keeps ONE pull request");
      expect(note).not.toContain("HEAD:refs/heads/trunk");
    },
  );

  test("ask and actual main-checkout sessions do not get worktree instructions", () => {
    expect(
      buildBranchNote({ ...directSession(), mode: "ask" }),
    ).toBeUndefined();
    expect(
      buildBranchNote({
        ...directSession(),
        worktreeDir: join(configDir, "direct"),
      }),
    ).toBeUndefined();
  });

  test("code storage keeps its existing publication rules", () => {
    const note = buildBranchNote({
      ...directSession(),
      worktreeDir: join(configDir, "worktrees/storage-change"),
    });
    expect(note).toContain("a pushed branch IS the change request");
    expect(note).not.toContain("HEAD:refs/heads/");
  });

  test("attached repos get their own publication instructions", () => {
    const note = buildReposNote({
      ...directSession(),
      repo: "direct",
      attachedRepos: [
        {
          repo: "infra",
          dir: join(configDir, "worktrees/infra-other"),
          branch: "other",
        },
      ],
    } as UnifiedSession);
    expect(note).toContain("HEAD:refs/heads/trunk");
    expect(note).toContain("git push -u origin other");
    expect(note).toContain("This workspace keeps ONE pull request");
  });

  test("an attached repo's open PR overrides its direct default", () => {
    const note = buildReposNote({
      ...directSession(),
      repo: "infra",
      worktreeDir: join(configDir, "worktrees/infra-change"),
      attachedRepos: [
        {
          repo: "direct",
          dir: join(configDir, "worktrees/direct-other"),
          branch: "other",
        },
      ],
      prs: [
        {
          repo: "direct",
          branch: "other",
          source: "attached",
          number: 2,
          state: "OPEN",
        },
      ],
    } as UnifiedSession);
    expect(note).toContain("git push -u origin other");
    expect(note).not.toContain("HEAD:refs/heads/trunk");
  });

  test("another branch's PR does not change the direct default", () => {
    const note = buildBranchNote({
      ...directSession(),
      prs: [
        {
          repo: "direct",
          branch: "different",
          source: "linked",
          number: 2,
          state: "OPEN",
        },
      ],
    });
    expect(note).toContain("HEAD:refs/heads/trunk");
  });

  test("requires explicit user authorization before merging a PR", () => {
    const note = buildBranchNote({
      mode: "code",
      branch: "ready-after-review",
      worktreeDir: join(configDir, "worktrees/tella-fusion-ready-after-review"),
    });

    expect(note).toContain("git push -u origin ready-after-review");
    expect(note).toContain(
      "Never merge a pull request unless the user explicitly asks",
    );
    expect(note).toContain("in the current conversation");
    expect(note).toContain("that specific pull request");
    expect(note).toContain("A positive review (including 5/5");
    expect(note).not.toContain("you may merge it yourself");
  });

  test("allows a user-requested rebase onto the trunk", () => {
    const note = buildBranchNote({
      mode: "code",
      branch: "tweet-media",
      worktreeDir: join(configDir, "worktrees/tella-fusion-tweet-media"),
    });

    expect(note).toContain(
      "When the user asks to rebase onto the trunk, do it",
    );
    expect(note).toContain("git push --force-with-lease origin tweet-media");
    expect(note).toContain("rebase-merge");
    expect(note).not.toContain("never rebase away");
  });
});

describe("resolveSessionRepoContext", () => {
  test("defaults to the primary repo", () => {
    expect(resolveSessionRepoContext(session)?.repo).toBe("opensession");
  });

  test("selects an attached repo explicitly", () => {
    expect(resolveSessionRepoContext(session, "tella-fusion")).toEqual({
      repo: "tella-fusion",
      dir: "/home/ubuntu/worktrees/tella-fusion-task",
      branch: "task",
      primary: false,
    });
  });

  test("infers exactly one attached worktree from a delegated prompt", () => {
    const resolved = resolveSessionRepoContext(
      session,
      undefined,
      "Review the changes in /home/ubuntu/worktrees/tella-fusion-task and report findings.",
    );
    expect(resolved?.repo).toBe("tella-fusion");
  });

  test("keeps the primary when a prompt is ambiguous", () => {
    const resolved = resolveSessionRepoContext(
      session,
      undefined,
      "Compare /home/ubuntu/worktrees/tella-fusion-task with /home/ubuntu/worktrees/infra-task.",
    );
    expect(resolved?.repo).toBe("opensession");
  });

  test("rejects an explicit repo the parent does not carry", () => {
    expect(resolveSessionRepoContext(session, "gitops")).toBeNull();
  });
});

describe("resolveWorktreeTarget", () => {
  const hostDir = process.cwd();
  const target = {
    repo: "opensession",
    worktreeDir: hostDir,
    attachedRepos: [
      {
        repo: "tella-fusion",
        dir: "/home/ubuntu/worktrees/gone",
        branch: "task",
      },
    ],
  };

  test("resolves the primary worktree by default", () => {
    expect(resolveWorktreeTarget(target)).toEqual({
      repoId: "opensession",
      dir: hostDir,
      primary: true,
      defaultBranch: getRepo("opensession").defaultBranch,
      reachable: true,
    });
  });

  test("resolves an attached repo by id, unreachable when its dir is gone", () => {
    const attached = resolveWorktreeTarget(target, "tella-fusion");
    expect(attached?.dir).toBe("/home/ubuntu/worktrees/gone");
    expect(attached?.primary).toBe(false);
    expect(attached?.reachable).toBe(false);
  });

  test("returns null for a repo the session does not carry", () => {
    expect(resolveWorktreeTarget(target, "gitops")).toBeNull();
  });

  test("counts a volume-mode primary workspace with no host dir as reachable", () => {
    const volume = {
      repo: "opensession",
      worktreeDir: "/workspace/opensession",
      sandbox: { workspace: "volume" },
      attachedRepos: target.attachedRepos,
    };
    expect(resolveWorktreeTarget(volume)?.reachable).toBe(true);
    // The remote exception is the primary repo's only: attached repos are
    // always host worktrees.
    expect(resolveWorktreeTarget(volume, "tella-fusion")?.reachable).toBe(
      false,
    );
  });

  test("returns null for a scratch session with no worktree", () => {
    expect(
      resolveWorktreeTarget({ repo: "opensession", worktreeDir: null }),
    ).toBeNull();
  });

  test("infers the repo id from the worktree path when the session has none", () => {
    const resolved = resolveWorktreeTarget({ worktreeDir: hostDir });
    expect(resolved?.repoId).toBe("opensession");
    expect(resolved?.primary).toBe(true);
  });
});

describe("resolvePrTarget", () => {
  test("uses the projected PR refs when they conflict with legacy fields", () => {
    const modern = {
      repo: "opensession",
      branch: "legacy-primary",
      prNumber: 10,
      prUrl: "https://github.com/tellahq/opensession/pull/10",
      attachedRepos: [
        {
          repo: "tella-fusion",
          dir: "/home/ubuntu/worktrees/tella-fusion-legacy",
          branch: "legacy-attached",
        },
      ],
      prs: [
        {
          repo: "opensession",
          branch: "projected-primary",
          source: "primary",
          number: 20,
        },
        {
          repo: "tella-fusion",
          branch: "projected-attached",
          source: "attached",
          number: 21,
        },
      ],
    } as UnifiedSession;

    expect(resolvePrTarget(modern)?.branch).toBe("projected-primary");
    expect(resolvePrTarget(modern, "tella-fusion")?.branch).toBe(
      "projected-attached",
    );
    expect(
      resolvePrTarget(modern, "tella-fusion", "legacy-attached"),
    ).toBeNull();
  });

  test("projects legacy primary, attached, and linked targets", () => {
    const legacy = {
      repo: "opensession",
      branch: "legacy-primary",
      prNumber: 10,
      prUrl: "https://github.com/tellahq/opensession/pull/10",
      attachedRepos: [
        {
          repo: "tella-fusion",
          dir: "/home/ubuntu/worktrees/tella-fusion-legacy",
          branch: "legacy-attached",
        },
      ],
      linkedPrs: [
        { repo: "opensession", branch: "legacy-follow-up", number: 11 },
      ],
    } as UnifiedSession;

    expect(resolvePrTarget(legacy)?.branch).toBe("legacy-primary");
    expect(resolvePrTarget(legacy, "tella-fusion")?.branch).toBe(
      "legacy-attached",
    );
    expect(
      resolvePrTarget(legacy, "opensession", "legacy-follow-up")?.branch,
    ).toBe("legacy-follow-up");
  });
});

describe("planCreateAttachRepos", () => {
  // A fixture registry rather than the real one: what is registered depends on
  // the instance's config, and this is a rule about repos, not about ours.
  const registry: Record<
    string,
    { id: string; defaultBranch: string; sharedCheckout: boolean }
  > = {
    app: { id: "app", defaultBranch: "main", sharedCheckout: false },
    infra: { id: "infra", defaultBranch: "master", sharedCheckout: false },
    docs: { id: "docs", defaultBranch: "main", sharedCheckout: false },
    itself: { id: "itself", defaultBranch: "main", sharedCheckout: true },
  };
  const lookup = (id: string) => registry[id] ?? null;

  test("keeps pick order, drops duplicates and the session's own repo", () => {
    expect(
      planCreateAttachRepos(
        ["infra", "app", "infra", "docs"],
        "app",
        "multi-repo-task",
        lookup,
      ),
    ).toEqual(["infra", "docs"]);
  });

  test("nothing asked for is not an error", () => {
    expect(planCreateAttachRepos(undefined, "app", "", lookup)).toEqual([]);
    expect(planCreateAttachRepos([], "app", "", lookup)).toEqual([]);
    expect(planCreateAttachRepos(["app"], "app", "", lookup)).toEqual([]);
  });

  test("refuses a repo that has no isolated worktree to attach", () => {
    expect(() =>
      planCreateAttachRepos(["itself"], "app", "multi-repo-task", lookup),
    ).toThrow(/only be a session's own repo/);
  });

  test("refuses an unknown repo", () => {
    expect(() =>
      planCreateAttachRepos(["nope"], "app", "multi-repo-task", lookup),
    ).toThrow(/Unknown repo/);
  });

  test("refuses to check a repo out on its own mainline", () => {
    expect(() =>
      planCreateAttachRepos(["infra"], "app", "master", lookup),
    ).toThrow(/its own mainline/);
    // …and the mainline is per repo, not one shared name.
    expect(planCreateAttachRepos(["docs"], "app", "master", lookup)).toEqual([
      "docs",
    ]);
  });

  test("refuses without a branch to check them out on", () => {
    expect(() => planCreateAttachRepos(["docs"], "app", "", lookup)).toThrow(
      /needs a branch/,
    );
  });
});

describe("ghPrView", () => {
  const stream = (text: string) => new Response(text).body!;
  const fakeGh =
    (stdout: string, stderr: string, code: number, seen: unknown[] = []) =>
    (args: string[], env: Record<string, string>) => {
      seen.push({ args, env });
      return {
        stdout: stream(stdout),
        stderr: stream(stderr),
        exited: Promise.resolve(code),
      };
    };
  const botCredential = async () => ({
    kind: "service" as const,
    principal: "service",
    env: { GH_TOKEN: "minted-for-repo" },
  });

  test("runs gh with the repository's minted bot token", async () => {
    const seen: Array<{ args: string[]; env: Record<string, string> }> = [];
    const result = await ghPrView("acme/app", "7647", {
      credential: botCredential,
      spawn: fakeGh(
        JSON.stringify({
          headRefName: "feature",
          number: 7647,
          url: "https://github.com/acme/app/pull/7647",
          title: "Feature",
        }),
        "",
        0,
        seen,
      ),
    });
    expect(result).toEqual({
      ok: true,
      pr: {
        branch: "feature",
        number: 7647,
        url: "https://github.com/acme/app/pull/7647",
        title: "Feature",
      },
    });
    expect(seen[0].env.GH_TOKEN).toBe("minted-for-repo");
    expect(seen[0].args).toContain("acme/app");
  });

  test("keeps gh's error text instead of collapsing it into not found", async () => {
    const result = await ghPrView("acme/app", "7647", {
      credential: botCredential,
      spawn: fakeGh(
        "",
        "GraphQL: Resource not accessible by personal access token (repository.pullRequest)\n",
        1,
      ),
    });
    expect(result).toEqual({
      ok: false,
      notFound: false,
      reason:
        "GraphQL: Resource not accessible by personal access token (repository.pullRequest)",
    });
  });

  test("tells a missing PR apart from a failure", async () => {
    const result = await ghPrView("acme/app", "no-pr-branch", {
      credential: botCredential,
      spawn: fakeGh("", 'no pull requests found for branch "x"\n', 1),
    });
    expect(result).toMatchObject({ ok: false, notFound: true });
  });

  test("an unavailable bot credential is the reported reason, and gh never runs", async () => {
    const seen: unknown[] = [];
    const result = await ghPrView("acme/app", "1", {
      credential: async () => {
        throw new Error("The selected GitHub bot credential is unavailable");
      },
      spawn: fakeGh("", "", 0, seen),
    });
    expect(result).toEqual({
      ok: false,
      notFound: false,
      reason: "The selected GitHub bot credential is unavailable",
    });
    expect(seen).toEqual([]);
  });
});
