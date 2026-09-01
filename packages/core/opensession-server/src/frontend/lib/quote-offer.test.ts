import { describe, expect, it } from "bun:test";
import { OFFER_GAP, OFFER_MARGIN, placeQuoteOffer } from "./quote-offer";

const rect = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

const pill = { width: 120, height: 32 };
const viewport = { width: 1000, height: 800 };

describe("placeQuoteOffer", () => {
  it("hangs above the first line, centered on the highlighted text", () => {
    const line = rect(300, 400, 700, 420);
    expect(placeQuoteOffer(line, line, pill, viewport)).toEqual({
      left: 440,
      top: 400 - OFFER_GAP - pill.height,
      side: "above",
    });
  });

  it("drops below the last line when there is no room above", () => {
    const first = rect(300, 20, 700, 40);
    const last = rect(100, 60, 400, 80);
    expect(placeQuoteOffer(first, last, pill, viewport)).toEqual({
      left: 190,
      top: 80 + OFFER_GAP,
      side: "below",
    });
  });

  it("keeps the pill on screen when the passage runs to the right edge", () => {
    const line = rect(960, 400, 990, 420);
    expect(placeQuoteOffer(line, line, pill, viewport).left).toBe(
      viewport.width - OFFER_MARGIN - pill.width,
    );
  });

  it("keeps the pill on screen when the passage runs to the left edge", () => {
    const line = rect(0, 400, 10, 420);
    expect(placeQuoteOffer(line, line, pill, viewport).left).toBe(OFFER_MARGIN);
  });

  it("stays inside the bottom edge for a passage against it", () => {
    const first = rect(300, 10, 700, 30);
    const last = rect(300, 795, 700, 815);
    const { top } = placeQuoteOffer(first, last, pill, viewport);
    expect(top).toBe(viewport.height - OFFER_MARGIN - pill.height);
  });
});
