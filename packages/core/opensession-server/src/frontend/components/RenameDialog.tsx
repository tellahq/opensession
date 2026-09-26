import { useRef, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Modal } from "../ui/modal";

/**
 * The phone's rename editor. On desktop a rename edits the title in place,
 * but the phone hides that title row (the centered bar title replaces it),
 * so the same draft opens here instead. `draft === null` means closed, the
 * same contract as the inline editor, so callers share one piece of state.
 */
export function RenameDialog({
  title,
  draft,
  onDraftChange,
  onCommit,
  onCancel,
}: {
  title: string;
  draft: string | null;
  onDraftChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Keep the last text through the exit fade instead of blanking the field.
  const [shown, setShown] = useState(draft ?? "");
  if (draft !== null && draft !== shown) setShown(draft);
  return (
    <Modal.Root
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Modal.Content widthClassName="max-w-[25rem]" initialFocus={inputRef}>
        <Modal.Header title={title} />
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            onCommit();
          }}
        >
          <Input
            ref={inputRef}
            size="lg"
            value={shown}
            aria-label="Name"
            enterKeyHint="done"
            onChange={(event) => onDraftChange(event.target.value)}
            onFocus={(event) => event.target.select()}
          />
          <Modal.Footer>
            <Button
              type="button"
              size="lg"
              variant="soft"
              className="phone:min-h-11 phone:flex-1"
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="lg"
              variant="primary"
              className="phone:min-h-11 phone:flex-1"
              disabled={!shown.trim()}
            >
              Rename
            </Button>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}
