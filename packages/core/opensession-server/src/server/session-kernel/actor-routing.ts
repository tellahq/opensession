import type {
  KernelActorAsyncRequest,
  KernelActorServiceCall,
} from "./actor-protocol";
import { isDeliveryReadRequest } from "./delivery-protocol";
import type { SessionActorReducerCommand } from "./lifecycle-protocol";
import { sessionKernelStoreRoute } from "./store-routing";
import { isTranscriptRead } from "./transcript-protocol";

export type SessionActorRoute =
  | { scope: "global" }
  | { scope: "catalog_read" }
  | { scope: "session"; sessionId: string; mutation: boolean }
  | { scope: "outbox"; id: number; mutation: boolean };

export function isReadReducer(command: SessionActorReducerCommand): boolean {
  if (command.kind === "ask")
    return (
      command.request.op === "snapshot" || command.request.op === "entries"
    );
  if (command.kind === "delivery")
    return isDeliveryReadRequest(command.request);
  if (command.kind === "transcript") return isTranscriptRead(command.request);
  return command.kind === "turn" && command.request.op === "snapshot";
}

/** Exhaustive routing for the typed reducer union. */
export function sessionActorReducerRoute(
  command: SessionActorReducerCommand,
): SessionActorRoute {
  switch (command.kind) {
    case "creation_event":
      return {
        scope: "session",
        sessionId: command.decision.sessionId,
        mutation: true,
      };
    case "run_event":
      return {
        scope: "session",
        sessionId: command.decision.sessionId,
        mutation: true,
      };
    case "delivery":
    case "ask":
    case "turn":
    case "timer":
    case "gateway":
    case "transcript":
      return "sessionId" in command.request
        ? {
            scope: "session",
            sessionId: command.request.sessionId,
            mutation: !isReadReducer(command),
          }
        : { scope: "global" };
    case "core":
      return {
        scope: "session",
        sessionId: command.request.sessionId,
        mutation: true,
      };
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

export function sessionActorServiceRoute(
  request: KernelActorAsyncRequest | KernelActorServiceCall,
): SessionActorRoute {
  if (request.t === "call") {
    if (request.request.t === "reduce")
      return sessionActorReducerRoute(request.request.command);
    // These lists are durable catalog projections. They may be read concurrently
    // with unrelated session mailboxes; waiting for every session turn would
    // make the ordinary sessions API disappear during long runs.
    if (
      ["askEntries", "deliveryEntries", "quarantinedSessions"].includes(
        request.request.method,
      )
    )
      return { scope: "catalog_read" };
    return sessionKernelStoreRoute(
      request.request.method,
      request.request.args,
    );
  }
  if (request.t === "acknowledge")
    return { scope: "session", sessionId: request.sessionId, mutation: true };
  if (request.t === "runtime_catalog_work") return { scope: "catalog_read" };
  if (request.t === "runtime_session_work")
    return { scope: "session", sessionId: request.sessionId, mutation: true };
  return { scope: "global" };
}

/** Stop, steer, and interrupt receipts retain reserved mailbox capacity and may
 * pass ordinary turns that have not started. The currently executing reduction
 * is never interrupted, so one session still has exactly one writer. */
export function isPrioritySessionActorRequest(
  request: KernelActorAsyncRequest | KernelActorServiceCall,
): boolean {
  if (request.t !== "call" || request.request.t !== "reduce") return false;
  const command = request.request.command;
  if (command.kind === "creation_event")
    return command.decision.event === "cancelled";
  if (command.kind === "core")
    return ["ack_outbox", "defer_outbox", "fail_outbox"].includes(
      command.request.op,
    );
  if (command.kind === "turn")
    return [
      "request_cancel_command",
      "complete_cancel_command",
      "fail_cancel_command",
      "prepare_cancel",
      "begin_cancel_effect",
      "settle_cancel",
    ].includes(command.request.op);
  if (command.kind === "delivery")
    return [
      "promote_queued",
      "prepare_steer",
      "accept_steer",
      "reject_steer",
      "requeue_steers",
      "prepare_interrupt",
      "begin_interrupt_effect",
      "settle_interrupt",
    ].includes(command.request.op);
  if (
    command.kind === "gateway" &&
    command.request.operation === "websocket_command" &&
    command.request.op === "request"
  ) {
    const identity = command.request.identity;
    return (
      !!identity &&
      typeof identity === "object" &&
      (("priority" in identity && identity.priority === true) ||
        ("command" in identity &&
          [
            "cancel",
            "steer",
            "interrupt_prompt",
            "steer_queued_prompt",
            "interrupt_queued_prompt",
          ].includes(String(identity.command))))
    );
  }
  return false;
}
