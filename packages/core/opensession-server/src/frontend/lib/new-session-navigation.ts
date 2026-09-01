export function errorMatchesPendingCreate(
  errorSessionId: string | undefined,
  pendingSessionId: string | null | undefined,
): boolean {
  // WebSocket errors are shared across every operation on the connection. Only
  // the create's deterministic session id proves this error belongs to the
  // pending create; an unscoped watch/ack failure must not tear down its shell.
  return !!pendingSessionId && errorSessionId === pendingSessionId;
}

export function shouldApplyCreatedSessionReply(
  replayed: boolean | undefined,
  hasPendingDraft: boolean,
): boolean {
  // A completed create command remains in the durable browser outbox until its
  // acknowledgement round-trip finishes. If the socket drops first, reconnect
  // replays the command and the server returns its stored session_created result.
  // Without the matching in-memory draft this is historical confirmation, not a
  // new optimistic session. Applying it would fabricate a sticky "New session"
  // row with no repo, which then falls into the instance-default repo lane.
  return replayed !== true || hasPendingDraft;
}

export function shouldOpenCreatedSession(
  draft: { originPath: string; background?: boolean } | null,
  currentPath: string,
  creationSurfaceOpen: boolean,
  roomScoped = false,
): boolean {
  // A restart-recovered create is announced to the session room so an already
  // open optimistic viewer can settle. It is not a creator reply and must never
  // pull another route back to that session through a stale watch.
  if (roomScoped) return false;
  // Only this browser's still-pending create may take the foreground. A
  // duplicate creator reply can be replayed from the durable command outbox on
  // reconnect, long after its draft was consumed; treating "no draft" as a
  // direct create made every reload jump back to that old session.
  if (!draft) return false;
  // "Create in background" asked for the current view to stay put.
  if (draft.background) return false;
  return creationSurfaceOpen && draft.originPath === currentPath;
}
