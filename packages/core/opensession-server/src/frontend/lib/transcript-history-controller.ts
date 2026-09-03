import type { WSClientMessage } from "./types";

export type TranscriptCursor = {
  sessionId: string;
  rev: string;
  offset: number;
};

export type TranscriptSequence = {
  sessionId: string;
  lastSeq: number;
  firstSeq: number | null;
  lastChangeSeq: number;
};

export type HistoryWalk = {
  sessionId: string;
  loaded: number;
  cursor: number | null;
};

export type TranscriptVisibilitySnapshot = {
  lastEntryId: string | null;
  streamLen: number;
};

export type HiddenTranscriptSnapshot = TranscriptVisibilitySnapshot & {
  at: number;
};

export type ResumeTranscriptWatch = TranscriptVisibilitySnapshot & {
  until: number;
};

type LoadHistoryMessage = Extract<WSClientMessage, { type: "load_history" }>;

export function historyPageRequest({
  sessionId,
  whole,
  sequence,
  cursor,
  historyStart,
  limits,
}: {
  sessionId: string;
  whole: boolean;
  sequence: TranscriptSequence | null;
  cursor: TranscriptCursor | null;
  historyStart: number | null;
  limits: { page: number; whole: number };
}): LoadHistoryMessage {
  if (sequence?.sessionId === sessionId) {
    const request: LoadHistoryMessage = {
      type: "load_history",
      sessionId,
      limit: whole ? limits.whole : limits.page,
    };
    if (sequence.firstSeq !== null && sequence.firstSeq > 1) {
      request.beforeSeq = sequence.firstSeq;
    }
    return request;
  }
  const request: LoadHistoryMessage = {
    type: "load_history",
    sessionId,
  };
  if (!whole && historyStart !== null && historyStart > 0) {
    request.beforeOffset = historyStart;
    request.beforeRev =
      cursor?.sessionId === sessionId ? cursor.rev : undefined;
  }
  return request;
}

export function transcriptSnapshotGrew(
  previous: TranscriptVisibilitySnapshot,
  current: TranscriptVisibilitySnapshot,
): boolean {
  return (
    current.lastEntryId !== previous.lastEntryId ||
    current.streamLen > previous.streamLen
  );
}

export function shouldJumpOnVisibilityResume({
  hidden,
  current,
  now,
  reopenAfterMs,
}: {
  hidden: HiddenTranscriptSnapshot;
  current: TranscriptVisibilitySnapshot;
  now: number;
  reopenAfterMs: number;
}): boolean {
  return (
    transcriptSnapshotGrew(hidden, current) || now - hidden.at >= reopenAfterMs
  );
}

export function scrolledTowardHistory(
  previousScrollTop: number,
  currentScrollTop: number,
): boolean {
  return currentScrollTop < previousScrollTop - 1;
}

export function shouldConsumeHistoryGesture({
  previousScrollTop,
  currentScrollTop,
  consumed,
  gestureUntil,
  now,
}: {
  previousScrollTop: number;
  currentScrollTop: number;
  consumed: boolean;
  gestureUntil: number;
  now: number;
}): boolean {
  return (
    scrolledTowardHistory(previousScrollTop, currentScrollTop) &&
    currentScrollTop <= 600 &&
    !consumed &&
    now <= gestureUntil
  );
}
