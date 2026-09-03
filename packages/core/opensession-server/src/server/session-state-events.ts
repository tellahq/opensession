export interface SessionStateEvent {
  sessionId: string;
  isRunning: boolean;
  at: number;
}

type SessionStateListener = (event: SessionStateEvent) => void;

const g = globalThis as {
  __osSessionStateListeners?: Set<SessionStateListener>;
  __osPrimarySessionRunning?: Map<string, boolean>;
  __osSessionRunningHolds?: Map<string, Set<string>>;
  __osPendingOpenings?: Set<string>;
};

function listeners(): Set<SessionStateListener> {
  return (g.__osSessionStateListeners ??= new Set());
}

function primaryRunning(): Map<string, boolean> {
  return (g.__osPrimarySessionRunning ??= new Map());
}

function runningHolds(): Map<string, Set<string>> {
  return (g.__osSessionRunningHolds ??= new Map());
}

function pendingOpenings(): Set<string> {
  return (g.__osPendingOpenings ??= new Set());
}

/** Sessions persisted for an accepted create whose opening turn has not taken
 * run admission yet. The row exists so the person can see their session while
 * its workspace is prepared, but a prompt admitted in this window would start a
 * turn before the worktree exists and race the opening. Prompt admission and
 * list state treat the session as busy until the opening turn owns it or the
 * create fails. Process-local: boot recovery re-marks a resumed create. */
export function holdPendingOpening(sessionId: string): void {
  pendingOpenings().add(sessionId);
}

export function releasePendingOpening(sessionId: string): void {
  pendingOpenings().delete(sessionId);
}

export function hasPendingOpening(sessionId: string): boolean {
  return pendingOpenings().has(sessionId);
}

/** Whether a session has background work that must keep it busy after its
 * primary model turn ends. Keys identify independent owners, so overlapping
 * workflows cannot release each other's hold. */
export function hasSessionRunningHold(sessionId: string): boolean {
  return (runningHolds().get(sessionId)?.size ?? 0) > 0;
}

/** Fold background activity into a caller's authoritative primary-run state. */
export function sessionRunningWithHolds(
  sessionId: string,
  primaryFallback = false,
): boolean {
  return (
    (primaryRunning().get(sessionId) ?? primaryFallback) ||
    hasSessionRunningHold(sessionId)
  );
}

/** Record a primary turn boundary and return the effective session state. */
export function setPrimarySessionRunning(
  sessionId: string,
  isRunning: boolean,
  at = Date.now(),
): boolean {
  primaryRunning().set(sessionId, isRunning);
  const effective = sessionRunningWithHolds(sessionId, isRunning);
  if (!isRunning && !hasSessionRunningHold(sessionId)) {
    primaryRunning().delete(sessionId);
  }
  emitSessionStateChange({ sessionId, isRunning: effective, at });
  return effective;
}

/** Keep a session busy for an independently owned background activity. */
export function holdSessionRunning(
  sessionId: string,
  key: string,
  at = Date.now(),
): boolean {
  let holds = runningHolds().get(sessionId);
  if (!holds) {
    holds = new Set();
    runningHolds().set(sessionId, holds);
  }
  holds.add(key);
  const effective = sessionRunningWithHolds(sessionId);
  emitSessionStateChange({ sessionId, isRunning: effective, at });
  return effective;
}

/** Release one background owner without disturbing primary or sibling work. */
export function releaseSessionRunning(
  sessionId: string,
  key: string,
  at = Date.now(),
): boolean {
  const holds = runningHolds().get(sessionId);
  holds?.delete(key);
  if (holds?.size === 0) runningHolds().delete(sessionId);
  const effective = sessionRunningWithHolds(sessionId);
  if (!effective) primaryRunning().delete(sessionId);
  emitSessionStateChange({ sessionId, isRunning: effective, at });
  return effective;
}

export function onSessionStateChange(
  listener: SessionStateListener,
): () => void {
  listeners().add(listener);
  return () => listeners().delete(listener);
}

export function emitSessionStateChange(event: SessionStateEvent): void {
  for (const listener of listeners()) {
    try {
      listener(event);
    } catch (error) {
      console.error("[live-activities] session-state listener failed:", error);
    }
  }
}
