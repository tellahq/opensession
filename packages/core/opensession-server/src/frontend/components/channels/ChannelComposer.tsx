import { useState } from "react";
import { noAutofill } from "../../lib/composer-autofill";
import {
  composerBox,
  composerBoxExpanded,
  composerSend,
  composerSendDefault,
  composerTextarea,
  composerTextareaPadding,
  composerToolbar,
} from "../../lib/composer-classes";
import { effectiveSendKey, isSendCombo } from "../../lib/send-key";
import { Checkbox } from "../../ui/checkbox";
import { cn } from "../../ui/cn";
import { IconArrowUp } from "../icons";

/**
 * The box under a channel or a thread. Same family as the session composer
 * (lib/composer-classes), and it posts as the signed-in person. Enter sends
 * on a keyboard; a touch keyboard has no Shift+Enter, so there it is the
 * send button.
 */
export function ChannelComposer({
  placeholder,
  disabled,
  disabledHint,
  broadcastLabel,
  onSend,
  autoFocus,
}: {
  placeholder: string;
  disabled: boolean;
  /** Shown instead of the placeholder while disabled. */
  disabledHint?: string;
  /** In a thread: the label of "also send to the channel". */
  broadcastLabel?: string;
  onSend: (text: string, broadcast: boolean) => Promise<boolean>;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [broadcast, setBroadcast] = useState(false);
  const sendKey = effectiveSendKey("enter");

  async function send() {
    const text = draft.trim();
    if (!text || sending || disabled) return;
    setSending(true);
    const sent = await onSend(text, broadcast);
    setSending(false);
    if (sent) {
      setDraft("");
      setBroadcast(false);
    }
  }

  return (
    // `composer` stays as a hook: base.css keys phone keyboard and shadow
    // behaviour off the class name.
    <div
      className={cn(
        "composer",
        composerBox,
        composerBoxExpanded,
        disabled && "opacity-60",
      )}
    >
      <textarea
        // `composer-textarea` stays as a class name hook (the sidebar swipe
        // guard and SessionViewer's global keys look for it).
        className={cn(
          "composer-textarea",
          composerTextarea,
          composerTextareaPadding,
          "text-fg placeholder:text-faint",
        )}
        style={{ minHeight: 44 }}
        placeholder={disabled && disabledHint ? disabledHint : placeholder}
        value={draft}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (isSendCombo(event, sendKey)) {
            event.preventDefault();
            void send();
          }
        }}
        rows={1}
        aria-label={placeholder}
        {...noAutofill}
      />
      <div className={composerToolbar}>
        {broadcastLabel ? (
          <label className="flex min-h-9 grow basis-0 cursor-pointer items-center gap-2 pl-1 text-meta text-dim select-none">
            <Checkbox
              checked={broadcast}
              onCheckedChange={(checked) => setBroadcast(checked === true)}
              disabled={disabled}
            />
            {broadcastLabel}
          </label>
        ) : (
          <div className="shrink-0 grow basis-0" />
        )}
        <button
          type="button"
          className={cn(composerSend, composerSendDefault)}
          onClick={() => void send()}
          disabled={disabled || sending || !draft.trim()}
          aria-label="Send message"
        >
          <IconArrowUp size={24} />
        </button>
      </div>
    </div>
  );
}
