// Reads "Open links in the Browser tab" without pulling in the synced
// preference machinery (lib/links-in-browser-tab-pref.ts writes and syncs it).
// Links and preview marks render in isolated tests with no window, so this
// module touches no browser global until it is asked.
import { useSyncExternalStore } from "react";

export const LINKS_IN_BROWSER_TAB_KEY = "opensession-links-in-browser-tab";
export const LINKS_IN_BROWSER_TAB_EVENT =
  "opensession-links-in-browser-tab-changed";

/** On unless this person turned it off. */
export function linksInBrowserTab(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(LINKS_IN_BROWSER_TAB_KEY) !== "off";
}

function subscribe(handler: () => void): () => void {
  window.addEventListener(LINKS_IN_BROWSER_TAB_EVENT, handler);
  return () => window.removeEventListener(LINKS_IN_BROWSER_TAB_EVENT, handler);
}

export function useLinksInBrowserTab(): boolean {
  return useSyncExternalStore(subscribe, linksInBrowserTab, linksInBrowserTab);
}
