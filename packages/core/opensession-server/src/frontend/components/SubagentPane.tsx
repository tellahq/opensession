import React, { useCallback, useEffect, useRef, useState } from "react";
import { fetchSubagent, type SubagentTranscript } from "../lib/api";
import { friendlyModelSlug, routedModelParts } from "./ModelEffortSelect";
import { TranscriptBlocks } from "./TranscriptBlocks";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import { PANEL_BODY } from "../lib/session-panel-classes";
import { Badge } from "../ui/badge";
import { errorMessage } from "../lib/error-message";

export interface SubagentRef {
  agentId: string;
  /** Human label for the breadcrumb (the Task summary, e.g. "Explore: find X"). */
  label: string;
}

interface Props {
  sessionId: string;
  /** Breadcrumb stack; the last entry is the sub-agent currently shown. */
  stack: SubagentRef[];
  /** Open a nested sub-agent (a Task call inside this sub-agent). */
  onOpenSubagent: (agentId: string, label: string) => void;
  /** Pop back to the parent sub-agent in the stack. */
  onBack: () => void;
  /** The name read off the sub-agent's own transcript. A link into a sub-agent
   *  carries ids only, so this is what gives its tab a real label. */
  onLabel?: (agentId: string, label: string) => void;
}

/**
 * A sub-agent's conversation, rendered full-width as its own view tab beside
 * the session tabs — a sub-agent run is a conversation, so it reads like one
 * instead of being squeezed into the right sidebar. Fetches over REST and,
 * while the parent session is still running, polls so a live sub-agent's
 * transcript fills in. Sub-agents that spawn their own sub-agents are
 * navigable via the breadcrumb stack.
 */
/** The pane's own liveness dot: 1.6s, slower than the sidebar's 1.4s. The
 * reduced-motion exception rides on the element — base.css blanks every
 * animation with !important and hands specific "still working" signals back,
 * and a name in that list stops matching the moment a migration renames the
 * element. */
const LIVE_DOT =
  "size-[7px] shrink-0 rounded-full bg-green animate-live " +
  "motion-reduce:[animation-duration:1.4s]! motion-reduce:[animation-iteration-count:infinite]!";

export function SubagentPane({
  sessionId,
  stack,
  onOpenSubagent,
  onBack,
  onLabel,
}: Props) {
  const current = stack[stack.length - 1];
  const [data, setData] = useState<SubagentTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [bodyElement, setBodyElement] = useState<HTMLDivElement | null>(null);
  const setBodyRef = useCallback((node: HTMLDivElement | null) => {
    bodyRef.current = node;
    setBodyElement(node);
  }, []);
  // Stick to the bottom only while the reader is already there, so polling a
  // live sub-agent doesn't yank them up from scrollback.
  const followRef = useRef(true);
  const shouldMaintainEnd = () => followRef.current;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load(initial: boolean) {
      if (initial) {
        setLoading(true);
        setError(null);
        setData(null);
        followRef.current = true;
      }
      await (async () => {
        const next = await fetchSubagent(sessionId, current.agentId);
        if (cancelled) return;
        setData(next);
        setLoading(false);
        // Keep polling only while the parent session is live (the sub-agent may
        // still be streaming); once idle the transcript is final.
        if (next.sessionRunning) timer = setTimeout(() => load(false), 1500);
      })().catch(async (error) => {
        if (cancelled) return;
        setError(errorMessage(error, "Failed to load sub-agent"));
        setLoading(false);
      });
    }

    load(true);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, current.agentId]);

  // After new content lands, keep a following reader pinned to the live edge.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [data]);

  function onScroll() {
    const el = bodyRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  const meta = data?.meta;
  const title = meta?.agentType || current.label || "Sub-agent";
  // Hand the name up for the tab. A drill-in already arrived carrying the Task
  // call's summary; a link arrived with an agent id and nothing to call it.
  const resolvedLabel = meta?.description || meta?.agentType || null;
  useEffect(() => {
    if (resolvedLabel) onLabel?.(current.agentId, resolvedLabel);
  }, [current.agentId, resolvedLabel, onLabel]);
  const modelLabel = meta?.model
    ? friendlyModelSlug(routedModelParts(meta.model)?.model ?? meta.model)
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-divider bg-raised px-2.5 pt-2 pb-2.5">
        <div className="flex items-center gap-2">
          <Badge tone="accent">sub-agent</Badge>
          <span
            className="overflow-hidden text-ellipsis whitespace-nowrap text-label font-semibold text-fg"
            title={meta?.description || current.label}
          >
            {title}
          </span>
          {modelLabel && (
            <span
              className="shrink-0 rounded-sm bg-surface px-1.5 py-0.5 text-meta text-dim"
              title={meta?.model}
            >
              {modelLabel}
            </span>
          )}
          {/* No close button: the tab's × owns that, like Review and Assets. */}
          {data?.sessionRunning && (
            <span className={LIVE_DOT} title="Session running" />
          )}
        </div>
        {stack.length > 1 && (
          <button
            className="mt-2 max-w-full overflow-hidden border-none bg-transparent p-0 text-ellipsis whitespace-nowrap text-supporting text-dim hover:text-fg"
            onClick={onBack}
          >
            ← {stack[stack.length - 2].label}
          </button>
        )}
        {meta?.description && (
          <div className="mt-1.5 text-supporting leading-snug text-dim">
            {meta.description}
          </div>
        )}
      </div>

      <div
        className={`${PANEL_BODY} px-3.5 py-3`}
        ref={setBodyRef}
        onScroll={onScroll}
      >
        {loading ? (
          <LoadingState>Loading sub-agent…</LoadingState>
        ) : error ? (
          <InlineAlert className="m-4">{error}</InlineAlert>
        ) : data && data.entries.length > 0 ? (
          <div className="min-w-0">
            <TranscriptBlocks
              entries={data.entries}
              scrollElement={bodyElement}
              shouldMaintainEnd={shouldMaintainEnd}
              live={data.sessionRunning}
              onOpenSubagent={onOpenSubagent}
            />
          </div>
        ) : (
          <EmptyState>No transcript yet for this sub-agent.</EmptyState>
        )}
      </div>
    </div>
  );
}
