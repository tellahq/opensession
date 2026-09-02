// Per-session "last read" marks, so the sidebar can flag sessions with unread
// activity (WhatsApp/iMessage-style). We store, per session id, the
// `lastActivity` timestamp the session had the last time it was open in the
// viewer. A session counts as unread when its current `lastActivity` is newer
// than that mark — i.e. something happened after you last looked.
//
// Only sessions you've actually opened get a mark, so sessions you've never
// looked at (other people's, automations you don't follow) don't all light up
// as unread — the flag means "new since you last read it", not "never seen".

import { z } from "zod";
import { fetchReads, saveReadsApi } from "./api";
import { getCurrentUser } from "../components/UserPicker";
import { whenCurrentUserReady } from "./auth-ready";

const KEY_PREFIX = "opensession-reads:";
const LEGACY_KEY = "opensession-reads";
const CHANGE_EVENT = "opensession-reads-changed";
const USER_CHANGE_EVENT = "opensession-user-changed";
// Bound the map so it can't grow forever; when over cap we drop the
// oldest-inserted marks (object key order is insertion order).
const CAP = 500;

type ReadMap = Record<string, string>;

function userKey(user: string): string {
  return `${KEY_PREFIX}${user.trim().toLowerCase() || "anonymous"}`;
}

function cap(map: ReadMap): ReadMap {
  const keys = Object.keys(map);
  if (keys.length <= CAP) return map;
  for (const key of keys.slice(0, keys.length - CAP)) delete map[key];
  return map;
}

function readStored(key: string): ReadMap {
  try {
    const stored = z
      .record(z.string(), z.unknown())
      .safeParse(JSON.parse(localStorage.getItem(key) || "{}"));
    if (!stored.success) return {};
    const reads: ReadMap = {};
    for (const [id, value] of Object.entries(stored.data)) {
      const mark = z.string().safeParse(value);
      if (mark.success) reads[id] = mark.data;
    }
    return cap(reads);
  } catch {
    return {};
  }
}

function read(user = getCurrentUser()): ReadMap {
  const key = userKey(user);
  const scoped = readStored(key);
  if (Object.keys(scoped).length || localStorage.getItem(LEGACY_KEY) === null) {
    return scoped;
  }
  // The old map predated user-scoped reads. Attribute it to the user active
  // during this one-time migration rather than leaking it across later switches.
  const legacy = readStored(LEGACY_KEY);
  localStorage.setItem(key, JSON.stringify(legacy));
  localStorage.removeItem(LEGACY_KEY);
  return legacy;
}

function write(user: string, map: ReadMap): void {
  localStorage.setItem(userKey(user), JSON.stringify(cap(map)));
}

export function getReads(): ReadMap {
  return read();
}

// Mirror the full read map to the server (fire-and-forget) so consumers that
// can't see localStorage — the hardware macropad feed (GET /api/keypad) — can
// flag unread sessions. Optimistic, like pins: failures are ignored.
let hydratedFor: string | null = null;
let hydrationVersion = 0;
let hydrationRetry: ReturnType<typeof setTimeout> | undefined;
const pendingIntents = new Map<string, ReadMap>();
const saveChains = new Map<string, Promise<unknown>>();

function syncToServer(user: string, map: ReadMap): void {
  const next = saveChains.get(user) ?? Promise.resolve();
  saveChains.set(
    user,
    next
      .catch(() => {})
      .then(() => saveReadsApi(user, map))
      .catch(() => {}),
  );
}

function emit(): void {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function recordIntent(user: string, id: string, mark: string): void {
  const intents = pendingIntents.get(user) ?? {};
  intents[id] = mark;
  pendingIntents.set(user, intents);
}

export function mergeReadMaps(
  server: ReadMap,
  local: ReadMap,
  intents: ReadMap = {},
): ReadMap {
  const merged = { ...server };
  for (const [id, mark] of Object.entries(local)) {
    if (
      !merged[id] ||
      new Date(mark).getTime() > new Date(merged[id]).getTime()
    ) {
      merged[id] = mark;
    }
  }
  // An explicit click while GET was in flight is newer than either persisted map.
  return cap({ ...merged, ...intents });
}

async function hydrate(user: string): Promise<void> {
  const version = ++hydrationVersion;
  let server: ReadMap;
  try {
    server = await fetchReads(user);
  } catch {
    clearTimeout(hydrationRetry);
    hydrationRetry = setTimeout(() => {
      if (getCurrentUser() === user && hydratedFor !== user) void hydrate(user);
    }, 5_000);
    return;
  }
  if (version !== hydrationVersion || getCurrentUser() !== user) return;
  const intents = pendingIntents.get(user) ?? {};
  const next = mergeReadMaps(server, read(user), intents);
  clearTimeout(hydrationRetry);
  hydrationRetry = undefined;
  write(user, next);
  hydratedFor = user;
  pendingIntents.delete(user);
  emit();
  // Never PUT a merely fresh browser's local map over the server map. Only an
  // explicit mark made before hydration needs to be persisted now.
  if (Object.keys(intents).length) syncToServer(user, next);
}

/**
 * Record that a session has been read up to `activity` (its `lastActivity` at
 * the moment it's open). No-op if we already have that exact mark, so calling
 * it on every activity tick while a session is open stays cheap and doesn't
 * spam the change event.
 */
export function markRead(id: string, activity: string): void {
  const user = getCurrentUser();
  const map = read(user);
  if (hydratedFor !== user) recordIntent(user, id, activity);
  if (map[id] === activity) return;
  map[id] = activity;
  write(user, map);
  emit();
  if (hydratedFor === user) syncToServer(user, map);
}

/**
 * Force a session to read as unread: park its mark at the epoch so any real
 * `lastActivity` is newer (see isUnread). Used by the sidebar's "Mark as unread"
 * — the inverse of markRead. If the session is currently open the viewer will
 * re-mark it read on the next activity tick, which is the expected behavior.
 */
export function markUnread(id: string): void {
  const user = getCurrentUser();
  const map = read(user);
  const epoch = "1970-01-01T00:00:00.000Z";
  if (hydratedFor !== user) recordIntent(user, id, epoch);
  if (map[id] === epoch) return;
  map[id] = epoch;
  write(user, map);
  emit();
  if (hydratedFor === user) syncToServer(user, map);
}

/** True when the session has activity newer than the last read mark. */
export function isUnread(
  id: string,
  lastActivity: string,
  reads: ReadMap,
): boolean {
  const mark = reads[id];
  if (!mark) return false;
  return new Date(lastActivity).getTime() > new Date(mark).getTime();
}

export function onReadsChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

if (globalThis.window?.addEventListener) {
  whenCurrentUserReady((user) => void hydrate(user));
  globalThis.window.addEventListener(USER_CHANGE_EVENT, () => {
    clearTimeout(hydrationRetry);
    hydratedFor = null;
    emit();
    void hydrate(getCurrentUser());
  });
  globalThis.window.addEventListener("storage", (event) => {
    if (event.key === "opensession-user" || event.key === "backstage-user") {
      clearTimeout(hydrationRetry);
      hydratedFor = null;
      emit();
      void hydrate(getCurrentUser());
    }
  });
}
