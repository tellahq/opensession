/**
 * Selecting a region of an existing transcript image.
 *
 * Regions stay normalized while they are on screen. The lightbox can resize
 * when a phone keyboard opens, but 0..1 coordinates continue to name the same
 * pixels. The crop is only converted to intrinsic pixels when it is sent.
 */

export interface ImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageRegionPoint {
  x: number;
  y: number;
}

const MAX_CROP_EDGE = 2000;

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A drag in either direction, clamped to the image's normalized bounds. */
export function imageRegionBetween(
  start: ImageRegionPoint,
  end: ImageRegionPoint,
): ImageRegion {
  const ax = clampUnit(start.x);
  const ay = clampUnit(start.y);
  const bx = clampUnit(end.x);
  const by = clampUnit(end.y);
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

/** Pixel rectangle inside a decoded source. Every edge remains in bounds. */
export function imageRegionPixels(
  region: ImageRegion,
  naturalWidth: number,
  naturalHeight: number,
) {
  const sourceWidth = Math.max(1, Math.round(naturalWidth) || 1);
  const sourceHeight = Math.max(1, Math.round(naturalHeight) || 1);
  const x = Math.min(
    sourceWidth - 1,
    Math.max(0, Math.floor(clampUnit(region.x) * sourceWidth)),
  );
  const y = Math.min(
    sourceHeight - 1,
    Math.max(0, Math.floor(clampUnit(region.y) * sourceHeight)),
  );
  const right = Math.min(
    sourceWidth,
    Math.max(
      x + 1,
      Math.ceil(clampUnit(region.x + region.width) * sourceWidth),
    ),
  );
  const bottom = Math.min(
    sourceHeight,
    Math.max(
      y + 1,
      Math.ceil(clampUnit(region.y + region.height) * sourceHeight),
    ),
  );
  return { x, y, width: right - x, height: bottom - y };
}

/** Output size for the derived attachment. Large retina crops are reduced. */
export function imageRegionOutputSize(width: number, height: number) {
  const w = Math.max(1, Math.round(width) || 1);
  const h = Math.max(1, Math.round(height) || 1);
  const scale = Math.min(1, MAX_CROP_EDGE / Math.max(w, h));
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale,
  };
}

/** Which part of a committed selection a drag has hold of. */
export type RegionHandle =
  | "move"
  | "n"
  | "e"
  | "s"
  | "w"
  | "nw"
  | "ne"
  | "se"
  | "sw";

/** Slide a region without changing its size. It stops at the image edge rather
 *  than shrinking, so a selection cannot lose the thing it was drawn around. */
export function movedImageRegion(
  region: ImageRegion,
  dx: number,
  dy: number,
): ImageRegion {
  const width = Math.min(1, Math.max(0, region.width));
  const height = Math.min(1, Math.max(0, region.height));
  return {
    x: Math.min(1 - width, Math.max(0, region.x + dx)),
    y: Math.min(1 - height, Math.max(0, region.y + dy)),
    width,
    height,
  };
}

/** One axis of a resize: the untouched edge holds still, the dragged one moves.
 *  Dragging an edge past its opposite flips the region instead of collapsing
 *  it, which is what every selection tool does and what the hand expects. */
function spanFromAnchor(
  anchor: number,
  moving: number,
  min: number,
): [number, number] {
  const fixed = clampUnit(anchor);
  const floor = Math.min(1, Math.max(0, min));
  let edge = clampUnit(moving);
  if (Math.abs(edge - fixed) < floor) {
    edge = edge >= fixed ? fixed + floor : fixed - floor;
  }
  let left = Math.min(fixed, edge);
  let right = Math.max(fixed, edge);
  if (left < 0) {
    right -= left;
    left = 0;
  }
  if (right > 1) {
    left -= right - 1;
    right = 1;
  }
  return [Math.max(0, left), Math.min(1, right)];
}

/** Resize a region by dragging one of its edges or corners. */
export function resizedImageRegion(
  region: ImageRegion,
  handle: Exclude<RegionHandle, "move">,
  dx: number,
  dy: number,
  min: { x: number; y: number } = { x: 0, y: 0 },
): ImageRegion {
  const left = region.x;
  const right = region.x + region.width;
  const top = region.y;
  const bottom = region.y + region.height;
  const [x0, x1] = handle.includes("w")
    ? spanFromAnchor(right, left + dx, min.x)
    : handle.includes("e")
      ? spanFromAnchor(left, right + dx, min.x)
      : [clampUnit(left), clampUnit(right)];
  const [y0, y1] = handle.includes("n")
    ? spanFromAnchor(bottom, top + dy, min.y)
    : handle.includes("s")
      ? spanFromAnchor(top, bottom + dy, min.y)
      : [clampUnit(top), clampUnit(bottom)];
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * How far a resize handle steps out of the region it belongs to.
 *
 * A target big enough for a finger, centred on the corner of a small region,
 * covers the region. Rather than shrink it under what a finger can hit, the
 * handles step outward and frame the selection, leaving its middle free to
 * press. The step stays under half the target on purpose: the corner is the
 * point a person aims at, so the handle has to keep covering it. A gap there
 * turns their press into a brand new selection.
 */
export function regionHandleStep(
  hit: number,
  width: number,
  height: number,
): number {
  if (Math.min(width, height) >= hit * 2) return 0;
  return Math.round(hit * 0.42);
}

export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface AnchoredCommentPosition {
  left: number;
  top: number;
  placement: "below" | "above" | "clamped";
}

/**
 * Where the comment card sits relative to the region it is about.
 *
 * Directly under the selection, so the words and the pixels they describe read
 * as one thing. It flips above when the region sits low, and it never leaves
 * the viewport: a card that hangs off the edge of a phone takes the Send button
 * with it.
 */
export function anchoredCommentPosition(
  region: ScreenRect,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 10,
  margin = 12,
): AnchoredCommentPosition {
  const maxLeft = Math.max(margin, viewport.width - card.width - margin);
  const left = Math.min(Math.max(margin, region.left), maxLeft);
  const below = region.top + region.height + gap;
  if (below + card.height <= viewport.height - margin) {
    return { left, top: below, placement: "below" };
  }
  const above = region.top - gap - card.height;
  if (above >= margin) return { left, top: above, placement: "above" };
  return {
    left,
    top: Math.max(margin, viewport.height - card.height - margin),
    placement: "clamped",
  };
}

async function decodedImage(blob: Blob): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}> {
  const createBitmap = globalThis.createImageBitmap;
  if (createBitmap instanceof Function) {
    const bitmap = await createBitmap(blob);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  }

  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Could not read this image"));
      image.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Could not create the selected image")),
      "image/png",
    );
  });
}

/**
 * Fetch and crop an image into a normal PNG attachment.
 *
 * Internal transcript images use authenticated same-origin routes. An external
 * image only works when its host allows browser reads through CORS. A blocked
 * source fails plainly instead of silently sending the full image.
 */
export async function cropImageRegionFile(
  src: string,
  region: ImageRegion,
): Promise<File> {
  let response: Response;
  try {
    response = await fetch(src, { credentials: "same-origin" });
  } catch {
    throw new Error("This image cannot be selected from its source");
  }
  if (!response.ok) throw new Error("Could not load this image for selection");
  const blob = await response.blob();
  if (blob.type && !blob.type.startsWith("image/")) {
    throw new Error("This source is not an image");
  }

  const decoded = await decodedImage(blob);
  try {
    const crop = imageRegionPixels(region, decoded.width, decoded.height);
    const output = imageRegionOutputSize(crop.width, crop.height);
    const canvas = document.createElement("canvas");
    canvas.width = output.width;
    canvas.height = output.height;
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error("Image selection is unavailable in this browser");
    context.drawImage(
      decoded.source,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      output.width,
      output.height,
    );
    const result = await canvasBlob(canvas);
    return new File([result], `image-comment-${Date.now()}.png`, {
      type: "image/png",
    });
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("Could not create the selected image");
  } finally {
    decoded.close();
  }
}
