import { useSyncExternalStore } from "react";

/**
 * Whether a sidebar's Workspace options popover is open. Each Sidebar makes
 * its own store. The value lives outside Sidebar's state because a Sidebar
 * render re-renders every workspace row, and opening or closing the popover
 * only changes its trigger buttons and the popover itself.
 */
export interface FilterMenuStore {
  get: () => boolean;
  set: (open: boolean) => void;
  toggle: () => void;
  subscribe: (listener: () => void) => () => void;
}

export function createFilterMenuStore(): FilterMenuStore {
  let open = false;
  const listeners = new Set<() => void>();
  const set = (next: boolean) => {
    if (next === open) return;
    open = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => open,
    set,
    toggle: () => set(!open),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useFilterMenuOpen(store: FilterMenuStore): boolean {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
