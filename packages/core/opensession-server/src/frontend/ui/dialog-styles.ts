import * as stylex from "@stylexjs/stylex";
import { color, leading, space, text, tracking, weight } from "./tokens.stylex";

/**
 * A dialog's title and its one-line consequence, shared by `Modal.Header`
 * and the confirmation alert so an alert and a full dialog read as one
 * family. Base UI renders them as `<h2>` and `<p>`, and base.css owns the
 * resets, so both zero their UA margins here.
 *
 * Spread a description with `SELECTABLE` as its class: base.css makes the app
 * unselectable chrome by default and opts copy back in through that hook.
 */
export const SELECTABLE = "selectable";

export const dialogText = stylex.create({
  title: {
    margin: space.s0,
    minWidth: 0,
    textWrap: "balance",
    fontSize: text.dialogTitle,
    fontWeight: weight.strong,
    lineHeight: leading.tight,
    letterSpacing: tracking.tight,
    color: color.fg,
  },
  // `font-weight: 400` is load-bearing: base.css runs the app at 500, so a
  // description that merely dropped the medium weight would still match the
  // field labels exactly.
  description: {
    margin: space.s0,
    textWrap: "pretty",
    fontSize: text.label,
    fontWeight: weight.regular,
    lineHeight: leading.relaxed,
    color: color.dim,
  },
});
