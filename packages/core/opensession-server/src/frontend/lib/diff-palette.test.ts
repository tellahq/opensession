import { describe, expect, test } from "bun:test";
import { isDiffPalette } from "./diff-palette";

describe("diff-palette", () => {
  test("accepts only default and colorblind palettes", () => {
    expect(isDiffPalette("default")).toBe(true);
    expect(isDiffPalette("colorblind")).toBe(true);
    expect(isDiffPalette("high-contrast")).toBe(false);
    expect(isDiffPalette(null)).toBe(false);
  });
});
