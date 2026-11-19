import { COMPARE_AFTER_CLASS, COMPARE_CLASS } from "./compare-block";
import { diagramDataUrl, readDiagramSvg } from "./diagram-media";
import {
  commentSessionIdFor,
  openLightbox,
  type LightboxItem,
} from "./media-lightbox";

/** Every piece of session media currently in the DOM, in document order.
 *  A chart's SVG is the one vega draws into its canvas (vega-chart.ts); a
 *  before/after slider's two stills are both here (compare-block.ts). */
export const GALLERY_SELECTOR =
  "img.md-image, video.md-video, .md-compare > img, .md-mermaid > svg, .md-chart-canvas > svg";

/** The viewer frosts the page behind it in the page's own colour, so the
 *  session stays recognisable while the picture is in front of it. */
export const LIGHTBOX_SCRIM_CLASS =
  "pointer-events-none absolute inset-0 bg-bg/80 backdrop-blur-2xl backdrop-saturate-150";

/** The tools sit in one inverse pill above the input, so they read as a
 *  single object over the frosted page rather than loose labels on it. */
export const LIGHTBOX_TOOLBAR_CLASS =
  "pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full bg-fg p-1 text-bg smooth-shadow-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** One tool in that pill. Ghost buttons re-inked for the inverse fill. */
export const LIGHTBOX_TOOL_CLASS =
  "shrink-0 cursor-pointer text-bg/80 hover:bg-bg/15 hover:text-bg aria-pressed:bg-bg/15 aria-pressed:text-bg";

/** Close and the page arrows: raised round buttons on the frosted page. */
export const LIGHTBOX_ROUND_BUTTON_CLASS =
  "z-10 size-10 shrink-0 rounded-full text-fg smooth-shadow-sm phone:size-11";

/** The session input a desktop viewer keeps above its scrim: the child of
 *  the marked host that holds Composer's box (`.composer`), lifted by
 *  VIEWER_INPUT while `html[data-lightbox-composer]` is set. */
export const LIGHTBOX_COMPOSER_SELECTOR =
  "[data-lightbox-composer-host] > :has(.composer)";
export const LIGHTBOX_PREVIEW_LABEL: Record<LightboxItem["kind"], string> = {
  image: "Image preview",
  video: "Video preview",
  diagram: "Diagram preview",
};

/** One node as an item, or null when it cannot be shown. */
function galleryItem(node: Element): LightboxItem | null {
  if (node instanceof HTMLImageElement) {
    // A slider's stills say which side they are with the same red and
    // green pill a walkthrough uses, not their alt text as a caption.
    if (node.parentElement?.classList.contains(COMPARE_CLASS)) {
      return {
        kind: "image",
        src: node.currentSrc || node.src,
        commentSessionId: commentSessionIdFor(node),
        walkthroughLabel: node.classList.contains(COMPARE_AFTER_CLASS)
          ? "after"
          : "before",
      };
    }
    return {
      kind: "image",
      src: node.currentSrc || node.src,
      commentSessionId: commentSessionIdFor(node),
      sessionTitle: node.alt.trim() || undefined,
    };
  }
  if (node instanceof HTMLVideoElement) {
    return { kind: "video", src: node.src };
  }
  return diagramItem(node);
}

/** A rendered diagram or chart as a lightbox item, or null when its markup
 *  does not say how big it is. Serialized as XML, not outerHTML: the item is
 *  also a standalone file (Download, Copy image), and HTML serialization
 *  writes a label's line break as an unclosed <br>, which no SVG parser
 *  will draw. */
export function diagramItem(svg: Element): LightboxItem | null {
  const diagram = readDiagramSvg(new XMLSerializer().serializeToString(svg));
  return diagram
    ? { kind: "diagram", src: diagramDataUrl(diagram.svg), diagram }
    : null;
}

/** Open on `el` and browse all session media currently on screen. */
export function openGalleryFrom(el: Element) {
  const shown = Array.from(document.querySelectorAll(GALLERY_SELECTOR)).flatMap(
    (node) => {
      const item = galleryItem(node);
      return item ? [{ node, item }] : [];
    },
  );
  if (shown.length === 0) return;
  openLightbox(
    shown.map((entry) => entry.item),
    Math.max(
      0,
      shown.findIndex((entry) => entry.node === el),
    ),
    el,
  );
}

/**
 * The media an expand button inside rendered markdown opens: a placed
 * video's player (markdown.ts writes the button beside it, since the player's
 * own controls take every click) or a before/after slider's after still
 * (compare-block.ts, where the range input covers both stills). The button
 * carries `data-md-expand` so the React-owned expand on a trailing-row video
 * (MessageBubble.tsx), which has its own handler, is left alone.
 */
export function lightboxBlockMediaFor(target: Element): Element | null {
  const button = target.closest?.("button[data-md-expand]");
  if (!button) return null;
  const kind = button.getAttribute("data-md-expand");
  if (kind === "video")
    return button.parentElement?.querySelector("video.md-video") ?? null;
  if (kind === "compare")
    return (
      button.closest(".md-compare")?.querySelector("img.md-compare-after") ??
      null
    );
  return null;
}

/** True while the reader has text selected inside `node`: copying a label,
 *  which a click or right-click must not take over. */
function selectingIn(node: Element): boolean {
  const selection = window.getSelection();
  return Boolean(
    selection &&
    !selection.isCollapsed &&
    selection.anchorNode &&
    node.contains(selection.anchorNode),
  );
}

/**
 * The diagram or chart a right-click landed on, in the transcript or open in
 * the viewer. Inline SVG gets no "Copy image" from the browser, so these take
 * the app's own menu instead. A text selection inside keeps the browser's.
 */
export function contextMenuDiagramFor(target: Element): Element | null {
  const svg = target
    .closest?.(".md-mermaid, .md-chart-canvas, [data-lightbox-diagram]")
    ?.querySelector(":scope > svg");
  if (!svg || selectingIn(svg)) return null;
  return svg;
}

/**
 * Resolve the diagram a click is about. A live text selection inside the SVG
 * is copying, not an attempt to open the viewer. A chart is interactive in
 * place (tooltips, brushes, zoom), so only its expand button opens the
 * viewer; a click on the chart itself belongs to the chart.
 */
export function lightboxDiagramFor(target: Element): Element | null {
  const chart = target
    .closest?.(".md-chart-wrap")
    ?.querySelector(".md-chart-canvas > svg");
  if (chart) return target.closest?.("button.md-diagram-expand") ? chart : null;
  const svg = target
    .closest?.(".md-mermaid-wrap")
    ?.querySelector(".md-mermaid > svg");
  if (!svg) return null;
  if (target.closest?.("button.md-diagram-expand")) return svg;
  return selectingIn(svg) ? null : svg;
}
