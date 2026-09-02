/**
 * The chord codec behind rebindable keyboard shortcuts.
 *
 * A chord is stored as one canonical lowercase string, modifiers first in a
 * fixed order, plus-joined: `mod+shift+a`, `mod+alt+arrowup`, `ctrl+r`.
 *
 * `mod` is the platform's command modifier, Meta on Apple and Control
 * elsewhere. It is stored that way rather than as `meta`/`ctrl` because these
 * bindings sync across devices through the per-user ui-prefs map: someone who
 * rebinds a chord on a MacBook should get the Control-key equivalent on a PC,
 * not a dead shortcut. `ctrl` is only its own token on Apple, where Control is
 * genuinely a second modifier; everywhere else it normalizes into `mod` so one
 * physical chord has exactly one spelling.
 *
 * Every function here is pure and takes `apple` explicitly, so the codec can be
 * tested without a navigator. lib/shortcuts binds it to the real platform.
 */

/** Canonical chord string. `mod+shift+a`, `alt+arrowup`, `f5`. */
export type Chord = string;

/** Modifier tokens, in the order a canonical chord spells them. */
const MODIFIER_ORDER = ["mod", "ctrl", "alt", "shift"] as const;

/** Keys that are only ever a modifier: they can't be the end of a chord. */
const MODIFIER_KEYS = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "CapsLock",
  "OS",
  "AltGraph",
  "Fn",
  "FnLock",
]);

/** Printable ASCII: the range where `e.key` is the character that got typed. */
function isAsciiPrintable(key: string): boolean {
  if (key.length !== 1) return false;
  const c = key.charCodeAt(0);
  return c >= 0x20 && c < 0x7f;
}

/**
 * The non-modifier half of a chord, as a stable token.
 *
 * Letters and digits prefer the physical `e.code` in the two cases where
 * `e.key` lies about which key was pressed:
 *
 *  - Option is held. On macOS ⌥C reports `ç` and ⌥N reports a dead key, so
 *    every ⌘⌥ chord in the app already matches on `e.code` by hand.
 *  - `e.key` isn't printable ASCII, i.e. a non-Latin layout. Cyrillic ⌘К
 *    should still open the command menu.
 *
 * Outside those, `e.key` wins, so a mnemonic follows the letter printed on the
 * key rather than its QWERTY position.
 */
export function eventKeyToken(e: KeyboardEvent): string | null {
  const key = e.key;
  if (!key || MODIFIER_KEYS.has(key)) return null;
  const code = e.code || "";
  const printable = isAsciiPrintable(key);
  if (/^Key[A-Z]$/.test(code) && (e.altKey || !printable)) {
    return code.slice(3).toLowerCase();
  }
  // Shift+digit types punctuation (`!` for `1`), so the code carries the digit.
  if (/^Digit[0-9]$/.test(code) && (e.altKey || e.shiftKey || !printable)) {
    return code.slice(5);
  }
  if (key === " " || code === "Space") return "space";
  return key.toLowerCase();
}

/**
 * The chord a keyboard event represents, or null when it carries no key of its
 * own (a bare modifier press, or a composition in progress).
 */
export function eventChord(e: KeyboardEvent, apple: boolean): Chord | null {
  if (e.isComposing) return null;
  const key = eventKeyToken(e);
  if (!key) return null;
  const parts: string[] = [];
  if (apple ? e.metaKey : e.ctrlKey) parts.push("mod");
  if (apple && e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

/**
 * Re-spell a chord in canonical form: lowercase, modifiers deduplicated and
 * ordered, `meta` read as `mod`, and `ctrl` folded into `mod` off Apple (where
 * they are the same physical key). Returns null for a chord with no key, or
 * one naming a modifier twice over.
 */
export function normalizeChord(raw: string, apple: boolean): Chord | null {
  const tokens = raw
    .toLowerCase()
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const mods = new Set<(typeof MODIFIER_ORDER)[number]>();
  let key: string | null = null;
  for (const token of tokens) {
    if (token === "mod" || token === "meta" || token === "cmd") {
      mods.add("mod");
    } else if (token === "ctrl" || token === "control") {
      mods.add(apple ? "ctrl" : "mod");
    } else if (token === "alt" || token === "option" || token === "opt") {
      mods.add("alt");
    } else if (token === "shift") {
      mods.add("shift");
    } else {
      if (key) return null; // two non-modifier keys is not a chord
      key = token;
    }
  }
  if (!key) return null;
  return [...MODIFIER_ORDER.filter((modifier) => mods.has(modifier)), key].join(
    "+",
  );
}

/** The modifier tokens a chord carries. */
export function chordModifiers(chord: Chord): string[] {
  const parts = chord.split("+");
  return parts.slice(0, -1);
}

/** The non-modifier token a chord ends on. */
export function chordKey(chord: Chord): string {
  const parts = chord.split("+");
  return parts[parts.length - 1] ?? "";
}

/**
 * True when a chord is safe to bind: it must be reachable without swallowing
 * ordinary typing. A bare printable key, or one carrying only Shift, would
 * fire from the composer on every keystroke, so those are rejected. Function
 * keys and the navigation keys stand alone, since nothing types them.
 */
export function isBindableChord(chord: Chord): boolean {
  const key = chordKey(chord);
  if (!key) return false;
  const mods = chordModifiers(chord);
  const hasRealModifier =
    mods.includes("mod") || mods.includes("ctrl") || mods.includes("alt");
  if (hasRealModifier) return true;
  return /^f([1-9]|1[0-9]|2[0-4])$/.test(key);
}

/** Keys whose glyph differs from their token. */
const KEY_GLYPHS = new Map([
  ["arrowup", "↑"],
  ["arrowdown", "↓"],
  ["arrowleft", "←"],
  ["arrowright", "→"],
  ["enter", "↵"],
  ["escape", "Esc"],
  ["backspace", "⌫"],
  ["delete", "⌦"],
  ["tab", "⇥"],
  ["space", "Space"],
  ["pageup", "PgUp"],
  ["pagedown", "PgDn"],
  ["home", "Home"],
  ["end", "End"],
  [",", ","],
  [".", "."],
  ["/", "/"],
  ["\\", "\\"],
  ["[", "["],
  ["]", "]"],
  ["'", "'"],
  [";", ";"],
  ["`", "`"],
  ["-", "-"],
  ["=", "="],
]);

const APPLE_MODIFIER_GLYPHS = new Map([
  ["mod", "⌘"],
  ["ctrl", "⌃"],
  ["alt", "⌥"],
  ["shift", "⇧"],
]);

const PC_MODIFIER_GLYPHS = new Map([
  ["mod", "Ctrl"],
  ["ctrl", "Ctrl"],
  ["alt", "Alt"],
  ["shift", "Shift"],
]);

/**
 * A chord as the keycaps to render, one string per key: `["⌘", "⇧", "A"]` on
 * Apple, `["Ctrl", "Shift", "A"]` elsewhere.
 */
export function chordGlyphs(chord: Chord, apple: boolean): string[] {
  const modGlyphs = apple ? APPLE_MODIFIER_GLYPHS : PC_MODIFIER_GLYPHS;
  const out = chordModifiers(chord).map(
    (modifier) => modGlyphs.get(modifier) ?? modifier,
  );
  const key = chordKey(chord);
  out.push(
    KEY_GLYPHS.get(key) ??
      (key.length === 1
        ? key.toUpperCase()
        : /^f\d+$/.test(key)
          ? key.toUpperCase()
          : key.charAt(0).toUpperCase() + key.slice(1)),
  );
  return out;
}

/** A chord as one flat label, for search text and accessible names. */
export function chordLabel(chord: Chord, apple: boolean): string {
  return chordGlyphs(chord, apple).join(apple ? "" : "+");
}
