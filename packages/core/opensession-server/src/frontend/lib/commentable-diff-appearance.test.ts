import { describe, expect, test } from "bun:test";
import { resolveTheme } from "@pierre/diffs";
import {
  DIFF_SURFACE_STYLE,
  diffAppearanceOptions,
} from "./commentable-diff-appearance";

describe("commentable diff appearance", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`${theme} uses a supported GitHub syntax theme and classic indicators`, async () => {
      const options = diffAppearanceOptions(theme, true);
      const resolved = await resolveTheme(options.theme);
      expect(resolved.name).toBe(`github-${theme}-default`);
      expect(resolved.type).toBe(theme);
      expect(options.themeType).toBe(theme);
      expect(options.diffIndicators).toBe("classic");
    });

    test(`${theme} preserves the structural highlighting preference`, () => {
      expect(diffAppearanceOptions(theme, true).lineDiffType).toBe("word-alt");
      expect(diffAppearanceOptions(theme, false).lineDiffType).toBe("none");
    });

    test(`${theme} keeps numbers neutral, softens change rows and tints the gutter`, () => {
      const style = DIFF_SURFACE_STYLE[theme];
      expect(style["--diffs-bg"]).toBe(`var(--review-code-${theme})`);
      for (const side of ["addition", "deletion"]) {
        expect(style[`--diffs-fg-number-${side}-override`]).toBe(
          style["--diffs-fg-number-override"],
        );
        const fill = style[`--diffs-bg-${side}-override`];
        expect(fill).toContain("50%, var(--diffs-bg)");
        // The gutter takes the full hue, a step above its softened code row.
        expect(style[`--diffs-bg-${side}-number-override`]).toBe(
          side === "addition" ? "var(--green)" : "var(--red)",
        );
        expect(style[`--diffs-bg-${side}-emphasis-override`]).toContain(
          "16%, transparent",
        );
      }
      // Only semantic tokens and color mixing, never a local palette. Host
      // variables cannot reference variables defined only inside the shadow.
      for (const value of Object.values(style)) {
        expect(value).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|oklch\(/i);
        expect(value).not.toContain("var(--diffs-fg-number)");
      }
    });
  }
});
