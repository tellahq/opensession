/**
 * Shared Motion presets so micro-interactions feel like one system instead of
 * per-component guesses. Use `motion.*` / `AnimatePresence` directly in
 * components and spread these — don't build wrapper components around Motion.
 */

import { MotionGlobalConfig, type Transition } from "motion/react";

/**
 * Duration tokens, in seconds. These mirror `--dur-micro` / `--dur` /
 * `--dur-lg` in styles/base.css one-for-one — the same three numbers picked
 * by travel distance, so a Motion spring and a CSS transition on neighbouring
 * elements land together instead of one trailing the other. Change one, change
 * both.
 */
export const duration = {
  /** In-place state change: colour, opacity, a caret flip. */
  micro: 0.15,
  /** The default. Small anchored movement — popups, chips, short slides. */
  base: 0.2,
  /** Spatial: sheets, drawers, the settings pager. */
  large: 0.28,
} as const;

/**
 * The one easing curve, mirroring `--ease`. Motion takes a bezier as a 4-tuple,
 * so this is literally the same cubic-bezier the stylesheet uses; reach for it
 * on `type: "tween"` transitions.
 *
 * Springs below use `bounce: 0`, which is critically damped — it decelerates
 * into its resting value without overshoot, which is the same shape this curve
 * describes. That is what lets CSS and Motion read as one system rather than
 * two. The native OS1 app makes the same choice: one `.snappy` spring,
 * `extraBounce: 0`, everywhere.
 */
export const ease: [number, number, number, number] = [0.32, 0.72, 0, 1];

/**
 * Morph for the mobile composer collapsing to / expanding from its single-row
 * resting pill. The composer's shape change is the longest travel in the app,
 * so it takes the large duration — but the same critically-damped spring as
 * everything else. It used to carry `bounce: 0.14`; the overshoot made it the
 * one control that moved differently from its neighbours, and dropping it is
 * what puts the composer in the same system as the CSS transitions around it.
 *
 * This is the transition for that ONE morph, not for the composer's size in
 * general. Everything it is attached to is paired with `layoutDependency` so it
 * runs on the pill morph and on nothing else. See the note on the composer box
 * in components/Composer.tsx.
 */
export const composerMorph: Transition = {
  type: "spring",
  duration: duration.large,
  bounce: 0,
};

/**
 * Enter for the composer's toolbar chips (model/effort/goal) as it expands — a
 * quick fade from the collapsed baseline. Deliberately no `exit`: on collapse
 * the chips are removed instantly (the container's layout glide carries the
 * motion) so they don't briefly reflow through the reordered single-row.
 *
 * These chips arrive in the middle of the pill morph, while the whole row is
 * already re-ordering around them, so they stay quiet: a chip scaling from 0.8
 * over the morph's full 280ms was a second moving thing competing with the
 * shape change. It fades at the chip duration, from near its own size.
 */
export const composerChipMotion = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1 },
  transition: { type: "tween", duration: duration.base, ease },
} as const;

/**
 * Suppress Motion animations for the duration of a synchronous UI gesture such
 * as a drag-resize, then restore. While active, any Motion animation that
 * STARTS snaps to its end instead of tweening — crucially this includes the
 * `layout` ("morph") animations the composer and sidebar rows run whenever
 * their measured width changes. Dragging the sidebar / right-panel resize
 * handles changes those widths on every mousemove; without this each step
 * springs, which reads as a "funky" text morph. (Motion already blocks layout
 * animation during a real window resize via projection update-blocking; a
 * custom drag doesn't trip that path, so we snap explicitly.)
 *
 * Returns a restore fn. It defers by one frame so the gesture's final layout
 * change settles instantly too, before normal animation resumes.
 */
export function suppressLayoutAnimations(): () => void {
  const prev = MotionGlobalConfig.instantAnimations;
  MotionGlobalConfig.instantAnimations = true;
  return () => {
    requestAnimationFrame(() => {
      MotionGlobalConfig.instantAnimations = prev;
    });
  };
}
