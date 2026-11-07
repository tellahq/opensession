import { describe, expect, test } from "bun:test";
import {
  groupThreads,
  isSpaceCoordinator,
  markSpaceSeen,
  spaceRecap,
  spaceSeenAt,
  spaceThreads,
  spawnedThreadId,
  threadState,
  threadStatusLine,
} from "./space-threads";
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

describe("space threads", () => {
  test("are the space's sessions with a parent, newest first", () => {
    const threads = spaceThreads(
      [
        session("bks-root", { parentSessionId: undefined }),
        session("old", { createdAt: "2026-11-07T08:00:00Z" }),
        session("new", { createdAt: "2026-11-07T09:30:00Z" }),
        session("elsewhere", { workspaceId: "ws-other" }),
      ],
      "ws-space",
    );
    expect(threads.map((thread) => thread.id)).toEqual(["new", "old"]);
  });

  test("only a root session in a space coordinates it", () => {
    const space = { id: "ws-space", space: true as const };
    expect(isSpaceCoordinator({ workspaceId: "ws-space" }, space)).toBe(true);
    expect(
      isSpaceCoordinator(
        { workspaceId: "ws-space", parentSessionId: "bks-root" },
        space,
      ),
    ).toBe(false);
    expect(
      isSpaceCoordinator({ workspaceId: "ws-space" }, { id: "ws-space" }),
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

describe("spaceRecap", () => {
  const seen = Date.parse("2026-11-07T09:45:00Z");

  test("is null on a first visit or when nothing changed", () => {
    expect(spaceRecap([session("a")], null)).toBeNull();
    expect(
      spaceRecap(
        [session("a", { lastActivity: "2026-11-07T09:00:00Z" })],
        seen,
      ),
    ).toBeNull();
  });

  test("lists what started, shipped, got ready, or got blocked since", () => {
    const recap = spaceRecap(
      [
        session("started", { createdAt: "2026-11-07T09:50:00Z" }),
        session("shipped", { prState: "MERGED" }),
        session("ready", { prState: "OPEN" }),
        session("stuck", { waitingForInput: true }),
        session("quiet", { lastActivity: "2026-11-07T09:00:00Z" }),
      ],
      seen,
    );
    expect(recap?.started.map((s) => s.id)).toEqual(["started"]);
    expect(recap?.shipped.map((s) => s.id)).toEqual(["shipped"]);
    expect(recap?.ready.map((s) => s.id)).toEqual(["ready"]);
    expect(recap?.blocked.map((s) => s.id)).toEqual(["stuck"]);
  });

  test("the seen time round-trips through storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    expect(spaceSeenAt("ws-space", storage)).toBeNull();
    markSpaceSeen("ws-space", 42, storage);
    expect(spaceSeenAt("ws-space", storage)).toBe(42);
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
