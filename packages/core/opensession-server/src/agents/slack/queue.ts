/**
 * Message queue system for the Slack agent.
 *
 * Each Slack session (channel+thread) gets its own FIFO queue.
 * Messages are persisted to disk so they survive restarts.
 */

import { processMessage } from "./handlers";
import { sendSlackMessage, removeReaction, MESSAGES } from "./slack-api";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import type { SlackFileRef } from "./slack-api";

const SESSION_DIR = `${process.env.HOME}/.slack-sessions`;
const QUEUE_FILE = `${SESSION_DIR}/message-queue.json`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueuedMessage {
  prompt: string;
  /** User-facing Slack text for the progress card, before prompt enrichment. */
  cardTitle?: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  userName: string;
  userId: string;
  isNewSession: boolean;
  worktreeDir?: string;
  branch?: string;
  /** Registered repo id the session works in; unset = the default repo. */
  repoId?: string;
  /**
   * File attachments on the Slack message (small refs, not bytes — the queue
   * persists to disk). processMessage downloads the images among them right
   * before the run and attaches them to the prompt as native image parts.
   */
  files?: SlackFileRef[];
  /** Stable transcript identity for this Slack message across provider retries. */
  promptEntryId?: string;
  /** Set when shutdown leaves this queue head for boot to continue. */
  restartRecovery?: boolean;
}

export interface SessionQueue {
  queue: QueuedMessage[];
  processing: boolean;
  abortController: AbortController | null;
  /** The server is restarting, so leave the current message queued for the
   * next process instead of treating its abort like a person's Stop action. */
  restartInterrupted?: boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const sessionQueues = new Map<string, SessionQueue>();

/** Deliberately distinct from an ordinary AbortError: handlers use this to
 * render a restart state rather than the misleading "Cancelled by user". */
export const RESTART_ABORT_REASON = "opensession-server-restart";

export function isRestartAbort(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === RESTART_ABORT_REASON;
}

/** Stop driving live Slack turns during process shutdown while retaining the
 * head message in each queue. Startup reloads and continues those messages. */
export function interruptQueuesForRestart(): number {
  let interrupted = 0;
  for (const sq of sessionQueues.values()) {
    if (!sq.abortController || sq.abortController.signal.aborted) continue;
    sq.restartInterrupted = true;
    // Boot must continue the interrupted turn, not submit the person's Slack
    // message as a new turn. This marker survives with the durable queue item.
    if (sq.queue[0]) sq.queue[0].restartRecovery = true;
    sq.abortController.abort(RESTART_ABORT_REASON);
    interrupted++;
  }
  return interrupted;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getOrCreateQueue(sessionKey: string): SessionQueue {
  let sq = sessionQueues.get(sessionKey);
  if (!sq) {
    sq = { queue: [], processing: false, abortController: null };
    sessionQueues.set(sessionKey, sq);
  }
  return sq;
}

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

export async function saveQueueToDisk(): Promise<void> {
  const data: Record<string, QueuedMessage[]> = {};
  for (const [key, sq] of sessionQueues) {
    if (sq.queue.length > 0) {
      data[key] = sq.queue;
    }
  }
  writeJsonAtomic(QUEUE_FILE, data);
}

export async function loadQueueFromDisk(): Promise<void> {
  try {
    const file = Bun.file(QUEUE_FILE);
    if (await file.exists()) {
      const data = JSON.parse(await file.text()) as Record<
        string,
        QueuedMessage[]
      >;
      let total = 0;
      for (const [sessionKey, messages] of Object.entries(data)) {
        if (messages.length > 0) {
          total += messages.length;
          for (const msg of messages) {
            enqueueMessage(sessionKey, msg);
          }
        }
      }
      if (total > 0) {
        console.log(`[slack] Restored ${total} queued message(s) from disk`);
      }
    }
  } catch (e) {
    console.warn("[slack] Failed to load message queue:", e);
  }
}

// ---------------------------------------------------------------------------
// Enqueue / process
// ---------------------------------------------------------------------------

export function enqueueMessage(sessionKey: string, msg: QueuedMessage): void {
  const sq = getOrCreateQueue(sessionKey);

  // Dedup: don't enqueue the same Slack message twice (by messageTs)
  if (sq.queue.some((m) => m.messageTs === msg.messageTs)) {
    console.log(
      `[slack] Skipping duplicate message ${msg.messageTs} for ${sessionKey}`,
    );
    return;
  }

  // The same Slack event can cross provider boundaries or a process restart.
  // Keep one transcript uuid so every attempt addresses the original row.
  msg.promptEntryId ??= crypto.randomUUID();
  sq.queue.push(msg);
  console.log(
    `[slack] Enqueued message for ${sessionKey} (queue length: ${sq.queue.length})`,
  );

  // Persist to disk
  saveQueueToDisk().catch((e) =>
    console.warn("[slack] Failed to save queue:", e),
  );

  if (!sq.processing) {
    sq.processing = true;
    processQueue(sessionKey).catch((e) => {
      console.error(`[slack] Queue processing error for ${sessionKey}:`, e);
      sq!.processing = false;
    });
  }
}

export async function processQueue(sessionKey: string): Promise<void> {
  const sq = sessionQueues.get(sessionKey);
  if (!sq) return;

  while (sq.queue.length > 0) {
    // Peek at the message — keep it in the queue until processing completes
    const msg = sq.queue[0]!;
    try {
      await processMessage(sessionKey, msg);
    } catch (e) {
      console.error(`[slack] Error processing message for ${sessionKey}:`, e);
      // Guard the error report itself — if THIS send throws, processQueue
      // aborts and the whole queue stalls until the next inbound message.
      try {
        await sendSlackMessage(
          msg.channel,
          `${MESSAGES.error} ${e}`,
          msg.threadTs,
        );
      } catch (e2) {
        console.error(
          `[slack] Failed to report processing error for ${sessionKey}:`,
          e2,
        );
      }
    }
    // A restart aborts the local streamer/runner but deliberately leaves this
    // message at the queue head. Do not let this process start it again while
    // shutdown is in progress; the next boot reloads the persisted queue.
    if (sq.restartInterrupted) {
      sq.processing = false;
      sq.abortController = null;
      await saveQueueToDisk().catch((e) =>
        console.warn("[slack] Failed to save restart-interrupted queue:", e),
      );
      console.log(
        `[slack] Preserved interrupted message for ${sessionKey} across restart`,
      );
      return;
    }
    // Remove the message we just processed BY IDENTITY, not a blind shift().
    // A Stop/cancel clears the queue (sq.queue.length = 0); if a new message
    // arrives while this one is still processing it becomes queue[0], and a
    // blind shift() would silently drop that new message. Matching on messageTs
    // removes only what we actually handled and leaves anything new to run next.
    const doneIdx = sq.queue.findIndex((m) => m.messageTs === msg.messageTs);
    if (doneIdx !== -1) sq.queue.splice(doneIdx, 1);
    await saveQueueToDisk().catch((e) =>
      console.warn("[slack] Failed to save queue:", e),
    );
    // Remove eyes reaction after processing each message
    await removeReaction(msg.channel, msg.messageTs, "eyes").catch(() => {});
  }

  sq.processing = false;
  sq.abortController = null;
  // Clean up empty queue from disk
  saveQueueToDisk().catch((e) =>
    console.warn("[slack] Failed to save queue:", e),
  );
}
