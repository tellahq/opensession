/** Class strings for the pixel spinner (components/PixelSpinner). Its own
 * module rather than constants in the component file, so the component stays
 * component-only and keeps React Fast Refresh. */

/** The 3×3 grid. `--glow-color` is what the keyframe paints with; it resolves
 * to the surrounding text colour, so a caller sets the spinner's colour with a
 * text utility and nothing here needs to know about it. */
export const PIXEL_GRID = "grid grid-cols-3 gap-px [--glow-color:currentColor]";

/** One pixel at rest. `rounded-xs` is exactly the radius the legacy rule spelled
 * (`--radius-xs` is `calc(2px * var(--rf))`) and, unlike `rounded-full`, still
 * matches base.css's squircle rule — so these keep their corner shape, not just
 * their radius. */
export const PIXEL =
  "size-[3px] rounded-xs bg-[color-mix(in_srgb,currentColor_35%,transparent)] " +
  "transition-[background,box-shadow,opacity] duration-micro ease-standard";

/** The wave, as animation LONGHANDS rather than an `animate-[…]` shorthand.
 * The shorthand would reset `animation-delay`, and which of the two won would
 * depend on Tailwind's output order rather than on the order they are written
 * — so every pixel would animate in unison if the delay utility happened to be
 * emitted first. Longhands touch different properties and cannot collide. */
const WAVE_BASE =
  "[animation-name:pixel-snake-trail] [animation-timing-function:ease-out] [animation-iteration-count:infinite]";
export const PIXEL_WAVE = `${WAVE_BASE} [animation-duration:1.4s]`;
/** Calm, ambient cadence — for indicators where 1.4s reads as jittery rather
 * than lively (the Changes tab's empty state). */
export const PIXEL_WAVE_SLOW = `${WAVE_BASE} [animation-duration:2.4s]`;

/** The wavefront sweeps top-left → bottom-right along successive
 * anti-diagonals, so a pixel's delay is its (row + column) step. Written out as
 * literal utilities, because Tailwind only compiles class names it can find in
 * the source — a built string like `[animation-delay:${n}ms]` would compile to
 * nothing and every pixel would light at once. */
export const PIXEL_DELAY = [
  "[animation-delay:0ms]",
  "[animation-delay:210ms]",
  "[animation-delay:420ms]",
  "[animation-delay:630ms]",
  "[animation-delay:840ms]",
];

/** Index into PIXEL_DELAY for the nth cell of the 3×3 grid. */
export function pixelDelayStep(i: number): number {
  return Math.floor(i / 3) + (i % 3);
}
