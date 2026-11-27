import * as React from "react";
import * as stylex from "@stylexjs/stylex";
import { SELECTABLE } from "./dialog-styles";
import { sx } from "./sx";
import {
  color,
  geometry,
  media,
  space,
  text,
  tracking,
  weight,
} from "./tokens.stylex";

const styles = stylex.create({
  header: {
    marginBottom: geometry.pageHeaderGap,
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    flexDirection: { default: null, [media.phone]: "column" },
    gap: { default: space.s16, [media.phone]: space.s10 },
  },
  title: {
    margin: space.s0,
    fontSize: text.sectionTitle,
    fontWeight: weight.title,
    letterSpacing: tracking.tight,
    color: color.fg,
  },
  description: {
    marginTop: space.s4,
    fontSize: text.label,
    fontWeight: weight.regular,
    color: color.faint,
  },
});

export function PageHeader({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return <div {...sx(styles.header, className)} {...props} />;
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
      {...sx(styles.title, className)}
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
      {...sx(styles.description, `${SELECTABLE} ${className ?? ""}`)}
      {...props}
    />
  );
}
