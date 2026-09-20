import { describe, expect, test } from "bun:test";
import {
  archivePlainSessionCandidates,
  resolvePlainDiscussion,
} from "./plain-archive";
import type { NativeSessionFile } from "./types";

describe("Plain archive sweep", () => {
  test("a matching thread cannot open an unbounded set of actor writers", async () => {
    let writes = 0;
    const sessions = Array.from({ length: 1000 }, (_, i) => ({
      data: {
        id: `candidate-${i}`,
        plainThreadId: "thread",
      } as NativeSessionFile,
    }));
    const archived = await archivePlainSessionCandidates(
      "thread",
      sessions,
      async (_id, _operation, mutate) => {
        writes++;
        return undefined as Awaited<ReturnType<typeof mutate>>;
      },
      () => {},
      () => {},
    );
    expect(writes).toBe(40);
    expect(archived).toBe(40);
  });

  test("a retargeted or already archived session cannot be archived from a stale candidate", async () => {
    const {
      SessionKernelStore,
      __setSessionKernelStoreForTest,
      sessionMetadata,
    } = await import("./session-kernel");
    const store = new SessionKernelStore(":memory:");
    const prior = __setSessionKernelStoreForTest(store);
    try {
      const current = { id: "os-archive-race", plainThreadId: "new-ticket" };
      await sessionMetadata({
        op: "put",
        sessionId: current.id,
        expectedRev: null,
        rev: 1,
        requestId: "seed",
        doc: JSON.stringify(current),
        archived: false,
        lastActivityMs: 0,
      });
      const failures: unknown[] = [];
      const result = await archivePlainSessionCandidates(
        "old-ticket",
        [
          {
            data: {
              ...current,
              plainThreadId: "old-ticket",
            } as NativeSessionFile,
          },
        ],
        async (_id, _op, mutate) => await mutate(),
        (_id, error) => failures.push(error),
        () => {
          throw new Error("Must not release a retargeted session lease");
        },
      );
      expect(result).toBe(0);
      expect(String(failures[0])).toContain(
        "changed since candidate selection",
      );
      expect(
        JSON.parse(
          (await sessionMetadata({ op: "catalog_get", sessionId: current.id }))!
            .doc,
        ),
      ).toEqual(current);
    } finally {
      __setSessionKernelStoreForTest(prior);
      store.close();
    }
  });

  test("continues after one session projection is quarantined", async () => {
    const projected: string[] = [];
    const released: string[] = [];
    const failures: Array<[string, unknown]> = [];
    const sessions = ["quarantined", "healthy"].map((id) => ({
      data: { id, plainThreadId: "thread-1" } as NativeSessionFile,
    }));

    const archived = await archivePlainSessionCandidates(
      "thread-1",
      sessions,
      async (sessionId, _operation, mutate) => {
        projected.push(sessionId);
        if (sessionId === "quarantined") throw new Error("session quarantined");
        return undefined as Awaited<ReturnType<typeof mutate>>;
      },
      (sessionId, error) => failures.push([sessionId, error]),
      (sessionId) => released.push(sessionId),
    );

    expect(archived).toBe(1);
    expect(projected).toEqual(["quarantined", "healthy"]);
    expect(released).toEqual(["healthy"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.[0]).toBe("quarantined");
  });

  test("resolves a session's discussion before archiving it, and only then", async () => {
    const events: string[] = [];
    const sessions = [
      {
        id: "with-discussion",
        plainThreadId: "thread-1",
        plainDiscussionId: "thd_a",
      },
      { id: "note-only", plainThreadId: "thread-1" },
      {
        id: "other-thread",
        plainThreadId: "thread-2",
        plainDiscussionId: "thd_b",
      },
    ].map((data) => ({ data: data as NativeSessionFile }));

    const archived = await archivePlainSessionCandidates(
      "thread-1",
      sessions,
      async (sessionId, _operation, mutate) => {
        events.push(`archive:${sessionId}`);
        return undefined as Awaited<ReturnType<typeof mutate>>;
      },
      () => {},
      () => {},
      async (discussionId) => {
        events.push(`resolve:${discussionId}`);
      },
    );

    expect(archived).toBe(2);
    expect(events).toEqual([
      "resolve:thd_a",
      "archive:with-discussion",
      "archive:note-only",
    ]);
  });

  test("keeps a session unarchived when its discussion cannot be resolved, so the sweep retries it", async () => {
    const projected: string[] = [];
    const failures: Array<[string, unknown]> = [];
    const sessions = [
      {
        id: "plain-down",
        plainThreadId: "thread-1",
        plainDiscussionId: "thd_a",
      },
      { id: "healthy", plainThreadId: "thread-1", plainDiscussionId: "thd_b" },
    ].map((data) => ({ data: data as NativeSessionFile }));

    const archived = await archivePlainSessionCandidates(
      "thread-1",
      sessions,
      async (sessionId, _operation, mutate) => {
        projected.push(sessionId);
        return undefined as Awaited<ReturnType<typeof mutate>>;
      },
      (sessionId, error) => failures.push([sessionId, error]),
      () => {},
      async (discussionId) => {
        if (discussionId === "thd_a")
          throw new Error("Plain API responded 503");
      },
    );

    expect(archived).toBe(1);
    expect(projected).toEqual(["healthy"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.[0]).toBe("plain-down");
  });

  test("treats a missing agent key as a resolution failure instead of archiving past the discussion", async () => {
    const saved = {
      PLAIN_AGENT_API_KEY: process.env.PLAIN_AGENT_API_KEY,
      PLAIN_API_KEY: process.env.PLAIN_API_KEY,
    };
    delete process.env.PLAIN_AGENT_API_KEY;
    delete process.env.PLAIN_API_KEY;
    try {
      await expect(resolvePlainDiscussion("thd_a")).rejects.toThrow(
        "not configured",
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
