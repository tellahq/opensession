import type { TranscriptEntry } from "./types";

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Build a compact one-line snippet around a visible transcript-text match. */
export function transcriptEntryMatchSnippet(
  entry: TranscriptEntry,
  query: string,
  context = 60,
): string | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const hay =
    entry.type === "tool_use" && entry.toolInput
      ? `${entry.content || ""}\n${safeStringify(entry.toolInput)}`
      : entry.content || "";
  const index = hay.toLowerCase().indexOf(needle);
  if (index < 0) return null;
  const start = Math.max(0, index - context);
  const end = Math.min(hay.length, index + needle.length + context);
  let snippet = hay.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < hay.length) snippet = `${snippet}…`;
  return snippet;
}
