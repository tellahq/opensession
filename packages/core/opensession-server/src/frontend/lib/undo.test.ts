import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearUndoAction,
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
