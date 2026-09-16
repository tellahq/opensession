import type { ActorAccess } from "./private-access";
import type { SessionActorReducerCommand } from "./lifecycle-protocol";
import type {
  DurableOutboxItem,
  DurableTimer,
  RunEventDecisionResult,
} from "./store";

export const SESSION_KERNEL_ACTOR_VERSION = 41;
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
  | {
      t: "store";
      access?: ActorAccess;
      rpcId: string;
      method: string;
      args: unknown[];
    }
  | { t: "reduce"; rpcId: string; command: SessionActorReducerCommand };

export type KernelActorServiceCall = {
  t: "call";
  rpcId: string;
  request:
    | { t: "store"; access?: ActorAccess; method: string; args: unknown[] }
    | { t: "reduce"; command: SessionActorReducerCommand };
  /** Compatibility field. The actor validates it against
   * `SESSION_KERNEL_MAX_RESPONSE_BYTES` but every call is executed exactly once
   * and answered under that single hard bound; there is no sized retry. */
  outputBytes: number;
};

/** `status` 1 carries the encoded result and -1 an encoded failure. Status 2
 * is a legacy "result exceeded the caller's hint" reply that current actors no
 * longer emit: every call executes exactly once under the single hard bound,
 * and an oversized result becomes an ordinary non-retryable failure body that
 * legacy and current transports alike settle without re-requesting. */
export type KernelActorResponse =
  | KernelActorAsyncResponse
  | {
      t: "call_result";
      rpcId: string;
      status: -1 | 1 | 2;
      length: number;
      body?: string;
    };

export type KernelActorCallResult = {
  status: -1 | 1;
  length: number;
  body: string;
};

export const SESSION_KERNEL_RESPONSE_TOO_LARGE = "response_too_large";

/**
 * JSON string escaping never shrinks a body and expands a byte at most sixfold
 * (`\u00XX` for a control character), so a body whose raw size fits six times
 * over needs no second pass to prove its escaped size fits.
 */
const MAX_JSON_ESCAPE_EXPANSION = 6;

/**
 * Bound one materialized call result by the bytes it occupies once embedded as
 * a JSON string in the transport envelope. The body is returned exactly when
 * that escaped size stays within `maxBytes`; otherwise the reply is a small
 * definitive failure. The work already executed once and re-running it would
 * not shrink the result, so the failure carries no retryable code.
 */
export function boundCallResult(
  body: string,
  ok: boolean,
  maxBytes = SESSION_KERNEL_MAX_RESPONSE_BYTES,
): KernelActorCallResult {
  const length = Buffer.byteLength(body);
  const status = ok ? 1 : -1;
  if (length * MAX_JSON_ESCAPE_EXPANSION <= maxBytes)
    return { status, length, body };
  // Envelope quotes are two bytes; the envelope's other fields are covered by
  // the service's fixed slack above the same bound.
  if (
    length <= maxBytes &&
    Buffer.byteLength(JSON.stringify(body)) - 2 <= maxBytes
  )
    return { status, length, body };
  const failure = JSON.stringify({
    ok: false,
    error: `Session kernel result exceeds the response bound (${length} bytes)`,
    code: SESSION_KERNEL_RESPONSE_TOO_LARGE,
  });
  return { status: -1, length: Buffer.byteLength(failure), body: failure };
}

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
