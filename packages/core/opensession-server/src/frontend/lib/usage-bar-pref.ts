// Whether the composer carries the usage bar: context, spend, the account's
// limits and which account the session runs on, in one strip above the field.
// Off by default; switched from the model menu or Settings → Preferences. A
// makeUserPref instance, so it follows the person across devices.

import { useSyncExternalStore } from "react";
import * as UserPref from "./user-pref";

const pref = UserPref.makeUserPref<boolean>({
  localKey: "opensession-usage-bar",
  prefKey: "usage-bar",
  changeEvent: "opensession-usage-bar-changed",
  defaultValue: false,
  decode: (v) => (v === "on" ? true : v === "off" ? false : null),
  encode: (on) => (on ? "on" : "off"),
});

export const getUsageBarPref = pref.get;
export const setUsageBarPref = pref.set;
export const onUsageBarChanged = pref.onChanged;

export function useUsageBarPref(): boolean {
  return useSyncExternalStore(pref.onChanged, pref.get, () => false);
}
