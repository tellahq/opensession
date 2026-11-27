import * as React from "react";
import * as stylex from "@stylexjs/stylex";
import { sx } from "./sx";
import { color, motion, radius, space } from "./tokens.stylex";

/**
 * The waiting spinner: a turning ring, for anything that is fetching,
 * uploading or preparing.
 *
 * It is deliberately not the PixelSpinner. That one is the app's *generating*
 * indicator: the wave a session wears while a model is producing output, so
 * wearing it to fetch a pull request reads as "the agent is working on this"
 * for a PR that has simply not arrived over the network yet. A ring says
 * "waiting", which is the truth on those surfaces.
 *
 * The same ring was hand-rolled in eight places (TurnBlock, PortalPane,
 * PreviewWait, CheckStatusIcon, VoiceInput…) at three different border widths;
 * this is that recipe, once. It inherits `currentColor`, so the caller's text
 * class picks the hue, and base-theme.css keeps `[data-progress]` turning
 * under prefers-reduced-motion.
 */
export type SpinnerSize = "sm" | "md" | "lg";

const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

const styles = stylex.create({
  ring: {
    display: "inline-block",
    flexShrink: 0,
    borderRadius: radius.pill,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${color.current} 25%, transparent)`,
    borderTopColor: color.current,
    animationName: spin,
    animationDuration: motion.spin,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  sm: { width: space.s12, height: space.s12, borderWidth: 1 },
  md: { width: space.s16, height: space.s16, borderWidth: 2 },
  lg: { width: space.s20, height: space.s20, borderWidth: 2 },
});

export function Spinner({
  size = "sm",
  className,
  style,
  ...props
}: React.ComponentPropsWithoutRef<"span"> & { size?: SpinnerSize }) {
  return (
    <span
      aria-hidden
      // The reduced-motion policy in base-theme.css keeps progress turning;
      // it finds a spinner by this attribute.
      data-progress=""
      {...props}
      {...sx([styles.ring, styles[size]], className, style)}
    />
  );
}
