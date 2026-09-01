import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";
import { type as typography } from "../styles/typography.stylex";

const sx = stylex.create({
  mb6: {
    marginBottom: "24px",
  },
  flex: {
    display: "flex",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap15: {
    gap: "6px",
  },
  focusRing: {
    ":focusVisible": {
      outline: "2px solid var(--accent-ink)",
      outlineOffset: "2px",
    },
    "@media (forced-colors: active)": {
      ":focusVisible": {
        outlineColor: "highlight",
      },
    },
  },
  inlineFlex: {
    display: "inline-flex",
  },
  minW0: {
    minWidth: "0",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  gap2: {
    gap: "8px",
  },
  rounded999px: {
    borderRadius: "999px",
    cornerShape: "var(--cs)",
  },
  border0: {
    borderStyle: "var(--tw-border-style)",
    borderWidth: "0",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  py1: {
    paddingBlock: "4px",
  },
  pr3: {
    paddingRight: "12px",
  },
  pl1: {
    paddingLeft: "4px",
  },
  fontMedium: {
    "--tw-font-weight": "var(--font-weight-medium)",
    fontWeight: "var(--font-weight-medium)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  transitionColors: {
    transitionProperty:
      "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
    transitionTimingFunction: "var(--tw-ease,var(--ease))",
    transitionDuration: "var(--tw-duration,var(--dur-micro))",
  },
  durationVarDurMicro: {
    "--tw-duration": "var(--dur-micro)",
    transitionDuration: "var(--dur-micro)",
  },
  easeVarEase: {
    "--tw-ease": "var(--ease)",
    transitionTimingFunction: "var(--ease)",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  bgAccent: {
    backgroundColor: "var(--accent)",
  },
  fontSemibold: {
    "--tw-font-weight": "var(--font-weight-semibold)",
    fontWeight: "var(--font-weight-semibold)",
  },
  textOnAccent: {
    color: "var(--on-accent)",
  },
  hoverBgAccentHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--accent-hover)",
      },
    },
  },
  hoverTextOnAccent: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--on-accent)",
      },
    },
  },
  size26px: {
    width: "26px",
    height: "26px",
  },
  shrink0: {
    flexShrink: "0",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  roundedAvatar: {
    borderRadius: "calc(32% * var(--rp))",
    cornerShape: "var(--cs)",
  },
  bgHover: {
    backgroundColor: "var(--hover)",
  },
  m0: {
    margin: "0",
  },
  mb2: {
    marginBottom: "8px",
  },
  textFg: {
    color: "var(--text)",
  },

  bgColorMixInSrgbVarOnAccent22Transparent: {
    backgroundColor: "var(--on-accent)",
    "@supports (color: color-mix(in lab, red, red))": {
      backgroundColor: "color-mix(in srgb,var(--on-accent) 22%,transparent)",
    },
  },
});

/**
 * The Feed page's scope row: the team and its organizations, as chips.
 *
 * They were cards in a grid when this page was called People and the roster
 * was the point. The feed is the point now, so the roster shrinks to what it
 * always was in practice — a row you pick from — and gets out of the way of
 * the thing you came to read.
 */

/** The row itself. It wraps rather than scrolling sideways: a hidden teammate
 *  is a teammate you never pick, and there are not enough of them to justify
 *  a scroll affordance. */
export const PEOPLE_CHIP_ROW = mergeStylexClassName(
  "",
  sx.mb6,
  sx.flex,
  sx.flexWrap,
  sx.itemsCenter,
  sx.gap15,
);

/** One scope: everyone, a person, or an organization. */
export const PEOPLE_CHIP =
  mergeStylexClassName(
    "",
    sx.focusRing,
    sx.inlineFlex,
    sx.minW0,
    sx.cursorPointer,
    sx.itemsCenter,
    sx.gap2,
    sx.rounded999px,
  ) +
  " " +
  mergeStylexClassName(
    "",
    sx.border0,
    sx.bgPanel,
    sx.py1,
    sx.pr3,
    sx.pl1,
    typography.controlLabel,
    sx.fontMedium,
    sx.textDim,
  ) +
  " " +
  mergeStylexClassName(
    "",
    sx.transitionColors,
    sx.durationVarDurMicro,
    sx.easeVarEase,
  ) +
  " " +
  mergeStylexClassName("", sx.hoverBgHover, sx.hoverTextFg);

/** The scope the feed is on. A wash the strength of a hover state read as one
 *  more chip you happened to be pointing at, on a row where the pick also
 *  decides what the sidebar holds. It takes the accent plate instead, which is
 *  the same mark the rest of the app puts on a chosen thing. */
export const PEOPLE_CHIP_SELECTED = mergeStylexClassName(
  "",
  sx.bgAccent,
  sx.fontSemibold,
  sx.textOnAccent,
  sx.hoverBgAccentHover,
  sx.hoverTextOnAccent,
);

/** The glyph slot in a chip that has no face of its own (Everyone). */
export const PEOPLE_CHIP_GLYPH = mergeStylexClassName(
  "",
  sx.flex,
  sx.size26px,
  sx.shrink0,
  sx.itemsCenter,
  sx.justifyCenter,
  sx.roundedAvatar,
  sx.bgHover,
  sx.textDim,
);

/** The same slot on the accent plate: the wash is ink, which disappears into a
 *  dark fill, so it inverts with the chip. */
export const PEOPLE_CHIP_GLYPH_SELECTED = mergeStylexClassName(
  "",
  sx.bgColorMixInSrgbVarOnAccent22Transparent,
  sx.textOnAccent,
);

/** "Shipped" and any other heading on the page. A step above the interface
 *  label it started as: it heads the whole list under it, so it reads as a
 *  heading rather than as the caption on a control. */
export const PEOPLE_SECTION_LABEL = mergeStylexClassName(
  "",
  sx.m0,
  sx.mb2,
  typography.body,
  sx.fontSemibold,
  sx.textFg,
);
