import { useEffect, useRef, useState, type RefObject } from "react";

import {
  DESK_PANEL_DEFAULT_PLACEMENT,
  DESK_PANEL_STORAGE_KEY,
  decodeDeskPanelPlacement,
  deskPanelRect,
  encodeDeskPanelPlacement,
  moveDeskPanel,
  placeDeskPanel,
  resizeDeskPanel,
  type DeskCorner,
  type DeskPanelPlacement,
  type DeskPanelRect,
  type DeskResizeHandle,
  type DeskViewport,
} from "../lib/desk-panel";

export interface DeskPanelController {
  /** Where the panel is right now, in viewport pixels. */
  rect: DeskPanelRect;
  /** The corner the panel is parked in. */
  corner: DeskCorner;
  startMove: (event: React.PointerEvent<HTMLElement>) => void;
  startResize: (
    handle: DeskResizeHandle,
    cursor: string,
    event: React.PointerEvent<HTMLElement>,
  ) => void;
}

function readViewport(): DeskViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function readPlacement(): DeskPanelPlacement {
  return (
    decodeDeskPanelPlacement(localStorage.getItem(DESK_PANEL_STORAGE_KEY)) ??
    DESK_PANEL_DEFAULT_PLACEMENT
  );
}

/**
 * Position and size for the desktop Desk panel. The stored placement is
 * anchored to a corner (lib/desk-panel), and the viewport is re-read on
 * resize while `enabled`, so a parked panel follows its corner.
 *
 * A drag paints the popup's inline style straight from the pointer, the way
 * SessionSplit drags its divider, and commits to state once on release: the
 * conversation inside is a live transcript, and re-rendering it sixty times a
 * second for a move it does not take part in is work for nothing.
 *
 * `panelRef` is the popup a drag paints. The caller owns it (and passes it to
 * the popup) rather than this hook returning it: a returned ref makes the
 * React Compiler treat the whole controller as a ref, and refuse to read its
 * rect during render.
 */
export function useDeskPanel(
  enabled: boolean,
  panelRef: RefObject<HTMLDivElement | null>,
): DeskPanelController {
  const [placement, setPlacement] = useState(readPlacement);
  const [viewport, setViewport] = useState(readViewport);

  useEffect(() => {
    if (!enabled) return;
    const onResize = () => setViewport(readViewport());
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [enabled]);

  const rect = deskPanelRect(placement, viewport);

  // The active drag's cancel, so an unmount mid-drag leaves nothing behind.
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);

  function commit(next: DeskPanelRect) {
    const stored = placeDeskPanel(next, readViewport());
    setPlacement(stored);
    try {
      localStorage.setItem(
        DESK_PANEL_STORAGE_KEY,
        encodeDeskPanelPlacement(stored),
      );
    } catch {
      // A full or disabled store only loses the position for next time.
    }
  }

  function beginDrag(
    event: React.PointerEvent<HTMLElement>,
    cursor: string,
    apply: (dx: number, dy: number) => DeskPanelRect,
  ) {
    if (event.button !== 0) return;
    const node = panelRef.current;
    if (!node) return;
    event.preventDefault();
    stopRef.current?.();

    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const origin = { x: event.clientX, y: event.clientY };
    const paint = (r: DeskPanelRect) => {
      node.style.left = `${r.left}px`;
      node.style.top = `${r.top}px`;
      node.style.width = `${r.width}px`;
      node.style.height = `${r.height}px`;
    };
    // The document owns the cursor for the whole drag: the pointer routinely
    // outruns a 6px handle, and without this it flickers back to a caret over
    // the transcript it crosses. Selection is off for the same reason.
    const body = document.body;
    const previous = {
      cursor: body.style.cursor,
      select: body.style.userSelect,
    };
    body.style.cursor = cursor;
    body.style.userSelect = "none";
    // Capture keeps the moves coming to the handle even once the pointer has
    // left it, and lets the panel's own content stay out of the way.
    handle.setPointerCapture(pointerId);

    let next = rect;
    const move = (e: PointerEvent) => {
      next = apply(e.clientX - origin.x, e.clientY - origin.y);
      paint(next);
    };
    const cleanup = () => {
      body.style.cursor = previous.cursor;
      body.style.userSelect = previous.select;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", cancel);
      if (handle.hasPointerCapture(pointerId))
        handle.releasePointerCapture(pointerId);
      stopRef.current = null;
    };
    const stop = () => {
      cleanup();
      commit(next);
    };
    const cancel = () => {
      cleanup();
      paint(rect);
    };
    stopRef.current = cancel;
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", cancel);
  }

  return {
    rect,
    corner: placement.corner,
    startMove: (event) =>
      beginDrag(event, "grabbing", (dx, dy) =>
        moveDeskPanel(rect, dx, dy, readViewport()),
      ),
    startResize: (handle, cursor, event) =>
      beginDrag(event, cursor, (dx, dy) =>
        resizeDeskPanel(rect, handle, dx, dy, readViewport()),
      ),
  };
}
