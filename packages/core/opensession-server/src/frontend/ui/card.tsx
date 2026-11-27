import * as React from "react";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { cn } from "./cn";
import { type LayoutStyles, sx } from "./sx";
import { color, corner, radius, space } from "./tokens.stylex";

type CardElement = "article" | "div" | "section" | "ul";

type CardProps = React.HTMLAttributes<HTMLElement> & {
  as?: CardElement;
  /** Placement only; a card's look is the card. */
  xstyle?: LayoutStyles;
};

const styles = stylex.create({
  // No border, and the card step of the radius scale. A block sitting on its
  // own fill is already separated from the page, and a hairline round it adds
  // a second edge that makes a page of cards read as a form. That is the house
  // rule (see src/frontend/AGENTS.md), and both surfaces that had grown their
  // own card optics (settings' `settingsSurface`, the analytics tiles) were
  // open-coding `border-0` to get back to it. `settingsSurface` has since
  // bought an edge back by giving up fill: it paints a plate lighter than a
  // fill alone can hold and adds `border` at the call site. That is the
  // documented carve-out and it belongs there, not here. This primitive stays
  // borderless.
  card: {
    borderRadius: radius.xl,
    ["cornerShape"]: corner.squircle,
    backgroundColor: color.panel,
  },
  // `as="ul"` is one of the shapes this primitive offers, and the browser's
  // own list styling doesn't know that: a card rendered as a list arrives
  // with 40px of marker indent and 14px of vertical margin, so its rows sit
  // visibly inboard of every other card on the page. base.css's preflight is
  // hand-rolled and deliberately leaves lists alone, so the reset belongs
  // with the shape that needs it.
  list: { margin: space.s0, listStyle: "none", paddingInlineStart: space.s0 },
  clip: { overflow: "hidden" },
});

function cardProps(
  { as: Component = "div", className, style, xstyle, ...props }: CardProps,
  extra?: StyleXStyles,
) {
  return React.createElement(Component, {
    ...props,
    ...sx(
      [styles.card, Component === "ul" && styles.list, extra, xstyle],
      className,
      style,
    ),
  });
}

export function Card(props: CardProps): React.ReactElement {
  return cardProps(props);
}

/**
 * A card of rows with a hairline between each. The divider is drawn on the
 * caller's own children, which StyleX cannot reach (it only styles elements
 * it renders), so that one structural rule stays a utility.
 */
export function CardList({
  className,
  ...props
}: CardProps): React.ReactElement {
  return cardProps(
    {
      ...props,
      className: cn("[&>*+*]:border-t [&>*+*]:border-line", className),
    },
    styles.clip,
  );
}
