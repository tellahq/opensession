// "Send messages with" — whether Enter sends in the composer (default, with
// Shift+Enter for new lines) or ⌘/Ctrl+Enter sends (plain Enter inserts a new
// line). A makeUserPref instance — see lib/user-pref for the server-side
// ui-prefs hydrate pattern (whose push-up also migrates the pre-2026-07-23
// per-browser-only value to the server on first load).
//
// The pure key-matching helpers (isSendCombo, labels) live in lib/send-key —
// this module owns only the stored preference.

import { makeUserPref } from "./user-pref";
import type { SendKeyPref } from "./send-key";

const pref = makeUserPref<SendKeyPref>({
  localKey: "opensession-send-key",
  prefKey: "send-key",
  changeEvent: "opensession-send-key-changed",
  defaultValue: "enter",
  decode: (v) => (v === "enter" || v === "mod-enter" ? v : null),
  encode: (v) => v,
});

export const getSendKeyPref = pref.get;
export const setSendKeyPref = pref.set;
export const onSendKeyChanged = pref.onChanged;
