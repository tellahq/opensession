import { describe, expect, test } from "bun:test";
import {
  historyPageRequest,
  scrolledTowardHistory,
  shouldConsumeHistoryGesture,
  shouldJumpOnVisibilityResume,
  transcriptSnapshotGrew,
  type TranscriptCursor,
  type TranscriptSequence,
} from "./transcript-history-controller";

const sequence: TranscriptSequence = {
  sessionId: "session-1",
  lastSeq: 900,
  firstSeq: 401,
  lastChangeSeq: 12,
};
const cursor: TranscriptCursor = {
  sessionId: "session-1",
  rev: "rev-1",
  offset: 8_000,
};
const limits = { page: 500, whole: 4_000 };

describe("history page requests", () => {
  test("uses the earliest sequence for indexed paging", () => {
    expect(
      historyPageRequest({
        sessionId: "session-1",
        whole: false,
        sequence,
        cursor,
        historyStart: 4_000,
        limits,
      }),
    ).toEqual({
      type: "load_history",
      sessionId: "session-1",
      beforeSeq: 401,
      limit: 500,
    });
    expect(
      historyPageRequest({
        sessionId: "session-1",
        whole: true,
        sequence,
        cursor,
        historyStart: 4_000,
        limits,
      }),
    ).toEqual({
      type: "load_history",
      sessionId: "session-1",
      beforeSeq: 401,
      limit: 4_000,
    });
  });

  test("keeps legacy whole-history requests cursorless", () => {
    expect(
      historyPageRequest({
        sessionId: "session-1",
        whole: false,
        sequence: null,
        cursor,
        historyStart: 4_000,
        limits,
      }),
    ).toEqual({
      type: "load_history",
      sessionId: "session-1",
      beforeOffset: 4_000,
      beforeRev: "rev-1",
    });
    expect(
      historyPageRequest({
        sessionId: "session-1",
        whole: true,
        sequence: null,
        cursor,
        historyStart: 4_000,
        limits,
      }),
    ).toEqual({ type: "load_history", sessionId: "session-1" });
  });

  test("ignores cursors owned by another session", () => {
    expect(
      historyPageRequest({
        sessionId: "session-2",
        whole: false,
        sequence,
        cursor,
        historyStart: 4_000,
        limits,
      }),
    ).toEqual({
      type: "load_history",
      sessionId: "session-2",
      beforeOffset: 4_000,
      beforeRev: undefined,
    });
  });
});

describe("history scroll intent", () => {
  test("requires a meaningful upward move", () => {
    expect(scrolledTowardHistory(800, 798)).toBe(true);
    expect(scrolledTowardHistory(800, 799)).toBe(false);
    expect(scrolledTowardHistory(800, 900)).toBe(false);
  });

  test("consumes an active gesture only near loaded history", () => {
    const intent = {
      previousScrollTop: 700,
      currentScrollTop: 590,
      consumed: false,
      gestureUntil: 2_000,
      now: 1_500,
    };
    expect(shouldConsumeHistoryGesture(intent)).toBe(true);
    expect(
      shouldConsumeHistoryGesture({ ...intent, currentScrollTop: 601 }),
    ).toBe(false);
    expect(shouldConsumeHistoryGesture({ ...intent, consumed: true })).toBe(
      false,
    );
    expect(shouldConsumeHistoryGesture({ ...intent, now: 2_001 })).toBe(false);
  });
});

describe("visibility resume", () => {
  const hidden = { at: 1_000, lastEntryId: "entry-1", streamLen: 20 };

  test("detects durable and streaming growth", () => {
    expect(
      transcriptSnapshotGrew(hidden, {
        lastEntryId: "entry-2",
        streamLen: 20,
      }),
    ).toBe(true);
    expect(
      transcriptSnapshotGrew(hidden, {
        lastEntryId: "entry-1",
        streamLen: 21,
      }),
    ).toBe(true);
    expect(transcriptSnapshotGrew(hidden, hidden)).toBe(false);
  });

  test("treats a long background interval as a reopen", () => {
    expect(
      shouldJumpOnVisibilityResume({
        hidden,
        current: hidden,
        now: 30_999,
        reopenAfterMs: 30_000,
      }),
    ).toBe(false);
    expect(
      shouldJumpOnVisibilityResume({
        hidden,
        current: hidden,
        now: 31_000,
        reopenAfterMs: 30_000,
      }),
    ).toBe(true);
  });
});
