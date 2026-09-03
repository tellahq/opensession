import type { ReactNode } from "react";
import { SESSION_DELETE_LABEL } from "../../lib/session-viewer-classes";
import { Button } from "../../ui/button";
import { Modal } from "../../ui/modal";
import { DeleteSessionDialog } from "../DeleteSessionDialog";

interface DeleteDialogState {
  open: boolean;
  deleting: boolean;
  label: string;
  hasWorktree: boolean;
}

interface DeleteDialogActions {
  onOpenChange: (open: boolean) => void;
  onDelete: (cleanWorktree: boolean) => void;
}

interface BranchDialogState {
  open: boolean;
  busy: "move" | "create" | null;
  mode: "move" | "create";
  sessionBusy: boolean;
  connected: boolean;
}

interface BranchDialogActions {
  onOpenChange: (open: boolean) => void;
  onMove: () => void;
  onMoveAndCreatePr: () => void;
}

interface SessionViewerDialogsProps {
  confirmDialog: ReactNode;
  deletion: DeleteDialogState;
  deletionActions: DeleteDialogActions;
  branch: BranchDialogState;
  branchActions: BranchDialogActions;
}

export function SessionViewerDialogs({
  confirmDialog,
  deletion,
  deletionActions,
  branch,
  branchActions,
}: SessionViewerDialogsProps) {
  return (
    <>
      {deletion.deleting && (
        <div
          /* `session-delete-overlay` stays on the markup as a bare hook with
             no rule behind it: the Escape/outside-click handlers above ask
             `closest('.palette-backdrop, .composer-schedule-modal-backdrop,
             .session-delete-overlay')` whether a click landed on a blocking
             surface. Drop the name and a click through this overlay starts
             dismissing what's underneath it. */
          className="session-delete-overlay absolute inset-0 z-30 flex items-center justify-center bg-[color-mix(in_srgb,var(--bg)_72%,transparent)] backdrop-blur-[2px]"
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-col items-center gap-[14px] rounded-xl border border-line bg-panel px-8 py-[26px] smooth-shadow-lg">
            {/* `rounded-full` rather than `rounded-[50%]`: base.css grants the
                squircle to every `rounded-*` class EXCEPT `rounded-full`, and
                this ring was a bare `border-radius: 50%` with no corner-shape.
                It serialises as a clamped huge px value instead of 50%, which
                on a square box is the same circle. */}
            <div className="size-[30px] animate-[spin_0.8s_linear_infinite] rounded-full border-2 border-line-strong border-t-accent" />
            <span className={SESSION_DELETE_LABEL}>{deletion.label}</span>
          </div>
        </div>
      )}
      {confirmDialog}
      <DeleteSessionDialog
        open={deletion.open}
        onOpenChange={deletionActions.onOpenChange}
        hasWorktree={deletion.hasWorktree}
        deleting={deletion.deleting}
        onDelete={deletionActions.onDelete}
      />
      <Modal.Root
        open={branch.open}
        onOpenChange={(open) => {
          if (!branch.busy) branchActions.onOpenChange(open);
        }}
        disablePointerDismissal={branch.busy !== null}
      >
        <Modal.Content>
          <Modal.Header title="Move to a branch?" />
          <Modal.Description className="m-0 text-pretty text-supporting font-normal leading-relaxed text-dim">
            {branch.mode === "create"
              ? "You need to move this session to a branch before you can create a PR."
              : "Copies this session’s changes to a new branch without removing them from the shared checkout."}
          </Modal.Description>
          <Modal.Footer>
            <Modal.Close
              render={
                <Button variant="ghost" disabled={branch.busy !== null}>
                  Cancel
                </Button>
              }
            />
            <Button
              variant="primary"
              disabled={
                branch.sessionBusy ||
                branch.busy !== null ||
                (branch.mode === "create" && !branch.connected)
              }
              onClick={() =>
                void (branch.mode === "create"
                  ? branchActions.onMoveAndCreatePr()
                  : branchActions.onMove())
              }
            >
              {branch.busy
                ? "Moving…"
                : branch.mode === "create"
                  ? "Move and create PR"
                  : "Move to branch"}
            </Button>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    </>
  );
}
