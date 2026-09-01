import { describe, expect, test } from "bun:test";
import { restoreSelectFocusAfterClose } from "./select-focus";

describe("restoreSelectFocusAfterClose", () => {
  test("does not return focus to the trigger after an outside press", () => {
    expect(restoreSelectFocusAfterClose("outside-press")).toBe(false);
    expect(restoreSelectFocusAfterClose("focus-out")).toBe(false);
  });

  test("keeps the trigger in the keyboard flow for other close reasons", () => {
    expect(restoreSelectFocusAfterClose("escape-key")).toBe(true);
    expect(restoreSelectFocusAfterClose("item-press")).toBe(true);
  });
});
