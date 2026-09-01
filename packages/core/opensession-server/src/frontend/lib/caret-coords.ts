/**
 * Where a character sits on screen inside a textarea.
 *
 * A textarea gives no per-character geometry, so the only way to point at one
 * is to lay the same text out again in a div whose metrics match, and measure
 * a marker span there. That is the same trick the composer's highlight mirror
 * uses, kept separate here because this one is transient: it mounts, measures,
 * and removes itself within a single call.
 *
 * Used to anchor the emoji picker beside the shortcode being typed, rather
 * than to the whole field. A picker that answers ":cr" belongs next to those
 * two characters; one pinned to the field's left edge reads as unrelated to
 * the caret when the text is halfway across a wide composer.
 */

/**
 * Every property that can move a glyph. Font and spacing decide where the
 * character lands on its line, padding and border decide where the line
 * starts, and the wrapping group decides which line it is on at all.
 */
const MIRRORED_PROPS = [
  "box-sizing",
  "width",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "font-stretch",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-indent",
  "text-transform",
  "text-align",
  "tab-size",
  "white-space",
  "word-break",
  "overflow-wrap",
];

export interface CaretPoint {
  /** Viewport x of the character's left edge. */
  left: number;
  /** Viewport y of the top of its line. */
  top: number;
  /** Viewport y of the bottom of its line. */
  bottom: number;
}

/**
 * Viewport coordinates of the character at `index`. Null when there is nothing
 * to measure against (no element, or a DOM without layout, as in tests).
 */
export function caretPoint(
  el: HTMLTextAreaElement | null | undefined,
  index: number,
): CaretPoint | null {
  if (!el || typeof window === "undefined") return null;
  const doc = el.ownerDocument;
  if (!doc?.body) return null;
  const style = window.getComputedStyle(el);
  const mirror = doc.createElement("div");
  for (const prop of MIRRORED_PROPS) {
    mirror.style.setProperty(prop, style.getPropertyValue(prop));
  }
  // The mirror lays out off screen at its natural height, so a long draft
  // wraps exactly as the field does without being clipped to the field's box.
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.height = "auto";
  mirror.style.overflow = "hidden";
  mirror.style.whiteSpace = style.whiteSpace === "nowrap" ? "pre" : "pre-wrap";
  mirror.style.overflowWrap = "break-word";

  mirror.textContent = el.value.slice(0, index);
  const marker = doc.createElement("span");
  // A trailing character keeps the span from collapsing to zero size, and the
  // rest of the draft keeps the wrap point honest: without it a word split
  // across the caret would measure as if it fit on the current line.
  marker.textContent = el.value.slice(index) || ".";
  mirror.appendChild(marker);
  doc.body.appendChild(mirror);

  const rect = el.getBoundingClientRect();
  const lineHeight =
    parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 16;
  const point: CaretPoint = {
    left: rect.left + marker.offsetLeft - el.scrollLeft,
    top: rect.top + marker.offsetTop - el.scrollTop,
    bottom: rect.top + marker.offsetTop - el.scrollTop + lineHeight,
  };
  mirror.remove();
  if (!Number.isFinite(point.left) || !Number.isFinite(point.top)) return null;
  return point;
}
