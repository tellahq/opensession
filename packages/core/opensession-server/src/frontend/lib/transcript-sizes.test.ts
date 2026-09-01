import { beforeEach, describe, expect, test } from "bun:test";
import {
  loadTranscriptSizes,
  resetTranscriptSizes,
  recordTranscriptSizes,
  seededBlockEstimate,
} from "./transcript-sizes";

beforeEach(() => resetTranscriptSizes());

function measure(
  sessionId: string,
  width: number,
  entries: Record<string, number>,
) {
  const cache = loadTranscriptSizes(sessionId);
  recordTranscriptSizes(cache, width, Object.entries(entries));
  return cache;
}

describe("transcript sizes", () => {
  test("round-trips measured heights within a page visit", () => {
    measure("s1", 800, { "range:a": 120.4 });
    expect(loadTranscriptSizes("s1").blockHeights.get("range:a")).toBe(120);
  });

  test("clears a session's heights when the layer width changes", () => {
    measure("s1", 800, { "range:a": 100, "range:b": 200 });
    measure("s1", 390, { "range:c": 90 });
    const cache = loadTranscriptSizes("s1");
    expect(cache.width).toBe(390);
    expect(cache.blockHeights.has("range:a")).toBe(false);
    expect(cache.blockHeights.has("range:b")).toBe(false);
    expect(cache.blockHeights.get("range:c")).toBe(90);
  });

  test("tolerates scrollbar-and-rounding jitter without clearing", () => {
    measure("s1", 800, { "range:a": 100 });
    measure("s1", 801, { "range:b": 140 });
    const cache = loadTranscriptSizes("s1");
    expect(cache.blockHeights.get("range:a")).toBe(100);
    expect(cache.blockHeights.get("range:b")).toBe(140);
  });

  test("ignores non-finite and non-positive measurements", () => {
    const cache = measure("s1", 800, { bad: Number.NaN, zero: 0 });
    expect(cache.blockHeights.size).toBe(0);
    recordTranscriptSizes(cache, Number.NaN, [["k", 10]]);
    expect(cache.blockHeights.size).toBe(0);
  });

  test("evicts the least-recently-used session beyond the cap", () => {
    // Fill the store to exactly its cap.
    for (let index = 0; index < 16; index++) {
      measure(`s${index}`, 800, { k: 100 + index });
    }
    // Re-loading refreshes recency, so s0 outlives its older peers.
    loadTranscriptSizes("s0");
    // One more session pushes past the cap; the oldest untouched entry goes.
    measure("s16", 800, { k: 16 });
    expect(loadTranscriptSizes("s0").blockHeights.get("k")).toBe(100);
    expect(loadTranscriptSizes("s16").blockHeights.get("k")).toBe(16);
    expect(loadTranscriptSizes("s1").blockHeights.size).toBe(0);
    expect(loadTranscriptSizes("s15").blockHeights.get("k")).toBe(115);
  });
});

describe("seededBlockEstimate", () => {
  test("prefers a positive measured seed over the heuristic", () => {
    const cache = loadTranscriptSizes("seeded");
    cache.blockHeights.set("k", 312);
    expect(seededBlockEstimate(96, cache, "k")).toBe(312);
  });

  test("falls back to the heuristic without a usable seed", () => {
    expect(seededBlockEstimate(96, undefined, "k")).toBe(96);
    expect(seededBlockEstimate(96, loadTranscriptSizes("empty"), "k")).toBe(96);
  });
});
