import * as stylex from "@stylexjs/stylex";
import {
  color,
  controlHeight,
  corner,
  geometry,
  media,
  motion,
  radius,
  shadow,
  space,
  text,
  weight,
} from "./tokens.stylex";

/**
 * The floating pill: "Load all" at the head of a transcript, "Scroll to the
 * bottom" at its foot, the support thread's agent rail, and the loading state
 * each of them swaps to.
 *
 * They float over live content, so they are a lid: an opaque popup surface
 * with the popup ring. Glass let the words under a pill read through it
 * wherever the text runs the full column (the support thread), so every
 * floating pill is opaque; one surface, wherever it floats.
 *
 * The padding is asymmetric on purpose. Every pill carries a leading icon,
 * and an icon brings its own whitespace to the edge, so the leading side is
 * 4px shorter to keep the two ends in optical balance.
 */
export const floatingPill = stylex.create({
  pill: {
    display: "inline-flex",
    minHeight: controlHeight.md,
    alignItems: "center",
    gap: space.s6,
    borderRadius: radius.capsule,
    ["cornerShape"]: corner.squircle,
    paddingInlineStart: space.s10,
    paddingInlineEnd: space.s14,
    fontSize: text.label,
    fontWeight: weight.strong,
    color: color.fg,
    backgroundColor: color.popup,
    "--smooth-ring-color": color.popupRing,
    boxShadow: shadow.ringSm,
  },
  /** A bare spinner ring carries no side bearing, so it asks for 2px more. */
  loading: { gap: space.s8 },
  /** The glyph-only form: a 32px circle. */
  icon: {
    display: "inline-flex",
    width: controlHeight.md,
    height: controlHeight.md,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    color: color.fg,
    backgroundColor: color.popup,
    "--smooth-ring-color": color.popupRing,
    boxShadow: shadow.ringSm,
  },
  /**
   * The pinned prompt a long turn answers (StickyActivePrompt): the person's
   * bubble in short, one line, right-aligned on the column. Regular weight,
   * since it quotes their words rather than naming an action.
   */
  prompt: {
    display: "inline-flex",
    minWidth: 0,
    maxWidth: geometry.stickyPromptMaxWidth,
    borderRadius: radius.capsule,
    paddingInline: space.s14,
    paddingBlock: space.s6,
    textAlign: "left",
    fontSize: text.label,
    color: color.fg,
    backgroundColor: color.bubbleUser,
    boxShadow: shadow.sm,
  },
  /**
   * The pressable form. The hover wash paints on `::before` so it layers
   * over the surface instead of replacing it, following the pill's corner.
   * `::after` is the hit target, a few pixels past the visible edge; it
   * paints nothing.
   */
  pressable: {
    position: "relative",
    cursor: "pointer",
    transitionProperty: "scale",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
    scale: { default: null, ":active": motion.pressScale },
    "::before": {
      content: "''",
      pointerEvents: "none",
      position: "absolute",
      inset: 0,
      borderRadius: "inherit",
      ["cornerShape"]: "inherit",
      backgroundColor: {
        default: "transparent",
        ":hover": { default: null, [media.hover]: color.hover },
      },
      transitionProperty: "background-color",
      transitionDuration: motion.micro,
      transitionTimingFunction: motion.ease,
    },
    "::after": {
      content: "''",
      position: "absolute",
      inset: `calc(-1 * ${space.s4})`,
    },
  },
  /** The circle's hit target reaches 2px further: it is smaller. */
  pressableWide: {
    "::after": { inset: `calc(-1 * ${space.s6})` },
  },
});
