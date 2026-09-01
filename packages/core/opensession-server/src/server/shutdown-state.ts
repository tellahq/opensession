/**
 * Process-wide graceful-shutdown flag, in its own module so intake paths
 * (run-session's queue drain) can read it without importing the entry file.
 * gracefulShutdown in opensession.ts sets it first thing on SIGTERM/SIGINT.
 *
 * Why intake checks it: the shutdown sequence snapshots active sessions, then
 * drains. A prompt accepted after that snapshot used to start a brand-new
 * turn seconds before the drain deadline. Detached engine runs survive the
 * restart, but an in-process turn gets SIGKILLed at the deadline and redone
 * from the journal on the next boot (wasted work, and side effects can run
 * twice), and the sender's socket dies mid-stream either way. Parking the
 * prompt in the durable queue instead delivers it exactly once: the next
 * boot's restorePromptQueues arms its drain.
 *
 * globalThis-parked so a hot reload during a shutdown cannot reset it.
 */
const g = globalThis as { __opensessionShuttingDown?: boolean };

export function beginShutdown(): void {
  g.__opensessionShuttingDown = true;
}

export function isShuttingDown(): boolean {
  return g.__opensessionShuttingDown === true;
}
