// Whether a running turn's reply types out as the model writes it, or appears
// a block at a time as each block finishes.
//
// The server streams either way. This is a per-VIEWER choice, not a per-run
// one: several people can watch the same session, the frames cost nothing to
// drop, and it covers every engine rather than only the one whose runner has
// a kill switch. Off means the live bubble stays quiet and the transcript
// fills in from the durable entries, which land as each block completes.
//
// Default off. Typing text moves the page while you are reading it, and the
// reply is no faster for having been watched.
//
// A makeUserPref instance, so the answer follows you across devices (see
// lib/user-pref).

import { makeUserPref } from "./user-pref";

const pref = makeUserPref<boolean>({
  localKey: "opensession-live-typing",
  prefKey: "live-typing",
  changeEvent: "opensession-live-typing-changed",
  defaultValue: false,
  decode: (v) => (v === "on" ? true : v === "off" ? false : null),
  encode: (on) => (on ? "on" : "off"),
});

export const getLiveTypingPref = pref.get;
export const setLiveTypingPref = pref.set;
export const onLiveTypingChanged = pref.onChanged;
