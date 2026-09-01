import { describe, expect, test } from "bun:test";
import type { TranscriptIndexEntry } from "@tellahq/opensession-protocol/session";
import {
  buildTranscriptRanges,
  mergeTranscriptIndexEntries,
} from "./transcript-index";

const row = (
  seq: number,
  role: TranscriptIndexEntry["role"],
  extra: Partial<TranscriptIndexEntry> = {},
): TranscriptIndexEntry => ({
  id: `e${seq}`,
  seq,
  changeSeq: seq,
  timestampMs: seq * 1000,
  role,
  contentLength: 20,
  ...extra,
});

describe("buildTranscriptRanges", () => {
  test("builds stable user turns across unloaded tool rows", () => {
    const ranges = buildTranscriptRanges([
      row(1, "user"),
      row(2, "assistant"),
      row(3, "tool_use"),
      row(4, "tool_result"),
      row(5, "assistant"),
      row(6, "user"),
    ]);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toMatchObject({
      firstSeq: 1,
      lastSeq: 5,
      headRole: "user",
      entryIds: ["e1", "e2", "e3", "e4", "e5"],
    });
    expect(ranges[1]).toMatchObject({ firstSeq: 6, lastSeq: 6 });
  });

  test("keeps hidden seqs in fetch coverage without rendering an item", () => {
    const ranges = buildTranscriptRanges([
      row(1, "hidden"),
      row(2, "user"),
      row(3, "hidden"),
      row(4, "assistant"),
    ]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ firstSeq: 2, lastSeq: 4 });
    expect(ranges[0].entryIds).toEqual(["e2", "e4"]);
  });

  test("retains review metadata for client-side loop grouping", () => {
    const [range] = buildTranscriptRanges([
      row(1, "review_handoff", { reviewPrNumber: 42 }),
      row(2, "assistant"),
    ]);
    expect(range).toMatchObject({
      headRole: "review_handoff",
      reviewPrNumber: 42,
      reviewRounds: 1,
    });
  });
});

describe("mergeTranscriptIndexEntries", () => {
  test("keeps newer changeSeq data when frames arrive out of order", () => {
    const newer = row(1, "user", { changeSeq: 4 });
    expect(
      mergeTranscriptIndexEntries(
        [newer],
        [row(1, "assistant", { changeSeq: 3 })],
      ),
    ).toEqual([newer]);
  });
});
