import { describe, expect, test } from "bun:test";
import {
  createSpace,
  isSpaceCoordinator,
  SpaceInputError,
  spaceCoordinatorNote,
} from "./spaces";
import type { CreateSessionOpts } from "./session-control";
import type { createWorkspace, Workspace } from "./workspaces";

type WorkspaceInput = Parameters<typeof createWorkspace>[0];

function fakeDeps() {
  const workspaces: WorkspaceInput[] = [];
  const sessions: CreateSessionOpts[] = [];
  const shared: string[] = [];
  return {
    shared,
    workspaces,
    sessions,
    deps: {
      createWorkspace: async (input: WorkspaceInput) => {
        workspaces.push(input);
        return {
          id: "ws-space",
          name: input.name,
          repo: input.repo,
          createdBy: input.createdBy,
          createdAt: "2026-11-07T00:00:00.000Z",
          ...(input.space ? { space: true as const } : {}),
        } satisfies Workspace;
      },
      share: async (_workspaceId: string, name: string) => {
        shared.push(name);
        return null;
      },
      createSession: async (opts: CreateSessionOpts) => {
        sessions.push(opts);
        return {
          id: "bks-coordinator",
          createdBy: opts.user || "Anonymous",
          createdAt: "2026-11-07T00:00:00.000Z",
        };
      },
    },
  };
}

describe("isSpaceCoordinator", () => {
  test("a root session in a space coordinates it", () => {
    expect(isSpaceCoordinator({}, { space: true })).toBe(true);
  });

  test("a thread in a space does not", () => {
    expect(
      isSpaceCoordinator({ parentSessionId: "bks-root" }, { space: true }),
    ).toBe(false);
  });

  test("a root session in an ordinary workspace does not", () => {
    expect(isSpaceCoordinator({}, {})).toBe(false);
    expect(isSpaceCoordinator({}, null)).toBe(false);
  });
});

describe("spaceCoordinatorNote", () => {
  test("names the space and its project and asks for delegation", () => {
    const note = spaceCoordinatorNote({ name: "Launch", repo: "acme" });
    expect(note).toContain('the space "Launch"');
    expect(note).toContain("`acme`");
    expect(note).toContain("spawn_task");
    expect(note).toContain("isolatedWorktree true");
    expect(note).toContain("space-summary.md");
  });

  test("points threads at the goal when there is one", () => {
    expect(
      spaceCoordinatorNote({ name: "Ops", goal: "Cut p95 latency" }),
    ).toContain("The space's goal: Cut p95 latency");
    expect(spaceCoordinatorNote({ name: "Ops" })).not.toContain("goal:");
  });

  test("tells a project-less space to pick a repo per thread", () => {
    expect(spaceCoordinatorNote({ name: "Ops" })).toContain(
      "It has no project",
    );
  });
});

describe("createSpace", () => {
  test("creates a space workspace and a Scratch coordinator inside it", async () => {
    const { deps, workspaces, sessions } = fakeDeps();
    const result = await createSpace(
      {
        title: "  Spaces v1 ",
        repo: "acme",
        prompt: " Ship spaces ",
        user: "Ada",
        createdByLogin: "ada",
      },
      deps,
    );
    expect(result).toMatchObject({
      sessionId: "bks-coordinator",
      workspace: { id: "ws-space", space: true },
    });
    expect(workspaces).toEqual([
      { name: "Spaces v1", repo: "acme", createdBy: "Ada", space: true },
    ]);
    expect(sessions).toEqual([
      {
        prompt: "Ship spaces",
        mode: "scratch",
        repo: "acme",
        workspaceId: "ws-space",
        user: "Ada",
        createdByLogin: "ada",
      },
    ]);
  });

  test("a space without a project starts a Scratch coordinator with no repo", async () => {
    const { deps, sessions } = fakeDeps();
    await createSpace({ title: "Ops", prompt: "Watch", user: "Ada" }, deps);
    expect(sessions[0]).toMatchObject({ mode: "scratch" });
    expect(sessions[0]?.repo).toBeUndefined();
  });

  test("rejects a missing title before creating anything", async () => {
    const { deps, workspaces } = fakeDeps();
    await expect(
      createSpace({ title: " ", prompt: "x", user: "Ada" }, deps),
    ).rejects.toBeInstanceOf(SpaceInputError);
    expect(workspaces).toEqual([]);
  });

  test("without a first message the agent opens with a model-only welcome", async () => {
    const { deps, sessions } = fakeDeps();
    await createSpace({ title: "Ops", prompt: " ", user: "Ada" }, deps);
    expect(sessions[0]?.prompt).toBe("");
    expect(sessions[0]?.openingContext?.source).toBe("space-coordinator");
    expect(sessions[0]?.openingContext?.text).toContain(
      "Ada just created this space",
    );
  });

  test("stores the goal and shares with each teammate once", async () => {
    const { deps, workspaces, shared } = fakeDeps();
    await createSpace(
      {
        title: "Ops",
        prompt: "Go",
        goal: " Ship checkout v2 ",
        sharedWith: ["Grace", "Grace", "Linus"],
        user: "Ada",
      },
      deps,
    );
    expect(workspaces[0]?.goal).toBe("Ship checkout v2");
    expect(shared).toEqual(["Grace", "Linus"]);
  });
});
