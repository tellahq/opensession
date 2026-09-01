import { checkClass, formatCheckDuration } from "../../lib/pr-status-derive";
import { CHECK_TEXT } from "../../lib/pr-tone-classes";
import type { PrCheck } from "../../lib/types";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";
import { mergeStylexProps, mergeStylexClassName } from "../../ui/cn";
import { motionStyles } from "../../styles/animations.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "8px",
  },
  roundedRow: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  px15: {
    paddingInline: "6px",
  },
  py1: {
    paddingBlock: "4px",
  },
  textFg: {
    color: "var(--text)",
  },
  transitionBackground: {
    transitionProperty: "background",
    transitionTimingFunction: "var(--tw-ease,var(--ease))",
    transitionDuration: "var(--tw-duration,var(--dur-micro))",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  textInherit: {
    color: "inherit",
  },
  noUnderline: {
    textDecorationLine: "none",
  },
  truncate: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  textFaint: {
    color: "var(--text-faint)",
  },

  w35: {
    width: "14px",
  },
  shrink0: {
    flexShrink: "0",
  },
  textCenter: {
    textAlign: "center",
  },

  animatePulse14sInfinite: {
    animation: "1.4s infinite pulse",
  },

  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  tabularNums: {
    "--tw-numeric-spacing": "tabular-nums",
    fontVariantNumeric:
      "var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)",
  },
});

/** `pr-check-mark-pending` styles nothing — it is base.css's hook for keeping
 *  this pulse alive under prefers-reduced-motion, which it does with
 *  !important and a utility therefore cannot. */
export function CheckRow({ check }: { check: PrCheck }) {
  const cls = checkClass(check.status, check.conclusion);
  const mark =
    cls === "check-success" ? "✓" : cls === "check-failure" ? "✕" : "●";
  const duration = formatCheckDuration(check);
  return (
    <div
      {...mergeStylexProps(
        "group",
        sx.hoverBgHover,
        sx.flex,
        sx.itemsCenter,
        sx.gap2,
        sx.roundedRow,
        sx.px15,
        sx.py1,
        sx.textFg,
        sx.transitionBackground,
        typography.label,
      )}
    >
      <a
        {...stylex.props(
          sx.flex,
          sx.minW0,
          sx.flex1,
          sx.itemsCenter,
          sx.gap2,
          sx.textInherit,
          sx.noUnderline,
        )}
        href={check.url}
        target="_blank"
        rel="noopener"
      >
        <span
          className={[
            mergeStylexClassName(
              "",
              sx.w35,
              sx.shrink0,
              sx.textCenter,
              typography.label,
            ),
            CHECK_TEXT[cls],
            cls === "check-pending"
              ? mergeStylexClassName(
                  "pr-check-mark-pending",
                  sx.animatePulse14sInfinite,
                )
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {mark}
        </span>
        <span {...stylex.props(sx.flex1, sx.truncate)}>{check.name}</span>
        {duration && (
          <span
            {...mergeStylexProps(
              "",
              sx.tabularNums,
              sx.textFaint,
              typography.meta,
            )}
          >
            {duration}
          </span>
        )}
        {check.url && (
          <span
            {...mergeStylexProps(
              "group-hover:text-fg",
              sx.textFaint,
              typography.itemTitle,
            )}
          >
            ↗
          </span>
        )}
      </a>
    </div>
  );
}
