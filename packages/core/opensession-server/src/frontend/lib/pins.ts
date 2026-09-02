// Pinned tabs, stored server-side per user (keyed on the UserPicker name) so
// they follow you across devices instead of living in one browser. The public
// API stays synchronous (an in-memory cache) so callers don't change: the cache
// is hydrated from the server on load and on user switch, and writes are
// optimistic — update the cache + fire the change event immediately, then PUT.
import { z } from "zod";
import { fetchPins, fetchUiPrefs, savePinsApi, saveUiPrefsApi } from "./api";
import { getCurrentUser } from "../components/UserPicker";
import { whenCurrentUserReady } from "./auth-ready";

const LEGACY_KEY = "opensession-pins"; // old per-browser store, migrated once
const MIGRATED_FLAG = "opensession-pins-migrated";
const CHANGE_EVENT = "opensession-pins-changed";
const USER_CHANGE_EVENT = "opensession-user-changed";

let cache: string[] = [];
let loadedFor: string | null = null;

function emit() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function readLegacy(): string[] {
  try {
    const parsed = z
      .array(z.unknown())
      .safeParse(JSON.parse(localStorage.getItem(LEGACY_KEY) || "[]"));
    if (!parsed.success) return [];
    const pins: string[] = [];
    for (const value of parsed.data) {
      const pin = z.string().safeParse(value);
      if (pin.success) pins.push(pin.data);
    }
    return pins;
  } catch {
    return [];
  }
}

// Hydrate the cache for `user`. On first run after the server-side switch, fold
// this browser's old localStorage pins into the user's server store so nobody
// loses their pins. Migration is deferred until a real user is picked (never
// "Anonymous") so legacy pins land on the right account, and runs at most once.
async function load(user: string) {
  loadedFor = user;
  let pins: string[] = [];
  try {
    pins = await fetchPins(user);
  } catch {
    pins = [];
  }

  if (user !== "Anonymous" && !localStorage.getItem(MIGRATED_FLAG)) {
    const legacy = readLegacy();
    if (legacy.length) {
      pins = Array.from(new Set([...pins, ...legacy]));
      try {
        pins = await savePinsApi(user, pins);
      } catch {
        /* keep the merged list in memory even if the write fails */
      }
    }
    localStorage.setItem(MIGRATED_FLAG, "1");
  }

  // A newer load() (user switched mid-flight) wins.
  if (loadedFor !== user) return;
  cache = pins;
  emit();
}

whenCurrentUserReady((user) => void load(user));
window.addEventListener(USER_CHANGE_EVENT, () => void load(getCurrentUser()));

export function getPins(): string[] {
  return cache;
}

export function isPinned(id: string): boolean {
  return cache.includes(id);
}

/** Add a pin if it isn't already set (never removes). Returns the new list.
    New pins go to the FRONT — the pins array is the Pinned band's display
    order (drag-to-reorder rewrites it), and a fresh session should surface at
    the top of the band, not sink under old pins. */
export function pin(id: string): string[] {
  if (cache.includes(id)) return cache;
  const next = [id, ...cache];
  cache = next;
  emit();
  void savePinsApi(getCurrentUser(), next).catch(() => {});
  return next;
}

// "Pin new" preferences. Both are opt-in — auto-pinning fills the tab strip
// with rows nobody asked for, so a pin should be a deliberate act. localStorage
// is the synchronous cache; ui-prefs is the source of truth so Slack and other
// devices can honor the same setting.
const PIN_NEW_KEY = "opensession-pin-new-sessions";
const PIN_NEW_EVENT = "opensession-pin-new-changed";
const PIN_NEW_PREF_KEY = "pin-new-sessions";
const PIN_NEW_WS_PREF_KEY = "pin-new-workspaces";
let pinPrefsWriteStamp = 0;
let pinPrefsLoadedFor: string | null = null;

export function getPinNewSessions(): boolean {
  return localStorage.getItem(PIN_NEW_KEY) === "on";
}

export function setPinNewSessions(on: boolean): void {
  pinPrefsWriteStamp++;
  if (on) localStorage.setItem(PIN_NEW_KEY, "on");
  else localStorage.removeItem(PIN_NEW_KEY);
  window.dispatchEvent(new Event(PIN_NEW_EVENT));
  void saveUiPrefsApi(getCurrentUser(), {
    [PIN_NEW_PREF_KEY]: on ? "on" : "off",
  }).catch(() => {});
}

export function onPinNewSessionsChanged(handler: () => void): () => void {
  window.addEventListener(PIN_NEW_EVENT, handler);
  return () => window.removeEventListener(PIN_NEW_EVENT, handler);
}

const PIN_NEW_WS_KEY = "opensession-pin-new-workspaces";
const PIN_NEW_WS_EVENT = "opensession-pin-new-workspaces-changed";

export function getPinNewWorkspaces(): boolean {
  return localStorage.getItem(PIN_NEW_WS_KEY) === "on";
}

export function setPinNewWorkspaces(on: boolean): void {
  pinPrefsWriteStamp++;
  if (on) localStorage.setItem(PIN_NEW_WS_KEY, "on");
  else localStorage.removeItem(PIN_NEW_WS_KEY);
  window.dispatchEvent(new Event(PIN_NEW_WS_EVENT));
  void saveUiPrefsApi(getCurrentUser(), {
    [PIN_NEW_WS_PREF_KEY]: on ? "on" : "off",
  }).catch(() => {});
}

export function onPinNewWorkspacesChanged(handler: () => void): () => void {
  window.addEventListener(PIN_NEW_WS_EVENT, handler);
  return () => window.removeEventListener(PIN_NEW_WS_EVENT, handler);
}

async function hydratePinPrefs(user: string) {
  pinPrefsLoadedFor = user;
  const stampAtStart = pinPrefsWriteStamp;
  let prefs: Record<string, string>;
  try {
    prefs = await fetchUiPrefs(user);
  } catch {
    return;
  }
  if (pinPrefsWriteStamp !== stampAtStart || pinPrefsLoadedFor !== user) return;

  const sessionPref = prefs[PIN_NEW_PREF_KEY];
  if (sessionPref === "on" || sessionPref === "off") {
    const on = sessionPref === "on";
    if (on !== getPinNewSessions()) {
      if (on) localStorage.setItem(PIN_NEW_KEY, "on");
      else localStorage.removeItem(PIN_NEW_KEY);
      window.dispatchEvent(new Event(PIN_NEW_EVENT));
    }
  } else if (getPinNewSessions()) {
    void saveUiPrefsApi(user, { [PIN_NEW_PREF_KEY]: "on" }).catch(() => {});
  }

  const workspacePref = prefs[PIN_NEW_WS_PREF_KEY];
  if (workspacePref === "on" || workspacePref === "off") {
    const on = workspacePref === "on";
    if (on !== getPinNewWorkspaces()) {
      if (on) localStorage.setItem(PIN_NEW_WS_KEY, "on");
      else localStorage.removeItem(PIN_NEW_WS_KEY);
      window.dispatchEvent(new Event(PIN_NEW_WS_EVENT));
    }
  } else if (getPinNewWorkspaces()) {
    void saveUiPrefsApi(user, { [PIN_NEW_WS_PREF_KEY]: "on" }).catch(() => {});
  }
}

whenCurrentUserReady((user) => void hydratePinPrefs(user));
window.addEventListener(
  USER_CHANGE_EVENT,
  () => void hydratePinPrefs(getCurrentUser()),
);

/** Apply an authoritative server push without writing the same list back. */
export function receivePins(user: string, pins: string[]): void {
  if (user !== getCurrentUser()) return;
  cache = Array.from(new Set(pins));
  emit();
}

/**
 * Remove any of `ids` that are currently pinned (no-op for the rest). Returns
 * the new list. This is the client-side mirror of the server's
 * `unpinArchivedSessions` — archiving a session drops its pins server-side, but
 * our cache is optimistic and never hears about that write, so the next
 * `savePinsApi` would re-upload the whole stale list and *resurrect* the pin we
 * just archived away. Call this on archive so the cache stays in sync and can't
 * bring an archived (unreachable) pin back to the Pinned band.
 */
export function unpin(ids: string[]): string[] {
  const drop = new Set(ids.filter(Boolean));
  if (!drop.size) return cache;
  const next = cache.filter((id) => !drop.has(id));
  if (next.length === cache.length) return cache;
  cache = next;
  emit();
  void savePinsApi(getCurrentUser(), next).catch(() => {});
  return next;
}

export function togglePin(id: string): string[] {
  // Adding prepends — same top-of-band rule as pin().
  const next = cache.includes(id)
    ? cache.filter((p) => p !== id)
    : [id, ...cache];
  cache = next;
  emit();
  void savePinsApi(getCurrentUser(), next).catch(() => {});
  return next;
}

/**
 * Replace the pin order with `ids` (drag-to-reorder in the tab bar). Keeps only
 * ids already pinned, so a stale drag can't resurrect an unpinned tab; appends
 * any pinned id the caller omitted, so nothing is silently dropped.
 */
export function reorderPins(ids: string[]): string[] {
  const known = new Set(cache);
  const next = ids.filter((id) => known.has(id));
  for (const id of cache) if (!next.includes(id)) next.push(id);
  cache = next;
  emit();
  void savePinsApi(getCurrentUser(), next).catch(() => {});
  return next;
}

export function onPinsChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}
