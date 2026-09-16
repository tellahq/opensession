import { assertPersonalImagesAbsent } from "./personal-image-admission";
import type { UnifiedSession } from "./types";
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

/** Only implemented private read operations are admitted here. Mutations,
 * terminals and unknown surfaces remain unavailable until their own guards are wired. */
export async function authorizeSessionMessage(
  msg: Record<string, unknown>,
  principal: import("../shared/access-scope").AccessPrincipal | undefined,
): Promise<{ allowed: boolean; sessionId?: string; session?: UnifiedSession }> {
  if (typeof msg.type !== "string") return { allowed: false };
  if (
    !SESSION_SCOPED_WS_OPERATIONS.has(msg.type) &&
    typeof msg.sessionId !== "string"
  )
    return { allowed: true };
  if (typeof msg.sessionId !== "string" || !msg.sessionId)
    return { allowed: false };
  const session = await findSessionAsync(msg.sessionId, principal);
  if (!session) return { allowed: false };
  if (session.accessScope?.kind === "personal") {
    if (
      ![
        "watch",
        "load_transcript_index",
        "load_transcript_range",
        "load_history",
        "prompt",
        "cancel",
        "answer_question",
        "command_ack",
      ].includes(msg.type)
    )
      return { allowed: false };
    assertPersonalImagesAbsent(msg.images);
    for (const key of [
      "files",
      "contextSessions",
      "contextChats",
      "mcpServers",
    ]) {
      if (
        msg[key] !== undefined &&
        (!Array.isArray(msg[key]) || (msg[key] as unknown[]).length)
      )
        return { allowed: false };
    }
    if (
      msg.type === "prompt" &&
      (typeof msg.content !== "string" ||
        msg.content.trimStart().startsWith("/") ||
        session.mcpServers?.length)
    )
      return { allowed: false };
    if (!(await import("./session-audience")).sessionAudiencesReady())
      return { allowed: false };
    // Check the actual actor metadata as well as its central projection before
    // reading actor content. A replacement catalog cannot relabel an old actor.
    const actor = await (
      await import("./session-kernel")
    ).sessionMetadata({ op: "get", sessionId: session.id, principal });
    if (!actor) return { allowed: false };
  }
  return { allowed: true, sessionId: session.id, session };
}
