import { utilityClassName } from "./cn";
import React, { useEffect, useRef } from "react";
import { cn } from "./cn";

const OVERFLOW_FADE =
  utilityClassName("min-w-0 overflow-hidden whitespace-nowrap text-clip ") +
  "data-[overflow]:[-webkit-mask-image:linear-gradient(to_right,#000_0,#000_calc(100%_-_24px),transparent_100%)] " +
  "data-[overflow]:[mask-image:linear-gradient(to_right,#000_0,#000_calc(100%_-_24px),transparent_100%)] " +
  "rtl:data-[overflow]:[-webkit-mask-image:linear-gradient(to_left,#000_0,#000_calc(100%_-_24px),transparent_100%)] " +
  "rtl:data-[overflow]:[mask-image:linear-gradient(to_left,#000_0,#000_calc(100%_-_24px),transparent_100%)]";

/** Clips single-line text and adds a soft trailing fade only when it overflows. */
export function OverflowFadeText({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"span">) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const sync = () =>
      element.toggleAttribute(
        "data-overflow",
        element.scrollWidth - element.clientWidth > 1,
      );
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children]);

  return (
    <span ref={ref} className={cn(OVERFLOW_FADE, className)} {...props}>
      {children}
    </span>
  );
}
