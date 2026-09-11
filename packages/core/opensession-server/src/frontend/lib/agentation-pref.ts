// Per-user Agentation visibility, beneath the instance-wide enable flag.
import * as UserPref from "./user-pref";

const pref = UserPref.makeUserPref<boolean>({
  localKey: "opensession-agentation",
  prefKey: "agentation",
  changeEvent: "opensession-agentation-changed",
  defaultValue: true,
  decode: (v) => (v === "on" ? true : v === "off" ? false : null),
  encode: (on) => (on ? "on" : "off"),
});

export const getAgentationPref = pref.get;
export const setAgentationPref = pref.set;
export const onAgentationChanged = pref.onChanged;
