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

import {
  captureClientDataScope,
  clientDataStorageKey,
  subscribeClientDataScope,
} from "./client-data-scope";
import * as userPref from "./user-pref";
const KEY = "opensession-default-repo-pref";
const EVENT = "opensession-default-repo-pref-changed";
// Preserve legacy sync only for explicit unauthenticated local operation.
const localPref = userPref.makeUserPref<string>({
  localKey: KEY,
  prefKey: "default-repo",
  changeEvent: EVENT,
  defaultValue: "",
  decode: (value) => (value == null ? null : value === "auto" ? "" : value),
  encode: (value) => value,
  localOnlyIdentity: true,
});
export function getDefaultRepoPref(): string {
  const scope = captureClientDataScope();
  if (scope?.key === "shared:local") return localPref.get();
  const key = clientDataStorageKey(KEY);
  if (!key) return "";
  try {
    const value = localStorage.getItem(key);
    return value === "auto" ? "" : (value ?? "");
  } catch {
    return "";
  }
}
export function setDefaultRepoPref(value: string): void {
  if (captureClientDataScope()?.key === "shared:local") {
    localPref.set(value);
    return;
  }
  const key = clientDataStorageKey(KEY);
  if (!key) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage optional. */
  }
  window.dispatchEvent(new Event(EVENT));
}
export const onDefaultRepoPrefChanged = localPref.onChanged;
subscribeClientDataScope(() => {
  globalThis.window?.dispatchEvent(new Event(EVENT));
});
