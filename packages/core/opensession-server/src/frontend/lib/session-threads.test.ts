import { describe, expect, test } from "bun:test";
import {
  groupThreads,
  isCoordinating,
  markThreadsSeen,
  sessionThreads,
  spawnedThreadId,
  threadState,
  threadStatusLine,
  threadsSeenAt,
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

describe("threads seen", () => {
  test("the seen time round-trips through storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    expect(threadsSeenAt("bks-root", storage)).toBeNull();
    markThreadsSeen("bks-root", 42, storage);
    expect(threadsSeenAt("bks-root", storage)).toBe(42);
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
