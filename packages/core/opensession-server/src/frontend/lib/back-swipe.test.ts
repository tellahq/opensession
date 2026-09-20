import { describe, expect, test } from "bun:test";

import {
  axisVerdict,
  edgeZoneAt,
  FLICK_MIN_PX,
  FLICK_VX,
  HARD_EDGE,
  shouldPop,
  SLOP,
  SOFT_EDGE,
} from "./back-swipe";

describe("edgeZoneAt", () => {
  test("the bezel edge is hard, the strip beside it soft, the rest nothing", () => {
    expect(edgeZoneAt(0)).toBe("hard");
    expect(edgeZoneAt(HARD_EDGE)).toBe("hard");
    expect(edgeZoneAt(HARD_EDGE + 1)).toBe("soft");
    expect(edgeZoneAt(SOFT_EDGE)).toBe("soft");
    expect(edgeZoneAt(SOFT_EDGE + 1)).toBeNull();
  });

  test("a sidebar row's icon sits in the soft zone, not the hard one", () => {
    // Row glyphs are drawn at x≈27 on phones; a tap there has to stay native.
    expect(edgeZoneAt(27)).toBe("soft");
  });
});

describe("axisVerdict", () => {
  test("waits below the slop in either zone", () => {
    expect(axisVerdict("hard", SLOP - 1, 0)).toBe("wait");
    expect(axisVerdict("soft", SLOP - 1, SLOP - 1)).toBe("wait");
  });

  test("hard zone commits on rightward travel however curved the path", () => {
    expect(axisVerdict("hard", SLOP, 0)).toBe("drag");
    // A thumb arc that dips first: more vertical than horizontal so far.
    expect(axisVerdict("hard", SLOP, 40)).toBe("drag");
    expect(axisVerdict("hard", 3, 40)).toBe("wait");
  });

  test("hard zone only gives up on a leftward move", () => {
    expect(axisVerdict("hard", -SLOP, 0)).toBe("release");
    expect(axisVerdict("hard", -3, 60)).toBe("wait");
  });

  test("soft zone claims a rightward move within ~50 degrees", () => {
    expect(axisVerdict("soft", 10, 0)).toBe("drag");
    expect(axisVerdict("soft", 10, 12)).toBe("drag");
    expect(axisVerdict("soft", 10, 13)).toBe("release");
  });

  test("soft zone hands a vertical or leftward move back to the scroll", () => {
    expect(axisVerdict("soft", 2, 10)).toBe("release");
    expect(axisVerdict("soft", -10, 0)).toBe("release");
  });
});

describe("shouldPop", () => {
  const width = 400;

  test("a slow release pops past halfway", () => {
    expect(shouldPop(width / 2 + 1, 0, width)).toBe(true);
    expect(shouldPop(width / 2, 0, width)).toBe(false);
  });

  test("a rightward flick pops a short drag, but not a twitch", () => {
    expect(shouldPop(FLICK_MIN_PX + 1, FLICK_VX + 0.1, width)).toBe(true);
    expect(shouldPop(FLICK_MIN_PX, FLICK_VX + 0.1, width)).toBe(false);
  });

  test("a leftward flick cancels even a long drag", () => {
    expect(shouldPop(width - 10, -FLICK_VX - 0.1, width)).toBe(false);
  });
});
