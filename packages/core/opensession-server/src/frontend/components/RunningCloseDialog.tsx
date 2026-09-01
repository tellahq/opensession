import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { Button } from "../ui/button";
import { Modal } from "../ui/modal";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  gap5: {
    gap: "calc(4px * 5)",
  },
  m0: {
    margin: "0",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  tracking001em: {
    letterSpacing: "-0.01em",
  },
  textFg: {
    color: "var(--text)",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  mt3: {
    marginTop: "calc(4px * 3)",
  },
  justifyEnd: {
    justifyContent: "flex-end",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  ml5: {
    marginLeft: "calc(4px * 5)",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  opacity70: {
    opacity: "70%",
  },
});

export function RunningCloseDialog({
  runningCount,
  onCancel,
  onConfirm,
}: {
  runningCount: number | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal.Root
      open={runningCount !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      disablePointerDismissal
    >
      <Modal.Content
        widthClassName={utilityClassName("max-w-[34rem]")}
        className={mergeStylexOverrideClassName("", sx.gap5)}
      >
        <Modal.Title
          className={mergeStylexOverrideClassName(
            "",
            sx.m0,
            sx.fontSemibold,
            sx.tracking001em,
            sx.textFg,
            typography.dialogTitle,
          )}
        >
          Close running session
          {runningCount === 1 ? "" : "s"}?
        </Modal.Title>
        <Modal.Description
          className={mergeStylexOverrideClassName(
            "",
            sx.m0,
            sx.leadingRelaxed,
            sx.textDim,
            typography.body,
          )}
        >
          {runningCount === 1
            ? "This session is currently running. Closing it will cancel its current run."
            : `These ${runningCount ?? 0} sessions are currently running. Closing them will cancel their current runs.`}
        </Modal.Description>
        <Modal.Footer
          className={mergeStylexOverrideClassName(
            "",
            sx.mt3,
            sx.justifyEnd,
            sx.gap3,
          )}
        >
          <Modal.Close render={<Button size="lg">Cancel</Button>} />
          <Button variant="danger-strong" size="lg" onClick={onConfirm}>
            <span>Close anyway</span>
            <span
              {...stylex.props(
                sx.ml5,
                sx.fontMedium,
                sx.opacity70,
                typography.label,
              )}
            >
              ⌘↵
            </span>
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
