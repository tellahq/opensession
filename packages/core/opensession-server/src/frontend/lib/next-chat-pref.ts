// Whether the Next chat button appears above the composer. This only controls
// the visible shortcut: the command palette action and keyboard shortcut stay
// available when the button is hidden.
//
// Default on to preserve the existing composer. A makeUserPref instance keeps
// the choice in sync across the web and native clients.

import * as userPref from "./user-pref";

const pref = userPref.makeUserPref<boolean>({
  localKey: "opensession-next-chat-button",
  prefKey: "next-chat-button",
  changeEvent: "opensession-next-chat-button-changed",
  defaultValue: true,
  decode: (v) => (v === "on" ? true : v === "off" ? false : null),
  encode: (on) => (on ? "on" : "off"),
});

export const getNextChatButtonPref = pref.get;
export const setNextChatButtonPref = pref.set;
export const onNextChatButtonChanged = pref.onChanged;
