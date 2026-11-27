import * as React from "react";
import * as stylex from "@stylexjs/stylex";
import { type LayoutStyles, sx } from "./sx";
import { color, corner, radius, space, text, weight } from "./tokens.stylex";

/**
 * Badge — a label that reports state, not an action.
 *
 * This is the shape the app kept rebuilding: a dozen surfaces each wrote their
 * own `rounded-* px-1.5 py-0.5 text-meta` chip, and between them they used
 * three radii, four font weights, and six different ways of tinting the same
 * six states (`bg-yellow/15`, `bg-yellow-soft`, and a hand-written
 * `color-mix(… var(--yellow) 16% …)` all appeared for "warning"). Individually
 * each was defensible; together they made one concept look like six.
 *
 * The choices worth knowing:
 *
 *  - `text-meta`, always. A badge sits inside a row it must not outweigh, so
 *    it does not get its own type size or a bolder weight "because this one
 *    matters." The tone carries that.
 *  - `rounded-sm`, matching the majority of what it replaces. A capsule reads
 *    as a control you can press; a badge is not pressable, and the softer rect
 *    also stays concentric inside the `rounded-md`/`rounded-control` boxes these
 *    live in.
 *  - Tones name the *state*, not the colour. A call site asking for `success`
 *    keeps meaning success when the palette moves; one asking for `green`
 *    does not.
 *  - `soft` is the default because a page of outlined chips reads as a form
 *    (see the "do not frame a section in a border" rule in AGENTS.md).
 *    `outline` stays for the few places that sit ON a filled surface, where a
 *    soft fill has nothing to separate itself from.
 *
 * A badge that opens something is not a badge. Use `Button` with `size="sm"`.
 */

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";
type Variant = "soft" | "outline";

/** A tone's ink at a fixed strength over whatever is behind it. */
const ink = (c: string, pct: number) =>
  `color-mix(in oklab, ${c} ${pct}%, transparent)`;

const styles = stylex.create({
  base: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s4,
    borderRadius: radius.sm,
    ["cornerShape"]: corner.squircle,
    paddingInline: space.s6,
    paddingBlock: space.s2,
    fontSize: text.meta,
    fontWeight: weight.regular,
    whiteSpace: "nowrap",
  },
  outline: { borderStyle: "solid", borderWidth: 1 },
  dot: {
    width: space.s6,
    height: space.s6,
    flexShrink: 0,
    borderRadius: radius.pill,
    backgroundColor: color.current,
  },
  soft_neutral: { backgroundColor: color.active, color: color.dim },
  soft_accent: { backgroundColor: color.accentSoft, color: color.accentInk },
  soft_success: { backgroundColor: color.greenSoft, color: color.green },
  soft_warning: { backgroundColor: color.yellowSoft, color: color.yellow },
  soft_danger: { backgroundColor: color.redSoft, color: color.red },
  soft_info: { backgroundColor: color.blueSoft, color: color.blue },
  outline_neutral: { borderColor: color.line, color: color.dim },
  outline_accent: {
    borderColor: ink(color.accent, 40),
    color: color.accentInk,
  },
  outline_success: { borderColor: ink(color.green, 40), color: color.green },
  outline_warning: { borderColor: ink(color.yellow, 40), color: color.yellow },
  outline_danger: { borderColor: ink(color.red, 40), color: color.red },
  outline_info: { borderColor: ink(color.blue, 40), color: color.blue },
});

const toneStyle = {
  soft: {
    neutral: styles.soft_neutral,
    accent: styles.soft_accent,
    success: styles.soft_success,
    warning: styles.soft_warning,
    danger: styles.soft_danger,
    info: styles.soft_info,
  },
  outline: {
    neutral: styles.outline_neutral,
    accent: styles.outline_accent,
    success: styles.outline_success,
    warning: styles.outline_warning,
    danger: styles.outline_danger,
    info: styles.outline_info,
  },
} as const;

export type BadgeProps = React.ComponentPropsWithoutRef<"span"> & {
  tone?: Tone;
  variant?: Variant;
  /** A leading state dot, filled with the tone's ink. */
  dot?: boolean;
  /** Placement only; tone and variant decide the look. */
  xstyle?: LayoutStyles;
};

export function Badge({
  tone = "neutral",
  variant = "soft",
  dot,
  xstyle,
  className,
  style,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      {...rest}
      {...sx(
        [
          styles.base,
          variant === "outline" && styles.outline,
          toneStyle[variant][tone],
          xstyle,
        ],
        className,
        style,
      )}
    >
      {dot && <span {...stylex.props(styles.dot)} aria-hidden="true" />}
      {children}
    </span>
  );
}
