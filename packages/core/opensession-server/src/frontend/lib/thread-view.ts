import { createContext, use, useSyncExternalStore } from "react";
import { openSidePanelTab, sidePanelHostOnScreen } from "./side-panel-store";

/**
 * The threads a conversation has open beside it, keyed by the session that
 * started them. Clicking a thread card opens the thread in the Threads side
 * tab instead of leaving the conversation; a card inside that thread opens
 * its own thread one level deeper, so the panel holds a stack: the deepest
 * level shows, with a way back to each one above it.
 */
const open = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();
const NONE: readonly string[] = [];

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Open `threadId` beside `rootId`'s conversation: on top of `from` when the
 * card sits inside the open thread `from`, else as the only level. False when
 * that conversation has no side panel on screen (a phone, a narrow window),
 * so the caller opens the session itself instead.
 */
export function openThreadPane(
  rootId: string,
  threadId: string,
  from?: string,
): boolean {
  if (!sidePanelHostOnScreen(rootId)) return false;
  const stack = open.get(rootId) ?? NONE;
  const at = from ? stack.indexOf(from) : -1;
  const next =
    at >= 0
      ? [...stack.slice(0, at + 1).filter((id) => id !== threadId), threadId]
      : [threadId];
  open.set(rootId, next);
  emit();
  openSidePanelTab("threads", rootId);
  return true;
}

/** Keep the first `depth` levels open (0 goes back to the thread list). */
export function closeThreadPane(rootId: string, depth = 0) {
  const stack = open.get(rootId);
  if (!stack || stack.length <= depth) return;
  if (depth === 0) open.delete(rootId);
  else open.set(rootId, stack.slice(0, depth));
  emit();
}

/** The threads open beside `rootId`, outermost first. */
export function useThreadPaneStack(rootId: string): readonly string[] {
  // The snapshot is the stack itself (a new array on every change): the
  // React Compiler caches `open.get(rootId)` by `rootId` alone, so reading
  // it after a bare version subscription kept the old stack and Back did
  // nothing.
  const read = () => open.get(rootId) ?? NONE;
  return useSyncExternalStore(subscribe, read, read);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Inside an open thread's transcript: which conversation it sits beside,
 *  and which thread it is, so its own cards open one level deeper. */
export interface ThreadPaneLevel {
  rootId: string;
  threadId: string;
}

const ThreadPaneLevelContext = createContext<ThreadPaneLevel | null>(null);
export const ThreadPaneLevelProvider = ThreadPaneLevelContext.Provider;

export function useThreadPaneLevel(): ThreadPaneLevel | null {
  return use(ThreadPaneLevelContext);
}
