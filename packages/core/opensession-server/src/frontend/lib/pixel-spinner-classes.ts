import { utilityClassName } from "../ui/cn";

import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";

const sx = stylex.create({
  grid: {
    display: "grid",
  },
  gridCols3: {
    gridTemplateColumns: "repeat(3,minmax(0,1fr))",
  },
  gapPx: {
    gap: "1px",
  },
  GlowColorCurrentColor: {
    "--glow-color": "currentColor",
  },
  size3px: {
    width: "3px",
    height: "3px",
  },
  roundedXs: {
    borderRadius: "calc(2px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  durationVarDurMicro: {
    "--tw-duration": "var(--dur-micro)",
    transitionDuration: "var(--dur-micro)",
  },
  easeVarEase: {
    "--tw-ease": "var(--ease)",
    transitionTimingFunction: "var(--ease)",
  },
  AnimationNamePixelSnakeTrail: {
    animationName: "pixel-snake-trail",
  },
  AnimationTimingFunctionEaseOut: {
    animationTimingFunction: "ease-out",
  },
  AnimationIterationCountInfinite: {
    animationIterationCount: "infinite",
  },
  AnimationDelay0ms: {
    animationDelay: "0s",
  },
  AnimationDelay210ms: {
    animationDelay: ".21s",
  },
  AnimationDelay420ms: {
    animationDelay: ".42s",
  },
  AnimationDelay630ms: {
    animationDelay: ".63s",
  },
  AnimationDelay840ms: {
    animationDelay: ".84s",
  },

  bgColorMixInSrgbCurrentColor35Transparent: {
    backgroundColor: "currentColor",
    "@supports (color: color-mix(in lab, red, red))": {
      backgroundColor: "color-mix(in srgb,currentColor 35%,transparent)",
    },
  },
  transitionBackgroundBoxShadowOpacity: {
    transitionProperty: "background,box-shadow,opacity",
    transitionTimingFunction: "var(--tw-ease,var(--ease))",
    transitionDuration: "var(--tw-duration,var(--dur-micro))",
  },
});

/** Class strings for the pixel spinner (components/PixelSpinner). Its own
 * module rather than constants in the component file, so the component stays
 * component-only and keeps React Fast Refresh. */

/** The 3×3 grid. `--glow-color` is what the keyframe paints with; it resolves
 * to the surrounding text colour, so a caller sets the spinner's colour with a
 * text utility and nothing here needs to know about it. */
export const PIXEL_GRID = mergeStylexClassName(
  "",
  sx.grid,
  sx.gridCols3,
  sx.gapPx,
  sx.GlowColorCurrentColor,
);

/** One pixel at rest. `rounded-xs` is exactly the radius the legacy rule spelled
 * (`--radius-xs` is `calc(2px * var(--rf))`) and, unlike `rounded-full`, still
 * matches base.css's squircle rule — so these keep their corner shape, not just
 * their radius. */
export const PIXEL =
  mergeStylexClassName(
    "",
    sx.bgColorMixInSrgbCurrentColor35Transparent,
    sx.size3px,
    sx.roundedXs,
  ) +
  " " +
  mergeStylexClassName(
    "",
    sx.transitionBackgroundBoxShadowOpacity,
    sx.durationVarDurMicro,
    sx.easeVarEase,
  );

/** The wave, as animation LONGHANDS rather than an `animate-[…]` shorthand.
 * The shorthand would reset `animation-delay`, and which of the two won would
 * depend on Tailwind's output order rather than on the order they are written
 * — so every pixel would animate in unison if the delay utility happened to be
 * emitted first. Longhands touch different properties and cannot collide. */
const WAVE_BASE = mergeStylexClassName(
  "",
  sx.AnimationNamePixelSnakeTrail,
  sx.AnimationTimingFunctionEaseOut,
  sx.AnimationIterationCountInfinite,
);
export const PIXEL_WAVE = utilityClassName(
  `${WAVE_BASE} [animation-duration:1.4s]`,
);
/** Calm, ambient cadence — for indicators where 1.4s reads as jittery rather
 * than lively (the Changes tab's empty state). */
export const PIXEL_WAVE_SLOW = utilityClassName(
  `${WAVE_BASE} [animation-duration:2.4s]`,
);

/** The wavefront sweeps top-left → bottom-right along successive
 * anti-diagonals, so a pixel's delay is its (row + column) step. Written out as
 * literal utilities, because Tailwind only compiles class names it can find in
 * the source — a built string like `[animation-delay:${n}ms]` would compile to
 * nothing and every pixel would light at once. */
export const PIXEL_DELAY = [
  mergeStylexClassName("", sx.AnimationDelay0ms),
  mergeStylexClassName("", sx.AnimationDelay210ms),
  mergeStylexClassName("", sx.AnimationDelay420ms),
  mergeStylexClassName("", sx.AnimationDelay630ms),
  mergeStylexClassName("", sx.AnimationDelay840ms),
];

/** Index into PIXEL_DELAY for the nth cell of the 3×3 grid. */
export function pixelDelayStep(i: number): number {
  return Math.floor(i / 3) + (i % 3);
}
