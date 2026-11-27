import type { CSSProperties } from "react";
import * as stylex from "@stylexjs/stylex";
import { sx } from "./sx";
import { space } from "./tokens.stylex";

const BAND =
  "linear-gradient(90deg, transparent 25%, black 45%, black 55%, transparent 75%)";

const styles = stylex.create({
  root: { position: "relative", display: "inline-block", contain: "paint" },
  highlight: {
    pointerEvents: "none",
    position: "absolute",
    inset: space.s0,
    userSelect: "none",
    color: "var(--text-shimmer-highlight)",
    maskImage: BAND,
    maskRepeat: "no-repeat",
    maskSize: "100% 100%",
    willChange: "transform",
  },
  copy: { display: "block", width: "100%", willChange: "transform" },
});

const sweepAnimation: CSSProperties = {
  animationName: "text-shimmer-window",
  animationDuration: "var(--text-shimmer-duration, 2s)",
  animationTimingFunction: "var(--text-shimmer-easing, linear)",
  animationDelay: "var(--text-shimmer-delay, 0s)",
  animationIterationCount: "infinite",
  animationFillMode: "both",
};

const copyAnimation: CSSProperties = {
  ...sweepAnimation,
  animationName: "text-shimmer-copy",
};

/**
 * A compositor-only highlight sweep over a short text label.
 *
 * The masked window and its text copy move in opposite directions, so the
 * duplicate glyphs stay registered with the visible label while only the mask
 * travels. Both animations change `transform`, avoiding the per-frame paint
 * caused by animating a clipped gradient's background position.
 */
export function TextShimmer({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <span {...sx(styles.root, className)} data-text-shimmer="">
      <span>{children}</span>
      <span
        aria-hidden="true"
        {...stylex.props(styles.highlight)}
        style={sweepAnimation}
      >
        <span {...stylex.props(styles.copy)} style={copyAnimation}>
          {children}
        </span>
      </span>
    </span>
  );
}
