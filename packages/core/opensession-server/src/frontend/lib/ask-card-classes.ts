import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";

const sx = stylex.create({
  mxAuto: {
    marginInline: "auto",
  },
  mb6: {
    marginBottom: "24px",
  },
  mt2: {
    marginTop: "8px",
  },
  flex: {
    display: "flex",
  },
  wFull: {
    width: "100%",
  },
  maxWVarSessionCol: {
    maxWidth: "var(--session-col)",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap5: {
    gap: "20px",
  },
  roundedXl: {
    borderRadius: "calc(18px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgRaised: {
    backgroundColor: "var(--bg-raised)",
  },
  p4: {
    padding: "16px",
  },
  CornerShapeVarCs: {
    cornerShape: "var(--cs)",
  },
  relative: {
    position: "relative",
  },
  minH11: {
    minHeight: "44px",
  },
  selectNone: {
    WebkitUserSelect: "none",
    userSelect: "none",
  },
  itemsStart: {
    alignItems: "flex-start",
  },
  gap3: {
    gap: "12px",
  },
  roundedCalc12pxVarRf: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgControl: {
    backgroundColor: "var(--control-surface)",
  },
  px3: {
    paddingInline: "12px",
  },
  py25: {
    paddingBlock: "10px",
  },
  textLeft: {
    textAlign: "left",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  transitionBackgroundColor: {
    transitionProperty: "background-color",
    transitionTimingFunction: "var(--tw-ease,var(--ease))",
    transitionDuration: "var(--tw-duration,var(--dur-micro))",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
});

/** Visual shell and choice rows for the live AskUserQuestion card. */

export const ASK_CARD_SHELL = mergeStylexClassName(
  "",
  sx.mxAuto,
  sx.mb6,
  sx.mt2,
  sx.flex,
  sx.wFull,
  sx.maxWVarSessionCol,
  sx.flexCol,
  sx.gap5,
  sx.roundedXl,
  sx.bgRaised,
  sx.p4,
  sx.CornerShapeVarCs,
);

export const ASK_CHOICE_ROW_BASE = mergeStylexClassName(
  "group",
  sx.relative,
  sx.flex,
  sx.minH11,
  sx.wFull,
  sx.selectNone,
  sx.itemsStart,
  sx.gap3,
  sx.roundedCalc12pxVarRf,
  sx.bgControl,
  sx.px3,
  sx.py25,
  sx.textLeft,
  sx.CornerShapeVarCs,
);

export const ASK_CHOICE_ROW = `${ASK_CHOICE_ROW_BASE} ${mergeStylexClassName(
  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--accent-ink)]",
  sx.cursorPointer,
  sx.transitionBackgroundColor,
  sx.hoverBgHover,
)}`;
