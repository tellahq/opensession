// Desk voice mode toggle (Settings → Desk, default off). A makeUserPref
// instance — see lib/user-pref for the server-side ui-prefs hydrate pattern;
// mounted surfaces flip live on the change event.

import * as userPref from "./user-pref";

const pref = userPref.makeUserPref<boolean>({
  localKey: "opensession-desk-voice",
  prefKey: "desk-voice",
  changeEvent: "opensession-desk-voice-changed",
  defaultValue: false,
  decode: (v) => (v === "on" ? true : v === "off" ? false : null),
  encode: (on) => (on ? "on" : "off"),
});

export const getDeskVoicePref = pref.get;
export const setDeskVoicePref = pref.set;
export const onDeskVoiceChanged = pref.onChanged;
