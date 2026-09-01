import { describe, expect, test } from "bun:test";
import {
  shippedChangeOutcome,
  suggestedShippedChangeMessage,
} from "./shipped-change-copy";

describe("suggestedShippedChangeMessage", () => {
  test("turns an imperative PR title into a short team update", () => {
    expect(suggestedShippedChangeMessage("Adopt the new toggle style")).toBe(
      "The new toggle style is now updated.",
    );
  });

  test("keeps a title that already reads as an outcome", () => {
    expect(suggestedShippedChangeMessage("Toggles now match the design")).toBe(
      "Toggles now match the design.",
    );
  });

  test("turns a visibility title into an outcome", () => {
    expect(
      suggestedShippedChangeMessage("Show background names via tooltips"),
    ).toBe("Background names are now visible via tooltips.");
  });

  test("turns a naming title into a product outcome", () => {
    expect(
      suggestedShippedChangeMessage("Name built-in video backgrounds"),
    ).toBe("Built-in video backgrounds now have names.");
  });

  test("keeps an unfamiliar title declarative and editable", () => {
    expect(suggestedShippedChangeMessage("Toggle polish")).toBe(
      "Toggle polish is now available.",
    );
  });

  test("prefers the first outcome from a walkthrough summary", () => {
    expect(
      suggestedShippedChangeMessage(
        "Update backgrounds",
        "Backgrounds now have names that are visible via tooltips.\n\nVerified on mobile.",
      ),
    ).toBe("Backgrounds now have names that are visible via tooltips.");
    expect(
      shippedChangeOutcome(
        "Deployment is live — Background names now appear on hover.",
      ),
    ).toBe("Background names now appear on hover.");
  });

  test("uses an implementation summary to name the concrete outcome", () => {
    expect(
      suggestedShippedChangeMessage(
        "Name built-in video backgrounds",
        "Updated all 40 to their real macOS release names and variants, including:\n\n- Mac Tahoe Beach Dawn",
      ),
    ).toBe(
      "All 40 built-in video backgrounds now use their real macOS release names and variants.",
    );
  });
});
