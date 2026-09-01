// Subscribes a surface to the shortcut registry so a rebind repaints the
// keycaps it advertises. Matching never needs this — matchesShortcut reads the
// current bindings at event time — so it is only for what's on screen:
// tooltips, menu hints, hover cards, the settings page itself.

import { useSyncExternalStore } from "react";
import {
  onShortcutsChanged,
  shortcutKeys,
  shortcutLabel,
  type ShortcutId,
} from "../lib/shortcuts";

// One store for every subscriber: the pref emits a single change event, and
// the snapshot is a version counter rather than a value, so components read
// whatever they need through the registry after it bumps. The subscription to
// the pref is made once here rather than per subscriber, so mounting and
// unmounting surfaces never stacks up window listeners.
let version = 0;
const listeners = new Set<() => void>();

onShortcutsChanged(() => {
  version++;
  for (const l of listeners) l();
});

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): number {
  return version;
}

/** Re-renders on any rebind. Returns the current version, rarely needed. */
export function useShortcutsVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The keycaps for a command's primary binding, or null when unassigned. */
export function useShortcutKeys(id: ShortcutId): string[] | null {
  useShortcutsVersion();
  return shortcutKeys(id)[0] ?? null;
}

/** A command's primary binding as one flat label. */
export function useShortcutLabel(id: ShortcutId): string | null {
  useShortcutsVersion();
  return shortcutLabel(id);
}
