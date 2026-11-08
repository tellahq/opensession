import { useSyncExternalStore } from "react";
import { openSidePanelTab } from "./side-panel-store";

/**
 * Which thread a conversation has open beside it, keyed by the session that
 * started it. Clicking a thread card opens the thread in the Threads side
 * tab instead of leaving the conversation; Back returns to the list.
 */
const open = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  for (const listener of listeners) listener();
}

export function openThreadPane(rootId: string, threadId: string) {
  open.set(rootId, threadId);
  emit();
  openSidePanelTab("threads");
}

export function closeThreadPane(rootId: string) {
  if (!open.delete(rootId)) return;
  emit();
}

export function useOpenThreadPane(rootId: string): string | null {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
  return open.get(rootId) ?? null;
}
