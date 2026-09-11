import { describe, expect, test } from "bun:test";
import { VoiceCaptionStore, parseVoiceRowId } from "./voice-captions";

const captions = (store: VoiceCaptionStore) =>
  store.getSnapshot().captions.map(({ role, text }) => ({ role, text }));

describe("parseVoiceRowId", () => {
  test("reads the role and row start out of a mirrored voice row id", () => {
    expect(parseVoiceRowId("voice-live_abc-assistant-1200-end-1800")).toEqual({
      callId: "live_abc",
      role: "assistant",
      startMs: 1200,
      endMs: 1800,
    });
    expect(parseVoiceRowId("voice-live_a-b-c-user-0-end-950")).toEqual({
      callId: "live_a-b-c",
      role: "user",
      startMs: 0,
      endMs: 950,
    });
  });

  test("reads a legacy id without the row's end", () => {
    expect(parseVoiceRowId("voice-live_abc-assistant-1200")).toEqual({
      callId: "live_abc",
      role: "assistant",
      startMs: 1200,
      endMs: null,
    });
  });

  test("does not match typed messages or ordinary entries", () => {
    expect(parseVoiceRowId("voice-typed-3f2a")).toBeNull();
    expect(parseVoiceRowId("e123")).toBeNull();
    expect(parseVoiceRowId("voice-live_abc-user-0-end-")).toBeNull();
  });
});

describe("VoiceCaptionStore with the row's end in its id", () => {
  test("a rewritten row still takes its fragments down", () => {
    // The server links what the Desk said to PRs and sessions before
    // mirroring it (desk-voice-refs.ts), so the durable text no longer
    // matches the spoken fragments. The id's span settles it instead.
    const store = new VoiceCaptionStore();
    store.start("live_abc");
    store.push({
      role: "assistant",
      delta: "I opened PR ",
      startMs: 900,
      endMs: 1300,
    });
    store.push({
      role: "assistant",
      delta: "forty two.",
      startMs: 1300,
      endMs: 1800,
    });
    expect(captions(store)).toEqual([
      { role: "assistant", text: "I opened PR forty two." },
    ]);
    store.land({
      id: "voice-live_abc-assistant-900-end-1800",
      type: "assistant",
      content: "I opened PR opensession#42.",
    });
    expect(captions(store)).toEqual([]);
    expect(store.hasCaptions()).toBe(false);
  });

  test("late fragments inside the span stay hidden, the next row shows", () => {
    const store = new VoiceCaptionStore();
    store.start("live_abc");
    store.land({
      id: "voice-live_abc-assistant-900-end-1800",
      type: "assistant",
      content: "I opened PR opensession#42.",
    });
    store.push({
      role: "assistant",
      delta: "I opened PR ",
      startMs: 900,
      endMs: 1300,
    });
    store.push({
      role: "assistant",
      delta: "forty two.",
      startMs: 1300,
      endMs: 1800,
    });
    // Starts exactly at the row's end: the server joined it into that row.
    store.push({
      role: "assistant",
      delta: " Done.",
      startMs: 1800,
      endMs: 2000,
    });
    expect(captions(store)).toEqual([]);
    store.push({
      role: "assistant",
      delta: "Anything else?",
      startMs: 5000,
      endMs: 5600,
    });
    expect(captions(store)).toEqual([
      { role: "assistant", text: "Anything else?" },
    ]);
  });

  test("the row only covers its own span, not the tail after it", () => {
    const store = new VoiceCaptionStore();
    store.start("live_abc");
    store.push({ role: "user", delta: "What is", startMs: 1000, endMs: 1200 });
    store.push({
      role: "user",
      delta: " running?",
      startMs: 1200,
      endMs: 1800,
    });
    store.push({ role: "user", delta: "Also,", startMs: 5000, endMs: 5300 });
    store.land({
      id: "voice-live_abc-user-1000-end-1800",
      type: "user",
      content: "What is running?",
    });
    expect(captions(store)).toEqual([{ role: "user", text: "Also," }]);
  });

  test("an older row cannot cover fragments of the latest settled row", () => {
    const store = new VoiceCaptionStore();
    store.start("live_abc");
    store.land({
      id: "voice-live_abc-assistant-3000-end-3500",
      type: "assistant",
      content: "Latest.",
    });
    store.push({
      role: "assistant",
      delta: "Next",
      startMs: 6000,
      endMs: 6300,
    });
    store.land({
      id: "voice-live_abc-assistant-1000-end-9000",
      type: "assistant",
      content: "Older.",
    });
    expect(captions(store)).toEqual([{ role: "assistant", text: "Next" }]);
  });
});

describe("VoiceCaptionStore", () => {
  test("shows each speaker's fragments as they arrive, in start order", () => {
    const store = new VoiceCaptionStore();
    store.start("live_abc");
    let notified = 0;
    store.subscribe(() => notified++);
    store.push({ role: "user", delta: "What is", startMs: 0, endMs: 300 });
    store.push({ role: "user", delta: " running?", startMs: 300, endMs: 800 });
    store.push({ role: "assistant", delta: "Two ", startMs: 900, endMs: 1100 });
    store.push({
      role: "assistant",
      delta: "sessions.",
      startMs: 1100,
      endMs: 1800,
    });
    expect(captions(store)).toEqual([
      { role: "user", text: "What is running?" },
      { role: "assistant", text: "Two sessions." },
    ]);
    expect(notified).toBe(4);
    expect(store.hasCaptions()).toBe(true);
  });

  test("a mirrored row takes exactly its own fragments down and keeps the rest", () => {
    const store = new VoiceCaptionStore();
    store.start("live_abc");
    store.push({ role: "user", delta: "What is", startMs: 1000, endMs: 1200 });
    store.push({
      role: "user",
      delta: " running?",
      startMs: 1200,
      endMs: 1800,
    });
    // Past the server's gap: this fragment opens a new row there.
    store.push({ role: "user", delta: "Also,", startMs: 5000, endMs: 5300 });
    store.land({
      id: "voice-live_abc-user-1000",
      type: "user",
      content: "What is running?",
    });
    expect(captions(store)).toEqual([{ role: "user", text: "Also," }]);
    store.land({
      id: "voice-live_abc-user-5000",
      type: "user",
      content: "Also,",
    });
    expect(captions(store)).toEqual([]);
    expect(store.hasCaptions()).toBe(false);
  });

  test("ignores typed messages, other roles and rows it never saw", () => {
    const store = new VoiceCaptionStore();
    store.start("live_abc");
    store.push({ role: "user", delta: "wait", startMs: 400, endMs: 700 });
    store.land({ id: "voice-typed-3f2a", type: "user", content: "wait" });
    store.land({
      id: "voice-live_abc-assistant-400",
      type: "assistant",
      content: "wait",
    });
    store.land({ id: "voice-live_abc-user-9", type: "user", content: "wait" });
    store.land({ id: "e77", type: "user", content: "wait" });
    expect(captions(store)).toEqual([{ role: "user", text: "wait" }]);
  });

  test("a later row also clears stale fragments left ahead of it", () => {
    const store = new VoiceCaptionStore();
    store.start("live_abc");
    store.push({ role: "assistant", delta: "stale", startMs: 100, endMs: 400 });
    store.push({
      role: "assistant",
      delta: "Sure.",
      startMs: 3000,
      endMs: 3400,
    });
    store.push({
      role: "assistant",
      delta: " Next",
      startMs: 6000,
      endMs: 6300,
    });
    store.land({
      id: "voice-live_abc-assistant-3000",
      type: "assistant",
      content: "Sure.",
    });
    expect(captions(store)).toEqual([{ role: "assistant", text: "Next" }]);
  });

  test("a row the browser has only part of supersedes what it holds", () => {
    const store = new VoiceCaptionStore();
    store.start("live_abc");
    store.push({ role: "assistant", delta: "Two ", startMs: 900, endMs: 1100 });
    store.land({
      id: "voice-live_abc-assistant-900",
      type: "assistant",
      content: "Two sessions.",
    });
    expect(captions(store)).toEqual([]);
  });

  test("whitespace-only fragments show nothing", () => {
    const store = new VoiceCaptionStore();
    store.start("live_abc");
    store.push({ role: "user", delta: "  ", startMs: 0, endMs: 100 });
    store.push({ role: "assistant", delta: "", startMs: 0, endMs: 100 });
    expect(captions(store)).toEqual([]);
    expect(store.hasCaptions()).toBe(false);
  });

  test("the call's end keeps the tails for the grace, then clears them", async () => {
    const store = new VoiceCaptionStore({ endGraceMs: 20 });
    store.start("live_abc");
    store.push({ role: "assistant", delta: "Bye.", startMs: 0, endMs: 300 });
    store.end();
    expect(captions(store)).toEqual([{ role: "assistant", text: "Bye." }]);
    // The mirrored row lands within the grace: the caption goes with it.
    store.land({
      id: "voice-live_abc-assistant-0",
      type: "assistant",
      content: "Bye.",
    });
    expect(captions(store)).toEqual([]);
    store.push({
      role: "user",
      delta: "never mirrored",
      startMs: 500,
      endMs: 900,
    });
    store.end();
    await Bun.sleep(40);
    expect(captions(store)).toEqual([]);
  });

  test("a new call clears captions and ignores the previous call's rows", async () => {
    const store = new VoiceCaptionStore({ endGraceMs: 20 });
    store.start("old");
    store.push({ role: "assistant", delta: "Bye.", startMs: 0, endMs: 300 });
    store.end();
    store.start("new");
    store.push({
      role: "assistant",
      delta: "Hi again",
      startMs: 0,
      endMs: 300,
    });
    store.land({
      id: "voice-old-assistant-0",
      type: "assistant",
      content: "Bye.",
    });
    await Bun.sleep(40);
    expect(captions(store)).toEqual([{ role: "assistant", text: "Hi again" }]);
    store.clear();
  });

  test("late RTC fragments never resurrect a row that landed first", () => {
    const store = new VoiceCaptionStore();
    store.start("live_abc");
    store.land({
      id: "voice-live_abc-assistant-900",
      type: "assistant",
      content: "Two sessions.",
    });
    store.push({ role: "assistant", delta: "Two ", startMs: 900, endMs: 1100 });
    expect(captions(store)).toEqual([]);
    store.push({
      role: "assistant",
      delta: "sessions.",
      startMs: 1100,
      endMs: 1800,
    });
    expect(captions(store)).toEqual([]);
    store.push({
      role: "assistant",
      delta: " Next reply.",
      startMs: 5000,
      endMs: 5500,
    });
    expect(captions(store)).toEqual([
      { role: "assistant", text: "Next reply." },
    ]);
  });

  test("a partial caption stays hidden when the remainder arrives after its row", () => {
    const store = new VoiceCaptionStore();
    store.start("live_abc");
    store.push({ role: "assistant", delta: "Two ", startMs: 900, endMs: 1100 });
    store.land({
      id: "voice-live_abc-assistant-900",
      type: "assistant",
      content: "Two sessions.",
    });
    store.push({
      role: "assistant",
      delta: "sessions.",
      startMs: 1100,
      endMs: 1800,
    });
    expect(captions(store)).toEqual([]);
  });

  test("history replay and old deltas cannot replace the latest settled row", () => {
    const store = new VoiceCaptionStore();
    store.start("live_abc");
    store.land({
      id: "voice-live_abc-assistant-3000",
      type: "assistant",
      content: "Latest.",
    });
    store.land({
      id: "voice-live_abc-assistant-1000",
      type: "assistant",
      content: "Older.",
    });
    store.push({
      role: "assistant",
      delta: "Older.",
      startMs: 1000,
      endMs: 1500,
    });
    store.push({
      role: "assistant",
      delta: "Latest.",
      startMs: 3000,
      endMs: 3500,
    });
    expect(captions(store)).toEqual([]);
  });
});
