import * as React from "react";
import { IconChevronDown } from "../components/icons";
import * as stylex from "@stylexjs/stylex";
import type {
  CompiledStyles,
  StyleXArray,
  StyleXStyles,
} from "@stylexjs/stylex";
import { cn } from "./cn";
import {
  color,
  controlHeight,
  focus,
  leading,
  media,
  motion,
  opacity,
  radius,
  shadow,
  space,
  text,
  weight,
} from "./tokens.stylex";

/**
 * Button primitive: the shared optics for text, icon+label, and icon-only
 * buttons. The first primitive authored in StyleX against the closed scales in
 * `tokens.stylex.ts` (see docs/design-system.md): callers place it with
 * `xstyle`, and pick its look with `variant` and `size`.
 *
 * The icon/spacing rules are ported from a mature button system
 * (webapp Button.res + ButtonWithIcon.res — the product these iconic-pro
 * glyphs come from):
 *
 *  - icon ↔ label gap is 4px, with 20px iconic glyphs (their `w-5 h-5`
 *    convention; matches our icons.tsx size-20 "inline/meta" step);
 *  - when an icon LEADS a label, pull the icon-side padding in, so the pair
 *    reads optically balanced against a text-only button — the glyph's
 *    built-in whitespace otherwise makes the icon side look padded out;
 *  - dim the leading icon relative to the label (opacity-50 on
 *    neutral weights, a lighter tint on the primary) — the label stays the
 *    dominant read, the icon is support;
 *  - icon-only buttons go square with symmetric padding and the icon
 *    dead-centered, UNdimmed — there the icon *is* the label;
 *  - press feedback is a whole-button scale tick (active:scale-97).
 *
 * `caret` is the mirror of `icon` for menu triggers: one trailing chevron,
 * sized off the LABEL rather than the 20px glyph step, with the same padding
 * pull on its own side. Every "label opens a menu" trigger in the app was
 * drawing its own chevron at 14, 16, 17 or 18 — the affordance belongs to the
 * primitive, so the whole family reads as one control.
 *
 * How big the pull and the gap are is measured, not chosen. Padding is a box
 * measurement and the eye reads ink, so the two disagree by whatever
 * whitespace the glyph carries: a 20px iconic-pro icon sits about 5px inside
 * its own box, while a label's first letter starts about 1.3px inside its
 * text box. Rendered, `px-3` with a 2px pull put the icon 15.0px from the
 * edge against the label's 13.3px, and left only 7.5px of air between icon
 * and label — so the icon read as pushed off the edge and glued to the word.
 * Pulling 4px on the glyph's side lands both outer insets on ~13px, and
 * `gap-1.5` opens the inner air to ~9.5px, under the outer inset so the pair
 * still binds. The chevron carries more whitespace still (~6.5px), which is
 * why it keeps `gap-1` and reaches the same ~9.8px optical gap.
 */

type Variant =
  | "default"
  | "primary"
  | "soft"
  | "ghost"
  | "overlay"
  | "success"
  | "danger"
  | "warning"
  | "danger-strong"
  | "success-strong";
type Size = "sm" | "md" | "lg" | "xl";

/** `color-mix` ink at a fixed strength over whatever surface is behind it. */
const ink = (c: string, pct: number) =>
  `color-mix(in oklab, ${c} ${pct}%, transparent)`;

const styles = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderStyle: "solid",
    borderWidth: 1,
    whiteSpace: "nowrap",
    userSelect: "none",
    // Inert on a <button>, load-bearing under `render`: an <a> underlines
    // its text by default, so a button that navigates would arrive looking
    // like body copy.
    textDecoration: "none",
    fontWeight: weight.medium,
    // Tailwind interop while callers still pass utilities: `text-meta` and
    // friends read their weight from this, and before the port Button's
    // `font-medium` set it. Delete with the last Tailwind caller.
    "--tw-font-weight": weight.medium,
    transitionProperty: "color, background-color, border-color, filter, scale",
    transitionTimingFunction: motion.ease,
    transitionDuration: motion.micro,
    scale: { default: null, ":active": motion.pressScale },
    // One keyboard focus treatment for every variant, with the forced-colors
    // fallback, instead of each engine's default outline.
    outline: { default: null, ":focus-visible": focus.ring },
    outlineOffset: { default: null, ":focus-visible": focus.offset },
    outlineColor: {
      default: null,
      [media.forcedColors]: { default: null, ":focus-visible": "Highlight" },
    },
    pointerEvents: { default: null, ":disabled": "none" },
    opacity: { default: null, ":disabled": opacity.disabled },
  },

  // Heights bracket the app's chrome: 32 matches the viewer header buttons,
  // 26 the chip/inline tier.
  //
  // One shape across every size and variant: a pill, and a circle when the
  // button is icon-only. It matches the composer's send disc, the
  // new-session Create and the tabs, so every pressable plate in the app
  // reads as one family. A true pill also opts out of base.css's squircle (a
  // squircle at 50% is a lobed blob).
  //
  // Padding sits half a step wider than it did as a rect: a pill's ends eat
  // into the label's air.
  //
  // At phone width every size is a 44px touch target: a finger does not get
  // smaller with the label. Call sites used to patch `phone:min-h-11` on one
  // button at a time, and the ones that forgot shipped 26px targets.
  //
  // One line box for every size (`leading.label`). The label is trimmed to
  // its cap band (`styles.label`), so it only shows on an element child or a
  // wrap.
  sm: {
    minHeight: {
      default: controlHeight.sm,
      [media.phone]: controlHeight.touch,
    },
    lineHeight: leading.label,
    paddingInline: space.s12,
    fontSize: text.label,
    borderRadius: radius.pill,
  },
  md: {
    minHeight: {
      default: controlHeight.md,
      [media.phone]: controlHeight.touch,
    },
    lineHeight: leading.label,
    paddingInline: space.s14,
    fontSize: text.label,
    borderRadius: radius.pill,
  },
  lg: {
    minHeight: {
      default: controlHeight.lg,
      [media.phone]: controlHeight.touch,
    },
    lineHeight: leading.label,
    paddingInline: space.s16,
    fontSize: text.body,
    borderRadius: radius.pill,
  },
  xl: {
    minHeight: {
      default: controlHeight.xl,
      [media.phone]: controlHeight.touch,
    },
    lineHeight: leading.label,
    paddingInline: space.s16,
    fontSize: text.body,
    borderRadius: radius.pill,
  },

  // The air between glyph and label (see the doc block for the measurement).
  leadGap: { gap: space.s6 },
  plainGap: { gap: space.s4 },

  // Leading icon + label: shave 4px off the icon side, which is the glyph's
  // own whitespace minus the label's side bearing.
  iconLead_sm: { paddingInlineStart: space.s8 },
  iconLead_md: { paddingInlineStart: space.s10 },
  iconLead_lg: { paddingInlineStart: space.s12 },
  iconLead_xl: { paddingInlineStart: space.s12 },
  // Trailing caret + label: the same 4px shave, on the caret's side.
  caretTrail_sm: { paddingInlineEnd: space.s8 },
  caretTrail_md: { paddingInlineEnd: space.s10 },
  caretTrail_lg: { paddingInlineEnd: space.s12 },
  caretTrail_xl: { paddingInlineEnd: space.s12 },
  // Icon-only: a square hit target, symmetric.
  iconOnly_sm: {
    width: { default: controlHeight.sm, [media.phone]: controlHeight.touch },
    paddingInline: space.s0,
  },
  iconOnly_md: {
    width: { default: controlHeight.md, [media.phone]: controlHeight.touch },
    paddingInline: space.s0,
  },
  iconOnly_lg: {
    width: { default: controlHeight.lg, [media.phone]: controlHeight.touch },
    paddingInline: space.s0,
  },
  iconOnly_xl: {
    width: { default: controlHeight.xl, [media.phone]: controlHeight.touch },
    paddingInline: space.s0,
  },

  // ── Variants ──
  //
  // Which one, in one line each. The question a variant answers is what the
  // button is FOR on its surface, not how loud you want it:
  //
  // - `primary`: the answer. One per surface, and only where there is one.
  // - `default`: a control standing alone on the page (a header action, a
  //   toolbar, a card's single button). Raised, so it reads as a thing to
  //   press against a surface that is otherwise flat.
  // - `soft`: everything in a row that is not the answer, or any neutral
  //   button sitting ON a panel or card. A grey plate, no edge.
  // - `ghost`: a control that is mostly reporting state (a filter, an icon
  //   in a row). Quiet until you reach for it.
  // - `overlay`: an inverse ghost floating over a dark media scrim.
  // - the tones: `danger`, `success` and `warning` are tinted plates that
  //   propose; `danger-strong` and `success-strong` are solid ones that
  //   commit.
  //
  // Hover rules sit behind `(hover: hover)` so a tap on a phone does not
  // leave a stuck wash; `:is([data-popup-open])` is Base UI's open state, so a
  // menu trigger stays lit while its menu is open.

  // Paper in light, graphite in dark: the hairline and the cast shadow are
  // what say "raised", so the fill does not have to.
  default: {
    backgroundColor: color.button,
    borderColor: {
      default: color.line,
      ":hover": { default: null, [media.hover]: color.lineStrong },
    },
    color: {
      default: color.dim,
      ":hover": { default: null, [media.hover]: color.fg },
    },
    boxShadow: shadow.xs,
  },
  // Solid ink, for the one dominant action on a surface. The label is
  // `onAccent`, not white: on an ink fill white-on-white is what dark mode
  // would get. The hover takes `accentHover`, which picks its own direction
  // per accent.
  primary: {
    backgroundColor: {
      default: color.accent,
      ":hover": { default: null, [media.hover]: color.accentHover },
    },
    borderColor: color.transparent,
    color: color.onAccent,
    backgroundImage: shadow.plateSheen,
    boxShadow: shadow.xs,
  },
  // A plate with no hairline: the quiet neutral button. The step is
  // RELATIVE (ink over whatever is behind it), so it holds its shape on a
  // panel, a card, or the sidebar's translucent material.
  soft: {
    backgroundColor: {
      default: ink(color.fg, 8),
      ":hover": { default: null, [media.hover]: ink(color.fg, 13) },
      ":is([data-popup-open])": ink(color.fg, 13),
    },
    borderColor: color.transparent,
    color: {
      default: color.dim,
      ":hover": { default: null, [media.hover]: color.fg },
      ":is([data-popup-open])": color.fg,
    },
  },
  ghost: {
    backgroundColor: {
      default: null,
      ":hover": { default: null, [media.hover]: color.hover },
      ":is([data-popup-open])": color.hover,
    },
    borderColor: color.transparent,
    color: {
      default: color.dim,
      ":hover": { default: null, [media.hover]: color.fg },
      ":is([data-popup-open])": color.fg,
    },
  },
  overlay: {
    backgroundColor: {
      default: color.transparent,
      ":hover": { default: null, [media.hover]: ink(color.onScrim, 15) },
    },
    borderColor: color.transparent,
    color: {
      default: ink(color.onScrim, 60),
      ":hover": { default: null, [media.hover]: color.onScrim },
    },
  },
  // The tones: a tinted plate that PROPOSES, a solid one that COMMITS. The
  // tint is the `-soft` token, so it layers over any surface; the hover
  // doubles it rather than adding an edge. Yellow has no strong half: it
  // qualifies an action, and nothing in the app commits in yellow.
  success: {
    backgroundColor: {
      default: color.greenSoft,
      ":hover": { default: null, [media.hover]: ink(color.green, 22) },
    },
    borderColor: color.transparent,
    color: color.green,
  },
  danger: {
    backgroundColor: {
      default: color.redSoft,
      ":hover": { default: null, [media.hover]: ink(color.red, 22) },
    },
    borderColor: color.transparent,
    color: color.red,
  },
  warning: {
    backgroundColor: {
      default: color.yellowSoft,
      ":hover": { default: null, [media.hover]: ink(color.yellow, 22) },
    },
    borderColor: color.transparent,
    color: color.yellow,
  },
  dangerStrong: {
    backgroundColor: color.red,
    borderColor: color.transparent,
    color: color.onScrim,
    backgroundImage: shadow.plateSheen,
    boxShadow: shadow.xs,
    filter: {
      default: null,
      ":hover": { default: null, [media.hover]: "brightness(110%)" },
    },
  },
  successStrong: {
    backgroundColor: color.green,
    borderColor: color.transparent,
    color: color.onScrim,
    backgroundImage: shadow.plateSheen,
    boxShadow: shadow.xs,
    filter: {
      default: null,
      ":hover": { default: null, [media.hover]: "brightness(110%)" },
    },
  },

  // ── Inner parts ──
  glyph: { display: "inline-flex", flexShrink: 0, alignItems: "center" },
  glyphMuted: { opacity: opacity.glyphMuted },
  glyphOnTone: { opacity: opacity.glyphOnTone },
  caret: { flexShrink: 0, opacity: opacity.glyphMuted },
  // A text label is centred on its CAP BAND, not its line box: the line box
  // carries the font's descender space, which put the ink ~1.75px high.
  // `text-box` trims to cap height and baseline, right in every font.
  label: { textBox: "trim-both cap alphabetic" },
});

const sizeStyle = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
  xl: styles.xl,
} as const;
const iconLeadPad = {
  sm: styles.iconLead_sm,
  md: styles.iconLead_md,
  lg: styles.iconLead_lg,
  xl: styles.iconLead_xl,
} as const;
const caretTrailPad = {
  sm: styles.caretTrail_sm,
  md: styles.caretTrail_md,
  lg: styles.caretTrail_lg,
  xl: styles.caretTrail_xl,
} as const;
const iconOnlyPad = {
  sm: styles.iconOnly_sm,
  md: styles.iconOnly_md,
  lg: styles.iconOnly_lg,
  xl: styles.iconOnly_xl,
} as const;
const variantStyle = {
  default: styles.default,
  primary: styles.primary,
  soft: styles.soft,
  ghost: styles.ghost,
  overlay: styles.overlay,
  success: styles.success,
  danger: styles.danger,
  warning: styles.warning,
  "danger-strong": styles.dangerStrong,
  "success-strong": styles.successStrong,
} as const;

// The caret keys off the label, not the 20px icon step: an iconic-pro glyph
// at 14 draws an arrow about as tall as the cap height of a 12px label.
// Leading-icon dimming: full-strength plates (primary, tones) take the
// lighter dim, neutral weights the stronger one. Icon-only stays undimmed.
const dimsOnTone = new Set<Variant>([
  "primary",
  "success",
  "danger",
  "warning",
  "danger-strong",
  "success-strong",
]);

/**
 * What a caller may change about a Button: where it sits, never what it looks
 * like. Size, colour, padding and corner come from `size` and `variant`; a
 * surface that needs something else needs a new variant, agreed once, rather
 * than a local override that the next screen copies.
 */
export type ButtonLayoutStyles = StyleXStyles<{
  margin?: string | number | null;
  marginBlock?: string | number | null;
  marginInline?: string | number | null;
  marginTop?: string | number | null;
  marginBottom?: string | number | null;
  marginInlineStart?: string | number | null;
  marginInlineEnd?: string | number | null;
  flex?: string | number | null;
  flexGrow?: string | number | null;
  flexShrink?: string | number | null;
  flexBasis?: string | number | null;
  alignSelf?: string | number | null;
  justifySelf?: string | number | null;
  order?: string | number | null;
  gridArea?: string | number | null;
  gridColumn?: string | number | null;
  gridRow?: string | number | null;
  width?: string | number | null;
  maxWidth?: string | number | null;
  minWidth?: string | number | null;
}>;

type ButtonRenderProps = React.ComponentPropsWithoutRef<"button"> & {
  ref?: React.ForwardedRef<HTMLButtonElement>;
};

export type ButtonProps = React.ComponentPropsWithoutRef<"button"> & {
  variant?: Variant;
  size?: Size;
  /** Leading icon — pass a 20px glyph from components/icons.tsx. Renders an
   * icon-only square button when there are no children. */
  icon?: React.ReactNode;
  /** Keep a labelled button's icon at full strength when its color carries
   * meaning. Neutral supporting icons stay muted by default. */
  iconTone?: "muted" | "full";
  /** Trailing dropdown chevron, for a button that opens a menu. Inherits the
   * button's own color at low strength: a fixed grey caret reads as a dead
   * spot next to a red or green label. */
  caret?: boolean;
  /**
   * A trailing glyph that is not a chevron, on the same terms as `caret`:
   * same gap, same padding pull, sized by the caller. The one this exists
   * for is the outbound arrow on a button that leaves the app.
   *
   * It is a slot rather than "put it in children" because the cap-band trim
   * below only reaches a plain string. A caller who passes
   * `<>{"Merge"}<IconArrowUpRight /></>` gets an element child, silently
   * loses the trim, and lands the word a pixel high, which is the exact bug
   * this primitive exists to make impossible.
   */
  trailing?: React.ReactNode;
  /**
   * Render these optics on another element, for a control that is not a
   * `<button>`. Base UI's convention, and the one the app already uses for
   * menu and dialog triggers, so `render={<a href={url} />}` reads the same
   * here as it does there.
   *
   * It exists because an action that NAVIGATES has to be an anchor: middle
   * click, cmd-click and the context menu's copy-link all come from the
   * element, not from an onClick. Without this the choice was a `<button>`
   * that swallows those, or a hand-rolled plate outside the primitive, and
   * the app has ten of the latter. The hand-rolled ones are also how a
   * control quietly misses what this component does for a label: the whole
   * hover card footer sat a pixel high because it was a class string rather
   * than a Button.
   *
   * The element's own className wins over the variant's, so a caller can
   * restyle one edge without forking the component. `disabled` is a
   * `<button>` attribute and does nothing on an anchor: an anchor that
   * should not be followed has no href.
   */
  render?: React.ReactElement<ButtonRenderProps>;
  /**
   * Layout-only StyleX overrides (margin, flex, grid placement, width). The
   * type rejects anything that would change how the button looks; reach for
   * `variant` and `size` for that.
   */
  xstyle?: ButtonLayoutStyles;
  /**
   * A primitive's own look on top of the variant, for a control in `ui/`
   * that IS a button with a twist (the overlay action's white plate and
   * reveal). Not for feature code: `bun scripts/ui-audit.ts` fails any use
   * outside `ui/` (`button-skin`), where the answer is a variant here.
   */
  skin?: StyleXArray<CompiledStyles | null | undefined | boolean>;
  /**
   * @deprecated for anything but layout. Kept while call sites migrate to
   * `xstyle`; `bun scripts/ui-audit.ts` counts the visual overrides.
   */
  className?: string;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "default",
      size = "md",
      icon,
      iconTone = "muted",
      caret,
      trailing,
      render,
      xstyle,
      skin,
      className,
      children,
      ...rest
    },
    ref,
  ) {
    const hasLabel = children != null && children !== false && children !== "";
    const iconOnly = icon != null && !hasLabel;
    // A text label is centered on its CAP BAND, not on its line box. The
    // line box carries the font's descender space, so flex centering puts
    // the ink about 1.75px high — measured on the sm button: 6.5px of air
    // above the cap, 10px below the baseline. `text-box` trims the box to
    // cap height and baseline, which lands both within a quarter pixel and
    // costs nothing per font, where a hand-tuned nudge would be wrong on
    // every font but the one it was measured in. It only applies to a
    // plain string child: an element child brings its own layout, and
    // wrapping it would make it a flex item of a flex item.
    const hasPlainLabel =
      children != null &&
      (children.constructor === String || children.constructor === Number);
    const label = hasPlainLabel ? (
      <span {...stylex.props(styles.label)}>{children}</span>
    ) : (
      children
    );
    const content = (
      <>
        {icon != null && (
          <span
            {...stylex.props(
              styles.glyph,
              !iconOnly &&
                iconTone === "muted" &&
                (dimsOnTone.has(variant)
                  ? styles.glyphOnTone
                  : styles.glyphMuted),
            )}
          >
            {icon}
          </span>
        )}
        {label}
        {trailing != null && (
          <span {...stylex.props(styles.glyph)}>{trailing}</span>
        )}
        {caret && (
          <IconChevronDown
            className={stylex.props(styles.caret).className}
            size={20}
          />
        )}
      </>
    );
    const optics = stylex.props(
      styles.base,
      icon != null && hasLabel ? styles.leadGap : styles.plainGap,
      sizeStyle[size],
      variantStyle[variant],
      icon != null && hasLabel && iconLeadPad[size],
      (caret || trailing != null) && hasLabel && caretTrailPad[size],
      iconOnly && iconOnlyPad[size],
      skin,
      xstyle,
    );
    // A caller's Tailwind `className` still lands last and wins ties, as it
    // did through tailwind-merge: the StyleX sheet is linked ahead of the
    // utilities (see stylexCss in src/server/stylex-transform.ts). New code
    // passes `xstyle` instead, which can only move the button, not restyle it.
    const merged = (own?: string) => cn(optics.className, className, own);
    const style =
      optics.style || rest.style
        ? { ...optics.style, ...rest.style }
        : undefined;

    if (render) {
      // The caller's element is the more specific of the two, so its own
      // className lands last and wins the merge. `type="button"` is not
      // forced on: it means nothing on an anchor.
      const own = render.props;
      return React.cloneElement(render, {
        ...rest,
        ref,
        className: merged(own.className),
        style: own.style ? { ...style, ...own.style } : style,
        children: content,
      });
    }

    return (
      <button
        type="button"
        ref={ref}
        {...rest}
        className={merged()}
        style={style}
      >
        {content}
      </button>
    );
  },
);
