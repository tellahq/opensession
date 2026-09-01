import { describe, expect, test } from "bun:test";
import type { UnifiedSession, Workspace } from "./types";
import { buildWorkspaceRows } from "./sidebar-workspace-rows";

function session(
  id: string,
  overrides: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    source: "opensession",
    branch: null,
    worktreeDir: null,
    startedBy: "Jaap",
    title: id,
    lastActivity: "2026-08-18T12:00:00.000Z",
    createdAt: "2026-08-18T11:00:00.000Z",
    isRunning: false,
    ...overrides,
  };
}

function workspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: id,
    createdBy: "Jaap",
    createdAt: "2026-08-18T10:00:00.000Z",
    ...overrides,
  };
}

function build(
  overrides: Partial<Parameters<typeof buildWorkspaceRows>[0]> = {},
) {
  return buildWorkspaceRows({
    sessions: [],
    workspaces: [],
    openPrs: [],
    nestedSubagentIds: new Set(),
    selectedWorkspaceId: null,
    selectedSessionId: null,
    reads: {},
    canonicalNames: new Map(),
    sort: "updated",
    isClaimed: () => false,
    statusForSession: () => "pending",
    pinnedLaneForSession: () => null,
    prLaneForSessions: () => null,
    mentionForSession: () => undefined,
    ...overrides,
  });
}

describe("buildWorkspaceRows", () => {
  test("groups workspace sessions and keeps tab order by creation time", () => {
    const rows = build({
      sessions: [
        session("second", {
          workspaceId: "workspace-1",
          createdAt: "2026-08-18T12:00:00.000Z",
        }),
        session("first", {
          workspaceId: "workspace-1",
          createdAt: "2026-08-18T11:00:00.000Z",
        }),
      ],
      workspaces: [workspace("workspace-1", { name: "Queue cleanup" })],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe("workspace:workspace-1");
    expect(rows[0]?.name).toBe("Queue cleanup");
    expect(rows[0]?.sessions.map(({ id }) => id)).toEqual(["first", "second"]);
  });

  test("treats a running worker as workspace activity without making a second row", () => {
    const rows = build({
      sessions: [
        session("parent", { workspaceId: "workspace-1" }),
        session("worker", {
          workspaceId: "workspace-1",
          parentSessionId: "parent",
          isRunning: true,
        }),
      ],
      workspaces: [workspace("workspace-1")],
      nestedSubagentIds: new Set(["worker"]),
      selectedWorkspaceId: "workspace-1",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.running).toBe(true);
    expect(rows[0]?.status).toBe("inprogress");
  });

  test("does not create top-level rows for merged or closed subagents", () => {
    const rows = build({
      sessions: [
        session("parent", { workspaceId: "workspace-1" }),
        session("merged-worker", {
          workspaceId: "workspace-merged-worker",
          parentSessionId: "parent",
          prState: "MERGED",
        }),
        session("closed-worker", {
          workspaceId: "workspace-closed-worker",
          parentSessionId: "parent",
          prState: "CLOSED",
        }),
      ],
      workspaces: [workspace("workspace-1")],
      nestedSubagentIds: new Set(["merged-worker", "closed-worker"]),
      selectedWorkspaceId: "workspace-1",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessions.map(({ id }) => id)).toEqual(["parent"]);
  });

  test("badge face and jump target come from the same mentioned member", () => {
    const rows = build({
      sessions: [
        session("hero", { workspaceId: "workspace-1" }),
        session("sibling", {
          workspaceId: "workspace-1",
          createdAt: "2026-08-18T12:30:00.000Z",
        }),
      ],
      workspaces: [workspace("workspace-1")],
      mentionForSession: (id) =>
        id === "sibling" ? { by: "Grant" } : undefined,
    });

    expect(rows[0]?.mention).toBe("Grant");
    expect(rows[0]?.mentionSessionId).toBe("sibling");
  });

  test("the selected session's mention never marks the row", () => {
    const rows = build({
      sessions: [session("hero", { workspaceId: "workspace-1" })],
      workspaces: [workspace("workspace-1")],
      selectedSessionId: "hero",
      mentionForSession: () => ({ by: "Grant" }),
    });

    expect(rows[0]?.mention).toBeUndefined();
    expect(rows[0]?.mentionSessionId).toBeUndefined();
  });

  test("includes drafts and excludes non-sidebar session kinds", () => {
    const rows = build({
      sessions: [
        session("desk", { desk: true }),
        session("automation", { automation: "Hourly check" }),
      ],
      workspaces: [
        workspace("draft", {
          draft: {
            text: "Investigate this",
            updatedAt: "2026-08-18T13:00:00.000Z",
          },
        }),
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "workspace:draft",
      name: "draft",
      sessions: [],
      lastActivity: "2026-08-18T13:00:00.000Z",
    });
  });
});
