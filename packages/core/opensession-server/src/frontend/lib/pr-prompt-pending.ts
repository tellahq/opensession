import { useSyncExternalStore } from "react";
import { duration } from "../ui/motion";
import { randomUUID } from "./random-uuid";
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
 * marks the prompt started when its user entry lands and clears it when that
 * turn's stream ends.
 *
 * The queue outranks the transcript. A steered prompt's entry lands as soon
 * as it is steered, but it stays a receipt in the queue until the engine
 * reads it, and goes back to the queue if the turn ends first. So while the
 * queue lists the prompt it is waiting, whatever the transcript shows, and
 * it starts when it leaves the queue with its entry already there.
 *
 * A viewer that remounts (a session switch) or reconnects missed those live
 * frames. Watch sends the queue and then the feed snapshot, whose
 * `activePromptIds` lists the prompts the running turn answers: a prompt in
 * neither, once the server has seen it, is finished.
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
  /** Its turn has started: that turn's end clears it. */
  started: boolean;
  /** Its user entry is in the transcript. */
  landed: boolean;
  /** The server has shown it, queued or running, at least once. */
  seen: boolean;
}

/** How long a prompt that is neither queued nor started may wait for its
 *  turn before the strip stops claiming the work is under way (a dropped
 *  socket, a queued prompt someone deleted). */
const PROMPT_START_GRACE_MS = 15_000;

const pending = new Map<string, PendingPrompt>();
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
      if (pending.get(key) === prompt) update(key, null);
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
  }
  emit();
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
  update(key, {
    label,
    headline,
    sessionId,
    requestId,
    queued: false,
    started: false,
    landed: false,
    seen: false,
  });
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
      // Queued, or steered and not yet read by the engine.
      case "queue_update": {
        const queued = [...msg.queued, ...(msg.steered ?? [])].some(
          (item) => item.id === prompt.requestId,
        );
        if (queued) {
          if (!prompt.queued || prompt.started)
            update(key, { ...prompt, queued, started: false, seen: true });
        } else if (prompt.queued) {
          update(key, { ...prompt, queued, started: prompt.landed });
        }
        break;
      }
      case "transcript_append": {
        if (prompt.landed) break;
        const landed = msg.entries.some(
          (entry) =>
            entry.type === "user" &&
            (entry.id === prompt.requestId ||
              entry.sourceMessageIds?.includes(prompt.requestId)),
        );
        if (!landed) break;
        update(key, {
          ...prompt,
          landed,
          started: !prompt.queued,
          seen: true,
        });
        break;
      }
      // Sent on watch after the queue: the prompts the running turn answers,
      // whether or not the snapshot carries that turn's text.
      case "feed_snapshot": {
        if (!msg.activePromptIds) break;
        if (msg.activePromptIds.includes(prompt.requestId)) {
          if (!prompt.started)
            update(key, {
              ...prompt,
              queued: false,
              started: true,
              seen: true,
            });
        } else if (prompt.started || (prompt.seen && !prompt.queued)) {
          update(key, null);
        }
        break;
      }
      // The fix's own turn is over. Session status folds background work
      // (a workflow) into isRunning, so it stays true past this point.
      case "stream_done":
        if (prompt.started) update(key, null);
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
