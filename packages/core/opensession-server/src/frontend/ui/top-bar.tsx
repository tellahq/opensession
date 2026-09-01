import { utilityClassName } from "./cn";
import * as React from "react";
import { MOBILE_BACK, MOBILE_TOP_BAR_CONTROL } from "../lib/app-header-classes";
import { IconChevronLeft } from "../components/icons";
import { Button, type ButtonProps } from "./button";
import { cn } from "./cn";

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
      className: cn(utilityClassName("flex min-w-0 items-center"), className),
      ...props,
    });
  },
);

export const TopBarLeading = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(function TopBarLeading({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        utilityClassName("flex min-w-0 items-center gap-2"),
        className,
      )}
      {...props}
    />
  );
});

export const TopBarTitle = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(function TopBarTitle({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(utilityClassName("min-w-0"), className)}
      {...props}
    />
  );
});

export const TopBarActions = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div">
>(function TopBarActions({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        utilityClassName("ml-auto flex shrink-0 items-center"),
        className,
      )}
      {...props}
    />
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
      className={cn(
        utilityClassName(
          "phone:relative phone:h-11 phone:shrink-0 phone:justify-center phone:px-3",
        ),
        className,
      )}
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
      className={cn(
        utilityClassName("text-body font-title text-fg"),
        className,
      )}
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
      className={cn(
        utilityClassName(
          "size-11 min-h-11 shrink-0 touch-manipulation rounded-full bg-panel p-0 text-dim shadow-none hover:bg-pressed active:scale-[0.96] [&_svg]:size-6",
        ),
        className,
      )}
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
      className={cn(floating && MOBILE_TOP_BAR_CONTROL, className)}
      {...props}
    />
  );
});

type TopBarBackProps = Omit<ButtonProps, "children" | "icon"> & {
  "aria-label": string;
  floating?: boolean;
  iconSize?: number;
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
