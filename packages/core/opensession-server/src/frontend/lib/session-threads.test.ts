import { describe, expect, test } from "bun:test";
import {
  coordinatedPrs,
  groupThreads,
  isCoordinating,
  sessionThreads,
  spawnedThreadId,
  startedGoalId,
  startedSessions,
  startedGoalName,
  threadState,
  threadStatusLine,
} from "./session-threads";
import type { UnifiedSession } from "./types";

function session(
  id: string,
  overrides: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    source: "opensession",
    branch: null,
    worktreeDir: null,
    startedBy: "Ada",
    title: id,
    lastActivity: "2026-11-07T10:00:00Z",
    createdAt: "2026-11-07T09:00:00Z",
    isRunning: false,
    workspaceId: "ws-space",
    parentSessionId: "bks-root",
    ...overrides,
  };
}

describe("session threads", () => {
  test("are what the session started, and theirs in turn, newest first", () => {
    const threads = sessionThreads(
      [
        session("bks-root", { parentSessionId: undefined }),
        session("old", { createdAt: "2026-11-07T08:00:00Z" }),
        session("new", { createdAt: "2026-11-07T09:30:00Z" }),
        session("grandchild", {
          parentSessionId: "old",
          createdAt: "2026-11-07T08:30:00Z",
        }),
        session("elsewhere", { parentSessionId: "bks-other" }),
      ],
      "bks-root",
    );
    expect(threads.map((thread) => thread.id)).toEqual([
      "new",
      "grandchild",
      "old",
    ]);
  });

  test("a session's own coordinator setting wins", () => {
    expect(isCoordinating({ coordinator: true }, null)).toBe(true);
    const legacy = { id: "ws-space", space: true as const };
    expect(
      isCoordinating({ coordinator: false, workspaceId: "ws-space" }, legacy),
    ).toBe(false);
  });

  test("a legacy space's root session coordinates, its threads do not", () => {
    const legacy = { id: "ws-space", space: true as const };
    expect(isCoordinating({ workspaceId: "ws-space" }, legacy)).toBe(true);
    expect(
      isCoordinating(
        { workspaceId: "ws-space", parentSessionId: "bks-root" },
        legacy,
      ),
    ).toBe(false);
    expect(
      isCoordinating({ workspaceId: "ws-space" }, { id: "ws-space" }),
    ).toBe(false);
  });
});

describe("threadState", () => {
  test("merged work is shipped even while something else is true", () => {
    expect(
      threadState(session("a", { prState: "MERGED", isRunning: true })),
    ).toBe("shipped");
  });

  test("a question waiting on a person blocks the thread", () => {
    expect(threadState(session("a", { waitingForInput: true }))).toBe(
      "blocked",
    );
  });

  test("an open, non-draft PR is ready to ship", () => {
    const ready = session("a", {
      prState: "OPEN",
      prNumber: 12,
      prChecks: { total: 3, passed: 3, failed: 0, pending: 0 },
    });
    expect(threadState(ready)).toBe("ready");
    expect(threadStatusLine(ready)).toBe("#12 checks passing");
    expect(
      threadState(session("b", { prState: "OPEN", prIsDraft: true })),
    ).toBe("idle");
  });

  test("groups follow the panel order and skip empty states", () => {
    const groups = groupThreads([
      session("idle"),
      session("busy", { isRunning: true }),
      session("stuck", { waitingForInput: true }),
    ]);
    expect(groups.map((group) => group.state)).toEqual([
      "blocked",
      "working",
      "idle",
    ]);
  });
});

describe("spawnedThreadId", () => {
  test("reads the child id from spawn_task and create_session results", () => {
    expect(
      spawnedThreadId(
        "mcp__opensession-sessions__spawn_task",
        {},
        "Spawned task `bks-123` — https://example.test/session/bks-123",
      ),
    ).toBe("bks-123");
    expect(
      spawnedThreadId(
        "opensession-sessions_create_session",
        {},
        "Started session `bks-456` (ask). Metadata: …",
      ),
    ).toBe("bks-456");
    expect(
      spawnedThreadId(
        "mcp_call",
        { name: "opensession-sessions_spawn_task", arguments: {} },
        "Spawned task `bks-789` — url",
      ),
    ).toBe("bks-789");
  });

  test("ignores other tools and failed calls", () => {
    expect(
      spawnedThreadId("mcp__opensession-sessions__task_status", {}, "x"),
    ).toBeNull();
    expect(
      spawnedThreadId(
        "mcp__opensession-sessions__spawn_task",
        {},
        "Depth limit reached",
      ),
    ).toBeNull();
  });
});

describe("startedSessions", () => {
  test("lists workers, created sessions and goals a chat started, newest first", () => {
    const rows = [
      session("root"),
      session("worker", {
        parentSessionId: "root",
        createdAt: "2026-11-01T01:00:00Z",
      }),
      session("created", {
        spawnedBy: "root",
        createdAt: "2026-11-01T03:00:00Z",
      }),
      session("goal-run", {
        goalId: "goal-1",
        goalStartedFrom: "root",
        createdAt: "2026-11-01T02:00:00Z",
      }),
      session("other", { spawnedBy: "elsewhere" }),
    ];
    expect(startedSessions(rows, "root").map((s) => s.id)).toEqual([
      "created",
      "goal-run",
      "worker",
    ]);
  });
});

describe("startedGoalId", () => {
  test("reads the goal a create_goal call started, through mcp_call too", () => {
    const result =
      "Created goal *Ship it* [`goal-01a2-b3`], mode code. First wake soon.";
    expect(
      startedGoalId("mcp__opensession-goals__create_goal", {}, result),
    ).toBe("goal-01a2-b3");
    const input = {
      name: "opensession-goals_create_goal",
      arguments: { name: "Ship it", mission: "…" },
    };
    expect(startedGoalId("mcp_call", input, result)).toBe("goal-01a2-b3");
    expect(startedGoalName("mcp_call", input)).toBe("Ship it");
  });

  test("ignores other tools and failed calls", () => {
    expect(
      startedGoalId("mcp__opensession-goals__get_goal", {}, "Created goal x"),
    ).toBeNull();
    expect(
      startedGoalId("mcp__opensession-goals__create_goal", {}, "Error: nope"),
    ).toBeNull();
  });
});

describe("coordinated PRs", () => {
  test("lists the root's and its threads' PRs once, needing attention first", () => {
    const shared = {
      repo: "acme",
      branch: "feature",
      number: 7,
      url: "https://github.com/org/acme/pull/7",
      state: "OPEN" as const,
    };
    const prs = coordinatedPrs(
      [
        session("bks-root", {
          parentSessionId: undefined,
          prs: [{ ...shared, source: "discovered" }],
        }),
        session("thread-a", { prs: [{ ...shared, source: "primary" }] }),
        session("thread-b", {
          prs: [
            {
              repo: "acme",
              branch: "fix",
              number: 9,
              state: "OPEN",
              source: "primary",
              checks: { total: 2, passed: 1, failed: 1, pending: 0 },
            },
            {
              repo: "acme",
              branch: "old",
              number: 3,
              state: "MERGED",
              source: "linked",
            },
            { repo: "acme", branch: "bare", source: "attached" },
          ],
        }),
        session("elsewhere", {
          parentSessionId: "bks-other",
          prs: [{ repo: "acme", branch: "x", number: 1, source: "primary" }],
        }),
      ],
      "bks-root",
    );
    expect(prs.map(({ pr, session }) => [pr.number, session.id])).toEqual([
      [9, "thread-b"],
      [7, "thread-a"],
      [3, "thread-b"],
    ]);
  });
});
