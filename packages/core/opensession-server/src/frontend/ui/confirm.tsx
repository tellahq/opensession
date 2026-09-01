import { mergeStylexOverrideClassName } from "./cn";
import { utilityClassName } from "./cn";
import * as React from "react";
import { Modal } from "./modal";
import { Button } from "./button";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  m0: {
    margin: "0",
  },
  textBalance: {
    textWrap: "balance",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  leadingTight: {
    lineHeight: "var(--leading-tight)",
  },
  tracking001em: {
    letterSpacing: "-0.01em",
  },
  textFg: {
    color: "var(--text)",
  },
  textPretty: {
    textWrap: "pretty",
  },
  fontNormal: {
    fontWeight: "var(--font-weight-normal)",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  phoneFlex1: {
    "@media (max-width: 720px)": {
      flex: "1",
    },
  },
});

/**
 * The app's confirmation alert: a title, an optional one-sentence
 * consequence, and two buttons. It replaces `window.confirm()`, which draws
 * the OS dialog (Chrome's grey sheet with the app icon and an "OK" button)
 * over an app that otherwise owns every surface it shows.
 *
 * Built on ui/modal so it inherits the shell, the scrim and the enter/exit
 * animation. Two deliberate differences from `Modal.Header`:
 *
 *  - no ✕. An alert already offers the way out as a labelled button, and a
 *    second dismissal in the corner is one control too many on a surface
 *    holding exactly one question.
 *  - focus starts on the SAFE button for a destructive confirm, so Enter
 *    cancels. macOS alerts do the same, and the cost of a mistaken Return on
 *    "Delete" is the thing this dialog exists to prevent.
 *
 * Drive it with `useConfirm()`, which keeps the request alive through the
 * exit animation (clearing it on close would blank the text mid-fade):
 *
 *   const [confirm, confirmDialog] = useConfirm();
 *   …
 *   confirm({
 *     title: "Delete this draft?",
 *     description: "It has no sessions, so nothing else is removed.",
 *     confirmLabel: "Delete",
 *     destructive: true,
 *     onConfirm: () => deleteDraft(row),
 *   });
 *   …
 *   return <>{rows}{confirmDialog}</>;
 */
export type ConfirmRequest = {
  title: React.ReactNode;
  /** One sentence on what happens. Skip it when the title says everything. */
  description?: React.ReactNode;
  /** A verb, one or two words. Defaults to "Confirm". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Solid red confirm, and focus parked on Cancel. */
  destructive?: boolean;
  onConfirm: () => void;
};

export function ConfirmDialog({
  request,
  open,
  onOpenChange,
}: {
  request: ConfirmRequest | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const confirmRef = React.useRef<HTMLButtonElement>(null);
  if (!request) return null;
  const {
    title,
    description,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    destructive,
    onConfirm,
  } = request;
  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content
        role="alertdialog"
        widthClassName={utilityClassName("max-w-[25rem]")}
        initialFocus={destructive ? cancelRef : confirmRef}
      >
        {/* 6px between title and consequence, the same step Modal.Header
				    holds, so an alert and a full dialog open on one rhythm. */}
        <div {...stylex.props(sx.flex, sx.flexCol, sx.gap15)}>
          <Modal.Title
            className={mergeStylexOverrideClassName(
              "",
              sx.m0,
              sx.textBalance,
              sx.fontSemibold,
              sx.leadingTight,
              sx.tracking001em,
              sx.textFg,
              typography.dialogTitle,
            )}
          >
            {title}
          </Modal.Title>
          {description && (
            <Modal.Description
              className={mergeStylexOverrideClassName(
                "",
                sx.m0,
                sx.textPretty,
                sx.fontNormal,
                sx.leadingRelaxed,
                sx.textDim,
                typography.supporting,
              )}
            >
              {description}
            </Modal.Description>
          )}
        </div>
        <Modal.Footer>
          <Button
            ref={cancelRef}
            type="button"
            size="lg"
            variant="soft"
            className={mergeStylexOverrideClassName(
              "",
              sx.phoneMinH11,
              sx.phoneFlex1,
            )}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            type="button"
            size="lg"
            variant={destructive ? "danger-strong" : "primary"}
            className={mergeStylexOverrideClassName(
              "",
              sx.phoneMinH11,
              sx.phoneFlex1,
            )}
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

/** `[confirm, confirmDialog]`: call `confirm(request)` to ask, and render
 *  `confirmDialog` once anywhere in the component's tree. */
export function useConfirm(): [
  (request: ConfirmRequest) => void,
  React.ReactElement,
] {
  const [request, setRequest] = React.useState<ConfirmRequest | null>(null);
  const [open, setOpen] = React.useState(false);
  const confirm = (next: ConfirmRequest) => {
    setRequest(next);
    setOpen(true);
  };
  // The request outlives the close on purpose: Base UI keeps the popup
  // mounted through its exit transition, and clearing it here would empty
  // the dialog for those 150ms.
  const element = (
    <ConfirmDialog request={request} open={open} onOpenChange={setOpen} />
  );
  return [confirm, element];
}
