import React, { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentUser } from "./UserPicker";
import { Button } from "../ui/button";
import { noAutofill } from "../lib/composer-autofill";
import type { WSClientMessage } from "../lib/types";

interface Props {
  sessionId: string;
  /** Human label for the source, e.g. `PR #1234` — used in the delivered message. */
  label: string;
  /** WS sender; when absent the selection popover is disabled (read-only view). */
  send?: (msg: WSClientMessage) => void;
  children: React.ReactNode;
}

interface Selection {
  text: string;
  x: number;
  y: number;
}

/**
 * Wraps a region of selectable text. When the user selects text inside it, a
 * floating "Send to session" popover appears; they can attach a message and send
 * the quoted selection + message to `sessionId` as a `prompt` (the server starts a
 * turn if idle, or steers/queues if the session is busy — same path as the diff
 * comment feature). Renders as `display:contents` so it doesn't disturb layout.
 */
export function SelectionToSession({
  sessionId,
  label,
  send,
  children,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);

  const dismiss = useCallback(() => {
    setSel(null);
    setComposing(false);
    setMessage("");
    setSent(false);
  }, []);

  const onMouseUp = () => {
    if (!send) return;
    // Defer so the browser has finalised the selection after mouseup.
    setTimeout(() => {
      const s = window.getSelection();
      const text = s?.toString().trim() || "";
      if (!s || s.rangeCount === 0 || text.length < 2) return;
      const anchor = s.anchorNode;
      // Only act on selections inside our region (ignore the popover's own text).
      if (!anchor || !hostRef.current || !hostRef.current.contains(anchor))
        return;
      if (popRef.current && anchor && popRef.current.contains(anchor)) return;
      const rect = s.getRangeAt(0).getBoundingClientRect();
      setSel({ text, x: rect.left + rect.width / 2, y: rect.bottom });
      setComposing(false);
      setMessage("");
      setSent(false);
    }, 0);
  };

  // Dismiss on outside click / Escape.
  useEffect(() => {
    if (!sel) return;
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && popRef.current?.contains(e.target))
        return;
      dismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [sel, dismiss]);

  const doSend = () => {
    if (!send || !sel) return;
    const user = getCurrentUser();
    const quoted = sel.text
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    const note = message.trim();
    const content =
      `${user} selected this text in ${label} and wants you to act on it:\n\n` +
      `${quoted}\n\n` +
      (note
        ? note
        : "(no extra message: use the selection as the instruction or context)");
    send({ type: "prompt", sessionId, user, content });
    setSent(true);
    setTimeout(dismiss, 1400);
  };

  return (
    // display:contents so wrapping a region doesn't disturb its layout.
    <div ref={hostRef} className="contents" onMouseUp={onMouseUp}>
      {children}
      {sel && send && (
        <div
          ref={popRef}
          className="fixed z-1000 max-w-[min(340px,90vw)] -translate-x-1/2 rounded-md border border-accent bg-popup-glass [backdrop-filter:var(--popup-blur)] font-sans smooth-shadow-md"
          style={{ left: sel.x, top: sel.y + 6 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {sent ? (
            <div className="px-3.5 py-2 text-label whitespace-nowrap text-accent">
              Sent to session ✓
            </div>
          ) : composing ? (
            <div className="flex flex-col gap-2 p-2.5">
              <div className="max-h-16 overflow-y-auto border-l-2 border-line-strong pl-2 text-supporting break-words whitespace-pre-wrap text-faint">
                {sel.text}
              </div>
              <textarea
                autoFocus
                {...noAutofill}
                className="resize-y rounded-md border border-line-strong bg-raised px-2.5 py-2 font-sans text-label leading-[1.45] text-fg outline-none focus:border-accent"
                rows={2}
                placeholder="Message to the session (optional)… ⌘↵ to send"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    doSend();
                  }
                }}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="soft"
                  size="sm"
                  className="min-h-0 px-3 py-[5px] text-label font-normal"
                  onClick={dismiss}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  className="min-h-0 px-[14px] py-[6px] text-supporting font-medium shadow-none"
                  onClick={doSend}
                >
                  Send to session
                </Button>
              </div>
            </div>
          ) : (
            <button
              className="block cursor-pointer rounded-md border-none bg-transparent px-3 py-[7px] font-sans text-label whitespace-nowrap text-fg hover:bg-hover"
              onClick={() => setComposing(true)}
            >
              💬 Send to session
            </button>
          )}
        </div>
      )}
    </div>
  );
}
