import { Button } from "../ui/button";
import { Modal } from "../ui/modal";

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
      <Modal.Content widthClassName="max-w-[34rem]" className="gap-5">
        <Modal.Title className="m-0 text-dialog-title font-semibold tracking-tight text-fg">
          Close running session
          {runningCount === 1 ? "" : "s"}?
        </Modal.Title>
        <Modal.Description className="m-0 text-body leading-relaxed text-dim">
          {runningCount === 1
            ? "This session is currently running. Closing it will cancel its current run."
            : `These ${runningCount ?? 0} sessions are currently running. Closing them will cancel their current runs.`}
        </Modal.Description>
        <Modal.Footer className="mt-3 justify-end gap-3">
          <Modal.Close render={<Button size="lg">Cancel</Button>} />
          <Button variant="danger-strong" size="lg" onClick={onConfirm}>
            <span>Close anyway</span>
            <span className="ml-5 text-label font-medium opacity-70">⌘↵</span>
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
