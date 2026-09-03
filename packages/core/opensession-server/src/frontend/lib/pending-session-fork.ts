const pendingForks = new Map<string, string>();

/** Carry a fork request across an in-app navigation from a workspace pane to
 * the source session. The composer owns fork mode, so the workspace menu parks
 * the selected assistant message here before opening that session. */
export function setPendingSessionFork(
  sessionId: string,
  messageId: string,
): void {
  pendingForks.set(sessionId, messageId);
}

/** Read once: returning to the session later must not re-enter fork mode. */
export function takePendingSessionFork(sessionId: string): string | null {
  const messageId = pendingForks.get(sessionId) ?? null;
  pendingForks.delete(sessionId);
  return messageId;
}
