// Factory for per-user UI preferences that follow you across devices. Each
// preference is stored server-side in the per-user ui-prefs map, with a
// localStorage copy as the synchronous cache: reads stay sync (right on first
// paint), the server hydrates on load / user switch and emits the pref's
// change event so mounted surfaces flip live.
//
// The concrete preference modules (lib/vim-pref, lib/turn-activity, …) are
// thin instantiations of this factory; lib/busy-send-pref keeps its own copy
// of the pattern because it manages two keys behind one change event with a
// single batched hydrate.

import { fetchUiPrefs, saveUiPrefsApi } from "./api";
import { getCurrentUser } from "../components/UserPicker";
import { whenCurrentUserReady } from "./auth-ready";

const USER_CHANGE_EVENT = "opensession-user-changed";

export interface UserPref<T> {
  /** Synchronous read of the cached value (defaulted, validated). */
  get: () => T;
  /** Set locally, broadcast the change event, and persist to the server. */
  set: (value: T) => void;
  /** Subscribe to changes (local sets, hydrations, other-tab writes). */
  onChanged: (handler: () => void) => () => void;
}

export function makeUserPref<T>(opts: {
  /** localStorage key for the synchronous cache. */
  localKey: string;
  /** Key inside the server-side ui-prefs map. */
  prefKey: string;
  /** Window event dispatched whenever the value changes. */
  changeEvent: string;
  defaultValue: T;
  /** Raw stored/server string → valid value, or null for invalid/absent. */
  decode: (raw: string | null | undefined) => T | null;
  /** Value → the string stored on the server (and locally for non-defaults). */
  encode: (value: T) => string;
}): UserPref<T> {
  const { localKey, prefKey, changeEvent, defaultValue, decode, encode } = opts;

  function get(): T {
    return decode(localStorage.getItem(localKey)) ?? defaultValue;
  }

  function writeLocal(value: T) {
    // The default's absence is its stored form.
    if (value === defaultValue) localStorage.removeItem(localKey);
    else localStorage.setItem(localKey, encode(value));
  }

  // Bumped on every local set; an in-flight hydration only applies if nothing
  // was set while it was fetching (the user's fresh choice beats a stale read).
  let writeStamp = 0;

  function set(value: T) {
    writeStamp++;
    writeLocal(value);
    window.dispatchEvent(new Event(changeEvent));
    // Server stores the explicit value (even the default) so a reset
    // propagates to other devices instead of leaving their old cached value.
    void saveUiPrefsApi(getCurrentUser(), { [prefKey]: encode(value) }).catch(
      () => {},
    );
  }

  // Pull the user's server-side value into the local cache. First run on a
  // browser that has a local value the server doesn't know yet (the pre-sync
  // localStorage-only era) pushes that value up instead, so nobody's setting
  // is lost by the migration.
  async function hydrate(user: string) {
    const stampAtStart = writeStamp;
    let prefs: Record<string, string>;
    try {
      prefs = await fetchUiPrefs(user);
    } catch {
      return; // offline/error: keep the local cache
    }
    if (writeStamp !== stampAtStart) return; // user changed it mid-fetch
    const server = decode(prefs[prefKey]);
    if (server !== null) {
      if (server !== get()) {
        writeLocal(server);
        window.dispatchEvent(new Event(changeEvent));
      }
    } else if (get() !== defaultValue) {
      // This browser has a local value the server doesn't know yet: push it up.
      void saveUiPrefsApi(user, { [prefKey]: encode(get()) }).catch(() => {});
    }
  }

  whenCurrentUserReady((user) => void hydrate(user));
  window.addEventListener(
    USER_CHANGE_EVENT,
    () => void hydrate(getCurrentUser()),
  );

  function onChanged(handler: () => void): () => void {
    window.addEventListener(changeEvent, handler);
    return () => window.removeEventListener(changeEvent, handler);
  }

  // Mirror changes made in another tab (storage events don't fire same-tab).
  window.addEventListener("storage", (e) => {
    if (e.key === localKey) window.dispatchEvent(new Event(changeEvent));
  });

  return { get, set, onChanged };
}
