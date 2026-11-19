// Whether the composer carries the usage bar: context, spend, the account's
// limits and which account the session runs on, in one strip above the field.
// Off by default; switched from the model menu or Settings → Preferences. A
// makeUserPref instance, so it follows the person across devices.
//
// The store is made on first use, not at import: the model menu imports this
// module, and a pref built at import time starts its server hydration in any
// test or tool that only wanted a label helper from that menu.

import { useSyncExternalStore } from "react";
import * as UserPref from "./user-pref";

let store: UserPref.UserPref<boolean> | undefined;

function prefStore(): UserPref.UserPref<boolean> {
  store ??= UserPref.makeUserPref<boolean>({
    localKey: "opensession-usage-bar",
    prefKey: "usage-bar",
    changeEvent: "opensession-usage-bar-changed",
    defaultValue: false,
    decode: (v) => (v === "on" ? true : v === "off" ? false : null),
    encode: (on) => (on ? "on" : "off"),
  });
  return store;
}

const browser = () =>
  typeof window !== "undefined" && typeof localStorage !== "undefined";

export function getUsageBarPref(): boolean {
  return browser() ? prefStore().get() : false;
}

export function setUsageBarPref(on: boolean): void {
  if (browser()) prefStore().set(on);
}

export function onUsageBarChanged(handler: () => void): () => void {
  return browser() ? prefStore().onChanged(handler) : () => {};
}

export function useUsageBarPref(): boolean {
  return useSyncExternalStore(onUsageBarChanged, getUsageBarPref, () => false);
}
