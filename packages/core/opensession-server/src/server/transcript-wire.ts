import { foldedAssistantIds } from "@tellahq/opensession-protocol/message-disclosure";
import type { SeqEntry } from "./transcript-store";

/** The web renders at most 6,000 characters of a message before its expander,
 * so sending more in an opening frame only consumes transfer and parse work. */
export const INIT_MESSAGE_CLAMP_BYTES = 6_000;
/** Tool results open folded and hydrate from the full-entry endpoint when a
 * reader expands them. The opening frame only needs a compact preview. */
export const INIT_TOOL_RESULT_CLAMP_BYTES = 256;
/** Explicit progress superseded by an answer lives inside a work turn. Its full
 * text loads through the existing entry endpoint only when requested. */
export const INIT_COLLAPSED_MESSAGE_CLAMP_BYTES = 256;

/**
 * Clamp an opening snapshot or history page without changing live appends.
 * Keeping the original content length lets every client offer full hydration.
 */
export function clampV2InitEntries(entries: SeqEntry[]): SeqEntry[] {
  const foldedAssistants = foldedAssistantIds(entries);
  if (
    !entries.some(
      (entry) =>
        entry.content.length >
        initClampBytes(entry, foldedAssistants.has(entry.id)),
    )
  ) {
    return entries;
  }
  return entries.map((entry) => {
    const max = initClampBytes(entry, foldedAssistants.has(entry.id));
    return entry.content.length <= max
      ? entry
      : {
          ...entry,
          content: entry.content.slice(0, max),
          contentClamped: true,
          contentLength: entry.contentLength ?? entry.content.length,
        };
  });
}

/**
 * Estimate a stored row's cost after clampV2InitEntries. Tool results get 512
 * bytes of headroom above their content preview for identifiers and metadata.
 */
export function v2SnapshotEntryWeight(
  kind: string,
  storedBytes: number,
): number {
  const wireBudget =
    kind === "tool_result"
      ? INIT_TOOL_RESULT_CLAMP_BYTES + 512
      : INIT_MESSAGE_CLAMP_BYTES;
  return Math.min(storedBytes, wireBudget);
}

function initClampBytes(entry: SeqEntry, foldedAssistant: boolean): number {
  if (entry.type === "tool_result") return INIT_TOOL_RESULT_CLAMP_BYTES;
  if (foldedAssistant) return INIT_COLLAPSED_MESSAGE_CLAMP_BYTES;
  return INIT_MESSAGE_CLAMP_BYTES;
}
