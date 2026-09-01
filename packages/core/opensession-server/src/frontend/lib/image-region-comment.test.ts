import { describe, expect, test } from "bun:test";
import {
  anchoredCommentPosition,
  imageRegionBetween,
  imageRegionOutputSize,
  imageRegionPixels,
  movedImageRegion,
  regionHandleStep,
  resizedImageRegion,
} from "./image-region-comment";
import {
  canCommentOnImageRegion,
  registerImageRegionCommentHandler,
  submitImageRegionComment,
} from "./image-region-comment-registry";

describe("image region geometry", () => {
  test("a reverse drag becomes a top-left rectangle", () => {
    expect(imageRegionBetween({ x: 0.8, y: 0.7 }, { x: 0.2, y: 0.1 })).toEqual({
      x: 0.2,
      y: 0.1,
      width: 0.6000000000000001,
      height: 0.6,
    });
  });

  test("a drag is clamped to the image", () => {
    expect(imageRegionBetween({ x: -1, y: 0.25 }, { x: 2, y: 1.5 })).toEqual({
      x: 0,
      y: 0.25,
      width: 1,
      height: 0.75,
    });
  });

  test("normalized edges become bounded intrinsic pixels", () => {
    expect(
      imageRegionPixels(
        { x: 0.25, y: 0.2, width: 0.5, height: 0.5 },
        1200,
        800,
      ),
    ).toEqual({ x: 300, y: 160, width: 600, height: 400 });
  });

  test("even a tiny edge selection keeps one pixel", () => {
    expect(
      imageRegionPixels({ x: 1, y: 1, width: 0, height: 0 }, 100, 50),
    ).toEqual({ x: 99, y: 49, width: 1, height: 1 });
  });

  test("large retina crops are bounded without changing their ratio", () => {
    expect(imageRegionOutputSize(4000, 2000)).toEqual({
      width: 2000,
      height: 1000,
      scale: 0.5,
    });
  });
});

describe("image region comment registry", () => {
  test("dispatches to the owning session and cleans up by identity", async () => {
    const calls: string[] = [];
    const first = async () => {
      calls.push("first");
    };
    const second = async () => {
      calls.push("second");
    };
    const unregisterFirst = registerImageRegionCommentHandler(
      "session-1",
      first,
    );
    const unregisterSecond = registerImageRegionCommentHandler(
      "session-1",
      second,
    );
    unregisterFirst();
    expect(canCommentOnImageRegion("session-1")).toBe(true);
    await submitImageRegionComment({
      sessionId: "session-1",
      src: "/media?path=image.png",
      region: { x: 0, y: 0, width: 1, height: 1 },
      text: "Fix this",
    });
    expect(calls).toEqual(["second"]);
    unregisterSecond();
    expect(canCommentOnImageRegion("session-1")).toBe(false);
  });
});

describe("the comment card sits against its region", () => {
  const card = { width: 340, height: 140 };
  const viewport = { width: 1440, height: 900 };

  test("hangs under the selection, aligned to its left edge", () => {
    expect(
      anchoredCommentPosition(
        { left: 500, top: 200, width: 260, height: 120 },
        card,
        viewport,
      ),
    ).toEqual({ left: 500, top: 330, placement: "below" });
  });

  test("flips above a region that reaches the bottom of the screen", () => {
    expect(
      anchoredCommentPosition(
        { left: 500, top: 640, width: 260, height: 200 },
        card,
        viewport,
      ),
    ).toEqual({ left: 500, top: 490, placement: "above" });
  });

  test("keeps Send on screen when a region fills the height", () => {
    const placed = anchoredCommentPosition(
      { left: 40, top: 10, width: 300, height: 880 },
      card,
      viewport,
    );
    expect(placed.placement).toBe("clamped");
    expect(placed.top + card.height).toBeLessThanOrEqual(viewport.height - 12);
  });

  test("never runs off the right edge of a phone", () => {
    const phone = { width: 390, height: 844 };
    const placed = anchoredCommentPosition(
      { left: 300, top: 120, width: 80, height: 60 },
      { width: 340, height: 150 },
      phone,
    );
    expect(placed.left).toBe(38);
    expect(placed.left + 340).toBeLessThanOrEqual(phone.width - 12);
  });
});

describe("a selection can be moved and resized", () => {
  const region = { x: 0.2, y: 0.2, width: 0.3, height: 0.2 };

  test("moving slides the region and keeps its size", () => {
    expect(movedImageRegion(region, 0.1, -0.05)).toEqual({
      x: 0.30000000000000004,
      y: 0.15000000000000002,
      width: 0.3,
      height: 0.2,
    });
  });

  test("a move stops at the edge instead of shrinking", () => {
    const moved = movedImageRegion(region, 0.9, 0.9);
    expect(moved.width).toBe(0.3);
    expect(moved.height).toBe(0.2);
    expect(moved.x + moved.width).toBeCloseTo(1, 10);
    expect(moved.y + moved.height).toBeCloseTo(1, 10);
  });

  test("a corner moves two edges and leaves the opposite corner alone", () => {
    const resized = resizedImageRegion(region, "se", 0.1, 0.1);
    expect(resized.x).toBeCloseTo(0.2, 10);
    expect(resized.y).toBeCloseTo(0.2, 10);
    expect(resized.width).toBeCloseTo(0.4, 10);
    expect(resized.height).toBeCloseTo(0.3, 10);
  });

  test("an edge moves only its own side", () => {
    const resized = resizedImageRegion(region, "w", -0.1, 0.4);
    expect(resized.x).toBeCloseTo(0.1, 10);
    expect(resized.width).toBeCloseTo(0.4, 10);
    expect(resized.y).toBeCloseTo(0.2, 10);
    expect(resized.height).toBeCloseTo(0.2, 10);
  });

  test("dragging an edge past its opposite flips instead of collapsing", () => {
    const resized = resizedImageRegion(region, "e", -0.4, 0);
    expect(resized.x).toBeCloseTo(0.1, 10);
    expect(resized.width).toBeCloseTo(0.1, 10);
  });

  test("a resize cannot go below the size a drag could have drawn", () => {
    const resized = resizedImageRegion(region, "se", -0.3, -0.2, {
      x: 0.05,
      y: 0.04,
    });
    expect(resized.width).toBeCloseTo(0.05, 10);
    expect(resized.height).toBeCloseTo(0.04, 10);
  });

  test("a resize stays inside the image", () => {
    const resized = resizedImageRegion(region, "nw", -0.9, -0.9);
    expect(resized.x).toBe(0);
    expect(resized.y).toBe(0);
    expect(resized.x + resized.width).toBeLessThanOrEqual(1);
    expect(resized.y + resized.height).toBeLessThanOrEqual(1);
  });
});

describe("handles frame a region too small to hold them", () => {
  test("a region with room keeps its handles on its corners", () => {
    expect(regionHandleStep(36, 204, 77)).toBe(0);
  });

  test("a small region pushes them outward", () => {
    expect(regionHandleStep(36, 34, 22)).toBeGreaterThan(0);
  });

  test("a stepped handle still covers the corner it belongs to", () => {
    // The corner is what a person aims at. If the step reaches half the
    // target, the handle clears the corner and that press draws a new
    // selection instead of resizing this one.
    for (const hit of [24, 36]) {
      for (const size of [8, 20, 34, 51, 71]) {
        expect(regionHandleStep(hit, size, size)).toBeLessThan(hit / 2);
      }
    }
  });
});
