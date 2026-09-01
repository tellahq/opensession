import type { TranscriptEntry } from "./types";

/** One interactive history page. The server caps seq pages at 500 entries. */
export const HISTORY_PAGE_ENTRIES = 500;

/**
 * A page can be hundreds of tool rows inside one collapsed turn. Keep walking
 * until the reader gets a visible conversation boundary, but do not turn an
 * ordinary upward scroll into an unbounded "load all" request.
 */
export const HISTORY_REVEAL_MAX_ENTRIES = 2_000;

export interface HistoryRevealPage {
  entries: TranscriptEntry[];
  truncated: boolean;
  loaded: number;
  cursor: number | null;
  previousCursor: number | null;
}

/**
 * Prepared history pages contain no hidden context-injection records. A user
 * or system entry therefore starts a rendered block outside the folded work
 * turn and makes the newly loaded history visible at the top of the timeline.
 */
export function historyPageHasVisibleBoundary(
  entries: TranscriptEntry[],
): boolean {
  return entries.some(
    (entry) => entry.type === "user" || entry.type === "system",
  );
}

export function shouldContinueHistoryReveal(page: HistoryRevealPage): boolean {
  return (
    page.truncated &&
    page.entries.length > 0 &&
    !historyPageHasVisibleBoundary(page.entries) &&
    page.loaded < HISTORY_REVEAL_MAX_ENTRIES &&
    page.cursor !== null &&
    page.cursor !== page.previousCursor
  );
}
