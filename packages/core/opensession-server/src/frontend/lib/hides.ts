// Sidebar hides, stored server-side per user (keyed on the UserPicker name)
// like pins and snoozes, so they follow you across devices.
//
// Hiding is the personal counterpart to archiving: archiving is global, so it
// removes a session for the whole team — wrong when a teammate is still working
// in it. A hide is an overlay on a sidebar row key (`workspace:<id>` or a solo
// session id) that only ever affects you; the session keeps running and stays in
// everyone else's sidebar.
//
// There is deliberately no "Hidden" band: hiding means the row is off your
// sidebar, not filed into a drawer you'd never open. A hidden session stays
// findable in the ⌘K palette (which ignores hides), and the Sidebar always
// shows the OPEN session's row — so opening one brings its row back and its menu
// offers "Restore to my sidebar". Prompting in a session clears its hide outright
// (`unhideForSession`): you can't be done with work you're actively doing.
//
// A hide is otherwise sticky (unlike a snooze, it has no expiry), with one
// exception the Sidebar applies: a hidden row resurfaces while any of its sessions
// is blocked on a question, and the entry is consumed when that happens — so a
// hide can never swallow work that needs you. The public API stays synchronous
// (an in-memory cache) mirroring snoozes.ts: the store is a lib/user-map
// instance, which owns hydration and ordered per-key delta writes.
import { fetchHides, saveHidesApi } from "./api";
import { makeUserMap } from "./user-map";

const CHANGE_EVENT = "opensession-hides-changed";

// The lifecycle (hydration, pending write intents, and stale-response guards)
// lives in makeUserMap; it also keeps the module
// importable outside a browser, which `partitionHidden` below is unit-tested
// through.
const store = makeUserMap<string>({
  changeEvent: CHANGE_EVENT,
  fetchMap: fetchHides,
  saveDelta: saveHidesApi,
});

export function getHides(): Record<string, string> {
  return store.get();
}

export function isHiddenForSession(
  session: {
    id: string;
    workspaceId?: string | null;
    worktreeDir?: string | null;
  },
  hides = store.get(),
): boolean {
  return [
    session.id,
    ...(session.workspaceId ? [`workspace:${session.workspaceId}`] : []),
    ...(session.worktreeDir ? [`wt:${session.worktreeDir}`] : []),
  ].some((key) => key in hides);
}

export function setHide(key: string): void {
  store.update((hides) =>
    key in hides ? null : { ...hides, [key]: new Date().toISOString() },
  );
}

/**
 * Drop hide entries. Takes a list so the Sidebar can consume several resurfaced
 * rows in one write; idempotent, since multiple tabs race to clear the same key.
 */
export function clearHides(keys: string[]): void {
  store.update((hides) => {
    const doomed = keys.filter((k) => k in hides);
    if (!doomed.length) return null;
    const next = { ...hides };
    for (const k of doomed) delete next[k];
    return next;
  });
}

/**
 * Clear the hide covering a session, whichever row key its row uses (a session can
 * sit under `workspace:<id>`, `wt:<dir>` or its own id — the Sidebar picks).
 * Called when the user PROMPTS in a session: you can't be done with a session you're
 * actively working in, and "I replied but it's still gone from my sidebar"
 * reads as a bug. Opening a hidden session deliberately does NOT unhide it.
 */
export function unhideForSession(session: {
  id: string;
  workspaceId?: string | null;
  worktreeDir?: string | null;
}): void {
  clearHides([
    session.id,
    ...(session.workspaceId ? [`workspace:${session.workspaceId}`] : []),
    ...(session.worktreeDir ? [`wt:${session.worktreeDir}`] : []),
  ]);
}

export function onHidesChanged(handler: () => void): () => void {
  return store.onChanged(handler);
}

/**
 * Split rows into "stays hidden" and "resurfaced", applying the one exception
 * to a hide: a row blocked on a question comes back, so hiding can never
 * swallow work that is waiting on a human. The caller consumes `resurfaced`
 * (clear the entries, mark them unread), which is what makes the rule
 * one-shot — the row then stays visible until it's hidden again, instead of
 * flickering as questions get asked and answered.
 */
export function partitionHidden<T extends { key: string; status: string }>(
  rows: T[],
  hides: Record<string, string>,
): { hiddenKeys: Set<string>; resurfaced: T[] } {
  const hiddenKeys = new Set<string>();
  const resurfaced: T[] = [];
  for (const row of rows) {
    if (!(row.key in hides)) continue;
    if (row.status === "needsinput") resurfaced.push(row);
    else hiddenKeys.add(row.key);
  }
  return { hiddenKeys, resurfaced };
}
