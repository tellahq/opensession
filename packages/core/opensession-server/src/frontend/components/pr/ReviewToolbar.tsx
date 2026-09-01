import type { ReactNode } from "react";
import { WS_SUMMARY_REVIEW_BAR_CLEARANCE } from "../../lib/workspace-summary-classes";
import * as stylex from "@stylexjs/stylex";
import { mergeStylexProps, mergeStylexClassName } from "../../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  pointerEventsNone: {
    pointerEvents: "none",
  },
  sticky: {
    position: "sticky",
  },
  top52px: {
    top: "52px",
  },
  z5: {
    zIndex: "5",
  },
  mx2: {
    marginInline: "8px",
  },
  hidden: {
    display: "none",
  },
  h25: {
    height: "10px",
  },
  Mb25: {
    marginBottom: "-10px",
  },
  overflowClip: {
    overflow: "clip",
  },
  roundedTLg: {
    borderTopLeftRadius: "calc(14px * var(--rf))",
    borderTopRightRadius: "calc(14px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },

  relative: {
    position: "relative",
  },
  shrink0: {
    flexShrink: "0",
  },
  desktopPt25: {
    "@media (min-width: 721px)": {
      paddingTop: "10px",
    },
  },
  desktopRoundedLg: {
    "@media (min-width: 721px)": {
      borderRadius: "calc(14px * var(--rf))",
    },
  },
  desktopBorder: {
    "@media (min-width: 721px)": {
      borderStyle: "var(--tw-border-style)",
      borderWidth: "1px",
    },
  },
  desktopBorderLine: {
    "@media (min-width: 721px)": {
      borderColor: "var(--border)",
    },
  },

  desktopOverflowHidden: {
    "@media (min-width: 721px)": {
      overflow: "hidden",
    },
  },
  desktopOverflowVisible: {
    "@media (min-width: 721px)": {
      overflow: "visible",
    },
  },

  top0: {
    top: "0",
  },
  z20: {
    zIndex: "20",
  },
  desktopMb0: {
    "@media (min-width: 721px)": {
      marginBottom: "0",
    },
  },
  desktopMl2: {
    "@media (min-width: 721px)": {
      marginLeft: "8px",
    },
  },
  desktopPb2: {
    "@media (min-width: 721px)": {
      paddingBottom: "8px",
    },
  },
  desktopMx2: {
    "@media (min-width: 721px)": {
      marginInline: "8px",
    },
  },
  desktopMb2: {
    "@media (min-width: 721px)": {
      marginBottom: "8px",
    },
  },
  desktopBlock: {
    "@media (min-width: 721px)": {
      display: "block",
    },
  },
});

/**
 * The floating review toolbar shared by branches with and without a pull
 * request. It stays edge to edge on phone and clears the standing workspace
 * summary on wide review canvases. The sticky outer surface masks code through
 * its inset; an opaque lower mask keeps scrolled code beneath pinned file headers.
 */
export function ReviewToolbar({
  children,
  compact,
}: {
  children: ReactNode;
  compact: boolean;
}) {
  const placement = compact
    ? [
        mergeStylexClassName(
          "",
          sx.sticky,
          sx.top0,
          sx.z20,
          sx.desktopMb0,
          sx.desktopMl2,
          sx.desktopPb2,
        ),
        WS_SUMMARY_REVIEW_BAR_CLEARANCE,
      ]
        .filter(Boolean)
        .join(" ")
    : mergeStylexClassName("", sx.desktopMx2, sx.desktopMb2);

  return (
    <>
      <div
        className={[
          mergeStylexClassName("", sx.relative, sx.shrink0, sx.desktopPt25),
          placement,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div
          className={[
            mergeStylexClassName(
              "",
              sx.relative,
              sx.bgSurface,
              sx.desktopRoundedLg,
            ),
            "desktop:smooth-shadow-ring-sm",
            compact
              ? mergeStylexClassName("", sx.desktopOverflowHidden)
              : mergeStylexClassName("", sx.desktopOverflowVisible),
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {children}
        </div>
      </div>
    </>
  );
}
