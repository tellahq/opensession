// Whether the Desk shows at all (Settings → Preferences → Desk, default off).
// Off removes its floating button, ⌘J and the command palette entry. A
// makeUserPref instance, so the choice follows the person across devices.

import { useSyncExternalStore } from "react";
import * as userPref from "./user-pref";

const pref = userPref.makeUserPref<boolean>({
  localKey: "opensession-desk-shown",
  prefKey: "desk",
  changeEvent: "opensession-desk-shown-changed",
  defaultValue: false,
  decode: (v) => (v === "on" ? true : v === "off" ? false : null),
  encode: (on) => (on ? "on" : "off"),
});

export const getDeskShownPref = pref.get;
export const setDeskShownPref = pref.set;
export const onDeskShownChanged = pref.onChanged;

export function useDeskShown(): boolean {
  return useSyncExternalStore(pref.onChanged, pref.get, () => false);
}
