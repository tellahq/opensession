import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import { BASE_PATH } from "../lib/base";
import { msgSystemInline, msgSystemRow } from "../lib/msg-classes";
import { Button } from "../ui/button";
import { Skeleton, SkeletonBar } from "../ui/state";
import { TranscriptLoadingStatus } from "./TranscriptLoadingStatus";

const sessionContextMetadataSchema = z.object({
  available: z.boolean(),
  exact: z.boolean().optional(),
  bytes: z.number().optional(),
  estimatedTokens: z.number().optional(),
  content: z.string().optional(),
});

type SessionContextMetadata = z.infer<typeof sessionContextMetadataSchema>;

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
 * slot so resolving the negative result cannot shift the transcript either.
 * History requests reuse this slot, so their status never inserts another row. */
export function SessionContextMessage({
  sessionId,
  historyLoading = false,
}: {
  sessionId: string;
  historyLoading?: boolean;
}) {
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
      .then(async (response) =>
        sessionContextMetadataSchema.parse(
          response.ok ? await response.json() : { available: false },
        ),
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
      const value = sessionContextMetadataSchema.parse(await response.json());
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
      {historyLoading && !open ? (
        <TranscriptLoadingStatus />
      ) : metadata === null ? (
        <Skeleton label="Loading session context" className={msgSystemInline}>
          <SkeletonBar className="mx-auto h-5 w-44 max-w-[60%]" />
        </Skeleton>
      ) : available ? (
        <>
          <span className={msgSystemInline}>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={open}
              onClick={toggle}
              className="h-auto min-h-0 cursor-pointer bg-transparent p-0 [font-family:inherit] text-inherit hover:bg-transparent"
            >
              {title} ·{" "}
              <span className="font-medium text-dim">
                {open ? "hide" : "show"}
              </span>
            </Button>
          </span>
          {open && (
            <div className="mx-auto mt-2 w-full max-w-[560px] rounded-lg bg-panel px-4 py-3 text-left">
              {loading ? (
                <p className="m-0 text-label text-dim">Loading…</p>
              ) : (
                <pre className="m-0 max-h-[70vh] overflow-auto whitespace-pre-wrap break-words font-sans text-label leading-relaxed text-fg">
                  {content}
                </pre>
              )}
            </div>
          )}
        </>
      ) : (
        <span className={msgSystemInline} aria-hidden>
          <span className="block h-5" />
        </span>
      )}
    </div>
  );
}
