import { useSyncExternalStore } from "react";
import { z } from "zod";

/**
 * Threads a person opened as tabs. A thread is a session another session
 * started, so it stays out of the workspace's tab strip until someone opens it
 * from a thread card or the Threads tab; from then on it keeps a tab beside the
 * conversation that started it until that tab is closed. Kept on this device.
 */
const KEY = "opensession-thread-tabs";
const stored = z.array(z.string());
const NONE: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
let ids: ReadonlySet<string> | null = null;

function read(): ReadonlySet<string> {
  if (ids) return ids;
  try {
    const parsed = stored.safeParse(
      JSON.parse(localStorage.getItem(KEY) ?? "[]"),
    );
    ids = parsed.success ? new Set(parsed.data) : NONE;
  } catch {
    ids = NONE;
  }
  return ids;
}

function write(next: ReadonlySet<string>) {
  ids = next;
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]));
  } catch {}
  for (const listener of listeners) listener();
}

/** Give `id` a tab in its workspace's strip. */
export function openThreadTab(id: string) {
  const current = read();
  if (!current.has(id)) write(new Set(current).add(id));
}

/** Take `id`'s tab away again. The thread itself keeps running. */
export function closeThreadTab(id: string) {
  const current = read();
  if (!current.has(id)) return;
  const next = new Set(current);
  next.delete(id);
  write(next);
}

/** Whether `id` has a thread tab. */
export function isThreadTab(id: string): boolean {
  return read().has(id);
}

/** The threads opened as tabs. */
export function useThreadTabs(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, read, () => NONE);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
