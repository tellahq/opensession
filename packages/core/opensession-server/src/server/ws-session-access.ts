import { findSessionAsync } from "./session-cache";

/** Every existing operation here names the session explicitly. In particular,
 * queueId/questionId/requestId alone is NOT a capability to resolve its owner. */
export const SESSION_SCOPED_WS_OPERATIONS = new Set([
  "command_ack",
  "watch",
  "load_transcript_index",
  "load_transcript_range",
  "load_history",
  "prompt",
  "interrupt_prompt",
  "delete_queued_prompt",
  "take_queued_prompt",
  "take_steered_prompt",
  "update_queued_prompt",
  "steer_queued_prompt",
  "interrupt_queued_prompt",
  "reorder_queued_prompt",
  "cancel",
  "answer_question",
  "term_start",
]);

/** Runs before mailbox admission or terminal creation. These are legacy shared
 * operations: do not accept principal/accessScope/user from the websocket.
 * Private owner-aware dispatch is a separate release gate. */
export async function authorizeSharedSessionMessage(
  msg: Record<string, unknown>,
  watchingSessionId?: string | null,
): Promise<{ allowed: boolean; sessionId?: string }> {
  if (
    typeof msg.type !== "string" ||
    !SESSION_SCOPED_WS_OPERATIONS.has(msg.type)
  )
    return { allowed: true };
  const id =
    typeof msg.sessionId === "string"
      ? msg.sessionId
      : msg.type === "cancel"
        ? watchingSessionId
        : undefined;
  const session =
    typeof id === "string" && id ? await findSessionAsync(id) : undefined;
  return session
    ? { allowed: true, sessionId: session.id }
    : { allowed: false };
}

export async function sharedSessionMessageAllowed(
  msg: Record<string, unknown>,
  watchingSessionId?: string | null,
): Promise<boolean> {
  return (await authorizeSharedSessionMessage(msg, watchingSessionId)).allowed;
}
