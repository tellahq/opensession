import * as React from "react";
import { MOBILE_BACK, MOBILE_TOP_BAR_CONTROL } from "../lib/app-header-classes";
import { IconChevronLeft, type IconSize } from "../components/icons";
import * as stylex from "@stylexjs/stylex";
import { Button, type ButtonProps } from "./button";
import { cn } from "./cn";
import { sx } from "./sx";
import {
  color,
  controlHeight,
  media,
  motion,
  radius,
  space,
  text,
  weight,
} from "./tokens.stylex";

const styles = stylex.create({
  bar: { display: "flex", minWidth: 0, alignItems: "center" },
  leading: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    gap: space.s8,
  },
  title: { minWidth: 0 },
  actions: {
    marginLeft: "auto",
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
  },
  phoneBar: {
    position: { default: null, [media.phone]: "relative" },
    height: { default: null, [media.phone]: controlHeight.touch },
    flexShrink: { default: null, [media.phone]: 0 },
    justifyContent: { default: null, [media.phone]: "center" },
    paddingInline: { default: null, [media.phone]: space.s12 },
  },
  phoneTitle: {
    fontSize: text.body,
    fontWeight: weight.title,
    color: color.fg,
  },
  // A round, filled action in a sheet's own top bar: a 44px target at every
  // width, quieter than the page's floating glass controls.
  phoneAction: {
    width: controlHeight.touch,
    height: controlHeight.touch,
    minHeight: controlHeight.touch,
    flexShrink: 0,
    touchAction: "manipulation",
    borderRadius: radius.pill,
    // Translucent ink, not the panel surface: a sheet in dark is lighter
    // than the panel, so a solid panel disc vanished there.
    backgroundColor: {
      default: color.hover,
      ":hover": { default: null, [media.hover]: color.pressed },
    },
    paddingInline: space.s0,
    paddingBlock: space.s0,
    color: {
      default: color.dim,
      ":hover": { default: null, [media.hover]: color.fg },
    },
    boxShadow: "none",
    scale: { default: null, ":active": motion.pressScale },
  },
});

/**
 * Shared application top-bar structure. Feature bars keep their own position,
 * height and surface while using the same leading, title and action slots.
 */
type TopBarProps = React.HTMLAttributes<HTMLElement> & {
  as?: "div" | "header";
};

export const TopBar = React.forwardRef<HTMLElement, TopBarProps>(
  function TopBar({ as = "div", className, ...props }, ref) {
    return React.createElement(as, {
      ref,
      "data-top-bar": "",
      ...props,
      ...sx(styles.bar, className, props.style),
    });
  },
);

export const TopBarLeading = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(function TopBarLeading({ className, ...props }, ref) {
  return (
    <div ref={ref} {...props} {...sx(styles.leading, className, props.style)} />
  );
});

export const TopBarTitle = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(function TopBarTitle({ className, ...props }, ref) {
  return (
    <div ref={ref} {...props} {...sx(styles.title, className, props.style)} />
  );
});

export const TopBarActions = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(function TopBarActions({ className, ...props }, ref) {
  return (
    <div ref={ref} {...props} {...sx(styles.actions, className, props.style)} />
  );
});

/**
 * Phone navigation row shared by full-screen pages and sheets. Position and
 * surface stay with the feature; its 44px rhythm and centred title do not.
 */
export const PhoneTopBar = React.forwardRef<
  HTMLElement,
  Omit<TopBarProps, "as">
>(function PhoneTopBar({ className, ...props }, ref) {
  return (
    <TopBar
      as="header"
      ref={ref}
      className={cn(stylex.props(styles.phoneBar).className, className)}
      {...props}
    />
  );
});

export const PhoneTopBarTitle = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(function PhoneTopBarTitle({ className, ...props }, ref) {
  return (
    <TopBarTitle
      ref={ref}
      // A hook a host's leading rules can name (Settings sets titles to 1.1).
      data-top-bar-title=""
      className={cn(stylex.props(styles.phoneTitle).className, className)}
      {...props}
    />
  );
});

/** The quiet 44px disc used for Back, Close and secondary phone actions. */
export const PhoneTopBarAction = React.forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, "children">
>(function PhoneTopBarAction({ className, ...props }, ref) {
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="md"
      skin={styles.phoneAction}
      // The glyph is sized from here: a reach into the child.
      className={cn("[&_svg]:size-6", className)}
      {...props}
    />
  );
});

type TopBarActionProps = Omit<ButtonProps, "children"> & {
  icon: React.ReactNode;
  floating?: boolean;
};

export const TopBarAction = React.forwardRef<
  HTMLButtonElement,
  TopBarActionProps
>(function TopBarAction({ className, floating = false, ...props }, ref) {
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="md"
      // A class string, not `skin`: a skin replaces Button's own values for
      // a property at every width, and these are phone-only. At phone width
      // they agree with Button wherever both set a property at the same
      // priority (heights, widths, padding), so stylesheet order cannot flip
      // the result.
      className={cn(floating && MOBILE_TOP_BAR_CONTROL, className)}
      {...props}
    />
  );
});

type TopBarBackProps = Omit<ButtonProps, "children" | "icon"> & {
  "aria-label": string;
  floating?: boolean;
  iconSize?: IconSize;
};

export const TopBarBack = React.forwardRef<HTMLButtonElement, TopBarBackProps>(
  function TopBarBack(
    { className, floating = false, iconSize = 22, ...props },
    ref,
  ) {
    return (
      <Button
        ref={ref}
        variant="ghost"
        size="md"
        icon={<IconChevronLeft size={iconSize} />}
        className={cn(floating && MOBILE_BACK, className)}
        {...props}
      />
    );
  },
);
