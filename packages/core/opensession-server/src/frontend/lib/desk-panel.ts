// The Desk's floating panel on desktop: where it sits, how big it is, and how
// a drag or a resize moves it. Pure geometry, so the hook that owns the
// pointer events (hooks/useDeskPanel) stays thin and this can be tested
// without a DOM.
//
// Placement is stored per browser in localStorage rather than through
// lib/user-pref: a panel position only means something on the screen it was
// dragged on, so syncing it across devices would land it off-screen elsewhere.

import { z } from "zod";

export interface DeskViewport {
  width: number;
  height: number;
}

export interface DeskPanelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type DeskCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/** Stored form: the nearest corner and the distance to it. Anchoring to a
 *  corner rather than keeping `left/top` is what keeps a panel parked in the
 *  bottom-right corner in that corner when the window grows, instead of
 *  drifting toward the middle of the page. */
export interface DeskPanelPlacement {
  corner: DeskCorner;
  /** Distance from the corner's vertical edge to the panel's nearest edge. */
  x: number;
  /** Distance from the corner's horizontal edge to the panel's nearest edge. */
  y: number;
  width: number;
  height: number;
}

/** The Desk trigger's inset from the window edge (lib/fab-classes), so the
 *  panel opens over the button that summoned it. */
export const DESK_PANEL_MARGIN = 18;
export const DESK_PANEL_MIN_WIDTH = 360;
export const DESK_PANEL_MIN_HEIGHT = 320;

export const DESK_PANEL_DEFAULT_PLACEMENT: DeskPanelPlacement = {
  corner: "bottom-right",
  x: DESK_PANEL_MARGIN,
  y: DESK_PANEL_MARGIN,
  width: 560,
  height: 600,
};

/** Compass names, the way the lightbox's region handles spell theirs. */
export type DeskResizeHandle =
  | "n"
  | "s"
  | "e"
  | "w"
  | "ne"
  | "nw"
  | "se"
  | "sw";

/** Inclusive clamp; the lower bound wins when the bounds cross. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(value, hi));
}

function maxWidth(viewport: DeskViewport): number {
  return Math.max(DESK_PANEL_MIN_WIDTH, viewport.width - 2 * DESK_PANEL_MARGIN);
}

function maxHeight(viewport: DeskViewport): number {
  return Math.max(
    DESK_PANEL_MIN_HEIGHT,
    viewport.height - 2 * DESK_PANEL_MARGIN,
  );
}

/** Keep the panel at least its minimum size, at most the viewport less its
 *  margin, and wholly on screen. */
export function clampDeskPanelRect(
  rect: DeskPanelRect,
  viewport: DeskViewport,
): DeskPanelRect {
  const width = clamp(rect.width, DESK_PANEL_MIN_WIDTH, maxWidth(viewport));
  const height = clamp(rect.height, DESK_PANEL_MIN_HEIGHT, maxHeight(viewport));
  const left = clamp(
    rect.left,
    DESK_PANEL_MARGIN,
    viewport.width - DESK_PANEL_MARGIN - width,
  );
  const top = clamp(
    rect.top,
    DESK_PANEL_MARGIN,
    viewport.height - DESK_PANEL_MARGIN - height,
  );
  return { left, top, width, height };
}

/** Where a stored placement lands in the current viewport. */
export function deskPanelRect(
  placement: DeskPanelPlacement,
  viewport: DeskViewport,
): DeskPanelRect {
  const { width, height } = placement;
  const left = placement.corner.endsWith("left")
    ? placement.x
    : viewport.width - placement.x - width;
  const top = placement.corner.startsWith("top")
    ? placement.y
    : viewport.height - placement.y - height;
  return clampDeskPanelRect({ left, top, width, height }, viewport);
}

/** The placement to store for a rect: anchored to whichever corner its centre
 *  is nearest, so it stays in that corner as the window changes size. */
export function placeDeskPanel(
  rect: DeskPanelRect,
  viewport: DeskViewport,
): DeskPanelPlacement {
  const r = clampDeskPanelRect(rect, viewport);
  const right = r.left + r.width / 2 > viewport.width / 2;
  const bottom = r.top + r.height / 2 > viewport.height / 2;
  return {
    corner: `${bottom ? "bottom" : "top"}-${right ? "right" : "left"}`,
    x: right ? viewport.width - r.left - r.width : r.left,
    y: bottom ? viewport.height - r.top - r.height : r.top,
    width: r.width,
    height: r.height,
  };
}

export function moveDeskPanel(
  rect: DeskPanelRect,
  dx: number,
  dy: number,
  viewport: DeskViewport,
): DeskPanelRect {
  return clampDeskPanelRect(
    { ...rect, left: rect.left + dx, top: rect.top + dy },
    viewport,
  );
}

/** Drag one edge or corner by (dx, dy). The opposite edge stays put, which is
 *  what makes a west or north drag move the panel's origin as it grows. */
export function resizeDeskPanel(
  rect: DeskPanelRect,
  handle: DeskResizeHandle,
  dx: number,
  dy: number,
  viewport: DeskViewport,
): DeskPanelRect {
  let { left, top, width, height } = rect;
  const right = left + width;
  const bottom = top + height;
  if (handle.includes("e")) {
    width = clamp(
      width + dx,
      DESK_PANEL_MIN_WIDTH,
      Math.min(maxWidth(viewport), viewport.width - DESK_PANEL_MARGIN - left),
    );
  }
  if (handle.includes("w")) {
    width = clamp(
      width - dx,
      DESK_PANEL_MIN_WIDTH,
      Math.min(maxWidth(viewport), right - DESK_PANEL_MARGIN),
    );
    left = right - width;
  }
  if (handle.includes("s")) {
    height = clamp(
      height + dy,
      DESK_PANEL_MIN_HEIGHT,
      Math.min(maxHeight(viewport), viewport.height - DESK_PANEL_MARGIN - top),
    );
  }
  if (handle.includes("n")) {
    height = clamp(
      height - dy,
      DESK_PANEL_MIN_HEIGHT,
      Math.min(maxHeight(viewport), bottom - DESK_PANEL_MARGIN),
    );
    top = bottom - height;
  }
  return { left, top, width, height };
}

export const DESK_PANEL_STORAGE_KEY = "opensession-desk-panel";

const placementSchema = z.object({
  corner: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]),
  x: z.number().finite().min(0),
  y: z.number().finite().min(0),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

/** The stored placement, or null for anything absent or malformed. */
export function decodeDeskPanelPlacement(
  raw: string | null | undefined,
): DeskPanelPlacement | null {
  if (!raw) return null;
  try {
    return placementSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function encodeDeskPanelPlacement(
  placement: DeskPanelPlacement,
): string {
  return JSON.stringify(placement);
}

// The Desk's dialog popup carries `data-desk-panel`; `data-open` is Base UI's
// own state attribute, present from the moment it opens until its exit
// animation begins, so a kept-mounted closed Desk does not match (the same
// trap lib/blocking-overlay guards against with `:not([hidden])`).
const OPEN_DESK_PANEL_SELECTOR = "[data-desk-panel][data-open]";

/** The Desk's popup while it is open, else null. */
export function openDeskPanel(root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(OPEN_DESK_PANEL_SELECTOR);
}

/** Whether the focused element is inside the Desk. A non-modal Desk shares
 *  the page with whatever you are working on, so "is it open" and "am I in
 *  it" are different questions. */
export function deskPanelOwnsFocus(
  panel: HTMLElement | null,
  active: Element | null = document.activeElement,
): boolean {
  return !!panel && !!active && panel.contains(active);
}

/** Put the caret in the Desk's composer, or on the panel when it has none. */
export function focusDeskPanel(panel: HTMLElement): void {
  (panel.querySelector<HTMLElement>("textarea") ?? panel).focus({
    preventScroll: true,
  });
}
