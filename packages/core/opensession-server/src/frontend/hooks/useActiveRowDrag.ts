import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import {
  getActiveOrder,
  onActiveOrderChanged,
  placeActiveOrder,
  setActiveOrder,
} from "../lib/active-order";

/** Starts a Motion drag from the row's last pointerdown. False when there is
 *  no press to start from. */
type LiftFn = () => boolean;

export interface ActiveRowDrag {
  /** The saved per-user order the Active sections sort by. */
  order: string[];
  /** Mid-drag, Motion's in-flight order for the section being dragged. */
  draft: { gkey: string; keys: string[] } | null;
  /** The row floating under the pointer (or lifted by a long press). */
  dragKey: string | null;
  /** Whole-row mouse drag. Touch drags start from a long press instead,
   *  because a whole-row drag would steal the list's scroll. */
  pointerDrag: boolean;
  onReorder: (gkey: string, keys: string[]) => void;
  onDragStart: (key: string) => void;
  onDragEnd: () => void;
  onClickCapture: (event: React.MouseEvent) => void;
  registerLift: (key: string, lift: LiftFn) => () => void;
}

export interface ActiveRowLift {
  /** Long press on a touch row: lift it so the same finger can drag it.
   *  False when the row is not in a reorderable Active section. */
  liftActiveRow: (key: string) => boolean;
  /** The finger came up. `moved` says whether the lift became a reorder;
   *  null when nothing was lifted. */
  endActiveLift: () => { moved: boolean } | null;
}

// While a row is lifted the finger drags it, not the page. The listener has
// to be native and non-passive: React's touchmove is passive, and a scroll
// that starts would cancel the pointer stream Motion is following.
//
// Module scope gives add and remove one function identity in every build. The
// document-level touchend ends the block even when the row's own touchend never
// reaches React (the row re-rendered away mid-press). A leftover block freezes
// every scroller in the app, including the sheet the release opens.
function blockScroll(event: TouchEvent) {
  if (event.cancelable) event.preventDefault();
}
function stopBlockingScroll() {
  document.removeEventListener("touchmove", blockScroll);
  document.removeEventListener("touchend", stopBlockingScroll, true);
  document.removeEventListener("touchcancel", stopBlockingScroll, true);
}
function startBlockingScroll() {
  document.addEventListener("touchmove", blockScroll, { passive: false });
  document.addEventListener("touchend", stopBlockingScroll, true);
  document.addEventListener("touchcancel", stopBlockingScroll, true);
}

export function useActiveRowDrag(
  isPhone: boolean,
): ActiveRowDrag & ActiveRowLift {
  const [order, setOrder] = useState(getActiveOrder);
  useEffect(() => onActiveOrderChanged(() => setOrder(getActiveOrder())), []);

  const [draft, setDraft] = useState<ActiveRowDrag["draft"]>(null);
  const draftRef = useRef<ActiveRowDrag["draft"]>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const justDragged = useRef(false);
  const lifts = useRef(new Map<string, LiftFn>());
  const lifted = useRef<{ key: string; moved: boolean } | null>(null);

  useEffect(() => stopBlockingScroll, []);

  // Stable, so each row registers once rather than on every sidebar render.
  const registerLift = useCallback((key: string, lift: LiftFn) => {
    lifts.current.set(key, lift);
    return () => {
      if (lifts.current.get(key) === lift) lifts.current.delete(key);
    };
  }, []);

  const onDragEnd = () => {
    setDragKey(null);
    justDragged.current = true;
    // The drop's click fires synchronously after pointerup; swallow only it.
    setTimeout(() => {
      justDragged.current = false;
    }, 0);
    const pending = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (pending)
      setActiveOrder(placeActiveOrder(getActiveOrder(), pending.keys));
  };

  return {
    order,
    draft,
    dragKey,
    pointerDrag: !isPhone,
    onReorder: (gkey, keys) => {
      if (lifted.current) lifted.current.moved = true;
      draftRef.current = { gkey, keys };
      setDraft({ gkey, keys });
    },
    onDragStart: setDragKey,
    onDragEnd,
    onClickCapture: (event) => {
      if (!justDragged.current) return;
      event.preventDefault();
      event.stopPropagation();
    },
    registerLift,
    liftActiveRow: (key) => {
      const lift = lifts.current.get(key);
      if (!lift || !lift()) return false;
      lifted.current = { key, moved: false };
      setDragKey(key);
      startBlockingScroll();
      return true;
    },
    endActiveLift: () => {
      stopBlockingScroll();
      const lift = lifted.current;
      lifted.current = null;
      if (!lift) return null;
      // A lift that never moved never started a Motion drag, so nothing else
      // will set the row down.
      if (!lift.moved) setDragKey(null);
      return { moved: lift.moved };
    },
  };
}
