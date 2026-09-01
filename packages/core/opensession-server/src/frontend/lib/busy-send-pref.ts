// Follow-up behavior while a run is busy (Settings → Preferences): two prefs, one
// per send gesture — what plain Enter (and the send button) does, and what
// ⌘/Ctrl+Enter does. Defaults queue/steer keep the classic split; set both to
// steer to always fold into the live turn. "queue" holds the message until the
// agent fully finishes (incl. running worker sessions); "steer" folds it into
// the live turn at its next step boundary.
// Stored server-side per user (ui-prefs) so it follows you across devices,
// with a localStorage copy as the synchronous cache — the same hydrate
// pattern as lib/user-pref. Deliberately NOT a makeUserPref instance: this
// module manages two stored keys (one per gesture) behind a single change
// event, with one hydrate fetch that applies/pushes both keys in one batch —
// the factory models exactly one key per preference.

import { fetchUiPrefs, saveUiPrefsApi } from "./api";
import { getCurrentUser } from "../components/UserPicker";
import { whenCurrentUserReady } from "./auth-ready";

export type BusySendPref = "queue" | "steer";
export type BusySendGesture = "enter" | "mod";
export type BusySendPrefs = { enter: BusySendPref; mod: BusySendPref };

const GESTURES: BusySendGesture[] = ["enter", "mod"];
// Per-gesture storage keys and defaults. "enter" keeps the pre-split key so an
// existing stored choice carries over unchanged.
const LOCAL_KEY: Record<BusySendGesture, string> = {
  enter: "opensession-busy-send",
  mod: "opensession-busy-send-mod",
};
const PREF_KEY: Record<BusySendGesture, string> = {
  enter: "busy-send", // key inside the server-side ui-prefs map
  mod: "busy-send-mod",
};
const DEFAULT: Record<BusySendGesture, BusySendPref> = {
  enter: "queue",
  mod: "steer",
};
const CHANGE_EVENT = "opensession-busy-send-changed";
const USER_CHANGE_EVENT = "opensession-user-changed";

function readLocal(gesture: BusySendGesture): BusySendPref {
  const raw = localStorage.getItem(LOCAL_KEY[gesture]);
  return raw === "queue" || raw === "steer" ? raw : DEFAULT[gesture];
}

export function getBusySendPrefs(): BusySendPrefs {
  return { enter: readLocal("enter"), mod: readLocal("mod") };
}

function writeLocal(gesture: BusySendGesture, pref: BusySendPref) {
  // The default's absence is its stored form.
  if (pref === DEFAULT[gesture]) localStorage.removeItem(LOCAL_KEY[gesture]);
  else localStorage.setItem(LOCAL_KEY[gesture], pref);
}

// Bumped on every local set; an in-flight hydration only applies if nothing
// was set while it was fetching (the user's fresh choice beats a stale read).
let writeStamp = 0;

export function setBusySendPref(gesture: BusySendGesture, pref: BusySendPref) {
  writeStamp++;
  writeLocal(gesture, pref);
  window.dispatchEvent(new Event(CHANGE_EVENT));
  // Server stores the explicit value (even the default) so a reset propagates
  // to other devices instead of leaving their old cached value in place.
  void saveUiPrefsApi(getCurrentUser(), { [PREF_KEY[gesture]]: pref }).catch(
    () => {},
  );
}

async function hydrate(user: string) {
  const stampAtStart = writeStamp;
  let prefs: Record<string, string>;
  try {
    prefs = await fetchUiPrefs(user);
  } catch {
    return; // offline/error: keep the local cache
  }
  if (writeStamp !== stampAtStart) return; // user changed it mid-fetch
  let changed = false;
  const pushUp: Record<string, string> = {};
  for (const gesture of GESTURES) {
    const server = prefs[PREF_KEY[gesture]];
    if (server === "steer" || server === "queue") {
      if (server !== readLocal(gesture)) {
        writeLocal(gesture, server);
        changed = true;
      }
    } else if (readLocal(gesture) !== DEFAULT[gesture]) {
      // This browser has a local value the server doesn't know yet.
      pushUp[PREF_KEY[gesture]] = readLocal(gesture);
    }
  }
  if (changed) window.dispatchEvent(new Event(CHANGE_EVENT));
  if (Object.keys(pushUp).length)
    void saveUiPrefsApi(user, pushUp).catch(() => {});
}

whenCurrentUserReady((user) => void hydrate(user));
window.addEventListener(
  USER_CHANGE_EVENT,
  () => void hydrate(getCurrentUser()),
);

export function onBusySendChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

// Mirror changes made in another tab (storage events don't fire same-tab).
window.addEventListener("storage", (e) => {
  if (e.key && Object.values(LOCAL_KEY).includes(e.key))
    window.dispatchEvent(new Event(CHANGE_EVENT));
});
