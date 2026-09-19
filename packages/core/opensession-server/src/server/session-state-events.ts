export interface SessionStateEvent {
  sessionId: string;
  isRunning: boolean;
  at: number;
  /** The run is still owned but paused on a question for a human. Emitted
   * when an AskUserQuestion is posed so turn watchers do not have to poll. */
  pendingQuestion?: boolean;
}

/** The most recent turn end seen for a session in this process. `seq` is a
 * process-wide monotonic counter, so two records are the same boundary only
 * when both `seq` and `at` match. */
export interface SessionTurnEnd {
  at: number;
  pendingQuestion: boolean;
  seq: number;
}

type SessionStateListener = (event: SessionStateEvent) => void;

const g = globalThis as {
  __osSessionStateListeners?: Set<SessionStateListener>;
  __osPrimarySessionRunning?: Map<string, boolean>;
  __osSessionRunningHolds?: Map<string, Set<string>>;
  __osPendingOpenings?: Set<string>;
  __osLastTurnEnds?: Map<string, SessionTurnEnd>;
  __osTurnEndSeq?: number;
};

const MAX_RETAINED_TURN_ENDS = 4096;

function listeners(): Set<SessionStateListener> {
  return (g.__osSessionStateListeners ??= new Set());
}

function lastTurnEnds(): Map<string, SessionTurnEnd> {
  return (g.__osLastTurnEnds ??= new Map());
}

/** Whether an event marks the end of a turn for anyone waiting on it: the
 * session stopped running, or it paused on a question for a human. */
export function isTurnEndEvent(event: SessionStateEvent): boolean {
  return !event.isRunning || event.pendingQuestion === true;
}

/** The last turn end retained for a session, so a watcher that subscribes
 * after the event can still tell that a boundary passed. Process-local. */
export function lastSessionTurnEnd(
  sessionId: string,
): SessionTurnEnd | undefined {
  return lastTurnEnds().get(sessionId);
}

function retainTurnEnd(event: SessionStateEvent): void {
  const ends = lastTurnEnds();
  // Re-insert so the map stays in recency order and the cap drops the oldest.
  ends.delete(event.sessionId);
  ends.set(event.sessionId, {
    at: event.at,
    pendingQuestion: event.pendingQuestion === true,
    seq: (g.__osTurnEndSeq = (g.__osTurnEndSeq ?? 0) + 1),
  });
  if (ends.size > MAX_RETAINED_TURN_ENDS) {
    const oldest = ends.keys().next().value;
    if (oldest !== undefined) ends.delete(oldest);
  }
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
  if (isTurnEndEvent(event)) retainTurnEnd(event);
  for (const listener of listeners()) {
    try {
      listener(event);
    } catch (error) {
      console.error("[live-activities] session-state listener failed:", error);
    }
  }
}
