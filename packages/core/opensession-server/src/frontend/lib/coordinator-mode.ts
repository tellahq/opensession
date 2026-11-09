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

function emit() {
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
  const settle = () => {
    if (pending.get(sessionId) !== on) return;
    pending.delete(sessionId);
    emit();
  };
  // By then the session's row carries the setting; a later switch from
  // another device must not be masked by this one.
  void request.then(() => window.setTimeout(settle, 15_000), settle);
  return request;
}

export function useIsCoordinating(
  session: Pick<
    UnifiedSession,
    "id" | "coordinator" | "parentSessionId" | "workspaceId"
  > | null,
  workspace: Pick<Workspace, "id" | "space"> | null | undefined,
): boolean {
  // The snapshot is the value itself: the React Compiler caches anything
  // computed from module state by its inputs alone, so a read after a bare
  // version subscription would go stale.
  const id = session?.id;
  const read = () => (id ? pending.get(id) : undefined);
  const local = useSyncExternalStore(subscribe, read, read);
  if (!session) return false;
  if (local !== undefined && local !== session.coordinator) return local;
  return isCoordinating(session, workspace);
}
