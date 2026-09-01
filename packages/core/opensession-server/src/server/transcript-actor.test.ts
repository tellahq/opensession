import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setTranscriptStoreForTest,
  TranscriptStore,
} from "./transcript-store";
import { subscribeTranscript, type TranscriptBusEvent } from "./transcript-bus";
import { drainPendingTranscriptWakesForSessions } from "./actor-transcript";
import {
  assertTranscriptActorRequest,
  assertTranscriptActorResponse,
  TRANSCRIPT_ACTOR_MAX_ENTRIES,
  TRANSCRIPT_ACTOR_MAX_READ_LIMIT,
  TRANSCRIPT_ACTOR_RANGE_PAGE_LIMIT,
  TRANSCRIPT_ACTOR_MAX_REQUEST_BYTES,
  TRANSCRIPT_ACTOR_MAX_RESPONSE_BYTES,
} from "./session-kernel/transcript-protocol";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "actor-transcript-wake-"));
  roots.push(root);
  const path = join(root, "session.sqlite");
  const sessionId = "wake-session";
  const request = {
    op: "append" as const,
    sessionId,
    requestId: "append-one",
    entries: [
      {
        id: "entry-one",
        type: "assistant" as const,
        timestamp: "2026-01-01T00:00:00.000Z",
        content: "committed",
      },
    ],
  };
  return { path, sessionId, request };
}

describe("actor transcript request bounds", () => {
  test("accepts boundary reads and rejects oversized entries and options", () => {
    expect(() =>
      assertTranscriptActorRequest({
        op: "tail",
        sessionId: "bounded",
        limit: TRANSCRIPT_ACTOR_MAX_READ_LIMIT,
      }),
    ).not.toThrow();
    expect(() =>
      assertTranscriptActorRequest({
        op: "tail",
        sessionId: "bounded",
        limit: TRANSCRIPT_ACTOR_MAX_READ_LIMIT + 1,
      }),
    ).toThrow("read limit");
    expect(() =>
      assertTranscriptActorRequest({
        op: "range",
        sessionId: "bounded",
        fromSeq: 1,
        toSeq: TRANSCRIPT_ACTOR_RANGE_PAGE_LIMIT,
        limit: TRANSCRIPT_ACTOR_RANGE_PAGE_LIMIT,
      }),
    ).not.toThrow();
    expect(() =>
      assertTranscriptActorRequest({
        op: "range",
        sessionId: "bounded",
        fromSeq: 1,
        toSeq: TRANSCRIPT_ACTOR_RANGE_PAGE_LIMIT + 1,
        limit: TRANSCRIPT_ACTOR_RANGE_PAGE_LIMIT + 1,
      }),
    ).toThrow("read limit");
    expect(() =>
      assertTranscriptActorRequest({
        op: "append",
        sessionId: "bounded",
        requestId: "too-many",
        entries: Array.from(
          { length: TRANSCRIPT_ACTOR_MAX_ENTRIES + 1 },
          (_, index) => ({
            id: String(index),
            type: "user" as const,
            timestamp: "2026-01-01T00:00:00.000Z",
            content: "x",
          }),
        ),
      }),
    ).toThrow("too many entries");
    expect(() =>
      assertTranscriptActorRequest({
        op: "tail_window",
        sessionId: "bounded",
        options: {
          minEntries: 1,
          minMessages: 1,
          maxEntries: TRANSCRIPT_ACTOR_MAX_READ_LIMIT + 1,
          maxEstimatedBytes: 1_000,
        },
      }),
    ).toThrow("maxEntries");
    expect(() =>
      assertTranscriptActorRequest({
        op: "tail_window",
        sessionId: "bounded",
        options: {
          minEntries: 132,
          minMessages: 4,
          minUserMessagesWithToolWork: 1,
          maxEntries: 1_400,
          maxEstimatedBytes: 850_000,
          weightProfile: "v2_snapshot",
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertTranscriptActorRequest({
        op: "tail_window",
        sessionId: "bounded",
        options: {
          minEntries: 132,
          minMessages: 4,
          minUserMessagesWithToolWork: 1,
          maxEntries: 1_401,
          maxEstimatedBytes: 850_000,
          weightProfile: "v2_snapshot",
        },
      }),
    ).toThrow("maxEntries");
    expect(() =>
      assertTranscriptActorRequest({
        op: "tail_window",
        sessionId: "bounded",
        options: {
          minEntries: 32,
          minMessages: 24,
          minUserMessagesWithToolWork: 4,
          maxEntries: 512,
          maxEstimatedBytes: 180_000,
          weightProfile: "handoff",
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertTranscriptActorRequest({
        op: "tail_window",
        sessionId: "bounded",
        options: {
          minEntries: 32,
          minMessages: 24,
          minUserMessagesWithToolWork: 4,
          maxEntries: 513,
          maxEstimatedBytes: 180_000,
          weightProfile: "handoff",
        },
      }),
    ).toThrow("maxEntries");
  });

  test("persists and reads an entry larger than the former 16 MiB envelope", () => {
    expect(TRANSCRIPT_ACTOR_MAX_REQUEST_BYTES).toBeGreaterThan(
      16 * 1024 * 1024,
    );
    expect(TRANSCRIPT_ACTOR_MAX_RESPONSE_BYTES).toBeGreaterThan(
      16 * 1024 * 1024,
    );
    const { path, sessionId } = fixture();
    const store = new TranscriptStore(path, { actorOwned: true });
    const content = "x".repeat(17 * 1024 * 1024);
    const request = {
      op: "append" as const,
      sessionId,
      requestId: "large-accepted-entry",
      entries: [
        {
          id: "large-entry",
          type: "user" as const,
          timestamp: "2026-01-01T00:00:00.000Z",
          content,
        },
      ],
    };
    expect(() => assertTranscriptActorRequest(request)).not.toThrow();
    store.applyActorRequest(request);
    const full = store.applyActorRequest({
      op: "full_entry",
      sessionId,
      entryId: "large-entry",
    });
    expect(() => assertTranscriptActorResponse(full)).not.toThrow();
    expect((full as { content: string }).content).toHaveLength(content.length);
    store.close();
  });

  test("pages outlines at the actor boundary", () => {
    const { path, sessionId } = fixture();
    const store = new TranscriptStore(path, { actorOwned: true });
    const makeEntries = (start: number, count: number) =>
      Array.from({ length: count }, (_, offset) => ({
        id: `outline-${start + offset}`,
        type: "user" as const,
        timestamp: "2026-01-01T00:00:00.000Z",
        content: "x",
      }));
    for (const [start, count] of [
      [0, 1_000],
      [1_000, 1_000],
      [2_000, 1],
    ] as const)
      store.applyActorRequest({
        op: "append",
        sessionId,
        requestId: `outline-${start}`,
        entries: makeEntries(start, count),
      });
    const first = store.applyActorRequest({
      op: "outline",
      sessionId,
      limit: 2_000,
    }) as { entries: Array<{ seq: number }> };
    const second = store.applyActorRequest({
      op: "outline",
      sessionId,
      afterSeq: first.entries.at(-1)!.seq,
      limit: 2_000,
    }) as { entries: Array<{ seq: number }> };
    expect(first.entries).toHaveLength(2_000);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]!.seq).toBe(2_001);
    store.close();
  });

  test("enforces canonical request strings and response bytes", () => {
    expect(() =>
      assertTranscriptActorRequest({
        op: "full_entry",
        sessionId: "bounded",
        entryId: "x".repeat(8 * 1024 * 1024 + 1),
      }),
    ).toThrow("entryId is invalid");
    expect(TRANSCRIPT_ACTOR_MAX_REQUEST_BYTES).toBe(80 * 1024 * 1024);
    expect(TRANSCRIPT_ACTOR_MAX_RESPONSE_BYTES).toBe(80 * 1024 * 1024);
    expect(() =>
      assertTranscriptActorResponse({
        payload: Array.from({ length: 250_001 }, () => 0),
      }),
    ).toThrow("too many scalar values");
  });
});

describe("actor transcript wake crash recovery", () => {
  test("reconciles a committed mutation after a crash before wake delivery", () => {
    const { path, sessionId, request } = fixture();
    let store = new TranscriptStore(path);
    const committed = store.applyActorRequest(request) as {
      wakeCursor: number;
      replay: boolean;
    };
    expect(committed).toMatchObject({ wakeCursor: 1, replay: false });
    store.close();

    store = new TranscriptStore(path);
    expect(store.pendingActorWake(sessionId)).toMatchObject({
      cursor: 1,
      ackedCursor: 0,
      firstChangeSeq: 1,
      lastChangeSeq: 1,
    });
    expect(store.readChangesSince(sessionId, 0).entries).toMatchObject([
      { id: "entry-one", seq: 1, changeSeq: 1 },
    ]);
    expect(store.ackActorWake(sessionId, 1)).toBe(true);
    expect(store.pendingActorWake(sessionId)).toBeNull();
    store.close();
  });

  test("boot-drains a replacement reset without waiting for another mutation", async () => {
    const { path, sessionId, request } = fixture();
    const store = new TranscriptStore(path, { actorOwned: true });
    store.applyActorRequest(request);
    store.ackActorWake(sessionId, 1);
    store.applyActorRequest({
      op: "replace",
      sessionId,
      requestId: "replace-empty",
      entries: [],
    });
    const previous = __setTranscriptStoreForTest(store);
    const events: TranscriptBusEvent[] = [];
    const unsubscribe = subscribeTranscript(sessionId, (event) =>
      events.push(event),
    );
    try {
      expect(await drainPendingTranscriptWakesForSessions([sessionId])).toBe(1);
      await Bun.sleep(0);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        entries: [],
        firstSeq: 0,
        lastSeq: 0,
        reset: true,
      });
      expect(store.pendingActorWake(sessionId)).toBeNull();
    } finally {
      unsubscribe();
      __setTranscriptStoreForTest(previous);
      store.close();
    }
  });

  for (const destructive of ["replace", "delete"] as const) {
    test(`preserves a pending ${destructive} reset through a later append`, async () => {
      const { path, sessionId, request } = fixture();
      const store = new TranscriptStore(path, { actorOwned: true });
      store.applyActorRequest(request);
      store.ackActorWake(sessionId, 1);
      store.applyActorRequest(
        destructive === "replace"
          ? {
              op: "replace",
              sessionId,
              requestId: `${destructive}-before-crash`,
              entries: [],
            }
          : {
              op: "delete",
              sessionId,
              requestId: `${destructive}-before-crash`,
            },
      );
      store.applyActorRequest({
        op: "append",
        sessionId,
        requestId: "append-after-crash",
        entries: [
          {
            id: "after",
            type: "user",
            timestamp: "2026-01-01T00:00:01.000Z",
            content: "after reset",
          },
        ],
      });
      const pending = store.pendingActorWake(sessionId)!;
      expect(pending.resetEpoch).toBeGreaterThan(pending.ackedResetEpoch);
      const previous = __setTranscriptStoreForTest(store);
      const events: TranscriptBusEvent[] = [];
      const unsubscribe = subscribeTranscript(sessionId, (event) =>
        events.push(event),
      );
      try {
        await drainPendingTranscriptWakesForSessions([sessionId]);
        await Bun.sleep(0);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          reset: true,
          entries: [{ id: "after" }],
        });
        expect(store.pendingActorWake(sessionId)).toBeNull();
      } finally {
        unsubscribe();
        __setTranscriptStoreForTest(previous);
        store.close();
      }
    });
  }

  test("marks a chunked import complete only after the final actor receipt", () => {
    const { path, sessionId } = fixture();
    const store = new TranscriptStore(path);
    store.applyActorRequest({
      op: "import",
      sessionId,
      requestId: "import:one:0",
      entries: [
        {
          id: "history",
          type: "user",
          timestamp: "2026-01-01T00:00:00.000Z",
          content: "history",
        },
      ],
      src: "merged",
      watermark: 42,
      final: false,
    });
    expect(store.needsImport(sessionId)).toBe(true);
    store.applyActorRequest({
      op: "import",
      sessionId,
      requestId: "import:one:1",
      entries: [],
      src: "merged",
      watermark: 42,
      final: true,
    });
    expect(store.needsImport(sessionId)).toBe(false);
    expect(store.getImportInfo(sessionId)).toMatchObject({
      src: "merged",
      watermark: 42,
    });
    store.close();
  });

  test("replays the immutable receipt without duplicating a wake before ack", () => {
    const { path, sessionId, request } = fixture();
    let store = new TranscriptStore(path);
    store.applyActorRequest(request);
    // Simulate gateway publication followed by a crash before durable ack.
    expect(store.readChangesSince(sessionId, 0).entries).toHaveLength(1);
    store.close();

    store = new TranscriptStore(path);
    expect(store.applyActorRequest(request)).toMatchObject({
      wakeCursor: 1,
      replay: true,
    });
    expect(store.countEvents(sessionId)).toBe(1);
    expect(store.getLastChangeSeq(sessionId)).toBe(1);
    expect(store.pendingActorWake(sessionId)?.cursor).toBe(1);
    store.close();
  });
});
