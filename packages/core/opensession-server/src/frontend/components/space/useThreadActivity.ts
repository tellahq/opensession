import { useEffect, useState } from "react";
import { fetchTranscript } from "../../lib/api/sessions";
import type { TranscriptEntry } from "../../lib/types";
import { toolSummary } from "../ToolCallBlock";

/** How often a working thread's card re-reads its latest step. */
const POLL_MS = 5_000;

/**
 * What a working thread is doing right now, in one line: its latest tool
 * call ("Editing checkout.ts") or, between calls, the start of what it last
 * wrote. Null while the thread is not working or before the first read.
 * Reads the thread's last few transcript entries, only while it works and
 * the page is visible.
 */
export function useThreadActivity(
  threadId: string,
  working: boolean,
): string | null {
  const [activity, setActivity] = useState<{ id: string; text: string }>();
  useEffect(() => {
    if (!working) return;
    let live = true;
    const read = () => {
      if (document.visibilityState !== "visible") return;
      void fetchTranscript(threadId, 8)
        .then((entries) => {
          const text = latestStep(entries);
          if (live && text) setActivity({ id: threadId, text });
        })
        .catch(() => {});
    };
    read();
    const timer = window.setInterval(read, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [threadId, working]);
  return working && activity?.id === threadId ? activity.text : null;
}

export function latestStep(entries: TranscriptEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type === "tool_use" && entry.toolName) {
      const text = toolSummary(
        entry.toolName,
        entry.toolInput,
        `Using ${entry.toolName}`,
      );
      if (text) return text;
    }
    if (entry.type === "assistant" && entry.content.trim()) {
      const line = entry.content
        .trim()
        .split("\n")[0]!
        .replace(/[#*`_]/g, "");
      return line.length > 120 ? `${line.slice(0, 119)}…` : line;
    }
  }
  return null;
}
