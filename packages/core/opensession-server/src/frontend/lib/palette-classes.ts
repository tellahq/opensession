import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";
import { type as typography } from "../styles/typography.stylex";
import { sharedClassStyles } from "../styles/shared-class-styles.stylex";

const sx = stylex.create({
  relative: {
    position: "relative",
  },
  inlineFlex: {
    display: "inline-flex",
  },
  size10: {
    width: "40px",
    height: "40px",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "var(--tw-border-style)",
    borderWidth: "1px",
  },
  borderTransparent: {
    borderColor: "transparent",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  transitionColor: {
    transitionProperty: "color",
    transitionTimingFunction: "var(--tw-ease,var(--ease))",
    transitionDuration: "var(--tw-duration,var(--dur-micro))",
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  disabledCursorDefault: {
    ":disabled": {
      cursor: "default",
    },
  },
  disabledOpacity50: {
    ":disabled": {
      opacity: ".5",
    },
  },
  roundedFull: {
    borderRadius: "3.40282e38px",
    cornerShape: "round",
  },
  textAccent: {
    color: "var(--accent-ink)",
  },
  minH8: {
    minHeight: "32px",
  },
  maxW180px: {
    maxWidth: "180px",
  },
  gap15: {
    gap: "6px",
  },
  px11px: {
    paddingInline: "11px",
  },
  py5px: {
    paddingBlock: "5px",
  },
  fontMedium: {
    "--tw-font-weight": "var(--font-weight-medium)",
    fontWeight: "var(--font-weight-medium)",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  disabledOpacity55: {
    ":disabled": {
      opacity: ".55",
    },
  },

  beforeRoundedFull: {
    "::before": {
      content: "var(--tw-content)",
      borderRadius: "3.40282e38px",
    },
  },
  beforeCornerShapeRound: {
    "::before": {
      content: "var(--tw-content)",
      cornerShape: "round",
    },
  },
  beforeBgColorMixInSrgbVarAccent16Transparent: {
    "::before": {
      content: "var(--tw-content)",
      backgroundColor: "var(--accent)",
    },
    "@supports (color: color-mix(in lab, red, red))": {
      "::before": {
        backgroundColor: "color-mix(in srgb,var(--accent) 16%,transparent)",
      },
    },
  },
  hoverBeforeBgColorMixInSrgbVarAccent24Transparent: {
    "@media (hover: hover)": {
      ":hover": {
        "::before": {
          content: "var(--tw-content)",
          backgroundColor: "var(--accent)",
        },
      },
      "@supports (color: color-mix(in lab, red, red))": {
        ":hover": {
          "::before": {
            backgroundColor: "color-mix(in srgb,var(--accent) 24%,transparent)",
          },
        },
      },
    },
  },
  transitionBackgroundBorderColorColor: {
    transitionProperty: "background,border-color,color",
    transitionTimingFunction: "var(--tw-ease,var(--ease))",
    transitionDuration: "var(--tw-duration,var(--dur-micro))",
  },

  hoverTextAccent: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--accent-ink)",
      },
    },
  },
});

/**
 * Shared Tailwind class maps for the `palette-*` family — the quiet icon
 * button and the model/effort pill that the composer toolbar and the
 * new-session palette footer both build their rows out of.
 *
 * Same two rules as lib/composer-classes.ts, and breaking either one fails
 * silently — no build error, just the wrong pixels:
 *
 * 1. **Every class is spelled out in full, literal text.** Tailwind scans
 *    source as text, so an interpolated class is never generated. Add a
 *    variant by adding a literal entry here, never by building the string.
 * 2. **A base string carries geometry; a variant carries a complete state.**
 *    Two competing colour utilities on one element do not compose — the
 *    browser takes whichever Tailwind emitted last — so `paletteIconBtnOn`
 *    restates its hover colour rather than leaning on the base's.
 *
 * These are meant to be combined through `cn()`, not concatenated: the
 * variants below depend on tailwind-merge dropping the base entry they
 * replace (`rounded-full` over `rounded-control`, `text-accent` over
 * `text-dim`). A plain template string leaves both in and the winner is
 * decided by the compiled sheet's order.
 */

/* ── The quiet icon button ────────────────────────────────────────
   A 40px pointer target around a 20px glyph, painting a 32px wash. The wash
   is a pseudo-element inset by 4px rather than the button box: filling all
   40px read as a slab twice the size of the glyph, and the button has to keep
   its target on every viewport. `src/frontend/AGENTS.md` cites this control
   as the example of keeping a hover wash proportional.

   Three details are load-bearing:
   · `border-transparent` is a real 1px border holding layout, not decoration.
     The wash is `inset-1` from the PADDING box, so dropping the border would
     grow it from 30px to 32px.
   · `[&>*]:relative [&>*]:z-[1]` lifts the glyph (and the new-session
     footer's count badge) above the wash — the pseudo-element is positioned,
     so it would otherwise paint over static in-flow content.
   · `before:[corner-shape:var(--cs)]` is not redundant with `rounded-*`.
     base.css grants the squircle to elements carrying a `rounded-` class, and
     `corner-shape` does NOT inherit into a pseudo-element — so a `::before`
     whose radius comes from `before:rounded-control` still resolves `round`
     and the wash hovers into a plain rounded rect inside a squircled button.
     The token spells itself `round` outside the `@supports` block, which is
     what keeps the fallback honest.
   · The base button reset in styles/base.css already supplies `cursor`,
     `background`, `padding` and `border: none`, so only the deviations are
     written here. */
export const paletteIconBtn =
  mergeStylexClassName(
    "",
    sx.relative,
    sx.inlineFlex,
    sx.size10,
    sx.itemsCenter,
    sx.justifyCenter,
    sx.roundedControl,
    sx.border,
    sx.borderTransparent,
    typography.itemTitle,
    sx.textDim,
    sx.transitionColor,
    sx.hoverTextFg,
    sx.disabledCursorDefault,
    sx.disabledOpacity50,
  ) +
  " " +
  mergeStylexClassName(
    "",
    sharedClassStyles.beforeAbsolute,
    sharedClassStyles.beforeInset1,
    sharedClassStyles.beforeZ0,
    sharedClassStyles.beforeRoundedControl,
    sharedClassStyles.beforeCornerShapeVarCs,
    sharedClassStyles.beforeTransitionBackgroundBoxShadow,
    sharedClassStyles.beforeContent,
    sharedClassStyles.hoverBeforeBgHover,
  ) +
  " " +
  "[&>*]:relative [&>*]:z-[1] phone:[&_svg]:size-5";

/** The phone composer's resting pill, and the ONE place `rounded-full` is the
 *  right spelling in this family. base.css grants `corner-shape: squircle` to
 *  `[class*="rounded-"]:not([class*="rounded-full"])`, so `rounded-full` is
 *  precisely the opt-out — and opting out is the intent here: the resting
 *  composer IS a 999px pill and its + / mic sit flush in its rounded ends, so
 *  they have to be circles. A squircle at 50% is a lobed blob, not a circle.
 *  The wash needs the same treatment or a circular button hovers into a
 *  squircle. Everywhere else this family keeps its squircle. */
export const paletteIconBtnRound = mergeStylexClassName(
  "",
  sx.beforeRoundedFull,
  sx.beforeCornerShapeRound,
  sx.roundedFull,
);

/** On reads as one filled accent chip: the glyph lights up with its wash. The
 *  hover colour is restated because the base's `hover:text-fg` is a different
 *  conflict group from `text-dim` — without it, an on toggle would drop back
 *  to plain ink under the cursor, and the stylesheet's `.is-on` never did.
 *  Both hover fills stay in the wash rather than a border: a full-strength
 *  ring read as a validation outline, and it is the one thing that survived
 *  on the plan-mode surface, which carries its own accent tint. */
export const paletteIconBtnOn = mergeStylexClassName(
  "",
  sx.hoverTextAccent,
  sx.beforeBgColorMixInSrgbVarAccent16Transparent,
  sx.hoverBeforeBgColorMixInSrgbVarAccent24Transparent,
  sx.textAccent,
);

/* ── The model/effort pill ────────────────────────────────────────
   ModelEffortSelect's trigger, in the composer toolbar and in the new-session
   palette footer. It stays a pill: it is a text readout you can change, not a
   plate you press.

   `rounded-full`, not `rounded-[999px]`: this control has never been a
   squircle — the stylesheet said a bare `border-radius: 999px` with no
   `corner-shape`, and the class is not in base.css's explicit squircle list.
   `rounded-[999px]` would opt it IN and change the corner.

   The border is transparent, which is the rendered state rather than a
   change: ModelEffortSelect's own trigger string already carried
   `border-transparent` ("quiet pill: no outline at rest, hover state only"),
   and as a utility it outranked the stylesheet's `var(--border)` on source
   order. Written out here so the constant describes what actually paints. */
export const palettePill = mergeStylexClassName(
  "",
  sx.transitionBackgroundBorderColorColor,
  sx.relative,
  sx.inlineFlex,
  sx.minH8,
  sx.maxW180px,
  sx.itemsCenter,
  sx.gap15,
  sx.roundedFull,
  sx.border,
  sx.borderTransparent,
  sx.px11px,
  sx.py5px,
  typography.label,
  sx.fontMedium,
  sx.textDim,
  sx.hoverBgHover,
  sx.hoverTextFg,
  sx.disabledCursorDefault,
  sx.disabledOpacity55,
);
