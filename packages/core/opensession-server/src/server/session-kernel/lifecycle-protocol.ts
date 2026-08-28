import type { AskActorRequest } from "./ask-protocol";
import type { AgentOperationRequest } from "./agent-operation-protocol";
import type { AgentHostSupervisionRequest } from "./agent-host-supervision-protocol";
import type { DeliveryActorRequest } from "./delivery-protocol";
import type { GatewayCommandRequest } from "./gateway-command-protocol";
import type { CoreActorRequest } from "./core-protocol";
import type { CreationActorEffect } from "./creation-effect-protocol";
import type { TurnActorRequest } from "./turn-protocol";
import type { TimerActorRequest } from "./timer-protocol";
import type { TranscriptActorRequest } from "./transcript-protocol";
import type {
  CreationEventDecision,
  RunEventDecision,
} from "./store";

export type RunFence = {
  runId: string;
  generation: number;
};

export type SessionActorReducerCommand =
  | {
      kind: "agent_operation";
      commandId: string;
      request: AgentOperationRequest;
    }
  | {
      kind: "agent_host_supervision";
      commandId: string;
      request: AgentHostSupervisionRequest;
    }
  | {
      kind: "creation_event";
      commandId: string;
      decision: CreationEventDecision;
    }
  | {
      kind: "run_event";
      commandId: string;
      decision: RunEventDecision;
    }
  | {
      kind: "delivery";
      commandId: string;
      request: DeliveryActorRequest;
    }
  | {
      kind: "ask";
      commandId: string;
      request: AskActorRequest;
    }
  | {
      kind: "turn";
      commandId: string;
      request: TurnActorRequest;
    }
  | {
      kind: "timer";
      commandId: string;
      request: TimerActorRequest;
    }
  | {
      kind: "gateway";
      commandId: string;
      request: GatewayCommandRequest;
    }
  | {
      kind: "core";
      commandId: string;
      request: CoreActorRequest;
    }
  | {
      kind: "transcript";
      commandId: string;
      request: TranscriptActorRequest;
    };

export type SessionActorCommand =
  | SessionActorReducerCommand
  | {
      kind: "effect_result";
      commandId: string;
      result: SessionActorEffectResult;
    };

export type SessionActorEvent =
  | { kind: "command_accepted"; commandId: string }
  | { kind: "command_completed"; commandId: string }
  | { kind: "command_failed"; commandId: string; error: string }
  | { kind: "effect_emitted"; commandId: string; effectId: string }
  | { kind: "effect_resulted"; commandId: string; effectId: string }
  | {
      kind: "stale_result_rejected";
      commandId: string;
      effectId: string;
      actorEpoch: string;
    };

export type HumanAskDeliverEffect = {
  kind: "human_ask_deliver";
  payload: {
    askId: string;
    skipUi: boolean;
  };
};

export type DeliveryInterruptCancelEffect = {
  kind: "delivery_interrupt_cancel";
  payload: {
    interruptId: string;
    /** Exact dispatch identity for schema 13+. */
    dispatchId?: string;
    /** Schema-12 compatibility for already-durable effects. */
    runIds?: string[];
    runGeneration: number;
  };
};

export type TurnCancelEffect = {
  kind: "turn_cancel";
  payload: {
    cancelId: string;
    dispatchId: string;
    runGeneration: number;
  };
};

export type TurnOutcomeProjectEffect = {
  kind: "turn_outcome_project";
  payload: {
    projectionId: string;
    runId: string;
    runGeneration: number;
    errorMessage: string | null;
    engineSessionId?: string;
    noticePersisted: boolean;
    noticeLabel?: string;
    projectedAt: string;
  };
};

export type SessionActorEffect =
  | HumanAskDeliverEffect
  | DeliveryInterruptCancelEffect
  | TurnCancelEffect
  | TurnOutcomeProjectEffect
  | CreationActorEffect;
export type SessionActorEffectKind = SessionActorEffect["kind"];
export type SessionActorEffectFor<K extends SessionActorEffectKind> = Extract<
  SessionActorEffect,
  { kind: K }
>;
export type StagedSessionActorEffect = {
  [K in SessionActorEffectKind]: SessionActorEffectFor<K> & {
    effectKey: string;
  };
}[SessionActorEffectKind];

export type SessionActorEffectEnvelope<
  TEffect extends SessionActorEffect = SessionActorEffect,
> = TEffect & {
  actorEpoch: string;
  commandId: string;
  effectId: string;
  run?: RunFence;
};

export type SessionActorEffectResult = {
  kind: "effect_result";
  actorEpoch: string;
  commandId: string;
  effectId: string;
  run?: RunFence;
} & (
  | { outcome: "succeeded" }
  | { outcome: "failed"; error: string; retryable: boolean }
  | { outcome: "indeterminate"; error: string }
);

export type SessionActorCommandResult<TResult = unknown> = {
  kind: "command_result";
  actorEpoch: string;
  commandId: string;
  run?: RunFence;
} & (
  | { outcome: "completed"; result: TResult }
  | { outcome: "failed"; error: string; retryable: boolean }
  | { outcome: "indeterminate"; error: string }
);
