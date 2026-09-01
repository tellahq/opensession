import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";

export interface SessionContextSnapshot {
  content: string;
  /** True only when the engine recorded its final effective system prompt and
   * active tool schemas, rather than the older partial audit sources. */
  exact: boolean;
  bytes: number;
  estimatedTokens: number;
}

function order(entries: TranscriptEntry[]): TranscriptEntry[] {
  return [...entries].sort((a, b) => {
    if (typeof a.seq === "number" && typeof b.seq === "number")
      return a.seq - b.seq;
    return Date.parse(a.timestamp) - Date.parse(b.timestamp);
  });
}

function snapshot(content: string, exact: boolean): SessionContextSnapshot {
  const bytes = Buffer.byteLength(content, "utf8");
  return {
    content,
    exact,
    bytes,
    // Provider tokenizers differ. This is intentionally labelled as an
    // estimate in the response and UI, but gives prompt growth a useful scale.
    estimatedTokens: Math.ceil(bytes / 4),
  };
}

/** Select the initial provider-input audit record. Sessions created before the
 * exact snapshot shipped fall back to the standing sources that were already
 * recorded, clearly marked partial rather than pretending to be complete. */
export function sessionContextSnapshot(
  entries: TranscriptEntry[],
): SessionContextSnapshot | null {
  const context = order(entries).filter((entry) => entry.contextInjection);
  const exact = context.find(
    (entry) => entry.contextInjection?.source === "session-start",
  );
  if (exact?.content) return snapshot(exact.content, true);

  const firstBySource = new Map<string, TranscriptEntry>();
  for (const entry of context) {
    const source = entry.contextInjection?.source;
    if (source && !firstBySource.has(source)) firstBySource.set(source, entry);
  }
  const sections: string[] = [];
  const add = (title: string, source: string) => {
    const content = firstBySource.get(source)?.content?.trim();
    if (content) sections.push(`# ${title}\n\n${content}`);
  };
  add("Open Session instructions", "instructions");
  add("Active tools", "mcp-servers");
  add("Tool policy", "tools");
  // Very old runners logged the repo and memory note without folding it into
  // an instructions record. Include it only in that compatibility case.
  if (!firstBySource.has("instructions"))
    add("Repository and memory context", "repos-note");
  return sections.length ? snapshot(sections.join("\n\n"), false) : null;
}
