/**
 * The ```compare fence: two stills as one before/after slider.
 *
 * The server writes the fence for an `OPENSESSION_COMPARE: /a.png /b.png`
 * line (server/transcript-media.ts placeMediaMarkers), so a client without
 * this upgrader reads two links and a caption. Here the fence becomes a
 * slider: the before still underneath, the after still clipped to the right
 * of a divider, and a native range input laid over the whole thing. The
 * input is what makes it work everywhere without a pointer handler of its
 * own: a drag or a tap anywhere moves it, arrow keys move it, a finger moves
 * it, and it carries the accessible name and value.
 */

import {
  chevronsLeftRightIconMarkup,
  expandIconMarkup,
} from "../components/icons";
import type { FenceUpgrader } from "./fence-upgraders";

export interface CompareSpec {
  before: string;
  after: string;
  caption?: string;
}

/** A root-relative path (the `/media?path=` form the server writes) or an
 *  http(s) URL. Nothing else is a still we should load. */
const SRC_RE = /^(?:\/|https?:\/\/)\S+$/;

/**
 * `before: <src>` and `after: <src>`, one per line, in either order, plus an
 * optional `caption: <text>`. Anything else on a line, or a missing half,
 * keeps the fence as code.
 */
export function parseCompareFence(source: string): CompareSpec | null {
  let before: string | undefined;
  let after: string | undefined;
  let caption: string | undefined;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(before|after|caption):\s*(.*)$/i.exec(line);
    if (!m) return null;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "caption") {
      caption = value || undefined;
      continue;
    }
    if (!SRC_RE.test(value)) return null;
    if (key === "before") before = value;
    else after = value;
  }
  return before && after ? { before, after, caption } : null;
}

/** The slider's classes (styles/blocks/compare.css). */
export const COMPARE_CLASS = "md-compare";
export const COMPARE_AFTER_CLASS = "md-compare-after";

const DEFAULT_POSITION = 50;

function valueText(position: number): string {
  return `${Math.round(position)}% before`;
}

/** The slider as DOM. Thin on purpose: the grammar above is the tested part. */
function buildCompare(spec: CompareSpec): HTMLElement {
  const figure = document.createElement("figure");
  figure.className = "md-compare-wrap";
  const box = document.createElement("div");
  box.className = COMPARE_CLASS;
  box.style.setProperty("--p", String(DEFAULT_POSITION));

  const before = document.createElement("img");
  before.className = "md-compare-img md-compare-before";
  before.src = spec.before;
  before.alt = "Before";
  before.loading = "lazy";
  before.draggable = false;
  const after = document.createElement("img");
  after.className = `md-compare-img ${COMPARE_AFTER_CLASS}`;
  after.src = spec.after;
  after.alt = "After";
  after.loading = "lazy";
  after.draggable = false;

  const labelBefore = document.createElement("span");
  labelBefore.className = "md-compare-label md-compare-label-before";
  labelBefore.textContent = "Before";
  const labelAfter = document.createElement("span");
  labelAfter.className = "md-compare-label md-compare-label-after";
  labelAfter.textContent = "After";

  const divider = document.createElement("div");
  divider.className = "md-compare-divider";
  divider.setAttribute("aria-hidden", "true");
  const handle = document.createElement("span");
  handle.className = "md-compare-handle";
  handle.innerHTML = chevronsLeftRightIconMarkup();
  divider.append(handle);

  const range = document.createElement("input");
  range.type = "range";
  range.className = "md-compare-range";
  range.min = "0";
  range.max = "100";
  // One percent per arrow key: fine enough to line the divider up with a
  // detail, coarse enough that a keyboard gets across in a hundred presses
  // rather than two hundred (Home and End jump to either end).
  range.step = "1";
  range.value = String(DEFAULT_POSITION);
  range.setAttribute("aria-label", "Compare before and after");
  range.setAttribute("aria-valuetext", valueText(DEFAULT_POSITION));
  range.addEventListener("input", () => {
    const position = Number(range.value);
    box.style.setProperty("--p", String(position));
    range.setAttribute("aria-valuetext", valueText(position));
  });

  // The stills sit under the range, so the button is the way into the
  // lightbox (MediaLightbox.tsx opens the after still through
  // lightboxBlockMediaFor). It comes after the input in the DOM so it wins
  // the hit test.
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "md-diagram-expand";
  expand.dataset.mdExpand = "compare";
  expand.title = "Expand";
  expand.setAttribute("aria-label", "Expand");
  expand.innerHTML = expandIconMarkup();

  box.append(before, after, labelBefore, labelAfter, divider, range, expand);
  figure.append(box);
  if (spec.caption) {
    const caption = document.createElement("figcaption");
    caption.className = "md-figcaption";
    caption.textContent = spec.caption;
    figure.append(caption);
  }
  return figure;
}

export const compareUpgrader: FenceUpgrader = {
  langs: ["compare"],
  async upgrade({ pre, source, root, alive }) {
    const spec = parseCompareFence(source);
    if (!spec || !alive() || !root.contains(pre)) return false;
    pre.replaceWith(buildCompare(spec));
    return true;
  },
};
