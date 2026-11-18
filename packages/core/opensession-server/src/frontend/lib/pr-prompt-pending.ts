import { useSyncExternalStore } from "react";
import { duration } from "../ui/motion";
import { randomUUID } from "./random-uuid";
import type {
  TranscriptEntry,
  TranscriptIndexEntry,
} from "@tellahq/opensession-protocol/session";
import type { WSClientMessage, WSServerMessage } from "./types";

/**
 * A PR action the session has been asked to carry out ("Fix checks" becomes
 * "Fixing…"). Kept outside the strip so the header strip and the workspace
 * summary card, which swap in for each other as the card opens and closes,
 * show the same pending state instead of each forgetting the press.
 *
 * The state follows the prompt that was sent, by its request id, rather than
 * whichever turn happens to be running: a prompt sent while the agent is busy
 * waits in the queue, and the turn ahead of it ending says nothing about the
 * fix. The session viewer feeds its frames to `observePromptFrame`, which
 * marks the prompt started when its user entry shows up in the transcript
 * and clears it when that turn's stream ends.
 *
 * A viewer that remounts (a session switch) missed the live frames, so it
 * reconciles from what watch sends instead: the transcript snapshot, the
 * queue, the feed snapshot's running turn, and the outline. A fix whose
 * entry fell out of the snapshot's tail is looked up through the outline.
 */
export interface PendingPrompt {
  label: string;
  /** The headline the action was offered for. Once the PR leaves it (checks
   *  rerun, feedback resolved) the strip stops showing the pending state. */
  headline: string;
  sessionId: string;
  requestId: string;
  /** Waiting in the session's queue behind another turn. */
  queued: boolean;
  /** Its turn has started: the next idle status ends it. */
  started: boolean;
  /** The transcript shows the agent answering it. */
  answered: boolean;
  /** The last feed snapshot found no turn running. Session status can't
   *  tell, since it folds background work (a workflow) into isRunning. */
  turnIdle: boolean;
  sentAt: number;
}

/** Server timestamps in the outline may run behind this clock. */
const CLOCK_SKEW_MS = 5 * 60_000;
/** The newest user rows of the outline to look up for a batched prompt. */
const MAX_LOOKUPS = 8;

/** How long a prompt that is neither queued nor started may wait for its
 *  turn before the strip stops claiming the work is under way (a dropped
 *  socket, a queued prompt someone deleted). */
const PROMPT_START_GRACE_MS = 15_000;

const pending = new Map<string, PendingPrompt>();
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const senders = new Map<string, (msg: WSClientMessage) => void>();
/** Outline rows fetched to find a prompt batched under another entry id. */
const lookups = new Map<
  string,
  { key: string; seq: number; answered: boolean }
>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function clearGrace(key: string) {
  clearTimeout(graceTimers.get(key));
  graceTimers.delete(key);
}

function armGrace(key: string, prompt: PendingPrompt) {
  clearGrace(key);
  graceTimers.set(
    key,
    setTimeout(() => {
      graceTimers.delete(key);
      if (pending.get(key) !== prompt) return;
      update(key, null);
    }, PROMPT_START_GRACE_MS),
  );
}

function update(key: string, next: PendingPrompt | null) {
  if (next) {
    pending.set(key, next);
    if (next.queued || next.started) clearGrace(key);
    else armGrace(key, next);
  } else {
    pending.delete(key);
    clearGrace(key);
    senders.delete(key);
    for (const [id, lookup] of lookups)
      if (lookup.key === key) lookups.delete(id);
  }
  emit();
}

/** Its turn ran and no turn is running now: the work is over. */
function settle(key: string, next: PendingPrompt) {
  update(key, next.started && next.answered && next.turnIdle ? null : next);
}

const isUserEntry = (entry: TranscriptEntry, requestId: string) =>
  entry.type === "user" &&
  (entry.id === requestId || !!entry.sourceMessageIds?.includes(requestId));

const isReply = (entry: TranscriptEntry) =>
  entry.type === "assistant" || entry.type === "tool_use";

const isReplyRow = (entry: TranscriptIndexEntry) =>
  entry.role === "agent_message" || entry.role === "assistant";

/** Where the prompt's user entry sits in `entries`, and whether the agent
 *  answered after it there. */
function findPrompt(entries: TranscriptEntry[], requestId: string) {
  const at = entries.findIndex((entry) => isUserEntry(entry, requestId));
  if (at < 0) return null;
  return { answered: entries.slice(at + 1).some(isReply) };
}

function lookUpBatched(
  key: string,
  prompt: PendingPrompt,
  msg: Extract<WSServerMessage, { type: "transcript_index" }>,
) {
  const send = senders.get(key);
  if (!send) return;
  const asked = new Set(
    [...lookups.values()]
      .filter((lookup) => lookup.key === key)
      .map((lookup) => lookup.seq),
  );
  const rows = msg.entries
    .filter(
      (entry) =>
        entry.role === "user" &&
        entry.timestampMs >= prompt.sentAt - CLOCK_SKEW_MS &&
        !asked.has(entry.seq),
    )
    .slice(-MAX_LOOKUPS);
  for (const row of rows) {
    const requestId = randomUUID();
    lookups.set(requestId, {
      key,
      seq: row.seq,
      answered: msg.entries.some(
        (entry) => entry.seq > row.seq && isReplyRow(entry),
      ),
    });
    send({
      type: "load_transcript_range",
      sessionId: prompt.sessionId,
      requestId,
      firstSeq: row.seq,
      lastSeq: row.seq,
      epoch: msg.epoch,
    });
  }
}

/**
 * Ask the session to carry out a PR action and show it as pending under
 * `key` until that prompt's turn is over.
 *
 * The button turns to "Fixing…" first and the prompt follows once that has
 * settled: the transcript's response to a sent prompt is a long task that
 * would otherwise freeze the morph in its first frames.
 */
export function sendPrPrompt(
  send: (msg: WSClientMessage) => void,
  {
    key,
    sessionId,
    user,
    label,
    headline,
    content,
  }: {
    key: string;
    sessionId: string;
    user: string;
    label: string;
    headline: string;
    content: string;
  },
) {
  const requestId = randomUUID();
  update(key, null);
  update(key, {
    label,
    headline,
    sessionId,
    requestId,
    queued: false,
    started: false,
    answered: false,
    turnIdle: false,
    sentAt: Date.now(),
  });
  senders.set(key, send);
  setTimeout(
    () => send({ type: "prompt", sessionId, requestId, user, content }),
    duration.large * 1000,
  );
}

/** Advance the pending prompts of `sessionId` with a frame the viewer
 *  received for that session. */
export function observePromptFrame(sessionId: string, msg: WSServerMessage) {
  if (pending.size === 0) return;
  for (const [key, prompt] of [...pending]) {
    if (prompt.sessionId !== sessionId) continue;
    switch (msg.type) {
      case "queue_update": {
        if (prompt.started) break;
        const queued = [...msg.queued, ...(msg.steered ?? [])].some(
          (item) => item.id === prompt.requestId,
        );
        if (queued !== prompt.queued) update(key, { ...prompt, queued });
        break;
      }
      // Live entries, and the tail snapshot a viewer gets on watch. Both run
      // past the prompt's entry once it started, so a reply in them answers it.
      case "transcript_append":
      case "transcript_init": {
        if (prompt.answered) break;
        const found = findPrompt(msg.entries, prompt.requestId);
        if (found)
          settle(key, { ...prompt, queued: false, started: true, ...found });
        else if (prompt.started && msg.entries.some(isReply))
          settle(key, { ...prompt, answered: true });
        break;
      }
      // Older pages, and the rows looked up through the outline.
      case "transcript_history":
      case "transcript_range": {
        let lookup = null;
        if (msg.type === "transcript_range") {
          lookup = lookups.get(msg.requestId);
          if (lookup && msg.complete) lookups.delete(msg.requestId);
        }
        if (prompt.started) break;
        const found = findPrompt(msg.entries, prompt.requestId);
        if (!found) break;
        settle(key, {
          ...prompt,
          queued: false,
          started: true,
          answered: found.answered || !!lookup?.answered,
        });
        break;
      }
      // The outline covers entries older than the snapshot's tail. A single
      // prompt's entry takes its request id; a batched one gets its own id,
      // so the recent user rows are fetched to read their source ids.
      case "transcript_index": {
        if (prompt.started || prompt.queued) break;
        const row = msg.entries.find(
          (entry) => entry.role === "user" && entry.id === prompt.requestId,
        );
        if (!row) {
          lookUpBatched(key, prompt, msg);
          break;
        }
        settle(key, {
          ...prompt,
          started: true,
          answered: msg.entries.some(
            (entry) => entry.seq > row.seq && isReplyRow(entry),
          ),
        });
        break;
      }
      // Sent on watch: whether a turn is running now, background work aside.
      case "feed_snapshot":
        settle(key, { ...prompt, turnIdle: msg.active === null });
        break;
      case "stream_start":
        if (prompt.turnIdle) update(key, { ...prompt, turnIdle: false });
        break;
      // The fix's own turn is over. Session status folds background work
      // (a workflow) into isRunning, so it stays true past this point.
      case "stream_done":
        if (prompt.started) update(key, null);
        else if (!prompt.turnIdle) update(key, { ...prompt, turnIdle: true });
        break;
      // Fallback for a viewer that missed the end frame while the session
      // went fully idle.
      case "session_status":
        if (prompt.started && !msg.isRunning) update(key, null);
        break;
    }
  }
}

export function getPromptPending(key: string): PendingPrompt | undefined {
  return pending.get(key);
}

export function usePromptPending(key: string): PendingPrompt | undefined {
  return useSyncExternalStore(
    subscribe,
    () => getPromptPending(key),
    () => undefined,
  );
}
