import { useSyncExternalStore } from "react";

/**
 * Where a session's ⋯ menu goes in the new layout: a slot inside its own
 * tab, just before the tab's close button. The tab strip is built above the
 * session viewer and the menu belongs to the viewer, so the strip registers
 * the slot here and the viewer portals the menu into it. With no slot (old
 * layout, phone, a view tab in front) the menu stays in the header.
 */
const slots = new Map<string, HTMLElement>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Register `el` as `sessionId`'s tab menu slot; returns the unregister. */
export function registerTabMenuSlot(
  sessionId: string,
  el: HTMLElement,
): () => void {
  slots.set(sessionId, el);
  notify();
  return () => {
    if (slots.get(sessionId) !== el) return;
    slots.delete(sessionId);
    notify();
  };
}

/** The slot in `sessionId`'s tab, or null while its tab offers none. */
export function useTabMenuSlot(
  sessionId: string | null | undefined,
): HTMLElement | null {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? (slots.get(sessionId) ?? null) : null),
    () => null,
  );
}
