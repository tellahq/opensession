import React, { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentUser } from "./UserPicker";
import { Button } from "../ui/button";

interface Props {
  sessionId: string;
  /** Human label for the source, e.g. `PR #1234` — used in the delivered message. */
  label: string;
  /** WS sender; when absent the selection popover is disabled (read-only view). */
  send?: (msg: any) => void;
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
export function SelectionToSession({ sessionId, label, send, children }: Props) {
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

  const onMouseUp = useCallback(() => {
    if (!send) return;
    // Defer so the browser has finalised the selection after mouseup.
    setTimeout(() => {
      const s = window.getSelection();
      const text = s?.toString().trim() || "";
      if (!s || s.rangeCount === 0 || text.length < 2) return;
      const anchor = s.anchorNode;
      // Only act on selections inside our region (ignore the popover's own text).
      if (!anchor || !hostRef.current || !hostRef.current.contains(anchor)) return;
      if (popRef.current && anchor && popRef.current.contains(anchor)) return;
      const rect = s.getRangeAt(0).getBoundingClientRect();
      setSel({ text, x: rect.left + rect.width / 2, y: rect.bottom });
      setComposing(false);
      setMessage("");
      setSent(false);
    }, 0);
  }, [send]);

  // Dismiss on outside click / Escape.
  useEffect(() => {
    if (!sel) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && popRef.current.contains(e.target as Node)) return;
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

  const doSend = useCallback(() => {
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
      (note ? note : "(no extra message — use the selection as the instruction / context)");
    send({ type: "prompt", sessionId, user, content });
    setSent(true);
    setTimeout(dismiss, 1400);
  }, [send, sel, message, label, sessionId, dismiss]);

  return (
    <div ref={hostRef} className="selection-host contents" onMouseUp={onMouseUp}>
      {children}
      {sel && send && (
        <div
          ref={popRef}
          className="selection-popover fixed z-[1000] max-w-[min(340px,90vw)] -translate-x-1/2 rounded-md border border-accent bg-panel font-sans shadow-[0_6px_24px_rgba(0,0,0,0.4)]"
          style={{ left: sel.x, top: sel.y + 6 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {sent ? (
            <div className="selection-sent whitespace-nowrap px-3.5 py-2 text-supporting text-accent">Sent to session ✓</div>
          ) : composing ? (
            <div className="selection-compose flex flex-col gap-2 p-2.5">
              <div className="selection-quote max-h-16 overflow-y-auto break-words whitespace-pre-wrap border-l-2 border-line-strong pl-2 text-meta text-faint">{sel.text}</div>
              <textarea
                autoFocus
                className="selection-input resize-y rounded-sm border border-line-strong bg-raised px-2.5 py-2 text-control-label leading-[1.45] text-fg outline-none focus:border-accent"
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
              <div className="selection-actions flex justify-end gap-2">
                <Button
                  variant="default"
                  size="sm"
                  className="min-h-0 border-line-strong bg-transparent px-3 py-[5px] text-control-label font-normal shadow-none"
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
            <button className="selection-trigger block whitespace-nowrap border-0 bg-transparent px-3 py-1.5 text-supporting text-fg hover:rounded-md hover:bg-hover" onClick={() => setComposing(true)}>
              💬 Send to session
            </button>
          )}
        </div>
      )}
    </div>
  );
}
