/**
 * The keyboard shortcut registry: every app-wide command, its default chords,
 * and the per-user overrides layered on top.
 *
 * A command belongs here when its listener is on `window` and it means the
 * same thing wherever you are. Structural keys stay hard-coded where they
 * live: Escape closes what's open, arrows move within a deck or a lightbox,
 * Enter commits a rename, and the composer's send key has its own preference
 * (Settings → Preferences) because what's configurable there is the behavior,
 * not the chord. Those are listed on the shortcuts page as reference rows, so
 * the page is still the whole picture, but they are not rebindable.
 *
 * Matching is exact on modifiers. The hand-written conditions this replaced
 * were inconsistent about it (⌘⇧C used to fire with Option held too), and once
 * a user can bind ⌘⌥⇧C to something else, looseness is a collision.
 *
 * Call sites keep their own listeners and guards and only swap their inline
 * condition for `matchesShortcut(e, id)`. That is deliberate: the guards are
 * load-bearing and site-specific (the `defaultPrevented` handshake between the
 * sidebar's archive and the viewer's fallback, the tab-split `focused` flag,
 * the composer-textarea exemption), and a central dispatcher would have to
 * re-invent all of it. It also could not see the chords that never reach
 * window, like the ones Base UI stops inside a dialog.
 */

import { z } from "zod";
import { isApple, isChromium } from "./platform";
import {
  chordGlyphs,
  chordLabel,
  eventChord,
  isBindableChord,
  normalizeChord,
  type Chord,
} from "./shortcut-chord";
import * as UserPref from "./user-pref";

export type { Chord } from "./shortcut-chord";

export type ShortcutId =
  | "command-menu"
  | "desk"
  | "history-back"
  | "history-forward"
  | "sidebar-toggle"
  | "sidebar-next"
  | "sidebar-prev"
  | "workspace-next-unread"
  | "tab-next"
  | "tab-prev"
  | "shortcuts-help"
  | "session-new"
  | "session-new-sibling"
  | "run-stop"
  | "session-close"
  | "session-archive"
  | "workspace-archive"
  | "session-reopen"
  | "session-pin"
  | "session-copy-link"
  | "session-copy-transcript"
  | "composer-attach"
  | "composer-dictate"
  | "composer-focus"
  | "transcript-up"
  | "transcript-down"
  | "effort-up"
  | "effort-down"
  | "open-pr"
  | "pr-copy-link"
  | "open-preview";

export interface ShortcutCommand {
  id: ShortcutId;
  title: string;
  description: string;
  group: string;
  defaults: Chord[];
  /** Advertise a different chord first where the browser eats the primary. */
  preferAliasOnChromium?: boolean;
}

/** Groups in page order. */
export const SHORTCUT_GROUPS = [
  "Navigation",
  "Sessions",
  "Composer",
  "Transcript",
  "Links",
] as const;

export const SHORTCUT_COMMANDS: ShortcutCommand[] = [
  {
    id: "command-menu",
    title: "Command menu",
    description: "Search sessions and jump anywhere",
    group: "Navigation",
    defaults: ["mod+k"],
  },
  {
    id: "desk",
    title: "Desk",
    description: "Open the desk overlay",
    group: "Navigation",
    defaults: ["mod+j"],
  },
  {
    id: "history-back",
    title: "Go back",
    description: "Return to the previous page",
    group: "Navigation",
    defaults: ["mod+["],
  },
  {
    id: "history-forward",
    title: "Go forward",
    description: "Return to the next page",
    group: "Navigation",
    defaults: ["mod+]"],
  },
  {
    id: "sidebar-toggle",
    title: "Toggle sidebar",
    description: "Show or hide the session list",
    group: "Navigation",
    defaults: ["mod+b"],
  },
  {
    id: "sidebar-next",
    title: "Next in sidebar",
    description: "Open the session below the current one",
    group: "Navigation",
    defaults: ["mod+arrowdown"],
  },
  {
    id: "sidebar-prev",
    title: "Previous in sidebar",
    description: "Open the session above the current one",
    group: "Navigation",
    defaults: ["mod+arrowup"],
  },
  {
    id: "workspace-next-unread",
    title: "Next chat",
    description: "Open the next chat, prioritizing work that needs attention",
    group: "Navigation",
    defaults: ["alt+shift+arrowdown"],
  },
  // The tab strip's horizontal answer to the sidebar's ⌘↑/⌘↓. ⌘⌥ arrows are
  // the neighbouring family (⌘⌥↑/↓ already step the reasoning effort), which
  // is why the pair reads as one set — but Chromium takes ⌘⌥→/← for its own
  // tab strip before the page sees them, so both carry a ⌃⌥ alias and
  // advertise it there. Off Apple the two spell the same keycaps, since
  // `ctrl` folds into `mod` on a PC.
  {
    id: "tab-next",
    title: "Next tab",
    description: "Move to the tab on the right in this workspace",
    group: "Navigation",
    defaults: ["mod+alt+arrowright", "ctrl+alt+arrowright"],
    preferAliasOnChromium: true,
  },
  {
    id: "tab-prev",
    title: "Previous tab",
    description: "Move to the tab on the left in this workspace",
    group: "Navigation",
    defaults: ["mod+alt+arrowleft", "ctrl+alt+arrowleft"],
    preferAliasOnChromium: true,
  },
  {
    id: "shortcuts-help",
    title: "Shortcut list",
    description: "Show every shortcut without leaving what you are doing",
    group: "Navigation",
    defaults: ["mod+/"],
  },
  {
    id: "session-new",
    title: "New session",
    description: "Start a session in a new workspace",
    group: "Sessions",
    defaults: ["mod+s"],
  },
  {
    id: "session-new-sibling",
    title: "New session here",
    description: "Start a session in the workspace you are already in",
    group: "Sessions",
    defaults: ["mod+alt+n"],
  },
  // Escape already asks this, but only with the composer focused, which is
  // exactly where you are not when you have been reading the transcript. The
  // two land on the same confirmation.
  {
    id: "run-stop",
    title: "Stop the run",
    description: "Ask to interrupt the turn that is running",
    group: "Sessions",
    defaults: ["mod+."],
  },
  {
    id: "session-close",
    title: "Close session",
    description: "Archive the open session and close its tab",
    group: "Sessions",
    defaults: ["mod+w"],
  },
  {
    id: "session-archive",
    title: "Archive session",
    description: "Archive the open session and move to the next one",
    group: "Sessions",
    defaults: ["mod+e", "mod+shift+a"],
    preferAliasOnChromium: true,
  },
  {
    id: "workspace-archive",
    title: "Archive workspace",
    description: "Archive every session in the active workspace",
    group: "Sessions",
    defaults: ["mod+alt+shift+a"],
  },
  {
    id: "session-reopen",
    title: "Reopen archived",
    description: "Bring back the session or workspace you just archived",
    group: "Sessions",
    defaults: ["mod+z", "mod+shift+t"],
  },
  {
    id: "session-pin",
    title: "Pin session",
    description: "Pin or unpin the open session",
    group: "Sessions",
    defaults: ["mod+p"],
  },
  {
    id: "session-copy-link",
    title: "Copy link",
    description:
      "Copy the Open Session link to the open session, workspace, or review",
    group: "Sessions",
    defaults: ["mod+shift+c"],
  },
  {
    id: "session-copy-transcript",
    title: "Copy transcript",
    description: "Copy the session transcript in its concise form",
    group: "Sessions",
    defaults: ["mod+alt+c"],
  },
  {
    id: "composer-attach",
    title: "Attach files",
    description: "Choose files to attach to the open session",
    group: "Composer",
    defaults: ["mod+u"],
  },
  {
    id: "composer-dictate",
    title: "Start dictation",
    description: "Record a message in the active composer",
    group: "Composer",
    defaults: ["mod+d"],
  },
  {
    id: "composer-focus",
    title: "Focus composer",
    description: "Move keyboard focus to the composer",
    group: "Composer",
    defaults: ["ctrl+r"],
  },
  {
    id: "transcript-up",
    title: "Scroll transcript up",
    description: "Page the transcript up without leaving the composer",
    group: "Transcript",
    defaults: ["ctrl+shift+arrowup"],
  },
  {
    id: "transcript-down",
    title: "Scroll transcript down",
    description: "Page the transcript down, resuming follow at the live edge",
    group: "Transcript",
    defaults: ["ctrl+shift+arrowdown"],
  },
  {
    id: "effort-up",
    title: "More reasoning",
    description: "Step the reasoning effort up a level",
    group: "Transcript",
    defaults: ["mod+alt+arrowup"],
  },
  {
    id: "effort-down",
    title: "Less reasoning",
    description: "Step the reasoning effort down a level",
    group: "Transcript",
    defaults: ["mod+alt+arrowdown"],
  },
  {
    id: "open-pr",
    title: "Open pull request",
    description: "Open the session's pull request on GitHub",
    group: "Links",
    defaults: ["mod+g"],
  },
  // ⌘⇧G is to ⌘G what ⌘⇧C is to the session: the same target, copied
  // rather than opened. It hands out the GitHub URL, where ⌘⇧C on a review
  // hands out the Open Session one.
  {
    id: "pr-copy-link",
    title: "Copy pull request link",
    description: "Copy the GitHub link to the session's pull request",
    group: "Links",
    defaults: ["mod+shift+g"],
  },
  {
    id: "open-preview",
    title: "Open preview",
    description: "Open the pull request's preview environment",
    group: "Links",
    defaults: ["mod+o"],
  },
];

const COMMANDS_BY_ID = new Map(SHORTCUT_COMMANDS.map((c) => [c.id, c]));

export function shortcutCommand(id: ShortcutId): ShortcutCommand | undefined {
  return COMMANDS_BY_ID.get(id);
}

// ── Reference rows ─────────────────────────────────────────────────────────
//
// Keys the page lists so it reads as the whole picture, but which are part of
// the interface rather than a command anyone should rebind.

export interface ShortcutReference {
  title: string;
  description: string;
  keys: string[];
}

export const SHORTCUT_REFERENCE: ShortcutReference[] = [
  {
    title: "Close what's open",
    description: "Dismiss a menu, dialog, palette, or panel",
    keys: ["Esc"],
  },
  {
    title: "Send a message",
    description: "Follows your send key setting in Preferences",
    keys: isApple ? ["↵"] : ["Enter"],
  },
  {
    title: "Create options",
    description: "Step through the create actions in the new session dialog",
    keys: isApple ? ["⌘", "⌥", "↑"] : ["Ctrl", "Alt", "↑"],
  },
  {
    title: "Answer a question",
    description: "Pick a lettered option on a question card",
    keys: ["A", "B", "C"],
  },
  {
    title: "Comment on an image",
    description: "Start selecting a region in an open image preview",
    keys: ["C"],
  },
  // A chord family, not a command: the digit varies, and matching is exact on
  // the whole chord, so there is nothing here one binding could stand for.
  // Rebinding the modifier alone is not something the registry can express,
  // so this stays hard-coded in App and is listed rather than offered.
  {
    title: "Jump to a tab",
    description: "Open the first nine tabs in the workspace by number",
    keys: isApple ? ["⌥", "1"] : ["Alt", "1"],
  },
  {
    title: "Sort a card in Catch up",
    description: "Archive it, mark it read, or keep it for later",
    keys: ["←", "→", "↑"],
  },
];

// ── Per-user overrides ─────────────────────────────────────────────────────
//
// Only overrides are stored, so a changed default reaches everyone who never
// touched that command. The pref's value is the canonical JSON *text* rather
// than a parsed object: makeUserPref compares values by identity to decide
// whether to write, whether a hydrate changed anything, and whether to push a
// local value up, and an object default would fail all three (a fresh parse is
// never `===` the default). Keys are sorted and whitespace stripped so equal
// maps compare equal as strings.
//
// An absent id means the default. An empty array means the user deliberately
// unassigned it, which is a different state: the row offers Reset for it.

type OverrideMap = Record<string, Chord[]>;

function canonicalJson(map: OverrideMap): string {
  const sorted: OverrideMap = {};
  const entries = Object.entries(map).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const [key, chords] of entries) sorted[key] = chords;
  return JSON.stringify(sorted);
}

const overrideRecordSchema = z.record(z.string(), z.json());
const overrideEntrySchema = z.string();

function parseOverrides(raw: string): OverrideMap | null {
  let result;
  try {
    result = overrideRecordSchema.safeParse(JSON.parse(raw));
  } catch {
    return null;
  }
  if (!result.success) return null;

  const out: OverrideMap = {};
  for (const [id, value] of Object.entries(result.data)) {
    if (!Array.isArray(value)) continue;
    const chords: Chord[] = [];
    for (const entry of value) {
      const parsedEntry = overrideEntrySchema.safeParse(entry);
      if (!parsedEntry.success) continue;
      const chord = normalizeChord(parsedEntry.data, isApple);
      if (chord && !chords.includes(chord)) chords.push(chord);
    }
    out[id] = chords;
  }
  return out;
}

/**
 * Parse and re-canonicalize stored overrides. Unknown command ids survive the
 * round trip on purpose: an older client must not strip bindings a newer one
 * wrote, or opening settings on the old client would destroy them.
 */
function decodeOverrides(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parsed = parseOverrides(raw);
  return parsed ? canonicalJson(parsed) : null;
}

const pref = UserPref.makeUserPref<string>({
  localKey: "opensession-shortcuts",
  prefKey: "shortcuts",
  changeEvent: "opensession-shortcuts-changed",
  defaultValue: "{}",
  decode: decodeOverrides,
  encode: (v) => v,
});

export const onShortcutsChanged = pref.onChanged;

// Parsing on every keydown would be wasteful, so cache against the raw text.
let cachedRaw: string | null = null;
let cachedMap: OverrideMap = {};

function overrides(): OverrideMap {
  const raw = pref.get();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedMap = parseOverrides(raw) ?? {};
  }
  return cachedMap;
}

/** The chords a command answers to right now. Empty means unassigned. */
export function shortcutBindings(id: ShortcutId): Chord[] {
  const custom = overrides()[id];
  if (custom) return custom;
  return shortcutCommand(id)?.defaults ?? [];
}

/** True when the user has set this command's bindings themselves. */
export function isShortcutCustomized(id: ShortcutId): boolean {
  return Object.hasOwn(overrides(), id);
}

/** Every command currently bound to a chord, for conflict reporting. */
export function commandsUsingChord(chord: Chord): ShortcutId[] {
  return SHORTCUT_COMMANDS.filter((c) =>
    shortcutBindings(c.id).includes(chord),
  ).map((c) => c.id);
}

/**
 * Replace a command's bindings. Pass an empty array to unassign it. Writes
 * every change through one canonical string so a set and a reset both
 * propagate to the user's other devices.
 */
export function setShortcutBindings(id: ShortcutId, chords: Chord[]): void {
  const next = { ...overrides() };
  const seen: Chord[] = [];
  for (const raw of chords) {
    const chord = normalizeChord(raw, isApple);
    if (chord && !seen.includes(chord)) seen.push(chord);
  }
  next[id] = seen;
  pref.set(canonicalJson(next));
}

/** Drop the override, returning the command to its default chords. */
export function resetShortcutBindings(id: ShortcutId): void {
  const next = { ...overrides() };
  if (!Object.hasOwn(next, id)) return;
  delete next[id];
  pref.set(canonicalJson(next));
}

/** Drop every override at once. */
export function resetAllShortcuts(): void {
  const next: OverrideMap = {};
  // Unknown ids belong to a newer client; leave them be.
  for (const [id, chords] of Object.entries(overrides())) {
    if (!SHORTCUT_COMMANDS.some((command) => command.id === id))
      next[id] = chords;
  }
  pref.set(canonicalJson(next));
}

// ── Matching ───────────────────────────────────────────────────────────────

// Raised while the settings page is capturing a chord. Every match reports
// false then, so a keystroke aimed at the recorder cannot also run the command
// it is about to be bound to. The recorder additionally swallows the event in
// the capture phase; this flag is the backstop for any listener that reads the
// event some other way.
let recording = false;

export function setShortcutRecording(active: boolean): void {
  recording = active;
}

export function isShortcutRecording(): boolean {
  return recording;
}

/**
 * True when this event is the given command's chord.
 *
 * Deliberately does not call `preventDefault`: some call sites decide whether
 * to take the chord only after matching it (⌘⇧C yields to a real text
 * selection), so consuming the event is theirs to do.
 */
export function matchesShortcut(
  e: KeyboardEvent | React.KeyboardEvent,
  id: ShortcutId,
): boolean {
  if (recording) return false;
  const native = "nativeEvent" in e ? e.nativeEvent : e;
  const chord = eventChord(native, isApple);
  if (!chord) return false;
  return shortcutBindings(id).includes(chord);
}

/** The chord this event spells, for the settings page's recorder. */
export function chordFromEvent(e: KeyboardEvent): Chord | null {
  return eventChord(e, isApple);
}

export function normalize(chord: string): Chord | null {
  return normalizeChord(chord, isApple);
}

export function isBindable(chord: Chord): boolean {
  return isBindableChord(chord);
}

// ── Display ────────────────────────────────────────────────────────────────

/**
 * The keycaps to render for a command, as one array per binding.
 *
 * Chromium reserves a few chords (⌘E among them) before the page sees them, so
 * a command that carries a working alias advertises that one first. This only
 * reorders what a command already answers to; it never invents a chord.
 */
export function shortcutKeys(id: ShortcutId): string[][] {
  const bindings = shortcutBindings(id);
  const command = shortcutCommand(id);
  const first = bindings[0];
  const ordered =
    command?.preferAliasOnChromium &&
    isChromium &&
    !isShortcutCustomized(id) &&
    bindings.length > 1 &&
    first
      ? [...bindings.slice(1), first]
      : bindings;
  return ordered.map((chord) => chordGlyphs(chord, isApple));
}

/** The keycaps for a command's primary binding, or null when unassigned. */
export function shortcutPrimaryKeys(id: ShortcutId): string[] | null {
  return shortcutKeys(id)[0] ?? null;
}

/** A command's primary binding as one flat label, for tooltips and titles. */
export function shortcutLabel(id: ShortcutId): string | null {
  const keys = shortcutPrimaryKeys(id);
  if (!keys) return null;
  return keys.join(isApple ? "" : "+");
}

export function glyphsFor(chord: Chord): string[] {
  return chordGlyphs(chord, isApple);
}

export function labelFor(chord: Chord): string {
  return chordLabel(chord, isApple);
}
