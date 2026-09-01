import { utilityClassName } from "./cn";
import * as React from "react";
import { cn } from "./cn";

type CardElement = "article" | "div" | "section" | "ul";

type CardProps = React.HTMLAttributes<HTMLElement> & {
  as?: CardElement;
};

export function Card({
  as: Component = "div",
  className,
  ...props
}: CardProps) {
  return React.createElement(Component, {
    ...props,
    className: cn(
      // No border, and the card step of the radius scale. A block sitting on
      // its own fill is already separated from the page, and a hairline round
      // it adds a second edge that makes a page of cards read as a form. That
      // is the house rule (see src/frontend/AGENTS.md), and both surfaces that
      // had grown their own card optics (settings' `settingsSurface`, the
      // analytics tiles) were open-coding `border-0` to get back to it.
      // `settingsSurface` has since bought an edge back by giving up fill: it
      // paints a plate lighter than a fill alone can hold and adds `border`
      // at the call site. That is the documented carve-out and it belongs
      // there, not here. This primitive stays borderless.
      utilityClassName("rounded-xl bg-panel"),
      // `as="ul"` is one of the shapes this primitive offers, and the
      // browser's own list styling doesn't know that: a card rendered as a
      // list arrives with 40px of marker indent and 14px of vertical margin,
      // so its rows sit visibly inboard of every other card on the page.
      // base.css's preflight is hand-rolled and deliberately leaves lists
      // alone, so the reset belongs with the shape that needs it.
      "[&:where(ul)]:m-0 [&:where(ul)]:list-none [&:where(ul)]:pl-0",
      className,
    ),
  });
}

export function CardList({ className, ...props }: CardProps) {
  return (
    <Card
      className={cn(
        utilityClassName(
          "overflow-hidden [&>*+*]:border-t [&>*+*]:border-line",
        ),
        className,
      )}
      {...props}
    />
  );
}
