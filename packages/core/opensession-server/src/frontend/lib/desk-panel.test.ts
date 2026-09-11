import { describe, expect, test } from "bun:test";
import {
  DESK_PANEL_DEFAULT_PLACEMENT,
  DESK_PANEL_MARGIN,
  DESK_PANEL_MIN_HEIGHT,
  DESK_PANEL_MIN_WIDTH,
  clampDeskPanelRect,
  decodeDeskPanelPlacement,
  deskPanelRect,
  encodeDeskPanelPlacement,
  moveDeskPanel,
  placeDeskPanel,
  resizeDeskPanel,
} from "./desk-panel";

const viewport = { width: 1440, height: 900 };

describe("deskPanelRect", () => {
  test("the default placement sits in the bottom-right corner over the trigger", () => {
    expect(deskPanelRect(DESK_PANEL_DEFAULT_PLACEMENT, viewport)).toEqual({
      left: 1440 - DESK_PANEL_MARGIN - 560,
      top: 900 - DESK_PANEL_MARGIN - 600,
      width: 560,
      height: 600,
    });
  });

  test("a corner-anchored panel stays in its corner when the window grows", () => {
    const wide = { width: 2560, height: 1440 };
    const rect = deskPanelRect(DESK_PANEL_DEFAULT_PLACEMENT, wide);
    expect(rect.left + rect.width).toBe(2560 - DESK_PANEL_MARGIN);
    expect(rect.top + rect.height).toBe(1440 - DESK_PANEL_MARGIN);
  });

  test("a top-left placement measures from the top-left", () => {
    expect(
      deskPanelRect(
        { corner: "top-left", x: 40, y: 50, width: 400, height: 400 },
        viewport,
      ),
    ).toEqual({ left: 40, top: 50, width: 400, height: 400 });
  });

  test("a panel bigger than a shrunken window is cut down to fit it", () => {
    const small = { width: 500, height: 500 };
    expect(deskPanelRect(DESK_PANEL_DEFAULT_PLACEMENT, small)).toEqual({
      left: DESK_PANEL_MARGIN,
      top: DESK_PANEL_MARGIN,
      width: 500 - 2 * DESK_PANEL_MARGIN,
      height: 500 - 2 * DESK_PANEL_MARGIN,
    });
  });
});

describe("clampDeskPanelRect", () => {
  test("keeps the panel on screen and no smaller than its minimum", () => {
    expect(
      clampDeskPanelRect(
        { left: -100, top: 2000, width: 100, height: 100 },
        viewport,
      ),
    ).toEqual({
      left: DESK_PANEL_MARGIN,
      top: 900 - DESK_PANEL_MARGIN - DESK_PANEL_MIN_HEIGHT,
      width: DESK_PANEL_MIN_WIDTH,
      height: DESK_PANEL_MIN_HEIGHT,
    });
  });
});

describe("placeDeskPanel", () => {
  test("anchors to the corner nearest the panel's centre", () => {
    const rect = { left: 100, top: 100, width: 400, height: 400 };
    expect(placeDeskPanel(rect, viewport)).toEqual({
      corner: "top-left",
      x: 100,
      y: 100,
      width: 400,
      height: 400,
    });
    const lowRight = { left: 900, top: 450, width: 400, height: 400 };
    expect(placeDeskPanel(lowRight, viewport)).toEqual({
      corner: "bottom-right",
      x: 1440 - 900 - 400,
      y: 900 - 450 - 400,
      width: 400,
      height: 400,
    });
  });

  test("round-trips through deskPanelRect", () => {
    const rect = { left: 700, top: 120, width: 420, height: 500 };
    expect(deskPanelRect(placeDeskPanel(rect, viewport), viewport)).toEqual(
      rect,
    );
  });
});

describe("moveDeskPanel", () => {
  test("translates and stops at the margin", () => {
    const rect = { left: 500, top: 200, width: 400, height: 400 };
    expect(moveDeskPanel(rect, -30, 40, viewport)).toEqual({
      ...rect,
      left: 470,
      top: 240,
    });
    expect(moveDeskPanel(rect, -5000, -5000, viewport)).toEqual({
      ...rect,
      left: DESK_PANEL_MARGIN,
      top: DESK_PANEL_MARGIN,
    });
  });
});

describe("resizeDeskPanel", () => {
  const rect = { left: 500, top: 200, width: 400, height: 400 };

  test("the east and south handles grow away from a fixed origin", () => {
    expect(resizeDeskPanel(rect, "se", 50, 60, viewport)).toEqual({
      left: 500,
      top: 200,
      width: 450,
      height: 460,
    });
  });

  test("the west and north handles keep the far edge in place", () => {
    expect(resizeDeskPanel(rect, "nw", -50, -60, viewport)).toEqual({
      left: 450,
      top: 140,
      width: 450,
      height: 460,
    });
    const shrunk = resizeDeskPanel(rect, "w", 1000, 0, viewport);
    expect(shrunk.width).toBe(DESK_PANEL_MIN_WIDTH);
    expect(shrunk.left + shrunk.width).toBe(900);
  });

  test("a single-axis handle leaves the other axis alone", () => {
    expect(resizeDeskPanel(rect, "e", 30, 999, viewport)).toEqual({
      ...rect,
      width: 430,
    });
    expect(resizeDeskPanel(rect, "n", 999, -30, viewport)).toEqual({
      ...rect,
      top: 170,
      height: 430,
    });
  });

  test("cannot be dragged past the viewport margin", () => {
    const grown = resizeDeskPanel(rect, "se", 5000, 5000, viewport);
    expect(grown.left + grown.width).toBe(1440 - DESK_PANEL_MARGIN);
    expect(grown.top + grown.height).toBe(900 - DESK_PANEL_MARGIN);
  });
});

describe("stored placement", () => {
  test("round-trips", () => {
    const placement = {
      corner: "top-right" as const,
      x: 24,
      y: 80,
      width: 480,
      height: 520,
    };
    expect(
      decodeDeskPanelPlacement(encodeDeskPanelPlacement(placement)),
    ).toEqual(placement);
  });

  test("rejects anything absent or malformed", () => {
    expect(decodeDeskPanelPlacement(null)).toBeNull();
    expect(decodeDeskPanelPlacement("")).toBeNull();
    expect(decodeDeskPanelPlacement("{not json")).toBeNull();
    expect(
      decodeDeskPanelPlacement(
        JSON.stringify({ corner: "middle", x: 1, y: 1, width: 1, height: 1 }),
      ),
    ).toBeNull();
    expect(
      decodeDeskPanelPlacement(
        JSON.stringify({
          corner: "top-left",
          x: -1,
          y: 1,
          width: 1,
          height: 1,
        }),
      ),
    ).toBeNull();
  });
});
