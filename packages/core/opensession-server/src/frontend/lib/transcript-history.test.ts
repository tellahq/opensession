import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "./types";
import {
  HISTORY_REVEAL_MAX_ENTRIES,
  historyPageHasVisibleBoundary,
  shouldContinueHistoryReveal,
} from "./transcript-history";

function entry(id: string, type: TranscriptEntry["type"]): TranscriptEntry {
  return {
    id,
    type,
    content: id,
    timestamp: "2026-08-19T12:00:00.000Z",
  };
}

describe("history reveal paging", () => {
  test("keeps walking when a page only extends a folded work turn", () => {
    const entries = [
      entry("note", "assistant"),
      entry("call", "tool_use"),
      entry("result", "tool_result"),
    ];
    expect(historyPageHasVisibleBoundary(entries)).toBe(false);
    expect(
      shouldContinueHistoryReveal({
        entries,
        truncated: true,
        loaded: entries.length,
        cursor: 80,
        previousCursor: 120,
      }),
    ).toBe(true);
  });

  test("stops as soon as the page reaches a visible conversation boundary", () => {
    for (const type of ["user", "system"] as const) {
      const entries = [entry("boundary", type), entry("call", "tool_use")];
      expect(historyPageHasVisibleBoundary(entries)).toBe(true);
      expect(
        shouldContinueHistoryReveal({
          entries,
          truncated: true,
          loaded: entries.length,
          cursor: 80,
          previousCursor: 120,
        }),
      ).toBe(false);
    }
  });

  test("stops at the backlog, a stalled cursor, or the reveal ceiling", () => {
    const entries = [entry("call", "tool_use")];
    const base = {
      entries,
      truncated: true,
      loaded: entries.length,
      cursor: 80,
      previousCursor: 120,
    };
    expect(shouldContinueHistoryReveal({ ...base, truncated: false })).toBe(
      false,
    );
    expect(shouldContinueHistoryReveal({ ...base, cursor: 120 })).toBe(false);
    expect(
      shouldContinueHistoryReveal({
        ...base,
        loaded: HISTORY_REVEAL_MAX_ENTRIES,
      }),
    ).toBe(false);
  });
});
