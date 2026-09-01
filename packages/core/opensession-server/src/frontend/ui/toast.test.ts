// The toast store, exercised without a DOM: firing, the visible cap, and the
// action a toast can carry. The action is worth pinning because some reversible
// receipts provide Undo even though archiving itself stays quiet.

import { beforeEach, describe, expect, test } from "bun:test";
import { undoLatestAction } from "../lib/undo";
import { activeToasts, dismissToast, toast } from "./toast";

beforeEach(() => {
  for (const t of [...activeToasts()]) dismissToast(t.id);
});

describe("toast", () => {
  test("fires and dismisses", () => {
    const id = toast("Archived");
    expect(activeToasts().map((t) => t.message)).toEqual(["Archived"]);
    dismissToast(id);
    expect(activeToasts()).toHaveLength(0);
  });

  test("leaves link-copy confirmation to the control or platform", () => {
    expect(toast("Link copied")).toBe(0);
    expect(toast("Preview link copied")).toBe(0);
    expect(toast("Pull request link copied")).toBe(0);
    expect(activeToasts()).toHaveLength(0);
  });

  test("infers the tone from common app feedback", () => {
    toast("Archived");
    toast("Provider removed");
    toast("Could not save that file");
    expect(activeToasts().map((t) => t.variant)).toEqual([
      "success",
      "success",
      "error",
    ]);
  });

  test("marks live status as ongoing until its owner dismisses it", () => {
    const id = toast("Restarting", { ongoing: true });
    expect(activeToasts()[0]).toMatchObject({ id, ongoing: true });
    dismissToast(id);
    expect(activeToasts()).toHaveLength(0);
  });

  test("carries an action for reversible feedback", () => {
    let undone = 0;
    toast("Item removed", {
      action: { label: "Undo", onClick: () => undone++ },
    });
    const t = activeToasts()[0];
    expect(t?.action?.label).toBe("Undo");
    t?.action?.onClick();
    expect(undone).toBe(1);
  });

  test("links a visible Undo action to the app-wide undo stack", () => {
    let undone = 0;
    toast("Item removed", {
      action: { label: "Undo", onClick: () => undone++ },
    });

    expect(undoLatestAction()).toBe(true);
    expect(undone).toBe(1);
    expect(activeToasts()).toHaveLength(0);
  });

  // A burst of receipts must not wallpaper the screen. Keep the newest ones.
  test("keeps only the newest three", () => {
    for (const n of [1, 2, 3, 4]) toast(`Removed item ${n}`);
    expect(activeToasts().map((t) => t.message)).toEqual([
      "Removed item 2",
      "Removed item 3",
      "Removed item 4",
    ]);
  });
});
