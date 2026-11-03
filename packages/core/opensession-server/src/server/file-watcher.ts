import type { Stats } from "node:fs";
import { stat as statFile } from "node:fs/promises";
import { entriesForWire, parseTranscriptFrom } from "./jsonl-parser";
import { markTranscriptStoreDegraded } from "./transcript-persistence";
import {
  appendTranscriptEvents,
  replaceTranscriptEvents,
  transcript,
} from "./actor-transcript";
import type { TranscriptEntry } from "./types";

export interface WatchState {
  path: string;
  /** Session this transcript belongs to — stamped on transcript_append so
      clients can drop events that aren't for the session they're viewing. */
  sessionId?: string;
  lastMtime: number;
  lastByteOffset: number;
  lastSize: number;
  lastDev: number;
  lastIno: number;
  viewers: Set<any>; // WebSocket connections
  /** Viewers still being sent their gap fill; polls skip them until it
   *  reaches the shared offset, so their entries stay in order. */
  catchingUp?: Set<any>;
  /** A poll's asynchronous read is in flight; the next tick waits for it. */
  polling?: boolean;
  /** Settles once the initial stat filled the cursor fields above. */
  ready?: Promise<void>;
  interval: ReturnType<typeof setInterval> | null;
}

// Parked on globalThis so a `bun --hot` reload keeps the live watch map: the
// old module's map would otherwise be unreachable from the new module's stop
// functions, orphaning every 1s polling interval forever.
const watches: Map<string, WatchState> = ((
  globalThis as any
).__transcriptWatches ??= new Map());

// Server-side hook: opensession registers a listener so appended entries can
// reconcile state that mirrors the transcript (steer receipts — a receipt
// whose message has landed must clear NOW, not at run end, or it shows as
// still-queued and a mid-run restart would re-deliver it). On globalThis so
// hot reloads re-register cleanly; read at call time.
type AppendListener = (
  sessionId: string,
  entries: TranscriptEntry[],
) => void | Promise<void>;
export function setTranscriptAppendListener(fn: AppendListener): void {
  (globalThis as any).__transcriptAppendListener = fn;
}
function notifyAppendListener(
  sessionId: string | undefined,
  entries: TranscriptEntry[],
) {
  if (!sessionId || entries.length === 0) return;
  const fn = (globalThis as any).__transcriptAppendListener as
    | AppendListener
    | undefined;
  if (!fn) return;
  try {
    void Promise.resolve(fn(sessionId, entries)).catch((error) => {
      console.warn("[file-watcher] transcript append listener failed:", error);
    });
  } catch (error) {
    // Reconcile is best-effort; never let it break transcript delivery.
    console.warn("[file-watcher] transcript append listener failed:", error);
  }
}

/**
 * Opaque revision tag for a transcript file, sent with transcript_init/append
 * and echoed back by clients on a resume-watch (`sinceRev`). It only has to
 * distinguish "same mirror file" from "the session's transcript moved" (engine
 * id rotation swaps transcriptPath; a byte offset into the OLD file must never
 * be applied to the new one) — a short path hash does that without leaking
 * server paths to the browser.
 */
export async function transcriptRev(path: string): Promise<string> {
  let identity = path;
  try {
    const stat = await statFile(path);
    identity += `:${stat.dev}:${stat.ino}`;
  } catch {}
  return revOf(identity);
}

function revOf(identity: string): string {
  let h = 5381;
  for (let i = 0; i < identity.length; i++)
    h = ((h * 33) ^ identity.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Watcher-feeds-store (transcript-v2 design §11): appends the watcher parsed
 * out of a transcript file are fed into the owned store too, covering
 * sessions whose file is written by a process that never writes the store
 * itself (external CLI/tmux runs — the sessions serveTranscriptV2 refuses; a
 * legacy watch is their only live reader). Entry-id upserts keep the store
 * consistent (same seqs; the bus republish is absorbed by the client's
 * id-keyed upsert). The watermark does NOT refresh here, so §8 still reads
 * the file growth as drift and the next store read re-imports — idempotent,
 * and it settles the watermark once the file stops growing.
 *
 * Strictly gated on the session being ALREADY imported — appending to a
 * never-imported session would mark it 'live-only' and permanently invert
 * seq order against the later history import (design §3), so this feed never
 * runs the import itself. A feed failure flags the session store-degraded
 * and never breaks legacy delivery.
 */
async function feedTranscriptStore(
  sessionId: string | undefined,
  entries: TranscriptEntry[],
  reset = false,
): Promise<void> {
  if (!sessionId || (!reset && entries.length === 0)) return;
  try {
    if (await transcript.needsImport(sessionId)) return;
    if (reset) await replaceTranscriptEvents(sessionId, entries);
    else await appendTranscriptEvents(sessionId, entries);
  } catch (e) {
    markTranscriptStoreDegraded(sessionId);
    console.warn(`[file-watcher] v2 store feed failed for ${sessionId}:`, e);
  }
}

type ParseFromResult = Awaited<ReturnType<typeof parseTranscriptFrom>>;

export interface FilePollDeps {
  parseFrom(
    path: string,
    byteOffset: number,
  ): ParseFromResult | Promise<ParseFromResult>;
  notify(sessionId: string | undefined, entries: TranscriptEntry[]): void;
  feed(
    sessionId: string | undefined,
    entries: TranscriptEntry[],
    reset?: boolean,
  ): unknown | Promise<void>;
}

const pollDeps: FilePollDeps = {
  parseFrom: parseTranscriptFrom,
  notify: notifyAppendListener,
  feed: feedTranscriptStore,
};

/** One deterministic poll step. Dependencies are explicit so tests use real
 * temp files while replacing only the surrounding delivery/store ports. */
export async function pollTranscriptFile(
  state: WatchState,
  deps: FilePollDeps = pollDeps,
): Promise<void> {
  if (state.polling) return;
  state.polling = true;
  try {
    await pollTranscriptFileOnce(state, deps);
  } finally {
    state.polling = false;
  }
}

async function pollTranscriptFileOnce(
  state: WatchState,
  deps: FilePollDeps,
): Promise<void> {
  let stat: Stats;
  try {
    stat = await statFile(state.path);
  } catch {
    return;
  }
  const replaced =
    (state.lastDev !== 0 || state.lastIno !== 0) &&
    (stat.dev !== state.lastDev || stat.ino !== state.lastIno);
  const truncated = stat.size < state.lastByteOffset;
  if (
    !replaced &&
    !truncated &&
    stat.size === state.lastByteOffset &&
    stat.mtimeMs <= state.lastMtime
  )
    return;

  const offset = replaced || truncated ? 0 : state.lastByteOffset;
  const { entries, newOffset, ok } = await deps.parseFrom(state.path, offset);
  // A transient read failure must not consume either change detector. The
  // exact range is retried even when no later write bumps mtime.
  if (!ok) return;
  const reset = replaced || truncated;
  // A non-empty replacement with no complete line is not an empty
  // transcript; retain the old identity/offset and retry after the writer
  // completes its first line.
  if (reset && stat.size > 0 && newOffset === 0 && entries.length === 0) return;

  state.lastMtime = stat.mtimeMs;
  state.lastByteOffset = newOffset;
  state.lastSize = stat.size;
  state.lastDev = stat.dev;
  state.lastIno = stat.ino;

  if (entries.length === 0 && !reset) return;

  deps.notify(state.sessionId, entries);
  void Promise.resolve(deps.feed(state.sessionId, entries, reset)).catch(
    (error) => {
      if (state.sessionId) markTranscriptStoreDegraded(state.sessionId);
      console.warn(
        `[file-watcher] v2 store feed failed for ${state.sessionId}:`,
        error,
      );
    },
  );

  // endOffset + rev = the client's resume cursor: on reconnect it re-watches
  // with sinceOffset/sinceRev and the gap since this exact byte is replayed
  // from the jsonl instead of a full transcript_init replace.
  const msg = JSON.stringify({
    type: reset ? "transcript_init" : "transcript_append",
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    entries: entriesForWire(entries),
    endOffset: state.lastByteOffset,
    // The stat above is the file this poll read, so its identity is the rev.
    rev: revOf(`${state.path}:${stat.dev}:${stat.ino}`),
  });
  for (const ws of state.viewers) {
    if (state.catchingUp?.has(ws)) continue;
    try {
      ws.send(msg);
    } catch {
      // Dead connection, will be cleaned up on close
    }
  }
}

function sendTranscriptAppend(
  ws: any,
  entries: TranscriptEntry[],
  sessionId: string | undefined,
  endOffset: number,
  rev: string,
): void {
  if (entries.length === 0) return;
  try {
    ws.send(
      JSON.stringify({
        type: "transcript_append",
        ...(sessionId ? { sessionId } : {}),
        entries: entriesForWire(entries),
        endOffset,
        rev,
      }),
    );
  } catch {
    // Dead connection, will be cleaned up on close
  }
}

/** Resolves once a joining viewer's gap fill (if any) has been sent. */
export async function startWatching(
  path: string,
  ws: any,
  initialOffset?: number,
  sessionId?: string,
): Promise<void> {
  const state = watches.get(path);
  if (state) {
    await state.ready;
    // A shared watch has one global byte offset. A new viewer may have just
    // parsed an older tail (or, for a fresh session, no transcript at all) and
    // ask to stream from that offset. Fill that viewer's gap without rewinding
    // the global watch for everyone else.
    let filled = Promise.resolve();
    if (initialOffset !== undefined && initialOffset < state.lastByteOffset) {
      (state.catchingUp ??= new Set()).add(ws);
      filled = fillViewerGap(state, ws, initialOffset, sessionId).catch(
        (error) =>
          console.warn(`[file-watcher] gap fill failed for ${path}:`, error),
      );
    }
    state.viewers.add(ws);
    if (sessionId && !state.sessionId) state.sessionId = sessionId;
    return filled;
  }

  // Registered before the first await, so a second viewer of the same path
  // joins this watch instead of starting another.
  const created: WatchState = {
    path,
    sessionId,
    lastMtime: 0,
    lastByteOffset: initialOffset ?? 0,
    lastSize: 0,
    lastDev: 0,
    lastIno: 0,
    viewers: new Set([ws]),
    interval: null,
  };
  watches.set(path, created);
  created.ready = (async () => {
    let stat: Stats | undefined;
    try {
      stat = await statFile(path);
    } catch {}
    // With a caller-supplied offset (including an explicit 0 — "stream this
    // file from the beginning", used when a run starts writing a brand-new
    // transcript), start with lastMtime 0 so the first poll flushes bytes
    // appended between the caller's parse and this watch (the file's current
    // mtime already covers them and would skip the tick). No offset = tail
    // only from the file's current end.
    if (initialOffset === undefined) {
      created.lastMtime = stat?.mtimeMs ?? 0;
      created.lastByteOffset = stat?.size ?? 0;
    }
    created.lastSize = stat?.size ?? 0;
    created.lastDev = stat?.dev ?? 0;
    created.lastIno = stat?.ino ?? 0;
    // The last viewer may have left while the stat ran.
    if (watches.get(path) !== created) return;
    created.interval = setInterval(() => {
      void pollTranscriptFile(created).catch((error) =>
        console.warn(`[file-watcher] poll failed for ${path}:`, error),
      );
    }, 1000);
  })();
  await created.ready;
}

/** Send one viewer the entries between its offset and the shared watch's,
 * then let the shared polls deliver to it. */
async function fillViewerGap(
  state: WatchState,
  ws: any,
  fromOffset: number,
  sessionId: string | undefined,
): Promise<void> {
  try {
    let offset = fromOffset;
    for (;;) {
      const { entries, newOffset } = await parseTranscriptFrom(
        state.path,
        offset,
      );
      if (!state.viewers.has(ws)) return;
      sendTranscriptAppend(
        ws,
        entries,
        sessionId || state.sessionId,
        newOffset,
        await transcriptRev(state.path),
      );
      // A poll that advanced the shared offset meanwhile sent its batch to
      // everyone else; read that range too before joining.
      if (newOffset >= state.lastByteOffset || newOffset <= offset) return;
      offset = newOffset;
    }
  } finally {
    state.catchingUp?.delete(ws);
  }
}

export function stopAllWatchesForClient(ws: any): void {
  for (const [path, state] of watches) {
    state.viewers.delete(ws);
    if (state.viewers.size === 0) {
      if (state.interval) clearInterval(state.interval);
      watches.delete(path);
    }
  }
}
