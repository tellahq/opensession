import React, { useEffect, useState } from "react";
import { BASE_PATH } from "../lib/base";
import type { TranscriptEntry } from "../lib/types";
import type { WorkflowAgentSnapshot } from "../../server/workflow-types";
import { cn } from "../ui/cn";
import { TranscriptBlocks } from "./TranscriptBlocks";

/**
 * The workflow-agent drill-in: one workflow agent's FULL conversation — every
 * tool call it made, not just its final text — rendered with the same
 * TranscriptBlocks the main thread and SubagentPane use, behind a
 * breadcrumb-back header (mirrors SubagentPane's pattern).
 *
 * Source: GET /api/workflows/:runId/agents/:seq/transcript →
 * { entries: TranscriptEntry[] }, read off the agent's pi session
 * (outcome.engineSessionId). While the agent is running we poll every 2s so you
 * watch it work live; once it terminates the transcript is final and polling
 * stops. A 404 means the agent has no engine session yet (it hasn't started, or
 * the run predates engineSessionId capture) — that's a placeholder, not an
 * error.
 *
 * Scrolling is deliberately NOT auto-followed: the scroll container is the
 * shared right-panel body owned by SessionViewer, and yanking it is exactly the
 * reader-intent hijack we removed elsewhere.
 */

interface Props {
  runId: string;
  /** Live snapshot from the WS-fed run list — status/duration keep updating. */
  agent: WorkflowAgentSnapshot;
  onBack: () => void;
}

type Load =
  | { kind: "loading" }
  | { kind: "ready"; entries: TranscriptEntry[] }
  /** No engine session (yet) — the agent hasn't started, or it's an old run. */
  | { kind: "none" }
  | { kind: "error"; message: string };

const POLL_MS = 2000;

export function WorkflowAgentTranscript({ runId, agent, onBack }: Props) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const running = agent.status === "running" || agent.status === "pending";

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll(initial: boolean) {
      if (initial) setLoad({ kind: "loading" });
      await (async () => {
        const res = await fetch(
          `${BASE_PATH}/api/workflows/${encodeURIComponent(runId)}/agents/${agent.seq}/transcript`,
        );
        if (cancelled) return;
        if (res.status === 404) setLoad({ kind: "none" });
        else if (!res.ok) throw new Error(`HTTP ${res.status}`);
        else {
          const data: { entries?: TranscriptEntry[] } | null = await res.json();
          if (cancelled) return;
          setLoad({ kind: "ready", entries: data?.entries ?? [] });
        }
      })().catch(async (e) => {
        if (cancelled) return;
        // A transient miss on a live agent just retries on the next tick.
        if (initial || !running)
          setLoad({
            kind: "error",
            message:
              e instanceof Error ? e.message : "Failed to load the transcript",
          });
      });
      // Keep watching only while the agent is still working.
      if (!cancelled && running) timer = setTimeout(() => poll(false), POLL_MS);
    }

    poll(true);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, agent.seq, running]);

  const entries = load.kind === "ready" ? load.entries : [];

  return (
    <div className="flex min-h-0 flex-col">
      <div className="sticky top-0 z-10 border-b border-divider bg-panel px-2 py-2">
        <button
          className="flex w-full items-center gap-1.5 rounded-control px-1 py-0.5 text-left transition-colors hover:bg-hover"
          onClick={onBack}
        >
          <svg
            viewBox="0 0 12 12"
            className="size-3 shrink-0 text-faint"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M7.5 2 3.5 6l4 4" />
          </svg>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
            {agent.label}
          </span>
          {agent.status === "running" && (
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-yellow" />
          )}
        </button>
        <div className="mt-0.5 pl-[18px] text-meta text-faint tabular-nums">
          {[
            `agent ${agent.seq}`,
            agent.status,
            agent.write ? "write" : undefined,
            agent.phase,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
      <div className="min-w-0 px-2 py-2">
        {load.kind === "loading" ? (
          <Placeholder>Loading the agent&rsquo;s conversation…</Placeholder>
        ) : load.kind === "error" ? (
          <Placeholder tone="error">{load.message}</Placeholder>
        ) : load.kind === "none" ? (
          <Placeholder>
            {running
              ? "This agent hasn’t started yet."
              : "No conversation recorded for this agent."}
          </Placeholder>
        ) : entries.length === 0 ? (
          <Placeholder>
            {running ? "Waiting for the first step…" : "Nothing to show."}
          </Placeholder>
        ) : (
          // The workspace panel scrolls through PANEL_BODY, not the main
          // transcript's `.viewer-messages` container. Its virtualizer cannot
          // measure against that panel and would mount zero rows even though
          // the API returned entries. Workflow conversations are capped at
          // 500 entries, so render this bounded drill-in statically.
          <TranscriptBlocks
            entries={entries}
            live={running}
            virtualize={false}
          />
        )}
      </div>
    </div>
  );
}

function Placeholder({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <div
      className={cn(
        "px-1 py-3 text-xs leading-relaxed",
        tone === "error" ? "text-red" : "text-faint",
      )}
    >
      {children}
    </div>
  );
}
