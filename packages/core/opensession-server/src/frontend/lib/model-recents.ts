// Models chosen from the picker, newest first. The list follows the person
// across devices through ui-prefs, with localStorage as the synchronous cache.
// Keep more than the three rows the picker shows so unavailable models do not
// leave gaps when a workspace exposes a smaller catalog.

import { z } from "zod";
import * as userPref from "./user-pref";
import type { UserPref } from "./user-pref";

const LOCAL_KEY = "opensession-recent-models";
const PREF_KEY = "recent-models";
const CHANGE_EVENT = "opensession-recent-models-changed";
const EMPTY = "[]";
export const RECENT_MODEL_LIMIT = 12;

const recentModelsSchema = z.array(z.string().catch(""));

export function decodeRecentModels(
  raw: string | null | undefined,
): string[] | null {
  if (raw == null) return null;
  try {
    const result = recentModelsSchema.safeParse(JSON.parse(raw));
    if (!result.success) return null;
    return [...new Set(result.data.filter((id) => id.length > 0))].slice(
      0,
      RECENT_MODEL_LIMIT,
    );
  } catch {
    return null;
  }
}

export function addRecentModel(models: string[], id: string): string[] {
  if (!id) return models.slice(0, RECENT_MODEL_LIMIT);
  return [id, ...models.filter((model) => model !== id)].slice(
    0,
    RECENT_MODEL_LIMIT,
  );
}

let store: UserPref<string> | undefined;

function prefStore(): UserPref<string> {
  if (!store) {
    store = userPref.makeUserPref<string>({
      localKey: LOCAL_KEY,
      prefKey: PREF_KEY,
      changeEvent: CHANGE_EVENT,
      defaultValue: EMPTY,
      decode: (raw) => {
        const models = decodeRecentModels(raw);
        return models === null ? null : JSON.stringify(models);
      },
      encode: (value) => value,
    });
  }
  return store;
}

export function getRecentModels(): string[] {
  if (typeof window === "undefined" || typeof localStorage === "undefined")
    return [];
  return decodeRecentModels(prefStore().get()) ?? [];
}

export function pushRecentModel(id: string): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined")
    return;
  prefStore().set(JSON.stringify(addRecentModel(getRecentModels(), id)));
}

export function onRecentModelsChanged(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  return prefStore().onChanged(handler);
}
