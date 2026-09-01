import type { SessionActorReducerCommand } from "./lifecycle-protocol";
import type {
  DurableOutboxItem,
  DurableTimer,
  RunEventDecisionResult,
} from "./store";

export const SESSION_KERNEL_ACTOR_VERSION = 36;
export const SESSION_KERNEL_TRANSPORT_VERSION = 1;
// A transcript mutation can carry one accepted 50 MiB legacy/base64 image
// (about 67 MiB on the JSON wire) before the actor splits it into blob storage.
export const SESSION_KERNEL_MAX_REQUEST_BYTES = 80 * 1024 * 1024;
export const SESSION_KERNEL_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
export const SESSION_KERNEL_MAX_TRANSPORT_REQUESTS = 1024;

export type KernelActorAsyncRequest =
  | { t: "hello"; rpcId: string; version: number }
  | { t: "acknowledge"; rpcId: string; sessionId: string; requestId: string }
  | { t: "stats"; rpcId: string }
  | { t: "maintain"; rpcId: string }
  | {
      t: "runtime_work" | "runtime_catalog_work";
      rpcId: string;
      now: number;
      timerKinds: string[];
      effectKinds: string[];
      limit: number;
      additionalOutboxGroups?: Array<{
        effectKinds: string[];
        limit: number;
      }>;
      activeOutbox?: Array<{ id: number; sessionId: string }>;
      activeOutboxRecheckAt?: number;
    }
  | {
      t: "runtime_session_work";
      rpcId: string;
      sessionId: string;
      candidateCount: number;
      now: number;
      timerKinds: string[];
      effectKinds: string[];
      limit: number;
      additionalOutboxGroups?: Array<{
        effectKinds: string[];
        limit: number;
      }>;
      activeOutbox?: Array<{ id: number; sessionId: string }>;
      activeOutboxRecheckAt?: number;
    };

export type KernelActorAsyncResponse =
  | { t: "ready"; rpcId: string; version: number; serviceEpoch?: string }
  | { t: "acknowledge_result"; rpcId: string }
  | { t: "maintain_result"; rpcId: string; pending: boolean }
  | {
      t: "stats_result";
      rpcId: string;
      stats: ReturnType<import("./store").SessionKernelStoreApi["stats"]>;
    }
  | {
      t: "runtime_work_result" | "runtime_session_work_result";
      rpcId: string;
      timers: DurableTimer[];
      outbox: DurableOutboxItem[];
    }
  | {
      t: "runtime_catalog_work_result";
      rpcId: string;
      sessionIds: string[];
      timers: DurableTimer[];
      outbox: DurableOutboxItem[];
    }
  | {
      t: "error";
      rpcId: string;
      error: string;
      retryable?: boolean;
      fatal?: boolean;
    };

/** Gateway-worker-only async call. The transport wraps this in a service call;
 * it never crosses the independently supervised service boundary directly. */
export type KernelActorClientCallRequest =
  | { t: "store"; rpcId: string; method: string; args: unknown[] }
  | { t: "reduce"; rpcId: string; command: SessionActorReducerCommand };

export type KernelActorServiceCall = {
  t: "call";
  rpcId: string;
  request:
    | { t: "store"; method: string; args: unknown[] }
    | { t: "reduce"; command: SessionActorReducerCommand };
  outputBytes: number;
};

export type KernelActorResponse =
  | KernelActorAsyncResponse
  | {
      t: "call_result";
      rpcId: string;
      status: -1 | 1 | 2;
      length: number;
      body?: string;
    };

/** HTTP service responses are fenced after the actor worker replies. */
export type KernelActorServiceResponse = KernelActorResponse & {
  serviceEpoch: string;
};

export type KernelActorClientRequest =
  | KernelActorAsyncRequest
  | KernelActorClientCallRequest;

export type KernelActorClientResponse = KernelActorResponse;

export type KernelActorTransportEnvelope = {
  version: number;
  actorVersion: number;
  serviceEpoch?: string;
  request: KernelActorAsyncRequest | KernelActorServiceCall;
};

export type KernelActorRunEventResult = RunEventDecisionResult;

/** Settlement follows a physical or externally visible action. A rejected
 * session-scoped settlement quarantines that session. Infrastructure failures
 * still fail-stop the whole actor because commit state may be unknowable. */
export function isCriticalSettlementCommand(
  command: SessionActorReducerCommand,
): boolean {
  if (command.kind === "gateway")
    return command.request.op === "complete" || command.request.op === "fail";
  if (command.kind === "core")
    return (
      command.request.op === "ack_outbox" ||
      command.request.op === "fail_outbox"
    );
  if (command.kind === "timer")
    return command.request.op === "complete" || command.request.op === "fail";
  if (command.kind === "delivery")
    return [
      "complete_submit_command",
      "fail_submit_command",
      "settle_interrupt",
      "ack_dispatch",
      "fail_dispatch",
    ].includes(command.request.op);
  if (command.kind === "turn")
    return [
      "complete_cancel_command",
      "fail_cancel_command",
      "settle_cancel",
      "settle_outcome_projection",
    ].includes(command.request.op);
  return false;
}
