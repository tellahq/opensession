import type { SessionActorReducerCommand } from "./lifecycle-protocol";
import type {
  AgentHostPlanRegistration,
  AgentHostPlanRegistrationResult,
  AgentHostSupervisionRequest,
  AgentHostSupervisionResult,
} from "./agent-host-supervision-protocol";
import {
  type CreationEventDecision,
  type CreationEventDecisionResult,
  type DurableCommandRecord,
  type DurableCreationState,
  type DurableDeliveryState,
  type DurableSessionQuarantine,
  type DurableOutboxItem,
  type DeliverySlot,
  type DurableRunState,
  type DurableSteerTarget,
  type DurableTimer,
  type RunEventDecision,
  type RunEventDecisionResult,
  type SessionKernelStoreApi,
} from "./store";
import type {
  DeliveryActorRequest,
  DeliveryActorResult,
  DeliveryMutationReply,
} from "./delivery-protocol";
import type { AskActorRequest, AskActorResult } from "./ask-protocol";
import type {
  AgentOperationCancel,
  AgentOperationCancellationIntent,
  AgentOperationCancellationResult,
  AgentOperationIdentity,
  AgentOperationRequest,
  AgentOperationResult,
} from "./agent-operation-protocol";
import type { TurnActorRequest, TurnActorResult } from "./turn-protocol";
import type { TimerActorRequest, TimerActorResult } from "./timer-protocol";
import type { GatewayCommandRequest, GatewayCommandResult } from "./gateway-command-protocol";
import type { CoreActorRequest, CoreActorResult } from "./core-protocol";
import {
  assertTranscriptActorRequest,
  decodeAgentTranscriptActorRequest,
  type AgentTranscriptDestinationAppendRequest,
  type AgentTranscriptReceiptQueryRequest,
  type AgentTranscriptReceiptValidationRequest,
  type TranscriptActorRequest,
  type TranscriptActorResult,
} from "./transcript-protocol";
import {
  SESSION_KERNEL_ACTOR_VERSION,
  type KernelActorClientRequest,
  type KernelActorClientResponse,
} from "./actor-protocol";
import { isReadReducer } from "./actor-routing";
import { READ_METHODS } from "./store-routing";

const SMALL_OUTPUT_BYTES = 256 * 1024;
const LARGE_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DYNAMIC_OUTPUT_BYTES = 128 * 1024 * 1024;
const LARGE_STORE_RESPONSES = new Set([
  "askEntries",
  "askSnapshot",
  "changesSince",
  "creationState",
  "deliveryEntries",
  "deliverySnapshot",
  "pendingOutbox",
  "dueTimers",
  "runStates",
  "turnSnapshot",
]);

export class SessionKernelActorError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "SessionKernelActorError";
  }
}

export class SessionKernelQuarantinedError extends SessionKernelActorError {
  constructor(
    readonly sessionId: string,
    message: string,
  ) {
    super(message, false);
    this.name = "SessionKernelQuarantinedError";
  }
}

export function isFatalSessionKernelAsyncTimeout(
  request: KernelActorClientRequest,
): boolean {
  return request.t === "hello" || request.t === "acknowledge";
}

type Pending = {
  resolve: (value: KernelActorClientResponse) => void;
  reject: (error: Error) => void;
};

export class SessionKernelActorClient {
  private readonly pending = new Map<string, Pending>();
  private deadError?: Error;
  private readonly runStateCache = new Map<string, DurableRunState>();

  constructor(
    private readonly worker: Worker,
    private readonly onFatal?: (error: Error) => void,
  ) {
    worker.addEventListener("message", (event: MessageEvent) => {
      const response = event.data as KernelActorClientResponse;
      const pending = this.pending.get(response.rpcId);
      if (!pending) return;
      this.pending.delete(response.rpcId);
      if (response.t === "error")
        pending.reject(
          new SessionKernelActorError(response.error, response.retryable),
        );
      else pending.resolve(response);
    });
    worker.addEventListener("error", (event) => {
      this.markDead(new Error(`Session kernel actor failed: ${event.message}`));
    });
    worker.addEventListener("messageerror", () => {
      this.markDead(new Error("Session kernel actor sent an invalid message"));
    });
    (
      worker as Worker & {
        addEventListener(type: "close", listener: () => void): void;
      }
    ).addEventListener("close", () => {
        this.markDead(new Error("Session kernel actor exited"));
      });
  }

  async hello(): Promise<void> {
    const response = await this.request({
      t: "hello",
      rpcId: crypto.randomUUID(),
      version: SESSION_KERNEL_ACTOR_VERSION,
    });
    if (
      response.t !== "ready" ||
      response.version !== SESSION_KERNEL_ACTOR_VERSION
    )
      throw new Error("Session kernel actor handshake failed");
  }

  async acknowledgeCommand(
    sessionId: string,
    requestId: string,
  ): Promise<void> {
    const response = await this.request({
      t: "acknowledge",
      rpcId: crypto.randomUUID(),
      sessionId,
      requestId,
    });
    if (response.t !== "acknowledge_result")
      throw new Error("Invalid kernel acknowledgement response");
  }

  runStateProjection(sessionId: string): DurableRunState {
    return this.runStateCache.get(sessionId) ?? {
      state: "idle",
      since: new Date(0).toISOString(),
      generation: 0,
      changeSeq: 0,
    };
  }

  runStateProjections(): Array<DurableRunState & { sessionId: string }> {
    return [...this.runStateCache].map(([sessionId, state]) => ({ sessionId, ...state }));
  }

  async statsAsync(): Promise<ReturnType<SessionKernelStoreApi["stats"]>> {
    const response = await this.request({
      t: "stats",
      rpcId: crypto.randomUUID(),
    });
    if (response.t !== "stats_result")
      throw new Error("Invalid kernel stats response");
    return response.stats;
  }

  async maintainAsync(): Promise<boolean> {
    const response = await this.request({
      t: "maintain",
      rpcId: crypto.randomUUID(),
    });
    if (response.t !== "maintain_result")
      throw new Error("Invalid kernel maintenance response");
    return response.pending;
  }

  async runtimeWork(
    timerKinds: string[],
    effectKinds: string[],
    now = Date.now(),
    limit = 100,
  ): Promise<{ timers: DurableTimer[]; outbox: DurableOutboxItem[] }> {
    const response = await this.request({
      t: "runtime_work",
      rpcId: crypto.randomUUID(),
      now,
      timerKinds,
      effectKinds,
      limit,
    });
    if (response.t !== "runtime_work_result")
      throw new Error("Invalid kernel runtime work response");
    return { timers: response.timers, outbox: response.outbox };
  }

  /** Awaited store/reduce RPC over the posted-message transport. */
  async callAsync<TResult>(
    request:
      | { t: "store"; method: string; args: unknown[] }
      | { t: "reduce"; command: SessionActorReducerCommand },
    label: string,
    large = false,
  ): Promise<TResult> {
    const deadline = Date.now() + 15_000;
    const retryableRead = request.t === "reduce"
      ? isReadReducer(request.command)
      : READ_METHODS.has(request.method);
    let delayMs = 10;
    while (true) {
      try {
        return await this.callAsyncOnce<TResult>(
          request,
          label,
          large,
          Math.max(1, deadline - Date.now()),
        );
      } catch (error) {
        if (
          !retryableRead ||
          !(error instanceof SessionKernelActorError) ||
          !error.retryable ||
          Date.now() + delayMs >= deadline
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 250);
      }
    }
  }

  private callAsyncOnce<TResult>(
    request:
      | { t: "store"; method: string; args: unknown[] }
      | { t: "reduce"; command: SessionActorReducerCommand },
    label: string,
    large: boolean,
    timeoutMs: number,
  ): Promise<TResult> {
    if (this.deadError) return Promise.reject(this.deadError);
    const rpcId = crypto.randomUUID();
    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(rpcId);
        reject(
          new SessionKernelActorError(
            `Session kernel actor timed out handling ${label}`,
            true,
          ),
        );
      }, timeoutMs);
      const parse = (value: unknown): TResult => {
        const response = value as {
          status: number;
          body?: string;
          length?: number;
        };
        if (!response.body)
          throw new SessionKernelActorError(
            `Session kernel ${label} returned no result`,
            true,
          );
        const body = JSON.parse(response.body) as {
          ok: boolean;
          result?: TResult;
          error?: string;
          code?: string;
          sessionId?: string;
        };
        if (!body.ok) {
          const message = body.error || `Session kernel ${label} failed`;
          if (body.code === "session_quarantined" && body.sessionId)
            throw new SessionKernelQuarantinedError(body.sessionId, message);
          const error = new SessionKernelActorError(
            message,
            body.code === "retryable",
          );
          if (body.code === "actor_fatal") this.markDead(error);
          throw error;
        }
        return body.result as TResult;
      };
      this.pending.set(rpcId, {
        resolve: (value) => {
          clearTimeout(timeout);
          try {
            resolve(parse(value));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        this.worker.postMessage({ ...request, rpcId });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(rpcId);
        const failure = error instanceof Error ? error : new Error(String(error));
        this.markDead(failure);
        reject(failure);
      }
    });
  }

  decideGatewayAsync<T extends GatewayCommandRequest>(
    request: T,
  ): Promise<GatewayCommandResult<T>> {
    return this.callAsync<GatewayCommandResult<T>>(
      {
        t: "reduce",
        command: { kind: "gateway", commandId: crypto.randomUUID(), request },
      },
      `gateway ${request.operation} ${request.op}`,
    );
  }

  decideAgentOperationAsync<T extends AgentOperationRequest>(
    request: T,
  ): Promise<
    T extends AgentOperationCancel
      ? AgentOperationCancellationResult
      : AgentOperationResult
  > {
    return this.callAsync<
      T extends AgentOperationCancel
        ? AgentOperationCancellationResult
        : AgentOperationResult
    >(
      {
        t: "reduce",
        command: {
          kind: "agent_operation",
          commandId: request.identity.operationId,
          request,
        },
      },
      `Agent operation ${request.op}`,
    );
  }

  agentOperationCancellationIntentAsync(
    identity: AgentOperationIdentity,
  ): Promise<AgentOperationCancellationIntent | undefined> {
    return this.callAsync<AgentOperationCancellationIntent | undefined>(
      {
        t: "store",
        method: "agentOperationCancellationIntent",
        args: [identity],
      },
      "Agent operation cancellation intent query",
    );
  }

  async decideAskAsync<T extends AskActorRequest>(
    request: T,
  ): Promise<AskActorResult<T>> {
    return this.callAsync<AskActorResult<T>>(
      {
        t: "reduce",
        command: { kind: "ask", commandId: crypto.randomUUID(), request },
      },
      `ask ${request.op}`,
    );
  }

  async decideTurnAsync<T extends TurnActorRequest>(
    request: T,
  ): Promise<TurnActorResult<T>> {
    const result = await this.callAsync<TurnActorResult<T>>(
      {
        t: "reduce",
        command: { kind: "turn", commandId: crypto.randomUUID(), request },
      },
      `turn ${request.op}`,
    );
    if (request.op === "prepare_cancel")
      this.noteRunState(
        request.sessionId,
        (
          result as TurnActorResult<
            Extract<TurnActorRequest, { op: "prepare_cancel" }>
          >
        ).runState,
      );
    else if (
      request.op === "prepare_outcome_projection" ||
      request.op === "settle_outcome_projection"
    )
      this.noteChange(request.sessionId);
    return result;
  }

  decideTimerAsync<T extends TimerActorRequest>(
    request: T,
  ): Promise<TimerActorResult<T>> {
    return this.callAsync<TimerActorResult<T>>(
      {
        t: "reduce",
        command: { kind: "timer", commandId: crypto.randomUUID(), request },
      },
      `timer ${request.op}`,
    );
  }

  decideCoreAsync<T extends CoreActorRequest>(
    request: T,
  ): Promise<CoreActorResult<T>> {
    return this.callAsync<CoreActorResult<T>>(
      {
        t: "reduce",
        command: { kind: "core", commandId: crypto.randomUUID(), request },
      },
      `core ${request.op}`,
    );
  }

  decideAgentTranscriptDestinationAsync(
    request: AgentTranscriptDestinationAppendRequest,
  ): Promise<TranscriptActorResult<AgentTranscriptDestinationAppendRequest>> {
    const decoded = decodeAgentTranscriptActorRequest(request);
    if (!decoded || decoded.op !== "agent_append_destination")
      return Promise.reject(new TypeError("Invalid Agent transcript destination append"));
    return this.decideTranscriptAsync(decoded);
  }

  queryAgentTranscriptReceiptAsync(
    request: AgentTranscriptReceiptQueryRequest,
  ): Promise<TranscriptActorResult<AgentTranscriptReceiptQueryRequest>> {
    const decoded = decodeAgentTranscriptActorRequest(request);
    if (!decoded || decoded.op !== "agent_query_destination_receipt")
      return Promise.reject(new TypeError("Invalid Agent transcript receipt query"));
    return this.decideTranscriptAsync(decoded);
  }

  validateAgentTranscriptReceiptAsync(
    request: AgentTranscriptReceiptValidationRequest,
  ): Promise<TranscriptActorResult<AgentTranscriptReceiptValidationRequest>> {
    const decoded = decodeAgentTranscriptActorRequest(request);
    if (!decoded || decoded.op !== "agent_validate_destination_receipt")
      return Promise.reject(new TypeError("Invalid Agent transcript receipt validation"));
    return this.decideTranscriptAsync(decoded);
  }

  decideTranscriptAsync<T extends TranscriptActorRequest>(
    request: T,
  ): Promise<TranscriptActorResult<T>> {
    assertTranscriptActorRequest(request);
    return this.callAsync<TranscriptActorResult<T>>(
      {
        t: "reduce",
        command: {
          kind: "transcript",
          commandId: "requestId" in request
            ? request.requestId
            : crypto.randomUUID(),
          request,
        },
      },
      `transcript ${request.op}`,
    );
  }

  async decideDeliveryAsync<T extends DeliveryActorRequest>(
    request: T,
  ): Promise<DeliveryActorResult<T>> {
    const response = await this.callAsync<
      DeliveryActorResult<T> | DeliveryMutationReply<DeliveryActorResult<T>>
    >(
      {
        t: "reduce",
        command: {
          kind: "delivery",
          commandId: crypto.randomUUID(),
          request,
        },
      },
      `delivery ${request.op}`,
    );
    if (request.op === "snapshot" || request.op === "entries")
      return response as DeliveryActorResult<T>;
    return (response as DeliveryMutationReply<DeliveryActorResult<T>>).result;
  }

  async decideAgentHostSupervisionAsync<T extends AgentHostSupervisionRequest>(
    request: T,
  ): Promise<T extends AgentHostPlanRegistration
    ? AgentHostPlanRegistrationResult
    : AgentHostSupervisionResult> {
    return this.callAsync<
      AgentHostPlanRegistrationResult | AgentHostSupervisionResult
    >(
      {
        t: "reduce",
        command: {
          kind: "agent_host_supervision",
          commandId:
            request.op === "register_plan"
              ? request.registrationId
              : request.claimId,
          request,
        },
      },
      "Agent Host supervision claim",
    ) as Promise<T extends AgentHostPlanRegistration
      ? AgentHostPlanRegistrationResult
      : AgentHostSupervisionResult>;
  }

  async decideCreationEventAsync(
    decision: CreationEventDecision,
  ): Promise<CreationEventDecisionResult> {
    return this.callAsync<CreationEventDecisionResult>(
      {
        t: "reduce",
        command: {
          kind: "creation_event",
          commandId: crypto.randomUUID(),
          decision,
        },
      },
      "creation event decision",
      true,
    );
  }

  async decideRunEventAsync(
    decision: RunEventDecision,
  ): Promise<RunEventDecisionResult> {
    const result = await this.callAsync<RunEventDecisionResult>(
      {
        t: "reduce",
        command: {
          kind: "run_event",
          commandId: crypto.randomUUID(),
          decision,
        },
      },
      "run event decision",
    );
    if (result.accepted)
      this.noteRunState(decision.sessionId, result.state);
    return result;
  }

  private noteRunState(sessionId: string, state: DurableRunState): void {
    this.runStateCache.set(sessionId, state);
  }

  private noteChange(sessionId: string): void {
    const current = this.runStateProjection(sessionId);
    this.runStateCache.set(sessionId, { ...current, changeSeq: current.changeSeq + 1 });
  }

  terminate(): void {
    this.markDead(new Error("Session kernel actor stopped"), false);
    this.worker.terminate();
  }

  private request(
    request: KernelActorClientRequest,
  ): Promise<KernelActorClientResponse> {
    if (this.deadError) return Promise.reject(this.deadError);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.rpcId);
        const message = `Session kernel actor timed out handling ${request.t}`;
        if (isFatalSessionKernelAsyncTimeout(request)) {
          const error = new Error(message);
          this.markDead(error);
          reject(error);
          return;
        }
        reject(new SessionKernelActorError(message, true));
      }, 15_000);
      this.pending.set(request.rpcId, {
        resolve: (value) => {
          if (timeout) clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          if (timeout) clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        this.worker.postMessage(request);
      } catch (error) {
        if (timeout) clearTimeout(timeout);
        this.pending.delete(request.rpcId);
        const failure =
          error instanceof Error ? error : new Error(String(error));
        this.markDead(failure);
        reject(failure);
      }
    });
  }

  private markDead(error: Error, fatal = true): void {
    if (this.deadError) return;
    this.deadError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (fatal) this.onFatal?.(error);
  }
}
