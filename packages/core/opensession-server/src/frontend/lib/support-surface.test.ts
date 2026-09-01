import { describe, expect, test } from "bun:test";
import {
  SUPPORT_SURFACE_OPTIONS,
  supportSurfaceOf,
  supportToolShown,
} from "./support-surface";

describe("supportSurfaceOf", () => {
  test("names each state the two underlying lists can be in", () => {
    expect(supportSurfaceOf(false, true)).toBe("sidebar");
    expect(supportSurfaceOf(true, false)).toBe("page");
    expect(supportSurfaceOf(false, false)).toBe("off");
  });

  // Defaults leave both underlying preferences visible. Support is a default
  // tool, so that ambiguous state must render the tool without also rendering
  // the alternate sidebar band.
  test("both on resolves to the tool only", () => {
    expect(supportSurfaceOf(true, true)).toBe("page");
    expect(supportToolShown(true, true)).toBe(true);
  });

  test("the tool is only up when it is the chosen surface", () => {
    expect(supportToolShown(true, false)).toBe(true);
    expect(supportToolShown(false, true)).toBe(false);
    expect(supportToolShown(false, false)).toBe(false);
  });

  test("every reachable state has a name to show for it", () => {
    const named = new Set(
      SUPPORT_SURFACE_OPTIONS.map((option) => option.value),
    );
    for (const tool of [true, false])
      for (const band of [true, false])
        expect(named.has(supportSurfaceOf(tool, band))).toBe(true);
  });
});
