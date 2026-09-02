import { describe, expect, test } from "bun:test";
import {
  chordGlyphs,
  chordLabel,
  eventChord,
  isBindableChord,
  normalizeChord,
} from "./shortcut-chord";

class TestKeyboardEvent extends Event implements KeyboardEvent {
  readonly altKey: boolean;
  readonly charCode = 0;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly detail = 0;
  readonly isComposing: boolean;
  readonly key: string;
  readonly keyCode = 0;
  readonly location = 0;
  readonly metaKey: boolean;
  readonly repeat = false;
  readonly shiftKey: boolean;
  readonly view = null;
  readonly which = 0;
  readonly DOM_KEY_LOCATION_STANDARD = 0;
  readonly DOM_KEY_LOCATION_LEFT = 1;
  readonly DOM_KEY_LOCATION_RIGHT = 2;
  readonly DOM_KEY_LOCATION_NUMPAD = 3;

  constructor(init: Partial<KeyboardEvent> & { key: string }) {
    super("keydown");
    this.altKey = init.altKey ?? false;
    this.code = init.code ?? "";
    this.ctrlKey = init.ctrlKey ?? false;
    this.isComposing = init.isComposing ?? false;
    this.key = init.key;
    this.metaKey = init.metaKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
  }

  getModifierState(): boolean {
    return false;
  }

  initKeyboardEvent(): void {}
  initUIEvent(): void {}
}

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return new TestKeyboardEvent(init);
}

describe("eventChord", () => {
  test("spells the platform command modifier as mod", () => {
    expect(
      eventChord(key({ key: "k", code: "KeyK", metaKey: true }), true),
    ).toBe("mod+k");
    expect(
      eventChord(key({ key: "k", code: "KeyK", ctrlKey: true }), false),
    ).toBe("mod+k");
  });

  test("keeps Control as its own modifier on Apple only", () => {
    expect(
      eventChord(key({ key: "r", code: "KeyR", ctrlKey: true }), true),
    ).toBe("ctrl+r");
    expect(
      eventChord(key({ key: "r", code: "KeyR", ctrlKey: true }), false),
    ).toBe("mod+r");
  });

  test("orders modifiers canonically regardless of which are held", () => {
    expect(
      eventChord(
        key({
          key: "a",
          code: "KeyA",
          metaKey: true,
          altKey: true,
          shiftKey: true,
        }),
        true,
      ),
    ).toBe("mod+alt+shift+a");
  });

  test("reads the physical key when Option rewrites e.key", () => {
    // macOS reports ⌥C as "ç"; the chord must still be the C key.
    expect(
      eventChord(
        key({ key: "ç", code: "KeyC", metaKey: true, altKey: true }),
        true,
      ),
    ).toBe("mod+alt+c");
  });

  test("reads the physical key on a non-Latin layout", () => {
    expect(
      eventChord(key({ key: "к", code: "KeyK", metaKey: true }), true),
    ).toBe("mod+k");
  });

  test("reads the digit rather than the punctuation Shift types", () => {
    expect(
      eventChord(
        key({ key: "!", code: "Digit1", metaKey: true, shiftKey: true }),
        true,
      ),
    ).toBe("mod+shift+1");
  });

  test("names arrows and space", () => {
    expect(
      eventChord(
        key({ key: "ArrowUp", code: "ArrowUp", metaKey: true, altKey: true }),
        true,
      ),
    ).toBe("mod+alt+arrowup");
    expect(
      eventChord(key({ key: " ", code: "Space", metaKey: true }), true),
    ).toBe("mod+space");
  });

  test("has no chord for a bare modifier or a composition", () => {
    expect(eventChord(key({ key: "Meta", metaKey: true }), true)).toBeNull();
    expect(eventChord(key({ key: "Shift", shiftKey: true }), true)).toBeNull();
    expect(
      eventChord(
        key({ key: "a", code: "KeyA", metaKey: true, isComposing: true }),
        true,
      ),
    ).toBeNull();
  });
});

describe("normalizeChord", () => {
  test("orders and lowercases", () => {
    expect(normalizeChord("Shift+Mod+A", true)).toBe("mod+shift+a");
  });

  test("reads meta and cmd as mod", () => {
    expect(normalizeChord("meta+k", true)).toBe("mod+k");
    expect(normalizeChord("Cmd+K", true)).toBe("mod+k");
  });

  test("folds ctrl into mod off Apple so one chord has one spelling", () => {
    expect(normalizeChord("ctrl+r", false)).toBe("mod+r");
    expect(normalizeChord("ctrl+r", true)).toBe("ctrl+r");
  });

  test("rejects a chord with no key or with two", () => {
    expect(normalizeChord("mod+shift", true)).toBeNull();
    expect(normalizeChord("mod+a+b", true)).toBeNull();
    expect(normalizeChord("", true)).toBeNull();
  });
});

describe("isBindableChord", () => {
  test("requires a modifier that isn't just Shift", () => {
    expect(isBindableChord("a")).toBe(false);
    expect(isBindableChord("shift+a")).toBe(false);
    expect(isBindableChord("mod+a")).toBe(true);
    expect(isBindableChord("alt+a")).toBe(true);
    expect(isBindableChord("ctrl+shift+arrowup")).toBe(true);
  });

  test("allows a bare function key, which nothing types", () => {
    expect(isBindableChord("f5")).toBe(true);
    expect(isBindableChord("f12")).toBe(true);
  });
});

describe("chordGlyphs", () => {
  test("draws Apple modifier glyphs", () => {
    expect(chordGlyphs("mod+shift+a", true)).toEqual(["⌘", "⇧", "A"]);
    expect(chordGlyphs("mod+alt+arrowup", true)).toEqual(["⌘", "⌥", "↑"]);
    expect(chordGlyphs("ctrl+r", true)).toEqual(["⌃", "R"]);
  });

  test("spells modifiers out elsewhere", () => {
    expect(chordGlyphs("mod+shift+a", false)).toEqual(["Ctrl", "Shift", "A"]);
  });

  test("labels join per platform convention", () => {
    expect(chordLabel("mod+shift+a", true)).toBe("⌘⇧A");
    expect(chordLabel("mod+shift+a", false)).toBe("Ctrl+Shift+A");
  });
});
