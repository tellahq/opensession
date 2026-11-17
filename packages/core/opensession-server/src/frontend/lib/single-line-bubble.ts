/**
 * Marks a message bubble `data-single-line` while its text fits on one line,
 * so `msgBubbleUser` can round it into a pill. A wrapped message keeps the
 * normal corner: a pill around a paragraph reads as a lozenge.
 *
 * CSS cannot style a box by its own height, so this measures. One observer is
 * shared by every bubble, created on first use, and it writes the attribute
 * straight onto the node: no React state, so a resize never re-renders the
 * transcript.
 */
let observer: ResizeObserver | null = null;

function measure(el: Element, contentHeight: number) {
  const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
  // Half a line of slack absorbs an inline code chip or an emoji that sits a
  // little taller than the text around it.
  const single =
    Number.isFinite(lineHeight) && contentHeight < lineHeight * 1.5;
  el.toggleAttribute("data-single-line", single);
}

export function observeSingleLine(el: HTMLElement): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries)
      measure(entry.target, entry.contentRect.height);
  });
  observer.observe(el);
  return () => observer?.unobserve(el);
}

/** Ref callback for a plain bubble element. React 19 runs the returned
 *  cleanup when the node unmounts. */
export function singleLineRef(el: HTMLElement | null) {
  return el ? observeSingleLine(el) : undefined;
}
