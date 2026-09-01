import type {
  DurableRunState,
  DurableTurnOutcomeProjection,
  DurableTurnState,
} from "./store";

export type DurableRunTarget = { runId: string; generation: number };

export type TurnCancelCommandPlan =
  | {
      status: "execute";
      targetRunId: string;
      targetRunGeneration: number;
    }
  | { status: "completed"; result: boolean; duplicate: boolean };

export function targetForTurnCancel(
  cancel: DurableTurnState["cancel"],
  cancelId: string,
): DurableRunTarget | undefined {
  return cancel?.cancelId === cancelId
    ? { runId: cancel.runId, generation: cancel.runGeneration }
    : undefined;
}

export type TurnActorRequest =
  | { op: "snapshot"; sessionId: string }
  | {
      op: "request_cancel_command";
      sessionId: string;
      requestId: string;
      fallbackRunId: string | null;
    }
  | {
      op: "complete_cancel_command";
      sessionId: string;
      requestId: string;
      result: boolean;
    }
  | {
      op: "fail_cancel_command";
      sessionId: string;
      requestId: string;
      error: string;
    }
  | {
      op: "prepare_cancel";
      sessionId: string;
      cancelId: string;
      expectedRunId: string;
      expectedGeneration: number;
      dispatchId: string;
      requeueIds: string[];
      source: string;
      user?: string;
    }
  | {
      op: "begin_cancel_effect";
      sessionId: string;
      cancelId: string;
      runGeneration: number;
    }
  | {
      op: "settle_cancel";
      sessionId: string;
      cancelId: string;
      outcome: "confirmed" | "not_aborted";
    }
  | {
      op: "prepare_outcome_projection";
      sessionId: string;
      projectionId: string;
      runId: string;
      runGeneration: number;
      errorMessage: string | null;
      engineSessionId?: string;
      noticePersisted: boolean;
      noticeLabel?: string;
      projectedAt: string;
    }
  | {
      op: "begin_outcome_projection";
      sessionId: string;
      projectionId: string;
      runGeneration: number;
    }
  | {
      op: "settle_outcome_projection";
      sessionId: string;
      projectionId: string;
      runGeneration: number;
    };

export type TurnActorResult<T extends TurnActorRequest> = T extends {
  op: "snapshot";
}
  ? DurableTurnState
  : T extends { op: "request_cancel_command" }
    ? TurnCancelCommandPlan
    : T extends { op: "complete_cancel_command" }
      ? boolean
      : T extends { op: "fail_cancel_command" }
        ? void
        : T extends { op: "prepare_cancel" }
          ? {
              cancel: NonNullable<DurableTurnState["cancel"]>;
              runState: DurableRunState;
            }
          : T extends { op: "begin_cancel_effect" }
            ? "execute" | "retry" | "adopt_confirmed" | "settled" | "missing"
            : T extends { op: "settle_cancel" }
              ? boolean
              : T extends { op: "prepare_outcome_projection" }
                ? DurableTurnOutcomeProjection | "stale"
                : T extends { op: "begin_outcome_projection" }
                  ? "execute" | "wait" | "completed" | "missing"
                  : T extends { op: "settle_outcome_projection" }
                    ? boolean
                    : never;
