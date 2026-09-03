import * as React from "react";
import { IconChevronDown } from "../components/icons";
import { cn } from "./cn";

/**
 * Button primitive — the shared optics for text, icon+label, and icon-only
 * buttons. New buttons go through this; legacy `.btn-*` classes in legacy.css
 * migrate here opportunistically when touched (strangler pattern).
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
type Size = "sm" | "md" | "lg";

const sizes: Record<Size, string> = {
  // Heights bracket the app's existing chrome: 32px matches the viewer
  // header buttons, 26px the chip/inline tier.
  //
  // One radius across every size: `rounded-control`, the corner the rest of
  // the chrome already uses (legacy.css authors it as `calc(10px*var(--rf))`
  // on .btn-viewer-pin / .btn-panel-toggle / .btn-viewer-newsession). The
  // `rounded-xs`/`rounded-sm` this used to ship read visibly squarer than the
  // buttons it sat beside — enough that call sites kept patching it back out
  // by hand. Holding one corner across the scale is also what makes the three
  // sizes read as one family: it goes pill on the short sizes, exactly as the
  // ~26px chrome buttons already do, and stays a soft rect on lg.
  //
  // There used to be an `xs` between nothing and `sm`, 24px against 26px with
  // the same padding, type and corner. Two names for one control: the 2px
  // never told anyone anything, and choosing between them was a coin toss.
  sm: "min-h-[26px] px-2.5 text-xs rounded-control",
  md: "min-h-8 px-3 text-sm rounded-control",
  lg: "min-h-9 px-3.5 text-base rounded-control",
};

// Leading icon + label: shave 4px off the icon side, which is the glyph's own
// whitespace minus the label's side bearing (see doc block).
const iconLeadPad: Record<Size, string> = {
  sm: "pl-1.5",
  md: "pl-2",
  lg: "pl-2.5",
};

// Trailing caret + label: the same 4px shave, on the caret's side.
const caretTrailPad: Record<Size, string> = {
  sm: "pr-1.5",
  md: "pr-2",
  lg: "pr-2.5",
};

// The air between glyph and label. One gap utility only: a second one on the
// same element resolves by Tailwind's output order rather than by the order
// they are written, so the two cases pick a value instead of layering.
const LEAD_GAP = "gap-1.5";
const PLAIN_GAP = "gap-1";

// The caret keys off the label, not the 20px icon step: an iconic-pro glyph at
// 14 draws an arrow about as tall as the cap height of a 12px label, which is
// the proportion a dropdown affordance wants. Bigger and it competes with the
// text it qualifies.
const caretSize: Record<Size, number> = { sm: 14, md: 16, lg: 18 };

// Icon-only: square hit target, symmetric.
const iconOnlyPad: Record<Size, string> = {
  sm: "w-[26px] px-0",
  md: "w-8 px-0",
  lg: "w-9 px-0",
};

// Solid ink: the heaviest weight, for the one dominant action on a surface (a
// page header's CTA, a panel's single call to action). It was once a second
// variant named `ink`, because the brand accent was red and, at that size, it
// shouted. The accent is ink now, so the two names described one plate; the
// older one is gone.
//
// The label is `text-on-accent` rather than a literal white: on an ink fill,
// white-on-white is what you get in dark mode. And `brightness-110` (what
// `primary` used to hover with) is invisible on a near-white or near-black
// fill, so the hover takes `--accent-hover`, which picks its own direction:
// toward the page while the accent is ink, deeper into the hue once it isn't.
//
// `plate-sheen` (styles/tailwind.css) is the top-down shading that keeps this
// from reading as a flat printed rectangle. It is a white-then-black overlay,
// so it costs the variant nothing per palette and survives the ink accent at
// both ends of the light/dark range.
const INK =
  "bg-accent border-transparent text-on-accent plate-sheen smooth-shadow-xs hover:bg-accent-hover";

/**
 * Which one, in one line each. The question a variant answers is what the
 * button is FOR on its surface, not how loud you want it:
 *
 * - `primary` — the answer. One per surface, and only where there is one.
 * - `default` — a control standing alone on the page: a header action, a
 *   toolbar, a card's single button. Raised, so it reads as a thing to press
 *   against a surface that is otherwise flat.
 * - `soft` — everything in a row that is not the answer: the Cancel beside a
 *   form's primary, two or more peers with no answer among them, or any
 *   neutral button sitting ON a panel or card. A grey plate, no edge. Raised
 *   plates in a row read as cards inside a card, and a hairline around each
 *   one draws a box about a label nobody is being asked to read.
 * - `ghost` — a control that is mostly reporting state (a filter, an icon in
 *   a row). Quiet until you reach for it.
 * - `overlay` — an inverse ghost floating over a dark media scrim.
 * - the tones — `danger`, `success` and `warning` are tinted plates that
 *   propose; `danger-strong` and `success-strong` are solid ones that commit.
 *   Two weights, no outline, so a Delete beside a Cancel is a red plate in a
 *   row of plates rather than a boxed label shouting over the quiet half.
 */
const variants: Record<Variant, string> = {
  // The raised control look of the newest chrome (viewer Share button).
  // Paper in light (`bg-button`), graphite in dark: the hairline and the cast
  // shadow are what say "raised", so the fill does not have to — see the
  // --button-surface note in base.css.
  default:
    "bg-button border-line text-dim smooth-shadow-xs hover:text-fg hover:border-line-strong",
  primary: INK,
  // A plate with no hairline: the quiet neutral button, and the one to reach
  // for whenever a row holds more than one action (Cancel beside Save, a
  // card's Run now · Edit · Delete). `default` cannot simply drop its border,
  // because its fill is paper in light and the border plus shadow are what
  // say raised — a row of them reads as plates inside a plate. `soft` steps
  // the fill instead, so it still reads as a pressable thing at a quieter
  // weight, and the hover goes one more step rather than adding an edge.
  //
  // The step is RELATIVE — ink over whatever is behind it, the same trick as
  // --hover — not a fixed surface value. It used to be `bg-control`, which is
  // tuned against the page: on a panel, where most of these rows actually
  // live, #ebebeb on #f0f0f0 all but disappeared in light. 8% ink lands on
  // that same #ebebeb over the white page, so nothing moved where the old
  // value was right, and it holds its shape on a panel, a card, or the
  // sidebar's translucent material.
  soft: "bg-fg/8 border-transparent text-dim hover:bg-fg/13 hover:text-fg data-[popup-open]:bg-fg/13 data-[popup-open]:text-fg",
  // No plate at all until you reach for it. A ghost is the right weight for a
  // control that is *reporting state* as much as inviting a press — a filter
  // that says "In all workspaces" is mostly a label — so the row stays quiet
  // and the wash arrives on hover. `data-popup-open` is Base UI's: when the
  // ghost is a menu trigger it has to stay lit while its own menu is open, or
  // the thing you just clicked disappears out from under the popup.
  ghost:
    "border-transparent text-dim hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg",
  // Media previews float directly on a dark scrim rather than an app surface.
  // Keep their safe action clusters as quiet inverse ghosts until hover; the
  // shared variant lets lightboxes use Button's spacing, focus, and anchor
  // rendering instead of rebuilding those fundamentals around raw controls.
  overlay:
    "border-transparent bg-transparent text-white/60 hover:bg-white/15 hover:text-white",
  // The tones come in two weights and no third: a tinted plate that PROPOSES
  // the action, and a solid one that COMMITS it. Both are fills, like every
  // variant above — a tone used to be an outline, which put a red box around
  // a Delete sitting next to a grey Cancel and made the quiet half of a
  // confirm the loudest thing in the row.
  //
  // The tint is the `-soft` token, a 10-14% wash of the tone itself, so it
  // layers over a panel, a card or the page without knowing which it is —
  // the same relative step `soft` takes. The hover doubles it rather than
  // adding an edge.
  //
  // Green is the second-most reached-for colour in the app after the accent
  // (approve a review, merge, mark read), so it earns a pair of its own.
  success: "bg-green-soft border-transparent text-green hover:bg-green/22",
  danger: "bg-red-soft border-transparent text-red hover:bg-red/22",
  // Yellow has no strong half: it qualifies an action ("delete the session,
  // keep the worktree"), and nothing in the app commits in yellow.
  warning: "bg-yellow-soft border-transparent text-yellow hover:bg-yellow/22",
  // Solid red plate — the button that actually does the irreversible thing
  // (a modal's confirm, the second click of a two-click close). Shares
  // `primary`'s shape, so the two swap cleanly in a footer.
  "danger-strong":
    "bg-red border-transparent text-white plate-sheen smooth-shadow-xs hover:brightness-110",
  // Solid green plate, for the affirmative action a surface wants read first
  // — the deck's Skip, a workspace's Approve — where the tint would let a
  // destructive neighbour dominate the row.
  "success-strong":
    "bg-green border-transparent text-white plate-sheen smooth-shadow-xs hover:brightness-110",
};

// Leading-icon dimming per variant (icon-only stays full strength).
const iconDim: Record<Variant, string> = {
  default: "opacity-60",
  primary: "opacity-80",
  soft: "opacity-60",
  ghost: "opacity-60",
  overlay: "opacity-60",
  success: "opacity-80",
  danger: "opacity-80",
  warning: "opacity-80",
  "danger-strong": "opacity-80",
  "success-strong": "opacity-80",
};

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
      <span className="[text-box:trim-both_cap_alphabetic]">{children}</span>
    ) : (
      children
    );
    const content = (
      <>
        {icon != null && (
          <span
            className={cn(
              "inline-flex shrink-0 items-center",
              !iconOnly && iconTone === "muted" && iconDim[variant],
            )}
          >
            {icon}
          </span>
        )}
        {label}
        {trailing != null && (
          <span className="inline-flex shrink-0 items-center">{trailing}</span>
        )}
        {caret && (
          <IconChevronDown
            className="shrink-0 opacity-55"
            size={caretSize[size]}
          />
        )}
      </>
    );
    const optics = cn(
      // `no-underline` is inert on a <button> and load-bearing under
      // `render`: an <a> underlines its text by default, so without it a
      // button that navigates arrives looking like body copy.
      "inline-flex items-center justify-center border whitespace-nowrap select-none no-underline",
      icon != null && hasLabel ? LEAD_GAP : PLAIN_GAP,
      // Text utilities carry different stock line heights even though this
      // button scale pins its own heights. A single tight line box gives
      // labels the same optical centre as fixed-size icons and chevrons.
      "leading-none",
      "font-medium transition-[color,background-color,border-color,filter,scale] active:scale-[0.96]",
      // One keyboard focus treatment for every variant. Without it a
      // Button falls back to the browser's default outline, which
      // differs per engine and sits tight against the corner; the
      // shared utility also carries the forced-colors fallback.
      "focus-ring",
      "disabled:pointer-events-none disabled:opacity-40",
      sizes[size],
      variants[variant],
      icon != null && hasLabel && iconLeadPad[size],
      (caret || trailing != null) && hasLabel && caretTrailPad[size],
      iconOnly && iconOnlyPad[size],
      className,
    );

    if (render) {
      // The caller's element is the more specific of the two, so its own
      // className lands last and wins the merge. `type="button"` is not
      // forced on: it means nothing on an anchor.
      const own = render.props;
      return React.cloneElement(render, {
        ...rest,
        ref,
        className: cn(optics, own.className),
        children: content,
      });
    }

    return (
      <button type="button" ref={ref} className={optics} {...rest}>
        {content}
      </button>
    );
  },
);
