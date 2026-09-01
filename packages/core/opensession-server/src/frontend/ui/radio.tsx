import { mergeStylexOverrideClassName } from "./cn";
import { utilityClassName } from "./cn";
import * as React from "react";
import { Radio as BaseRadio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { cn } from "./cn";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  size15: {
    width: "calc(4px * 1.5)",
    height: "calc(4px * 1.5)",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  bgOnAccentControl: {
    backgroundColor: "var(--on-accent-control, var(--on-accent))",
  },
});

type RadioProps = React.ComponentProps<typeof BaseRadio.Root>;
type RadioGroupProps = React.ComponentProps<typeof BaseRadioGroup>;

/** The app's radio control for choosing one option from a visible set. */
export function Radio({ className, ...props }: RadioProps) {
  return (
    <BaseRadio.Root
      className={cn(
        utilityClassName(
          "flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full border border-line-strong bg-surface p-0 outline-none",
        ),
        utilityClassName(
          "transition-[background-color,border-color] duration-[var(--dur-micro)] ease-[var(--ease)]",
        ),
        utilityClassName("hover:border-faint"),
        "data-[checked]:border-accent-control data-[checked]:bg-accent-control data-[checked]:hover:border-accent-control",
        utilityClassName(
          "focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        ),
        "data-[disabled]:cursor-default data-[disabled]:opacity-40",
        className,
      )}
      {...props}
    >
      <BaseRadio.Indicator
        className={mergeStylexOverrideClassName(
          "",
          sx.size15,
          sx.roundedFull,
          sx.bgOnAccentControl,
        )}
      />
    </BaseRadio.Root>
  );
}

/** Coordinates a visible set of `Radio` controls. */
export function RadioGroup({ className, ...props }: RadioGroupProps) {
  return <BaseRadioGroup className={cn(className)} {...props} />;
}
