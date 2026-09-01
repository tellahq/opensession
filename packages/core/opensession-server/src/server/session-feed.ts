import { LiveTextBuffer } from "@tellahq/opensession-protocol/live-text";
import type { SessionLiveEvent } from "@tellahq/opensession-protocol/session";
import { setPrimarySessionRunning } from "./session-state-events";

/**
 * Ordered, bounded feed for the live half of a session.
 *
 * Transcript entries already have a durable per-session sequence in
 * transcript-store. This feed gives ephemeral phases the same reconnect
 * semantics without making them durable. A real restart intentionally starts
 * a new epoch; recordRecoveredRunEvent rebuilds the active phase from the
 * adopted run's init and subsequent stream events while transcript backfill
 * supplies anything that committed before adoption.
 */

export type SessionFeedPhase = "delta" | "committed" | "status";

export interface SessionFeedFrame {
  type: "session_feed";
  sessionId: string;
  feedEpoch: string;
  feedSeq: number;
  runId?: string;
  turnId?: string;
  entryId?: string;
  phase: SessionFeedPhase;
  /** The wrapped live-turn frame, declared once in the protocol package: a
   *  client can hand `event` straight to its ordinary frame handler. */
  event: SessionLiveEvent;
}

export interface SessionFeedSnapshot {
  type: "feed_snapshot";
  sessionId: string;
  feedEpoch: string;
  feedSeq: number;
  active: null | {
    runId: string;
    turnId: string;
    entryId: string;
    by?: string;
    text: string;
    startedAt: number;
  };
}

/** The running turn, minus its text — that lives in `FeedState.live`. */
interface ActiveTurn {
  runId: string;
  turnId: string;
  entryId: string;
  by?: string;
  startedAt: number;
}

interface FeedState {
  epoch: string;
  nextSeq: number;
  frames: SessionFeedFrame[];
  active: ActiveTurn | null;
  /** The active turn's live text, minus the blocks that already landed. */
  live: LiveTextBuffer;
  bytes: number;
}

const MAX_FRAMES = 2_000;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_SESSIONS = 200;
const g = globalThis as {
  __osSessionFeeds?: Map<string, FeedState>;
};

function feeds(): Map<string, FeedState> {
  return (g.__osSessionFeeds ??= new Map());
}

function stateFor(sessionId: string): FeedState {
  let state = feeds().get(sessionId);
  if (state) {
    // Map insertion order doubles as a tiny LRU.
    feeds().delete(sessionId);
    feeds().set(sessionId, state);
  }
  if (!state) {
    state = {
      epoch: crypto.randomUUID(),
      nextSeq: 1,
      frames: [],
      active: null,
      live: new LiveTextBuffer(),
      bytes: 0,
    };
    feeds().set(sessionId, state);
    while (feeds().size > MAX_SESSIONS) {
      const candidate = [...feeds()].find(
        ([id, candidateState]) => id !== sessionId && !candidateState.active,
      );
      if (!candidate) break;
      feeds().delete(candidate[0]);
    }
  }
  return state;
}

function phaseFor(type: SessionLiveEvent["type"]): SessionFeedPhase {
  if (type === "transcript_append") return "committed";
  if (type === "stream_text") return "delta";
  return "status";
}

/** Append one event exactly once, then fan the returned immutable frame out. */
export function appendSessionFeed(
  sessionId: string,
  event: SessionLiveEvent,
): SessionFeedFrame {
  const state = stateFor(sessionId);
  const type = event.type;
  // A workflow can outlive the model turn that launched it. Record the raw
  // primary boundary, but put the aggregate state on the wire so stream_done
  // cannot make the session look idle while background work is still live.
  let feedEvent = event;
  if (event.type === "stream_start") {
    setPrimarySessionRunning(sessionId, true);
  } else if (event.type === "stream_done") {
    setPrimarySessionRunning(sessionId, false);
  } else if (event.type === "session_status") {
    feedEvent = {
      ...event,
      isRunning: setPrimarySessionRunning(sessionId, event.isRunning),
    };
  }

  if (event.type === "stream_start") {
    const runId = crypto.randomUUID();
    state.active = {
      runId,
      turnId: `turn:${runId}`,
      entryId: `stream:${runId}`,
      ...(event.by ? { by: event.by } : {}),
      startedAt: Date.now(),
    };
    state.live.reset();
  } else if (event.type === "stream_text" && state.active) {
    state.live.append(event.text ?? "", event.blockId);
  } else if (event.type === "transcript_append" && state.active) {
    // A block that landed durably is in the transcript this viewer will
    // also receive, so it must leave the live text a fresh viewer is
    // handed — otherwise the same paragraph shows twice, once above the
    // turn's tool steps and once in the bubble under them.
    for (const entry of event.entries ?? []) {
      if (entry.type === "assistant" && typeof entry.content === "string") {
        state.live.land(entry.content, entry.id);
      }
    }
  }

  const active = state.active;
  const frame: SessionFeedFrame = {
    type: "session_feed",
    sessionId,
    feedEpoch: state.epoch,
    feedSeq: state.nextSeq++,
    ...(active
      ? {
          runId: active.runId,
          turnId: active.turnId,
          entryId: active.entryId,
        }
      : {}),
    phase: phaseFor(type),
    event: feedEvent,
  };
  state.frames.push(frame);
  state.bytes += JSON.stringify(frame).length;
  while (
    state.frames.length > MAX_FRAMES ||
    (state.bytes > MAX_FEED_BYTES && state.frames.length > 1)
  ) {
    const removed = state.frames.shift();
    if (removed) state.bytes -= JSON.stringify(removed).length;
  }
  if (type === "stream_done") {
    state.active = null;
    state.live.reset();
  }
  return frame;
}

export function sessionFeedSnapshot(sessionId: string): SessionFeedSnapshot {
  const state = stateFor(sessionId);
  return {
    type: "feed_snapshot",
    sessionId,
    feedEpoch: state.epoch,
    feedSeq: state.nextSeq - 1,
    active: state.active ? { ...state.active, text: state.live.text } : null,
  };
}

/**
 * Replay only a true gap. Epoch changes and cursors older than the bounded
 * window intentionally fall back to the active snapshot.
 */
export function resumeSessionFeed(
  sessionId: string,
  sinceFeedSeq?: number,
  feedEpoch?: string,
): { frames: SessionFeedFrame[]; snapshot: SessionFeedSnapshot } {
  const state = stateFor(sessionId);
  const snapshot = sessionFeedSnapshot(sessionId);
  if (
    feedEpoch !== state.epoch ||
    typeof sinceFeedSeq !== "number" ||
    !Number.isFinite(sinceFeedSeq)
  ) {
    return { frames: [], snapshot };
  }
  const first = state.frames[0]?.feedSeq ?? state.nextSeq;
  if (sinceFeedSeq < first - 1 || sinceFeedSeq > state.nextSeq - 1) {
    return { frames: [], snapshot };
  }
  if (!state.active) return { frames: [], snapshot };
  return {
    frames: state.frames.filter(
      (frame) =>
        frame.feedSeq > sinceFeedSeq &&
        (frame.runId === state.active?.runId ||
          (frame.phase === "committed" && !frame.runId)),
    ),
    // A valid cursor replays deltas; sending cumulative active text as well
    // would duplicate that gap on the client.
    snapshot: { ...snapshot, active: null },
  };
}

export function isFeedEvent(msg: object): msg is SessionLiveEvent {
  const type = (msg as { type?: string }).type;
  return (
    type === "stream_start" ||
    type === "stream_text" ||
    type === "stream_tool_use" ||
    type === "stream_tool_result" ||
    type === "stream_done" ||
    type === "session_status"
  );
}
