// Whether a PR's ready preview environment gets a Browser tab of its own.
import * as UserPref from "./user-pref";

// Off by default: a personal opt-in, synced across devices.
const pref = UserPref.makeUserPref<boolean>({
  localKey: "opensession-preview-auto-open",
  prefKey: "previewAutoOpen",
  changeEvent: "opensession-preview-auto-open-changed",
  defaultValue: false,
  decode: (v) => (v === "on" ? true : v === "off" ? false : null),
  encode: (on) => (on ? "on" : "off"),
});

export const getPreviewAutoOpenPref = pref.get;
export const setPreviewAutoOpenPref = pref.set;
export const onPreviewAutoOpenChanged = pref.onChanged;
