import { utilityClassName } from "./cn";
import * as React from "react";
import { Button, type ButtonProps } from "./button";
import { cn } from "./cn";

export type OverlayActionProps = Omit<ButtonProps, "size" | "variant">;

/**
 * A compact action over the top-right corner of a visual preview.
 *
 * Put it inside a relative `group/overlay-action` parent. Pointer devices
 * reveal it on hover, keyboard focus always reveals it, and touch devices keep
 * it visible because they have no hover path. The surface stays white across
 * themes so the action remains distinct from any image or colour underneath.
 */
export const OverlayAction = React.forwardRef<
  HTMLButtonElement,
  OverlayActionProps
>(function OverlayAction({ className, ...props }, ref) {
  return (
    <Button
      ref={ref}
      variant="default"
      size="sm"
      className={cn(
        utilityClassName(
          "absolute -right-2 -top-2 z-[1] bg-white transition-[opacity,scale]",
        ),
        "[@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:opacity-0",
        "[@media(hover:hover)]:group-hover/overlay-action:pointer-events-auto [@media(hover:hover)]:group-hover/overlay-action:opacity-100",
        utilityClassName(
          "focus-visible:pointer-events-auto focus-visible:opacity-100",
        ),
        className,
      )}
      {...props}
    />
  );
});
