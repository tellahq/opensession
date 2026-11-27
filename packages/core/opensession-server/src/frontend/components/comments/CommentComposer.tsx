import React, { useEffect, useRef, useState } from "react";
import type { FileMention } from "../../lib/api";
import { AGENT_NAME } from "../../lib/brand";
import { noAutofill } from "../../lib/composer-autofill";
import { isTouchPrimary } from "../../lib/platform";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Tooltip } from "../../ui/tooltip";
import { IconArrowUp } from "../icons";
import { useFileMentions } from "../useFileMentions";

/** The agent as an "@" row: tagging it asks for an answer in the thread. */
const agentRow: FileMention = {
  display: AGENT_NAME,
  insert: "agent",
  kind: "person",
  sub: "Answers in this thread",
};

function agentRows(query: string): Promise<FileMention[]> {
  const q = query.trim().toLowerCase();
  const matches =
    !q || "agent".startsWith(q) || AGENT_NAME.toLowerCase().startsWith(q);
  return Promise.resolve(matches ? [agentRow] : []);
}

const noFiles = () => Promise.resolve<FileMention[]>([]);

/**
 * The text box under a thread, and the one that starts a thread. "@" opens
 * the same people picker the session composer uses, with the agent first.
 * Enter sends on a desktop keyboard (Shift+Enter for a new line); a touch
 * keyboard has no Shift+Enter habit, so there the button sends.
 */
export function CommentComposer({
  placeholder,
  submitLabel,
  autoFocus,
  onSubmit,
  onCancel,
  compact,
  className,
}: {
  placeholder: string;
  submitLabel: string;
  autoFocus?: boolean;
  /** Resolve true to clear the box; false keeps the text for a retry. */
  onSubmit: (text: string) => Promise<boolean>;
  onCancel?: () => void;
  /** Collapsed to one line until focused or filled (the reply box). */
  compact?: boolean;
  className?: string;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const {
    setInputWrap,
    popup: mentionPopup,
    inputProps: mentionInputProps,
    sync: syncMentions,
    handleKeyDown: handleMentionKeyDown,
    close: closeMentions,
  } = useFileMentions({
    value,
    onChange: (next) => setValue(next),
    textareaRef,
    mentionFetch: noFiles,
    paletteFetch: agentRows,
  });

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  // Grow with the text, up to the cap in the class list.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "";
    el.style.height = `${el.scrollHeight}px`;
    // Scroll only once the text outgrows the cap (max-h-48).
    el.style.overflowY = el.scrollHeight > 192 ? "auto" : "hidden";
  }, [value]);

  async function submit() {
    const text = value.trim();
    if (!text || busy) return;
    setBusy(true);
    const ok = await onSubmit(text).finally(() => setBusy(false));
    if (ok) setValue("");
  }

  const expanded = !compact || focused || value.length > 0;

  return (
    // One card, like the session composer: the draft on top and, once it is
    // in use, Cancel and a send disc inside the same edge. Focus deepens the
    // hairline rather than ringing it in the accent.
    <div
      ref={setInputWrap}
      className={cn(
        "relative flex flex-col rounded-xl border border-line bg-surface smooth-shadow-xs transition-[border-color] focus-within:border-line-strong",
        expanded ? "px-3 pt-2.5 pb-2" : "px-3 py-1.5",
        className,
      )}
    >
      <textarea
        ref={textareaRef}
        value={value}
        rows={1}
        disabled={busy}
        placeholder={placeholder}
        aria-label={placeholder}
        {...noAutofill}
        {...mentionInputProps}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          closeMentions();
        }}
        onKeyUp={syncMentions}
        onClick={syncMentions}
        onKeyDown={(e) => {
          if (handleMentionKeyDown(e)) return;
          if (e.key === "Escape" && onCancel) {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
            return;
          }
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            !e.nativeEvent.isComposing &&
            (e.metaKey || e.ctrlKey || !isTouchPrimary)
          ) {
            e.preventDefault();
            void submit();
          }
        }}
        className="block max-h-48 min-h-6 w-full resize-none overflow-hidden border-none bg-transparent p-0 text-body leading-body text-fg outline-none placeholder:text-faint phone:text-input-phone"
      />
      {mentionPopup}
      {expanded && (
        <div className="mt-2 flex items-center justify-end gap-1.5">
          {onCancel && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onCancel}
              disabled={busy}
              className="phone:min-h-10"
            >
              Cancel
            </Button>
          )}
          <Tooltip label={submitLabel}>
            <Button
              size="sm"
              variant="primary"
              aria-label={submitLabel}
              icon={<IconArrowUp size={20} />}
              // Keep focus in the box: a press that blurs it would collapse a
              // compact reply box before the click lands.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void submit()}
              disabled={busy || !value.trim()}
              // The session composer's send disc, at comment size. Until
              // there is text it is a quiet grey disc, not a washed accent.
              className="size-7 rounded-full disabled:bg-pressed disabled:text-faint disabled:opacity-100 disabled:shadow-none phone:size-10"
            />
          </Tooltip>
        </div>
      )}
    </div>
  );
}
