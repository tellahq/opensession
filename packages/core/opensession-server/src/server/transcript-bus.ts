/**
 * Transcript v2 in-process bus (docs/transcripts.md §2).
 *
 * Pub/sub keyed by UNIFIED session id (bks-… / slack-… / …): the transcript store
 * publishes post-commit append/upsert batches here, and v2 WebSocket watchers
 * subscribe instead of polling the mirror jsonl. State is parked on
 * `globalThis.__osTranscriptBus` so `bun --hot` reloads keep live
 * subscriptions (same pattern as ws-hub/queue-state).
 *
 * Contract:
 *  - `subscribeTranscript(sessionId, fn)` returns an unsubscribe function.
 *    Call it exactly once from every teardown path (double-unsub is a no-op).
 *  - `publishTranscript(sessionId, payload)` assigns and fans out the feed
 *    frame in one microtask. This keeps feed sequence aligned with delivery:
 *    a synchronous stream event sent before that microtask must sort before
 *    the committed frame too. Subscriber errors stay isolated.
 *  - Zero runtime imports from engine/run-rpc/session modules (the only
 *    import below is type-only and erased at compile time) — this module is
 *    safe to import from tests and from anywhere in the server graph.
 */

import type { TranscriptEntry } from "./types";
import { appendSessionFeed, type SessionFeedFrame } from "./session-feed";

/** A stored transcript entry annotated with its per-session sequence number. */
export type SeqEntry = TranscriptEntry & { seq: number; changeSeq: number };

/** Payload published for every committed append/upsert batch. `firstSeq`/
 *  `lastSeq` span the affected rows (an upsert republish keeps its ORIGINAL
 *  seq, so a pure-update batch can publish seqs below `getLastSeq`). */
export interface TranscriptBusEvent {
  entries: SeqEntry[];
  firstSeq: number;
  lastSeq: number;
  /** The durable transcript was authoritatively replaced. Subscribers must
   * discard their current snapshot rather than merging by id. */
  reset?: boolean;
  /** This commit's identity in the ordered session feed. */
  feed?: SessionFeedFrame;
}

export type TranscriptSubscriber = (event: TranscriptBusEvent) => void;

const g = globalThis as {
  __osTranscriptBus?: Map<string, Set<TranscriptSubscriber>>;
};

function bus(): Map<string, Set<TranscriptSubscriber>> {
  return (g.__osTranscriptBus ??= new Map());
}

/**
 * Subscribe to committed transcript appends for one session. Returns the
 * unsubscribe function; safe to call more than once.
 */
export function subscribeTranscript(
  sessionId: string,
  fn: TranscriptSubscriber,
): () => void {
  const map = bus();
  let subs = map.get(sessionId);
  if (!subs) {
    subs = new Set();
    map.set(sessionId, subs);
  }
  subs.add(fn);
  return () => {
    const cur = bus().get(sessionId);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) bus().delete(sessionId);
  };
}

/**
 * Fan a committed batch out to this session's subscribers. Fire-and-forget:
 * feed sequencing and delivery happen together on the microtask queue (never
 * synchronously inside the caller's transaction scope), and subscriber errors
 * are isolated.
 */
export function publishTranscript(
  sessionId: string,
  event: TranscriptBusEvent,
): void {
  const subscribers = [...(bus().get(sessionId) ?? [])];
  queueMicrotask(() => {
    const lastChangeSeq = event.entries.reduce(
      (last, entry) => Math.max(last, entry.changeSeq),
      0,
    );
    // Assign the feed sequence at delivery time. Appending it before this
    // microtask let a later stream_tool_* frame send synchronously with a
    // higher sequence first; clients then rejected this durable append as
    // stale, leaving live tool rows missing until refresh.
    const feed = appendSessionFeed(sessionId, {
      type: "transcript_append",
      sessionId,
      entries: event.entries,
      firstSeq: event.firstSeq,
      lastSeq: event.lastSeq,
      ...(lastChangeSeq ? { lastChangeSeq } : {}),
      v2: true,
    });
    for (const fn of subscribers) {
      try {
        fn({ ...event, feed });
      } catch (e) {
        console.warn("[transcript-bus] subscriber threw:", e);
      }
    }
  });
}

/** Live subscriber count for one session (diagnostics / serve decisions). */
export function transcriptSubscriberCount(sessionId: string): number {
  return bus().get(sessionId)?.size ?? 0;
}
