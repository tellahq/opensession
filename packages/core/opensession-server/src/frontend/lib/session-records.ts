/**
 * The app's live session list, for surfaces that sit several layers below its
 * owner (useSessions): the threads panel and the thread cards in a
 * transcript. The list stays the source; this only mirrors it, the same way
 * workspace-records.ts mirrors the workspace list.
 */

import { useSyncExternalStore } from "react";
import type { UnifiedSession } from "./types";

const NONE: readonly UnifiedSession[] = [];
let list: readonly UnifiedSession[] = NONE;
let byId = new Map<string, UnifiedSession>();
const listeners = new Set<() => void>();

export function publishSessionRecords(next: readonly UnifiedSession[]): void {
  if (next === list) return;
  list = next;
  byId = new Map();
  for (const session of next) {
    byId.set(session.id, session);
    for (const alias of session.aliasIds ?? []) byId.set(alias, session);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every live session, as the app last fetched them. */
export function useSessionRecords(): readonly UnifiedSession[] {
  return useSyncExternalStore(subscribe, () => list);
}

/** One session by id (or a former id), or null while it is not in the list. */
export function useSessionRecord(id: string | null): UnifiedSession | null {
  return useSyncExternalStore(subscribe, () =>
    id ? (byId.get(id) ?? null) : null,
  );
}
