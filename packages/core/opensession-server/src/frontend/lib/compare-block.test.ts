import { describe, expect, it } from "bun:test";
import {
  COMPARE_MODES,
  DEFAULT_COMPARE_MODE,
  decodeCompareMode,
  parseCompareFence,
} from "./compare-block";

const before = "/media?path=%2Ftmp%2Fbefore.png";
const after = "/media?path=%2Ftmp%2Fafter.png";

describe("parseCompareFence", () => {
  it("reads before, after and a caption", () => {
    expect(
      parseCompareFence(
        `before: ${before}\nafter: ${after}\ncaption: Retry timeline\n`,
      ),
    ).toEqual({ before, after, caption: "Retry timeline" });
  });

  it("takes the halves in either order and without a caption", () => {
    expect(parseCompareFence(`after: ${after}\n\nbefore: ${before}`)).toEqual({
      before,
      after,
      caption: undefined,
    });
  });

  it("accepts an http(s) still", () => {
    expect(
      parseCompareFence(
        "before: https://cdn.example/a.png\nafter: https://cdn.example/b.png",
      ),
    ).toEqual({
      before: "https://cdn.example/a.png",
      after: "https://cdn.example/b.png",
      caption: undefined,
    });
  });

  it("keeps the fence as code when a half is missing or unreadable", () => {
    expect(parseCompareFence(`before: ${before}`)).toBeNull();
    expect(parseCompareFence(`before: ${before}\nafter:`)).toBeNull();
    expect(
      parseCompareFence(`before: ${before}\nafter: javascript:alert(1)`),
    ).toBeNull();
    expect(
      parseCompareFence(`before: ${before}\nafter: ${after}\nnote: hi`),
    ).toBeNull();
    expect(parseCompareFence("")).toBeNull();
  });
});

describe("compare mode preference", () => {
  it("offers GitHub's three views in its order and opens on 2-up", () => {
    expect(COMPARE_MODES.map((mode) => mode.label)).toEqual([
      "2-up",
      "Swipe",
      "Onion skin",
    ]);
    expect(DEFAULT_COMPARE_MODE).toBe("two-up");
  });

  it("reads a stored mode back and drops anything else", () => {
    for (const { value } of COMPARE_MODES)
      expect(decodeCompareMode(value)).toBe(value);
    expect(decodeCompareMode("slider")).toBeNull();
    expect(decodeCompareMode("")).toBeNull();
    expect(decodeCompareMode(null)).toBeNull();
    expect(decodeCompareMode(undefined)).toBeNull();
  });
});
