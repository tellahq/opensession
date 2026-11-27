// Whether this person sees the new layout (Settings → Preferences → Layout,
// default off): a minibar of places beside a sidebar that lists only
// sessions. A makeUserPref instance, so the choice follows the person across
// devices. Desktop widths only for now; phones keep the page stack.

import { useSyncExternalStore } from "react";
import * as userPref from "./user-pref";

const pref = userPref.makeUserPref<boolean>({
  localKey: "opensession-new-layout",
  prefKey: "new-layout",
  changeEvent: "opensession-new-layout-changed",
  defaultValue: false,
  decode: (v) => (v === "on" ? true : v === "off" ? false : null),
  encode: (on) => (on ? "on" : "off"),
});

export const setNewLayoutPref = pref.set;

export function useNewLayoutPref(): boolean {
  return useSyncExternalStore(pref.onChanged, pref.get, () => false);
}
