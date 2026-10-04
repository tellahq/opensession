/**
 * The drain helper owns one in-flight publication per session. These tests
 * drive it through an injected in-memory wake store whose reads and acks can
 * be held mid-flight, so every interleaving below is deterministic: a read
 * snapshots the store when it starts (an actor reply may be stale by the time
 * it arrives), an ack applies only while the durable cursor still matches,
 * and every operation is counted.
 */
import { describe, expect, test } from "bun:test";
import type { SeqEntry, TranscriptBusEvent } from "./transcript-bus";
import type { TranscriptWake } from "./session-kernel/transcript-protocol";
import {
  createTranscriptWakeDrainer,
  type TranscriptWakeDrainOps,
} from "./transcript-wake-drain";

type Gate = {
  release(): void;
  promise: Promise<void>;
  entered: Promise<void>;
  enter(): void;
};

function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
  return { release, promise, entered, enter };
}

class FakeWakeStore {
  cursor = 0;
  acked = 0;
  firstChangeSeq = 0;
  lastChangeSeq = 0;
  resetEpoch = 0;
  ackedResetEpoch = 0;
  entries: SeqEntry[] = [];
  pageSize = 200;
  counts = { pending: 0, changes: 0, ack: 0, publish: 0, hook: 0 };
  published: TranscriptBusEvent[] = [];
  hooked: SeqEntry[][] = [];
  /** Held operations complete only when the test releases them. */
  holds: { pending?: Gate; ack?: Gate } = {};
  /** When set, the next matching operation rejects with this error once. */
  failNext: { pending?: Error; ack?: Error } = {};
  /** Apply the ack durably before its reply is held (reply in flight). */
  ackBeforeHold = false;

  /** Commit like the actor: extend the unacked span or start a new one. */
  commit(count: number, options: { reset?: boolean } = {}): number {
    const before = this.lastChangeSeq;
    if (options.reset) {
      this.entries = [];
      this.resetEpoch++;
    }
    for (let i = 0; i < count; i++) {
      const changeSeq = ++this.lastChangeSeq;
      this.entries.push({
        id: `entry-${changeSeq}`,
        type: "assistant",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: `change ${changeSeq}`,
        seq: this.entries.length + 1,
        changeSeq,
      });
    }
    if (this.cursor <= this.acked)
      this.firstChangeSeq = Math.min(this.lastChangeSeq, before + 1);
    return ++this.cursor;
  }

  ops(): TranscriptWakeDrainOps {
    return {
      pendingWake: async (): Promise<TranscriptWake | null> => {
        this.counts.pending++;
        const snapshot: TranscriptWake | null =
          this.cursor <= this.acked
            ? null
            : {
                cursor: this.cursor,
                ackedCursor: this.acked,
                firstChangeSeq: this.firstChangeSeq,
                lastChangeSeq: this.lastChangeSeq,
                resetEpoch: this.resetEpoch,
                ackedResetEpoch: this.ackedResetEpoch,
              };
        this.holds.pending?.enter();
        await this.holds.pending?.promise;
        if (this.failNext.pending) {
          const error = this.failNext.pending;
          delete this.failNext.pending;
          throw error;
        }
        return snapshot;
      },
      changesSince: async (_sessionId, changeSeq) => {
        this.counts.changes++;
        const entries = this.entries
          .filter((entry) => entry.changeSeq > changeSeq)
          .slice(0, this.pageSize);
        return {
          entries,
          firstSeq: entries[0]?.seq ?? 0,
          lastSeq: entries[entries.length - 1]?.seq ?? 0,
        };
      },
      ackWake: async (_sessionId, cursor) => {
        this.counts.ack++;
        const apply = () => {
          if (cursor !== this.cursor || this.acked >= cursor) return false;
          this.acked = cursor;
          this.ackedResetEpoch = this.resetEpoch;
          return true;
        };
        const early = this.ackBeforeHold ? apply() : null;
        this.holds.ack?.enter();
        await this.holds.ack?.promise;
        if (this.failNext.ack) {
          const error = this.failNext.ack;
          delete this.failNext.ack;
          throw error;
        }
        return early ?? apply();
      },
      publish: (_sessionId, event) => {
        this.counts.publish++;
        this.published.push(event);
      },
      appendHook: (_sessionId, entries) => {
        this.counts.hook++;
        this.hooked.push(entries);
      },
    };
  }
}

const SESSION = "drain-session";

function changeSeqs(event: TranscriptBusEvent | undefined): number[] {
  return event?.entries.map((entry) => entry.changeSeq) ?? [];
}

describe("transcript wake drain", () => {
  test("overlapping callers share one read, one publication and one ack", async () => {
    const store = new FakeWakeStore();
    const drainer = createTranscriptWakeDrainer(store.ops());
    store.holds.pending = gate();
    const one = store.commit(1);
    const two = store.commit(1);
    const first = drainer.require(SESSION, one);
    const second = drainer.require(SESSION, two);
    await store.holds.pending.entered;
    let completed = false;
    void first.then(() => {
      completed = true;
    });
    expect(completed).toBe(false);
    store.holds.pending.release();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(store.counts).toEqual({
      pending: 1,
      changes: 1,
      ack: 1,
      publish: 1,
      hook: 1,
    });
    expect(changeSeqs(store.published[0])).toEqual([1, 2]);
    expect(store.acked).toBe(2);
  });

  test("a mutation landing during the ack rejects it and extends the drain", async () => {
    const store = new FakeWakeStore();
    const drainer = createTranscriptWakeDrainer(store.ops());
    store.holds.ack = gate();
    const first = drainer.require(SESSION, store.commit(1));
    await store.holds.ack.entered;
    expect(store.counts).toMatchObject({ pending: 1, publish: 1, ack: 1 });
    // Committed while ack(1) is in flight: the durable cursor is now 2.
    const second = drainer.require(SESSION, store.commit(1));
    store.holds.ack.release();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(store.counts).toEqual({
      pending: 2,
      changes: 2,
      ack: 2,
      publish: 2,
      hook: 2,
    });
    // The store kept the unacked span, so the second pass republishes change
    // 1 together with change 2 (at least once) rather than dropping either.
    expect(changeSeqs(store.published[1])).toEqual([1, 2]);
    expect(store.acked).toBe(2);
  });

  test("a caller requiring N+1 waits past a successful ack of N", async () => {
    const store = new FakeWakeStore();
    const drainer = createTranscriptWakeDrainer(store.ops());
    store.ackBeforeHold = true;
    store.holds.ack = gate();
    const first = drainer.require(SESSION, store.commit(1));
    await store.holds.ack.entered;
    expect(store.acked).toBe(1);
    // ack(1) is durable but its reply is still in flight when cursor 2 lands.
    const second = drainer.require(SESSION, store.commit(1));
    store.holds.ack.release();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(store.counts).toEqual({
      pending: 2,
      changes: 2,
      ack: 2,
      publish: 2,
      hook: 2,
    });
    expect(changeSeqs(store.published[1])).toEqual([2]);
    expect(store.acked).toBe(2);
  });

  test("a cursor-0 caller joining during a successful ack waits for its own read", async () => {
    const store = new FakeWakeStore();
    const drainer = createTranscriptWakeDrainer(store.ops());
    store.ackBeforeHold = true;
    store.holds.ack = gate();
    const first = drainer.require(SESSION, store.commit(1));
    await store.holds.ack.entered;
    expect(store.acked).toBe(1);
    // Cursor 2 commits, then a startup-style drain joins while ack(1)'s
    // (already durable) reply is still in flight.
    store.commit(1);
    const startup = drainer.require(SESSION, 0);
    store.holds.ack.release();
    expect(await first).toBe(true);
    expect(await startup).toBe(true);
    expect(store.counts).toEqual({
      pending: 2,
      changes: 2,
      ack: 2,
      publish: 2,
      hook: 2,
    });
    expect(changeSeqs(store.published[1])).toEqual([2]);
    expect(store.acked).toBe(2);
  });

  test("a read that started before the caller's commit cannot settle it", async () => {
    const store = new FakeWakeStore();
    const drainer = createTranscriptWakeDrainer(store.ops());
    store.holds.pending = gate();
    // Startup-style drain with nothing pending: the read snapshots null.
    const startup = drainer.require(SESSION, 0);
    await store.holds.pending.entered;
    expect(store.counts.pending).toBe(1);
    const mutation = drainer.require(SESSION, store.commit(1));
    const hold = store.holds.pending;
    delete store.holds.pending;
    hold.release();
    expect(await startup).toBe(false);
    expect(await mutation).toBe(true);
    expect(store.counts).toMatchObject({ pending: 2, publish: 1, ack: 1 });
    expect(store.acked).toBe(1);
  });

  test("a cursor-0 drain never trusts an earlier ack for newly pending work", async () => {
    const store = new FakeWakeStore();
    const drainer = createTranscriptWakeDrainer(store.ops());
    expect(await drainer.require(SESSION, store.commit(1))).toBe(true);
    store.commit(1);
    expect(await drainer.require(SESSION, 0)).toBe(true);
    expect(store.counts).toMatchObject({ pending: 2, ack: 2 });
    expect(store.acked).toBe(2);
    // Nothing pending: a fresh read, no publication, not counted as drained.
    expect(await drainer.require(SESSION, 0)).toBe(false);
    expect(store.counts).toMatchObject({ pending: 3, ack: 2, publish: 2 });
  });

  test("an exact cursor already acked by the running owner resolves without a read", async () => {
    const store = new FakeWakeStore();
    const drainer = createTranscriptWakeDrainer(store.ops());
    const firstRead = gate();
    store.holds.pending = firstRead;
    const one = store.commit(1);
    const two = store.commit(1);
    const first = drainer.require(SESSION, one);
    const second = drainer.require(SESSION, two);
    // An uncovered waiter keeps the owner alive through a second, held read.
    const later = drainer.require(SESSION, 99);
    await firstRead.entered;
    const secondRead = gate();
    store.holds.pending = secondRead;
    firstRead.release();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(store.counts).toMatchObject({ pending: 2, ack: 1 });
    expect(await drainer.require(SESSION, two)).toBe(true);
    expect(store.counts.pending).toBe(2);
    secondRead.release();
    expect(await later).toBe(false);
    expect(store.counts.pending).toBe(2);
  });

  test("a reentrant caller from a resolved waiter restarts the owner", async () => {
    const store = new FakeWakeStore();
    const drainer = createTranscriptWakeDrainer(store.ops());
    const chained = drainer
      .require(SESSION, store.commit(1))
      .then(() => drainer.require(SESSION, store.commit(1)));
    expect(await chained).toBe(true);
    expect(store.counts).toEqual({
      pending: 2,
      changes: 2,
      ack: 2,
      publish: 2,
      hook: 2,
    });
    expect(store.acked).toBe(2);
  });

  test("a failed ack rejects its callers, releases the owner and stays retryable", async () => {
    const store = new FakeWakeStore();
    const drainer = createTranscriptWakeDrainer(store.ops());
    store.failNext.ack = new Error("actor unavailable");
    store.holds.pending = gate();
    const one = store.commit(1);
    const two = store.commit(1);
    const outcome = Promise.allSettled([
      drainer.require(SESSION, one),
      drainer.require(SESSION, two),
    ]);
    const hold = store.holds.pending;
    delete store.holds.pending;
    hold.release();
    expect(await outcome).toMatchObject([
      { status: "rejected", reason: new Error("actor unavailable") },
      { status: "rejected", reason: new Error("actor unavailable") },
    ]);
    expect(store.acked).toBe(0);
    expect(store.counts).toMatchObject({ pending: 1, ack: 1, publish: 1 });
    // The durable wake is untouched, so the next caller drains it again.
    expect(await drainer.require(SESSION, two)).toBe(true);
    expect(store.counts).toMatchObject({ pending: 2, ack: 2, publish: 2 });
    expect(store.acked).toBe(2);
    expect(changeSeqs(store.published[1])).toEqual([1, 2]);
  });

  test("a failed read rejects every waiter without acking anything", async () => {
    const store = new FakeWakeStore();
    const drainer = createTranscriptWakeDrainer(store.ops());
    store.failNext.pending = new Error("read failed");
    await expect(drainer.require(SESSION, store.commit(1))).rejects.toThrow(
      "read failed",
    );
    expect(store.counts).toEqual({
      pending: 1,
      changes: 0,
      ack: 0,
      publish: 0,
      hook: 0,
    });
    expect(await drainer.require(SESSION, 1)).toBe(true);
    expect(store.acked).toBe(1);
  });

  test("a reset rides only the first page and an empty reset still publishes", async () => {
    const store = new FakeWakeStore();
    const drainer = createTranscriptWakeDrainer(store.ops());
    store.pageSize = 2;
    store.commit(2);
    expect(
      await drainer.require(SESSION, store.commit(3, { reset: true })),
    ).toBe(true);
    expect(store.published.map((event) => event.reset ?? false)).toEqual([
      true,
      false,
    ]);
    expect(store.published.map((event) => event.entries.length)).toEqual([
      2, 1,
    ]);
    expect(store.counts.hook).toBe(2);
    expect(store.ackedResetEpoch).toBe(1);

    store.commit(0, { reset: true });
    expect(await drainer.require(SESSION, store.cursor)).toBe(true);
    expect(store.published[2]).toMatchObject({
      entries: [],
      firstSeq: 0,
      lastSeq: 0,
      reset: true,
    });
    expect(store.counts.hook).toBe(2);
    expect(store.ackedResetEpoch).toBe(2);
  });

  test("an ack rejected twice for the same cursor surfaces instead of spinning", async () => {
    const store = new FakeWakeStore();
    const drainer = createTranscriptWakeDrainer({
      ...store.ops(),
      ackWake: async () => {
        store.counts.ack++;
        return false;
      },
    });
    await expect(drainer.require(SESSION, store.commit(1))).rejects.toThrow(
      "ack rejected twice",
    );
    expect(store.counts).toMatchObject({ pending: 2, ack: 2 });
    // The owner was released: the retry runs its own reads instead of hanging.
    await expect(drainer.require(SESSION, 1)).rejects.toThrow(
      "ack rejected twice",
    );
    expect(store.counts).toMatchObject({ pending: 4, ack: 4 });
  });

  test("sessions drain independently", async () => {
    const stores = { a: new FakeWakeStore(), b: new FakeWakeStore() };
    const pick = (sessionId: string) =>
      stores[sessionId as keyof typeof stores].ops();
    const drainer = createTranscriptWakeDrainer({
      pendingWake: (sessionId) => pick(sessionId).pendingWake(sessionId),
      changesSince: (sessionId, changeSeq) =>
        pick(sessionId).changesSince(sessionId, changeSeq),
      ackWake: (sessionId, cursor) =>
        pick(sessionId).ackWake(sessionId, cursor),
      publish: (sessionId, event) => pick(sessionId).publish(sessionId, event),
      appendHook: (sessionId, entries) =>
        pick(sessionId).appendHook(sessionId, entries),
    });
    stores.a.holds.pending = gate();
    const blocked = drainer.require("a", stores.a.commit(1));
    expect(await drainer.require("b", stores.b.commit(1))).toBe(true);
    await stores.a.holds.pending!.entered;
    let completed = false;
    void blocked.then(() => {
      completed = true;
    });
    expect(completed).toBe(false);
    stores.a.holds.pending.release();
    expect(await blocked).toBe(true);
  });
});
