// Quick-reply chips above the session composer (components/ReplySuggestions).
// The chips themselves are generated server-side and arrive over the session
// socket as `reply_suggestions`; this module holds the shared shape and the
// per-user switch.
//
// The pref is a makeUserPref instance, so it follows you across devices and
// mounted sessions flip live on the change event. Default on: the row only
// appears when a turn actually ended on a choice, so an instance that never
// hits one never sees it.

import * as userPref from "./user-pref";

export interface ReplySuggestion {
  /** 1-2 words, sentence case. What the chip reads as. */
  label: string;
  /** The full instruction the chip pastes into the composer. */
  text: string;
}

const pref = userPref.makeUserPref<boolean>({
  localKey: "opensession-reply-suggestions",
  prefKey: "reply-suggestions",
  changeEvent: "opensession-reply-suggestions-changed",
  defaultValue: true,
  decode: (v) => (v === "on" ? true : v === "off" ? false : null),
  encode: (on) => (on ? "on" : "off"),
});

export const getReplySuggestionsPref = pref.get;
export const setReplySuggestionsPref = pref.set;
export const onReplySuggestionsChanged = pref.onChanged;
