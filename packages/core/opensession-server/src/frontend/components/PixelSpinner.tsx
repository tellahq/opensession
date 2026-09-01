import React from "react";
import { cn } from "../ui/cn";
import {
  PIXEL,
  PIXEL_DELAY,
  PIXEL_GRID,
  PIXEL_WAVE,
  PIXEL_WAVE_SLOW,
  pixelDelayStep,
} from "../lib/pixel-spinner-classes";

/**
 * Pixel spinner — a 3×3 grid of tiny pixels that light up in a single,
 * consistent diagonal wave sweeping top-left → bottom-right. The wavefront
 * runs along successive anti-diagonals, so the number of lit pixels grows
 * 1 → 2 → 3 and then recedes 3 → 2 → 1 as it crosses the grid.
 * The pixels inherit the surrounding text
 * color (via `currentColor`), so the color is controlled by the caller's text
 * class (e.g. `text-fg` for a neutral black/white loader).
 *
 * Reserved for GENERATING: a model producing output. Anything that is merely
 * fetching, uploading or preparing wears the ring in ui/spinner instead, or a
 * skeleton in the shape of what is arriving. Worn on a slow fetch, the wave
 * says the agent is working on a request nobody made.
 *
 * Styling lives in lib/pixel-spinner-classes; the keyframe is in base.css,
 * with the other keyframes the utilities reference.
 *
 * The pattern is intentionally fixed (not random per instance) so every
 * loader in the app looks identical — a row of session spinners reads as one
 * consistent indicator rather than a different animation each. `cycling` and
 * `interval` are kept for call-site compatibility but no longer switch the
 * pattern.
 */
interface Props {
  /** Retained for compatibility; the pattern no longer changes over time. */
  cycling?: boolean;
  /** Retained for compatibility; no longer used. */
  interval?: number;
  /** Slower, calmer cadence for ambient indicators. */
  slow?: boolean;
  className?: string;
}

export function PixelSpinner({ className, slow }: Props) {
  return (
    <div className={cn(PIXEL_GRID, className)} aria-hidden>
      {Array.from({ length: 9 }, (_, i) => (
        <div
          key={i}
          className={cn(
            PIXEL,
            slow ? PIXEL_WAVE_SLOW : PIXEL_WAVE,
            PIXEL_DELAY[pixelDelayStep(i)],
          )}
        />
      ))}
    </div>
  );
}
