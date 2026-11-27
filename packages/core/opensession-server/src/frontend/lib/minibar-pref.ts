// Which items the new layout's minibar shows besides Sessions (right-click
// the minibar, or ⋯ → Show in minibar). A makeUserPref instance, so the
// choice follows the person across devices. Everything left out is one click
// away in the minibar's ⋯ menu.

import { useSyncExternalStore } from "react";
import {
  DEFAULT_MINIBAR_ITEMS,
  MINIBAR_ITEM_IDS,
  type MinibarItemId,
} from "./minibar-items";
import * as userPref from "./user-pref";

const KNOWN: ReadonlySet<string> = new Set(MINIBAR_ITEM_IDS);

// Stored as the ids joined by commas, in catalog order. The pref's value is
// that string rather than an array, so a read returns the same snapshot
// until something changes (useSyncExternalStore compares by identity).
function normalize(ids: Iterable<string>): string {
  const shown = new Set(ids);
  return MINIBAR_ITEM_IDS.filter((id) => shown.has(id)).join(",");
}

const pref = userPref.makeUserPref<string>({
  localKey: "opensession-minibar-items",
  prefKey: "minibar-items",
  changeEvent: "opensession-minibar-items-changed",
  defaultValue: normalize(DEFAULT_MINIBAR_ITEMS),
  // New after preferences began to sync: nothing browser-wide to carry over.
  perUser: true,
  decode: (raw) => {
    if (raw == null || raw === "") return null;
    return normalize(raw.split(",").filter((id) => KNOWN.has(id)));
  },
  // Only Sessions in the bar is a real choice. It is stored as a marker
  // rather than an empty string, which reads as no choice at all and would
  // put the defaults back on the next device.
  encode: (value) => value || "-",
});

export function parseMinibarItems(value: string): ReadonlySet<MinibarItemId> {
  return new Set(
    value.split(",").filter((id): id is MinibarItemId => KNOWN.has(id)),
  );
}

/** The items in the bar, as the stored string (parse with parseMinibarItems). */
export function useMinibarItems(): string {
  return useSyncExternalStore(pref.onChanged, pref.get, pref.get);
}

export function setMinibarItemShown(id: MinibarItemId, shown: boolean): void {
  const current = parseMinibarItems(pref.get());
  const next = new Set<string>(current);
  if (shown) next.add(id);
  else next.delete(id);
  pref.set(normalize(next));
}
