import * as React from "react";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import * as stylex from "@stylexjs/stylex";
import { sx } from "./sx";
import {
  color,
  focus,
  geometry,
  motion,
  opacity,
  radius,
  shadow,
  space,
} from "./tokens.stylex";

type SwitchSize = "md" | "sm";

/** The track. macOS 26's NSSwitch, measured off a render from the Mac node:
 *  a 54×24pt track with a 2pt inset. A pt is a CSS px here, so these are its
 *  numbers, not a scaled interpretation of them. It is longer and flatter
 *  than the iOS switch (51×31), which is the shape difference you see against
 *  the native app. "sm" is the same switch at 44×20, for dense rows where the
 *  full control would outweigh the row it sits in.
 *
 *  The shape lives in these styles rather than inside one component
 *  because `SwitchIndicator` below draws the same switch without owning the
 *  press: a switch in a menu row that had drifted from a switch in a settings
 *  row would read as a different control. Both are keyed off `data-checked`,
 *  which Base UI sets on the real thing and the indicator sets by hand. */
const CHECKED = ":is([data-checked])";

const styles = stylex.create({
  track: {
    position: "relative",
    display: "inline-flex",
    flexShrink: 0,
    borderRadius: radius.pill,
    backgroundColor: { default: color.active, [CHECKED]: color.accentControl },
    transitionProperty: "color, background-color, border-color",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
  },
  trackMd: { width: geometry.switchTrackW, height: geometry.switchTrackH },
  trackSm: { width: geometry.switchTrackWSm, height: geometry.switchTrackHSm },
  // The press, focus and disabled states belong to the real control only;
  // the indicator below answers no pointer.
  control: {
    cursor: { default: "pointer", ":is([data-disabled])": "default" },
    opacity: { default: null, ":is([data-disabled])": opacity.disabled },
    outline: { default: "none", ":focus-visible": focus.ring },
    outlineOffset: { default: null, ":focus-visible": focus.offset },
  },
  indicator: { pointerEvents: "none" },
  // The knob is a capsule, not a circle (32x20, 26x16 small): that wider
  // shape is most of what reads as the current macOS switch.
  thumb: {
    position: "absolute",
    insetInlineStart: space.s2,
    top: space.s2,
    borderRadius: radius.pill,
    backgroundColor: { default: color.knob, [CHECKED]: color.onAccentControl },
    boxShadow: shadow.knob,
    transitionProperty: "translate, background-color",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
  },
  thumbMd: {
    width: geometry.switchThumbW,
    height: geometry.switchThumbH,
    translate: { default: null, [CHECKED]: geometry.switchTravel },
  },
  thumbSm: {
    width: geometry.switchThumbWSm,
    height: geometry.switchThumbHSm,
    translate: { default: null, [CHECKED]: geometry.switchTravelSm },
  },
});

const STRETCH_ANIMATION_ID = "switch-thumb-stretch";

/** Stretch only while the thumb travels, anchored toward its destination. */
function animateThumbTravel(thumb: HTMLElement, checked: boolean) {
  if (
    !thumb.animate ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return;
  thumb
    .getAnimations()
    .find((animation) => animation.id === STRETCH_ANIMATION_ID)
    ?.cancel();
  const origin = checked ? "left center" : "right center";
  const easing =
    getComputedStyle(thumb).getPropertyValue("--ease").trim() || "ease-out";
  const animation = thumb.animate(
    [
      { scale: "1 1", transformOrigin: origin, easing },
      { scale: "1.12 1", transformOrigin: origin, easing, offset: 0.4 },
      { scale: "1 1", transformOrigin: origin },
    ],
    { duration: 150 },
  );
  animation.id = STRETCH_ANIMATION_ID;
}

type SwitchProps = Omit<
  React.ComponentProps<typeof BaseSwitch.Root>,
  "size"
> & {
  className?: string;
  size?: SwitchSize;
};

export function Switch({
  className,
  size = "md",
  onCheckedChange,
  ...props
}: SwitchProps) {
  const thumbRef = React.useRef<HTMLSpanElement>(null);
  return (
    <BaseSwitch.Root
      {...sx(
        [
          styles.track,
          size === "sm" ? styles.trackSm : styles.trackMd,
          styles.control,
        ],
        className,
      )}
      onCheckedChange={(checked, eventDetails) => {
        if (thumbRef.current) animateThumbTravel(thumbRef.current, checked);
        onCheckedChange?.(checked, eventDetails);
      }}
      {...props}
    >
      <BaseSwitch.Thumb
        ref={thumbRef}
        {...stylex.props(
          styles.thumb,
          size === "sm" ? styles.thumbSm : styles.thumbMd,
        )}
      />
    </BaseSwitch.Root>
  );
}

/**
 * The switch as a picture of a setting rather than the control for it: for a
 * row that is itself the control, where a real switch would be a button
 * inside a button and would take the press away from the row around it. It
 * holds no focus and answers no pointer, and it is hidden from assistive
 * technology, because the row already says what the setting is and whether it
 * is on.
 */
export function SwitchIndicator({
  on,
  size = "sm",
  className,
}: {
  /** Whether the setting is on. */
  on: boolean;
  size?: SwitchSize;
  className?: string;
}) {
  // Written as an attribute rather than a class so both halves take the same
  // `data-[checked]:` utilities the real control does.
  const checked = on ? "" : undefined;
  return (
    <span
      aria-hidden
      data-checked={checked}
      {...sx(
        [
          styles.track,
          size === "sm" ? styles.trackSm : styles.trackMd,
          styles.indicator,
        ],
        className,
      )}
    >
      <span
        data-checked={checked}
        {...stylex.props(
          styles.thumb,
          size === "sm" ? styles.thumbSm : styles.thumbMd,
        )}
      />
    </span>
  );
}
