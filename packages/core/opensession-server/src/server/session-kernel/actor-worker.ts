import {
  isSessionKernelCentralStoreFailure,
  isSessionKernelInfrastructureFailure,
  SessionKernelStoreHost,
} from "./store-host";
import {
  SESSION_KERNEL_ACTOR_VERSION,
  SESSION_KERNEL_MAX_RESPONSE_BYTES,
  isCriticalSettlementCommand,
  type KernelActorAsyncRequest,
  type KernelActorClientCallRequest,
  type KernelActorServiceCall,
  type KernelActorResponse,
} from "./actor-protocol";
import { isDeliveryReadRequest } from "./delivery-protocol";
import type { SessionActorReducerCommand } from "./lifecycle-protocol";
import { isReadReducer, sessionActorReducerRoute } from "./actor-routing";
import { READ_METHODS, sessionKernelStoreRoute } from "./store-routing";
import { assertTranscriptActorRequest } from "./transcript-protocol";

class SessionQuarantinedError extends Error {
  readonly code = "session_quarantined";

  constructor(
    readonly sessionId: string,
    readonly reason: string,
  ) {
    super(`Session ${sessionId} is quarantined: ${reason}`);
    this.name = "SessionQuarantinedError";
  }
}

function reducerSessionId(
  command: SessionActorReducerCommand,
  host: SessionKernelStoreHost,
): string | undefined {
  const route = sessionActorReducerRoute(command);
  if (route.scope === "session") return route.sessionId;
  if (route.scope === "outbox") return host.outboxSessionId(route.id);
  return undefined;
}

function reducerMutatesSparseProjection(
  command: SessionActorReducerCommand,
): boolean {
  if (command.kind === "ask") return !isReadReducer(command);
  if (command.kind === "delivery")
    return !isDeliveryReadRequest(command.request);
  return (
    command.kind === "core" &&
    (command.request.op === "clear" || command.request.op === "tombstone")
  );
}

function routedStoreCall(
  method: string,
  args: unknown[],
  host: SessionKernelStoreHost,
): { sessionId?: string; mutation: boolean } {
  const route = sessionKernelStoreRoute(method, args);
  if (route.scope === "session")
    return { sessionId: route.sessionId, mutation: route.mutation };
  if (route.scope === "outbox")
    return {
      sessionId: host.outboxSessionId(route.id),
      mutation: route.mutation,
    };
  return { mutation: false };
}

export function startSessionKernelActorWorker(): void {
  const host = new SessionKernelStoreHost();
  function post(message: KernelActorResponse): void {
    // Internal worker telemetry is consumed by the parent service and stripped
    // before the actor response crosses the HTTP boundary.
    self.postMessage({ ...message, workerMetrics: host.metrics() });
  }

  function executeCall(
    request: KernelActorServiceCall["request"],
    outputBytes: number,
  ): { status: -1 | 1 | 2; length: number; body: string } {
    let store = host.central;
    let requestSessionId: string | undefined;
    try {
      let result: unknown;
      if (request.t === "reduce") {
        const command = request.command;
        const sessionId = reducerSessionId(command, host);
        requestSessionId = sessionId;
        if (command.kind === "transcript")
          assertTranscriptActorRequest(command.request);
        if (!isReadReducer(command) && sessionId) {
          const quarantine = host.quarantinedSession(sessionId);
          if (quarantine)
            throw new SessionQuarantinedError(sessionId, quarantine.reason);
        }
        if (sessionId)
          store = host.storeForSession(
            sessionId,
            command.kind === "transcript" ? false : !isReadReducer(command),
            reducerMutatesSparseProjection(command),
          );
        if (
          command.kind === "transcript" &&
          !isReadReducer(command) &&
          command.request.op !== "delete" &&
          store.isTombstoned(command.request.sessionId)
        )
          throw new Error(`Session ${command.request.sessionId} is tombstoned`);
        else if (command.kind === "transcript")
          result = host.transcript(command.request);
        else if (command.kind === "creation_event")
          result = store.applyCreationEvent(command.decision);
        else if (command.kind === "run_event")
          result = store.applyRunEvent(command.decision);
        else if (command.kind === "delivery") {
          const delivery = command.request;
          if (delivery.op === "snapshot")
            result = store.deliverySnapshot(delivery.sessionId);
          else if (delivery.op === "entries")
            result = host.allDeliveryEntries(delivery.slot);
          else if (delivery.op === "request_submit_command")
            result = store.requestSubmitPromptCommand(delivery);
          else if (delivery.op === "complete_submit_command")
            result = store.completeSubmitPromptCommand(delivery);
          else if (delivery.op === "fail_submit_command")
            result = store.failSubmitPromptCommand(delivery);
          else if (delivery.op === "set")
            result = store.setDeliverySlot(
              delivery.sessionId,
              delivery.slot,
              delivery.value,
            );
          else if (delivery.op === "enqueue")
            result = store.enqueueDelivery(
              delivery.sessionId,
              delivery.item,
              delivery.front,
            );
          else if (delivery.op === "promote_queued")
            result = store.promoteQueuedDelivery(
              delivery.sessionId,
              delivery.itemId,
              delivery.promptEntryId,
              delivery.item,
            );
          else if (delivery.op === "delete")
            result = store.deleteDeliverySlot(
              delivery.sessionId,
              delivery.slot,
            );
          else if (delivery.op === "clear_slot")
            result = host.call("clearDeliverySlot", [delivery.slot]);
          else if (delivery.op === "prepare_steer")
            result = store.prepareSteerDelivery(
              delivery.sessionId,
              delivery.itemId,
              delivery.target,
              delivery.item,
            );
          else if (delivery.op === "accept_steer")
            result = store.acceptSteerDelivery(
              delivery.sessionId,
              delivery.itemId,
              delivery.target,
            );
          else if (delivery.op === "reject_steer")
            result = store.rejectSteerDelivery(
              delivery.sessionId,
              delivery.itemId,
              delivery.target,
            );
          else if (delivery.op === "settle_pending_steers")
            result = host.call("settlePendingSteers", []);
          else if (delivery.op === "requeue_steers")
            result = store.requeueSteerDeliveries(
              delivery.sessionId,
              delivery.items,
            );
          else if (delivery.op === "prepare_interrupt")
            result = store.prepareDeliveryInterrupt(delivery);
          else if (delivery.op === "begin_interrupt_effect")
            result = store.beginDeliveryInterruptEffect(delivery);
          else if (delivery.op === "settle_interrupt")
            result = store.settleDeliveryInterrupt(delivery);
          else if (delivery.op === "claim_next_dispatch")
            result = store.claimNextDeliveryDispatch(delivery);
          else if (delivery.op === "claim_dispatch")
            result = store.claimDeliveryDispatch(delivery);
          else if (delivery.op === "ack_dispatch")
            result = store.ackDeliveryDispatch(
              delivery.sessionId,
              delivery.promptEntryId,
            );
          else
            result = store.failDeliveryDispatch(
              delivery.sessionId,
              delivery.promptEntryId,
            );
          if (!isDeliveryReadRequest(delivery) && "sessionId" in delivery)
            host.refreshSessionProjections(delivery.sessionId);
          if (!isDeliveryReadRequest(delivery))
            result = {
              result,
              ...("sessionId" in delivery
                ? {
                    revision: store.deliverySnapshot(delivery.sessionId)
                      .revision,
                  }
                : {}),
            };
        } else if (command.kind === "gateway") {
          const gateway = command.request;
          if (gateway.op === "request")
            result = store.requestGatewayCommand(gateway);
          else if (gateway.op === "complete")
            result = store.completeGatewayCommand(gateway);
          else result = store.failGatewayCommand(gateway);
        } else if (command.kind === "core") {
          const core = command.request;
          if (core.op === "enqueue_effect")
            result = store.enqueueOutbox(
              core.sessionId,
              core.kind,
              core.payload,
              core.effectKey,
            );
          else if (core.op === "ack_outbox") {
            const owner =
              store.outboxSessionId(core.id) ?? host.outboxSessionId(core.id);
            // Settlements are idempotent. A timed-out acknowledgement may have
            // committed even though the caller did not receive its response;
            // in that case the effect is already absent and replay is a no-op.
            // Existing effects still retain the cross-session ownership fence.
            if (owner !== undefined && owner !== core.sessionId)
              throw new Error(`Outbox ${core.id} crossed session ownership`);
            result = store.ackOutbox(core.id);
          } else if (core.op === "defer_outbox") {
            const owner =
              store.outboxSessionId(core.id) ?? host.outboxSessionId(core.id);
            if (owner !== undefined && owner !== core.sessionId)
              throw new Error(`Outbox ${core.id} crossed session ownership`);
            result = store.deferOutbox(core.id);
          } else if (core.op === "fail_outbox") {
            const owner =
              store.outboxSessionId(core.id) ?? host.outboxSessionId(core.id);
            if (owner !== undefined && owner !== core.sessionId)
              throw new Error(`Outbox ${core.id} crossed session ownership`);
            result = store.noteOutboxFailure(
              core.id,
              core.error,
              core.maxAttempts,
            );
          } else if (core.op === "clear")
            result = store.clearSession(core.sessionId);
          else result = store.tombstoneSession(core.sessionId);
          if (core.op === "clear" || core.op === "tombstone")
            host.refreshSessionProjections(core.sessionId);
        } else if (command.kind === "turn") {
          const turn = command.request;
          if (turn.op === "snapshot")
            result = store.turnSnapshot(turn.sessionId);
          else if (turn.op === "request_cancel_command")
            result = store.requestTurnCancelCommand(turn);
          else if (turn.op === "complete_cancel_command")
            result = store.completeTurnCancelCommand(turn);
          else if (turn.op === "fail_cancel_command")
            result = store.failTurnCancelCommand(turn);
          else if (turn.op === "prepare_cancel")
            result = store.prepareTurnCancel(turn);
          else if (turn.op === "begin_cancel_effect")
            result = store.beginTurnCancelEffect(turn);
          else if (turn.op === "settle_cancel")
            result = store.settleTurnCancel(turn);
          else if (turn.op === "prepare_outcome_projection")
            result = store.prepareTurnOutcomeProjection(turn);
          else if (turn.op === "begin_outcome_projection")
            result = store.beginTurnOutcomeProjection(turn);
          else result = store.settleTurnOutcomeProjection(turn);
        } else if (command.kind === "timer") {
          const timer = command.request;
          if (timer.op === "schedule") result = store.scheduleTimer(timer);
          else if (timer.op === "cancel")
            result = store.cancelTimer(timer.sessionId, timer.timerId);
          else if (timer.op === "begin")
            result = store.beginTimerExecution(timer);
          else if (timer.op === "complete")
            result = store.completeTimerExecution(timer);
          else if (timer.op === "fail")
            result = store.failTimerExecution(timer);
          else result = store.recordTimerRuntimeFailure(timer);
        } else {
          const ask = command.request;
          if (ask.op === "snapshot") result = store.askSnapshot(ask.sessionId);
          else if (ask.op === "entries") result = host.allAskEntries();
          else if (ask.op === "set")
            result = host.call("setAskRecord", [ask.sessionId, ask.value]);
          else if (ask.op === "answer")
            result = host.call("answerAskRecord", [
              ask.sessionId,
              ask.questionId,
              ask.answers,
              ask.answeredVia,
            ]);
          else if (ask.op === "delete")
            result = host.call("deleteAskRecord", [ask.sessionId]);
          else result = host.call("clearAskRecords", []);
        }
      } else {
        const route = routedStoreCall(request.method, request.args, host);
        const { sessionId } = route;
        requestSessionId = sessionId;
        if (
          route.mutation &&
          sessionId &&
          request.method !== "quarantineSession" &&
          request.method !== "releaseQuarantine"
        ) {
          const quarantine = host.quarantinedSession(sessionId);
          if (quarantine)
            throw new SessionQuarantinedError(sessionId, quarantine.reason);
        }
        result = host.call(request.method, request.args);
      }
      const body = JSON.stringify({ ok: true, result });
      const length = Buffer.byteLength(body);
      return { status: length > outputBytes ? 2 : 1, length, body };
    } catch (error) {
      host.recordSqliteBusy(error);
      let failStop = false;
      let responseCode:
        | "actor_fatal"
        | "session_quarantined"
        | "retryable"
        | undefined;
      let responseSessionId: string | undefined;
      const sessionId = requestSessionId;
      const infrastructure = isSessionKernelInfrastructureFailure(error);
      const critical =
        request.t === "reduce" && isCriticalSettlementCommand(request.command);
      if (infrastructure || critical) {
        if (
          !sessionId ||
          isSessionKernelCentralStoreFailure(error) ||
          (infrastructure && !host.isIsolated(sessionId))
        ) {
          failStop = true;
          responseCode = "actor_fatal";
        } else {
          try {
            const commandKind =
              request.t === "reduce"
                ? `${request.command.kind}:${"request" in request.command ? request.command.request.op : "event"}`
                : `store:${request.method}`;
            host.quarantineSession(
              sessionId,
              error instanceof Error ? error.message : String(error),
              commandKind,
              infrastructure,
            );
            responseCode = "session_quarantined";
            responseSessionId = sessionId;
          } catch {
            failStop = true;
            responseCode = "actor_fatal";
          }
        }
      } else if (error instanceof SessionQuarantinedError) {
        responseCode = error.code;
        responseSessionId = error.sessionId;
      } else if (
        error &&
        typeof error === "object" &&
        "retryable" in error &&
        error.retryable === true
      ) {
        responseCode = "retryable";
      }
      const body = JSON.stringify({
        ok: false,
        error: (error instanceof Error ? error.message : String(error)).slice(
          0,
          8_000,
        ),
        ...(responseCode ? { code: responseCode } : {}),
        ...(responseSessionId ? { sessionId: responseSessionId } : {}),
      });
      if (failStop) queueMicrotask(() => self.close());
      return { status: -1, length: Buffer.byteLength(body), body };
    }
  }

  function asyncCall(request: KernelActorClientCallRequest): void {
    const retryableRead =
      request.t === "reduce"
        ? isReadReducer(request.command)
        : READ_METHODS.has(request.method);
    let outputBytes = 256 * 1024;
    for (;;) {
      const result = executeCall(request, outputBytes);
      if (
        result.status === 2 &&
        retryableRead &&
        result.length > outputBytes &&
        result.length <= SESSION_KERNEL_MAX_RESPONSE_BYTES
      ) {
        outputBytes = result.length;
        continue;
      }
      post({
        t: "call_result",
        rpcId: request.rpcId,
        status: result.status === 2 && !retryableRead ? 1 : result.status,
        length: result.length,
        ...(result.status === 2 && retryableRead ? {} : { body: result.body }),
      });
      return;
    }
  }

  function serviceCall(request: KernelActorServiceCall): void {
    const outputBytes = Math.floor(request.outputBytes);
    if (outputBytes <= 0 || outputBytes > SESSION_KERNEL_MAX_RESPONSE_BYTES) {
      post({
        t: "error",
        rpcId: request.rpcId,
        error: "Invalid kernel actor response bound",
      });
      return;
    }
    const retryableRead =
      request.request.t === "reduce"
        ? isReadReducer(request.request.command)
        : READ_METHODS.has(request.request.method);
    const result = executeCall(request.request, outputBytes);
    post({
      t: "call_result",
      rpcId: request.rpcId,
      status: result.status === 2 && !retryableRead ? 1 : result.status,
      length: result.length,
      ...(result.status === 2 && retryableRead ? {} : { body: result.body }),
    });
  }

  self.onmessage = (
    event: MessageEvent<
      | KernelActorAsyncRequest
      | KernelActorClientCallRequest
      | KernelActorServiceCall
    >,
  ) => {
    const request = event.data;
    if (request.t === "call") {
      serviceCall(request);
      return;
    }
    if (request.t === "store" || request.t === "reduce") {
      asyncCall(request);
      return;
    }
    if (request.t === "hello") {
      if (request.version !== SESSION_KERNEL_ACTOR_VERSION)
        post({
          t: "error",
          rpcId: request.rpcId,
          error: "Unsupported kernel actor version",
        });
      else
        post({
          t: "ready",
          rpcId: request.rpcId,
          version: SESSION_KERNEL_ACTOR_VERSION,
        });
      return;
    }
    try {
      if (request.t === "acknowledge") {
        // Deliberately NOT fenced by quarantine: acknowledging a command only
        // stamps acknowledged_at on an already-completed receipt (monotonic,
        // idempotent, touches no semantic session state), so it cannot deepen
        // whatever ambiguity caused the quarantine. Failing it closed turned
        // every quarantined session into an endless client ack-retry loop that
        // surfaced to users as `Internal error handling "command_ack"` on
        // every reconnect for as long as the quarantine stood.
        host.call("acknowledgeCommand", [request.sessionId, request.requestId]);
        post({ t: "acknowledge_result", rpcId: request.rpcId });
      } else if (request.t === "stats") {
        post({ t: "stats_result", rpcId: request.rpcId, stats: host.stats() });
      } else if (request.t === "maintain") {
        const pending = host.maintain();
        post({ t: "maintain_result", rpcId: request.rpcId, pending });
      } else if (request.t === "runtime_catalog_work") {
        post({
          t: "runtime_catalog_work_result",
          rpcId: request.rpcId,
          ...host.runtimeCatalogWork(
            request.now,
            request.timerKinds,
            request.effectKinds,
            request.limit,
            request.additionalOutboxGroups,
            request.activeOutbox,
          ),
        });
      } else if (request.t === "runtime_session_work") {
        post({
          t: "runtime_session_work_result",
          rpcId: request.rpcId,
          ...host.runtimeSessionWork(
            request.sessionId,
            request.candidateCount,
            request.now,
            request.timerKinds,
            request.effectKinds,
            request.limit,
            request.additionalOutboxGroups,
            request.activeOutbox,
            request.activeOutboxRecheckAt,
          ),
        });
      } else if (request.t === "runtime_work") {
        throw new Error(
          "Runtime work must be routed through session mailboxes",
        );
      }
    } catch (error) {
      host.recordSqliteBusy(error);
      const sessionId =
        request.t === "acknowledge" ? request.sessionId : undefined;
      const isolatedFailure =
        !!sessionId &&
        isSessionKernelInfrastructureFailure(error) &&
        host.isIsolated(sessionId);
      if (isolatedFailure) {
        try {
          host.quarantineSession(
            sessionId,
            error instanceof Error ? error.message : String(error),
            "command:acknowledge",
            true,
          );
        } catch {
          queueMicrotask(() => self.close());
        }
      } else if (!(error instanceof SessionQuarantinedError)) {
        queueMicrotask(() => self.close());
      }
      post({
        t: "error",
        rpcId: request.rpcId,
        error: error instanceof Error ? error.message : String(error),
        ...(isSessionKernelCentralStoreFailure(error) ? { fatal: true } : {}),
      });
    }
  };
}

if (import.meta.main) startSessionKernelActorWorker();
