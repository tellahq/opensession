// Vim mode for the composer (Settings → Preferences, default off). A
// makeUserPref instance — see lib/user-pref for the server-side ui-prefs
// hydrate pattern; mounted composers flip live on the change event.

import { makeUserPref } from "./user-pref";

const pref = makeUserPref<boolean>({
  localKey: "opensession-vim-mode",
  prefKey: "composer-vim",
  changeEvent: "opensession-vim-mode-changed",
  defaultValue: false,
  decode: (v) => (v === "on" ? true : v === "off" ? false : null),
  encode: (on) => (on ? "on" : "off"),
});

export const getVimModePref = pref.get;
export const setVimModePref = pref.set;
export const onVimModeChanged = pref.onChanged;
