import * as React from "react";

/**
 * Deferred popups: tooltips, menus and popovers that are built only once
 * someone reaches for the region holding them.
 *
 * Every Base UI root and trigger runs its floating, focus and hover hooks
 * when it mounts, whether or not it ever opens. A transcript row carries a
 * dozen of them (timestamps, copy, reactions, the ⋯ menu, file chips), and a
 * session opens many rows at once. Inside a `PopupArmingRegion` they render
 * as their plain trigger element until the pointer enters the region, a key
 * focuses into it, or something in it is clicked. Outside a region nothing is
 * deferred.
 */
export interface PopupArming {
  armed: boolean;
  arm: () => void;
}

export const PopupArmingContext = React.createContext<PopupArming | null>(null);

/** False only inside a region nobody has reached for yet. */
export function usePopupsArmed(): boolean {
  return React.useContext(PopupArmingContext)?.armed ?? true;
}

/**
 * Set by a deferred Menu or Popover root for its own trigger and popup: the
 * trigger renders a plain button that opens the popup on click, and the
 * popup renders nothing. Null under a live root.
 */
export interface DeferredPopupRoot {
  /** Arm the region and open this popup once its root is live. */
  open: () => void;
}

export const DeferredPopupRootContext =
  React.createContext<DeferredPopupRoot | null>(null);

export function useDeferredPopupRoot(): DeferredPopupRoot | null {
  return React.useContext(DeferredPopupRootContext);
}

/** What a Menu or Popover root needs to decide whether to go live. */
export interface LazyPopupRoot {
  /** Set while the root should wait; null once the real root mounts. */
  deferred: DeferredPopupRoot | null;
  /** The plain trigger was clicked, so the real root mounts open. */
  openOnMount: boolean;
}

/**
 * For a Menu or Popover root: whether to mount the real Base UI root yet, and
 * whether it should mount open because its plain trigger was clicked. A
 * controlled root (one given `open`) is always live: only its owner can open
 * it, through the `onOpenChange` a plain trigger cannot call.
 */
export function useLazyPopupRoot(open: boolean | undefined): LazyPopupRoot {
  const arming = React.useContext(PopupArmingContext);
  const [requested, setRequested] = React.useState(false);
  if (!arming || arming.armed || open !== undefined || requested)
    return { deferred: null, openOnMount: requested };
  const arm = arming.arm;
  return {
    deferred: {
      open: () => {
        setRequested(true);
        arm();
      },
    },
    openOnMount: false,
  };
}
