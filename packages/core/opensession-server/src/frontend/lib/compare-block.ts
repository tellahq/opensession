/**
 * The ```compare fence: two stills, three ways to look at them.
 *
 * The server writes the fence for an `OPENSESSION_COMPARE: /a.png /b.png`
 * line (server/transcript-media.ts placeMediaMarkers), so a client without
 * this upgrader reads two links and a caption. Here the fence becomes the
 * comparison a GitHub image diff offers, with a switch under the stills:
 *
 * - 2-up: both stills side by side, each opening the gallery on click.
 * - Swipe: the before still underneath, the after still clipped to the right
 *   of a divider, and a native range input laid over the whole thing. The
 *   input is what makes it work everywhere without a pointer handler of its
 *   own: a drag or a tap anywhere moves it, arrow keys move it, a finger
 *   moves it, and it carries the accessible name and value.
 * - Onion skin: the after still laid over the before at an opacity set by a
 *   second range beside the switch.
 *
 * The view is one per-user preference (user-pref.ts), not one per block:
 * whoever prefers dragging a divider picks Swipe once and every comparison
 * after that opens the same way, on every device. The pref is created on the
 * first build rather than at import, so this module stays inert in a test
 * without a window and in the copy control that imports the registry.
 */

import {
  chevronsLeftRightIconMarkup,
  expandIconMarkup,
} from "../components/icons";
import type { FenceUpgrader } from "./fence-upgraders";
import * as UserPrefs from "./user-pref";

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

/** The block's classes (styles/blocks/compare.css). */
export const COMPARE_CLASS = "md-compare";
export const COMPARE_AFTER_CLASS = "md-compare-after";
export const COMPARE_IMAGE_CLASS = "md-compare-img";

export type CompareMode = "two-up" | "swipe" | "onion";

/** The switch's options, in the order GitHub lists them. */
export const COMPARE_MODES: readonly { value: CompareMode; label: string }[] = [
  { value: "two-up", label: "2-up" },
  { value: "swipe", label: "Swipe" },
  { value: "onion", label: "Onion skin" },
];

/** 2-up, as on GitHub: the whole of both stills is on screen at once, so a
 *  reader who has never met the switch still sees everything. */
export const DEFAULT_COMPARE_MODE: CompareMode = "two-up";

export const COMPARE_MODE_CHANGE_EVENT = "opensession-compare-mode-changed";

/** A stored value back to a mode, or null when it is not one. */
export function decodeCompareMode(
  raw: string | null | undefined,
): CompareMode | null {
  return COMPARE_MODES.find((mode) => mode.value === raw)?.value ?? null;
}

let pref: UserPrefs.UserPref<CompareMode> | null = null;

function compareModePref(): UserPrefs.UserPref<CompareMode> {
  if (pref) return pref;
  pref = UserPrefs.makeUserPref<CompareMode>({
    localKey: "opensession-compare-mode",
    prefKey: "compare-mode",
    changeEvent: COMPARE_MODE_CHANGE_EVENT,
    defaultValue: DEFAULT_COMPARE_MODE,
    decode: decodeCompareMode,
    encode: (mode) => mode,
  });
  // One listener for every block on the page, rather than one per block
  // that outlives the DOM it was built for: a switch in one comparison
  // flips the others too, the way one preference should.
  pref.onChanged(() => {
    const mode = compareModePref().get();
    for (const figure of Array.from(
      document.querySelectorAll<HTMLElement>(".md-compare-wrap"),
    ))
      applyMode(figure, mode);
  });
  return pref;
}

function applyMode(figure: HTMLElement, mode: CompareMode): void {
  figure.dataset.mode = mode;
  for (const button of Array.from(
    figure.querySelectorAll<HTMLElement>(".md-compare-mode"),
  ))
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
}

const DEFAULT_POSITION = 50;

function dividerValueText(position: number): string {
  return `${Math.round(position)}% before`;
}

function blendValueText(blend: number): string {
  return `${Math.round(blend)}% after`;
}

/** A 0 to 100 range that writes its value to `property` on `box` and reads
 *  it back through `valueText` for assistive tech. */
function rangeInput(
  box: HTMLElement,
  property: string,
  className: string,
  label: string,
  valueText: (value: number) => string,
): HTMLInputElement {
  const range = document.createElement("input");
  range.type = "range";
  range.className = className;
  range.min = "0";
  range.max = "100";
  // One percent per arrow key: fine enough to line the divider up with a
  // detail, coarse enough that a keyboard gets across in a hundred presses
  // rather than two hundred (Home and End jump to either end).
  range.step = "1";
  range.value = String(DEFAULT_POSITION);
  range.setAttribute("aria-label", label);
  range.setAttribute("aria-valuetext", valueText(DEFAULT_POSITION));
  box.style.setProperty(property, String(DEFAULT_POSITION));
  range.addEventListener("input", () => {
    const value = Number(range.value);
    box.style.setProperty(property, String(value));
    range.setAttribute("aria-valuetext", valueText(value));
  });
  return range;
}

/** The switch under the stills and, for Onion skin, the blend range. */
function buildBar(box: HTMLElement): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "md-compare-bar";

  const modes = document.createElement("div");
  modes.className = "md-compare-modes";
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "View");
  for (const { value, label } of COMPARE_MODES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "md-compare-mode";
    button.dataset.mode = value;
    button.textContent = label;
    button.addEventListener("click", () => compareModePref().set(value));
    modes.append(button);
  }

  const blend = document.createElement("div");
  blend.className = "md-compare-blend";
  const blendBefore = document.createElement("span");
  blendBefore.textContent = "Before";
  const blendAfter = document.createElement("span");
  blendAfter.textContent = "After";
  blend.append(
    blendBefore,
    rangeInput(
      box,
      "--blend",
      "md-compare-blend-range",
      "Blend before and after",
      blendValueText,
    ),
    blendAfter,
  );

  bar.append(modes, blend);
  return bar;
}

/** The block as DOM. Thin on purpose: the grammar above is the tested part. */
function buildCompare(spec: CompareSpec): HTMLElement {
  const figure = document.createElement("figure");
  figure.className = "md-compare-wrap";
  const box = document.createElement("div");
  box.className = COMPARE_CLASS;

  const before = document.createElement("img");
  before.className = `${COMPARE_IMAGE_CLASS} md-compare-before`;
  before.src = spec.before;
  before.alt = "Before";
  before.loading = "lazy";
  before.draggable = false;
  const after = document.createElement("img");
  after.className = `${COMPARE_IMAGE_CLASS} ${COMPARE_AFTER_CLASS}`;
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

  const range = rangeInput(
    box,
    "--p",
    "md-compare-range",
    "Compare before and after",
    dividerValueText,
  );

  // In Swipe the stills sit under the range, so the button is the way into
  // the lightbox (MediaLightbox.tsx opens the after still through
  // lightboxBlockMediaFor). It comes after the input in the DOM so it wins
  // the hit test. 2-up hides it: there the stills take the click themselves.
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "md-diagram-expand";
  expand.dataset.mdExpand = "compare";
  expand.title = "Expand";
  expand.setAttribute("aria-label", "Expand");
  expand.innerHTML = expandIconMarkup();

  box.append(before, after, labelBefore, labelAfter, divider, range, expand);
  figure.append(box, buildBar(box));
  if (spec.caption) {
    const caption = document.createElement("figcaption");
    caption.className = "md-figcaption";
    caption.textContent = spec.caption;
    figure.append(caption);
  }
  applyMode(figure, compareModePref().get());
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
