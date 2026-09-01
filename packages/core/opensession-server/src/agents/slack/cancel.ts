/**
 * Cancellation primitives for the Slack agent.
 *
 * Keyword matching, pending-answer resolution, and the shared cancelSession
 * helper used by both keyword-driven cancels and the Stop button.
 */

import { pendingAnswers, CANCELLED_ANSWER } from "./state";
import { sessionQueues } from "./queue";

// Whole-message-after-trim, case-insensitive. `/` prefix is optional.
const STOP_TERMS = ["stop", "cancel", "abort", "halt", "kill", "wait", "pause"];

const STOP_RE = new RegExp(`^/?(?:${STOP_TERMS.join("|")})$`, "i");

export function isStopMessage(text: string | undefined | null): boolean {
  if (!text) return false;
  return STOP_RE.test(text.trim());
}

/**
 * Cancel an in-flight session: abort the SDK, drop the queue, and resolve any
 * pending AskUserQuestion modals so the SDK doesn't hang.
 *
 * Returns true if anything was actually cancelled.
 */
export function cancelSession(sessionKey: string): boolean {
  let didCancel = false;

  const sq = sessionQueues.get(sessionKey);
  if (sq) {
    if (sq.abortController) {
      sq.abortController.abort();
      didCancel = true;
    }
    if (sq.queue.length > 0) {
      sq.queue.length = 0;
      didCancel = true;
    }
  }

  // Unblock any AskUserQuestion modal awaiting an answer for this session.
  for (const [questionId, pending] of pendingAnswers) {
    if (pending.sessionKey !== sessionKey) continue;
    clearTimeout(pending.timeoutId);
    pendingAnswers.delete(questionId);
    pending.resolve(CANCELLED_ANSWER);
    didCancel = true;
  }

  return didCancel;
}
