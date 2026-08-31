import type {
  AskQuestion,
  SessionSafetyState,
  SessionUsage,
  WSServerMessage,
} from "./types";
import type { QueueReceipt } from "./session-queue";

export interface SessionRuntimeState {
  isStreaming: boolean;
  isRunningLive: boolean;
  safety: SessionSafetyState | undefined;
  queued: QueueReceipt[];
  steered: QueueReceipt[];
  pendingDeliveryIds: string[];
  ask: {
    questionId: string;
    questions: AskQuestion[];
  } | null;
  model: string;
  usage: SessionUsage | undefined;
}

export interface SessionRuntimeSeed {
  isRunning: boolean;
  safety: SessionSafetyState | undefined;
  model: string;
  usage: SessionUsage | undefined;
}

type SessionRuntimeFrame = Extract<
  WSServerMessage,
  {
    type:
      | "queue_update"
      | "queued_prompt_taken"
      | "ask_question"
      | "ask_resolved"
      | "session_status"
      | "stream_start"
      | "stream_done"
      | "model_changed"
      | "usage_update"
      | "error";
  }
>;

export type SessionRuntimeAction =
  | {
      type: "frame";
      frame: SessionRuntimeFrame;
      acceptQueueUpdate?: boolean;
    }
  | { type: "sync_safety"; safety: SessionSafetyState | undefined }
  | { type: "sync_model"; model: string }
  | { type: "sync_usage"; usage: SessionUsage | undefined }
  | { type: "mark_running" }
  | { type: "reset_live"; isRunning: boolean }
  | { type: "repair_safety" }
  | { type: "set_steered_editing"; queueId: string; editing: boolean }
  | { type: "reorder_queue"; queued: QueueReceipt[] }
  | { type: "select_model"; model: string };

export function initialSessionRuntimeState(
  seed: SessionRuntimeSeed,
): SessionRuntimeState {
  return {
    isStreaming: false,
    isRunningLive: seed.isRunning,
    safety: seed.safety,
    queued: [],
    steered: [],
    pendingDeliveryIds: [],
    ask: null,
    model: seed.model,
    usage: seed.usage,
  };
}

export function reduceSessionRuntimeFrame(
  state: SessionRuntimeState,
  frame: SessionRuntimeFrame,
  acceptQueueUpdate = true,
): SessionRuntimeState {
  switch (frame.type) {
    case "queue_update":
      return {
        ...state,
        queued: acceptQueueUpdate ? frame.queued : state.queued,
        steered: frame.steered ?? [],
        pendingDeliveryIds: frame.pendingDeliveryIds ?? [],
      };
    case "queued_prompt_taken":
      if (frame.item) return state;
      return {
        ...state,
        steered: state.steered.map((item) =>
          item.id === frame.queueId ? { ...item, editing: false } : item,
        ),
      };
    case "ask_question":
      return {
        ...state,
        ask: {
          questionId: frame.questionId,
          questions: frame.questions,
        },
      };
    case "ask_resolved":
      if (state.ask?.questionId !== frame.questionId) return state;
      return { ...state, ask: null };
    case "session_status": {
      const isRunningLive = frame.isRunning && !frame.safety;
      return {
        ...state,
        isRunningLive,
        safety: frame.safety,
        isStreaming: isRunningLive ? state.isStreaming : false,
      };
    }
    case "stream_start":
      return { ...state, isStreaming: true };
    case "stream_done":
    case "error":
      return { ...state, isStreaming: false };
    case "model_changed":
      return { ...state, model: frame.model };
    case "usage_update":
      return { ...state, usage: frame.usage };
  }
}

export function sessionRuntimeReducer(
  state: SessionRuntimeState,
  action: SessionRuntimeAction,
): SessionRuntimeState {
  switch (action.type) {
    case "frame":
      return reduceSessionRuntimeFrame(
        state,
        action.frame,
        action.acceptQueueUpdate,
      );
    case "sync_safety":
      return {
        ...state,
        safety: action.safety,
        isRunningLive: action.safety ? false : state.isRunningLive,
      };
    case "sync_model":
    case "select_model":
      return { ...state, model: action.model };
    case "sync_usage":
      return { ...state, usage: action.usage };
    case "mark_running":
      return { ...state, isRunningLive: true };
    case "reset_live":
      return {
        ...state,
        isRunningLive: action.isRunning,
        pendingDeliveryIds: [],
        isStreaming: false,
      };
    case "repair_safety":
      return { ...state, safety: undefined, isRunningLive: false };
    case "set_steered_editing":
      return {
        ...state,
        steered: state.steered.map((item) =>
          item.id === action.queueId
            ? { ...item, editing: action.editing }
            : item,
        ),
      };
    case "reorder_queue":
      return { ...state, queued: action.queued };
  }
}
