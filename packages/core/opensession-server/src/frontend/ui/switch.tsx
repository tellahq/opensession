import { utilityClassName } from "./cn";
import * as React from "react";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { cn } from "./cn";

type SwitchSize = "md" | "sm";

/** The track. macOS 26's NSSwitch, measured off a render from the Mac node:
 *  a 54×24pt track with a 2pt inset. A pt is a CSS px here, so these are its
 *  numbers, not a scaled interpretation of them. It is longer and flatter
 *  than the iOS switch (51×31), which is the shape difference you see against
 *  the native app. "sm" is the same switch at 44×20, for dense rows where the
 *  full control would outweigh the row it sits in.
 *
 *  The shape lives in these two strings rather than inside the component
 *  because `SwitchIndicator` below draws the same switch without owning the
 *  press: a switch in a menu row that had drifted from a switch in a settings
 *  row would read as a different control. Both are keyed off `data-checked`,
 *  which Base UI sets on the real thing and the indicator sets by hand. */
const trackClasses = (size: SwitchSize) =>
  cn(
    utilityClassName("relative inline-flex shrink-0 rounded-full bg-active"),
    size === "sm"
      ? utilityClassName("h-5 w-11")
      : utilityClassName("h-6 w-[54px]"),
    // The checked track is the selected app accent, matching native
    // controls, through --accent-control: Black and Honey swap it for
    // a blue in dark mode, where a white or yellow track stops reading
    // as "on". Every other accent resolves straight through.
    utilityClassName(
      "transition-colors duration-[var(--dur-micro)] ease-[var(--ease)] data-[checked]:bg-accent-control",
    ),
  );

/** The knob is a 32×20 capsule, not a circle. That wider shape is most of
 *  what reads as the current macOS switch. The small size keeps the 2px inset
 *  and the capsule, at 26×16. */
const thumbClasses = (size: SwitchSize) =>
  cn(
    utilityClassName(
      "absolute left-0.5 top-0.5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.22),0_0_0_1px_rgba(0,0,0,0.07)] transition-[translate,background-color] duration-[var(--dur-micro)] ease-[var(--ease)] data-[checked]:bg-on-accent-control",
    ),
    size === "sm"
      ? utilityClassName("h-4 w-[26px] data-[checked]:translate-x-[14px]")
      : utilityClassName("h-5 w-8 data-[checked]:translate-x-[18px]"),
  );

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
      className={cn(
        trackClasses(size),
        utilityClassName("cursor-pointer outline-none"),
        utilityClassName(
          "focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        ),
        "data-[disabled]:cursor-default data-[disabled]:opacity-40",
        className,
      )}
      onCheckedChange={(checked, eventDetails) => {
        if (thumbRef.current) animateThumbTravel(thumbRef.current, checked);
        onCheckedChange?.(checked, eventDetails);
      }}
      {...props}
    >
      <BaseSwitch.Thumb ref={thumbRef} className={thumbClasses(size)} />
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
      className={cn(
        trackClasses(size),
        utilityClassName("pointer-events-none"),
        className,
      )}
    >
      <span data-checked={checked} className={thumbClasses(size)} />
    </span>
  );
}
