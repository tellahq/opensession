/**
 * One logical owner for a session.
 *
 * The production kernel actor admits commands and owns durable state for exactly
 * one session. This facade executes admitted physical effects in order, then
 * returns their fenced results. Engines and WebSockets never become owners.
 */
import { audit } from "../audit";
import type { AskActorRequest, AskActorResult } from "./ask-protocol";
import {
  type SessionActorEffectFor,
  type SessionActorEffectKind,
} from "./lifecycle-protocol";
import type {
  DeliveryActorRequest,
  DeliveryActorResult,
} from "./delivery-protocol";
import type { TurnActorRequest, TurnActorResult } from "./turn-protocol";
import type { TimerActorRequest, TimerActorResult } from "./timer-protocol";
import type {
  GatewayCommandRequest,
  GatewayCommandResult,
} from "./gateway-command-protocol";
import type { CoreActorRequest, CoreActorResult } from "./core-protocol";
import type {
  TranscriptActorRequest,
  TranscriptActorResult,
} from "./transcript-protocol";
import {
  SessionKernelActorError,
  type SessionKernelActorClient,
} from "./actor-client";
import {
  SessionKernelStore,
  type CreationEventDecision,
  type CreationEventDecisionResult,
  type DurableCommandRecord,
  type DurableCreationState,
  type DurableDeliveryState,
  type DurableRunState,
  type DurableTimer,
  type RunEventDecision,
  type RunEventDecisionResult,
} from "./store";

export function isRetryableSessionCommandError(error: unknown): boolean {
  if (error instanceof SessionKernelActorError) return error.retryable;
  const message = error instanceof Error ? error.message : String(error);
  return /session kernel actor|sqlite_busy|database is locked|timed out|server restart/i.test(
    message,
  );
}

/** Optional read-model data must not take its owning surface down while the
 * kernel lane is briefly degraded. Mutations and authoritative reads stay
 * strict; callers use this only for replaceable UI projections. */
export function sessionProjectionOr<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch (error) {
    if (!isRetryableSessionCommandError(error)) throw error;
    return fallback;
  }
}

type GlobalKernelState = {
  store?: SessionKernelStore;
  actor?: SessionKernelActorClient;
  kernels?: Map<string, SessionKernel>;
};

const globalState = globalThis as typeof globalThis & {
  __opensessionSessionKernel?: GlobalKernelState;
};
const state = (globalState.__opensessionSessionKernel ??= {});
function compatibilityStoreForTest(
  domain: "ask" | "core" | "creation" | "delivery" | "gateway command" | "turn",
) {
  if (process.env.NODE_ENV !== "test")
    throw new Error(
      `Session ${domain} mutation requires the authoritative actor`,
    );
  return __sessionKernelStoreForTest();
}

export async function sessionAsk<T extends AskActorRequest>(
  request: T,
): Promise<AskActorResult<T>> {
  if (state.actor) return state.actor.decideAskAsync(request);
  const store = compatibilityStoreForTest("ask");
  let result: unknown;
  if (request.op === "snapshot") result = store.askSnapshot(request.sessionId);
  else if (request.op === "entries") result = store.askEntries();
  else if (request.op === "set")
    result = store.setAskRecord(request.sessionId, request.value);
  else if (request.op === "answer")
    result = store.answerAskRecord(
      request.sessionId,
      request.questionId,
      request.answers,
      request.answeredVia,
    );
  else if (request.op === "delete")
    result = store.deleteAskRecord(request.sessionId);
  else result = store.clearAskRecords();
  return result as AskActorResult<T>;
}

export async function sessionTurn<T extends TurnActorRequest>(
  request: T,
): Promise<TurnActorResult<T>> {
  const actor = state.actor;
  if (actor) return actor.decideTurnAsync(request);
  const store = compatibilityStoreForTest("turn");
  if (request.op === "snapshot")
    return store.turnSnapshot(request.sessionId) as TurnActorResult<T>;
  if (request.op === "request_cancel_command")
    return store.requestTurnCancelCommand(request) as TurnActorResult<T>;
  if (request.op === "complete_cancel_command")
    return store.completeTurnCancelCommand(request) as TurnActorResult<T>;
  if (request.op === "fail_cancel_command")
    return store.failTurnCancelCommand(request) as TurnActorResult<T>;
  if (request.op === "prepare_cancel")
    return store.prepareTurnCancel(request) as TurnActorResult<T>;
  if (request.op === "begin_cancel_effect")
    return store.beginTurnCancelEffect(request) as TurnActorResult<T>;
  if (request.op === "settle_cancel")
    return store.settleTurnCancel(request) as TurnActorResult<T>;
  if (request.op === "prepare_outcome_projection")
    return store.prepareTurnOutcomeProjection(request) as TurnActorResult<T>;
  if (request.op === "begin_outcome_projection")
    return store.beginTurnOutcomeProjection(request) as TurnActorResult<T>;
  return store.settleTurnOutcomeProjection(request) as TurnActorResult<T>;
}

export async function sessionTimer<T extends TimerActorRequest>(
  request: T,
): Promise<TimerActorResult<T>> {
  if (state.actor) return state.actor.decideTimerAsync(request);
  const store = compatibilityStoreForTest("turn");
  if (request.op === "schedule")
    return store.scheduleTimer(request) as TimerActorResult<T>;
  if (request.op === "cancel")
    return store.cancelTimer(
      request.sessionId,
      request.timerId,
    ) as TimerActorResult<T>;
  if (request.op === "begin")
    return store.beginTimerExecution(request) as TimerActorResult<T>;
  if (request.op === "complete")
    return store.completeTimerExecution(request) as TimerActorResult<T>;
  if (request.op === "fail")
    return store.failTimerExecution(request) as TimerActorResult<T>;
  return store.recordTimerRuntimeFailure(request) as TimerActorResult<T>;
}

export async function sessionCore<T extends CoreActorRequest>(
  request: T,
): Promise<CoreActorResult<T>> {
  if (state.actor) return state.actor.decideCoreAsync(request);
  const store = compatibilityStoreForTest("core");
  if (request.op === "enqueue_effect")
    return store.enqueueOutbox(
      request.sessionId,
      request.kind,
      request.payload,
      request.effectKey,
    ) as CoreActorResult<T>;
  if (request.op === "ack_outbox")
    return store.ackOutbox(request.id) as CoreActorResult<T>;
  if (request.op === "defer_outbox")
    return store.deferOutbox(request.id) as CoreActorResult<T>;
  if (request.op === "fail_outbox")
    return store.noteOutboxFailure(
      request.id,
      request.error,
      request.maxAttempts,
    ) as CoreActorResult<T>;
  if (request.op === "clear")
    return store.clearSession(request.sessionId) as CoreActorResult<T>;
  return store.tombstoneSession(request.sessionId) as CoreActorResult<T>;
}

export async function sessionCoreAsync<T extends CoreActorRequest>(
  request: T,
): Promise<CoreActorResult<T>> {
  if (state.actor) return state.actor.decideCoreAsync(request);
  return sessionCore(request);
}

export async function sessionTranscript<T extends TranscriptActorRequest>(
  request: T,
): Promise<TranscriptActorResult<T>> {
  if (state.actor) return state.actor.decideTranscriptAsync(request);
  throw new Error(
    "Session transcript operation requires the authoritative actor",
  );
}

export async function actorTranscriptSessionIds(
  limit = 100,
  afterSessionId = "",
): Promise<string[]> {
  if (!state.actor)
    throw new Error(
      "Transcript catalog access requires the authoritative actor",
    );
  return state.actor.callAsync<string[]>(
    {
      t: "store",
      method: "actorTranscriptSessionIds",
      args: [limit, afterSessionId],
    },
    "actor transcript catalog",
  );
}

export async function sessionGatewayCommand<T extends GatewayCommandRequest>(
  request: T,
): Promise<GatewayCommandResult<T>> {
  if (state.actor) return state.actor.decideGatewayAsync(request);
  const store = compatibilityStoreForTest("gateway command");
  if (request.op === "request")
    return store.requestGatewayCommand(request) as GatewayCommandResult<T>;
  if (request.op === "complete")
    return store.completeGatewayCommand(request) as GatewayCommandResult<T>;
  return store.failGatewayCommand(request) as GatewayCommandResult<T>;
}

export async function sessionGatewayCommandAsync<
  T extends GatewayCommandRequest,
>(request: T): Promise<GatewayCommandResult<T>> {
  if (state.actor) return state.actor.decideGatewayAsync(request);
  return sessionGatewayCommand(request);
}

const deliveryProjectionCache = new Map<string, DurableDeliveryState>();

function noteDeliveryProjection(
  sessionId: string,
  snapshot: DurableDeliveryState,
): void {
  deliveryProjectionCache.set(sessionId, snapshot);
}

export function sessionDeliveryProjectionCached(
  sessionId: string,
): DurableDeliveryState {
  return (
    deliveryProjectionCache.get(sessionId) ?? {
      revision: 0,
      queued: [],
      steered: [],
      pendingSteers: [],
      updatedAt: 0,
    }
  );
}

export function sessionDeliveryEntriesCached(
  slot: import("./store").DeliverySlot,
): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const [sessionId, state] of deliveryProjectionCache) {
    const value =
      slot === "queued"
        ? state.queued
        : slot === "steered"
          ? state.steered
          : state.dispatch;
    if (value !== undefined && !(Array.isArray(value) && value.length === 0))
      entries.push([sessionId, value]);
  }
  return entries;
}

export async function sessionDelivery<T extends DeliveryActorRequest>(
  request: T,
): Promise<DeliveryActorResult<T>> {
  const actor = state.actor;
  let result: unknown;
  if (actor) result = await actor.decideDeliveryAsync(request);
  else {
    const store = compatibilityStoreForTest("delivery");
    if (request.op === "snapshot")
      result = store.deliverySnapshot(request.sessionId);
    else if (request.op === "entries")
      result = store.deliveryEntries(request.slot);
    else if (request.op === "request_submit_command")
      result = store.requestSubmitPromptCommand(request);
    else if (request.op === "complete_submit_command")
      result = store.completeSubmitPromptCommand(request);
    else if (request.op === "fail_submit_command")
      result = store.failSubmitPromptCommand(request);
    else if (request.op === "set")
      result = store.setDeliverySlot(
        request.sessionId,
        request.slot,
        request.value,
      );
    else if (request.op === "enqueue")
      result = store.enqueueDelivery(
        request.sessionId,
        request.item,
        request.front,
      );
    else if (request.op === "promote_queued")
      result = store.promoteQueuedDelivery(
        request.sessionId,
        request.itemId,
        request.promptEntryId,
        request.item,
      );
    else if (request.op === "delete")
      result = store.deleteDeliverySlot(request.sessionId, request.slot);
    else if (request.op === "clear_slot")
      result = store.clearDeliverySlot(request.slot);
    else if (request.op === "prepare_steer")
      result = store.prepareSteerDelivery(
        request.sessionId,
        request.itemId,
        request.target,
        request.item,
      );
    else if (request.op === "accept_steer")
      result = store.acceptSteerDelivery(
        request.sessionId,
        request.itemId,
        request.target,
      );
    else if (request.op === "reject_steer")
      result = store.rejectSteerDelivery(
        request.sessionId,
        request.itemId,
        request.target,
      );
    else if (request.op === "settle_pending_steers")
      result = store.settlePendingSteers();
    else if (request.op === "requeue_steers")
      result = store.requeueSteerDeliveries(request.sessionId, request.items);
    else if (request.op === "prepare_interrupt")
      result = store.prepareDeliveryInterrupt(request);
    else if (request.op === "begin_interrupt_effect")
      result = store.beginDeliveryInterruptEffect(request);
    else if (request.op === "settle_interrupt")
      result = store.settleDeliveryInterrupt(request);
    else if (request.op === "claim_next_dispatch")
      result = store.claimNextDeliveryDispatch(request);
    else if (request.op === "claim_dispatch")
      result = store.claimDeliveryDispatch(request);
    else if (request.op === "ack_dispatch")
      result = store.ackDeliveryDispatch(
        request.sessionId,
        request.promptEntryId,
      );
    else
      result = store.failDeliveryDispatch(
        request.sessionId,
        request.promptEntryId,
      );
  }
  if (request.op === "snapshot")
    noteDeliveryProjection(request.sessionId, result as DurableDeliveryState);
  else if (request.op === "entries") {
    const entries = result as Array<[string, unknown]>;
    const present = new Set(entries.map(([sessionId]) => sessionId));
    for (const [sessionId, snapshot] of deliveryProjectionCache) {
      if (present.has(sessionId)) continue;
      noteDeliveryProjection(sessionId, {
        ...snapshot,
        ...(request.slot === "queued"
          ? { queued: [] }
          : request.slot === "steered"
            ? { steered: [] }
            : { dispatch: undefined }),
      });
    }
    for (const [sessionId, value] of entries) {
      const snapshot = sessionDeliveryProjectionCached(sessionId);
      noteDeliveryProjection(sessionId, {
        ...snapshot,
        ...(request.slot === "queued"
          ? { queued: value }
          : request.slot === "steered"
            ? { steered: value }
            : { dispatch: value }),
      } as DurableDeliveryState);
    }
  } else if ("sessionId" in request) {
    try {
      const snapshot = actor
        ? await actor.decideDeliveryAsync({
            op: "snapshot",
            sessionId: request.sessionId,
          })
        : compatibilityStoreForTest("delivery").deliverySnapshot(
            request.sessionId,
          );
      noteDeliveryProjection(request.sessionId, snapshot);
    } catch (error) {
      console.error(
        `[session-kernel] delivery projection refresh failed for ${request.sessionId}:`,
        error,
      );
    }
  } else if (request.op === "clear_slot") {
    for (const [sessionId, snapshot] of deliveryProjectionCache) {
      noteDeliveryProjection(sessionId, {
        ...snapshot,
        ...(request.slot === "queued"
          ? { queued: [] }
          : request.slot === "steered"
            ? { steered: [] }
            : { dispatch: undefined }),
      });
    }
  }
  return result as DeliveryActorResult<T>;
}

export async function sessionDeliveryProjection(
  sessionId: string,
): Promise<DurableDeliveryState> {
  return sessionDelivery({ op: "snapshot", sessionId });
}

async function sessionStoreAsync<TResult>(
  method: string,
  args: unknown[] = [],
  large = false,
): Promise<TResult> {
  if (state.actor)
    return state.actor.callAsync<TResult>(
      { t: "store", method, args },
      method,
      large,
    );
  const store = __sessionKernelStoreForTest() as unknown as Record<
    string,
    (...values: unknown[]) => TResult
  >;
  return store[method](...args);
}

export function sessionAskMigrationComplete(): Promise<boolean> {
  return sessionStoreAsync("askMigrationComplete");
}

export function markSessionAskMigrationComplete(): Promise<void> {
  return sessionStoreAsync("markAskMigrationComplete");
}

export function sessionDeliveryMigrationComplete(): Promise<boolean> {
  return sessionStoreAsync("deliveryMigrationComplete");
}

export function markSessionDeliveryMigrationComplete(): Promise<void> {
  return sessionStoreAsync("markDeliveryMigrationComplete");
}

export function sessionQuarantineSnapshot(
  sessionId: string,
): Promise<import("./store").DurableSessionQuarantine | undefined> {
  return sessionStoreAsync("quarantinedSession", [sessionId]);
}

export function sessionQuarantines(
  limit = 10_000,
): Promise<import("./store").DurableSessionQuarantine[]> {
  return sessionStoreAsync("quarantinedSessions", [limit, 0], true);
}

export function sessionKernelActorActive(): boolean {
  return !!state.actor;
}

export async function sessionIsQuarantined(
  sessionId: string,
): Promise<boolean> {
  return !!(await sessionStoreAsync<unknown>("quarantinedSession", [
    sessionId,
  ]));
}

export function quarantineSessionForSafety(
  sessionId: string,
  reason: string,
  operation: string,
): Promise<import("./store").DurableSessionQuarantine> {
  return sessionStoreAsync("quarantineSession", [sessionId, reason, operation]);
}

export function __sessionKernelStoreForTest(): SessionKernelStore {
  if (state.store) return state.store;
  if (process.env.NODE_ENV === "test")
    return (state.store = new SessionKernelStore());
  throw new Error(
    "Session kernel store requires the authoritative actor service",
  );
}

export function __setSessionKernelStoreForTest(
  store: SessionKernelStore | undefined,
): SessionKernelStore | undefined {
  const previous = state.store;
  state.store = store;
  state.actor = undefined;
  state.kernels?.clear();
  return previous instanceof SessionKernelStore ? previous : undefined;
}

export function installSessionKernelActor(
  actor: SessionKernelActorClient | undefined,
): SessionKernelActorClient | undefined {
  const previous = state.actor;
  state.actor = actor;
  state.kernels?.clear();
  return previous;
}

export class SessionKernel {
  private lastUsedAt = Date.now();

  constructor(readonly sessionId: string) {}

  get isIdle(): boolean {
    return true;
  }

  get idleSince(): number {
    return this.lastUsedAt;
  }

  private async assertWritable(operation?: string): Promise<void> {
    const tombstoned = state.actor
      ? await state.actor.callAsync<boolean>(
          { t: "store", method: "isTombstoned", args: [this.sessionId] },
          "isTombstoned",
        )
      : __sessionKernelStoreForTest().isTombstoned(this.sessionId);
    if (
      tombstoned &&
      operation !== "session_delete" &&
      operation !== "transcript_delete"
    )
      throw new Error(`Session ${this.sessionId} was deleted`);
  }

  async applyCreationEvent(
    input: Omit<CreationEventDecision, "sessionId">,
  ): Promise<CreationEventDecisionResult> {
    await this.assertWritable(`creation_state:${input.event}`);
    this.touch();
    const result = state.actor
      ? await state.actor.decideCreationEventAsync({
          sessionId: this.sessionId,
          ...input,
        })
      : compatibilityStoreForTest("creation").applyCreationEvent({
          sessionId: this.sessionId,
          ...input,
        });
    if (!result.accepted && result.reason === "stale_effect")
      audit({
        msg: "session_creation_stale_result_rejected",
        session_id: this.sessionId,
        creation_identity: input.identity,
        effect_id: input.effectId,
        current_effect_id: result.state?.currentEffectId,
        creation_generation: result.state?.generation,
        event: input.event,
      });
    return result;
  }

  creationState(): Promise<DurableCreationState | undefined> {
    this.touch();
    return sessionCreationState(this.sessionId);
  }

  async applyRunEvent(
    input: Omit<RunEventDecision, "sessionId">,
  ): Promise<RunEventDecisionResult> {
    await this.assertWritable(`run_state:${input.event}`);
    this.touch();
    return state.actor
      ? state.actor.decideRunEventAsync({ sessionId: this.sessionId, ...input })
      : compatibilityStoreForTest("core").applyRunEvent({
          sessionId: this.sessionId,
          ...input,
        });
  }

  /** Gateway-local run projection. It is never durable evidence. */
  runStateProjection(): DurableRunState {
    this.touch();
    return sessionRunStateProjection(this.sessionId);
  }

  isCurrentRunProjection(runId: string, generation?: number): boolean {
    const current = this.runStateProjection();
    return (
      ["running", "ask_blocked", "interrupted", "reattaching"].includes(
        current.state,
      ) &&
      current.currentRunId === runId &&
      (generation === undefined || current.generation === generation)
    );
  }

  changesSince(changeSeq: number, limit = 500) {
    this.touch();
    return sessionChangesSince(this.sessionId, changeSeq, limit);
  }

  scheduleTimer(
    timer: Omit<
      DurableTimer,
      | "sessionId"
      | "token"
      | "attempts"
      | "nextAttemptAt"
      | "lastError"
      | "deadLetteredAt"
      | "createdAt"
    >,
  ): Promise<void> {
    return sessionTimer({
      op: "schedule",
      sessionId: this.sessionId,
      ...timer,
    });
  }

  cancelTimer(timerId: string): Promise<void> {
    return sessionTimer({
      op: "cancel",
      sessionId: this.sessionId,
      timerId,
    }).then(() => {});
  }

  enqueueEffect<K extends SessionActorEffectKind>(
    kind: K,
    payload: SessionActorEffectFor<K>["payload"],
    effectKey: string = crypto.randomUUID(),
  ): Promise<number> {
    this.touch();
    return sessionCore({
      op: "enqueue_effect",
      sessionId: this.sessionId,
      kind,
      payload:
        payload as SessionActorEffectFor<SessionActorEffectKind>["payload"],
      effectKey,
    });
  }

  clear(): Promise<void> {
    return sessionCore({ op: "clear", sessionId: this.sessionId }).then(
      () => {},
    );
  }

  tombstone(): Promise<void> {
    return sessionCore({ op: "tombstone", sessionId: this.sessionId }).then(
      () => {},
    );
  }

  private touch(): void {
    this.lastUsedAt = Date.now();
  }
}

function kernels(): Map<string, SessionKernel> {
  return (state.kernels ??= new Map());
}

export function peekSessionKernel(
  sessionId: string,
): SessionKernel | undefined {
  return state.kernels?.get(sessionId);
}

export function sessionKernel(sessionId: string): SessionKernel {
  if (!sessionId) throw new Error("SessionKernel requires sessionId");
  let kernel = kernels().get(sessionId);
  if (!kernel) {
    kernel = new SessionKernel(sessionId);
    kernels().set(sessionId, kernel);
  }
  return kernel;
}

export function activeSessionKernels(): readonly SessionKernel[] {
  return [...kernels().values()];
}

export function passivateIdleSessionKernels(
  now = Date.now(),
  idleMs = 60_000,
): number {
  let count = 0;
  for (const [sessionId, kernel] of kernels()) {
    if (!kernel.isIdle || now - kernel.idleSince < idleMs) continue;
    kernels().delete(sessionId);
    count += 1;
  }
  return count;
}

export async function clearSessionKernel(sessionId: string): Promise<void> {
  const kernel = kernels().get(sessionId) ?? sessionKernel(sessionId);
  await kernel.clear();
  kernels().delete(sessionId);
}

export function durableSessionCommand(
  sessionId: string,
  requestId: string,
): Promise<DurableCommandRecord | undefined> {
  return sessionStoreAsync("command", [sessionId, requestId]);
}

export function sessionCreationState(
  sessionId: string,
): Promise<DurableCreationState | undefined> {
  return sessionStoreAsync("creationState", [sessionId], true);
}

/** Authoritative run state for recovery decisions. Unlike runStateProjection(),
 * this crosses the actor boundary and may be used as durable terminal proof. */
export function sessionRunStateSnapshot(
  sessionId: string,
): Promise<DurableRunState> {
  return sessionStoreAsync("runState", [sessionId]);
}

export function sessionTurnSnapshot(sessionId: string) {
  return sessionTurn({ op: "snapshot", sessionId });
}

export function sessionChangesSince(
  sessionId: string,
  after: number,
  limit = 500,
) {
  return sessionStoreAsync<ReturnType<SessionKernelStore["changesSince"]>>(
    "changesSince",
    [sessionId, after, limit],
    true,
  );
}

/** Replaceable gateway-local projection hydrated during the actor handshake. */
export function sessionRunStateProjection(sessionId: string): DurableRunState {
  if (state.actor) return state.actor.runStateProjection(sessionId);
  return __sessionKernelStoreForTest().runState(sessionId);
}

export function sessionRunStateProjections(): Array<
  DurableRunState & { sessionId: string }
> {
  if (state.actor) return state.actor.runStateProjections();
  return __sessionKernelStoreForTest().runStates();
}

export function sessionTombstoneState(sessionId: string): Promise<boolean> {
  return sessionStoreAsync("isTombstoned", [sessionId]);
}

export function sessionTimerSnapshot(
  sessionId: string,
  timerId: string,
): Promise<DurableTimer | undefined> {
  return sessionStoreAsync("timer", [sessionId, timerId]);
}

export function sessionKernelDeadLetters(limit = 100, offset = 0) {
  return sessionStoreAsync<ReturnType<SessionKernelStore["deadLetters"]>>(
    "deadLetters",
    [limit, offset],
    true,
  );
}

export function releaseSessionQuarantine(sessionId: string): Promise<boolean> {
  return sessionStoreAsync("releaseQuarantine", [sessionId]);
}

export function discardSessionDeadTimer(
  sessionId: string,
  timerId: string,
): Promise<boolean> {
  return sessionStoreAsync("discardDeadTimer", [sessionId, timerId]);
}

export function retrySessionDeadTimer(
  sessionId: string,
  timerId: string,
): Promise<boolean> {
  return sessionStoreAsync("retryDeadTimer", [sessionId, timerId]);
}

export function discardSessionDeadOutbox(id: number): Promise<boolean> {
  return sessionStoreAsync("discardDeadOutbox", [id]);
}

export function retrySessionDeadOutbox(id: number): Promise<boolean> {
  return sessionStoreAsync("retryDeadOutbox", [id]);
}

export async function acknowledgeSessionCommand(
  sessionId: string,
  requestId: string,
): Promise<void> {
  if (state.actor) {
    await state.actor.acknowledgeCommand(sessionId, requestId);
    return;
  }
  __sessionKernelStoreForTest().acknowledgeCommand(sessionId, requestId);
}

export async function sessionKernelRuntimeWork(
  timerKinds: string[],
  effectKinds: string[],
  now = Date.now(),
  limit = 100,
  additionalOutboxGroups: Array<{
    effectKinds: string[];
    limit: number;
  }> = [],
  activeOutbox: Array<{ id: number; sessionId: string }> = [],
  activeOutboxRecheckAt = now,
): Promise<{
  timers: DurableTimer[];
  outbox: import("./store").DurableOutboxItem[];
}> {
  if (state.actor)
    return state.actor.runtimeWork(
      timerKinds,
      effectKinds,
      now,
      limit,
      additionalOutboxGroups,
      activeOutbox,
      activeOutboxRecheckAt,
    );
  const store = __sessionKernelStoreForTest();
  const outbox = new Map<number, import("./store").DurableOutboxItem>();
  const activeIds = activeOutbox.map((item) => item.id);
  for (const group of [{ effectKinds, limit }, ...additionalOutboxGroups]) {
    for (const item of store.pendingOutbox(
      now,
      group.limit,
      group.effectKinds,
      activeIds,
    ))
      outbox.set(item.id, item);
  }
  return {
    timers: store.dueTimers(now, limit, timerKinds),
    outbox: [...outbox.values()],
  };
}

/** Health and readiness use the gateway-local snapshot. Aggregate accounting
 * belongs in catalog projections; request paths never inspect actor shards. */
export function sessionKernelReadinessSnapshot(): Record<string, unknown> {
  return {
    active: state.kernels?.size ?? 0,
    detailedStatsDeferred: true,
  };
}

export async function sessionKernelHealth(): Promise<Record<string, unknown>> {
  return sessionKernelReadinessSnapshot();
}

export async function maintainSessionKernel(): Promise<boolean> {
  if (state.actor) return state.actor.maintainAsync();
  return __sessionKernelStoreForTest().maintain();
}

export async function tombstoneSessionKernel(sessionId: string): Promise<void> {
  const kernel = state.kernels?.get(sessionId) ?? new SessionKernel(sessionId);
  await kernel.tombstone();
  state.kernels?.delete(sessionId);
}
