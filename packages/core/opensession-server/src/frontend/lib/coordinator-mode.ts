import { useSyncExternalStore } from "react";
import { setCoordinatorApi } from "./api/workspaces";
import { isCoordinating } from "./session-threads";
import type { UnifiedSession, Workspace } from "./types";

/**
 * Coordinator mode as this browser sees it: the session's own setting, or a
 * switch made here that the session's list row has not caught up with yet.
 * The row arrives over the socket a moment after the server writes it.
 */
const pending = new Map<string, boolean>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Switch the mode, showing the change right away. Rejects (and undoes the
 *  change) when the server refuses it. */
export function setCoordinatorMode(sessionId: string, on: boolean) {
  pending.set(sessionId, on);
  emit();
  const request = setCoordinatorApi(sessionId, on);
  void request.catch(() => {
    pending.delete(sessionId);
    emit();
  });
  return request;
}

export function useIsCoordinating(
  session: Pick<
    UnifiedSession,
    "id" | "coordinator" | "parentSessionId" | "workspaceId"
  > | null,
  workspace: Pick<Workspace, "id" | "space"> | null | undefined,
): boolean {
  const read = () => version;
  useSyncExternalStore(subscribe, read, read);
  if (!session) return false;
  const local = pending.get(session.id);
  if (local !== undefined && local !== session.coordinator) return local;
  if (local !== undefined) pending.delete(session.id);
  return isCoordinating(session, workspace);
}
