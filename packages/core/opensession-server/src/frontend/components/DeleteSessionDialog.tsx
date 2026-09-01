import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { Button } from "../ui/button";
import { Modal } from "../ui/modal";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
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

interface Props {
  open: boolean;
  hasWorktree: boolean;
  deleting: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (deleteWorktree: boolean) => void;
}

/** The shared destructive choice opened from a session's overflow menu. */
export function DeleteSessionDialog({
  open,
  hasWorktree,
  deleting,
  onOpenChange,
  onDelete,
}: Props) {
  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!deleting) onOpenChange(next);
      }}
      disablePointerDismissal={deleting}
    >
      <Modal.Content
        role="alertdialog"
        widthClassName={utilityClassName("max-w-[25rem]")}
      >
        <Modal.Header
          title="Delete session"
          description={
            hasWorktree
              ? "Delete the session only, or delete it together with its worktree. This can’t be undone."
              : "Delete this session permanently. This can’t be undone."
          }
        />
        <Modal.Footer>
          <Button
            type="button"
            size="lg"
            variant={hasWorktree ? "warning" : "danger-strong"}
            className={mergeStylexOverrideClassName(
              "",
              sx.phoneMinH11,
              sx.phoneFlex1,
            )}
            disabled={deleting}
            onClick={() => onDelete(false)}
          >
            {deleting ? "Deleting…" : "Delete session"}
          </Button>
          {hasWorktree && (
            <Button
              type="button"
              size="lg"
              variant="danger-strong"
              className={mergeStylexOverrideClassName(
                "",
                sx.phoneMinH11,
                sx.phoneFlex1,
              )}
              disabled={deleting}
              onClick={() => onDelete(true)}
            >
              {deleting ? "Deleting…" : "Delete worktree"}
            </Button>
          )}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
