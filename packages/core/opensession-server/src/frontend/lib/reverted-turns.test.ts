import { expect, test } from "bun:test";
import { revertedEntryIds } from "./reverted-turns";
import type { TranscriptEntry } from "./types";
const entry = (id: string, seq: number): TranscriptEntry => ({
  id,
  seq,
  type: "user",
  content: "prompt",
  timestamp: "2026-01-01T00:00:00Z",
});
test("latest marker dims unloaded-history ranges and never dims the audit notice", () => {
  const marker: TranscriptEntry = {
    ...entry("revert", 4),
    type: "system",
    turnRevert: {
      intentId: "one",
      operation: "revert",
      fromSeq: 2,
      toSeq: 3,
      activeRanges: [{ fromSeq: 2, toSeq: 3 }],
    },
  };
  expect([
    ...revertedEntryIds([
      entry("one", 1),
      entry("two", 2),
      entry("three", 3),
      marker,
    ]),
  ]).toEqual(["two", "three"]);
});
test("undo's authoritative ranges clear even stale locally derived flags", () => {
  const old = { ...entry("one", 1), reverted: true };
  const undone: TranscriptEntry = {
    ...entry("undo", 4),
    type: "system",
    turnRevert: {
      intentId: "two",
      operation: "undo",
      fromSeq: 1,
      toSeq: 3,
      activeRanges: [],
    },
  };
  expect(revertedEntryIds([old, undone]).size).toBe(0);
});
