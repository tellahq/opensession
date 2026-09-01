/** Runtime wake-ups for durable timers and outbox effects. */
import {
  passivateIdleSessionKernels,
  sessionCoreAsync,
  sessionKernel,
  sessionKernelRuntimeWork,
  maintainSessionKernel,
  sessionIsQuarantined,
  sessionRunStateProjections,
  sessionTimer,
  sessionTimerSnapshot,
} from "./kernel";
import type { DurableOutboxItem, DurableTimer } from "./store";
import {
  executeSessionEffect,
  registeredSessionEffectKinds,
  SessionEffectDeferredError,
} from "./effect-executors";
import { pruneCreatePlans } from "../session-create-plan";
import {
  CreationEffectIndeterminateError,
  ensureCreationEffectExecutors,
} from "./creation-effect-executors";
import { audit } from "../audit";
import { SessionKernelQuarantinedError } from "./actor-client";
import { envCapacity } from "../shared/env-capacity";

// Runtime effect execution happens in the gateway process (physical work),
// so these knobs are read from the gateway environment.
const TIMER_CONCURRENCY = envCapacity(
  "OPENSESSION_KERNEL_TIMER_CONCURRENCY",
  8,
  1,
  64,
);
const OUTBOX_CONCURRENCY = envCapacity(
  "OPENSESSION_KERNEL_OUTBOX_CONCURRENCY",
  8,
  1,
  64,
);
const OPENING_OUTBOX_CONCURRENCY = envCapacity(
  "OPENSESSION_KERNEL_OPENING_OUTBOX_CONCURRENCY",
  100,
  1,
  512,
);

type TimerHandler = (timer: DurableTimer) => void | Promise<void>;

class SessionTimerExecutionError extends Error {
  constructor(
    readonly cause: unknown,
    readonly deadLetteredNow: boolean,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SessionTimerExecutionError";
  }
}

async function timerRuntimeFailure(
  timer: DurableTimer,
  error: unknown,
): Promise<SessionTimerExecutionError> {
  let deadLetteredNow = false;
  try {
    deadLetteredNow = (
      await sessionTimer({
        op: "record_runtime_failure",
        sessionId: timer.sessionId,
        timerId: timer.timerId,
        token: timer.token,
        error: error instanceof Error ? error.message : String(error),
        maxAttempts: 20,
        observedAttempts: timer.attempts,
      })
    ).deadLetteredNow;
  } catch {
    // The actor is the only timer writer. If it is unavailable, preserve the
    // original failure and let the next actor-owned runtime pass retry.
  }
  return new SessionTimerExecutionError(error, deadLetteredNow);
}

async function failDeadCreationEffect(
  item: DurableOutboxItem,
  error: string,
): Promise<void> {
  if (!item.kind.startsWith("creation_")) return;
  const payload = item.payload as
    | { creationIdentity?: unknown; creationGeneration?: unknown }
    | undefined;
  if (
    typeof payload?.creationIdentity !== "string" ||
    payload.creationIdentity.length === 0 ||
    !Number.isSafeInteger(payload.creationGeneration)
  )
    return;
  const result = await sessionKernel(item.sessionId).applyCreationEvent({
    identity: payload.creationIdentity,
    event: "failed",
    effectId: item.effectKey,
    detail: { effectKind: item.kind, error },
  });
  if (!result.accepted && result.reason !== "stale_effect")
    throw new Error(
      `Creation effect ${item.effectId} failure was rejected: ${result.reason || "unknown"}`,
    );
}
type RuntimeState = {
  timerHandlers: Map<string, TimerHandler>;
  handle?: ReturnType<typeof setInterval>;
  draining?: boolean;
  lastCompactAt?: number;
  startedAt?: number;
  nextMaintenanceAt?: number;
  maintenancePending?: boolean;
  activeTimers?: Set<string>;
  activeOutbox?: Map<number, string>;
  activeOpeningOutbox?: Map<number, string>;
  pendingOutbox?: Map<number, DurableOutboxItem>;
  lastRuntimePollErrorAt?: number;
};

const globalRuntime = globalThis as typeof globalThis & {
  __opensessionSessionKernelRuntime?: RuntimeState;
};
const runtime: RuntimeState =
  (globalRuntime.__opensessionSessionKernelRuntime ??= {
    timerHandlers: new Map(),
  });
runtime.startedAt ??= Date.now();

// Maintenance is catalog-only and is not a readiness prerequisite. Keep it
// delayed and spaced so recovery traffic retains priority after startup.
const BOOT_MAINTENANCE_DELAY_MS = 5 * 60_000;
const MAINTENANCE_SWEEP_INTERVAL_MS = 60 * 60_000;
const MAINTENANCE_CONTINUATION_DELAY_MS = 15_000;
// Keep active physical effects out of the one-second discovery loop while
// retaining a short, durable retry horizon if the gateway disappears.
const ACTIVE_OUTBOX_RECHECK_MS = 30_000;
const PENDING_OUTBOX_LIMIT = 512;

export function registerSessionTimerHandler(
  kind: string,
  handler: TimerHandler,
): () => void {
  runtime.timerHandlers.set(kind, handler);
  return () => {
    if (runtime.timerHandlers.get(kind) === handler)
      runtime.timerHandlers.delete(kind);
  };
}

export async function fireSessionTimer(timer: DurableTimer): Promise<boolean> {
  const handler = runtime.timerHandlers.get(timer.kind);
  if (!handler) return false;
  let decision: "execute" | "completed" | "missing";
  try {
    decision = await sessionTimer({
      op: "begin",
      sessionId: timer.sessionId,
      timerId: timer.timerId,
      token: timer.token,
    });
  } catch (error) {
    throw await timerRuntimeFailure(timer, error);
  }
  if (decision === "missing") return false;
  if (decision === "completed") return true;
  try {
    await handler(timer);
  } catch (error) {
    try {
      const settled = await sessionTimer({
        op: "fail",
        sessionId: timer.sessionId,
        timerId: timer.timerId,
        token: timer.token,
        error: error instanceof Error ? error.message : String(error),
        maxAttempts: 20,
      });
      throw new SessionTimerExecutionError(error, settled.deadLetteredNow);
    } catch (settlementError) {
      if (settlementError instanceof SessionTimerExecutionError)
        throw settlementError;
      throw await timerRuntimeFailure(timer, settlementError);
    }
  }
  try {
    await sessionTimer({
      op: "complete",
      sessionId: timer.sessionId,
      timerId: timer.timerId,
      token: timer.token,
    });
  } catch (error) {
    throw await timerRuntimeFailure(timer, error);
  }
  return true;
}

export async function fireStoredSessionTimer(
  sessionId: string,
  timerId: string,
): Promise<boolean> {
  const timer = await sessionTimerSnapshot(sessionId, timerId);
  return timer ? fireSessionTimer(timer) : false;
}

export async function drainSessionKernelRuntime(): Promise<void> {
  if (runtime.draining) return;
  runtime.draining = true;
  try {
    const timerKinds = [...runtime.timerHandlers.keys()];
    const effectKinds = registeredSessionEffectKinds();
    const openingKind = "creation_opening_turn";
    const now = Date.now();
    const activeOutbox = (runtime.activeOutbox ??= new Map());
    const activeOpeningOutbox = (runtime.activeOpeningOutbox ??= new Map());
    const pendingOutbox = (runtime.pendingOutbox ??= new Map());
    const activeEffects = new Map<number, string>([
      ...activeOutbox.entries(),
      ...activeOpeningOutbox.entries(),
    ]);
    for (const item of pendingOutbox.values())
      activeEffects.set(item.id, item.sessionId);
    // Fetch ordinary and opening effects in one actor pass. Separate quotas
    // preserve opening admission without opening and rescanning another batch
    // of per-session SQLite databases every second.
    const work = await sessionKernelRuntimeWork(
      timerKinds,
      effectKinds.filter((kind) => kind !== openingKind),
      now,
      100,
      effectKinds.includes(openingKind)
        ? [{ effectKinds: [openingKind], limit: OPENING_OUTBOX_CONCURRENCY }]
        : [],
      [...activeEffects].map(([id, sessionId]) => ({ id, sessionId })),
      now + ACTIVE_OUTBOX_RECHECK_MS,
    );
    const activeTimers = (runtime.activeTimers ??= new Set());
    for (const timer of work.timers) {
      if (activeTimers.size >= TIMER_CONCURRENCY) break;
      const key = `${timer.sessionId}:${timer.timerId}:${timer.token}`;
      if (activeTimers.has(key)) continue;
      activeTimers.add(key);
      void fireSessionTimer(timer)
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          if (
            error instanceof SessionTimerExecutionError &&
            error.deadLetteredNow
          )
            audit({
              msg: "session_kernel_dead_lettered",
              kind: "timer",
              session_id: timer.sessionId,
              timer_id: timer.timerId,
              error: message,
            });
          console.error(
            `[session-kernel] timer ${timer.kind}/${timer.timerId} failed:`,
            error instanceof SessionTimerExecutionError ? error.cause : error,
          );
        })
        .finally(() => activeTimers.delete(key));
    }
    for (const item of work.outbox) {
      if (pendingOutbox.size >= PENDING_OUTBOX_LIMIT) break;
      pendingOutbox.set(item.id, item);
    }
    for (const item of pendingOutbox.values()) {
      // Opening turns can legitimately last for hours. Keep their bounded
      // execution pool separate so eight accepted openings cannot starve
      // delivery, preparation, or projection effects globally.
      const active =
        item.kind === "creation_opening_turn"
          ? activeOpeningOutbox
          : activeOutbox;
      const admissionLimit =
        item.kind === openingKind
          ? OPENING_OUTBOX_CONCURRENCY
          : OUTBOX_CONCURRENCY;
      if (active.has(item.id)) {
        pendingOutbox.delete(item.id);
        continue;
      }
      if (active.size >= admissionLimit) continue;
      pendingOutbox.delete(item.id);
      active.set(item.id, item.sessionId);
      void executeSessionEffect(item)
        .then(async (executed) => {
          if (!executed) return;
          try {
            await sessionCoreAsync({
              op: "ack_outbox",
              id: item.id,
              sessionId: item.sessionId,
            });
          } catch (settlementError) {
            // The physical effect succeeded. An acknowledgement timeout is
            // therefore an indeterminate settlement, not an effect failure:
            // fail_outbox would falsely retry/account for work that completed.
            // A committed ACK removes the item; an uncommitted ACK leaves it
            // available for the runtime's next idempotent execution pass.
            console.error(
              `[session-kernel] outbox ${item.kind}/${item.id} completed but could not acknowledge:`,
              settlementError,
            );
          }
        })
        .catch(async (error) => {
          if (error instanceof SessionKernelQuarantinedError) {
            console.error(
              `[session-kernel] outbox ${item.kind}/${item.id} frozen with quarantined session ${item.sessionId}:`,
              error,
            );
            return;
          }
          try {
            if (error instanceof SessionEffectDeferredError) {
              await sessionCoreAsync({
                op: "defer_outbox",
                id: item.id,
                sessionId: item.sessionId,
              });
              return;
            }
            const message =
              error instanceof Error ? error.message : String(error);
            const settled = await sessionCoreAsync({
              op: "fail_outbox",
              id: item.id,
              sessionId: item.sessionId,
              error: message,
              maxAttempts:
                error instanceof CreationEffectIndeterminateError ? 1 : 20,
            });
            if (settled.deadLetteredNow) {
              await failDeadCreationEffect(item, message);
              audit({
                msg: "session_kernel_dead_lettered",
                kind: "outbox",
                session_id: item.sessionId,
                outbox_id: item.id,
                error: message,
              });
            }
            console.error(
              `[session-kernel] outbox ${item.kind}/${item.id} failed:`,
              error,
            );
          } catch (settlementError) {
            // Session quarantine freezes accepted work in place. Catalog/actor
            // failures are handled by the actor client's fail-closed callback;
            // neither may escape this detached promise as an unhandled rejection.
            console.error(
              `[session-kernel] outbox ${item.kind}/${item.id} could not settle its failure:`,
              settlementError,
            );
          }
        })
        .finally(() => active.delete(item.id));
    }
    passivateIdleSessionKernels();
    const maintenanceNow = Date.now();
    const maintenanceScheduleDue =
      maintenanceNow >=
      (runtime.nextMaintenanceAt ??
        (runtime.startedAt ?? maintenanceNow) + BOOT_MAINTENANCE_DELAY_MS);
    const maintenanceSweepDue =
      !runtime.maintenancePending &&
      maintenanceScheduleDue &&
      (!runtime.lastCompactAt ||
        maintenanceNow - runtime.lastCompactAt >=
          MAINTENANCE_SWEEP_INTERVAL_MS);
    const maintenanceContinuationDue =
      !!runtime.maintenancePending && maintenanceScheduleDue;
    if (maintenanceSweepDue || maintenanceContinuationDue) {
      // Set the retry point before awaiting so a failed actor call cannot turn
      // the one-second runtime ticker into a maintenance request storm.
      runtime.nextMaintenanceAt =
        maintenanceNow + MAINTENANCE_CONTINUATION_DELAY_MS;
      runtime.maintenancePending = await maintainSessionKernel();
      if (maintenanceSweepDue) {
        // Legacy create-plan files are forensic evidence. Their asynchronous
        // receipt sweep runs outside the gateway/kernel compatibility store.
        runtime.lastCompactAt = maintenanceNow;
      }
      if (!runtime.maintenancePending)
        runtime.nextMaintenanceAt =
          maintenanceNow + MAINTENANCE_SWEEP_INTERVAL_MS;
    }
  } finally {
    runtime.draining = false;
  }
}

export function startSessionKernelRuntime(intervalMs = 1_000): void {
  if (runtime.handle) return;
  ensureCreationEffectExecutors();
  const drain = () => {
    void drainSessionKernelRuntime().catch((error) => {
      const now = Date.now();
      if (
        !runtime.lastRuntimePollErrorAt ||
        now - runtime.lastRuntimePollErrorAt >= 30_000
      ) {
        runtime.lastRuntimePollErrorAt = now;
        console.error("[session-kernel] runtime poll failed; retrying:", error);
      }
    });
  };
  runtime.handle = setInterval(() => {
    drain();
  }, intervalMs);
  runtime.handle.unref?.();
  drain();
}

export function stopSessionKernelRuntime(): void {
  if (runtime.handle) clearInterval(runtime.handle);
  runtime.handle = undefined;
}

/** Settle durable ownership left behind without a recoverable journal. */
export async function reconcileSessionKernelOwnership(
  ownedSessionIds: ReadonlySet<string>,
): Promise<string[]> {
  const unsettled = new Set([
    "preparing",
    "starting",
    "running",
    "ask_blocked",
    "interrupted",
    "reattaching",
  ]);
  const settled: string[] = [];
  for (const state of sessionRunStateProjections()) {
    if (
      !unsettled.has(state.state) ||
      ownedSessionIds.has(state.sessionId) ||
      (await sessionIsQuarantined(state.sessionId))
    )
      continue;
    await sessionKernel(state.sessionId).applyRunEvent({
      event: "boot_owner_missing",
      detail: { previousState: state.state },
    });
    settled.push(state.sessionId);
  }
  return settled;
}

export async function waitForSessionKernelRuntimeIdle(
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (
    (runtime.activeTimers?.size || 0) > 0 ||
    (runtime.activeOutbox?.size || 0) > 0 ||
    (runtime.activeOpeningOutbox?.size || 0) > 0
  ) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(5);
  }
  return true;
}
