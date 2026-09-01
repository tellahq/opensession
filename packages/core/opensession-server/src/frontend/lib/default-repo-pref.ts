// Per-user default repository for NEW sessions (Settings → Preferences): what
// the New-session palette's repo picker starts on for this user. "" = no
// preference, which falls back to the workspace's configured default and then
// to the registered default repository.
//
// Older clients could store "auto" here. Decode that retired value as no
// preference so every visible selection is a real repository.
//
// A makeUserPref instance — see lib/user-pref for the ui-prefs hydrate
// pattern. Any string the server sends (including "" for an explicit reset) is
// applied as-is; the palette validates it against the live repo list, so a
// preference naming a repo that has since been removed simply stops applying.

import { makeUserPref } from "./user-pref";

const pref = makeUserPref<string>({
  localKey: "opensession-default-repo-pref",
  prefKey: "default-repo",
  changeEvent: "opensession-default-repo-pref-changed",
  defaultValue: "",
  decode: (v) => (typeof v === "string" ? (v === "auto" ? "" : v) : null),
  encode: (v) => v,
});

/** The user's preferred new-session repo id, or "" for no preference. */
export const getDefaultRepoPref = pref.get;
export const setDefaultRepoPref = pref.set;
export const onDefaultRepoPrefChanged = pref.onChanged;
