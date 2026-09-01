// Whether worker sessions appear nested under the selected workspace in the
// sidebar. They remain hidden from the top-level workspace and automation lists
// when this is off, so disabling the preference removes the extra rows instead
// of turning implementation-detail workers into peers of their parent.

import { makeUserPref } from "./user-pref";

const pref = makeUserPref<boolean>({
  localKey: "opensession-sidebar-subagents",
  prefKey: "sidebar-subagents",
  changeEvent: "opensession-sidebar-subagents-changed",
  defaultValue: true,
  decode: (value) =>
    value === "show" ? true : value === "hide" ? false : null,
  encode: (shown) => (shown ? "show" : "hide"),
});

export const getSidebarSubagentsPref = pref.get;
export const setSidebarSubagentsPref = pref.set;
export const onSidebarSubagentsChanged = pref.onChanged;
