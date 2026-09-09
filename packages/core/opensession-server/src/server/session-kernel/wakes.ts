/**
 * In-process wake-ups between the creation waiters, the kernel facade and the
 * durable runtime. Nothing here is durable or authoritative: a waiter that is
 * woken re-reads the actor's creation state, and a waiter that is never woken
 * still polls it on a backed-off interval, so a commit made by another process
 * (a gateway handoff) is observed within that interval. What the wakes remove
 * is the busy loop: a pending create used to ask the actor for its state every
 * 25 ms, and an opening turn kept doing so for its whole run.
 */

type WakeState = {
  creationWaiters: Map<string, Set<() => void>>;
  drainRequest?: () => void;
};

const globalWakes = globalThis as typeof globalThis & {
  __opensessionSessionKernelWakes?: WakeState;
};
const wakes: WakeState = (globalWakes.__opensessionSessionKernelWakes ??= {
  creationWaiters: new Map(),
});

/** Resolve when the session's creation state changes in this process or after `maxMs`. */
export function waitForCreationStateChange(
  sessionId: string,
  maxMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let waiters = wakes.creationWaiters.get(sessionId);
    if (!waiters) {
      waiters = new Set();
      wakes.creationWaiters.set(sessionId, waiters);
    }
    const settle = () => {
      clearTimeout(timer);
      waiters.delete(settle);
      if (
        waiters.size === 0 &&
        wakes.creationWaiters.get(sessionId) === waiters
      )
        wakes.creationWaiters.delete(sessionId);
      resolve();
    };
    const timer = setTimeout(settle, maxMs);
    waiters.add(settle);
  });
}

/** A creation event committed for the session: wake every waiter on it. */
export function notifyCreationStateChanged(sessionId: string): void {
  const waiters = wakes.creationWaiters.get(sessionId);
  if (!waiters) return;
  for (const settle of [...waiters]) settle();
}

export function creationWaiterCountForTest(sessionId: string): number {
  return wakes.creationWaiters.get(sessionId)?.size ?? 0;
}

/** Installed by the durable runtime while it is started. */
export function setSessionKernelRuntimeDrainRequest(
  request: (() => void) | undefined,
): void {
  wakes.drainRequest = request;
}

/**
 * Durable work was emitted or a slot freed: run the runtime drain soon instead
 * of waiting for its one-second tick. A no-op when the runtime is not started.
 */
export function requestSessionKernelRuntimeDrain(): void {
  wakes.drainRequest?.();
}
