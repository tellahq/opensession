export type PendingSessionFork =
  | { kind: "tip" }
  | { kind: "message"; messageId: string };

type PendingSessionForkListener = (sessionId: string) => void;

const pendingForks = new Map<string, PendingSessionFork>();
const listeners = new Set<PendingSessionForkListener>();

/** Carry a duplicate request across in-app navigation. Omitting messageId
 * duplicates the current tip; message menus can target an earlier answer. */
export function setPendingSessionFork(
  sessionId: string,
  messageId?: string,
): void {
  pendingForks.set(
    sessionId,
    messageId ? { kind: "message", messageId } : { kind: "tip" },
  );
  for (const listener of listeners) listener(sessionId);
}

/** Read once: returning to the session later must not re-enter duplicate mode. */
export function takePendingSessionFork(
  sessionId: string,
): PendingSessionFork | null {
  const target = pendingForks.get(sessionId) ?? null;
  pendingForks.delete(sessionId);
  return target;
}

/** Notify the already-open viewer when its sidebar row is duplicated. */
export function onPendingSessionFork(
  listener: PendingSessionForkListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
