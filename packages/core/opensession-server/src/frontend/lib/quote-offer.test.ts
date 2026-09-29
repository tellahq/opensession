import { describe, expect, it } from "bun:test";
import {
  OFFER_GAP,
  OFFER_MARGIN,
  followSelection,
  placeQuoteOffer,
  selectedPassage,
  type SelectionLike,
} from "./quote-offer";

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

interface FakeRange {
  startContainer: string;
  endContainer: string;
  text: string;
  cloneRange(): FakeRange;
}

/** A selection of `text` spanning the named nodes, like a DOM Selection. */
function selection(
  text: string,
  start = "transcript",
  end = start,
): SelectionLike<FakeRange> {
  const range: FakeRange = {
    startContainer: start,
    endContainer: end,
    text,
    cloneRange: () => ({ ...range }),
  };
  return {
    rangeCount: 1,
    isCollapsed: text.length === 0,
    toString: () => text,
    getRangeAt: () => range,
  };
}

const inTranscript = (node: string) => node === "transcript";

describe("selectedPassage", () => {
  it("offers a trimmed passage and a copy of its range", () => {
    const live = selection("  the posting tool  ");
    const passage = selectedPassage(live, inTranscript);
    expect(passage?.text).toBe("the posting tool");
    expect(passage?.range).not.toBe(live.getRangeAt(0));
  });

  it("offers nothing for a collapsed, tiny or escaping selection", () => {
    expect(selectedPassage(null, inTranscript)).toBeNull();
    expect(selectedPassage(selection(""), inTranscript)).toBeNull();
    expect(selectedPassage(selection("a"), inTranscript)).toBeNull();
    expect(
      selectedPassage(selection("header text", "header"), inTranscript),
    ).toBeNull();
    expect(
      selectedPassage(
        selection("reaches the header", "transcript", "header"),
        inTranscript,
      ),
    ).toBeNull();
  });
});

describe("followSelection", () => {
  // A long-press offers the one word it selected; dragging the native handles
  // afterwards fires only selectionchange. The pill must add the whole passage.
  it("keeps the offer on the selection the handles extended", () => {
    const doc = new EventTarget();
    let live = selection("the");
    const offered: string[] = [];
    const stop = followSelection(
      doc,
      () => selectedPassage(live, inTranscript),
      (passage) => offered.push(passage.text),
    );
    live = selection("the posting tool can't attach images");
    doc.dispatchEvent(new Event("selectionchange"));
    expect(offered).toEqual(["the posting tool can't attach images"]);

    // Tapping the pill can collapse the selection first: keep the passage.
    live = selection("");
    doc.dispatchEvent(new Event("selectionchange"));
    expect(offered).toEqual(["the posting tool can't attach images"]);

    stop();
    live = selection("after the offer closed");
    doc.dispatchEvent(new Event("selectionchange"));
    expect(offered).toHaveLength(1);
  });
});
