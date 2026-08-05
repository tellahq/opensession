import React, { useState, useEffect } from "react";
import type { TranscriptEntry } from "../lib/types";
import { ToolCallBlock, toolDisplayName, toolSummary, useToolPathRoots } from "./ToolCallBlock";
import { IconChevronDown } from "./icons";
import { cn } from "../ui/cn";

interface Props {
  items: TranscriptEntry[]; // tool_use entries, in order
  toolResults: Map<string, TranscriptEntry>;
  live: boolean; // this is the active block of a running stream
  onOpenSubagent?: (agentId: string, label: string) => void;
}

/**
 * Devin-style work segment: a light "Worked for 12s · 5 steps" disclosure line
 * with the tool calls on a vertical timeline rail underneath — no box-in-box
 * chrome, the steps read as one grouped run of activity.
 */
// Memoized with a custom comparator: TranscriptBlocks rebuilds the `items`
// arrays and the `toolResults` Map on every render, so plain shallow-prop memo
// would never bail. The entries themselves keep stable references (mergeEntries
// reuses objects), so compare element-wise — and only the results this block's
// items actually read — letting untouched history blocks skip re-rendering on
// each stream event.
export const WorkBlock = React.memo(function WorkBlock({
  items,
  toolResults,
  live,
  onOpenSubagent,
}: Props) {
  const pathRoots = useToolPathRoots();
  // If any tool in the block returned media (image or video), keep the block
  // open so the screenshot/recording stays visible after the run finishes
  // (otherwise the user has to expand "Worked" then the tool to see what the
  // model showed them).
  const hasMedia = items.some((it) => {
    const r = it.toolUseId ? toolResults.get(it.toolUseId) : undefined;
    return (r?.images?.length ?? 0) > 0 || (r?.videos?.length ?? 0) > 0;
  });
  const [expanded, setExpanded] = useState(live || hasMedia);

  useEffect(() => {
    if (live || hasMedia) setExpanded(true);
  }, [live, hasMedia]);

  const duration = blockDuration(items, toolResults);
  const last = items[items.length - 1];
  const failures = items.filter(
    (it) => it.toolUseId && toolResults.get(it.toolUseId)?.isError
  ).length;

  return (
	<div className="mx-auto mb-3 w-full max-w-[var(--chat-col)]">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
		className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-1 py-1 text-left font-sans text-supporting text-dim transition-colors hover:bg-hover focus-ring"
      >
        <span
          className={cn(
            "flex-shrink-0 text-faint transition-transform duration-150",
            !expanded && "-rotate-90"
          )}
        >
          <IconChevronDown size={20} />
        </span>
        <span className={cn("flex-shrink-0 font-medium", live && "text-green")}>
          {live ? "Working" : "Worked"}
          {duration ? ` for ${duration}` : ""}
        </span>
        <span className="flex-shrink-0 text-faint">
          · {items.length} step{items.length === 1 ? "" : "s"}
        </span>
        {failures > 0 && !live && (
          <span className="flex-shrink-0 text-meta text-red/80">· {failures} failed</span>
        )}
        {!expanded && last && (
          <span className="min-w-0 truncate text-meta text-faint">
            {toolDisplayName(last.toolName)}:{" "}
            {toolSummary(last.toolName || "Tool", last.toolInput, last.content, pathRoots)}
          </span>
        )}
        {live && (
          <span className="ml-auto size-[10px] flex-shrink-0 animate-spin rounded-full border-2 border-green-soft border-t-green" />
        )}
      </button>

      {expanded && (
        <div className="mt-0.5">
          {items.map((entry) => (
            <ToolCallBlock
              key={entry.id}
              entry={entry}
              result={entry.toolUseId ? toolResults.get(entry.toolUseId) : undefined}
              pending={
                live &&
                !!entry.toolUseId &&
                !toolResults.has(entry.toolUseId)
              }
              onOpenSubagent={onOpenSubagent}
            />
          ))}
        </div>
      )}
    </div>
  );
}, workBlockPropsEqual);

function workBlockPropsEqual(prev: Props, next: Props): boolean {
  if (prev.live !== next.live) return false;
  if (prev.onOpenSubagent !== next.onOpenSubagent) return false;
  if (prev.items.length !== next.items.length) return false;
  for (let i = 0; i < next.items.length; i++) {
    if (prev.items[i] !== next.items[i]) return false;
    const id = next.items[i].toolUseId;
    if (id && prev.toolResults.get(id) !== next.toolResults.get(id))
      return false;
  }
  return true;
}

function blockDuration(
  items: TranscriptEntry[],
  toolResults: Map<string, TranscriptEntry>
): string | null {
  if (items.length === 0) return null;
  const first = new Date(items[0].timestamp).getTime();
  const lastItem = items[items.length - 1];
  const lastResult = lastItem.toolUseId ? toolResults.get(lastItem.toolUseId) : undefined;
  const last = new Date((lastResult || lastItem).timestamp).getTime();
  const secs = Math.round((last - first) / 1000);
  if (!isFinite(secs) || secs < 1) return null;
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}
