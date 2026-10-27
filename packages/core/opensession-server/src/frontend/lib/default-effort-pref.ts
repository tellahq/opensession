// Per-user default reasoning effort for NEW sessions (Settings → Preferences),
// the companion of lib/default-model-pref. "" = no preference: a new session
// starts on its model's own default effort. A makeUserPref instance, so it
// follows the person across devices through the server-side ui-prefs map.
// A preference the starting model does not offer is skipped, not forced
// (lib/new-session-model preferredNewSessionEffort).

import * as userPref from "./user-pref";

const DEFAULT_EFFORT_CHOICES = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type DefaultEffort = (typeof DEFAULT_EFFORT_CHOICES)[number];
const EFFORT_SET = new Set<string>(DEFAULT_EFFORT_CHOICES);

export function isDefaultEffort(value: string): value is DefaultEffort {
  return EFFORT_SET.has(value);
}

const pref = userPref.makeUserPref<string>({
  localKey: "opensession-default-effort-pref",
  prefKey: "default-effort",
  changeEvent: "opensession-default-effort-pref-changed",
  defaultValue: "",
  decode: (value) =>
    value === "" ? "" : value && isDefaultEffort(value) ? value : null,
  encode: (v) => v,
});

/** The user's preferred new-session effort id, or "" for no preference. */
export const getDefaultEffortPref = pref.get;
export const setDefaultEffortPref = pref.set;
export const onDefaultEffortPrefChanged = pref.onChanged;
