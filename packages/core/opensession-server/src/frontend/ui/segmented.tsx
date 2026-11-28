import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { motion } from "motion/react";
import * as React from "react";
import * as stylex from "@stylexjs/stylex";
import { sx } from "./sx";
import {
  color,
  corner,
  focus,
  media,
  motion as timing,
  radius,
  shadow,
  space,
  text,
  weight,
} from "./tokens.stylex";
import { duration, ease } from "./motion";

/**
 * Segmented control — a short, exclusive choice shown in full, where every
 * option is worth reading at a glance: Default / Compact, 7d / 14d / 30d / 90d.
 *
 * Recessed track, raised knob: the option in effect sits ON the group rather
 * than being a darker hole cut into it. A plate sitting IN a well is not the
 * same problem as one sitting on the page, so the knob does not borrow the
 * Button plate's `border-line`: that hairline is darker than the `bg-hover`
 * track it lies on, which made the knob read as an outline drawn around the
 * option, its top edge unjustified by any shadow (light falls downward). The
 * knob's surface and edge are per-theme tokens instead, `--segmented-knob-*`
 * in base.css: paper and no edge in light, where the cast shadow separates it,
 * and in dark a fill well above the ramp's last step with a hair-lighter edge,
 * because a shadow on a near-black track does nothing and a plate at or below
 * the track's own tier reads as a hole rather than a knob. The
 * track is `bg-hover` — one of the few places that absolute surface is right,
 * because here it is a real surface (a well the options sit in) rather than an
 * interaction wash. Concentric corners: the knob's `rounded-control` (12) plus
 * the track's 2px padding is the track's `rounded-lg` (14).
 *
 * The knob is one element that MOVES between options (Motion's `layoutId`), not
 * a background that blinks on and off, so the control says which way the value
 * went. Each mounted group gets its own id from `useId`, or two segmented
 * controls on one page would trade a single knob back and forth across the
 * screen. Trading it IS right where a control beside the group holds the same
 * value — the date range next to the presets in `ui/date-picker` — so `knobId`
 * can be passed in and the knob rendered from `SegmentedKnob` out there.
 *
 * Built on Base UI's ToggleGroup, which is what makes the keyboard right:
 * arrow keys move between the options, the group is one tab stop, and each
 * option announces through `aria-pressed` whether it is the one in effect.
 * Re-pressing the current option is ignored — a segmented control always has a
 * value, so there is nothing for it to mean.
 *
 * Reach for it only for two or three short options that all deserve to be
 * visible. A longer list (every repo on the instance) belongs in a `Select` or
 * a menu — spelled out, it wraps to a second line and outweighs the content it
 * is choosing for.
 */
/** Two densities, one shape. `sm` only tightens the option's padding, so the
 *  knob keeps `rounded-control` and the track its `rounded-lg` — the same
 *  concentric pair at both sizes, and the same "goes pill when short" the
 *  Button primitive relies on. Use it where the control is chrome beside the
 *  content it filters rather than a setting being read on its own. */
type Size = "sm" | "md";

const styles = stylex.create({
  track: {
    display: "inline-flex",
    borderRadius: radius.lg,
    ["cornerShape"]: corner.squircle,
    backgroundColor: color.hover,
    padding: space.s2,
  },
  option: {
    // Flush with the option, in the track's padding: an inset ring would sit
    // under the knob, which is positioned and paints over it.
    outline: { default: null, ":focus-visible": focus.ring },
    outlineOffset: { default: null, ":focus-visible": space.s0 },
    position: "relative",
    display: "inline-flex",
    cursor: { default: "pointer", ":disabled": "default" },
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
    borderWidth: 0,
    backgroundColor: color.transparent,
    textAlign: "center",
    fontSize: { default: text.label, [media.phone]: text.itemTitle },
    fontWeight: weight.medium,
    whiteSpace: "nowrap",
    transitionProperty: "color, background-color, border-color",
    transitionDuration: timing.micro,
    transitionTimingFunction: timing.ease,
  },
  sm: {
    paddingInline: { default: space.s8, [media.phone]: space.s12 },
    paddingBlock: { default: space.s2, [media.phone]: space.s8 },
  },
  md: {
    paddingInline: { default: space.s10, [media.phone]: space.s12 },
    paddingBlock: { default: space.s4, [media.phone]: space.s8 },
  },
  selected: { color: { default: color.fg, ":disabled": color.faint } },
  idle: {
    color: {
      default: color.dim,
      // Scoped to enabled options: StyleX emits the hover media query after
      // `:disabled`, so a bare hover would light up an option it can't offer.
      ":enabled:hover": { default: null, [media.hover]: color.fg },
      ":disabled": color.faint,
    },
  },
  // Above the knob, which is absolutely positioned over the option.
  label: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space.s6,
  },
  knob: {
    position: "absolute",
    inset: space.s0,
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: color.segmentedKnobEdge,
    backgroundColor: color.segmentedKnob,
    boxShadow: shadow.sm,
  },
});

const SegmentedContext = React.createContext<{
  knobId: string;
  value: string | null;
  size: Size;
}>({
  knobId: "",
  value: null,
  size: "md",
});

export function Segmented({
  label,
  value,
  onValueChange,
  size = "md",
  knobId: knobIdProp,
  className,
  children,
  ...props
}: Omit<
  React.ComponentPropsWithoutRef<"div">,
  "value" | "onChange" | "defaultValue"
> & {
  label: string;
  /** The option in effect. `null` leaves every option unpressed — for a
   *  control whose value can also be set from outside it (a custom date
   *  range that matches no preset). */
  value: string | null;
  onValueChange: (value: string) => void;
  size?: Size;
  /** Share the knob with a control outside the group that holds the same
   *  value, so it travels between the two instead of blinking across. Pass
   *  the same id to `SegmentedKnob` over there. */
  knobId?: string;
}) {
  const ownId = React.useId();
  const knobId = knobIdProp ?? ownId;
  return (
    <SegmentedContext.Provider value={{ knobId, value, size }}>
      <ToggleGroup
        aria-label={label}
        value={value === null ? [] : [value]}
        onValueChange={(next) => {
          const picked = next[0];
          if (picked !== undefined && picked !== value) onValueChange(picked);
        }}
        {...sx(styles.track, className)}
        {...props}
      >
        {children}
      </ToggleGroup>
    </SegmentedContext.Provider>
  );
}

export function SegmentedOption({
  value,
  className,
  children,
  ...props
}: Omit<React.ComponentPropsWithoutRef<"button">, "value"> & {
  value: string;
}) {
  const { knobId, value: current, size } = React.useContext(SegmentedContext);
  const selected = current === value;
  return (
    <Toggle
      value={value}
      // Phones get the tap box; the desktop control is a reading size. An
      // option the data can't offer yet stays in place, greyed: taking it out
      // would shift the ones beside it as the page loads.
      {...sx(
        [
          styles.option,
          size === "sm" ? styles.sm : styles.md,
          selected ? styles.selected : styles.idle,
        ],
        className,
      )}
      {...props}
    >
      {selected && <SegmentedKnob knobId={knobId} />}
      {/* Above the knob, which is absolutely positioned over the option. */}
      <span {...stylex.props(styles.label)}>{children}</span>
    </Toggle>
  );
}

/**
 * The knob itself. Rendered by whichever option is in effect, and exported so a
 * control sitting on the same track outside the group can hold it too: one
 * element with one `layoutId` means the knob travels to it rather than blinking
 * off one plate and on to another.
 *
 * Its host needs `relative` and a `rounded-control` corner of its own, since
 * the knob fills the box it is dropped into.
 */
export function SegmentedKnob({ knobId }: { knobId: string }) {
  return (
    <motion.span
      layoutId={knobId}
      aria-hidden
      {...stylex.props(styles.knob)}
      transition={{ type: "tween", duration: duration.base, ease }}
    />
  );
}
