import * as React from "react";
import * as stylex from "@stylexjs/stylex";
import { focusStyles } from "./focus-styles";
import { sx } from "./sx";
import {
  color,
  controlHeight,
  corner,
  media,
  motion,
  radius,
  space,
} from "./tokens.stylex";

const styles = stylex.create({
  row: {
    display: "flex",
    width: "100%",
    minWidth: 0,
    alignItems: "flex-start",
    gap: space.s10,
    textAlign: "left",
    minHeight: { default: null, [media.phone]: controlHeight.touch },
    ["cornerShape"]: corner.squircle,
    backgroundColor: {
      default: null,
      ":hover": { default: null, [media.hover]: color.hover },
    },
    transitionProperty:
      "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
  },
  plain: {
    borderRadius: radius.md,
    paddingInline: space.s8,
    paddingBlock: space.s6,
  },
  // A card row stands on its own fill; under the pointer the wash replaces
  // it, as on a plain row.
  card: {
    borderRadius: radius.xl,
    backgroundColor: {
      default: color.panel,
      ":hover": { default: color.panel, [media.hover]: color.hover },
    },
    paddingInline: space.s12,
    paddingBlock: space.s8,
  },
});

/**
 * A whole list row that is one action: a thread, a comment, a file. Full
 * width, left aligned, any layout inside; the focus ring and hover wash are
 * the row's, and it is a 44px target on a phone. `Button` is for a labelled
 * control, this is for a row of content you open.
 *
 * `variant="card"` is the same row standing on its own fill, for a row that
 * sits in running text rather than in a list (a thread card in a transcript).
 */
/** The row's look, for a row that has to be a link rather than a button. */
export function listRowClass(variant: "plain" | "card" = "plain") {
  return (
    stylex.props(styles.row, styles[variant], focusStyles.ring).className ?? ""
  );
}

export function ListRow({
  className,
  variant = "plain",
  type = "button",
  ...props
}: React.ComponentProps<"button"> & { variant?: "plain" | "card" }) {
  return (
    <button
      type={type}
      {...sx([styles.row, styles[variant], focusStyles.ring], className)}
      {...props}
    />
  );
}
