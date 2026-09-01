import type {
  DeliverySlot,
  DurableDeliveryState,
  DurableSteerTarget,
} from "./store";
import type { DurableRunTarget } from "./turn-protocol";

export function deliveryInterruptForAnchor(
  state: DurableDeliveryState,
  anchorId: string,
): DurableDeliveryState["interrupt"] {
  const dispatchInterrupt = (
    state.dispatch as
      | { interrupt?: DurableDeliveryState["interrupt"] }
      | undefined
  )?.interrupt;
  const interrupt = state.interrupt || dispatchInterrupt;
  return interrupt?.anchorId === anchorId ? interrupt : undefined;
}

export function targetForDeliveryInterrupt(
  interrupt: DurableDeliveryState["interrupt"],
  anchorId: string,
): DurableRunTarget | undefined {
  return interrupt?.anchorId === anchorId && interrupt.dispatchId
    ? { runId: interrupt.dispatchId, generation: interrupt.runGeneration }
    : undefined;
}

export type SubmitPromptCommandPlan =
  | { status: "execute" }
  | { status: "in_progress" }
  | { status: "completed"; result: unknown; duplicate: true };

type DeliveryItem = {
  id?: string;
  promptEntryId?: string;
} & Record<string, unknown>;

export type DeliveryActorRequest =
  | { op: "snapshot"; sessionId: string }
  | {
      op: "request_submit_command";
      sessionId: string;
      requestId: string;
      identity: unknown;
    }
  | {
      op: "complete_submit_command";
      sessionId: string;
      requestId: string;
      result: unknown;
    }
  | {
      op: "fail_submit_command";
      sessionId: string;
      requestId: string;
      error: string;
    }
  | { op: "entries"; slot: DeliverySlot }
  | { op: "set"; sessionId: string; slot: DeliverySlot; value: unknown }
  | { op: "enqueue"; sessionId: string; item: unknown; front?: boolean }
  | {
      op: "promote_queued";
      sessionId: string;
      itemId: string;
      promptEntryId: string;
      item?: unknown;
    }
  | { op: "delete"; sessionId: string; slot: DeliverySlot }
  | { op: "clear_slot"; slot: DeliverySlot }
  | {
      op: "prepare_steer";
      sessionId: string;
      itemId: string;
      target: DurableSteerTarget;
      item?: unknown;
    }
  | {
      op: "accept_steer";
      sessionId: string;
      itemId: string;
      target: DurableSteerTarget;
    }
  | {
      op: "reject_steer";
      sessionId: string;
      itemId: string;
      target: DurableSteerTarget;
    }
  | { op: "settle_pending_steers" }
  | { op: "requeue_steers"; sessionId: string; items: unknown[] }
  | {
      op: "prepare_interrupt";
      sessionId: string;
      interruptId: string;
      anchorId: string;
      dispatchId: string;
      soloId?: string;
    }
  | {
      op: "begin_interrupt_effect";
      sessionId: string;
      interruptId: string;
      runGeneration: number;
    }
  | {
      op: "settle_interrupt";
      sessionId: string;
      interruptId: string;
      outcome: "confirmed" | "not_aborted";
    }
  | {
      op: "claim_next_dispatch";
      sessionId: string;
      promptEntryId: string;
      stillWorking?: boolean;
    }
  | {
      op: "claim_dispatch";
      sessionId: string;
      items: DeliveryItem[];
      promptEntryId: string;
      kind?: "create";
      requireQueued?: boolean;
    }
  | { op: "ack_dispatch"; sessionId: string; promptEntryId: string }
  | { op: "fail_dispatch"; sessionId: string; promptEntryId: string };

export type DeliveryMutationReply<TResult = unknown> = {
  revision?: number;
  result: TResult;
};

export function isDeliveryReadRequest(
  request: DeliveryActorRequest,
): request is Extract<DeliveryActorRequest, { op: "snapshot" | "entries" }> {
  return request.op === "snapshot" || request.op === "entries";
}

export type DeliveryActorResult<T extends DeliveryActorRequest> = T extends {
  op: "snapshot";
}
  ? DurableDeliveryState
  : T extends { op: "entries" }
    ? Array<[string, unknown]>
    : T extends { op: "request_submit_command" }
      ? SubmitPromptCommandPlan
      : T extends { op: "complete_submit_command" }
        ? unknown
        : T extends { op: "fail_submit_command" }
          ? void
          : T extends { op: "claim_dispatch" }
            ? { promptEntryId: string; items: unknown[]; revision: number }
            : T extends { op: "claim_next_dispatch" }
              ?
                  | { kind: "empty"; revision: number }
                  | { kind: "hold"; heldCount: number; revision: number }
                  | {
                      kind: "deliver";
                      promptEntryId: string;
                      items: unknown[];
                      interrupted: boolean;
                      revision: number;
                    }
              : T extends { op: "prepare_steer" | "promote_queued" }
                ? unknown | undefined
                : T extends {
                      op:
                        | "enqueue"
                        | "delete"
                        | "ack_dispatch"
                        | "fail_dispatch"
                        | "accept_steer"
                        | "reject_steer";
                    }
                  ? boolean
                  : T extends { op: "settle_pending_steers" | "requeue_steers" }
                    ? number
                    : T extends { op: "prepare_interrupt" }
                      ? {
                          interruptId: string;
                          phase: "prepared" | "executing" | "confirmed";
                          runGeneration: number;
                          anchorId: string;
                          soloId?: string;
                        }
                      : T extends { op: "begin_interrupt_effect" }
                        ?
                            | "execute"
                            | "retry"
                            | "adopt_confirmed"
                            | "confirmed"
                            | "settled"
                        : T extends { op: "settle_interrupt" }
                          ? boolean
                          : void;
