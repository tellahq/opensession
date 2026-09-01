import { useEffect, useLayoutEffect, useRef } from "react";

import { PHONE_QUERY } from "../lib/breakpoints";

/**
 * iOS-style edge-swipe-to-go-back for the mobile page stack, plus a permanent
 * guard against the browser's own history-navigation gesture. On phones the
 * sidebar is the root page and a session/view is pushed over it (see the
 * `.mobile-detail` rules in legacy.css); overlays (the workspace/right panel,
 * the session info page) stack further layers on top. A drag that STARTS near
 * the left edge pulls the topmost active layer's pane to the right under the
 * finger and, past the halfway point, pops it (calls its `onBack`).
 *
 * Several components mount this hook at once, so it's a module-level manager
 * rather than per-instance listeners: every mounted instance registers a
 * layer, one shared set of document listeners arbitrates, and the gesture goes
 * to the highest-`priority` layer whose `active` is true (App's page stack is
 * 0; overlays register higher). Registration order can't express that stacking
 * because React runs child effects before parent effects.
 *
 * The guard is deliberately NOT gated on any layer being active: as long as
 * one instance is mounted (App's always is), a touch starting in the edge zone
 * is preventDefault-ed even when there's nothing to pop — e.g. on the home
 * root or under the phone Settings sheet. Before this, those states had no
 * listener at all and an edge swipe fell through to the browser's native
 * back/forward navigation, kicking the user out of the app's history.
 *
 * - Only reacts at mobile widths; desktop touches pass straight through.
 * - Must start within EDGE px of the left edge, so it doesn't hijack
 *   horizontal scrolling inside diffs/code.
 * - Vertical-dominant (or leftward) moves abort immediately, leaving normal
 *   scrolling alone.
 *
 * Stranded gestures. WebKit keeps dispatching a touch's move/end events to the
 * element the touch STARTED on even after that element leaves the DOM — and a
 * detached node has no ancestors, so those events never reach these document
 * listeners. Message bodies render through `dangerouslySetInnerHTML`
 * (MarkdownBody), so a streaming update replaces every node under the finger:
 * the drag would then never end and the pane sat frozen on its inline
 * transform, half-swiped and stuck. Three defences, cheapest first: the
 * per-gesture listeners are mirrored onto the start target (orphaned events
 * still land), a stall timer abandons a drag that goes silent, and any fresh
 * touch heals a pane that somehow still carries a drag transform.
 */
interface Opts {
  /** This layer is currently showing and may be popped by the swipe. */
  active: boolean;
  /** Pop this layer — navigate back / close the overlay. */
  onBack: () => void;
  /** The pane to drag. A `{current}` getter object works too. */
  paneRef: { current: HTMLElement | null };
  /**
   * Stacking order among simultaneously-active layers; highest wins the
   * gesture (ties go to the most recently mounted). App's page stack is 0.
   */
  priority?: number;
}

const EDGE = 32; // px from the left that may begin a back drag
const SLOP = 8; // px of movement before committing to an axis
const SNAP_MS = 260; // matches the CSS page transition
const FLICK_VX = 0.35; // px/ms rightward at release that pops even a short drag
const STALL_MS = 1500; // silence on a committed drag that means the touch is gone

interface Layer {
  seq: number;
  priority: number;
  activeRef: { current: boolean };
  onBackRef: { current: () => void };
  paneRef: { current: HTMLElement | null };
}

const layers = new Set<Layer>();
let seqCounter = 0;
let installed = false;

// ── Shared gesture state (one gesture at a time) ──────────────────────────
let handler: Layer | null = null; // layer that owns the current gesture
let startX = 0;
let startY = 0;
let width = 0;
let candidate = false; // touch began in the left-edge zone
let dragging = false; // committed to a horizontal drag
let startTarget: EventTarget | null = null;
let lastX = 0;
let lastT = 0;
let vx = 0; // smoothed horizontal velocity, px/ms (+ = rightward)
let mirrorTarget: EventTarget | null = null; // node carrying the mirrored listeners
let lastHandled: TouchEvent | null = null; // dedupes target-phase vs. document
let stallTimer: ReturnType<typeof setTimeout> | null = null;
let settleSeq = 0; // so a stale settle can't reset a newer gesture's transform

function topLayer(): Layer | null {
  let best: Layer | null = null;
  for (const l of layers) {
    if (!l.activeRef.current) continue;
    if (
      !best ||
      l.priority > best.priority ||
      (l.priority === best.priority && l.seq > best.seq)
    ) {
      best = l;
    }
  }
  return best;
}

function pane(): HTMLElement | null {
  return handler ? handler.paneRef.current : null;
}

function setTransform(px: number) {
  const el = pane();
  if (!el) return;
  el.style.transition = "none";
  el.style.transform = `translateX(${px}px)`;
}

function resetPaneStyles(el: HTMLElement | null) {
  if (!el) return;
  el.style.transition = "";
  el.style.transform = "";
}

// Mirror the per-gesture listeners onto the node the touch started on, so a
// touch orphaned by that node's removal still reports its moves and its end.
// Both copies fire in the ordinary case (target phase, then document), which
// `lastHandled` collapses back to one.
function mirrorOn(target: EventTarget | null) {
  unmirror();
  if (!target || target === document || target === window) return;
  mirrorTarget = target;
  const opts = { passive: false } as const;
  target.addEventListener("touchmove", onMove as EventListener, opts);
  target.addEventListener("touchend", onEnd as EventListener);
  target.addEventListener("touchcancel", onEnd as EventListener);
}

function unmirror() {
  if (!mirrorTarget) return;
  mirrorTarget.removeEventListener("touchmove", onMove as EventListener);
  mirrorTarget.removeEventListener("touchend", onEnd as EventListener);
  mirrorTarget.removeEventListener("touchcancel", onEnd as EventListener);
  mirrorTarget = null;
}

function clearStall() {
  if (stallTimer === null) return;
  clearTimeout(stallTimer);
  stallTimer = null;
}

// Re-armed on every move of a committed drag. Firing means the touch stopped
// reporting altogether — abandon the drag and snap the pane home rather than
// leaving it frozen mid-swipe. Deliberately never pops: a gesture we lost
// track of shouldn't navigate.
function armStall() {
  clearStall();
  stallTimer = setTimeout(() => {
    stallTimer = null;
    if (!dragging) return;
    endGestureState();
    settle(false);
  }, STALL_MS);
}

function endGestureState() {
  candidate = false;
  dragging = false;
  startTarget = null;
  lastHandled = null;
  unmirror();
  clearStall();
}

// Animate the pane to its resting edge, then hand control back to the CSS
// class so the inline styles don't linger and fight future layout.
function settle(toBack: boolean) {
  const layer = handler;
  handler = null;
  if (!layer) return;
  const onBack = () => layer.onBackRef.current();
  const el = layer.paneRef.current;
  if (!el) {
    if (toBack) onBack();
    return;
  }
  let finished = false;
  const seq = ++settleSeq;
  const done = () => {
    if (finished) return;
    finished = true;
    el.removeEventListener("transitionend", done);
    // A gesture that started while this animation was running now owns the
    // pane's inline transform — clearing it here would yank the pane out from
    // under the finger. The pop still has to happen either way.
    if (seq === settleSeq) resetPaneStyles(el);
    if (toBack) onBack();
  };
  el.style.transition = `transform ${SNAP_MS}ms ease`;
  el.style.transform = `translateX(${toBack ? width : 0}px)`;
  el.addEventListener("transitionend", done);
  setTimeout(done, SNAP_MS + 60);
}

const mq =
  typeof window !== "undefined" ? window.matchMedia(PHONE_QUERY) : null;

function onStart(e: TouchEvent) {
  if (!mq?.matches || e.touches.length !== 1) return;
  // A single live touch means the previous one is over, however quietly it
  // went. If it left a drag behind, drop it now so the pane can't stay stuck
  // past the next tap — a stranded transform outlives its gesture otherwise.
  if (dragging || candidate) {
    const stale = pane();
    endGestureState();
    resetPaneStyles(stale);
    handler = null;
  }
  const t = e.touches[0];
  startX = t.clientX;
  startY = t.clientY;
  lastX = t.clientX;
  lastT = performance.now();
  vx = 0;
  dragging = false;
  candidate = startX <= EDGE;
  startTarget = candidate ? e.target : null;
  // The edge zone is app-owned gesture territory: preventDefault here is what
  // stops the browser's native back-swipe (iOS Safari) from starting a real
  // history navigation and racing our pane drag — even when no layer is
  // active and the swipe will simply be swallowed. It also swallows the
  // tap→click synthesis for touches starting in the zone, so onEnd
  // re-dispatches a click when the touch turns out to be a plain tap.
  if (candidate && e.cancelable) e.preventDefault();
  if (!candidate) return;
  mirrorOn(startTarget);
  handler = topLayer();
  const el = pane();
  width = el
    ? el.getBoundingClientRect().width || window.innerWidth
    : window.innerWidth;
}

function onMove(e: TouchEvent) {
  if (!candidate || e.touches.length !== 1) return;
  if (lastHandled === e) return;
  lastHandled = e;
  const t = e.touches[0];
  const dx = t.clientX - startX;
  const dy = t.clientY - startY;
  if (!dragging) {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax < SLOP && ay < SLOP) return;
    // Commit on a rightward move within ~50° of horizontal. Only a clearly
    // vertical (or leftward) move aborts; an ambiguous diagonal keeps
    // watching instead of giving up forever on the first sample — the old
    // strict dy>dx test killed any thumb arc that dipped a few px first.
    if (dx > 0 && ax >= ay * 0.8) {
      dragging = true;
      settleSeq++; // this drag now owns the pane; older settles must not reset it
    } else if (dx < -SLOP || ay > ax * 1.4) {
      endGestureState();
      return;
    } else {
      return;
    }
  }
  if (!handler) return; // guard-only: nothing to drag, gesture is swallowed
  e.preventDefault(); // we own this gesture now; stop scrolling
  armStall();
  const now = performance.now();
  if (now > lastT) {
    // Exponentially smoothed so the release reads intent, not one sample.
    vx = 0.6 * vx + (0.4 * (t.clientX - lastX)) / (now - lastT);
  }
  lastX = t.clientX;
  lastT = now;
  const px = Math.max(0, Math.min(width, dx));
  setTransform(px);
}

function onEnd(e: TouchEvent) {
  if (!candidate) return;
  if (lastHandled === e) return;
  lastHandled = e;
  const wasDragging = dragging;
  const target = startTarget;
  endGestureState();
  const el = pane();
  if (!wasDragging || !el) {
    resetPaneStyles(el);
    handler = null;
    // preventDefault on touchstart suppressed the browser's own tap→click,
    // so a touch that never became a drag and barely moved is a tap we
    // must complete ourselves.
    const t = e.changedTouches?.[0];
    if (
      e.type === "touchend" &&
      t &&
      Math.abs(t.clientX - startX) < SLOP &&
      Math.abs(t.clientY - startY) < SLOP &&
      target instanceof HTMLElement
    ) {
      target.click();
    }
    return;
  }
  const m = /translateX\(([-0-9.]+)px\)/.exec(el.style.transform);
  const px = m ? parseFloat(m[1]) : 0;
  // A rightward flick pops even a short drag (and a leftward flick cancels
  // even a long one); a slow release falls back to the halfway rule.
  const pop = vx > FLICK_VX ? px > 24 : vx < -FLICK_VX ? false : px > width / 2;
  settle(pop);
}

function syncListeners() {
  const want = layers.size > 0;
  if (want && !installed) {
    document.addEventListener("touchstart", onStart, { passive: false });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
    installed = true;
  } else if (!want && installed) {
    document.removeEventListener("touchstart", onStart);
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onEnd);
    document.removeEventListener("touchcancel", onEnd);
    installed = false;
  }
}

export function useBackSwipe({ active, onBack, paneRef, priority = 0 }: Opts) {
  // Callers pass fresh `active`/`onBack` every render. Going through refs
  // keeps them out of the effect deps: if the layer re-registered mid-gesture
  // (any re-render, e.g. a WebSocket session update), the manager would drop
  // the in-flight drag and strand the pane on its inline transform.
  const activeRef = useRef(active);
  const onBackRef = useRef(onBack);
  useLayoutEffect(() => {
    activeRef.current = active;
    onBackRef.current = onBack;
  });

  useEffect(() => {
    const layer: Layer = {
      seq: (seqCounter += 1),
      priority,
      activeRef,
      onBackRef,
      paneRef,
    };
    layers.add(layer);
    // Setup-scope helper so teardown reads the latest pane node without
    // touching `.current` inside the cleanup body itself.
    const releaseLayer = () => {
      layers.delete(layer);
      // If teardown lands mid-gesture on this layer (route change, unmount),
      // hand the pane back to the CSS class instead of leaving it stuck
      // halfway. An in-flight settle() is untouched: it nulls `handler` first.
      if (handler === layer) {
        resetPaneStyles(paneRef.current);
        handler = null;
        endGestureState();
      }
      syncListeners();
    };
    syncListeners();
    return () => {
      releaseLayer();
    };
  }, [paneRef, priority]);
}
