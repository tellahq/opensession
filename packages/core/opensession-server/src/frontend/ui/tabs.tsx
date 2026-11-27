import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type * as React from "react";
import * as stylex from "@stylexjs/stylex";
import { tabMarker } from "./markers.stylex";
import { sx } from "./sx";
import {
  color,
  controlHeight,
  corner,
  focus,
  media,
  motion,
  radius,
  space,
  text,
  weight,
} from "./tokens.stylex";

const ACTIVE = ":is([data-active])";
const focusRing = {
  outline: { default: null, ":focus-visible": focus.ring },
  outlineOffset: { default: null, ":focus-visible": focus.offset },
  outlineColor: {
    default: null,
    [media.forcedColors]: { default: null, ":focus-visible": "Highlight" },
  },
} as const;

const styles = stylex.create({
  root: { display: "flex", minWidth: 0, alignItems: "stretch" },
  list: {
    position: "relative",
    display: "flex",
    minWidth: 0,
    alignItems: "stretch",
    gap: space.s4,
  },
  indicator: {
    position: "absolute",
    bottom: space.s0,
    left: "var(--active-tab-left)",
    height: space.s2,
    width: "var(--active-tab-width)",
    borderRadius: radius.capsule,
    ["cornerShape"]: corner.squircle,
    backgroundColor: color.accent,
    transitionProperty: {
      default: "left, width",
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    transitionDuration: motion.slide,
    transitionTimingFunction: motion.easeOut,
  },
  tab: {
    ...focusRing,
    display: "flex",
    flexShrink: 0,
    cursor: "pointer",
    alignItems: "center",
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
    borderWidth: 0,
    backgroundColor: color.transparent,
    padding: space.s0,
    fontSize: text.label,
    color: { default: color.dim, [ACTIVE]: color.fg },
    fontWeight: { default: null, [ACTIVE]: weight.strong },
  },
  // The wash sits on an inner plate so the underline keeps the row's full
  // height under it.
  tabPlate: {
    display: "flex",
    alignItems: "center",
    gap: space.s6,
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
    paddingInline: space.s8,
    paddingBlock: space.s4,
    transitionProperty: "color, background-color, border-color",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
    backgroundColor: {
      default: null,
      [stylex.when.ancestor(":hover", tabMarker)]: {
        default: null,
        [media.hover]: color.hover,
      },
    },
    color: {
      default: null,
      [stylex.when.ancestor(":hover", tabMarker)]: {
        default: null,
        [media.hover]: color.fg,
      },
    },
  },
  tabIcon: {
    display: "inline-flex",
    flexShrink: 0,
    color: {
      default: color.faint,
      [stylex.when.ancestor(ACTIVE, tabMarker)]: color.dim,
    },
  },
  count: {
    borderRadius: radius.capsule,
    ["cornerShape"]: corner.squircle,
    backgroundColor: color.hover,
    paddingInline: space.s6,
    fontSize: text.meta,
    fontWeight: weight.medium,
    color: color.dim,
    fontVariantNumeric: "tabular-nums",
  },
  plateList: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    gap: space.s4,
  },
  plateTab: {
    ...focusRing,
    display: "flex",
    minWidth: 0,
    flexShrink: 0,
    cursor: "pointer",
    alignItems: "center",
    gap: space.s6,
    borderRadius: radius.lg,
    ["cornerShape"]: corner.squircle,
    borderStyle: "none",
    paddingInline: space.s8,
    paddingBlock: space.s4,
    minHeight: { default: null, [media.phone]: controlHeight.touch },
    fontSize: text.label,
    transitionProperty: "color, background-color, border-color",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
    backgroundColor: {
      default: color.transparent,
      ":hover": { default: null, [media.hover]: color.hover },
      [ACTIVE]: color.hover,
    },
    color: {
      default: color.dim,
      ":hover": { default: null, [media.hover]: color.fg },
      [ACTIVE]: color.fg,
    },
  },
  plateIcon: {
    position: "relative",
    display: "inline-flex",
    flexShrink: 0,
    color: color.dim,
  },
  // An attention dot, cut out of the plate by a ring of the panel's surface.
  attention: {
    position: "absolute",
    top: `calc(-1 * ${space.s2})`,
    right: `calc(-1 * ${space.s2})`,
    width: space.s8,
    height: space.s8,
    borderRadius: radius.pill,
    backgroundColor: color.blue,
    boxShadow: `0 0 0 ${space.s2} ${color.panelSurface}`,
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

/**
 * Underline tabs: the pages of one object (a pull request's Overview and
 * Files changed), drawn the way GitHub draws them. A word with an optional
 * count, and a bar under the page you are on that slides to the next one.
 *
 * Use it for page navigation that sits on a divider line. A short exclusive
 * setting stays a `Segmented`; this is a place you go, not a value you set.
 *
 * Built on Base UI's Tabs, so arrow keys move between tabs and the list is
 * one tab stop. It renders no panels: the caller swaps the page itself.
 */
function Root({
  value,
  onValueChange,
  label,
  className,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <BaseTabs.Root
      value={value}
      onValueChange={onValueChange}
      {...sx(styles.root, className)}
    >
      <BaseTabs.List aria-label={label} {...stylex.props(styles.list)}>
        {children}
        <BaseTabs.Indicator {...stylex.props(styles.indicator)} />
      </BaseTabs.List>
    </BaseTabs.Root>
  );
}

function Tab({
  value,
  icon,
  count,
  children,
}: {
  value: string;
  icon?: React.ReactNode;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <BaseTabs.Tab value={value} {...stylex.props(styles.tab, tabMarker)}>
      {/* The wash sits on an inner plate so the underline keeps the row's
          full height under it. */}
      <span {...stylex.props(styles.tabPlate)}>
        {icon && <span {...stylex.props(styles.tabIcon)}>{icon}</span>}
        {children}
        {count !== undefined && (
          <span {...stylex.props(styles.count)}>{count}</span>
        )}
      </span>
    </BaseTabs.Tab>
  );
}

export const UnderlineTabs = { Root, Tab };

/**
 * Plate tabs: the pages of a panel, drawn like the side panel's own tab
 * strip. An icon and a word on a soft plate; the page you are on keeps the
 * wash. A blue dot on the icon says that page has something waiting on
 * someone. Underline tabs sit on a divider; these stand on their own.
 */
function PlateRoot<T extends string>({
  value,
  onValueChange,
  label,
  className,
  children,
}: {
  value: T;
  onValueChange: (value: T) => void;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <BaseTabs.Root
      value={value}
      onValueChange={(next: T) => onValueChange(next)}
      className={className}
    >
      <BaseTabs.List aria-label={label} {...stylex.props(styles.plateList)}>
        {children}
      </BaseTabs.List>
    </BaseTabs.Root>
  );
}

function PlateTab({
  value,
  icon,
  attention,
  children,
}: {
  value: string;
  icon: React.ReactNode;
  attention?: boolean;
  children: React.ReactNode;
}) {
  return (
    <BaseTabs.Tab value={value} {...stylex.props(styles.plateTab)}>
      <span {...stylex.props(styles.plateIcon)}>
        {icon}
        {attention && (
          <span aria-hidden="true" {...stylex.props(styles.attention)} />
        )}
      </span>
      <span {...stylex.props(styles.truncate)}>{children}</span>
    </BaseTabs.Tab>
  );
}

export const PlateTabs = { Root: PlateRoot, Tab: PlateTab };
