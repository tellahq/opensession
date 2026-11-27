import { motion, type HTMLMotionProps } from "motion/react";
import * as stylex from "@stylexjs/stylex";
import { SELECTABLE } from "./dialog-styles";
import { sx } from "./sx";
import {
  color,
  leading,
  radius,
  corner,
  shadow,
  space,
  text,
  weight,
} from "./tokens.stylex";

const styles = stylex.create({
  status: {
    display: "flex",
    alignItems: "center",
    gap: space.s8,
    whiteSpace: "nowrap",
    borderRadius: radius.capsule,
    ["cornerShape"]: corner.squircle,
    backgroundColor: color.popupGlass,
    paddingInline: space.s12,
    paddingBlock: space.s6,
    fontSize: text.label,
    fontWeight: weight.medium,
    lineHeight: leading.tight,
    color: color.fg,
    backdropFilter: "var(--popup-blur)",
    "--smooth-ring-color": color.popupRing,
    boxShadow: shadow.ringSm,
  },
});

/** Compact, non-interactive status lifted above the current surface. */
export function FloatingStatus({
  className,
  ...props
}: HTMLMotionProps<"div">) {
  return (
    <motion.div
      className={
        sx(styles.status, `${SELECTABLE} ${className ?? ""}`).className
      }
      {...props}
    />
  );
}
