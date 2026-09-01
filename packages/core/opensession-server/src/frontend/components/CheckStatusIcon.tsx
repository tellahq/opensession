import type { CheckVisual } from "../lib/pr-checks";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  m15px: {
    margin: "1.5px",
  },
  block: {
    display: "block",
  },
  size13px: {
    width: "13px",
    height: "13px",
  },
  animateSpin: {
    animation: "var(--animate-spin)",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderCurrent30: {
    borderColor: "color-mix(in oklab, currentcolor 30%, transparent)",
  },
  borderTCurrent: {
    borderTopColor: "currentcolor",
  },
  size4: {
    width: "calc(4px * 4)",
    height: "calc(4px * 4)",
  },
});

export function CheckStatusIcon({ kind }: { kind: CheckVisual }) {
  if (kind === "pending")
    return (
      <span
        {...stylex.props(
          sx.m15px,
          sx.block,
          sx.size13px,
          sx.animateSpin,
          sx.roundedFull,
          sx.border,
          sx.borderCurrent30,
          sx.borderTCurrent,
        )}
        aria-hidden
      />
    );
  if (kind === "success")
    return (
      <svg
        {...stylex.props(sx.block, sx.size4)}
        viewBox="0 0 16 16"
        aria-hidden
      >
        <circle cx="8" cy="8" r="8" fill="currentColor" />
        <path
          d="M4.4 8.3l2.3 2.3 4.9-4.9"
          fill="none"
          stroke="#fff"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (kind === "failure")
    return (
      <svg
        {...stylex.props(sx.block, sx.size4)}
        viewBox="0 0 16 16"
        aria-hidden
      >
        <circle cx="8" cy="8" r="8" fill="currentColor" />
        <path
          d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2"
          stroke="#fff"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  return (
    <svg {...stylex.props(sx.block, sx.size4)} viewBox="0 0 16 16" aria-hidden>
      <circle
        cx="8"
        cy="8"
        r="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeDasharray="2.4 2.2"
      />
    </svg>
  );
}
