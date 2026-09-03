import {
  ACCENT_THEME_OPTIONS,
  type AccentTheme,
  DEFAULT_ACCENT_THEME,
  getAccentThemeOption,
  isAccentTheme,
} from "../../shared/accent-theme";
import { getCurrentUser } from "../components/UserPicker";
import { fetchUiPrefs, saveUiPrefsApi } from "./api";
import { whenCurrentUserReady } from "./auth-ready";
import { repairDesktopPalettePaint } from "./palette-repaint";

/**
 * Seven accents, ordered as a walk around the hue wheel from the blues.
 *
 * Each fill runs at 92% of the chroma its hue can physically reach in sRGB at
 * its lightness, which keeps the palette vivid without clipping. That share is
 * flat across the wheel, but the results are not: Sky tops out below Indigo
 * and Coral, so the cool end reads calmer than the warm one.
 *
 * Two entries sit outside the rule. `lime` (Honey) is a yellow, and yellow only
 * exists at high lightness, so it keeps one value in both appearances; its ink
 * form deepens instead, since a label has to clear text contrast that a plate
 * does not. `mono` (Black) has no hue at all and inverts with the page.
 *
 * The `value` is persisted per person, so these ids outlive their colours:
 * changing a hex re-themes everyone who chose that slot, while renaming one
 * drops them back to the default. Migrate instead: see `getAccentTheme`.
 */
export {
  ACCENT_THEME_OPTIONS,
  type AccentTheme,
  DEFAULT_ACCENT_THEME,
  getAccentThemeOption,
  isAccentTheme,
};

const KEY = "opensession-accent";
const CHANGE_EVENT = "opensession-accent-changed";
const USER_CHANGE_EVENT = "opensession-user-changed";
const PREF_KEY = "accent";

/**
 * Selections that outlived their colour. Each maps to the nearest hue still in
 * the palette, so someone who chose a removed accent lands somewhere close
 * rather than back on the default.
 */
const RETIRED_THEMES = new Map<string, AccentTheme>([
  ["gold", "lime"],
  ["purple", "coral"],
  ["pink", "coral"],
  ["brown", "orange"],
  ["teal", "sky"],
]);

export function getAccentTheme(): AccentTheme {
  const stored = localStorage.getItem(KEY);
  const retired = stored === null ? undefined : RETIRED_THEMES.get(stored);
  if (retired) {
    localStorage.setItem(KEY, retired);
    return retired;
  }
  return isAccentTheme(stored) ? stored : DEFAULT_ACCENT_THEME;
}

/** Black's fill inverts with the page, so it is the only accent whose glyph
 *  changes with the appearance. Honey's white glyph is the palette's one
 *  deliberate low-contrast pairing; see its block in base.css. */
export function getOnAccentInk(
  theme: AccentTheme,
  tone: "light" | "dark",
): "#000000" | "#ffffff" {
  return theme === "mono" && tone === "dark" ? "#000000" : "#ffffff";
}

export function applyAccentTheme(theme: AccentTheme = getAccentTheme()) {
  document.documentElement.dataset.accent = theme;
  repairDesktopPalettePaint();
}

let writeStamp = 0;

function publishAccentTheme(theme: AccentTheme, user = getCurrentUser()) {
  void saveUiPrefsApi(user, { [PREF_KEY]: theme }).catch(() => {});
}

export function setAccentTheme(theme: AccentTheme) {
  writeStamp++;
  localStorage.setItem(KEY, theme);
  applyAccentTheme(theme);
  publishAccentTheme(theme);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Pull the cross-device value once instead of writing the browser's cached
 * value on every page load. The old eager write was both a redundant PUT and
 * could overwrite a newer choice made on another device. */
async function hydrateAccentTheme(user: string) {
  const stampAtStart = writeStamp;
  const localRaw = localStorage.getItem(KEY);
  const localWasExplicit =
    isAccentTheme(localRaw) ||
    (localRaw !== null && RETIRED_THEMES.has(localRaw));
  const localTheme = getAccentTheme();
  let prefs: Record<string, string>;
  try {
    prefs = await fetchUiPrefs(user);
  } catch {
    return;
  }
  if (writeStamp !== stampAtStart || getCurrentUser() !== user) return;

  const raw = prefs[PREF_KEY];
  const serverTheme = isAccentTheme(raw) ? raw : RETIRED_THEMES.get(raw);
  if (serverTheme) {
    if (serverTheme !== localTheme) {
      localStorage.setItem(KEY, serverTheme);
      applyAccentTheme(serverTheme);
      window.dispatchEvent(new Event(CHANGE_EVENT));
    }
    // Retire old server ids too, so the migration is paid once.
    if (raw !== serverTheme) publishAccentTheme(serverTheme, user);
  } else if (localWasExplicit) {
    // Preserve a choice made while the server was unavailable.
    publishAccentTheme(localTheme, user);
  }
}

export function onAccentThemeChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

export function handleAccentStorageChange(event: Pick<StorageEvent, "key">) {
  // A null key is localStorage.clear(), which resets the accent to its default.
  if (event.key !== KEY && event.key !== null) return;
  writeStamp++;
  applyAccentTheme();
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

if (globalThis.window && globalThis.document) {
  window.addEventListener("storage", handleAccentStorageChange);

  // The inline bootstrap applies this before paint; repeat it on import so the
  // contract still holds if that bootstrap is ever removed.
  const theme = getAccentTheme();
  applyAccentTheme(theme);
  whenCurrentUserReady((user) => void hydrateAccentTheme(user));
  window.addEventListener(
    USER_CHANGE_EVENT,
    () => void hydrateAccentTheme(getCurrentUser()),
  );
}
