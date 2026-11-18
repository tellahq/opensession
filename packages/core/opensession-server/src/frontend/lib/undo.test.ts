import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearUndoAction,
  fieldOwnsUndo,
  hasUndoAction,
  registerUndoAction,
  undoLatestAction,
} from "./undo";

beforeEach(() => {
  while (undoLatestAction()) {
    // Empty the module-level stack between tests.
  }
});

describe("app-wide undo", () => {
  test("runs the newest action first", () => {
    const calls: string[] = [];
    registerUndoAction("first", () => calls.push("first"));
    registerUndoAction("second", () => calls.push("second"));

    expect(undoLatestAction()).toBe(true);
    expect(calls).toEqual(["second"]);
    expect(undoLatestAction()).toBe(true);
    expect(calls).toEqual(["second", "first"]);
  });

  test("replaces a stale callback for the same action", () => {
    const calls: string[] = [];
    const stale = registerUndoAction("merge", () => calls.push("stale"));
    registerUndoAction("merge", () => calls.push("current"));

    expect(clearUndoAction(stale)).toBe(false);
    expect(undoLatestAction()).toBe(true);
    expect(calls).toEqual(["current"]);
  });

  test("clears only the matching registration", () => {
    const handle = registerUndoAction("archive", () => undefined);
    expect(hasUndoAction()).toBe(true);
    expect(clearUndoAction(handle)).toBe(true);
    expect(hasUndoAction()).toBe(false);
  });
});

describe("fieldOwnsUndo", () => {
  test("leaves Command-Z to the archive when the field was not edited since", () => {
    expect(
      fieldOwnsUndo({ claimed: false, lastFieldEditAt: 100, actionAt: 200 }),
    ).toBe(false);
  });

  test("keeps Command-Z for text typed after the archive", () => {
    expect(
      fieldOwnsUndo({ claimed: false, lastFieldEditAt: 300, actionAt: 200 }),
    ).toBe(true);
  });

  test("keeps Command-Z when the field's own handler claimed it", () => {
    expect(
      fieldOwnsUndo({ claimed: true, lastFieldEditAt: 100, actionAt: 200 }),
    ).toBe(true);
  });
});
