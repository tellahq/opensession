// Models a person picked from the model menu, newest first, as id tails
// ("gemini-4-neon"). They decide which five models the menu's top level
// lists; the curated best fill whatever the recents leave open. A
// makeUserPref instance, so it follows the person across devices. The key is
// the one the menu's earlier Recent models group used, so its picks still
// count; that group stored full ids, which decode to their tails.
//
// The store is made on first use, not at import, like top-model-order.

import { useSyncExternalStore } from "react";
import { z } from "zod";
import * as UserPref from "./user-pref";

/** Kept beyond the five shown so a smaller catalog still fills the top. */
export const RECENT_MODEL_LIMIT = 12;

const EMPTY = "[]";
// A non-string entry (a newer client's shape) reads as a blank and drops out.
const storedSchema = z.array(z.string().catch(""));
const tailOf = (id: string) => id.split("/").pop() || "";

let store: UserPref.UserPref<string> | undefined;

function prefStore(): UserPref.UserPref<string> {
  store ??= UserPref.makeUserPref<string>({
    localKey: "opensession-recent-models",
    prefKey: "recent-models",
    changeEvent: "opensession-recent-models-changed",
    defaultValue: EMPTY,
    decode: (raw) => {
      const tails = decodeRecentModels(raw);
      return tails === null ? null : JSON.stringify(tails);
    },
    encode: (value) => value,
  });
  return store;
}

/** Stored JSON → tails, newest first, without blanks or repeats; null when
 * the value is not a list. */
export function decodeRecentModels(
  raw: string | null | undefined,
): string[] | null {
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = storedSchema.safeParse(parsed);
  if (!result.success) return null;
  const tails = result.data.map((id) => tailOf(id.trim())).filter(Boolean);
  return [...new Set(tails)].slice(0, RECENT_MODEL_LIMIT);
}

/** `tails` with `id`'s tail moved to the front. */
export function addRecentModel(tails: readonly string[], id: string): string[] {
  const tail = tailOf(id);
  const rest = tails.filter((t) => t !== tail);
  return (tail ? [tail, ...rest] : rest).slice(0, RECENT_MODEL_LIMIT);
}

const browser = () =>
  typeof window !== "undefined" && typeof localStorage !== "undefined";

function getRaw(): string {
  return browser() ? prefStore().get() : EMPTY;
}

function subscribe(handler: () => void): () => void {
  return browser() ? prefStore().onChanged(handler) : () => {};
}

/** Record a pick from the model menu. */
export function pushRecentModel(id: string): void {
  if (!browser()) return;
  const current = decodeRecentModels(getRaw()) ?? [];
  const next = addRecentModel(current, id);
  if (next.join(",") !== current.join(","))
    prefStore().set(JSON.stringify(next));
}

/** The recent tails, newest first, updated on every change. */
export function useRecentModels(): string[] {
  const raw = useSyncExternalStore(subscribe, getRaw, () => EMPTY);
  return decodeRecentModels(raw) ?? [];
}
