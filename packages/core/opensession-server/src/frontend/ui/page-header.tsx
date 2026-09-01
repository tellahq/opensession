import { utilityClassName } from "./cn";
import * as React from "react";
import { cn } from "./cn";

export function PageHeader({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        utilityClassName(
          "mb-[22px] flex items-start justify-between gap-4 phone:flex-col phone:gap-2.5",
        ),
        className,
      )}
      {...props}
    />
  );
}

export function PageTitle({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"h2">) {
  return (
    <h2
      // The anchor for the iOS large-title handoff: while this heading is on
      // screen it is the page's name, and the chrome row above stays quiet;
      // once it has scrolled under that row, the row picks the name up. Read
      // by hooks/useLargeTitle.ts, which the app's top bar and the Analytics
      // range bar both call. Nothing else reads it, and it styles nothing.
      data-large-title=""
      className={cn(
        utilityClassName(
          "m-0 text-section-title font-title tracking-[-0.01em] text-fg",
        ),
        className,
      )}
      {...props}
    />
  );
}

export function PageDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        utilityClassName("mt-1 text-supporting text-faint"),
        className,
      )}
      {...props}
    />
  );
}
