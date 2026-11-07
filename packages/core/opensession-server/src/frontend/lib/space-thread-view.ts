import { useSyncExternalStore } from "react";
import { openSidePanelTab } from "./side-panel-store";

/**
 * Which thread a space's conversation has open beside it, keyed by the
 * coordinator session. Clicking a thread card opens the thread in the Space
 * side tab instead of leaving the conversation; Back returns to the space.
 */
const open = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  for (const listener of listeners) listener();
}

export function openSpaceThread(coordinatorId: string, threadId: string) {
  open.set(coordinatorId, threadId);
  emit();
  openSidePanelTab("space");
}

export function closeSpaceThread(coordinatorId: string) {
  if (!open.delete(coordinatorId)) return;
  emit();
}

export function useOpenSpaceThread(coordinatorId: string): string | null {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
  return open.get(coordinatorId) ?? null;
}
