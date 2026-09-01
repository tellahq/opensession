/**
 * Where the "Add to chat" pill floats over a transcript selection.
 *
 * Selecting text offers the passage rather than attaching it: the pill sits
 * above the first line of the selection, out of the way of the words being
 * read, and only a press on it makes the passage context for the next message.
 *
 * The maths is here rather than in the component because it is the part with
 * edge cases (a selection that starts under the header, one that ends against
 * the bottom of the window, one near the right edge wide enough to push the
 * pill off screen) and none of them need a browser to check.
 */

export interface OfferRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface OfferBox {
  width: number;
  height: number;
}

export interface OfferPlacement {
  left: number;
  top: number;
  side: "above" | "below";
}

/** Air between the pill and the passage it points at. */
export const OFFER_GAP = 6;
/** Closest the pill comes to any edge of the window. */
export const OFFER_MARGIN = 8;

/**
 * `first` and `last` are the selection's first and last line boxes; the pill
 * hangs off whichever one it lands beside, so a selection spanning a paragraph
 * is still anchored to a line rather than to the block around it.
 */
export function placeQuoteOffer(
  first: OfferRect,
  last: OfferRect,
  pill: OfferBox,
  viewport: OfferBox,
): OfferPlacement {
  const above = first.top - OFFER_GAP - pill.height;
  const side = above >= OFFER_MARGIN ? "above" : "below";
  const anchor = side === "above" ? first : last;
  const bottomLimit = viewport.height - OFFER_MARGIN - pill.height;
  const top =
    side === "above"
      ? above
      : Math.min(last.bottom + OFFER_GAP, Math.max(OFFER_MARGIN, bottomLimit));
  const centered = anchor.left + (anchor.right - anchor.left - pill.width) / 2;
  const rightLimit = Math.max(
    OFFER_MARGIN,
    viewport.width - OFFER_MARGIN - pill.width,
  );
  return {
    left: Math.min(Math.max(centered, OFFER_MARGIN), rightLimit),
    top,
    side,
  };
}
