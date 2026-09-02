// Per-user session tab colors, stored server-side (keyed on the UserPicker
// name) so they follow you across devices. The public API stays synchronous
// (an in-memory cache) so callers don't await: the store is a lib/user-map
// instance, which owns hydration and ordered per-key delta writes.
import { fetchTabColors, saveTabColorsApi } from "./api";
import * as userMap from "./user-map";

const CHANGE_EVENT = "opensession-tab-colors-changed";

/** The default swatch palette. Keys must stay in sync with server/tab-colors.ts. */
export const TAB_COLORS: { key: string; label: string; hex: string }[] = [
  { key: "red", label: "Red", hex: "#f85149" },
  { key: "orange", label: "Orange", hex: "#db8a40" },
  { key: "yellow", label: "Yellow", hex: "#d29922" },
  { key: "green", label: "Green", hex: "#3fb950" },
  { key: "blue", label: "Blue", hex: "#4493f8" },
  { key: "purple", label: "Purple", hex: "#a371f7" },
  { key: "pink", label: "Pink", hex: "#db61a2" },
];

export function colorHex(key: string | undefined): string | null {
  return TAB_COLORS.find((c) => c.key === key)?.hex ?? null;
}

const store = userMap.makeUserMap<string>({
  changeEvent: CHANGE_EVENT,
  fetchMap: fetchTabColors,
  saveDelta: saveTabColorsApi,
});

export function getTabColors(): Record<string, string> {
  return store.get();
}

/** Set (or, with `null`/unknown key, clear) a session's tab color. */
export function setTabColor(
  id: string,
  color: string | null,
): Record<string, string> {
  return store.update((colors) => {
    const next = { ...colors };
    if (color && TAB_COLORS.some((c) => c.key === color)) next[id] = color;
    else if (id in next) delete next[id];
    else return null;
    return next;
  });
}

export function onTabColorsChanged(handler: () => void): () => void {
  return store.onChanged(handler);
}
