import { useCallback, useEffect, useRef, useState } from "react";
import { recordSessionPerf } from "../lib/session-performance";

// Scroll engineering for the transcript. The guiding rule: never move the reader
// against their intent. The reader's own scroll position is the source of truth
// for whether we keep them glued to the live edge ("following"). We only stick to
// the bottom while they're actually there; the moment they scroll up — or select
// text, which is also intent — we leave them where they are and surface a
// "Jump to latest" affordance instead.
//
// New turns are pinned near the top of the viewport so their reply can stream into
// the space below while earlier context stays visible (principles 4–6). That needs
// a bottom spacer: a freshly-sent message is the last element, so without reserved
// space below it the browser can't scroll it up to the top. The spacer is sized to
// exactly the room the latest turn needs and shrinks to nothing as the reply fills
// it — so once the answer is long enough the spacer vanishes and scrolling is normal.
//
// The load-bearing subtlety: the browser fires scroll events for layout causes too
// (the pin's own anchor animation, clamps when stream text swaps for the final
// entry) and those always land "at the edge" — the pinned position IS the padded
// scroll max. So following only ever RE-engages from gesture-backed scrolls
// (wheel/touch/scrollbar drag) or explicit actions (jump button); position alone
// is never proof of intent.

// Distance from the bottom (px) that still counts as "at the live edge".
const STICK_THRESHOLD = 90;
// Gap left above a pinned turn so a little previous context stays visible.
const TOP_GAP = 20;
// How close to the head of the loaded transcript still counts as being at the
// top. The "Load all" pill belongs to that head, so it only shows within reach
// of it: one screenful, capped so a tall window never leaves it floating
// halfway down a long transcript.
const TOP_THRESHOLD = 600;
// Touch devices get instant pin scrolls: iOS Safari drops smooth programmatic
// scrolls during keyboard/visual-viewport animation, leaving the pin stranded
// at an intermediate position.
const COARSE_POINTER =
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(pointer: coarse)").matches;
export interface SessionScroll {
  /** Attach to the scrollable transcript container. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Callback ref that keeps element-bound listeners attached across view swaps. */
  setContainerRef: (node: HTMLDivElement | null) => void;
  /** Attach to a zero-content div rendered as the last child of the container. */
  spacerRef: React.RefObject<HTMLDivElement | null>;
  /** True while the reader is pinned to the live edge and we may auto-advance. */
  following: boolean;
  /** Live ref of `following` for rAF loops that outrun React renders. */
  followingLive: React.RefObject<boolean>;
  /** True when content has streamed in below the fold while not following. */
  newBelow: boolean;
  /** True when the latest message is out of view and the return control should show. */
  showScrollToBottom: boolean;
  /** True while the reader is within reach of the head of the loaded transcript. */
  atTop: boolean;
  /** Bring the reader back to the latest reply and resume following. */
  scrollToLatest: (behavior?: ScrollBehavior) => void;
  /** Stop following because the reader is intentionally moving into history. */
  leaveLatest: () => void;
  /** Pin a turn near the top of the viewport (used for reopening at the last turn). */
  anchorToTop: (target: HTMLElement | null, behavior?: ScrollBehavior) => void;
  /** Mark that the local reader just sent a turn — pin it to the top next paint. */
  beginTurn: () => void;
  /** The turn finished; release the spacer so the layout settles. */
  endTurn: () => void;
  /** Whether transcript measurement may maintain the live edge right now. */
  shouldMaintainEnd: () => boolean;
  /** Call after each content change (run in a layout effect) to keep things in place. */
  relayout: () => void;
  /** Suspend the live-edge glue for two animation frames so a fold toggle's
   *  height change settles before any re-glue can move the reader. */
  suspendEndMaintenance: () => void;
  /** Wire to the container's onScroll to track the live edge. */
  onScroll: () => void;
}

function selectionWithin(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  return el.contains(sel.anchorNode) || el.contains(sel.focusNode);
}

function lastUserEl(container: HTMLElement): HTMLElement | null {
  const els = container.querySelectorAll<HTMLElement>(".msg-user");
  return els[els.length - 1] ?? null;
}

// The container's top edge as the reader actually sees it. On iOS the on-screen
// keyboard doesn't shrink the layout viewport — Safari pans the *visual*
// viewport down to keep the focused composer visible — so client-rect
// coordinates (and clientHeight) describe a window partly above/behind what's
// on screen. Anchoring a pinned turn to the raw container top then parks it
// above the visible area and the reader sees only the spacer: empty space.
// All pin math measures from this clipped top instead. In the standalone PWA
// visualViewport stays inert (offsetTop 0), which degrades to the raw top.
function visibleTop(el: HTMLElement): number {
  const rectTop = el.getBoundingClientRect().top;
  const vv = window.visualViewport;
  if (!vv) return rectTop;
  return Math.max(rectTop, vv.offsetTop);
}

export function shouldDisengageTranscriptFollowing({
  atEdge,
  following,
  gestured,
}: {
  atEdge: boolean;
  following: boolean;
  gestured: boolean;
}): boolean {
  // Native virtual anchoring and browser clamps emit ordinary scroll events
  // while layout is between heights. Position alone is not reader intent.
  return following && !atEdge && gestured;
}

function latestMessageVisible(container: HTMLElement): boolean {
  const els = container.querySelectorAll<HTMLElement>(".msg");
  const latest = els[els.length - 1];
  if (!latest) return true;
  const containerRect = container.getBoundingClientRect();
  const latestRect = latest.getBoundingClientRect();
  return (
    latestRect.bottom > containerRect.top &&
    latestRect.top < containerRect.bottom
  );
}

export function useSessionScroll(initialFollowing = true): SessionScroll {
  const containerRef = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    setContainer(node);
  }, []);
  const spacerRef = useRef<HTMLDivElement>(null);
  // followingRef is the live value read inside handlers; `following` mirrors it for
  // rendering. Default true so a fresh, running session tracks the stream.
  const followingRef = useRef(initialFollowing);
  const [following, setFollowingState] = useState(initialFollowing);
  const [newBelow, setNewBelow] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // Starts false and is established before the first paint by relayout(): a
  // session usually opens at the live edge, and a pill flashed over the newest
  // reply is exactly what this gate exists to prevent.
  const [atTop, setAtTop] = useState(false);
  // Whether the latest turn is currently pinned to the top (spacer active).
  const pinnedRef = useRef(false);
  // Set on send; consumed once to perform the one-time scroll-to-top.
  const needAnchorRef = useRef(false);
  // Where the pin parked the reader (scrollTop). While they're still there,
  // relayout actively holds the pinned turn at TOP_GAP through DOM swaps —
  // the pending bubble → real entry replacement shifts/clamps scrollTop, and
  // at scroll-max the browser's scroll anchoring keeps the BOTTOM edge stable
  // instead, dragging the reader from the pinned turn to the live edge.
  const pinTopRef = useRef<number | null>(null);
  // Expiry (performance.now()) of an in-flight programmatic smooth scroll.
  // Its intermediate scroll events pass through "not at the edge" positions;
  // reading those as reader intent turned following off mid-animation, so a
  // jump-to-latest during a fast stream landed short of the grown bottom and
  // never stuck. While in flight we only ever re-engage (on arrival); a real
  // gesture (wheel/touch) or the deadline cancels the flight.
  const autoFlightRef = useRef(0);
  // True for two animation frames after a fold toggle. Expanding or collapsing
  // a disclosure changes block heights, and at the live edge that reads as
  // "the bottom moved" — the glue would yank the reader off the fold they just
  // opened, and the scroll events it generates read as intent to leave. Both
  // are held off until the layout settles. A real reader gesture cancels it.
  const disclosureSettleRef = useRef(false);
  const disclosureSettleFramesRef = useRef<number[]>([]);
  // Timestamps of the last real reader gestures. Scroll events without a
  // recent gesture are layout-driven — the pin's anchor animation, or the
  // clamp when stream text swaps for the final transcript entry — and must
  // never RE-engage following: the pinned position sits exactly at the padded
  // scroll max, so those events always read as "at the edge" and used to
  // dissolve the pin (on send) or yank the view to the bottom (on turn end).
  // Touch gets a long window of its own: iOS momentum keeps scrolling for
  // seconds after the last touch event, with no scrollend support to lean on.
  const lastGestureRef = useRef(0);
  const lastTouchRef = useRef(0);
  // Persists across trailing layout-driven scroll events. Only movement back
  // toward the live edge or an explicit jump clears the reader's upward intent.
  const towardHistoryGestureRef = useRef(false);
  // Position from the previous scroll event. Direction matters inside the stick
  // threshold: a small first step toward history is still an instruction to
  // stop following, even though it remains less than 90px from the bottom.
  const lastScrollTopRef = useRef(0);
  // True while the pointer is dragging the scrollbar (classic scrollbars hit
  // the container itself past clientWidth; overlay scrollbars aren't
  // detectable — those readers re-engage via wheel/touch or the jump button).
  const scrollbarDragRef = useRef(false);
  // A cached session can mount while intentionally reading history. Its first
  // relayout describes restored content, not content that arrived below it.
  const hasRelayoutRef = useRef(false);
  const scrollPerfRef = useRef({ raf: 0, startedAt: 0, frames: 0 });

  const distanceFromBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return 0;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }, []);

  const clearSpacer = useCallback(() => {
    pinnedRef.current = false;
    needAnchorRef.current = false;
    pinTopRef.current = null;
    if (spacerRef.current) spacerRef.current.style.height = "0px";
    // NOTE: overflowAnchor is deliberately NOT restored here. This runs on
    // turn end — exactly when the final-entry restructure lands — and
    // re-enabling browser anchoring for that layout pass can move a following
    // reader away from the edge before relayout runs. relayout owns the flag:
    // "none" while following, back to the browser once the reader isn't.
  }, []);

  const setFollowing = useCallback(
    (v: boolean) => {
      followingRef.current = v;
      setFollowingState(v);
      if (v) {
        towardHistoryGestureRef.current = false;
        // Returning to the live edge ends any pinned turn and clears the unread flag.
        setNewBelow(false);
        setShowScrollToBottom(false);
        clearSpacer();
      }
    },
    [clearSpacer],
  );

  // Both floating controls read the same scroll position, so they are recomputed
  // together: the "Load all" pill at the head of the transcript and the return
  // control at its foot. Each one belongs to an end the reader can't see, and
  // showing either from anywhere else leaves it floating over live content.
  const updateEdges = useCallback((isFollowing?: boolean) => {
    const resolvedFollowing = isFollowing ?? followingRef.current;
    const el = containerRef.current;
    setShowScrollToBottom(
      Boolean(el && !resolvedFollowing && !latestMessageVisible(el)),
    );
    setAtTop(
      Boolean(el && el.scrollTop <= Math.min(el.clientHeight, TOP_THRESHOLD)),
    );
  }, []);

  const leaveLatest = useCallback(() => {
    autoFlightRef.current = 0;
    lastGestureRef.current = 0;
    lastTouchRef.current = 0;
    scrollbarDragRef.current = false;
    towardHistoryGestureRef.current = true;
    setFollowing(false);
    updateEdges(false);
  }, [setFollowing, updateEdges]);

  const scrollToLatest = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const el = containerRef.current;
      if (!el) return;
      clearSpacer();
      if (behavior === "smooth")
        autoFlightRef.current = performance.now() + 1200;
      el.scrollTo({ top: el.scrollHeight, behavior });
      setFollowing(true);
    },
    [clearSpacer, setFollowing],
  );

  const anchorToTop = useCallback(
    (target: HTMLElement | null, behavior?: ScrollBehavior) => {
      const el = containerRef.current;
      if (!el || !target) return;
      // Callers may force "auto" when an instant reopen-anchor jump is preferable
      // to an animation that can be disturbed by transcript layout changes.
      const resolved: ScrollBehavior =
        behavior ?? (COARSE_POINTER ? "auto" : "smooth");
      const instant = resolved !== "smooth";
      const delta =
        target.getBoundingClientRect().top - visibleTop(el) - TOP_GAP;
      if (delta <= 0) {
        // Already at or above the target — don't scroll up. For a pinned turn
        // this IS the pin position; remember it so relayout holds it.
        if (pinnedRef.current) pinTopRef.current = el.scrollTop;
        return;
      }
      const finalFromBottom =
        el.scrollHeight - (el.scrollTop + delta) - el.clientHeight;
      if (pinnedRef.current) pinTopRef.current = el.scrollTop + delta;
      el.scrollTo({ top: el.scrollTop + delta, behavior: resolved });
      // An instant scroll can land clamped (sub-pixel or scroll-max rounding);
      // record where it actually parked so relayout's hold engages.
      if (instant && pinnedRef.current) pinTopRef.current = el.scrollTop;
      // A reopen-anchor that lands at the live edge anyway keeps following (with
      // a flight so the animation's mid positions don't disengage it). A pinned
      // turn must stop following instead: its padded "edge" is fake, and the
      // reply streams into the reserved space below.
      if (!pinnedRef.current && finalFromBottom < STICK_THRESHOLD) {
        if (!instant) autoFlightRef.current = performance.now() + 1200;
        return;
      }
      // Leaving the live edge to read from the top is intent: stop following so the
      // streaming reply fills the space below instead of yanking us back down.
      setFollowing(false);
      updateEdges(false);
    },
    [setFollowing, updateEdges],
  );

  // Size the bottom spacer to exactly the room the pinned turn needs to sit near the
  // top. Resizing a spacer that's below the fold doesn't move what the reader sees.
  const sizeSpacer = useCallback(() => {
    const el = containerRef.current;
    const sp = spacerRef.current;
    if (!el || !sp) return;
    if (!pinnedRef.current) {
      sp.style.height = "0px";
      return;
    }
    const target = lastUserEl(el);
    if (!target) {
      sp.style.height = "0px";
      return;
    }
    const current = sp.offsetHeight;
    const contentHeight = el.scrollHeight - current; // exclude the spacer itself
    const targetTop =
      target.getBoundingClientRect().top -
      el.getBoundingClientRect().top +
      el.scrollTop;
    const below = contentHeight - targetTop; // content height beneath the pinned turn
    // Shrink by the visual-viewport pan (iOS keyboard) so scroll-max sits
    // exactly at the pan-aware pin position — no more, or the anchor clamps
    // short; no less, or empty spacer stays visible once the keyboard closes.
    const topCut = visibleTop(el) - el.getBoundingClientRect().top;
    sp.style.height = `${Math.max(0, el.clientHeight - topCut - below - TOP_GAP)}px`;
  }, []);

  const beginTurn = useCallback(() => {
    pinnedRef.current = true;
    needAnchorRef.current = true;
  }, []);

  const endTurn = useCallback(() => {
    clearSpacer();
  }, [clearSpacer]);

  const suspendEndMaintenance = useCallback(() => {
    for (const frame of disclosureSettleFramesRef.current)
      cancelAnimationFrame(frame);
    disclosureSettleFramesRef.current = [];
    disclosureSettleRef.current = true;
    // Two frames: one for the fold's own layout pass, one for the follow-up
    // resize nested content sometimes triggers.
    const first = requestAnimationFrame(() => {
      const second = requestAnimationFrame(() => {
        disclosureSettleRef.current = false;
        disclosureSettleFramesRef.current = [];
      });
      disclosureSettleFramesRef.current = [second];
    });
    disclosureSettleFramesRef.current = [first];
  }, []);

  const shouldMaintainEnd = useCallback(() => {
    const el = containerRef.current;
    return Boolean(
      el &&
      followingRef.current &&
      !pinnedRef.current &&
      !disclosureSettleRef.current &&
      !selectionWithin(el),
    );
  }, []);

  // Run from a layout effect after content changes. Two jobs: keep a following
  // reader glued to the live edge, and maintain the pinned-turn spacer.
  const relayout = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const hadLayout = hasRelayoutRef.current;
    hasRelayoutRef.current = true;
    if (pinnedRef.current) {
      // Own the position for the duration of the pin: at scroll-max the
      // browser's scroll anchoring keeps the bottom edge stable across content
      // swaps, which would teleport the reader from the pinned turn to the
      // live edge when the final entry lands.
      el.style.overflowAnchor = "none";
      sizeSpacer();
      if (needAnchorRef.current) {
        // First paint after a send: now that the spacer reserves room, scroll the
        // new turn to the top. Re-measure afterwards so the spacer is exact.
        const target = lastUserEl(el);
        if (target) {
          anchorToTop(target);
          needAnchorRef.current = false;
          sizeSpacer();
        }
      } else if (
        pinTopRef.current !== null &&
        Math.abs(el.scrollTop - pinTopRef.current) < 4
      ) {
        // The reader is still parked at the pin: hold the turn at TOP_GAP
        // through DOM swaps that shift or clamp scrollTop. Skipped the moment
        // they scroll away — their position is theirs.
        const target = lastUserEl(el);
        if (target) {
          const desired = Math.max(
            0,
            Math.round(
              target.getBoundingClientRect().top -
                visibleTop(el) +
                el.scrollTop -
                TOP_GAP,
            ),
          );
          if (Math.abs(desired - el.scrollTop) > 1) el.scrollTop = desired;
          pinTopRef.current = el.scrollTop;
        }
      }
      updateEdges(false);
      return;
    }
    // Stick to the bottom only while following — and never mid-selection, since a
    // selection is the reader actively working with the text (principle 3).
    if (shouldMaintainEnd()) {
      // Own the scroll while following: browser scroll anchoring compensating
      // for a block mounting above the edge can move the reader by the whole
      // restructure (measured: 1138px at turn end). The glue IS the anchor
      // while following; hand anchoring back when not.
      el.style.overflowAnchor = "none";
      // A fold is settling: its height change IS this relayout's cause, and
      // gluing now would drag the reader off the block they just toggled.
      // Otherwise restore the live-edge invariant before paint. Animating this
      // correction leaves a following reader visibly stranded above a newly
      // mounted message, then scrolls the whole conversation under them.
      if (!disclosureSettleRef.current) el.scrollTop = el.scrollHeight;
    } else if (
      hadLayout &&
      !followingRef.current &&
      !disclosureSettleRef.current &&
      distanceFromBottom() > STICK_THRESHOLD
    ) {
      // Hand anchoring back to the browser: a reader in history deserves its
      // protection against images and code blocks loading above them.
      if (el.style.overflowAnchor) el.style.overflowAnchor = "";
      setNewBelow(true); // content arrived out of view, let the UI announce it
    }
    updateEdges();
  }, [
    sizeSpacer,
    anchorToTop,
    shouldMaintainEnd,
    distanceFromBottom,
    updateEdges,
  ]);

  // The reader's scroll is the source of truth for following. Reaching the live
  // edge re-engages it; scrolling away disengages it.
  const onScroll = useCallback(() => {
    const scrollPerf = scrollPerfRef.current;
    if (!scrollPerf.startedAt) scrollPerf.startedAt = performance.now();
    if (!scrollPerf.raf) {
      scrollPerf.raf = requestAnimationFrame(() => {
        scrollPerf.raf = 0;
        scrollPerf.frames++;
        const elapsed = performance.now() - scrollPerf.startedAt;
        if (elapsed >= 500) {
          recordSessionPerf(
            "scroll_fps",
            (scrollPerf.frames * 1_000) / elapsed,
          );
          scrollPerf.startedAt = performance.now();
          scrollPerf.frames = 0;
        }
      });
    }
    const el = containerRef.current;
    const scrollTop = el?.scrollTop ?? 0;
    const movedTowardHistory = scrollTop < lastScrollTopRef.current - 0.5;
    const movedTowardLatest = scrollTop > lastScrollTopRef.current + 0.5;
    lastScrollTopRef.current = scrollTop;
    const atEdge = distanceFromBottom() < STICK_THRESHOLD;
    const now = performance.now();
    if (autoFlightRef.current) {
      if (now > autoFlightRef.current) {
        autoFlightRef.current = 0; // overdue, treat the event as the reader's
      } else if (atEdge) {
        autoFlightRef.current = 0; // arrived
        if (!followingRef.current) setFollowing(true);
        updateEdges(true);
        return;
      } else {
        return; // mid-flight positions carry no reader intent
      }
    }
    // Leaving the edge always disengages, but only a gesture-backed scroll may
    // RE-engage: layout-driven events (see lastGestureRef) always land "at the
    // edge" and carry no intent. Non-gesture readers at the true bottom still
    // have the jump button.
    const gestured =
      scrollbarDragRef.current ||
      now - lastGestureRef.current < 1000 ||
      now - lastTouchRef.current < 6000;
    // Mid-settle positions carry no reader intent (same rule as autoFlight):
    // the fold's growth moves scrollTop without the reader touching anything.
    if (disclosureSettleRef.current && !gestured) return;
    if (scrollbarDragRef.current && gestured) {
      if (movedTowardHistory) towardHistoryGestureRef.current = true;
      else if (movedTowardLatest) towardHistoryGestureRef.current = false;
    }
    if (towardHistoryGestureRef.current && gestured) {
      if (followingRef.current) setFollowing(false);
      updateEdges(false);
      return;
    }
    if (
      shouldDisengageTranscriptFollowing({
        atEdge,
        following: followingRef.current,
        gestured,
      })
    )
      setFollowing(false);
    else if (atEdge && !followingRef.current && gestured) setFollowing(true);
    updateEdges(followingRef.current);
  }, [distanceFromBottom, setFollowing, updateEdges]);

  // Two container-level listeners: a real gesture cancels a programmatic
  // flight immediately (so the reader can grab the transcript mid-animation),
  // and capture-phase load events re-run the glue — an image finishing to load
  // grows the content with no React state change, which otherwise left a
  // following reader silently stranded above the bottom.
  useEffect(() => {
    const el = container;
    if (!el) return;
    const markGesture = () => {
      autoFlightRef.current = 0;
      disclosureSettleRef.current = false;
      lastGestureRef.current = performance.now();
    };
    const leaveForGesture = () => {
      // A live frame can relayout before the browser delivers the gesture's
      // scroll event. Retire both forms of automatic positioning immediately,
      // or that frame can put the reader back at the live edge/pinned turn and
      // erase their first attempt to scroll into history.
      pinTopRef.current = null;
      needAnchorRef.current = false;
      lastScrollTopRef.current = el.scrollTop;
      towardHistoryGestureRef.current = true;
      if (followingRef.current) setFollowing(false);
    };
    const wheel = (event: WheelEvent) => {
      markGesture();
      if (event.deltaY < 0 && el.scrollTop > 0) leaveForGesture();
      else if (event.deltaY > 0) towardHistoryGestureRef.current = false;
    };
    let touchY: number | null = null;
    const touchStart = (event: TouchEvent) => {
      markGesture();
      lastTouchRef.current = performance.now();
      touchY = event.touches[0]?.clientY ?? null;
    };
    const touchMove = (event: TouchEvent) => {
      markGesture();
      lastTouchRef.current = performance.now();
      const nextY = event.touches[0]?.clientY ?? null;
      // Dragging the finger down moves the transcript toward earlier messages.
      if (
        touchY !== null &&
        nextY !== null &&
        nextY > touchY &&
        el.scrollTop > 0
      )
        leaveForGesture();
      else if (touchY !== null && nextY !== null && nextY < touchY)
        towardHistoryGestureRef.current = false;
      touchY = nextY;
    };
    const onPointerDown = (e: PointerEvent) => {
      // Classic scrollbar drags hit the container itself past the content box.
      if (
        e.target === el &&
        (e.offsetX >= el.clientWidth || e.offsetY >= el.clientHeight)
      ) {
        scrollbarDragRef.current = true;
        markGesture();
        leaveForGesture();
      }
    };
    const endDrag = () => {
      if (!scrollbarDragRef.current) return;
      scrollbarDragRef.current = false;
      lastGestureRef.current = performance.now();
    };
    const onLoad = () => relayout();
    el.addEventListener("wheel", wheel, { passive: true });
    el.addEventListener("touchstart", touchStart, { passive: true });
    el.addEventListener("touchmove", touchMove, { passive: true });
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    el.addEventListener("load", onLoad, true);
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("touchstart", touchStart);
      el.removeEventListener("touchmove", touchMove);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      el.removeEventListener("load", onLoad, true);
    };
  }, [container, relayout, setFollowing]);

  // The viewport can change height with no content change at all: the composer
  // grows a line as the reader types, the queue flap folds out, a panel opens.
  // The inverse matters too: cached/indexed transcript content can replace its
  // estimates with real rows while the viewport itself stays the same size.
  // That changes scrollHeight without changing the container's border box, so
  // observing only `el` silently stranded a following reader above the edge.
  // Observe the direct content layers as well and keep the set current across
  // loading → transcript swaps. Guarded to following/pinned readers so resize
  // never moves someone deliberately reading history or announces new content.
  useEffect(() => {
    const el = container;
    if (!el || typeof ResizeObserver === "undefined") return;
    let mounted = false;
    let resizeFrame = 0;
    const ro = new ResizeObserver(() => {
      // The initial batch describes observation setup, not a resize. relayout's
      // layout effect owns the opening position; skipping this also avoids a
      // second mount-time scroll after a cached position has been restored.
      if (!mounted) {
        mounted = true;
        return;
      }
      // This observer is the fallback for non-React growth such as an image
      // decoding or the visual viewport changing. Semantic transcript commits
      // already call relayout from a layout effect. Writing scrollTop or the
      // spacer from inside ResizeObserver delivery can resize another observed
      // layer and trigger the browser's undelivered-notifications warning, so
      // coalesce fallback maintenance into the next rendering turn.
      if (resizeFrame || (!followingRef.current && !pinnedRef.current)) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        if (followingRef.current || pinnedRef.current) relayout();
      });
    });
    const observeLayers = () => {
      ro.observe(el);
      for (const child of el.children) ro.observe(child);
    };
    observeLayers();
    const mutations = new MutationObserver(observeLayers);
    mutations.observe(el, { childList: true });
    return () => {
      mutations.disconnect();
      ro.disconnect();
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
    };
  }, [container, relayout]);

  // While a turn is pinned, keyboard open/close (visual-viewport pan/resize on
  // iOS) moves the visible window without any content change — re-seat the pin
  // so the turn stays at TOP_GAP below what the reader actually sees.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onChange = () => {
      if (pinnedRef.current) relayout();
    };
    vv.addEventListener("resize", onChange);
    vv.addEventListener("scroll", onChange);
    return () => {
      vv.removeEventListener("resize", onChange);
      vv.removeEventListener("scroll", onChange);
    };
  }, [relayout]);

  return {
    containerRef,
    setContainerRef,
    spacerRef,
    following,
    followingLive: followingRef,
    newBelow,
    showScrollToBottom,
    atTop,
    scrollToLatest,
    leaveLatest,
    anchorToTop,
    beginTurn,
    endTurn,
    shouldMaintainEnd,
    relayout,
    suspendEndMaintenance,
    onScroll,
  };
}
