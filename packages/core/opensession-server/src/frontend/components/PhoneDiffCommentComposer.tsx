import { useEffect, useRef, useState } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type {
  CommentDraftTextStore,
  DiffCommentDraft,
} from "../hooks/usePendingComments";
import { diffCommentContext } from "../lib/diff-comment-context";
import { trackKeyboardInset } from "../lib/keyboard-inset";
import { noAutofill } from "../lib/composer-autofill";
import { renderPrCommentMarkdown } from "../lib/markdown";
import { errorMessage } from "../lib/error-message";
import { Button } from "../ui/button";
import { Modal } from "../ui/modal";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { useConfirm } from "../ui/confirm";
import { IconX } from "./icons";

export function PhoneDiffCommentComposer({
  draft,
  file,
  textStore,
  placeholder,
  submitLabel,
  disabled,
  disabledHint,
  repo,
  onCancel,
  onSubmit,
}: {
  draft: DiffCommentDraft;
  file: FileDiffMetadata;
  textStore: CommentDraftTextStore;
  placeholder: string;
  submitLabel: string;
  disabled?: boolean;
  disabledHint?: string;
  repo?: string;
  onCancel: () => void;
  onSubmit: (body: string) => Promise<void>;
}) {
  const [text, setText] = useState(() => textStore.read());
  const [mode, setMode] = useState("write");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmation] = useConfirm();
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => trackKeyboardInset(), []);
  const dismiss = () => {
    if (sending) return;
    if (!text.trim()) return onCancel();
    confirm({
      title: "Discard comment?",
      description: "Your unsaved comment will be lost.",
      confirmLabel: "Discard",
      cancelLabel: "Keep writing",
      destructive: true,
      onConfirm: onCancel,
    });
  };
  const submit = async () => {
    if (disabled || sending || !text.trim()) return;
    setSending(true);
    setError(null);
    try {
      await onSubmit(text.trim());
    } catch (error) {
      setError(errorMessage(error, "Failed to submit"));
      setSending(false);
    }
  };
  const start = Math.min(draft.range.start, draft.range.end);
  const end = Math.max(draft.range.start, draft.range.end);
  return (
    <Modal.Root
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <Modal.Content
        variant="palette"
        widthClassName="w-full"
        initialFocus={input}
        viewportClassName="items-stretch px-0 !pt-[env(safe-area-inset-top)] pb-[var(--kb-inset,0px)]"
        className="h-full min-h-0 rounded-none bg-surface pb-[env(safe-area-inset-bottom)]"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-2">
          <Modal.Title className="text-body font-semibold">Comment</Modal.Title>
          <Button
            variant="ghost"
            aria-label="Close comment"
            className="size-11"
            icon={<IconX size={20} />}
            onClick={dismiss}
            disabled={sending}
          />
        </div>
        <div className="min-h-0 shrink overflow-y-auto px-4 pb-3 max-h-[25%]">
          <p className="mb-2 break-all text-label text-dim">
            {draft.path} ·{" "}
            {start === end ? `line ${start}` : `lines ${start}–${end}`}
            {draft.range.side === "deletions" ? " (removed)" : ""}
          </p>
          <pre
            className="overflow-x-auto rounded-md bg-panel p-2 text-meta text-fg"
            aria-label="Selected code"
          >
            {diffCommentContext(file, draft.range).map((line) => (
              <div key={line.number}>
                <span className="mr-3 select-none text-faint">
                  {line.number}
                </span>
                {line.text}
              </div>
            ))}
          </pre>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-4">
          <Segmented
            label="Comment mode"
            value={mode}
            onValueChange={setMode}
            className="shrink-0 self-start"
          >
            <SegmentedOption value="write" className="min-h-11">
              Write
            </SegmentedOption>
            <SegmentedOption value="preview" className="min-h-11">
              Preview
            </SegmentedOption>
          </Segmented>
          {disabled ? (
            <p className="text-label text-dim">
              {disabledHint || "Unavailable right now"}
            </p>
          ) : mode === "write" ? (
            <textarea
              ref={input}
              {...noAutofill}
              aria-label="Comment"
              placeholder={placeholder}
              value={text}
              disabled={sending}
              className="min-h-11 w-full flex-1 resize-none rounded-md border border-line-strong bg-raised p-3 text-[length:var(--text-input-phone)] text-fg outline-none focus:border-accent"
              onChange={(event) => {
                setText(event.target.value);
                textStore.write(event.target.value);
              }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          ) : (
            <div
              className="markdown min-h-0 flex-1 overflow-y-auto text-body text-fg"
              dangerouslySetInnerHTML={{
                __html: text.trim()
                  ? renderPrCommentMarkdown(text, { repo })
                  : "<p>Nothing to preview</p>",
              }}
            />
          )}
          {error && (
            <p role="alert" className="text-label text-red">
              {error}
            </p>
          )}
        </div>
        <div className="flex shrink-0 justify-end px-4 py-3">
          <Button
            variant="primary"
            className="min-h-11"
            disabled={disabled || sending || !text.trim()}
            onClick={() => void submit()}
          >
            {sending ? "Sending…" : submitLabel}
          </Button>
        </div>
      </Modal.Content>
      {confirmation}
    </Modal.Root>
  );
}
