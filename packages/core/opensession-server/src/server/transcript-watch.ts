import type {
  SeqEntry,
  TailWindowOpts,
  TranscriptBusEvent,
  TranscriptPage,
} from "./transcript-store";
import { v2SnapshotEntryWeight } from "./transcript-wire";

export interface TranscriptWatchStore {
  getLastChangeSeq(sessionId: string): number | Promise<number>;
  getLastResetChangeSeq(sessionId: string): number | Promise<number>;
  readChangesSince(
    sessionId: string,
    sinceChangeSeq: number,
    limit?: number,
  ): TranscriptPage | Promise<TranscriptPage>;
  readTail(
    sessionId: string,
    limit?: number,
  ): TranscriptPage | Promise<TranscriptPage>;
  /** Optional: a store without it falls back to the flat entry tail. */
  readTailWindow?(
    sessionId: string,
    opts: TailWindowOpts,
  ): TranscriptPage | Promise<TranscriptPage>;
}

export interface TranscriptWatchSocket {
  send(payload: string): void;
}

export interface StartTranscriptWatchOptions {
  sessionId: string;
  store: TranscriptWatchStore;
  socket: TranscriptWatchSocket;
  subscribe: (
    sessionId: string,
    wake: (event: TranscriptBusEvent) => void,
  ) => () => void;
  isCurrent: () => boolean;
  sinceChangeSeq?: number;
  /**
   * Everything an entry batch needs before it leaves the server: classify how
   * each entry reads and strip its delivery plumbing (notices.ts). Applied at
   * EVERY send site here, snapshot and append alike, because a store row is
   * raw — a client that reads only the classified form (the native apps read
   * `notice`/`sender` and never see `noticeKind`) would otherwise render a
   * recap as an anonymous system chip and a teammate's routed-back answer as
   * words the session owner typed.
   */
  prepareEntries?: (entries: SeqEntry[]) => SeqEntry[];
  clampSnapshot?: (entries: SeqEntry[]) => SeqEntry[];
  formatAppend?: (
    frame: Record<string, unknown>,
    event?: TranscriptBusEvent,
  ) => Record<string, unknown>;
  /** An authoritative reset sent a replacement snapshot. */
  afterResetSnapshot?: () => void;
}

export interface TranscriptWatchHandle {
  unsubscribe(): void;
  /** Current durable mutation cursor, exposed for deterministic tests. */
  changeSeq(): number;
}

const RESUME_LIMIT = 199;

// The opening window. SNAPSHOT_TAIL_ENTRIES is the floor it has always had;
// the rest let it reach further back when those entries hold no conversation.
//
// A turn's tool calls and its intermediate notes collapse into ONE fold in the
// UI, so an entry count says nothing about how much a reader will see: the
// tail of a thousand-step turn renders as a single collapsed line, which is
// what "why is this the only transcript I see in this session?" looks like
// from the other side. The window therefore keeps reading back until it holds
// enough user/assistant entries to give the turn context, including at least
// one user-message boundary. The boundary is load-bearing: intermediate
// assistant notes are folded into the work row too, so counting those alone
// can still stop inside the same giant turn. Past either ceiling the snapshot
// stays truncated and the reader pages with "Load all", exactly as before.
const SNAPSHOT_TAIL_ENTRIES = 132;
const SNAPSHOT_MIN_MESSAGES = 4;
const SNAPSHOT_MIN_USER_MESSAGES_WITH_TOOL_WORK = 1;
const SNAPSHOT_MAX_ENTRIES = 1400;
const SNAPSHOT_MAX_ESTIMATED_BYTES = 850_000;

/**
 * Start a race-free v2 watch. Subscription happens before the durable read,
 * and bus callbacks are only wake-ups: every delivery is reconciled from
 * SQLite by changeSeq. This makes delayed/duplicated notifications harmless.
 */
export async function startTranscriptWatch(
  options: StartTranscriptWatchOptions,
): Promise<TranscriptWatchHandle> {
  const {
    sessionId,
    store,
    socket,
    subscribe,
    isCurrent,
    prepareEntries = (entries) => entries,
    clampSnapshot = (entries) => entries,
    formatAppend = (frame) => frame,
  } = options;
  let cursor = 0;
  let initialized = false;
  let flushing = false;
  let pending = false;
  let resetPending = false;
  let closed = false;

  const send = (frame: Record<string, unknown>) => {
    if (!closed && isCurrent()) socket.send(JSON.stringify(frame));
  };

  async function sendSnapshot(): Promise<void> {
    // Capture the mutation baseline before the tail. A write racing the tail
    // read may overlap the snapshot, but the following flush replays it by id.
    cursor = await store.getLastChangeSeq(sessionId);
    const tail = await (store.readTailWindow
      ? store.readTailWindow(sessionId, {
          minEntries: SNAPSHOT_TAIL_ENTRIES,
          minMessages: SNAPSHOT_MIN_MESSAGES,
          minUserMessagesWithToolWork:
            SNAPSHOT_MIN_USER_MESSAGES_WITH_TOOL_WORK,
          maxEntries: SNAPSHOT_MAX_ENTRIES,
          maxEstimatedBytes: SNAPSHOT_MAX_ESTIMATED_BYTES,
          weigh: v2SnapshotEntryWeight,
        })
      : store.readTail(sessionId, SNAPSHOT_TAIL_ENTRIES));
    send({
      type: "transcript_init",
      sessionId,
      // Classify first, clamp second: the classifier strips plumbing out of
      // `content`, so the clamp then measures the text a reader will see.
      entries: clampSnapshot(prepareEntries(tail.entries)),
      truncated: tail.firstSeq > 1,
      firstSeq: tail.firstSeq,
      lastSeq: tail.lastSeq,
      lastChangeSeq: cursor,
      v2: true,
    });
    if (initialized) options.afterResetSnapshot?.();
  }

  const flush = async (event?: TranscriptBusEvent): Promise<void> => {
    if (event?.reset) resetPending = true;
    if (closed || !initialized) {
      pending = true;
      return;
    }
    if (flushing) {
      pending = true;
      return;
    }
    flushing = true;
    try {
      do {
        pending = false;
        if (resetPending) {
          resetPending = false;
          await sendSnapshot();
        }
        let wakeEvent = event;
        for (;;) {
          const page = await store.readChangesSince(
            sessionId,
            cursor,
            RESUME_LIMIT,
          );
          if (!page.entries.length) break;
          cursor = Math.max(
            cursor,
            ...page.entries.map((entry) => entry.changeSeq),
          );
          const append = {
            type: "transcript_append",
            sessionId,
            entries: prepareEntries(page.entries),
            firstSeq: page.firstSeq,
            lastSeq: page.lastSeq,
            lastChangeSeq: cursor,
            v2: true,
          };
          const matchingEvent =
            wakeEvent &&
            wakeEvent.entries.length === page.entries.length &&
            wakeEvent.entries.every(
              (entry, index) =>
                entry.id === page.entries[index]?.id &&
                entry.changeSeq === page.entries[index]?.changeSeq,
            )
              ? wakeEvent
              : undefined;
          send(formatAppend(append, matchingEvent));
          wakeEvent = undefined;
          if (page.entries.length < RESUME_LIMIT) break;
        }
      } while (pending && !closed);
    } finally {
      flushing = false;
    }
  };

  // Subscribe before observing any cursor or snapshot. A commit at every
  // possible handshake boundary either appears in the read or sets pending.
  const unsubscribeBus = subscribe(sessionId, (event) => {
    void flush(event);
  });
  try {
    const requested =
      typeof options.sinceChangeSeq === "number" &&
      Number.isFinite(options.sinceChangeSeq) &&
      options.sinceChangeSeq >= 0
        ? Math.floor(options.sinceChangeSeq)
        : undefined;
    let resumed = false;
    if (requested !== undefined) {
      // A fresh conversation has no resume cursor. Do not put two actor RPCs
      // in front of its snapshot only to discover that fact: sendSnapshot
      // captures the one baseline it needs. Under actor-mailbox pressure these
      // redundant round trips were a visible part of conversation-open delay.
      const [lastChangeSeq, lastResetChangeSeq] = await Promise.all([
        store.getLastChangeSeq(sessionId),
        store.getLastResetChangeSeq(sessionId),
      ]);
      if (requested >= lastResetChangeSeq && requested <= lastChangeSeq) {
        const changes = await store.readChangesSince(
          sessionId,
          requested,
          RESUME_LIMIT + 1,
        );
        if (changes.entries.length <= RESUME_LIMIT) {
          cursor = requested;
          if (changes.entries.length) {
            cursor = Math.max(
              cursor,
              ...changes.entries.map((entry) => entry.changeSeq),
            );
            send({
              type: "transcript_append",
              sessionId,
              entries: prepareEntries(changes.entries),
              firstSeq: changes.firstSeq,
              lastSeq: changes.lastSeq,
              lastChangeSeq: cursor,
              v2: true,
            });
          }
          resumed = true;
        }
      }
    }

    if (!resumed) await sendSnapshot();

    initialized = true;
    // Mandatory post-subscription reconciliation. It also covers writes caused
    // synchronously by a socket.send implementation in tests or adapters.
    await flush();

    return {
      unsubscribe() {
        if (closed) return;
        closed = true;
        unsubscribeBus();
      },
      changeSeq: () => cursor,
    };
  } catch (error) {
    closed = true;
    unsubscribeBus();
    throw error;
  }
}
