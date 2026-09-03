import React, {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  imageRegionBetween,
  movedImageRegion,
  regionHandleStep,
  resizedImageRegion,
  type ImageRegion,
  type ImageRegionPoint,
  type RegionHandle,
} from "../lib/image-region-comment";
import {
  DIAGRAM_PADDING,
  DISMISS_DISTANCE,
  DOUBLE_TAP_SCALE,
  MAX_SCALE,
  REGION_HANDLE_HIT,
  type MediaLightboxViewerProps,
} from "../lib/media-lightbox-viewer";
import { useIsPhone } from "./useIsPhone";

function parseRegionHandle(value: string | null): RegionHandle | null {
  switch (value) {
    case "move":
    case "n":
    case "e":
    case "s":
    case "w":
    case "nw":
    case "ne":
    case "se":
    case "sw":
      return value;
    default:
      return null;
  }
}

/**
 * The lightbox's zoom and gesture controller: pinch on touch (iOS PWA
 * included — pointer events + touch-action:none, no native gesture
 * dependence), double-tap/double-click to toggle, wheel/trackpad on desktop,
 * one-finger pan while zoomed. While comment mode is active the same pointer
 * state machine drives region selection instead, which is why that mode lives
 * here rather than in a second handler layered on top.
 */
export function useMediaZoomGesture({
  src,
  diagram,
  onTapBackdrop,
  onTapMedia,
  onZoomChange,
  onSwipe,
  onDismiss,
  onDragProgress,
  enterFrom = 0,
  commentMode = false,
  selection,
  onSelection,
  onSelectionRect,
  annotations = [],
}: Omit<
  MediaLightboxViewerProps,
  "viewTransitionName" | "onEditAnnotation" | "onDeleteAnnotation"
>) {
  const isPhone = useIsPhone();
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  /** The element the transform is written to, whichever kind is on screen. */
  const mediaEl = () => (diagram ? boxRef.current : imgRef.current);
  /** Cached layoutOrigin(), see there. Null means "measure on next read". */
  const layout = useRef<{ x: number; y: number; w: number; h: number } | null>(
    null,
  );
  const t = useRef({ s: 1, tx: 0, ty: 0 });
  /** The in-progress drag written to the wrapper: sideways for a page turn,
   * downwards for a dismissal. */
  const drag = useRef({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    moved: boolean;
    downTarget: EventTarget | null;
    downAt: number;
    p0: { x: number; y: number };
    t0: { s: number; tx: number; ty: number };
    d0: number;
    m0: { x: number; y: number };
    pinched: boolean;
    /** null while the drag's intent is still undecided. */
    swiping: boolean | null;
    /** Decided at the same moment as `swiping`, and never both. */
    dismissing: boolean;
  } | null>(null);
  const lastTap = useRef<{
    at: number;
    x: number;
    y: number;
    media: boolean;
  } | null>(null);
  const singleTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const zoomedRef = useRef(false);
  const [openAnnotation, setOpenAnnotation] = useState<string | null>(null);
  const regionGesture = useRef<
    | {
        kind: "create";
        pointerId: number;
        start: ImageRegionPoint;
        imageRect: DOMRect;
      }
    | {
        kind: "adjust";
        handle: RegionHandle;
        origin: ImageRegion;
        pointerId: number;
        start: ImageRegionPoint;
        imageRect: DOMRect;
      }
    | null
  >(null);
  const [draftRegion, setDraftRegion] = useState<ImageRegion | null>(null);
  const [imageBox, setImageBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
    /** The same box in viewport coordinates, for the fixed comment card. */
    viewLeft: number;
    viewTop: number;
  } | null>(null);
  /** A diagram's box, fitted to the surface. Unlike a photo, a chart has no
   * natural pixel size to hold it back — its viewBox is arbitrary units — so
   * it fills the room available rather than stopping at 1:1. Sized here in JS
   * rather than by CSS on the svg because the gesture code needs a real box
   * to measure the zoom and pan bounds against. */
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);

  function cancelSingleTap() {
    if (singleTapTimer.current === null) return;
    clearTimeout(singleTapTimer.current);
    singleTapTimer.current = null;
  }

  useEffect(() => cancelSingleTap, [src, commentMode]);

  useLayoutEffect(() => {
    if (!diagram) return;
    const measure = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const room = {
        w: wrap.clientWidth - DIAGRAM_PADDING * 2,
        h: wrap.clientHeight - DIAGRAM_PADDING * 2,
      };
      const scale = Math.min(room.w / diagram.size.w, room.h / diagram.size.h);
      if (!(scale > 0) || !Number.isFinite(scale)) return;
      setFit({
        w: Math.round(diagram.size.w * scale) + DIAGRAM_PADDING * 2,
        h: Math.round(diagram.size.h * scale) + DIAGRAM_PADDING * 2,
      });
      layout.current = null;
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [diagram]);

  function apply(animate = false) {
    const img = mediaEl();
    if (!img) return;
    const { s, tx, ty } = t.current;
    img.style.transition = animate ? "transform 0.18s ease-out" : "none";
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    const nextZoomed = s > 1;
    if (nextZoomed !== zoomedRef.current) {
      zoomedRef.current = nextZoomed;
      setZoomed(nextZoomed);
      onZoomChange(nextZoomed);
    }
  }

  /** The drag offset, written to the wrapper so it composes with the img's
   * own zoom transform instead of fighting it. A downward drag also shrinks
   * the picture, which is what makes it read as being put back rather than
   * slid aside. */
  function applyDrag(dx: number, dy = 0, animate = false) {
    drag.current = { x: dx, y: dy };
    const wrap = wrapRef.current;
    if (!wrap) return;
    wrap.style.transition = animate
      ? "transform 0.24s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.24s ease-out"
      : "none";
    const pull = Math.max(0, dy);
    const scale = 1 - Math.min(pull / 1600, 0.12);
    wrap.style.transform =
      dx || dy ? `translate(${dx}px, ${dy}px) scale(${scale})` : "";
    // A touch of fade sells the hand-off; the picture stays legible enough
    // to see what you are dragging towards, or away from.
    const fade = Math.min(Math.abs(dx) / 900, 0.3) + Math.min(pull / 700, 0.45);
    wrap.style.opacity = dx || dy ? String(1 - fade) : "1";
    onDragProgress?.(Math.min(pull / DISMISS_DISTANCE, 1));
  }

  // The item is keyed by src, so a page turn mounts a fresh surface: slide it
  // in from the side the drag was heading, which is the only cue that the
  // picture changed rather than reloaded.
  // Interaction helpers are read through effect events so the effects that
  // reach them keep their narrow triggers without listing unstable closures.
  const effectApplyDrag = useEffectEvent(applyDrag);
  const effectZoomAt = useEffectEvent(zoomAt);
  const effectOnZoomChange = useEffectEvent(onZoomChange);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!enterFrom || !wrap) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // The wrapper is translated for the length of this, so the img's rect is
    // in motion and must not be cached from it.
    layout.current = null;
    effectApplyDrag(enterFrom * Math.min(140, window.innerWidth * 0.25));
    const frame = requestAnimationFrame(() => effectApplyDrag(0, 0, true));
    return () => cancelAnimationFrame(frame);
  }, [enterFrom, src]);

  /** The img's layout (untransformed) viewport rect — transform-origin is 0 0,
   * so the rendered top-left is layout top-left + current translation.
   *
   * Cached, because reading it is a layout read and the callers sit between
   * transform writes: measuring per pointer event forces a synchronous reflow
   * on every frame of a pinch or pan, at up to the pointer's rate. The value
   * it returns is by construction independent of the transform, so nothing
   * a gesture does can invalidate it — only a real layout change can. */
  function layoutOrigin() {
    if (layout.current) return layout.current;
    const img = mediaEl()!;
    const r = img.getBoundingClientRect();
    const { s, tx, ty } = t.current;
    return (layout.current = {
      x: r.left - tx,
      y: r.top - ty,
      w: r.width / s,
      h: r.height / s,
    });
  }
  // The picture's box moves with the viewport, and moves again when a new src
  // decodes at a different aspect. Each gesture also re-measures on its first
  // press: the wrapper carries the page-turn translation, so a box read while
  // that is running describes where the picture was, not where it settles.
  useEffect(() => {
    const forget = () => {
      layout.current = null;
    };
    window.addEventListener("resize", forget);
    return () => window.removeEventListener("resize", forget);
  }, []);
  useEffect(() => {
    layout.current = null;
  }, [src]);

  // Chrome visibility changes the fitted room on a phone. Forget the old
  // geometry throughout that refit so the next pan or zoom starts from what is
  // actually on screen.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() => {
      layout.current = null;
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // A region is stored against the image, while its outline is painted against
  // the lightbox wrapper. Keep that projection current when a phone keyboard,
  // a rotation, or a decoded image changes the fitted box.
  useLayoutEffect(() => {
    if ((!commentMode && annotations.length === 0) || diagram) {
      setImageBox(null);
      return;
    }
    // Reset before measuring. A transformed getBoundingClientRect would map
    // the selection against the old zoom level until the next resize.
    t.current = { s: 1, tx: 0, ty: 0 };
    const media = diagram ? boxRef.current : imgRef.current;
    if (media) {
      media.style.transition = "none";
      media.style.transform = "translate(0px, 0px) scale(1)";
    }
    if (zoomedRef.current) {
      zoomedRef.current = false;
      setZoomed(false);
      effectOnZoomChange(false);
    }
    const measure = () => {
      const wrap = wrapRef.current;
      const image = imgRef.current;
      if (!wrap || !image || !image.complete) return;
      const wrapRect = wrap.getBoundingClientRect();
      const imageRect = image.getBoundingClientRect();
      const next = {
        left: imageRect.left - wrapRect.left,
        top: imageRect.top - wrapRect.top,
        width: imageRect.width,
        height: imageRect.height,
        viewLeft: imageRect.left,
        viewTop: imageRect.top,
      };
      setImageBox((current) =>
        current &&
        Math.abs(current.left - next.left) < 0.25 &&
        Math.abs(current.top - next.top) < 0.25 &&
        Math.abs(current.width - next.width) < 0.25 &&
        Math.abs(current.height - next.height) < 0.25 &&
        Math.abs(current.viewLeft - next.viewLeft) < 0.25 &&
        Math.abs(current.viewTop - next.viewTop) < 0.25
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (wrapRef.current) observer.observe(wrapRef.current);
    if (imgRef.current) observer.observe(imgRef.current);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [commentMode, diagram, src, annotations.length]);

  // Selection needs the fitted, untransformed image. Entering comment mode
  // returns a zoomed or panned image to fit before the first drag.
  useEffect(() => {
    if (!commentMode) {
      regionGesture.current = null;
      setDraftRegion(null);
      return;
    }
    pointers.current.clear();
    gesture.current = null;
    lastTap.current = null;
    cancelSingleTap();
  }, [commentMode, src]);

  /** Keep the scaled image covering the viewport (or centered when smaller).
   * Bounds are the full screen, not the letterboxed wrapper — a zoomed photo
   * should spread under the floating chrome like a native photo viewer, not
   * clip at the wrapper edges. */
  function clamp(next: { s: number; tx: number; ty: number }) {
    if (!mediaEl()) return next;
    const C = {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    };
    const o = layoutOrigin();
    const clampAxis = (
      pos: number, // desired translation on this axis
      origin: number,
      size: number,
      cStart: number,
      cSize: number,
    ) => {
      const scaled = size * next.s;
      if (scaled <= cSize) return cStart + (cSize - scaled) / 2 - origin;
      const min = cStart + cSize - scaled - origin;
      const max = cStart - origin;
      return Math.min(max, Math.max(min, pos));
    };
    return {
      s: next.s,
      tx: clampAxis(next.tx, o.x, o.w, C.left, C.width),
      ty: clampAxis(next.ty, o.y, o.h, C.top, C.height),
    };
  }

  /** Rescale to `sNew` keeping the viewport point `p` fixed on the image. */
  function zoomAt(p: { x: number; y: number }, sNew: number, animate = false) {
    const o = layoutOrigin();
    const { s, tx, ty } = t.current;
    const ux = (p.x - o.x - tx) / s;
    const uy = (p.y - o.y - ty) / s;
    t.current = clamp({
      s: sNew,
      tx: p.x - o.x - ux * sNew,
      ty: p.y - o.y - uy * sNew,
    });
    if (t.current.s <= 1.02) t.current = { s: 1, tx: 0, ty: 0 };
    apply(animate);
  }

  function pointInRegionImage(
    x: number,
    y: number,
    rect: DOMRect,
  ): ImageRegionPoint {
    return {
      x: Math.min(1, Math.max(0, (x - rect.left) / Math.max(1, rect.width))),
      y: Math.min(1, Math.max(0, (y - rect.top) / Math.max(1, rect.height))),
    };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (commentMode && !diagram) {
      const image = imgRef.current;
      if (!image || e.button !== 0 || !e.isPrimary || regionGesture.current)
        return;
      const rect = image.getBoundingClientRect();
      // A press on the selection itself moves it, and one on a handle
      // resizes it. Read from the target rather than from coordinates: the
      // handles deliberately overhang the region so a thin selection still
      // has something to take hold of.
      const handle = parseRegionHandle(
        e.target instanceof Element
          ? (e.target
              .closest("[data-region-handle]")
              ?.getAttribute("data-region-handle") ?? null)
          : null,
      );
      // A corner handle sits half outside the picture, so only a fresh
      // selection has to start inside it.
      if (
        !handle &&
        (e.clientX < rect.left ||
          e.clientX > rect.right ||
          e.clientY < rect.top ||
          e.clientY > rect.bottom)
      )
        return;
      e.preventDefault();
      wrapRef.current?.setPointerCapture(e.pointerId);
      const start = pointInRegionImage(e.clientX, e.clientY, rect);
      if (handle && selection) {
        regionGesture.current = {
          kind: "adjust",
          handle,
          origin: selection,
          pointerId: e.pointerId,
          start,
          imageRect: rect,
        };
        setDraftRegion(selection);
        return;
      }
      regionGesture.current = {
        kind: "create",
        pointerId: e.pointerId,
        start,
        imageRect: rect,
      };
      setDraftRegion(imageRegionBetween(start, start));
      return;
    }
    // A second interaction cancels a pending single tap. If this press is the
    // second half of a double tap, pointer-up below will zoom instead.
    cancelSingleTap();
    // One measurement per gesture: nothing that happens between here and the
    // last finger up can move the picture's layout box.
    layout.current = null;
    wrapRef.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length === 2) {
      gesture.current = {
        ...(gesture.current || {
          moved: false,
          downTarget: e.target,
          downAt: performance.now(),
        }),
        moved: gesture.current?.moved || false,
        downTarget: gesture.current?.downTarget ?? e.target,
        downAt: gesture.current?.downAt ?? performance.now(),
        p0: pts[0],
        t0: { ...t.current },
        d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        m0: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
        pinched: true,
        swiping: false,
        dismissing: false,
      };
      // A second finger means this was never a page turn or a dismissal.
      if (drag.current.x || drag.current.y) applyDrag(0, 0, true);
    } else if (pts.length === 1) {
      gesture.current = {
        moved: false,
        downTarget: e.target,
        downAt: performance.now(),
        p0: pts[0],
        t0: { ...t.current },
        d0: 0,
        m0: pts[0],
        pinched: false,
        swiping: null,
        dismissing: false,
      };
    }
  }

  /** The region this gesture describes with the pointer where it now is. */
  function regionForGesture(
    selecting: NonNullable<typeof regionGesture.current>,
    clientX: number,
    clientY: number,
  ): ImageRegion {
    const point = pointInRegionImage(clientX, clientY, selecting.imageRect);
    if (selecting.kind === "create") {
      return imageRegionBetween(selecting.start, point);
    }
    const dx = point.x - selecting.start.x;
    const dy = point.y - selecting.start.y;
    if (selecting.handle === "move") {
      return movedImageRegion(selecting.origin, dx, dy);
    }
    // The same twelve display pixels a new selection has to clear, so a
    // region cannot be resized into something too small to have drawn.
    return resizedImageRegion(selecting.origin, selecting.handle, dx, dy, {
      x: 12 / Math.max(1, selecting.imageRect.width),
      y: 12 / Math.max(1, selecting.imageRect.height),
    });
  }

  function onPointerMove(e: React.PointerEvent) {
    const selecting = regionGesture.current;
    if (selecting?.pointerId === e.pointerId) {
      const next = regionForGesture(selecting, e.clientX, e.clientY);
      setDraftRegion(next);
      // An adjustment changes a region that already has a comment against
      // it, so the card travels with the pixels it is about.
      if (selecting.kind === "adjust") onSelection?.(next);
      return;
    }
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const pts = [...pointers.current.values()];
    if (g.pinched && pts.length >= 2) {
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const m = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      // No clamping mid-pinch — fighting the fingers makes the image slide
      // away from the focal point. Bounds are re-imposed on release.
      const sNew = Math.min(
        MAX_SCALE,
        Math.max(0.5, (g.t0.s * d) / (g.d0 || 1)),
      );
      const o = layoutOrigin();
      const ux = (g.m0.x - o.x - g.t0.tx) / g.t0.s;
      const uy = (g.m0.y - o.y - g.t0.ty) / g.t0.s;
      t.current = {
        s: sNew,
        tx: m.x - o.x - ux * sNew,
        ty: m.y - o.y - uy * sNew,
      };
      apply();
      g.moved = true;
    } else if (pts.length === 1) {
      const p = pts[0];
      const dx = p.x - g.p0.x;
      const dy = p.y - g.p0.y;
      if (Math.hypot(dx, dy) > 6) {
        g.moved = true;
        cancelSingleTap();
      }
      if (t.current.s > 1 && !g.pinched) {
        t.current = clamp({ s: g.t0.s, tx: g.t0.tx + dx, ty: g.t0.ty + dy });
        apply();
      } else if ((onSwipe || onDismiss) && !g.pinched && t.current.s === 1) {
        // Decide once, at the threshold: a drag that starts out mostly
        // sideways pages to the neighbouring item, one that starts out
        // vertical puts the picture back. Deciding once means the intent
        // can't flip mid-gesture.
        if (g.swiping === null && Math.hypot(dx, dy) > 8) {
          const sideways = Math.abs(dx) > Math.abs(dy) * 1.2;
          g.swiping = !!onSwipe && sideways;
          g.dismissing = !!onDismiss && !sideways && e.pointerType !== "mouse";
        }
        if (g.swiping) applyDrag(dx);
        // Up is not a dismissal, so it only rubber-bands.
        else if (g.dismissing) applyDrag(dx, dy > 0 ? dy : dy / 3);
      }
    }
  }

  function clearRegionGesture(pointerId: number): boolean {
    if (regionGesture.current?.pointerId !== pointerId) return false;
    regionGesture.current = null;
    setDraftRegion(null);
    return true;
  }

  function onPointerCancel(e: React.PointerEvent) {
    cancelSingleTap();
    lastTap.current = null;
    if (clearRegionGesture(e.pointerId)) return;
    // Settle the transform without letting a canceled gesture page or count as
    // a tap. A pointer capture can be canceled by app switching or a browser
    // gesture even when the finger barely moved.
    if (gesture.current) {
      gesture.current.moved = true;
      gesture.current.swiping = false;
      gesture.current.dismissing = false;
    }
    if (drag.current.x || drag.current.y) applyDrag(0, 0, true);
    onPointerEnd(e);
  }

  /** Commit both the normalized region and its viewport box in the same event.
   * Waiting for the post-render imageBox effect made the first drag race image
   * decode/hero layout, so the field sometimes appeared only after a redraw. */
  function commitRegion(region: ImageRegion, imageRect: DOMRect) {
    onSelection?.(region);
    onSelectionRect?.({
      left: imageRect.left + region.x * imageRect.width,
      top: imageRect.top + region.y * imageRect.height,
      width: region.width * imageRect.width,
      height: region.height * imageRect.height,
    });
  }

  const onPointerEnd = (e: React.PointerEvent) => {
    const selecting = regionGesture.current;
    if (selecting?.pointerId === e.pointerId) {
      const region = regionForGesture(selecting, e.clientX, e.clientY);
      clearRegionGesture(e.pointerId);
      // Twelve display pixels filters taps and shaky starts without making a
      // small button impossible to select. An adjustment is already bounded.
      if (
        selecting.kind === "adjust" ||
        (region.width * selecting.imageRect.width >= 12 &&
          region.height * selecting.imageRect.height >= 12)
      ) {
        commitRegion(region, selecting.imageRect);
      }
      return;
    }
    if (!pointers.current.has(e.pointerId)) return;
    const p = { x: e.clientX, y: e.clientY };
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    const remaining = [...pointers.current.values()];
    if (remaining.length === 1) {
      // Pinch → one finger left: re-anchor so it pans from here.
      g.p0 = remaining[0];
      g.t0 = { ...t.current };
      g.pinched = false;
      g.moved = true;
      return;
    }
    if (remaining.length > 0) return;
    // A page drag resolves on its own terms: past a fifth of the screen, or
    // a flick of any size, hands over to the neighbouring item — otherwise
    // the picture slides back and nothing changed.
    if (g.swiping) {
      const dx = p.x - g.p0.x;
      const speed = Math.abs(dx) / Math.max(1, performance.now() - g.downAt);
      gesture.current = null;
      if (
        Math.abs(dx) > Math.min(120, window.innerWidth * 0.2) ||
        (speed > 0.45 && Math.abs(dx) > 24)
      ) {
        onSwipe?.(dx < 0 ? 1 : -1);
      } else {
        applyDrag(0, 0, true);
      }
      return;
    }
    // A drag downwards resolves on the same terms as a page turn: past a
    // fifth of the screen, or a flick of any size, closes — otherwise the
    // picture springs back and nothing changed.
    if (g.dismissing) {
      const dy = p.y - g.p0.y;
      const speed = dy / Math.max(1, performance.now() - g.downAt);
      gesture.current = null;
      if (
        dy > Math.min(DISMISS_DISTANCE, window.innerHeight * 0.2) ||
        (speed > 0.5 && dy > 32)
      ) {
        onDismiss?.();
      } else {
        applyDrag(0, 0, true);
      }
      return;
    }
    // Last pointer up — settle back inside bounds (animated) and check taps.
    if (t.current.s <= 1.05) {
      t.current = { s: 1, tx: 0, ty: 0 };
      apply(true);
    } else {
      t.current = clamp({ ...t.current });
      apply(true);
    }
    const isTap =
      !g.moved && e.pointerType !== "mouse"
        ? performance.now() - g.downAt < 400
        : !g.moved; // mouse: any clean click counts
    gesture.current = null;
    if (!isTap) return;
    const mediaTap = g.downTarget === imgRef.current;
    const prevTap = lastTap.current;
    lastTap.current = {
      at: performance.now(),
      x: p.x,
      y: p.y,
      media: mediaTap,
    };
    const isDouble =
      mediaTap &&
      prevTap?.media &&
      performance.now() - prevTap.at < 300 &&
      Math.hypot(p.x - prevTap.x, p.y - prevTap.y) < 40;
    if (isDouble) {
      lastTap.current = null;
      cancelSingleTap();
      zoomAt(p, t.current.s > 1 ? 1 : DOUBLE_TAP_SCALE, true);
      return;
    }
    if (mediaTap && onTapMedia) {
      singleTapTimer.current = setTimeout(() => {
        singleTapTimer.current = null;
        onTapMedia();
      }, 300);
      return;
    }
    // A clean tap beside the media keeps the existing backdrop behavior.
    if (g.downTarget === wrapRef.current && t.current.s === 1) onTapBackdrop();
  };

  // Wheel/trackpad zoom. Native non-passive listener — React's onWheel can be
  // passive, and preventDefault must win or the page behind rubber-bands.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const sNew = Math.min(
        MAX_SCALE,
        Math.max(1, t.current.s * Math.exp(-e.deltaY * 0.0022)),
      );
      effectZoomAt({ x: e.clientX, y: e.clientY }, sNew);
    }
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, []);

  // The comment belongs against the region it is about, so the viewer reports
  // where that region landed. Viewport coordinates rather than wrapper ones:
  // the wrapper carries the page-turn translation, and the card is fixed.
  useEffect(() => {
    if (!onSelectionRect) return;
    if (!commentMode || !selection || !imageBox) {
      onSelectionRect(null);
      return;
    }
    onSelectionRect({
      left: imageBox.viewLeft + selection.x * imageBox.width,
      top: imageBox.viewTop + selection.y * imageBox.height,
      width: selection.width * imageBox.width,
      height: selection.height * imageBox.height,
    });
  }, [commentMode, selection, imageBox, onSelectionRect]);

  const handleHit = isPhone
    ? REGION_HANDLE_HIT.phone
    : REGION_HANDLE_HIT.desktop;
  const shownRegion = draftRegion ?? selection ?? null;
  const shownRegionBox =
    shownRegion && imageBox
      ? {
          left: imageBox.left + shownRegion.x * imageBox.width,
          top: imageBox.top + shownRegion.y * imageBox.height,
          width: shownRegion.width * imageBox.width,
          height: shownRegion.height * imageBox.height,
        }
      : null;

  // A handle centred on the corner of a small region covers the region. Rather
  // than shrink the target below what a finger can hit, step the handles
  // outward so they frame the selection and leave its middle free to press.
  // Large regions keep them on the corners, which is where the eye expects.
  const handlesOutside =
    !!shownRegionBox &&
    Math.min(shownRegionBox.width, shownRegionBox.height) < handleHit * 2;
  const handleStep = shownRegionBox
    ? regionHandleStep(handleHit, shownRegionBox.width, shownRegionBox.height)
    : 0;

  function onMediaLoad() {
    layout.current = null;
  }

  return {
    wrapRef,
    imgRef,
    boxRef,
    fit,
    zoomed,
    imageBox,
    openAnnotation,
    setOpenAnnotation,
    shownRegionBox,
    handlesOutside,
    handleHit,
    handleStep,
    onPointerDown,
    onPointerMove,
    onPointerEnd,
    onPointerCancel,
    onMediaLoad,
  };
}
