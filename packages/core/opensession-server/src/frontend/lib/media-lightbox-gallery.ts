import { diagramDataUrl, readDiagramSvg } from "./diagram-media";
import {
  commentSessionIdFor,
  openLightbox,
  type LightboxItem,
} from "./media-lightbox";

/** Every piece of session media currently in the DOM, in document order. */
export const GALLERY_SELECTOR =
  "img.md-image, video.md-video, .md-mermaid > svg";

/** Apple's page control keeps a small moving window for long galleries. */
export const MAX_VISIBLE_LIGHTBOX_DOTS = 7;

/** Quiet top-cluster actions shared by Download, Copy link, and Open. */
export const LIGHTBOX_ACTION_CLASS = "shrink-0 cursor-pointer";
export const LIGHTBOX_PREVIEW_LABEL: Record<LightboxItem["kind"], string> = {
  image: "Image preview",
  video: "Video preview",
  diagram: "Diagram preview",
};

/** One node as an item, or null when it cannot be shown. */
function galleryItem(node: Element): LightboxItem | null {
  if (node.tagName === "IMG" || node.tagName === "VIDEO") {
    const media = node as HTMLImageElement | HTMLVideoElement;
    return {
      kind: node.tagName === "VIDEO" ? "video" : "image",
      src:
        node.tagName === "IMG"
          ? (media as HTMLImageElement).currentSrc || media.src
          : media.src,
      commentSessionId:
        node.tagName === "IMG" ? commentSessionIdFor(node) : undefined,
      sessionTitle: (node as HTMLImageElement).alt?.trim() || undefined,
    };
  }
  const diagram = readDiagramSvg(node.outerHTML);
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
 * Resolve the diagram a click is about. A live text selection inside the SVG
 * is copying, not an attempt to open the viewer.
 */
export function lightboxDiagramFor(target: Element): Element | null {
  const svg = target
    .closest?.(".md-mermaid-wrap")
    ?.querySelector(".md-mermaid > svg");
  if (!svg) return null;
  if (target.closest?.("button.md-diagram-expand")) return svg;
  const selection = window.getSelection();
  const selecting =
    selection &&
    !selection.isCollapsed &&
    selection.anchorNode &&
    svg.contains(selection.anchorNode);
  return selecting ? null : svg;
}
