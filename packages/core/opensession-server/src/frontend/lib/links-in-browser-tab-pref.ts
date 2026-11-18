// "Open links in the Browser tab": whether web links, the PR preview included,
// open in the workspace's Browser tab or go straight to the person's own
// browser. On by default; turning it off is a personal choice, synced across
// devices. Portals keep their pane either way: they are the workspace's own
// running services, not links. Surfaces read it through
// lib/links-in-browser-tab.ts.
import {
  LINKS_IN_BROWSER_TAB_EVENT,
  LINKS_IN_BROWSER_TAB_KEY,
} from "./links-in-browser-tab";
import * as UserPref from "./user-pref";

const pref = UserPref.makeUserPref<boolean>({
  localKey: LINKS_IN_BROWSER_TAB_KEY,
  prefKey: "linksInBrowserTab",
  changeEvent: LINKS_IN_BROWSER_TAB_EVENT,
  defaultValue: true,
  decode: (v) => (v === "on" ? true : v === "off" ? false : null),
  encode: (on) => (on ? "on" : "off"),
});

export const getLinksInBrowserTabPref = pref.get;
export const setLinksInBrowserTabPref = pref.set;
export const onLinksInBrowserTabChanged = pref.onChanged;
