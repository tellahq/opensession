import { describe, expect, test } from "bun:test";

import { calculateDeskFabPosition } from "./desk-fab-position";

describe("calculateDeskFabPosition", () => {
  test("uses the bottom-right corner when the composer leaves room", () => {
    expect(
      calculateDeskFabPosition(
        { right: 1300.625, top: 818.75 },
        { width: 2074, height: 938 },
      ),
    ).toEqual({ left: 2012, bottom: 18 });
  });

  test("moves above a composer that reaches the viewport edge", () => {
    expect(
      calculateDeskFabPosition(
        { right: 863, top: 818.75 },
        { width: 900, height: 938 },
      ),
    ).toEqual({ left: 819, bottom: 129.25 });
  });

  test("returns to the corner when the viewport widens again", () => {
    const anchor = { right: 1300.625, top: 818.75 };
    const narrow = calculateDeskFabPosition(anchor, {
      width: 1320,
      height: 938,
    });
    const wide = calculateDeskFabPosition(anchor, {
      width: 2074,
      height: 938,
    });

    expect(narrow).toEqual({ left: 1256.625, bottom: 129.25 });
    expect(wide).toEqual({ left: 2012, bottom: 18 });
  });
});
