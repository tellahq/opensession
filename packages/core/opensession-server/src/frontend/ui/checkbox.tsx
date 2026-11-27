import * as React from "react";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import * as stylex from "@stylexjs/stylex";
import { choice } from "./choice-styles";
import { sx } from "./sx";
import { color, geometry } from "./tokens.stylex";

const styles = stylex.create({
  indicator: {
    display: { default: "flex", ":is([data-unchecked])": "none" },
    color: color.onAccentControl,
  },
  glyph: { width: geometry.checkGlyph, height: geometry.checkGlyph },
});

type CheckboxProps = Omit<
  React.ComponentProps<typeof BaseCheckbox.Root>,
  "size"
> & {
  className?: string;
};

/**
 * The app's checkbox: a form option you pick, as opposed to `Switch`, which
 * turns a setting on. It replaces the browser's own `input[type=checkbox]`,
 * whose fill is the UA accent rather than ours and whose box ignores the
 * corner and border scales every other control follows.
 *
 * It is labelable, so the existing pattern still works and the whole row stays
 * clickable:
 *
 *   <label className="flex items-center gap-2">
 *     <Checkbox checked={x} onCheckedChange={setX} />
 *     Include thread replies
 *   </label>
 */
export function Checkbox({ className, ...props }: CheckboxProps) {
  return (
    <BaseCheckbox.Root
      {...sx([choice.box, choice.square], className)}
      {...props}
    >
      <BaseCheckbox.Indicator {...stylex.props(styles.indicator)}>
        <svg
          viewBox="0 0 12 12"
          {...stylex.props(styles.glyph)}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M2.4 6.3 4.7 8.6 9.6 3.5" />
        </svg>
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
}
