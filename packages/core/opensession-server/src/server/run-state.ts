/**
 * Authoritative per-session run-state machine.
 *
 * The transition table remains pure and exhaustively tested. Runtime state is
 * committed by SessionKernel, which gives prompt admission, recovery, asks,
 * cancellation and executor events one durable answer to whether the session
 * is owned. Detached run hosts keep only a private ephemeral view: they report
 * events to the server and never write the session kernel database.
 */

import { audit } from "./audit";
import {
  clearSessionKernel,
  sessionKernel,
  sessionRunStateProjection,
} from "./session-kernel";

export {
  RUN_STATE_TRANSITIONS,
  nextRunState,
  type RunEvent,
  type RunState,
} from "./session-kernel/run-state-machine";
import {
  nextRunState,
  type RunEvent,
  type RunState,
} from "./session-kernel/run-state-machine";

export type RunStateEntry = {
  state: RunState;
  since: string;
  lastEvent?: RunEvent;
};

/** States that still own the session and must settle before a new turn starts. */
export function isRunStateUnsettled(state: RunState): boolean {
  return (
    state === "preparing" ||
    state === "starting" ||
    state === "running" ||
    state === "ask_blocked" ||
    state === "interrupted" ||
    state === "reattaching"
  );
}

const detachedHostStates = new Map<string, RunStateEntry>();
const detachedRunHost = () => !!process.env.OPENSESSION_RUN_JOURNAL;

export const runStates = {
  get(sessionId: string): RunStateEntry | undefined {
    if (detachedRunHost()) return detachedHostStates.get(sessionId);
    const current = sessionRunStateProjection(sessionId);
    if (current.changeSeq === 0) return undefined;
    return {
      state: current.state as RunState,
      since: current.since,
      lastEvent: current.lastEvent as RunEvent | undefined,
    };
  },
};

export function getRunState(sessionId: string): RunState {
  if (detachedRunHost())
    return detachedHostStates.get(sessionId)?.state ?? "idle";
  return sessionRunStateProjection(sessionId).state as RunState;
}

type AuditEmit = (event: Record<string, unknown>) => void;

export type RunStateTransitionDecision = {
  accepted: boolean;
  from: RunState;
  to: RunState;
  reason?: "invalid_transition" | "stale_run";
  currentRunId?: string;
  rejectedRunId?: string;
};

/** Apply one run event and retain the actor's admission decision. */
export async function decideRunStateTransition(
  sessionId: string,
  event: RunEvent,
  detail?: Record<string, unknown>,
  emit: AuditEmit = audit,
): Promise<RunStateTransitionDecision> {
  if (detachedRunHost()) {
    const from = getRunState(sessionId);
    const next = nextRunState(from, event);
    if (!next) {
      console.warn(
        `[run-state] rejected: ${event} while ${from} (session ${sessionId})`,
      );
      emit({
        msg: "run_state_rejected",
        session_id: sessionId,
        state: from,
        event,
        ...detail,
      });
      return { accepted: false, from, to: from, reason: "invalid_transition" };
    }
    detachedHostStates.set(sessionId, {
      state: next,
      since: new Date().toISOString(),
      lastEvent: event,
    });
    emit({
      msg: "run_state_transition",
      session_id: sessionId,
      from,
      to: next,
      event,
      ...detail,
    });
    return { accepted: true, from, to: next };
  }

  const runKey =
    typeof detail?.run_key === "string" ? detail.run_key : undefined;
  const decision = await sessionKernel(sessionId).applyRunEvent({
    event,
    detail,
    runKey,
  });
  if (!decision.accepted) {
    if (decision.reason === "stale_run") {
      emit({
        msg: "stale_run_registration_rejected",
        session_id: sessionId,
        current_run_id: decision.currentRunId,
        rejected_run_id: decision.rejectedRunId,
        state: decision.from,
      });
    } else {
      // Boot-drained prompts park here while restart recovery still owns
      // the session (interrupted/reattaching). That is the designed
      // fail-closed fence, not a defect — one warning per parked prompt
      // per boot is noise, so only unexpected rejections warn.
      const parkedPrompt =
        event === "prompt" &&
        (decision.from === "interrupted" || decision.from === "reattaching");
      if (!parkedPrompt)
        console.warn(
          `[run-state] rejected: ${event} while ${decision.from} (session ${sessionId})`,
        );
      emit({
        msg: "run_state_rejected",
        session_id: sessionId,
        state: decision.from,
        event,
        ...detail,
      });
    }
    return decision;
  }
  emit({
    msg: "run_state_transition",
    session_id: sessionId,
    from: decision.from,
    to: decision.to,
    event,
    ...detail,
  });
  return decision;
}

/**
 * Apply an event through the owning SessionKernel. A defined edge moves the
 * durable state and emits `run_state_transition`; an undefined one leaves the
 * state untouched and emits `run_state_rejected`.
 */
export async function transitionRunState(
  sessionId: string,
  event: RunEvent,
  detail?: Record<string, unknown>,
  emit: AuditEmit = audit,
): Promise<RunState> {
  const decision = await decideRunStateTransition(
    sessionId,
    event,
    detail,
    emit,
  );
  return decision.accepted ? decision.to : decision.from;
}

/** Drop tracking for a deleted session. */
export async function clearRunState(sessionId: string): Promise<void> {
  if (detachedRunHost()) detachedHostStates.delete(sessionId);
  else await clearSessionKernel(sessionId);
}
