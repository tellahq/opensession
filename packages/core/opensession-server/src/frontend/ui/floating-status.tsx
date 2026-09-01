import { utilityClassName } from "./cn";
import { motion, type HTMLMotionProps } from "motion/react";
import { cn } from "./cn";

/** Compact, non-interactive status lifted above the current surface. */
export function FloatingStatus({
  className,
  ...props
}: HTMLMotionProps<"div">) {
  return (
    <motion.div
      className={cn(
        utilityClassName(
          "flex items-center gap-2 whitespace-nowrap rounded-[999px] bg-popup-glass",
        ),
        utilityClassName(
          "px-3 py-1.5 text-supporting font-medium leading-tight text-fg",
        ),
        utilityClassName(
          "[backdrop-filter:var(--popup-blur)] [--smooth-ring-color:var(--popup-ring)] smooth-shadow-ring-sm",
        ),
        className,
      )}
      {...props}
    />
  );
}
