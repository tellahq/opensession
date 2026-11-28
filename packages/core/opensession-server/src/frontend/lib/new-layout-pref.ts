// Whether this person sees the new layout (Settings → Appearance → New layout,
// default off): a minibar of places beside a sidebar that lists only
// sessions. A makeUserPref instance, so the choice follows the person across
// devices. Desktop widths only for now; phones keep the page stack.

import { useSyncExternalStore } from "react";
import { setSidePanelWindowWide } from "./side-panel-store";
import * as userPref from "./user-pref";

const pref = userPref.makeUserPref<boolean>({
  localKey: "opensession-new-layout",
  prefKey: "new-layout",
  changeEvent: "opensession-new-layout-changed",
  defaultValue: false,
  // New after preferences began to sync, so there is no browser-wide value
  // to carry over, and a shared one would opt the next person in.
  perUser: true,
  decode: (v) => (v === "on" ? true : v === "off" ? false : null),
  encode: (on) => (on ? "on" : "off"),
});

export const setNewLayoutPref = pref.set;

// The new layout has one side panel for the window, not one per session.
setSidePanelWindowWide(pref.get);

export function useNewLayoutPref(): boolean {
  return useSyncExternalStore(pref.onChanged, pref.get, () => false);
}
