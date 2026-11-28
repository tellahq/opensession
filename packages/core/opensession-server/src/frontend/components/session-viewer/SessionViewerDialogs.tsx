import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { PageLoader } from "../../ui/page-loader";
import { sx } from "../../ui/sx";
import {
  blur,
  color,
  corner,
  layer,
  radius,
  shadow,
  space,
  text,
} from "../../ui/tokens.stylex";
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

const styles = stylex.create({
  overlay: {
    position: "absolute",
    inset: space.s0,
    zIndex: layer.shellOverlay,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.veil,
    backdropFilter: blur.veil,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.s14,
    borderRadius: radius.xl,
    ["cornerShape"]: corner.squircle,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.line,
    backgroundColor: color.panel,
    paddingInline: space.s32,
    paddingBlock: space.s24,
    boxShadow: shadow.lg,
  },
  label: { fontSize: text.label, color: color.dim },
});

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
          {...sx(styles.overlay, "session-delete-overlay")}
          role="status"
          aria-live="polite"
        >
          {/* The app's one large waiting spinner, as on an empty pane. */}
          <div {...stylex.props(styles.card)}>
            <PageLoader />
            <span {...stylex.props(styles.label)}>{deletion.label}</span>
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
          <Modal.Description>
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
