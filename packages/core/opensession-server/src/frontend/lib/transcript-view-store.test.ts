import { describe, expect, test } from "bun:test";
import { TranscriptViewStore } from "./transcript-view-store";
import type { TranscriptEntry } from "./types";

const entry = (
  id: string,
  timestamp = `2026-01-01T00:00:0${id}.000Z`,
): TranscriptEntry => ({
  id,
  type: "assistant",
  content: id,
  timestamp,
});

describe("TranscriptViewStore", () => {
  test("upserts without replacing untouched entries", () => {
    const a = entry("1");
    const b = entry("2");
    const store = new TranscriptViewStore([a, b]);
    const nextB = { ...b, content: "updated" };
    store.merge([nextB]);
    expect(store.getSnapshot()[0]).toBe(a);
    expect(store.getSnapshot()[1]).toBe(nextB);
  });

  test("publishes durable appends immediately when their index updates with them", () => {
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (_callback: FrameRequestCallback) => 1;
    globalThis.cancelAnimationFrame = (_handle: number) => {};
    try {
      const store = new TranscriptViewStore([entry("1")]);
      store.merge([entry("2")]);
      expect(store.getSnapshot().map((item) => item.id)).toEqual(["1"]);
      store.merge([entry("2")], false, true);
      expect(store.getSnapshot().map((item) => item.id)).toEqual(["1", "2"]);
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancel;
    }
  });

  test("prepends older entries in timestamp order", () => {
    const store = new TranscriptViewStore([entry("2")]);
    store.prepend([entry("1")]);
    expect(store.getSnapshot().map((item) => item.id)).toEqual(["1", "2"]);
  });

  test("reorders a live tool result when its durable seq arrives", () => {
    const store = new TranscriptViewStore([
      { ...entry("1"), seq: 1, changeSeq: 1 },
      { ...entry("3"), seq: 3, changeSeq: 3 },
    ]);
    store.merge([{ ...entry("2"), changeSeq: 2 }], false, true);
    expect(store.getSnapshot().map((item) => item.id)).toEqual(["1", "3", "2"]);
    store.merge([{ ...entry("2"), seq: 2, changeSeq: 4 }], true, true);
    expect(store.getSnapshot().map((item) => item.id)).toEqual(["1", "2", "3"]);
  });

  test("splices a sequenced range into the loaded seq gap", () => {
    const store = new TranscriptViewStore([
      { ...entry("1"), seq: 1, changeSeq: 1 },
      { ...entry("3"), seq: 3, changeSeq: 3 },
      { ...entry("5"), seq: 5, changeSeq: 5 },
    ]);

    store.mergeRange(
      [
        { ...entry("4"), seq: 4, changeSeq: 4 },
        { ...entry("3"), content: "updated", seq: 3, changeSeq: 6 },
        { ...entry("2"), seq: 2, changeSeq: 2 },
      ],
      true,
    );

    expect(store.getSnapshot().map((item) => item.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(store.getSnapshot()[2].content).toBe("updated");
  });

  test("linearly merges a sequenced range around existing decorations", () => {
    const store = new TranscriptViewStore([
      { ...entry("1", "2026-01-01T00:00:01.000Z"), seq: 1 },
      entry("decoration", "2026-01-01T00:00:02.500Z"),
      { ...entry("4", "2026-01-01T00:00:04.000Z"), seq: 4 },
    ]);

    store.mergeRange(
      [
        { ...entry("3", "2026-01-01T00:00:03.000Z"), seq: 3 },
        { ...entry("2", "2026-01-01T00:00:02.000Z"), seq: 2 },
      ],
      true,
    );

    expect(store.getSnapshot().map((item) => item.id)).toEqual([
      "1",
      "2",
      "decoration",
      "3",
      "4",
    ]);
  });

  test("moves a live decoration onto the seq spine during range hydration", () => {
    const live = {
      ...entry("2", "2026-01-01T00:00:02.000Z"),
      changeSeq: 2,
    };
    const store = new TranscriptViewStore([
      { ...entry("1"), seq: 1, changeSeq: 1 },
      live,
      { ...entry("3"), seq: 3, changeSeq: 3 },
    ]);

    store.mergeRange([{ ...live, seq: 2, changeSeq: 4 }], true);
    store.mergeRange(
      [{ ...live, content: "stale", seq: 2, changeSeq: 2 }],
      true,
    );

    expect(store.getSnapshot().map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(store.getSnapshot()[1].content).toBe("2");
  });

  test("rejects delayed mutations and orders v2 entries by immutable seq", () => {
    const store = new TranscriptViewStore([
      { ...entry("2"), seq: 2, changeSeq: 2 },
    ]);
    store.merge([{ ...entry("1"), seq: 1, changeSeq: 3 }], true);
    store.merge(
      [{ ...entry("2"), content: "stale", seq: 2, changeSeq: 1 }],
      true,
    );

    expect(store.getSnapshot().map((item) => item.id)).toEqual(["1", "2"]);
    expect(store.getSnapshot()[1].content).toBe("2");
  });
});
