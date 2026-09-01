import { describe, expect, test } from "bun:test";
import {
  shouldRetireCommandResult,
  WsCommandOutbox,
} from "./ws-command-outbox";

class MemoryStorage {
  values = new Map<string, string>();
  failWrites = false;
  failItemWriteAt: number | undefined;
  itemWrites = 0;
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (key.includes(":item:")) {
      this.itemWrites += 1;
      if (this.itemWrites === this.failItemWriteAt) throw new Error("quota");
    }
    if (this.failWrites) throw new Error("quota");
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const KEY = "opensession-ws-command-outbox:v1:test";

describe("WebSocket command outbox", () => {
  test("survives command and acknowledgement reconnects", () => {
    const storage = new MemoryStorage();
    const first = new WsCommandOutbox(storage, () => 100, KEY);
    first.put({ type: "cancel", requestId: "request-1" });
    const resumed = new WsCommandOutbox(storage, () => 101, KEY);
    expect(resumed.pending()).toEqual([
      { type: "cancel", requestId: "request-1" },
    ]);
    expect(resumed.ack("request-1", "s1")).toBe(true);
    const awaitingServer = new WsCommandOutbox(storage, () => 102, KEY);
    expect(awaitingServer.pending()).toEqual([]);
    expect(awaitingServer.pendingAcks()).toEqual([
      { type: "command_ack", sessionId: "s1", requestId: "request-1" },
    ]);
    expect(awaitingServer.confirmAck("request-1")).toBe(true);
    expect(new WsCommandOutbox(storage, () => 103, KEY).pendingAcks()).toEqual(
      [],
    );
    expect(
      [...storage.values.keys()].some((key) => key.includes(":retired:")),
    ).toBe(false);
  });

  test("migrates the actual shipped v1 aggregate key in place", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        items: [
          {
            message: { type: "cancel", requestId: "legacy" },
            createdAt: 1,
          },
        ],
      }),
    );
    const migrated = new WsCommandOutbox(storage, () => 2, KEY);
    expect(migrated.pending()).toEqual([
      { type: "cancel", requestId: "legacy" },
    ]);
    expect(JSON.parse(storage.getItem(KEY)!)).toEqual({ version: 2 });
  });

  test("partial migration keeps every legacy intent visible", () => {
    const storage = new MemoryStorage();
    const legacy = ["a", "b", "c"].map((requestId, index) => ({
      message: { type: "cancel" as const, requestId },
      createdAt: index,
    }));
    storage.setItem(KEY, JSON.stringify({ version: 1, items: legacy }));
    storage.failItemWriteAt = 2;
    const partial = new WsCommandOutbox(storage, () => 4, KEY);
    expect(partial.pending().map((item) => item.requestId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(JSON.parse(storage.getItem(KEY)!)).toMatchObject({ version: 1 });

    storage.itemWrites = 0;
    const reconstructed = new WsCommandOutbox(storage, () => 5, KEY);
    expect(reconstructed.pending().map((item) => item.requestId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(reconstructed.ack("a", "s1")).toBe(true);
    expect(reconstructed.confirmAck("a")).toBe(true);
    storage.itemWrites = 0;
    const afterAck = new WsCommandOutbox(storage, () => 6, KEY);
    expect(afterAck.pending().map((item) => item.requestId)).toEqual([
      "b",
      "c",
    ]);

    // A stale tab can finish its old migration write after confirmAck. The
    // permanent retired record must still suppress that resurrected item.
    storage.failItemWriteAt = undefined;
    storage.setItem(`${KEY}:item:a`, JSON.stringify(legacy[0]));
    expect(
      new WsCommandOutbox(storage, () => 7, KEY)
        .pending()
        .map((item) => item.requestId),
    ).toEqual(["b", "c"]);
    expect(storage.getItem(`${KEY}:retired:a`)).not.toBeNull();
  });

  test("adopts the previously shipped user key into a verified scope", () => {
    const storage = new MemoryStorage();
    const old = new WsCommandOutbox(storage, () => 1, `${KEY}:ada`);
    expect(old.put({ type: "cancel", requestId: "old-a" })).toBe(true);
    const scoped = new WsCommandOutbox(storage, () => 2, `${KEY}:github:ada`);
    scoped.adoptLegacyPrefix(`${KEY}:ada`);
    expect(scoped.pending().map((item) => item.requestId)).toEqual(["old-a"]);
  });

  test("moves the previous scoped key once and binds it to one identity", () => {
    const storage = new MemoryStorage();
    const prior = new WsCommandOutbox(storage, () => 1, `${KEY}:github:ada`);
    expect(prior.put({ type: "cancel", requestId: "prior" })).toBe(true);
    const encoded = new WsCommandOutbox(
      storage,
      () => 2,
      `${KEY}:github%3Aada`,
    );
    encoded.adoptLegacyPrefix(`${KEY}:github:ada`);
    expect(encoded.pending().map((item) => item.requestId)).toEqual(["prior"]);
    expect(storage.getItem(`${KEY}:github:ada:item:prior`)).toBeNull();
    const other = new WsCommandOutbox(
      storage,
      () => 3,
      `${KEY}:github%3Agrace`,
    );
    other.adoptLegacyPrefix(`${KEY}:github:ada`);
    expect(other.pending()).toEqual([]);
  });

  test("partitions pending commands by current identity scope", () => {
    const storage = new MemoryStorage();
    const a = new WsCommandOutbox(storage, () => 1, `${KEY}:local:ada`);
    const b = new WsCommandOutbox(storage, () => 2, `${KEY}:local:grace`);
    expect(a.put({ type: "cancel", requestId: "a" })).toBe(true);
    expect(b.put({ type: "cancel", requestId: "b" })).toBe(true);
    expect(a.pending().map((item) => item.requestId)).toEqual(["a"]);
    expect(b.pending().map((item) => item.requestId)).toEqual(["b"]);
  });

  test("separate tabs cannot overwrite each other's request records", () => {
    const storage = new MemoryStorage();
    const tabA = new WsCommandOutbox(storage, () => 1, KEY);
    const tabB = new WsCommandOutbox(storage, () => 2, KEY);
    tabA.put({ type: "cancel", requestId: "a" });
    tabB.put({ type: "cancel", requestId: "b" });
    expect(new WsCommandOutbox(storage, () => 3, KEY).pending()).toEqual([
      { type: "cancel", requestId: "a" },
      { type: "cancel", requestId: "b" },
    ]);
    expect(tabA.ack("a", "s1")).toBe(true);
    tabB.put({ type: "cancel", requestId: "c" });
    expect(new WsCommandOutbox(storage, () => 4, KEY).pending()).toEqual([
      { type: "cancel", requestId: "b" },
      { type: "cancel", requestId: "c" },
    ]);
  });

  test("does not acknowledge the server when durable ack storage fails", () => {
    const storage = new MemoryStorage();
    const outbox = new WsCommandOutbox(storage, () => 100, KEY);
    outbox.put({ type: "cancel", requestId: "keep" });
    storage.failWrites = true;
    expect(outbox.ack("keep", "s1")).toBe(false);
    expect(outbox.pending()).toEqual([{ type: "cancel", requestId: "keep" }]);
  });

  test("rejects changed payload under one request id", () => {
    const outbox = new WsCommandOutbox(new MemoryStorage(), () => 100, KEY);
    outbox.put({ type: "cancel", requestId: "same" });
    expect(() =>
      outbox.put({
        type: "answer_question",
        sessionId: "s1",
        questionId: "q",
        answers: null,
        requestId: "same",
      }),
    ).toThrow("was reused");
  });

  test("does not evict unresolved commands by age or count", () => {
    const storage = new MemoryStorage();
    const first = new WsCommandOutbox(storage, () => 0, KEY);
    for (let i = 0; i < 101; i++)
      first.put({ type: "cancel", requestId: `request-${i}` });
    const muchLater = new WsCommandOutbox(
      storage,
      () => 30 * 24 * 60 * 60_000,
      KEY,
    );
    expect(muchLater.pending()).toHaveLength(101);
    expect(muchLater.pending()[0]).toMatchObject({ requestId: "request-0" });
  });

  test("keeps transient failures until a completed or terminal receipt", () => {
    expect(shouldRetireCommandResult({ status: "failed" })).toBe(false);
    expect(
      shouldRetireCommandResult({ status: "failed", terminal: true }),
    ).toBe(true);
    expect(shouldRetireCommandResult({ status: "completed" })).toBe(true);
  });
});
