import { UNDO_SHORTCUT_KEYS } from "../../lib/undo";
import { Button } from "../../ui/button";
import { cn, mergeStylexProps, mergeStylexClassName } from "../../ui/cn";
import { Tooltip } from "../../ui/tooltip";
import { IconUndo } from "../icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  shrink0: {
    flexShrink: "0",
  },
  opacity60: {
    opacity: ".6",
  },
  TextBoxTrimBothCapAlphabetic: {
    textBox: "trim-both cap alphabetic",
  },

  inlineFlex: {
    display: "inline-flex",
  },
  itemsStretch: {
    alignItems: "stretch",
  },
  whitespaceNowrap: {
    whiteSpace: "nowrap",
  },
  bgFg8: {
    backgroundColor: "var(--text)",
    "@supports (color: color-mix(in lab, red, red))": {
      backgroundColor: "color-mix(in oklab, var(--text) 8%, transparent)",
    },
  },
  textDim: {
    color: "var(--text-dim)",
  },
  minH22px: {
    minHeight: "22px",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  minH26px: {
    minHeight: "26px",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  textXs: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading,var(--text-xs--line-height))",
  },
  phoneMinH26px: {
    "@media (max-width: 720px)": {
      minHeight: "26px",
    },
  },
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  fontMedium: {
    "--tw-font-weight": "var(--font-weight-medium)",
    fontWeight: "var(--font-weight-medium)",
  },
  px2: {
    paddingInline: "8px",
  },
  px25: {
    paddingInline: "10px",
  },
  phonePx15: {
    "@media (max-width: 720px)": {
      paddingInline: "6px",
    },
  },
  relative: {
    position: "relative",
  },
  roundedLNone: {
    borderTopLeftRadius: "0",
    borderBottomLeftRadius: "0",
    cornerShape: "var(--cs)",
  },
  beforeAbsolute: {
    "::before": {
      content: "var(--tw-content)",
      position: "absolute",
    },
  },
  beforeInsetY15: {
    "::before": {
      content: "var(--tw-content)",
      insetBlock: "6px",
    },
  },
  beforeLeft0: {
    "::before": {
      content: "var(--tw-content)",
      left: "0",
    },
  },
  beforeWPx: {
    "::before": {
      content: "var(--tw-content)",
      width: "1px",
    },
  },
  beforeBgLine: {
    "::before": {
      content: "var(--tw-content)",
      backgroundColor: "var(--border)",
    },
  },
  roundedRMd: {
    borderTopRightRadius: "calc(7px * var(--rf))",
    borderBottomRightRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  roundedRControl: {
    borderTopRightRadius: "calc(12px * var(--rf))",
    borderBottomRightRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },

  phoneHidden: {
    "@media (max-width: 720px)": {
      display: "none",
    },
  },
});

/** The merge button's five-second inline result and its reversal. */
export function MergeUndoControl({
  onUndo,
  compact = false,
  className,
}: {
  onUndo: () => void;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        mergeStylexClassName(
          "",
          sx.inlineFlex,
          sx.shrink0,
          sx.itemsStretch,
          sx.whitespaceNowrap,
          sx.bgFg8,
          sx.textDim,
        ),
        compact
          ? mergeStylexClassName(
              "",
              sx.minH22px,
              sx.roundedMd,
              typography.label,
            )
          : mergeStylexClassName(
              "",
              sx.minH26px,
              sx.roundedControl,
              sx.textXs,
              sx.phoneMinH26px,
            ),
        className,
      )}
    >
      <span
        aria-live="polite"
        className={cn(
          mergeStylexClassName(
            "",
            sx.flex,
            sx.itemsCenter,
            sx.fontMedium,
            sx.TextBoxTrimBothCapAlphabetic,
          ),
          compact
            ? mergeStylexClassName("", sx.px2)
            : mergeStylexClassName("", sx.px25, sx.phonePx15),
        )}
      >
        PR merged
      </span>
      <Tooltip label="Undo" shortcut={UNDO_SHORTCUT_KEYS}>
        <Button
          variant="ghost"
          size="sm"
          onClick={onUndo}
          className={cn(
            mergeStylexClassName(
              "",
              sx.relative,
              sx.roundedLNone,
              sx.beforeAbsolute,
              sx.beforeInsetY15,
              sx.beforeLeft0,
              sx.beforeWPx,
              sx.beforeBgLine,
            ),
            compact
              ? mergeStylexClassName(
                  "",
                  sx.minH22px,
                  sx.roundedRMd,
                  sx.px2,
                  typography.label,
                )
              : mergeStylexClassName(
                  "",
                  sx.roundedRControl,
                  sx.phoneMinH26px,
                  sx.phonePx15,
                ),
          )}
        >
          <IconUndo
            size={20}
            {...mergeStylexProps("", sx.phoneHidden, sx.shrink0, sx.opacity60)}
          />
          <span {...stylex.props(sx.TextBoxTrimBothCapAlphabetic)}>Undo</span>
        </Button>
      </Tooltip>
    </div>
  );
}
