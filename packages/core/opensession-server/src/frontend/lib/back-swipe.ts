// Pure decisions behind hooks/useBackSwipe: which touches may become a back
// drag, when a drag commits or lets go, and whether a release pops the page.
// Kept DOM-free so the tuning can be tested without a browser.

/**
 * Two zones, because the two costs pull in opposite directions.
 *
 * The HARD zone is the bezel edge, where a real edge swipe's first sample
 * lands (a finger coming off the bezel reports x in the single digits) and
 * where UIKit's own screen-edge recognizers live. Touches starting there are
 * cancelled at touchstart so nothing native (a history swipe, a scroll) can
 * race the pane drag. That cancel is total: no scroll, no focus, no click can
 * come out of the touch, so the zone has to be narrow.
 *
 * The SOFT zone is the strip beside it, reachable by a less precise start.
 * Nothing is cancelled at touchstart, so a tap on a sidebar row's icon, a
 * vertical scroll or a long-press starting there behaves natively; the touch
 * is only claimed once its first real movement is clearly rightward.
 */
export const HARD_EDGE = 20;
export const SOFT_EDGE = 44;

/** Movement before a touch is judged: below this, nothing is decided. */
export const SLOP = 8;
/** Rightward release speed (px/ms) that pops even a short drag. */
export const FLICK_VX = 0.35;
/** A flick still has to have moved the pane at least this far. */
export const FLICK_MIN_PX = 24;

export type EdgeZone = "hard" | "soft";

export function edgeZoneAt(x: number): EdgeZone | null {
  if (x <= HARD_EDGE) return "hard";
  if (x <= SOFT_EDGE) return "soft";
  return null;
}

/**
 * `wait`: keep watching. `drag`: this touch is the back gesture from here on.
 * `release`: it is something else (a scroll, a leftward swipe); let it go.
 *
 * Hard-zone touches were already cancelled at touchstart, so there is nothing
 * to hand a vertical move back to; any rightward travel of SLOP commits, however
 * curved the thumb's path, and only a leftward move gives up. Soft-zone touches
 * still own a native scroll, so the first sample past SLOP must read as
 * rightward within about 50 degrees of horizontal, or the scroll keeps it.
 */
export function axisVerdict(
  zone: EdgeZone,
  dx: number,
  dy: number,
): "wait" | "drag" | "release" {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (zone === "hard") {
    if (dx >= SLOP) return "drag";
    if (dx <= -SLOP) return "release";
    return "wait";
  }
  if (ax < SLOP && ay < SLOP) return "wait";
  return dx > 0 && ax >= ay * 0.8 ? "drag" : "release";
}

/**
 * Whether a released drag pops. A rightward flick pops even a short drag and
 * a leftward flick cancels even a long one; a slow release falls back to the
 * halfway rule.
 */
export function shouldPop(px: number, vx: number, width: number): boolean {
  if (vx > FLICK_VX) return px > FLICK_MIN_PX;
  if (vx < -FLICK_VX) return false;
  return px > width / 2;
}
