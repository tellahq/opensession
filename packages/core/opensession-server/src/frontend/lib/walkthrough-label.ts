import * as stylex from "@stylexjs/stylex";
import { sharedClassStyles } from "../styles/shared-class-styles.stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexClassName } from "../ui/cn";

export type WalkthroughMediaLabel = "before" | "after" | "demo";

export const WALKTHROUGH_LABEL_TEXT: Record<WalkthroughMediaLabel, string> = {
  before: "Before",
  after: "After",
  demo: "Demo",
};

const sx = stylex.create({
  bgPanel: { backgroundColor: "var(--bg-panel)" },
  px2: { paddingInline: "8px" },
  py05: { paddingBlock: "2px" },
  fontSemibold: { fontWeight: "var(--font-weight-semibold)" },
  leading4: { lineHeight: "16px" },
  textRed: { color: "var(--red)" },
  textGreen: { color: "var(--green)" },
  textBlue: { color: "var(--blue)" },
});

export const WALKTHROUGH_LABEL_CLASS = mergeStylexClassName(
  "shadow-[inset_0_0_0_1px_var(--border),0_1px_1px_oklch(0_0_0_/_0.14)]",
  sharedClassStyles.rounded999px,
  sx.bgPanel,
  sx.px2,
  sx.py05,
  typography.meta,
  sx.fontSemibold,
  sx.leading4,
);

export const WALKTHROUGH_LABEL_TONE: Record<WalkthroughMediaLabel, string> = {
  before: mergeStylexClassName(
    "[background-image:linear-gradient(var(--red-soft),var(--red-soft))]",
    sx.textRed,
  ),
  after: mergeStylexClassName(
    "[background-image:linear-gradient(var(--green-soft),var(--green-soft))]",
    sx.textGreen,
  ),
  demo: mergeStylexClassName(
    "[background-image:linear-gradient(var(--blue-soft),var(--blue-soft))]",
    sx.textBlue,
  ),
};
