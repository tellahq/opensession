import { describe, expect, test } from "bun:test";
import type { TranscriptIndexedRange } from "../../lib/transcript-index";
import {
  transcriptRangesContainPayload,
  visibleTranscriptHydrationDemand,
  type TranscriptHydrationOutlineItem,
} from "./transcript-hydration";

function range(
  key: string,
  seq: number,
  entryIds = [key],
): TranscriptIndexedRange {
  return {
    key,
    firstSeq: seq,
    lastSeq: seq,
    entryIds,
    estimateSize: 100,
    startTimestampMs: seq,
    endTimestampMs: seq,
    headRole: "user",
    reviewPrNumber: null,
    reviewRounds: 0,
  };
}

const ranges = [range("above", 1), range("visible", 2), range("below", 3)];
const outline: TranscriptHydrationOutlineItem[] = ranges.map((item) => ({
  key: item.key,
  ranges: [item],
}));

describe("visible transcript hydration", () => {
  test("does not treat a standalone decoration as loaded indexed history", () => {
    const review = range("review", 1, ["review-entry"]);
    expect(transcriptRangesContainPayload([review], () => false)).toBe(false);
    expect(
      transcriptRangesContainPayload(
        [review, range("tail", 2, ["tail-entry"])],
        (id) => id === "tail-entry",
      ),
    ).toBe(true);
  });

  test("settles when every range in the near-visible window is loaded", () => {
    const loaded = new Set(["above", "visible", "below"]);
    expect(
      visibleTranscriptHydrationDemand(
        outline,
        new Set(["above", "visible", "below"]),
        (id) => loaded.has(id),
      ),
    ).toEqual([]);
  });

  test("does not wait for missing data proven above or below the fold", () => {
    expect(
      visibleTranscriptHydrationDemand(
        outline,
        new Set(["visible"]),
        (id) => id === "visible",
      ),
    ).toEqual([]);
  });

  test("does not hydrate compacted gaps between visible rows", () => {
    expect(
      visibleTranscriptHydrationDemand(
        outline,
        new Set(["above", "below"]),
        (id) => id !== "visible",
      ),
    ).toEqual([]);
  });

  test("waits when a visible structural range is missing newer payload", () => {
    const partial = range("partial", 4, ["loaded", "missing"]);
    expect(
      visibleTranscriptHydrationDemand(
        [{ key: partial.key, ranges: [partial] }],
        new Set([partial.key]),
        (id) => id === "loaded",
      ),
    ).toEqual([partial]);
  });

  test("defers an older missing prefix to explicit top approach", () => {
    const partial = range("partial", 4, ["older", "loaded-1", "loaded-2"]);
    expect(
      visibleTranscriptHydrationDemand(
        [{ key: partial.key, ranges: [partial] }],
        new Set([partial.key]),
        (id) => id.startsWith("loaded"),
      ),
    ).toEqual([]);
  });

  test("does not claim readiness before the virtualizer reports a window", () => {
    expect(
      visibleTranscriptHydrationDemand(outline, new Set(), () => true),
    ).toBeNull();
  });
});
