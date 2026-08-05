import React, { useEffect, useRef, useState } from "react";
import { fetchSubagent, type SubagentTranscript } from "../lib/api";
import { friendlyModelSlug, opencodeModelParts } from "./ModelEffortSelect";
import { TranscriptBlocks } from "./TranscriptBlocks";

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
}

/**
 * A sub-agent's conversation, rendered full-width as its own view tab beside
 * the chat tabs — a sub-agent run is a conversation, so it reads like one
 * instead of being squeezed into the right sidebar. Fetches over REST and,
 * while the parent session is still running, polls so a live sub-agent's
 * transcript fills in. Sub-agents that spawn their own sub-agents are
 * navigable via the breadcrumb stack.
 */
export function SubagentPane({ sessionId, stack, onOpenSubagent, onBack }: Props) {
  const current = stack[stack.length - 1];
  const [data, setData] = useState<SubagentTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Stick to the bottom only while the reader is already there, so polling a
  // live sub-agent doesn't yank them up from scrollback.
  const followRef = useRef(true);

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
      try {
        const next = await fetchSubagent(sessionId, current.agentId);
        if (cancelled) return;
        setData(next);
        setLoading(false);
        // Keep polling only while the parent session is live (the sub-agent may
        // still be streaming); once idle the transcript is final.
        if (next.sessionRunning) timer = setTimeout(() => load(false), 1500);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || "Failed to load sub-agent");
        setLoading(false);
      }
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
  const modelLabel = meta?.model
    ? friendlyModelSlug(opencodeModelParts(meta.model)?.model ?? meta.model)
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="subagent-head border-b border-line bg-raised px-2.5 pb-2.5 pt-2">
        <div className="subagent-head-top flex items-center gap-2">
          <span className="subagent-chip whitespace-nowrap rounded-sm bg-accent-soft px-1.5 py-0.5 text-meta font-semibold tracking-[-0.01em] text-accent">sub-agent</span>
          <span className="subagent-title min-w-0 flex-1 truncate text-control-label font-semibold text-fg" title={meta?.description || current.label}>
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
          {data?.sessionRunning && <span className="subagent-live-dot size-[7px] shrink-0 animate-pulse rounded-full bg-green" title="Session running" />}
        </div>
        {stack.length > 1 && (
          <button className="subagent-back mt-2 block max-w-full truncate bg-transparent p-0 text-label text-dim hover:text-fg focus-ring" onClick={onBack}>
            ← {stack[stack.length - 2].label}
          </button>
        )}
        {meta?.description && <div className="subagent-desc mt-1.5 text-label leading-[1.4] text-dim">{meta.description}</div>}
      </div>

      <div className="panel-body subagent-body min-h-0 flex-1 overflow-y-auto px-3.5 py-3" ref={bodyRef} onScroll={onScroll}>
        {loading ? (
          <div className="panel-placeholder px-4 py-12 text-center text-control-label text-faint">Loading sub-agent…</div>
        ) : error ? (
          <div className="panel-placeholder panel-error px-4 py-12 text-center text-control-label text-red">{error}</div>
        ) : data && data.entries.length > 0 ? (
          <div className="subagent-messages min-w-0">
            <TranscriptBlocks
              entries={data.entries}
              live={data.sessionRunning}
              onOpenSubagent={onOpenSubagent}
            />
          </div>
        ) : (
          <div className="panel-placeholder px-4 py-12 text-center text-control-label text-faint">No transcript yet for this sub-agent.</div>
        )}
      </div>
    </div>
  );
}
