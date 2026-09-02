import { repairDesktopPalettePaint } from "./palette-repaint";

// Appearance theme: follow the OS ("system", the default) or force light/dark.
// Stored per-browser in localStorage — it's an appearance/device preference, not
// per-user cloud state like pins — and applied to <html data-theme>, which drives
// the CSS-variable palette in styles/base.css. Kept in its own module so the
// pre-paint inline script in index.html and the React Settings page share one
// source of truth for the key and the resolution logic.

export type ThemePref = "system" | "light" | "dark";
export type EffectiveTheme = "light" | "dark";

// Keep this key in sync with the pre-paint script in index.html.
const KEY = "opensession-theme";
const CHANGE_EVENT = "opensession-theme-changed";

export function getThemePref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function systemTheme(): EffectiveTheme {
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function effectiveTheme(
  pref: ThemePref = getThemePref(),
): EffectiveTheme {
  return pref === "system" ? systemTheme() : pref;
}

// Paint the resolved theme onto <html> so the variable palette + native UI (form
// controls, scrollbars, via color-scheme) switch, and keep the PWA status-bar
// color in sync.
export function applyTheme(pref: ThemePref = getThemePref()) {
  const eff = effectiveTheme(pref);
  const html = document.documentElement;
  html.dataset.theme = eff;
  html.style.colorScheme = eff;
  const meta = document.querySelector('meta[name="theme-color"]');
  // Match --bg-raised (the sidebar + WCO titlebar surface), not --bg: in an
  // installed desktop PWA the OS paints the window-controls caption band (behind
  // the traffic lights) with theme-color, so anything else leaves that strip a
  // different colour from our own titlebar. Keep in sync with index.html.
  if (meta)
    meta.setAttribute("content", eff === "light" ? "#f6f6f6" : "#222222");
  repairDesktopPalettePaint();
}

export function setThemePref(pref: ThemePref) {
  // "system" is the absence of an override, so clear the key rather than store it.
  if (pref === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, pref);
  applyTheme(pref);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onThemeChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

// Re-apply when the OS flips while we're following it, and mirror changes made
// in another tab (localStorage `storage` events fire cross-tab, not same-tab).
// Capability check, not just `typeof window`: test runners can leave a bare
// `window` global without DOM methods, which must not break module import.
if (
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.addEventListener
) {
  window
    .matchMedia("(prefers-color-scheme: light)")
    .addEventListener?.("change", () => {
      if (getThemePref() === "system") {
        applyTheme();
        window.dispatchEvent(new Event(CHANGE_EVENT));
      }
    });
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) {
      applyTheme();
      window.dispatchEvent(new Event(CHANGE_EVENT));
    }
  });

  // Belt-and-suspenders with index.html's pre-paint script: apply on import so
  // the theme is correct even if that inline script is ever dropped.
  applyTheme();
}
