import type { WSClientMessage } from "./types";
import { randomUUID } from "./random-uuid";

const MUTATION_TYPE_LIST = [
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
  "create_session",
] satisfies WSClientMessage["type"][];

type MutationType = (typeof MUTATION_TYPE_LIST)[number];
type MutationMessage = Extract<WSClientMessage, { type: MutationType }>;

const MUTATION_TYPES = new Set<WSClientMessage["type"]>(MUTATION_TYPE_LIST);

function isMutationMessage(
  message: WSClientMessage,
): message is MutationMessage {
  return MUTATION_TYPES.has(message.type);
}

/** Stamp an intent once, before it enters the reconnect outbox. */
export function withMutationRequestId(
  message: WSClientMessage,
): WSClientMessage {
  if (!isMutationMessage(message) || message.requestId) return message;
  return { ...message, requestId: randomUUID() };
}
