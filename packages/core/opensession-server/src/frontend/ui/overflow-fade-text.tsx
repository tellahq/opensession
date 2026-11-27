import React, { useEffect, useRef } from "react";
import * as stylex from "@stylexjs/stylex";
import { sx } from "./sx";
import { color, geometry } from "./tokens.stylex";

const OVERFLOW = ":is([data-overflow])";
const RTL_OVERFLOW = ":is([data-overflow]):dir(rtl)";
const fade = (to: string) =>
  `linear-gradient(to ${to}, ${color.mask} 0, ${color.mask} calc(100% - ${geometry.fadeEdge}), transparent 100%)`;

const styles = stylex.create({
  text: {
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "clip",
    maskImage: {
      default: null,
      [OVERFLOW]: fade("right"),
      [RTL_OVERFLOW]: fade("left"),
    },
  },
});

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
    <span ref={ref} {...sx(styles.text, className)} {...props}>
      {children}
    </span>
  );
}
