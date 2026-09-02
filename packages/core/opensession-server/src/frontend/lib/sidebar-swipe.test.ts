// The two focus rules the sidebar's chords apply. They differ on purpose: the
// archive chords take the composer, the caret chords hand it back as soon as
// there is a draft in it. That difference is exactly the kind of thing a later
// edit flattens into one blanket rule, so it is pinned here.
//
// There is no DOM preload in this repo (see lib/shortcuts.test.ts), and both
// predicates only ever ask a target for its editable ancestor, that
// ancestor's classes and its value, so the elements are hand-rolled.

import { describe, expect, test } from "bun:test";
import {
  editableOwnsCaretChord,
  editableSwallowsArchiveChord,
  swipeActionForOffset,
  swipeCommitOffset,
} from "./sidebar-swipe";

function target(
  editable: { composer?: boolean; value?: string } | null,
): EventTarget {
  const el = editable
    ? {
        classList: {
          contains: (name: string) =>
            name === "composer-textarea" && !!editable.composer,
        },
        value: editable.value ?? "",
      }
    : null;
  const eventTarget = new EventTarget();
  Object.defineProperty(eventTarget, "closest", { value: () => el });
  return eventTarget;
}

const nothing = target(null);
const renameField = target({ value: "" });
const emptyComposer = target({ composer: true, value: "" });
const draftComposer = target({ composer: true, value: "half a prompt" });

describe("mobile sidebar swipe", () => {
  test("left archives and right pins", () => {
    expect(swipeActionForOffset(-1)).toBe("archive");
    expect(swipeActionForOffset(1)).toBe("star");
    expect(swipeActionForOffset(0)).toBeNull();
    expect(swipeCommitOffset("archive", 320)).toBe(-320);
    expect(swipeCommitOffset("star", 320)).toBe(320);
  });
});

describe("editableOwnsCaretChord", () => {
  test("a transcript or a row leaves ⌘↑/⌘↓ to the sidebar", () => {
    expect(editableOwnsCaretChord(nothing)).toBe(false);
    expect(editableOwnsCaretChord(null)).toBe(false);
  });

  test("a draft in the composer keeps its caret moves", () => {
    expect(editableOwnsCaretChord(draftComposer)).toBe(true);
  });

  // Any character is somewhere for the caret to go, whitespace included.
  test("a draft of only spaces still counts as text", () => {
    expect(editableOwnsCaretChord(target({ composer: true, value: " " }))).toBe(
      true,
    );
  });

  // The composer is where focus tends to sit, so claiming the chord here too
  // would leave it dead in the place people press it from. With nothing to
  // move through, the caret loses nothing by giving it up.
  test("an empty composer leaves cycling reachable", () => {
    expect(editableOwnsCaretChord(emptyComposer)).toBe(false);
  });

  test("every other field claims them, empty or not", () => {
    expect(editableOwnsCaretChord(renameField)).toBe(true);
    expect(editableOwnsCaretChord(target({ value: "old name" }))).toBe(true);
  });
});

describe("editableSwallowsArchiveChord", () => {
  test("the composer stays exempt, draft or not", () => {
    expect(editableSwallowsArchiveChord(emptyComposer)).toBe(false);
    expect(editableSwallowsArchiveChord(draftComposer)).toBe(false);
  });

  test("rename fields and search boxes keep the guard", () => {
    expect(editableSwallowsArchiveChord(renameField)).toBe(true);
  });

  test("nothing editable in focus leaves the chord alone", () => {
    expect(editableSwallowsArchiveChord(nothing)).toBe(false);
  });
});
