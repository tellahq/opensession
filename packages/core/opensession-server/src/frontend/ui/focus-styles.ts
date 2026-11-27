import * as stylex from "@stylexjs/stylex";
import { focus, media } from "./tokens.stylex";

/**
 * The one keyboard-focus treatment, for any element a primitive draws (the
 * StyleX form of the `focus-ring` utility). It does not animate, so focus is
 * immediate and reduced motion needs no special case.
 */
export const focusStyles = stylex.create({
  ring: {
    outline: { default: null, ":focus-visible": focus.ring },
    outlineOffset: { default: null, ":focus-visible": focus.offset },
    outlineColor: {
      default: null,
      [media.forcedColors]: { default: null, ":focus-visible": "Highlight" },
    },
  },
});
