import * as React from "react";
import * as stylex from "@stylexjs/stylex";
import { IconX } from "../components/icons";
import { focusStyles } from "./focus-styles";
import {
  color,
  geometry,
  media,
  motion,
  opacity,
  radius,
  corner,
  space,
  text,
  tracking,
  weight,
} from "./tokens.stylex";

/**
 * A file attachment chip: a type badge, the file's name and a second line.
 * The composer's staged attachments add a remove control in the corner; a
 * sent message's chips are download links. One chip, two uses.
 */
export const fileChip = stylex.create({
  row: {
    marginBottom: space.s8,
    display: "flex",
    flexWrap: "wrap",
    gap: space.s8,
  },
  card: {
    position: "relative",
    display: "inline-flex",
    maxWidth: geometry.fileChipMaxWidth,
    alignItems: "center",
    gap: space.s8,
    borderRadius: radius.lg,
    ["cornerShape"]: corner.squircle,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.lineStrong,
    backgroundColor: color.hoverSolid,
    paddingBlock: space.s6,
    paddingInlineStart: space.s6,
    paddingInlineEnd: space.s10,
  },
  /** Room in the corner for the remove control. */
  removable: { paddingInlineEnd: space.s32 },
  /** A sent message's chip is a download link. */
  link: {
    textDecoration: "none",
    borderColor: {
      default: color.lineStrong,
      ":hover": { default: null, [media.hover]: color.accent },
    },
  },
  badge: {
    display: "inline-flex",
    width: geometry.fileChipBadge,
    height: geometry.fileChipBadge,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
    backgroundColor: `color-mix(in oklab, ${color.accent} 16%, transparent)`,
    fontSize: text.meta,
    fontWeight: weight.strong,
    letterSpacing: tracking.wide,
    color: color.accent,
  },
  meta: {
    display: "flex",
    minWidth: 0,
    flexDirection: "column",
    gap: geometry.hairline,
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.label,
    color: color.fg,
  },
  sub: { fontSize: text.meta, fontWeight: weight.regular, color: color.faint },
  remove: {
    position: "absolute",
    top: space.s4,
    right: space.s4,
    display: "flex",
    width: space.s24,
    height: space.s24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    color: {
      default: color.faint,
      ":hover": { default: null, [media.hover]: color.fg },
    },
    cursor: { default: "pointer", ":disabled": "default" },
    opacity: { default: null, ":disabled": opacity.disabled },
    transitionProperty: "color",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
    // The 24px glyph is small to hit; the target reaches 8px past it.
    "::before": {
      content: "''",
      position: "absolute",
      inset: `calc(-1 * ${space.s8})`,
    },
  },
});

/** The corner control that takes a staged file back out. */
export function FileChipRemove({
  label,
  ...props
}: Omit<React.ComponentPropsWithoutRef<"button">, "className" | "style"> & {
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      {...stylex.props(fileChip.remove, focusStyles.ring)}
    >
      <IconX size={16} dense />
    </button>
  );
}
