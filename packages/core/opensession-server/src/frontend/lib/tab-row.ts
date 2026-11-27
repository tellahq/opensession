// Whether the session tab strip is sitting in the new layout's window row
// (components/shell/PaneTopRow.tsx) rather than in a band under the header.
// The few things that measure from the header's bottom edge read it, because
// "a strip is showing" no longer says there is a strip to clear.

import { useSyncExternalStore } from "react";

let tabsInTopRow = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setTabsInTopRow(value: boolean) {
  if (value === tabsInTopRow) return;
  tabsInTopRow = value;
  for (const listener of listeners) listener();
}

export function useTabsInTopRow(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => tabsInTopRow,
    () => false,
  );
}
