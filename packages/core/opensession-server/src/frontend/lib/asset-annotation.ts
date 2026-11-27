import type { AssetPreviewKind } from "./asset-preview";
import type {
  FrameRect,
  InspectReply,
  InspectedElement,
} from "./browser-annotation";

/**
 * Annotating a session asset: the Browser tab's comment layer, laid over an
 * asset preview instead of a framed page.
 *
 * Unlike a Browser page, an asset is this app's own file: an HTML asset is
 * framed same-origin and markdown or text renders in this document, so the
 * layer reads the element under a mark directly instead of asking the page.
 */

/** Kinds whose preview has something to point at. */
export function canAnnotateAsset(kind: AssetPreviewKind): boolean {
  return kind !== "audio" && kind !== "binary";
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function selectorPart(element: Element): string {
  let name = element.localName;
  if (element.id && /^[A-Za-z][\w-]*$/.test(element.id))
    return `${name}#${element.id}`;
  const classes = Array.from(element.classList)
    .filter((name) => /^[A-Za-z_-][\w-]*$/.test(name))
    .slice(0, 2);
  if (classes.length) name += `.${classes.join(".")}`;
  return name;
}

/** A short CSS path to `element`, stopping at `root` or the first id. The
 *  same shape the desktop app's frame responder answers with. */
export function selectorFor(element: Element, root?: Element | null): string {
  const parts: string[] = [];
  for (
    let node: Element | null = element;
    node && parts.length < 4;
    node = node.parentElement
  ) {
    if (node === root) break;
    const owner: Document = node.ownerDocument;
    if (node === owner.body || node === owner.documentElement) break;
    parts.unshift(selectorPart(node));
    if (node.id) break;
  }
  return clip(parts.join(" > ") || element.localName, 300);
}

function textOf(element: Element): string {
  // An element in a framed asset belongs to that frame's window, and so to
  // its HTMLElement rather than this one's.
  const view = element.ownerDocument.defaultView;
  const inner =
    view && element instanceof view.HTMLElement ? element.innerText : "";
  return clip(
    (
      element.getAttribute("aria-label") ||
      element.getAttribute("alt") ||
      element.getAttribute("placeholder") ||
      inner ||
      element.textContent ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim(),
    200,
  );
}

function describe(element: Element, rect: FrameRect, root?: Element | null) {
  return {
    selector: selectorFor(element, root),
    tag: element.localName.slice(0, 40),
    text: textOf(element),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  } satisfies InspectedElement;
}

/**
 * How much smaller than its own CSS pixels a frame is drawn: an inline HTML
 * asset renders at desktop width and is scaled down to fit the chat.
 */
function frameScale(frame: HTMLIFrameElement): number {
  const drawn = frame.getBoundingClientRect().width;
  return frame.offsetWidth > 0 && drawn > 0 ? drawn / frame.offsetWidth : 1;
}

/**
 * What is at `point` (layer pixels) in the preview under the layer.
 *
 * `host` is the preview's root. An HTML asset's frame is read in its own
 * pixels, which may be scaled against the layer's, and the element's box is
 * handed back in layer pixels. Anything else renders in this document, where
 * the layer itself is the top element and is skipped.
 */
export function inspectAssetPreview(
  host: HTMLElement | null,
  layer: HTMLElement | null,
  point: { x: number; y: number },
): InspectReply | null {
  if (!host || !layer) return null;
  const frame = host.querySelector("iframe");
  if (frame) {
    let document: Document | null = null;
    try {
      document = frame.contentDocument;
    } catch {
      return null;
    }
    const view = frame.contentWindow;
    if (!document || !view) return null;
    const origin = layer.getBoundingClientRect();
    const drawn = frame.getBoundingClientRect();
    const scale = frameScale(frame);
    const dx = drawn.left - origin.left;
    const dy = drawn.top - origin.top;
    const element = document.elementFromPoint(
      (point.x - dx) / scale,
      (point.y - dy) / scale,
    );
    const box = element?.getBoundingClientRect();
    return {
      type: "opensession:inspected",
      id: "",
      element:
        element && box
          ? describe(element, {
              x: dx + box.left * scale,
              y: dy + box.top * scale,
              width: box.width * scale,
              height: box.height * scale,
            })
          : null,
      scroll: { x: view.scrollX, y: view.scrollY },
      viewport: { width: view.innerWidth, height: view.innerHeight },
    };
  }
  const origin = layer.getBoundingClientRect();
  const element = layer.ownerDocument
    .elementsFromPoint(origin.left + point.x, origin.top + point.y)
    .find(
      (candidate) =>
        candidate !== host &&
        !layer.contains(candidate) &&
        host.contains(candidate),
    );
  const box = element?.getBoundingClientRect();
  const scroller = host.scrollHeight > host.clientHeight ? host : null;
  return {
    type: "opensession:inspected",
    id: "",
    element:
      element && box
        ? describe(
            element,
            {
              x: box.left - origin.left,
              y: box.top - origin.top,
              width: box.width,
              height: box.height,
            },
            host,
          )
        : null,
    scroll: { x: 0, y: scroller ? Math.round(scroller.scrollTop) : 0 },
    viewport: { width: origin.width, height: origin.height },
  };
}

/**
 * Scroll the preview under the layer: the layer takes the pointer, and a
 * long page or document must still be reachable while annotating. True when
 * something moved, so the caller keeps the wheel from also scrolling the chat.
 */
export function scrollAssetPreview(
  host: HTMLElement | null,
  dx: number,
  dy: number,
): boolean {
  if (!host) return false;
  const frame = host.querySelector("iframe");
  if (frame) {
    try {
      const view = frame.contentWindow;
      if (!view) return false;
      const before = [view.scrollX, view.scrollY];
      // The wheel moves what is drawn: a scaled page scrolls further in its
      // own pixels for the same distance on screen.
      const scale = frameScale(frame);
      view.scrollBy(dx / scale, dy / scale);
      return view.scrollX !== before[0] || view.scrollY !== before[1];
    } catch {
      return false;
    }
  }
  const before = [host.scrollLeft, host.scrollTop];
  host.scrollBy(dx, dy);
  return host.scrollLeft !== before[0] || host.scrollTop !== before[1];
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read the image"));
    image.src = src;
  });
}

/**
 * An image asset with the commented box outlined, at the image's own
 * resolution, or null when the mark is not on the picture. `box` is in layer
 * pixels; the image is wherever the preview letterboxed it.
 */
export async function captureMarkedImage(
  host: HTMLElement | null,
  layer: DOMRect,
  box: FrameRect,
): Promise<File | null> {
  const shown = host?.querySelector("img");
  if (!shown) return null;
  const rect = shown.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const image = await loadImage(shown.currentSrc || shown.src);
  const scale = image.naturalWidth / rect.width;
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0);
  const accent =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--blue")
      .trim() || "royalblue";
  context.strokeStyle = accent;
  context.lineWidth = Math.max(2, 3 * scale);
  context.strokeRect(
    (box.x + layer.left - rect.left) * scale,
    (box.y + layer.top - rect.top) * scale,
    box.width * scale,
    box.height * scale,
  );
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  return blob
    ? new File([blob], `asset-comment-${Date.now()}.png`, {
        type: "image/png",
      })
    : null;
}
