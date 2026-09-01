// The cheat sheet is only worth anything if it is the WHOLE picture, so what
// is asserted here is coverage rather than markup: every registry command and
// every reference row reaches the card, and the caps it draws are the ones the
// keyboard answers to right now.
//
// lib/shortcuts reaches the ui-prefs factory, which touches localStorage,
// fetch and window at module load, and there is no DOM preload in this repo —
// so the shims go here, file-locally, and the imports are dynamic to land
// after them (a static import would hoist above the shims).

import { beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
  window: {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  },
  Event: class {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  },
  fetch: () => Promise.reject(new Error("offline in tests")),
});

let sheet: typeof import("./ShortcutCheatSheet");
let mod: typeof import("../lib/shortcuts");
let chordMod: typeof import("../lib/shortcut-chord");

beforeAll(async () => {
  sheet = await import("./ShortcutCheatSheet");
  mod = await import("../lib/shortcuts");
  chordMod = await import("../lib/shortcut-chord");
});

describe("shortcut cheat sheet", () => {
  test("nothing renders while it is closed", () => {
    const html = renderToStaticMarkup(
      <sheet.ShortcutCheatSheet open={false} onOpenChange={() => {}} />,
    );
    expect(html).toBe("");
  });

  test("every command and every group reaches the card", () => {
    const html = renderToStaticMarkup(<sheet.ShortcutCheatSheetBody />);
    for (const command of mod.SHORTCUT_COMMANDS) {
      expect(html).toContain(command.title);
    }
    for (const group of mod.SHORTCUT_GROUPS) {
      expect(html).toContain(`>${group}</h3>`);
    }
  });

  test("the keys that are part of the interface are listed too", () => {
    // React escapes the apostrophe in "Close what's open", so compare
    // against text rather than against the markup as written.
    const html = renderToStaticMarkup(<sheet.ShortcutCheatSheetBody />).replace(
      /&#x27;/g,
      "'",
    );
    expect(html).toContain(">Always on</h3>");
    for (const entry of mod.SHORTCUT_REFERENCE) {
      expect(html).toContain(entry.title);
    }
  });

  test("a rebind is what the card draws, not the shipped default", () => {
    mod.setShortcutBindings("desk", ["mod+shift+f7"]);
    const html = renderToStaticMarkup(<sheet.ShortcutCheatSheetBody />);
    // The glyphs, not the stored chord: this is the reader's keyboard.
    for (const cap of mod.shortcutKeys("desk")[0] ?? []) {
      expect(html).toContain(`>${cap}</kbd>`);
    }
    expect(html).toContain("F7");
    mod.resetShortcutBindings("desk");
  });

  test("an unassigned command still holds its row", () => {
    mod.setShortcutBindings("desk", []);
    const html = renderToStaticMarkup(<sheet.ShortcutCheatSheetBody />);
    expect(html).toContain("Desk");
    expect(html).toContain("Not set");
    mod.resetShortcutBindings("desk");
  });
});

// The batch-E additions, held to the same invariants the registry's own test
// holds every other command to. They live here rather than in shortcuts.test
// so two sessions editing the registry don't collide in one file.
describe("cheat sheet, tab and stop commands", () => {
  const ADDED = ["shortcuts-help", "tab-next", "tab-prev", "run-stop"] as const;

  test("each one is registered, grouped, and canonical", () => {
    for (const id of ADDED) {
      const command = mod.shortcutCommand(id);
      expect(command?.id).toBe(id);
      expect(mod.SHORTCUT_GROUPS).toContain(
        command!.group as (typeof mod.SHORTCUT_GROUPS)[number],
      );
      expect(command!.defaults.length).toBeGreaterThan(0);
      for (const chord of command!.defaults) {
        // A non-canonical default is un-matchable: the event side only
        // ever produces canonical form.
        expect(chordMod.normalizeChord(chord, true)).toBe(chord);
        expect(chordMod.isBindableChord(chord)).toBe(true);
      }
    }
  });

  test("none of them takes a chord another command already answers to", () => {
    for (const id of ADDED) {
      for (const chord of mod.shortcutCommand(id)!.defaults) {
        expect(mod.commandsUsingChord(chord)).toEqual([id]);
      }
    }
  });

  test("the tab pair carries a working alias for Chromium", () => {
    // ⌘⌥→/← are Chromium's own tab chords, so the page never sees them
    // there. Both commands answer to a ⌃⌥ spelling as well, and that is
    // what shortcutKeys advertises on Chromium.
    for (const id of ["tab-next", "tab-prev"] as const) {
      const command = mod.shortcutCommand(id)!;
      expect(command.preferAliasOnChromium).toBe(true);
      expect(command.defaults.length).toBeGreaterThan(1);
      expect(command.defaults[0]).toContain("mod+alt+");
      expect(command.defaults[1]).toContain("ctrl+alt+");
    }
  });

  test("the digit family is a reference row, not a rebindable command", () => {
    const row = mod.SHORTCUT_REFERENCE.find((r) => r.title === "Jump to a tab");
    expect(row).toBeTruthy();
    expect(row!.keys.length).toBe(2);
    // Nine chords cannot be one binding, so no command claims them.
    expect(mod.commandsUsingChord("alt+1")).toEqual([]);
  });

  test("the deck's arrows are listed so the page stays the whole picture", () => {
    const row = mod.SHORTCUT_REFERENCE.find((r) =>
      r.title.includes("Catch up"),
    );
    expect(row?.keys).toEqual(["←", "→", "↑"]);
  });

  test("copy states in sentence case, with no em dash", () => {
    for (const id of ADDED) {
      const command = mod.shortcutCommand(id)!;
      expect(command.title).not.toContain("—");
      expect(command.description).not.toContain("—");
      expect(command.description.endsWith(".")).toBe(false);
    }
  });
});
