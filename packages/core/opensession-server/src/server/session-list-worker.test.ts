/**
 * The session-list index runs on a dedicated worker. These tests pin the
 * gateway-facing guarantees: the event loop stays free while the worker is
 * busy, a read posted after a write observes it, a dead worker rejects what
 * it owed and the next call recovers on the same durable file, and a
 * repointed OPENSESSION_STATE_DIR gets its own database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetSessionListIndexForTest,
  __sessionListIndexDebugForTest,
  __sessionListIndexPendingForTest,
  SESSION_LIST_MAX_PENDING,
  SessionListIndexError,
  indexedCoverage,
  indexedSession,
  indexedSessionWithVisibilityGroup,
  indexedSessions,
  indexedSidebarSessions,
  removeIndexedSession,
  upsertIndexedSession,
  upsertIndexedSessions,
} from "./session-list-store";
import { SESSION_LIST_DB_FILE } from "./session-list-protocol";
import type { UnifiedSession } from "./types";

const root = mkdtempSync(join(tmpdir(), "session-list-worker-"));
const stateA = join(root, "a");
const stateB = join(root, "b");
const priorStateDir = process.env.OPENSESSION_STATE_DIR;

function session(
  id: string,
  patch: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    source: "opensession",
    branch: null,
    worktreeDir: null,
    createdBy: "Ada",
    startedBy: "Ada",
    title: id,
    lastActivity: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    isRunning: false,
    transcriptPath: null,
    ...patch,
  } as UnifiedSession;
}

beforeAll(() => {
  process.env.OPENSESSION_STATE_DIR = stateA;
});

afterAll(() => {
  __resetSessionListIndexForTest();
  if (priorStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = priorStateDir;
  rmSync(root, { recursive: true, force: true });
});

describe("session list worker", () => {
  test("a read posted after a write observes it, and the file lands under the state root", async () => {
    const write = upsertIndexedSessions(
      [session("first"), session("second", { workspaceId: "ws-1" })],
      "exclude",
    );
    const read = indexedSessions("exclude");
    expect(__sessionListIndexPendingForTest()).toBe(2);
    await write;
    expect((await read)?.map((row) => row.id).sort()).toEqual([
      "first",
      "second",
    ]);
    expect(await indexedCoverage("exclude")).toBe(true);
    expect(await indexedCoverage("only")).toBe(false);
    expect(existsSync(join(stateA, SESSION_LIST_DB_FILE))).toBe(true);
    expect(__sessionListIndexPendingForTest()).toBe(0);
  });

  test("the gateway loop answers HTTP and timers while the worker is busy", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("ok"),
    });
    try {
      const stallMs = 400;
      const stalled = __sessionListIndexDebugForTest({
        action: "stall",
        ms: stallMs,
      });
      const delayedRead = indexedSession("first");
      let ticks = 0;
      const ticker = setInterval(() => ticks++, 10);
      const startedAt = performance.now();
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(await response.text()).toBe("ok");
      expect(performance.now() - startedAt).toBeLessThan(stallMs / 2);
      await Bun.sleep(100);
      clearInterval(ticker);
      // The loop kept ticking while the worker thread slept.
      expect(ticks).toBeGreaterThanOrEqual(5);
      await stalled;
      expect((await delayedRead)?.id).toBe("first");
    } finally {
      server.stop(true);
    }
  });

  test("refuses to queue past the pending bound", async () => {
    const stalled = __sessionListIndexDebugForTest({
      action: "stall",
      ms: 150,
    });
    const reads: Promise<unknown>[] = [];
    for (let index = 1; index < SESSION_LIST_MAX_PENDING; index++)
      reads.push(indexedSession(`missing-${index}`));
    expect(__sessionListIndexPendingForTest()).toBe(SESSION_LIST_MAX_PENDING);
    await expect(indexedSession("one-too-many")).rejects.toBeInstanceOf(
      SessionListIndexError,
    );
    await stalled;
    await Promise.all(reads);
    expect(__sessionListIndexPendingForTest()).toBe(0);
  });

  test("a crashed worker rejects what it owed and the next call recovers on the same file", async () => {
    await upsertIndexedSession(session("durable"));
    // Settle both together: the worker rejects every pending request at
    // once, and a rejection nobody is listening to yet would fail the test
    // as unhandled.
    const outcomes = await Promise.allSettled([
      __sessionListIndexDebugForTest({ action: "crash" }),
      indexedSession("durable"),
    ]);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected")
        expect(outcome.reason).toBeInstanceOf(SessionListIndexError);
    }
    expect(__sessionListIndexPendingForTest()).toBe(0);
    // Fresh worker, same database: the write before the crash is still there.
    expect((await indexedSession("durable"))?.id).toBe("durable");
    expect(await indexedCoverage("exclude")).toBe(true);
  });

  test("one round trip returns a row with its visibility group", async () => {
    await upsertIndexedSessions([
      session("parent", { workspaceId: "ws-2" }),
      session("child", { workspaceId: "ws-2", parentSessionId: "parent" }),
    ]);
    const stored = await indexedSessionWithVisibilityGroup("child");
    expect(stored?.session.id).toBe("child");
    expect(stored?.group.map((row) => row.id).sort()).toEqual([
      "child",
      "parent",
    ]);
    await removeIndexedSession("child");
    expect(await indexedSessionWithVisibilityGroup("child")).toBeNull();
    expect(await indexedSession("child")).toBeNull();
  });

  test("a repointed OPENSESSION_STATE_DIR gets its own database", async () => {
    expect((await indexedSession("first"))?.id).toBe("first");
    process.env.OPENSESSION_STATE_DIR = stateB;
    try {
      expect(await indexedSession("first")).toBeNull();
      expect(await indexedCoverage("exclude")).toBe(false);
      expect(await indexedSidebarSessions()).toBeNull();
      await upsertIndexedSession(session("only-in-b"));
      expect(existsSync(join(stateB, SESSION_LIST_DB_FILE))).toBe(true);
    } finally {
      process.env.OPENSESSION_STATE_DIR = stateA;
    }
    expect((await indexedSession("first"))?.id).toBe("first");
    expect(await indexedSession("only-in-b")).toBeNull();
  });
});
