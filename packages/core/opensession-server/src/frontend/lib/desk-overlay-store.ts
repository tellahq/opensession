import { useSyncExternalStore, type SetStateAction } from "react";

/**
 * The Desk overlay (⌘J / the floating desk button): a standing concierge
 * session on top of whatever view is open. Its entrance origin follows the
 * invocation: the corner launcher is spatial, while the shortcut is not.
 *
 * Held outside App so opening or closing Desk re-renders the overlay alone,
 * not the route, viewer, and sidebar around it.
 */
export interface DeskOverlayState {
  open: boolean;
  origin: "center" | "bottom-right";
}

const CLOSED: DeskOverlayState = { open: false, origin: "bottom-right" };

let current = CLOSED;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Open or close Desk. Takes a value or an updater, like a state setter. */
export function setDeskOverlay(next: SetStateAction<DeskOverlayState>): void {
  const value = next instanceof Function ? next(current) : next;
  if (value.open === current.open && value.origin === current.origin) return;
  current = value;
  for (const listener of listeners) listener();
}

export function useDeskOverlay(): DeskOverlayState {
  return useSyncExternalStore(subscribe, () => current);
}

/** True while `active` holds and Desk is closed. Re-renders only on a flip. */
export function useActiveWhileDeskClosed(active: boolean): boolean {
  return useSyncExternalStore(subscribe, () => active && !current.open);
}

export function getDeskOverlayForTest(): DeskOverlayState {
  return current;
}
