import { utilityClassName } from "./cn";
import type { CSSProperties } from "react";
import { cn } from "./cn";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  pointerEventsNone: {
    pointerEvents: "none",
  },
  absolute: {
    position: "absolute",
  },
  inset0: {
    inset: "0",
  },
  selectNone: {
    WebkitUserSelect: "none",
    userSelect: "none",
  },
  textVarTextShimmerHighlight: {
    color: "var(--text-shimmer-highlight)",
  },
  MaskImageLinearGradient90degTransparent25Black45Black55Transparent75: {
    maskImage:
      "linear-gradient(90deg,transparent 25%,black 45%,black 55%,transparent 75%)",
  },
  MaskRepeatNoRepeat: {
    maskRepeat: "no-repeat",
  },
  MaskSize100100: {
    maskSize: "100% 100%",
  },
  WillChangeTransform: {
    willChange: "transform",
  },
  WebkitMaskImageLinearGradient90degTransparent25Black45Black55Transparent75: {
    WebkitMaskImage:
      "linear-gradient(90deg,transparent 25%,black 45%,black 55%,transparent 75%)",
  },
  WebkitMaskRepeatNoRepeat: {
    WebkitMaskRepeat: "no-repeat",
  },
  WebkitMaskSize100100: {
    WebkitMaskSize: "100% 100%",
  },
  block: {
    display: "block",
  },
  wFull: {
    width: "100%",
  },
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
    <span
      className={cn(
        utilityClassName("relative inline-block [contain:paint]"),
        className,
      )}
      data-text-shimmer=""
    >
      <span>{children}</span>
      <span
        aria-hidden="true"
        {...stylex.props(
          sx.pointerEventsNone,
          sx.absolute,
          sx.inset0,
          sx.selectNone,
          sx.textVarTextShimmerHighlight,
          sx.MaskImageLinearGradient90degTransparent25Black45Black55Transparent75,
          sx.MaskRepeatNoRepeat,
          sx.MaskSize100100,
          sx.WillChangeTransform,
          sx.WebkitMaskImageLinearGradient90degTransparent25Black45Black55Transparent75,
          sx.WebkitMaskRepeatNoRepeat,
          sx.WebkitMaskSize100100,
        )}
        style={sweepAnimation}
      >
        <span
          {...stylex.props(sx.block, sx.wFull, sx.WillChangeTransform)}
          style={copyAnimation}
        >
          {children}
        </span>
      </span>
    </span>
  );
}
