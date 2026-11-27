import * as React from "react";
import { Radio as BaseRadio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import * as stylex from "@stylexjs/stylex";
import { choice } from "./choice-styles";
import { sx } from "./sx";
import { color, geometry, radius } from "./tokens.stylex";

const styles = stylex.create({
  dot: {
    width: geometry.radioDot,
    height: geometry.radioDot,
    borderRadius: radius.pill,
    backgroundColor: color.onAccentControl,
  },
});

type RadioProps = Omit<
  React.ComponentProps<typeof BaseRadio.Root>,
  "className"
> & {
  className?: string;
};
type RadioGroupProps = React.ComponentProps<typeof BaseRadioGroup>;

/** The app's radio control for choosing one option from a visible set. */
export function Radio({ className, ...props }: RadioProps) {
  return (
    <BaseRadio.Root {...props} {...sx([choice.box, choice.round], className)}>
      <BaseRadio.Indicator {...stylex.props(styles.dot)} />
    </BaseRadio.Root>
  );
}

/** Coordinates a visible set of `Radio` controls. */
export function RadioGroup({ className, ...props }: RadioGroupProps) {
  return <BaseRadioGroup className={className} {...props} />;
}
