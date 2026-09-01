import { describe, expect, test } from "bun:test";
import {
  RAIL_EDGE,
  RAIL_GUTTER,
  RAIL_GUTTER_CLASS,
  RAIL_W,
} from "./message-rail";
import {
  VIEWER_INPUT,
  VIEWER_MESSAGES,
  VIEWER_SUGGESTIONS,
} from "./session-viewer-classes";

describe("message rail gutter", () => {
  test("the reserved padding is the room the rail actually needs", () => {
    // Tailwind only compiles class names it can find written out, so the
    // padding cannot be built from the numbers. This is what keeps the two
    // from drifting: widen the rail and this fails.
    expect(RAIL_GUTTER).toBe(RAIL_W + RAIL_EDGE);
    expect(RAIL_GUTTER_CLASS).toBe(
      `desktop:[@media(hover:hover)]:px-[${RAIL_GUTTER}px]`,
    );
  });

  test("the transcript and the composer keep the same gutter", () => {
    // Different edges would put the input past the column it belongs to.
    expect(VIEWER_MESSAGES).toContain(RAIL_GUTTER_CLASS);
    expect(VIEWER_INPUT).toContain(RAIL_GUTTER_CLASS);
    // The quick-reply row floats over the transcript on the composer's own
    // edge, so it repeats the input's padding rather than the 20px that
    // padding reads as. Measured without the gutter, the pills sat 17px
    // outside the composer.
    expect(VIEWER_SUGGESTIONS).toContain(RAIL_GUTTER_CLASS);
  });
});
