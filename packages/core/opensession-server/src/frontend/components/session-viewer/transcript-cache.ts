import type { TranscriptIndexEntry } from "@tellahq/opensession-protocol/session";
import type { TranscriptEntry } from "../../lib/types";

export type CachedTranscriptView = {
  entries: TranscriptEntry[];
  cursor: { sessionId: string; rev: string; offset: number } | null;
  /** Transcript v2 seq-mode state (null = legacy mode), so a session
   *  switch-back resumes with sinceSeq instead of re-snapshotting. */
  seq: {
    sessionId: string;
    lastSeq: number;
    firstSeq: number | null;
    lastChangeSeq: number;
  } | null;
  historyTruncated: boolean;
  historyStart: number | null;
  index: TranscriptIndexEntry[] | null;
  indexEpoch: number | null;
};

// SessionViewer remounts on navigation. Keep a small LRU of the expensive
// transcript view state so moving between nearby sessions is instant without
// retaining an unbounded workday's worth of conversations in the browser.
const transcriptViewCache = new Map<string, CachedTranscriptView>();
const TRANSCRIPT_VIEW_CACHE_MAX = 6;

export function cachedTranscriptView(
  sessionId: string,
): CachedTranscriptView | null {
  const hit = transcriptViewCache.get(sessionId);
  if (!hit) return null;
  transcriptViewCache.delete(sessionId);
  transcriptViewCache.set(sessionId, hit);
  return hit;
}

export function peekCachedTranscriptView(
  sessionId: string,
): CachedTranscriptView | null {
  return transcriptViewCache.get(sessionId) ?? null;
}

export function cacheTranscriptView(
  sessionId: string,
  view: CachedTranscriptView,
) {
  transcriptViewCache.delete(sessionId);
  transcriptViewCache.set(sessionId, view);
  while (transcriptViewCache.size > TRANSCRIPT_VIEW_CACHE_MAX) {
    const oldest = transcriptViewCache.keys().next().value;
    if (oldest === undefined) break;
    transcriptViewCache.delete(oldest);
  }
}

/**
 * Paint a duplicate with the conversation it copies before the server has
 * created it. The source is the session on screen, so its view is cached; the
 * copy stops at `throughEntryId` like the server's. It carries no cursor or
 * index, so the duplicate's first watch replaces it with the server's own
 * snapshot. Model-switch dividers are woven in from the source's own model
 * history, which the duplicate does not inherit, so they stay behind. False
 * when there is nothing to show.
 */
export function seedDuplicateTranscriptView(
  sourceId: string,
  duplicateId: string,
  throughEntryId?: string,
): boolean {
  const source = peekCachedTranscriptView(sourceId);
  if (!source?.entries.length) return false;
  const end =
    throughEntryId === undefined
      ? source.entries.length
      : source.entries.findIndex((entry) => entry.id === throughEntryId) + 1;
  if (end <= 0) return false;
  cacheTranscriptView(duplicateId, {
    entries: source.entries
      .slice(0, end)
      .filter((entry) => !entry.id.startsWith("model-switch-")),
    cursor: null,
    seq: null,
    historyTruncated: false,
    historyStart: null,
    index: null,
    indexEpoch: null,
  });
  return true;
}
