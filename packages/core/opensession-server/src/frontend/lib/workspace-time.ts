// "Show last used time" on sidebar workspace rows — the compact time ("3h",
// "2d") of a workspace's last activity. Revealed on row hover by default (the
// always-on badge was sidebar noise, so the resting state stays clean); "always"
// pins it visible, "off" hides it entirely. A live run still shows its elapsed
// ticker regardless. Stored per-browser in localStorage like the theme: a
// display habit, not cloud state.

export type WsTimePref = "off" | "always" | "hover";

const KEY = "opensession-ws-time";
const CHANGE_EVENT = "opensession-ws-time-changed";

export function getWsTimePref(): WsTimePref {
  const v = localStorage.getItem(KEY);
  // "hover" is the default, so its absence is the stored form.
  return v === "always" || v === "off" ? v : "hover";
}

export function setWsTimePref(pref: WsTimePref) {
  if (pref === "hover") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, pref);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onWsTimeChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

// Mirror changes made in another tab (storage events don't fire same-tab).
window.addEventListener("storage", (e) => {
  if (e.key === KEY) window.dispatchEvent(new Event(CHANGE_EVENT));
});
