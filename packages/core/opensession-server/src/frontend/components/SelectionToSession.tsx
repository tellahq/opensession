import React, { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentUser } from "./UserPicker";
import { Button } from "../ui/button";
import { noAutofill } from "../lib/composer-autofill";
import type { WSClientMessage } from "../lib/types";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import {
  mergeStylexProps,
  mergeStylexClassName,
  mergeStylexOverrideClassName,
} from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  contents: {
    display: "contents",
  },
  fixed: {
    position: "fixed",
  },
  z1000: {
    zIndex: "1000",
  },
  TranslateX12: {
    translate: "calc(calc(1 / 2 * 100%) * -1) 0",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderAccent: {
    borderColor: "var(--accent)",
  },
  bgPopupGlass: {
    backgroundColor: "var(--popup-glass)",
  },
  fontSans: {
    fontFamily: "var(--sans)",
  },
  smoothShadowMd: {
    boxShadow:
      "0 2px 6px -2px var(--smooth-shadow-color), 0 10px 28px -8px var(--smooth-shadow-color)",
  },
  px35: {
    paddingInline: "14px",
  },
  py2: {
    paddingBlock: "8px",
  },
  whitespaceNowrap: {
    whiteSpace: "nowrap",
  },
  textAccent: {
    color: "var(--accent-ink)",
  },
  flex: {
    display: "flex",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap2: {
    gap: "8px",
  },
  p25: {
    padding: "10px",
  },
  maxH16: {
    maxHeight: "64px",
  },
  overflowYAuto: {
    overflowY: "auto",
  },
  borderL2: {
    borderLeftStyle: "solid",
    borderLeftWidth: "2px",
  },
  borderLineStrong: {
    borderColor: "var(--border-strong)",
  },
  pl2: {
    paddingLeft: "8px",
  },
  breakWords: {
    overflowWrap: "break-word",
  },
  whitespacePreWrap: {
    whiteSpace: "pre-wrap",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  resizeY: {
    resize: "vertical",
  },
  bgRaised: {
    backgroundColor: "var(--bg-raised)",
  },
  px25: {
    paddingInline: "10px",
  },
  leading145: {
    lineHeight: "1.45",
  },
  textFg: {
    color: "var(--text)",
  },
  outlineNone: {
    outlineStyle: "none",
  },
  justifyEnd: {
    justifyContent: "flex-end",
  },
  minH0: {
    minHeight: "0",
  },
  px3: {
    paddingInline: "12px",
  },
  py5px: {
    paddingBlock: "5px",
  },
  fontNormal: {
    fontWeight: "var(--font-weight-normal)",
  },
  px14px: {
    paddingInline: "14px",
  },
  py6px: {
    paddingBlock: "6px",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  block: {
    display: "block",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  borderNone: {
    borderStyle: "none",
  },
  bgTransparent: {
    backgroundColor: "transparent",
  },
  py7px: {
    paddingBlock: "7px",
  },

  maxWMin340px90vw: {
    maxWidth: "min(340px,90vw)",
  },
  BackdropFilterVarPopupBlur: {
    WebkitBackdropFilter: "var(--popup-blur)",
    backdropFilter: "var(--popup-blur)",
  },
  focusBorderAccent: {
    ":focus": {
      borderColor: "var(--accent)",
    },
  },
  shadowNone: {
    "--tw-shadow": "0 0 transparent",
    boxShadow:
      "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
});

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
    <div ref={hostRef} {...stylex.props(sx.contents)} onMouseUp={onMouseUp}>
      {children}
      {sel && send && (
        <div
          ref={popRef}
          {...mergeStylexProps(
            "",
            sx.maxWMin340px90vw,
            sx.BackdropFilterVarPopupBlur,
            sx.fixed,
            sx.z1000,
            sx.TranslateX12,
            sx.roundedMd,
            sx.border,
            sx.borderAccent,
            sx.bgPopupGlass,
            sx.fontSans,
            sx.smoothShadowMd,
          )}
          style={{ left: sel.x, top: sel.y + 6 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {sent ? (
            <div
              {...stylex.props(
                sx.px35,
                sx.py2,
                sx.whitespaceNowrap,
                sx.textAccent,
                typography.label,
              )}
            >
              Sent to session ✓
            </div>
          ) : composing ? (
            <div {...stylex.props(sx.flex, sx.flexCol, sx.gap2, sx.p25)}>
              <div
                {...stylex.props(
                  sx.maxH16,
                  sx.overflowYAuto,
                  sx.borderL2,
                  sx.borderLineStrong,
                  sx.pl2,
                  sx.breakWords,
                  sx.whitespacePreWrap,
                  sx.textFaint,
                  typography.supporting,
                )}
              >
                {sel.text}
              </div>
              <textarea
                autoFocus
                {...noAutofill}
                {...mergeStylexProps(
                  "",
                  sx.focusBorderAccent,
                  sx.resizeY,
                  sx.roundedMd,
                  sx.border,
                  sx.borderLineStrong,
                  sx.bgRaised,
                  sx.px25,
                  sx.py2,
                  sx.fontSans,
                  sx.leading145,
                  sx.textFg,
                  sx.outlineNone,
                  typography.label,
                )}
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
              <div {...stylex.props(sx.flex, sx.justifyEnd, sx.gap2)}>
                <Button
                  variant="soft"
                  size="sm"
                  className={mergeStylexOverrideClassName(
                    "",
                    sx.minH0,
                    sx.px3,
                    sx.py5px,
                    sx.fontNormal,
                    typography.label,
                  )}
                  onClick={dismiss}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  {...mergeStylexProps(
                    "",
                    sx.shadowNone,
                    sx.minH0,
                    sx.px14px,
                    sx.py6px,
                    sx.fontMedium,
                    typography.supporting,
                  )}
                  onClick={doSend}
                >
                  Send to session
                </Button>
              </div>
            </div>
          ) : (
            <button
              {...mergeStylexProps(
                "",
                sx.hoverBgHover,
                sx.block,
                sx.cursorPointer,
                sx.roundedMd,
                sx.borderNone,
                sx.bgTransparent,
                sx.px3,
                sx.py7px,
                sx.fontSans,
                sx.whitespaceNowrap,
                sx.textFg,
                typography.label,
              )}
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
