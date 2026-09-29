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

/** The parts of a DOM Selection the offer reads. */
export interface SelectionLike<R> {
  readonly rangeCount: number;
  readonly isCollapsed: boolean;
  toString(): string;
  getRangeAt(index: number): R;
}

/** A selected passage worth offering: its text and a copy of its range. */
export interface SelectedPassage<R> {
  text: string;
  range: R;
}

/**
 * The passage the live selection holds, or `null` when there is nothing to
 * offer: no selection, a collapsed one, a stray character, or one that
 * reaches outside the transcript.
 */
export function selectedPassage<
  N,
  R extends { startContainer: N; endContainer: N; cloneRange(): R },
>(
  selection: SelectionLike<R> | null | undefined,
  inside: (node: N) => boolean,
): SelectedPassage<R> | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed)
    return null;
  const text = selection.toString().trim();
  if (text.length < 2) return null;
  const range = selection.getRangeAt(0);
  if (!inside(range.startContainer) || !inside(range.endContainer)) return null;
  return { text, range: range.cloneRange() };
}

/**
 * Keeps an open offer in step with the selection. Touch browsers resize a
 * selection with native handles that fire no touch or mouse events, only
 * `selectionchange`, so an offer captured on the first `touchend` would
 * otherwise keep the word the long-press picked. A selection that collapses
 * or leaves the transcript is ignored rather than withdrawing the offer: a tap
 * on the pill itself can collapse it on the way to the click.
 */
export function followSelection<P>(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  read: () => P | null,
  update: (passage: P) => void,
): () => void {
  const onChange = () => {
    const passage = read();
    if (passage) update(passage);
  };
  target.addEventListener("selectionchange", onChange);
  return () => target.removeEventListener("selectionchange", onChange);
}
