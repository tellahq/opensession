import { describe, expect, test } from "bun:test";
import { hexToOklch, maxChroma, oklchToHex } from "./oklch";
import { markTileGradient, MARK_TONES } from "./mark-tile";

describe("hexToOklch", () => {
  test("round trips a colour through both directions", () => {
    for (const hex of ["#208a94", "#d26232", "#825dbc", "#2b8948", "#ffffff"])
      expect(oklchToHex(hexToOklch(hex))).toBe(hex);
  });

  test("expands the three digit form", () => {
    expect(hexToOklch("#fff")).toEqual(hexToOklch("#ffffff"));
  });

  test("reads greys as having no chroma", () => {
    expect(hexToOklch("#808080").C).toBeCloseTo(0, 4);
  });
});

describe("maxChroma", () => {
  test("holds far less cyan than violet at one lightness", () => {
    // The asymmetry the mark palette's shared ceiling exists to absorb. If
    // this ever evens out, the ceiling is costing saturation for nothing.
    const cyan = maxChroma(0.58, hexToOklch("#208a94").h);
    const violet = maxChroma(0.58, hexToOklch("#825dbc").h);
    expect(violet).toBeGreaterThan(cyan * 2);
  });

  test("stays inside sRGB", () => {
    for (const h of [0, 60, 120, 180, 240, 300]) {
      const hex = oklchToHex({ L: 0.6, C: maxChroma(0.6, h), h });
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("oklchToHex", () => {
  test("gives up chroma rather than clipping a channel", () => {
    // Asking for more chroma than the hue can hold must not shift the hue:
    // clipping a channel is what turns an out of range blue cyan.
    const asked = { L: 0.6, C: 0.35, h: 264 };
    const got = hexToOklch(oklchToHex(asked));
    expect(got.h).toBeCloseTo(asked.h, 0);
    expect(got.L).toBeCloseTo(asked.L, 1);
    expect(got.C).toBeLessThan(asked.C);
  });
});

describe("mark tile ramps", () => {
  const relativeLuminance = (hex: string) => {
    const channel = (c: number) =>
      c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    const r = channel(parseInt(hex.slice(1, 3), 16) / 255);
    const g = channel(parseInt(hex.slice(3, 5), 16) / 255);
    const b = channel(parseInt(hex.slice(5, 7), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  test("every tone keeps a white glyph legible at its lightest end", () => {
    for (const tone of MARK_TONES) {
      const stops = markTileGradient(tone).match(/#[0-9a-f]{6}/g)!;
      const lightest = stops.reduce((a, b) =>
        relativeLuminance(a) > relativeLuminance(b) ? a : b,
      );
      const contrast = 1.05 / (relativeLuminance(lightest) + 0.05);
      // The floor for a graphic. mark-tile trims a hue's light end to hold
      // it, so this is the guard on that guard: raise CHROMA_CEILING or
      // RAMP_LIGHTNESS past what a hue can carry and it fails here rather
      // than shipping a tile whose glyph has gone soft.
      expect(contrast).toBeGreaterThanOrEqual(3);
    }
  });

  test("the ramp brightens without desaturating", () => {
    for (const tone of MARK_TONES) {
      const [top, bottom] = markTileGradient(tone)
        .match(/#[0-9a-f]{6}/g)!
        .map(hexToOklch);
      expect(top!.L).toBeGreaterThan(bottom!.L);
      // The white mix this replaced lost about a third of its chroma at
      // the light end. Holding it is the whole point.
      expect(top!.C).toBeGreaterThan(bottom!.C * 0.85);
    }
  });
});
