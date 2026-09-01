import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildBranchNote,
  planCreateAttachRepos,
  resolvePrTarget,
  resolveSessionRepoContext,
  resolveWorktreeTarget,
} from "./session-repos";
import type { UnifiedSession } from "./types";
import { getRepo } from "./worktree";

const previousConfig = process.env.OPENSESSION_CONFIG;
let configDir = "";

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "session-repos-config-"));
  const configPath = join(configDir, "config.json");
  process.env.OPENSESSION_CONFIG = configPath;
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
      },
    }),
  );
});

afterAll(() => {
  if (previousConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = previousConfig;
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
  test("allows an ordinary PR to merge only after the current review and checks pass", () => {
    const note = buildBranchNote({
      mode: "code",
      branch: "ready-after-review",
      worktreeDir: join(configDir, "worktrees/tella-fusion-ready-after-review"),
    });

    expect(note).toContain("git push -u origin ready-after-review");
    expect(note).toContain("you may merge it yourself");
    expect(note).toContain(
      "latest Open Session review covers the current head",
    );
    expect(note).toContain("reports no blocking findings");
    expect(note).toContain("all required checks have passed");
    expect(note).toContain("Do not merge while the review is stale");
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
