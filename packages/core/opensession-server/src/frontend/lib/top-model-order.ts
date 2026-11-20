// The order a person dragged the model menu's top five into, as model id
// tails ("claude-opus-5-5"). Only the order is theirs: which five sit there is
// curated in ModelEffortSelect. A makeUserPref instance, so it follows the
// person across devices.
//
// The store is made on first use, not at import: the model menu imports this
// module, and a pref built at import time starts its server hydration in any
// test that only wanted a label helper from that menu.

import { useSyncExternalStore } from "react";
import * as UserPref from "./user-pref";

let store: UserPref.UserPref<string> | undefined;

function prefStore(): UserPref.UserPref<string> {
  store ??= UserPref.makeUserPref<string>({
    localKey: "opensession-top-model-order",
    prefKey: "top-model-order",
    changeEvent: "opensession-top-model-order-changed",
    defaultValue: "",
    decode: (raw) =>
      raw == null ? null : decodeTopModelOrder(raw).join(",") || "",
    encode: (value) => value,
  });
  return store;
}

/** Stored form → tails, dropping blanks and repeats. */
export function decodeTopModelOrder(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(",")
        .map((tail) => tail.trim())
        .filter(Boolean),
    ),
  ];
}

const browser = () =>
  typeof window !== "undefined" && typeof localStorage !== "undefined";

function getRaw(): string {
  return browser() ? prefStore().get() : "";
}

function subscribe(handler: () => void): () => void {
  return browser() ? prefStore().onChanged(handler) : () => {};
}

export function setTopModelOrder(tails: readonly string[]): void {
  if (browser()) prefStore().set(tails.join(","));
}

/** The saved order, newest value on every change. */
export function useTopModelOrder(): string[] {
  const raw = useSyncExternalStore(subscribe, getRaw, () => "");
  return decodeTopModelOrder(raw);
}
