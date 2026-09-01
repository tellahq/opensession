// Per-user sidebar lanes, stored server-side per user (keyed on the
// UserPicker name) like pins, so they follow you across devices. An entry
// claims a session into YOUR sidebar lanes — that's what pulls an automation
// run or a teammate's workspace out of its own band; the value then either
// forces a status lane (Backlog, In review, …) or, as "mine", leaves it to
// follow its live state. Personal triage, not workspace state, so two
// teammates can each hold the same workspace in their own Backlog. The legacy global
// `manualStatus` (status-overrides registry, applied server-side) remains as
// a fallback for entries set before lanes went per-user; the sidebar reads
// the personal lane first. The public API stays synchronous (an in-memory
// cache): the store is a lib/user-map instance, which owns hydration and
// ordered per-key delta writes.
import { fetchLanes, saveLanesApi } from "./api";
import { makeUserMap } from "./user-map";

export type Lane =
  | "needsinput"
  | "inprogress"
  | "review"
  | "merged"
  | "pending"
  /** Claimed into your sidebar with no forced lane — it follows its live
	    state (In progress while running, Backlog once idle). */
  | "mine";

const CHANGE_EVENT = "opensession-lanes-changed";

const store = makeUserMap<Lane>({
  changeEvent: CHANGE_EVENT,
  fetchMap: (user) => fetchLanes(user) as Promise<Record<string, Lane>>,
  saveDelta: (user, delta) => saveLanesApi(user, delta),
});

export function getLanes(): Record<string, Lane> {
  return store.get();
}

/** Your personal lane for a session id, or undefined. */
export function getLane(id: string): Lane | undefined {
  return store.get()[id];
}

/** Set (a lane) or clear (null) your personal lane for a session id. */
export function setLane(id: string, lane: Lane | null): void {
  store.update((lanes) => {
    if (lane) return { ...lanes, [id]: lane };
    if (!(id in lanes)) return null;
    const next = { ...lanes };
    delete next[id];
    return next;
  });
}

export function onLanesChanged(handler: () => void): () => void {
  return store.onChanged(handler);
}
