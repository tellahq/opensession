import { mergeStylexOverrideClassName } from "../ui/cn";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BASE_PATH } from "../lib/base";
import { msgSystemInline, msgSystemRow } from "../lib/msg-classes";
import { Button } from "../ui/button";
import { Skeleton, SkeletonBar } from "../ui/state";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  mxAuto: {
    marginInline: "auto",
  },
  h5: {
    height: "calc(4px * 5)",
  },
  w44: {
    width: "calc(4px * 44)",
  },
  maxW60: {
    maxWidth: "60%",
  },
  hAuto: {
    height: "auto",
  },
  minH0: {
    minHeight: "0",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  bgTransparent: {
    backgroundColor: "transparent",
  },
  p0: {
    padding: "0",
  },
  FontFamilyInherit: {
    fontFamily: "inherit",
  },
  textInherit: {
    color: "inherit",
  },
  hoverBgTransparent: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "transparent",
      },
    },
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  wFull: {
    width: "100%",
  },
  maxW560px: {
    maxWidth: "560px",
  },
  roundedLg: {
    borderRadius: "calc(14px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  px4: {
    paddingInline: "calc(4px * 4)",
  },
  py3: {
    paddingBlock: "calc(4px * 3)",
  },
  textLeft: {
    textAlign: "left",
  },
  m0: {
    margin: "0",
  },
  maxH70vh: {
    maxHeight: "70vh",
  },
  overflowAuto: {
    overflow: "auto",
  },
  whitespacePreWrap: {
    whiteSpace: "pre-wrap",
  },
  breakWords: {
    overflowWrap: "break-word",
  },
  fontSans: {
    fontFamily: "var(--sans)",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  textFg: {
    color: "var(--text)",
  },
  block: {
    display: "block",
  },
});

interface SessionContextMetadata {
  available: boolean;
  exact?: boolean;
  bytes?: number;
  estimatedTokens?: number;
  content?: string;
}

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function tokenLabel(tokens: number): string {
  if (tokens >= 1000) return `~${Math.round(tokens / 1000)}k tokens`;
  return `~${tokens} tokens`;
}

/** The complete provider input that preceded the initial user message. The
 * body is fetched only after expansion, so making prompt bloat visible does
 * not add that bloat to every transcript load.
 *
 * The collapsed row keeps its final geometry while metadata loads. This route
 * can need a cold transcript read, and mounting the row only after that work
 * completed used to prepend roughly 40px to an already-painted conversation.
 * A one-line ghost replaces in place instead, preserving the reader's scroll
 * position. Ancient sessions with no recorded context retain the same quiet
 * slot so resolving the negative result cannot shift the transcript either. */
export function SessionContextMessage({ sessionId }: { sessionId: string }) {
  const [metadata, setMetadata] = useState<SessionContextMetadata | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setMetadata(null);
    setOpen(false);
    setContent(null);
    void fetch(
      `${BASE_PATH}/api/sessions/${encodeURIComponent(sessionId)}/session-context`,
      { signal: controller.signal },
    )
      .then((response) =>
        response.ok ? response.json() : { available: false },
      )
      .then((value) => setMetadata(value))
      .catch(() => {
        if (!controller.signal.aborted) setMetadata({ available: false });
      });
    return () => controller.abort();
  }, [sessionId]);

  // Expanding a 100KB prompt can add most of a viewport above a transcript
  // pinned to its live edge. Keep the control and the start of the payload in
  // view so the first line does not jump above the phone's top bar.
  useLayoutEffect(() => {
    if (open && content != null)
      rowRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [open, content]);

  const available = metadata?.available === true;
  const bytes = metadata?.bytes ?? 0;
  const tokens = metadata?.estimatedTokens ?? 0;
  const title = available
    ? [
        metadata.exact === false
          ? "Session context · partial"
          : "Session context",
        sizeLabel(bytes),
        tokenLabel(tokens),
      ].join(" · ")
    : "";

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (content != null || loading) return;
    setLoading(true);
    await (async () => {
      const response = await fetch(
        `${BASE_PATH}/api/sessions/${encodeURIComponent(sessionId)}/session-context?content=1`,
      );
      if (!response.ok) throw new Error("context request failed");
      const value = (await response.json()) as SessionContextMetadata;
      setContent(value.content ?? "");
    })()
      .catch(() => {
        setContent("Couldn’t load the session context.");
      })
      .finally(() => {
        setLoading(false);
      });
  };

  return (
    <div ref={rowRef} className={msgSystemRow} data-session-context>
      {metadata === null ? (
        <Skeleton label="Loading session context" className={msgSystemInline}>
          <SkeletonBar
            className={mergeStylexOverrideClassName(
              "",
              sx.mxAuto,
              sx.h5,
              sx.w44,
              sx.maxW60,
            )}
          />
        </Skeleton>
      ) : available ? (
        <>
          <span className={msgSystemInline}>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={open}
              onClick={toggle}
              className={mergeStylexOverrideClassName(
                "",
                sx.hAuto,
                sx.minH0,
                sx.cursorPointer,
                sx.bgTransparent,
                sx.p0,
                sx.FontFamilyInherit,
                sx.textInherit,
                sx.hoverBgTransparent,
              )}
            >
              {title} ·{" "}
              <span {...stylex.props(sx.fontMedium, sx.textDim)}>
                {open ? "hide" : "show"}
              </span>
            </Button>
          </span>
          {open && (
            <div
              {...stylex.props(
                sx.mxAuto,
                sx.mt2,
                sx.wFull,
                sx.maxW560px,
                sx.roundedLg,
                sx.bgPanel,
                sx.px4,
                sx.py3,
                sx.textLeft,
              )}
            >
              {loading ? (
                <p {...stylex.props(sx.m0, sx.textDim, typography.label)}>
                  Loading…
                </p>
              ) : (
                <pre
                  {...stylex.props(
                    sx.m0,
                    sx.maxH70vh,
                    sx.overflowAuto,
                    sx.whitespacePreWrap,
                    sx.breakWords,
                    sx.fontSans,
                    sx.leadingRelaxed,
                    sx.textFg,
                    typography.label,
                  )}
                >
                  {content}
                </pre>
              )}
            </div>
          )}
        </>
      ) : (
        <span className={msgSystemInline} aria-hidden>
          <span {...stylex.props(sx.block, sx.h5)} />
        </span>
      )}
    </div>
  );
}
