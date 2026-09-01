// The registry's own invariants. Two defaults on one chord would make the app
// fire two commands from one keystroke with no way to arbitrate — every
// handler owns its own listener, so there is no priority order to fall back
// on. That is worth a test rather than a careful reading.
//
// lib/shortcuts pulls in the ui-prefs factory, which touches localStorage,
// fetch and window at module load. There is no DOM preload in this repo, so
// the shims go in here, file-locally, before the import.

import { beforeAll, describe, expect, test } from "bun:test";

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

let mod: typeof import("./shortcuts");
let chordMod: typeof import("./shortcut-chord");
let apple = false;

/** An event carrying the platform's own command modifier, which is the whole
 *  point of spelling it `mod`: the same stored chord has to match ⌘ on a Mac
 *  and Ctrl everywhere else. */
function modEvent(init: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    isComposing: false,
    metaKey: apple,
    ctrlKey: !apple,
    altKey: false,
    shiftKey: false,
    key: "k",
    code: "KeyK",
    ...init,
  } as KeyboardEvent;
}

beforeAll(async () => {
  mod = await import("./shortcuts");
  chordMod = await import("./shortcut-chord");
  apple = (await import("./platform")).isApple;
});

describe("shortcut registry", () => {
  test("every command has a unique id", () => {
    const ids = mod.SHORTCUT_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("no two commands share a default chord", () => {
    const owner = new Map<string, string>();
    for (const command of mod.SHORTCUT_COMMANDS) {
      for (const chord of command.defaults) {
        const taken = owner.get(chord);
        expect(taken ? `${chord} taken by ${taken}` : chord).toBe(chord);
        owner.set(chord, command.id);
      }
    }
  });

  test("every default is canonical and bindable", () => {
    for (const command of mod.SHORTCUT_COMMANDS) {
      expect(command.defaults.length).toBeGreaterThan(0);
      for (const chord of command.defaults) {
        // Storing a non-canonical default would make it un-matchable: the
        // event side always produces canonical form.
        expect(chordMod.normalizeChord(chord, true)).toBe(chord);
        expect(chordMod.isBindableChord(chord)).toBe(true);
      }
    }
  });

  test("every command lands in a rendered group", () => {
    for (const command of mod.SHORTCUT_COMMANDS) {
      expect(mod.SHORTCUT_GROUPS).toContain(
        command.group as (typeof mod.SHORTCUT_GROUPS)[number],
      );
    }
  });

  test("copy states in sentence case, with no em dash", () => {
    for (const command of mod.SHORTCUT_COMMANDS) {
      expect(command.title).not.toContain("—");
      expect(command.description).not.toContain("—");
      // A description is one line, not a paragraph.
      expect(command.description.endsWith(".")).toBe(false);
    }
  });

  test("bindings fall back to the defaults with nothing stored", () => {
    expect(mod.shortcutBindings("command-menu")).toEqual(["mod+k"]);
    expect(mod.shortcutBindings("composer-attach")).toEqual(["mod+u"]);
    expect(mod.shortcutBindings("composer-dictate")).toEqual(["mod+d"]);
    expect(mod.shortcutBindings("workspace-next-unread")).toEqual([
      "alt+shift+arrowdown",
    ]);
    expect(mod.shortcutBindings("session-archive")).toEqual([
      "mod+e",
      "mod+shift+a",
    ]);
    expect(mod.isShortcutCustomized("command-menu")).toBe(false);
  });

  test("a rebind takes effect, and reset puts the default back", () => {
    mod.setShortcutBindings("desk", ["mod+shift+d"]);
    expect(mod.shortcutBindings("desk")).toEqual(["mod+shift+d"]);
    expect(mod.isShortcutCustomized("desk")).toBe(true);
    mod.resetShortcutBindings("desk");
    expect(mod.shortcutBindings("desk")).toEqual(["mod+j"]);
    expect(mod.isShortcutCustomized("desk")).toBe(false);
  });

  test("unassigning is its own state, distinct from untouched", () => {
    mod.setShortcutBindings("desk", []);
    expect(mod.shortcutBindings("desk")).toEqual([]);
    expect(mod.isShortcutCustomized("desk")).toBe(true);
    mod.resetShortcutBindings("desk");
  });

  test("conflicts report every command holding a chord", () => {
    expect(mod.commandsUsingChord("mod+k")).toEqual(["command-menu"]);
    expect(mod.commandsUsingChord("mod+shift+f9")).toEqual([]);
  });

  test("matching is exact on modifiers", () => {
    expect(mod.matchesShortcut(modEvent(), "command-menu")).toBe(true);
    // The hand-written conditions this replaced let stray modifiers through.
    expect(
      mod.matchesShortcut(modEvent({ altKey: true }), "command-menu"),
    ).toBe(false);
    expect(
      mod.matchesShortcut(modEvent({ shiftKey: true }), "command-menu"),
    ).toBe(false);
  });

  test("history shortcuts match the bracket keys", () => {
    expect(
      mod.matchesShortcut(
        modEvent({ key: "[", code: "BracketLeft" }),
        "history-back",
      ),
    ).toBe(true);
    expect(
      mod.matchesShortcut(
        modEvent({ key: "]", code: "BracketRight" }),
        "history-forward",
      ),
    ).toBe(true);
  });

  test("a rebound chord is what fires", () => {
    expect(
      mod.matchesShortcut(modEvent({ key: "y", code: "KeyY" }), "desk"),
    ).toBe(false);
    mod.setShortcutBindings("desk", ["mod+y"]);
    expect(
      mod.matchesShortcut(modEvent({ key: "y", code: "KeyY" }), "desk"),
    ).toBe(true);
    expect(
      mod.matchesShortcut(modEvent({ key: "j", code: "KeyJ" }), "desk"),
    ).toBe(false);
    mod.resetShortcutBindings("desk");
  });

  test("nothing matches while a chord is being recorded", () => {
    const e = modEvent();
    mod.setShortcutRecording(true);
    expect(mod.matchesShortcut(e, "command-menu")).toBe(false);
    mod.setShortcutRecording(false);
    expect(mod.matchesShortcut(e, "command-menu")).toBe(true);
  });

  // A newer client may store a command this build doesn't know. Dropping it
  // on the next write would destroy that device's binding, so it rides along
  // untouched through both a set and a reset-all.
  test("an id this build doesn't know survives a write", () => {
    store.set(
      "opensession-shortcuts",
      JSON.stringify({ "future-command": ["mod+shift+9"] }),
    );
    mod.setShortcutBindings("desk", ["mod+shift+d"]);
    expect(
      JSON.parse(store.get("opensession-shortcuts") ?? "{}"),
    ).toHaveProperty("future-command");
    mod.resetAllShortcuts();
    const after = JSON.parse(store.get("opensession-shortcuts") ?? "{}");
    expect(after).toHaveProperty("future-command");
    expect(after).not.toHaveProperty("desk");
    store.delete("opensession-shortcuts");
  });
});
