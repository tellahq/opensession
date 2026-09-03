import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptStore } from "./transcript-store";
import {
  subscribeTranscript,
  transcriptSubscriberCount,
} from "./transcript-bus";
import { startTranscriptWatch } from "./transcript-watch";
import type { TranscriptEntry } from "./types";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "transcript-watch-"));
  const store = new TranscriptStore(join(dir, "transcripts.db"));
  const frames: any[] = [];
  const compression: boolean[] = [];
  const socket = {
    onSend: null as null | ((frame: any) => void),
    send(payload: string, compress = false) {
      const frame = JSON.parse(payload);
      frames.push(frame);
      compression.push(compress);
      this.onSend?.(frame);
    },
  };
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, frames, compression, socket };
}

function entry(id: string, content: string): TranscriptEntry {
  return {
    id,
    type: "assistant",
    content,
    timestamp: "2026-07-23T12:00:00.000Z",
  };
}

function watch(
  state: ReturnType<typeof setup>,
  sessionId: string,
  sinceChangeSeq?: number,
  afterResetSnapshot?: () => void,
) {
  return startTranscriptWatch({
    sessionId,
    store: state.store,
    socket: state.socket,
    subscribe: subscribeTranscript,
    isCurrent: () => true,
    ...(sinceChangeSeq === undefined ? {} : { sinceChangeSeq }),
    ...(afterResetSnapshot ? { afterResetSnapshot } : {}),
  });
}

describe("race-free transcript watch", () => {
  test("fresh snapshots skip resume-only cursor reads", async () => {
    const state = setup();
    const sid = `bks-fresh-${crypto.randomUUID()}`;
    state.store.appendTranscriptEvents(sid, [entry("a", "before")]);
    let lastChangeReads = 0;
    let lastResetReads = 0;
    const handle = await startTranscriptWatch({
      sessionId: sid,
      store: {
        getLastChangeSeq(sessionId) {
          lastChangeReads++;
          return state.store.getLastChangeSeq(sessionId);
        },
        getLastResetChangeSeq(sessionId) {
          lastResetReads++;
          return state.store.getLastResetChangeSeq(sessionId);
        },
        readChangesSince: state.store.readChangesSince.bind(state.store),
        readTail: state.store.readTail.bind(state.store),
        readTailWindow: state.store.readTailWindow.bind(state.store),
      },
      socket: state.socket,
      subscribe: subscribeTranscript,
      isCurrent: () => true,
    });
    cleanups.push(() => handle.unsubscribe());

    expect(state.frames[0]?.type).toBe("transcript_init");
    // One baseline belongs to sendSnapshot. The reset cursor is resume-only.
    expect(lastChangeReads).toBe(1);
    expect(lastResetReads).toBe(0);
  });

  test("reconciles an append committed synchronously while init is being sent", async () => {
    const state = setup();
    const sid = `bks-race-${crypto.randomUUID()}`;
    state.store.appendTranscriptEvents(sid, [entry("a", "before")]);
    state.socket.onSend = (frame) => {
      if (frame.type === "transcript_init") {
        state.socket.onSend = null;
        state.store.appendTranscriptEvents(sid, [entry("b", "during")]);
      }
    };

    const handle = await watch(state, sid);
    cleanups.push(() => handle.unsubscribe());

    expect(state.frames.map((frame) => frame.type)).toEqual([
      "transcript_init",
      "transcript_append",
    ]);
    expect(state.frames[1].entries.map((e: TranscriptEntry) => e.id)).toEqual([
      "b",
    ]);
    expect(handle.changeSeq()).toBe(2);
  });

  test("reconnect replays an old-seq rewrite through changeSeq", async () => {
    const state = setup();
    const sid = `bks-rewrite-${crypto.randomUUID()}`;
    state.store.appendTranscriptEvents(sid, [
      entry("old", "v1"),
      entry("new", "later"),
    ]);
    const cursor = state.store.getLastChangeSeq(sid);
    state.store.appendTranscriptEvents(sid, [entry("old", "v2")]);

    const handle = await watch(state, sid, cursor);
    cleanups.push(() => handle.unsubscribe());

    expect(state.frames).toHaveLength(1);
    expect(state.frames[0]).toMatchObject({
      type: "transcript_append",
      lastChangeSeq: 3,
    });
    expect(state.frames[0].entries[0]).toMatchObject({
      id: "old",
      content: "v2",
      seq: 1,
      changeSeq: 3,
    });
  });

  test("duplicate bus wake-ups never duplicate durable changes", async () => {
    const state = setup();
    const sid = `bks-wake-${crypto.randomUUID()}`;
    state.store.markImported(sid, "live-only");
    const handle = await watch(state, sid);
    cleanups.push(() => handle.unsubscribe());
    state.frames.length = 0;

    state.store.appendTranscriptEvents(sid, [entry("a", "one")]);
    // A second subscriber-style wake is represented by another upsert-free
    // notification; reconciliation reads only changeSeq > cursor.
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(state.frames).toHaveLength(1);
    expect(state.frames[0].entries.map((e: TranscriptEntry) => e.id)).toEqual([
      "a",
    ]);
  });

  test("preserves an ordered feed envelope for the matching durable wake", async () => {
    const state = setup();
    const sid = `bks-feed-${crypto.randomUUID()}`;
    state.store.markImported(sid, "live-only");
    const handle = await startTranscriptWatch({
      sessionId: sid,
      store: state.store,
      socket: state.socket,
      subscribe: subscribeTranscript,
      isCurrent: () => true,
      formatAppend(frame, event) {
        return event?.feed ? { ...event.feed, event: frame } : frame;
      },
    });
    cleanups.push(() => handle.unsubscribe());
    state.frames.length = 0;

    state.store.appendTranscriptEvents(sid, [entry("a", "one")]);
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(state.frames[0]).toMatchObject({
      type: "session_feed",
      phase: "committed",
      event: {
        type: "transcript_append",
        lastChangeSeq: 1,
        entries: [expect.objectContaining({ id: "a", changeSeq: 1 })],
      },
    });
  });

  test("unsubscribe is idempotent and releases the bus subscription", async () => {
    const state = setup();
    const sid = `bks-unsub-${crypto.randomUUID()}`;
    const handle = await watch(state, sid);
    expect(transcriptSubscriberCount(sid)).toBe(1);
    handle.unsubscribe();
    handle.unsubscribe();
    expect(transcriptSubscriberCount(sid)).toBe(0);
  });

  test("a failed handshake releases its subscription", async () => {
    const state = setup();
    const sid = `bks-fail-${crypto.randomUUID()}`;
    state.store.appendTranscriptEvents(sid, [entry("a", "one")]);
    state.socket.send = () => {
      throw new Error("socket closed");
    };

    await expect(watch(state, sid)).rejects.toThrow("socket closed");
    expect(transcriptSubscriberCount(sid)).toBe(0);
  });

  test("authoritative replacement sends a fresh complete init", async () => {
    const state = setup();
    const sid = `bks-reset-${crypto.randomUUID()}`;
    let resetSnapshots = 0;
    state.store.appendTranscriptEvents(
      sid,
      Array.from({ length: 30 }, (_, i) => entry(`old-${i}`, String(i))),
    );
    const handle = await watch(state, sid, undefined, () => resetSnapshots++);
    cleanups.push(() => handle.unsubscribe());
    expect(resetSnapshots).toBe(0);
    state.frames.length = 0;

    state.store.replaceTranscriptEvents(sid, [entry("new", "replacement")]);
    await Bun.sleep(0);
    expect(state.frames).toHaveLength(1);
    expect(state.frames[0]).toMatchObject({
      type: "transcript_init",
      entries: [expect.objectContaining({ id: "new", seq: 1 })],
    });
    expect(resetSnapshots).toBe(1);
  });

  test("reconnect from before a missed replacement receives a snapshot", async () => {
    const state = setup();
    const sid = `bks-reset-resume-${crypto.randomUUID()}`;
    state.store.appendTranscriptEvents(sid, [entry("old", "old")]);
    const staleCursor = state.store.getLastChangeSeq(sid);
    state.store.replaceTranscriptEvents(sid, [entry("new", "new")]);

    const handle = await watch(state, sid, staleCursor);
    cleanups.push(() => handle.unsubscribe());
    expect(state.frames).toHaveLength(1);
    expect(state.frames[0]).toMatchObject({
      type: "transcript_init",
      entries: [expect.objectContaining({ id: "new" })],
    });
  });

  test("large snapshots initialize in one frame", async () => {
    const state = setup();
    const sid = `bks-stage-${crypto.randomUUID()}`;
    state.store.appendTranscriptEvents(
      sid,
      Array.from({ length: 140 }, (_, i) => entry(`e${i}`, String(i))),
    );
    const handle = await watch(state, sid);
    expect(state.frames).toHaveLength(1);
    expect(state.frames[0]).toMatchObject({
      type: "transcript_init",
      truncated: true,
      firstSeq: 9,
      lastSeq: 140,
    });
    expect(state.frames[0].entries).toHaveLength(132);
    expect(state.frames[0].entries[0]).toMatchObject({ id: "e8", seq: 9 });
    expect(state.frames[0].entries.at(-1)).toMatchObject({
      id: "e139",
      seq: 140,
    });
    expect(state.compression).toEqual([true]);
    handle.unsubscribe();
    expect(state.frames).toHaveLength(1);
  });

  test("an assistant-heavy tool tail opens with substantial conversation context", async () => {
    // A turn's tools and intermediate assistant notes collapse into one fold.
    // The opening payload should carry enough earlier conversation that later
    // hydration does not have to grow the visible transcript after open.
    const state = setup();
    const sid = `bks-window-${crypto.randomUUID()}`;
    const rows: TranscriptEntry[] = [];
    for (let i = 0; i < 60; i++) {
      rows.push({ ...entry(`msg-${i}`, `question ${i}`), type: "user" });
      rows.push(entry(`ans-${i}`, `answer ${i}`));
    }
    rows.push({ ...entry("current-user", "current question"), type: "user" });
    rows.push(entry("current-start", "I am checking"));
    for (let i = 0; i < 400; i++) {
      rows.push({ ...entry(`tu-${i}`, "Using bash"), type: "tool_use" });
      rows.push({ ...entry(`tr-${i}`, `out ${i}`), type: "tool_result" });
      if (i % 100 === 0) rows.push(entry(`note-${i}`, `note ${i}`));
    }
    rows.push(entry("current-answer", "current answer"));
    state.store.appendTranscriptEvents(sid, rows);

    const handle = await watch(state, sid);
    cleanups.push(() => handle.unsubscribe());

    const sent = state.frames[0].entries as TranscriptEntry[];
    const messages = sent.filter(
      (e) => e.type === "user" || e.type === "assistant",
    );
    const userMessages = sent.filter((e) => e.type === "user");
    expect(sent.length).toBeGreaterThan(132);
    expect(messages.length).toBeGreaterThanOrEqual(100);
    expect(userMessages.length).toBeGreaterThanOrEqual(50);
    expect(sent.some((e) => e.id === "current-user")).toBe(true);
    expect(sent.at(-1)?.id).toBe("current-answer");
    expect(state.frames[0].truncated).toBe(true);
  });

  test("the message floor never shrinks the window below the entry floor", async () => {
    // A chatty session already satisfies the message floor immediately; it
    // must still receive the 132-entry tail it always did.
    const state = setup();
    const sid = `bks-window-chatty-${crypto.randomUUID()}`;
    state.store.appendTranscriptEvents(
      sid,
      Array.from({ length: 300 }, (_, i) => entry(`e${i}`, String(i))),
    );
    const handle = await watch(state, sid);
    cleanups.push(() => handle.unsubscribe());

    expect(state.frames[0].entries).toHaveLength(132);
    expect(state.frames[0]).toMatchObject({ truncated: true, lastSeq: 300 });
  });

  test("a store without the window read still serves the flat tail", async () => {
    // readTailWindow is optional on TranscriptWatchStore; an adapter that
    // does not implement it must degrade to the previous behaviour rather
    // than throw the whole watch.
    const state = setup();
    const sid = `bks-window-legacy-${crypto.randomUUID()}`;
    state.store.appendTranscriptEvents(
      sid,
      Array.from({ length: 200 }, (_, i) => entry(`e${i}`, String(i))),
    );
    const legacy = {
      getLastChangeSeq: (id: string) => state.store.getLastChangeSeq(id),
      getLastResetChangeSeq: (id: string) =>
        state.store.getLastResetChangeSeq(id),
      readChangesSince: (id: string, since: number, limit?: number) =>
        state.store.readChangesSince(id, since, limit),
      readTail: (id: string, limit?: number) => state.store.readTail(id, limit),
    };
    const handle = await startTranscriptWatch({
      sessionId: sid,
      store: legacy,
      socket: state.socket,
      subscribe: subscribeTranscript,
      isCurrent: () => true,
    });
    cleanups.push(() => handle.unsubscribe());

    expect(state.frames[0].entries).toHaveLength(132);
  });

  test("every entry batch is prepared before it goes on the wire", async () => {
    // Store rows are raw: classification (notices.ts) happens on the way out,
    // and a client that only reads the classified form has no second chance.
    // Snapshot, resume append and live append must all go through it.
    const state = setup();
    const sid = `bks-prepare-${crypto.randomUUID()}`;
    const prepareEntries = (entries: any[]) =>
      entries.map((e) => ({ ...e, prepared: true }));
    state.store.appendTranscriptEvents(sid, [entry("a", "snapshot")]);
    const cursor = state.store.getLastChangeSeq(sid);
    state.store.appendTranscriptEvents(sid, [entry("b", "resume")]);

    const handle = await startTranscriptWatch({
      sessionId: sid,
      store: state.store,
      socket: state.socket,
      subscribe: subscribeTranscript,
      isCurrent: () => true,
      sinceChangeSeq: cursor,
      prepareEntries,
    });
    cleanups.push(() => handle.unsubscribe());
    state.store.appendTranscriptEvents(sid, [entry("c", "live")]);
    // The bus fans out on the microtask queue, never inside the write.
    await Bun.sleep(0);

    const sent = state.frames.flatMap((frame) => frame.entries ?? []);
    expect(sent.map((e: any) => e.id)).toEqual(["b", "c"]);
    expect(sent.every((e: any) => e.prepared)).toBe(true);

    // …and the snapshot path too, for a watch that can't resume.
    state.frames.length = 0;
    const fresh = await startTranscriptWatch({
      sessionId: sid,
      store: state.store,
      socket: state.socket,
      subscribe: subscribeTranscript,
      isCurrent: () => true,
      prepareEntries,
    });
    cleanups.push(() => fresh.unsubscribe());
    expect(state.frames[0].type).toBe("transcript_init");
    expect(state.frames[0].entries.every((e: any) => e.prepared)).toBe(true);
  });
});
