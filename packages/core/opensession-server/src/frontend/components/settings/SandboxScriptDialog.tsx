import { useEffect, useState } from "react";
import { useIsPhone } from "../../hooks/useIsPhone";
import { errorMessage } from "../../lib/error-message";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/input";
import { Modal } from "../../ui/modal";
import { ResponsiveDialog, SheetBody, SheetIconButton } from "../../ui/sheet";
import { toast } from "../../ui/toast";
import { IconX } from "../icons";

/**
 * Edit a lifecycle script kept in Workspace settings (a project's setup
 * script, the workspace resume script). Saving an empty script removes it.
 * A centered modal on desktop, a bottom sheet on phone.
 */
export function SandboxScriptDialog({
  open,
  onOpenChange,
  title,
  description,
  value,
  placeholder,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  value: string | null;
  placeholder: string;
  onSave: (script: string | null) => Promise<void>;
}) {
  const phone = useIsPhone();
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setDraft(value ?? "");
  }, [open, value]);

  async function save(next: string | null) {
    setSaving(true);
    await onSave(next && next.trim() ? next : null)
      .then(() => onOpenChange(false))
      .catch((error) =>
        toast(errorMessage(error, "Failed to save the script"), {
          variant: "error",
        }),
      )
      .finally(() => setSaving(false));
  }

  const editor = (
    <Textarea
      aria-label={title}
      className="min-h-56 font-mono text-meta leading-relaxed"
      spellCheck={false}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
  const actions = (
    <>
      {value ? (
        <Button
          variant="ghost"
          className="mr-auto text-red"
          disabled={saving}
          onClick={() => void save(null)}
        >
          Remove
        </Button>
      ) : null}
      <Button
        variant="ghost"
        disabled={saving}
        onClick={() => onOpenChange(false)}
      >
        Cancel
      </Button>
      <Button
        variant="primary"
        disabled={saving || draft === (value ?? "")}
        onClick={() => void save(draft)}
      >
        {saving ? "Saving…" : "Save"}
      </Button>
    </>
  );

  if (phone)
    return (
      <ResponsiveDialog
        open={open}
        onClose={() => onOpenChange(false)}
        phone
        label={title}
        sheetClassName="max-h-[88dvh]"
      >
        <div className="flex shrink-0 items-center gap-3 px-6 pb-2 pt-0.5">
          <h2 className="m-0 min-w-0 flex-1 text-dialog-title font-semibold leading-tight tracking-[-0.01em] text-fg">
            {title}
          </h2>
          <SheetIconButton
            aria-label="Close"
            onClick={() => onOpenChange(false)}
          >
            <IconX />
          </SheetIconButton>
        </div>
        <SheetBody className="flex flex-1 flex-col gap-3 px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
          <p className="m-0 text-supporting leading-relaxed text-dim">
            {description}
          </p>
          {editor}
          <div className="flex flex-wrap items-center justify-end gap-2 [&>button]:min-h-11">
            {actions}
          </div>
        </SheetBody>
      </ResponsiveDialog>
    );

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content widthClassName="max-w-[40rem]">
        <Modal.Header title={title} description={description} />
        {editor}
        <Modal.Footer>{actions}</Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
