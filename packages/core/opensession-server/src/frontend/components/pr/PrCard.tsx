import type React from "react";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";
import { mergeStylexProps, mergeStylexClassName } from "../../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  roundedXl: {
    borderRadius: "calc(18px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyBetween: {
    justifyContent: "space-between",
  },
  gap3: {
    gap: "12px",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  borderDivider: {
    borderColor: "var(--divider)",
  },
  px4: {
    paddingInline: "16px",
  },
  py3: {
    paddingBlock: "12px",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap2: {
    gap: "8px",
  },

  smPx5: {
    "@media (min-width: 40rem)": {
      paddingInline: "20px",
    },
  },
});

/** A titled card: a label row over a body of rows.
 *
 * No frame: the card sits on the review canvas's `bg-surface` with a fill of
 * its own, so a hairline round it would be a second edge. The rule under the
 * label stays: that one is a divider between the title and the rows, which is
 * genuinely a line. */
export function PrCard({
  title,
  headExtra,
  children,
}: {
  title: string;
  headExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div {...stylex.props(sx.roundedXl, sx.bgPanel)}>
      <div
        {...mergeStylexProps(
          "",
          sx.smPx5,
          sx.flex,
          sx.itemsCenter,
          sx.justifyBetween,
          sx.gap3,
          sx.borderB,
          sx.borderDivider,
          sx.px4,
          sx.py3,
        )}
      >
        <span
          {...stylex.props(sx.fontSemibold, sx.textFaint, typography.label)}
        >
          {title}
        </span>
        {headExtra}
      </div>
      <div
        {...mergeStylexProps(
          "",
          sx.smPx5,
          sx.flex,
          sx.flexCol,
          sx.gap2,
          sx.px4,
          sx.py3,
        )}
      >
        {children}
      </div>
    </div>
  );
}
