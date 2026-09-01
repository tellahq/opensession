import { INIT_WIRE_CLAMP_BYTES } from "./jsonl-parser";
import type { SeqEntry } from "./transcript-store";

/**
 * Tool results open folded and hydrate from the full-entry endpoint when a
 * reader expands them. The opening frame therefore carries a compact preview;
 * messages keep the established 8 KB preview because they render in place.
 */
export const INIT_TOOL_RESULT_CLAMP_BYTES = 512;
/** Intermediate assistant notes live inside a closed work turn. Their full
 *  text loads through the existing entry endpoint only when requested. */
export const INIT_COLLAPSED_MESSAGE_CLAMP_BYTES = 512;

/**
 * Clamp an opening snapshot or history page without changing live appends.
 * Keeping the original content length lets every client offer full hydration.
 */
export function clampV2InitEntries(entries: SeqEntry[]): SeqEntry[] {
  const foldedAssistants = foldedAssistantIndexes(entries);
  if (
    !entries.some(
      (entry, index) =>
        entry.content.length >
        initClampBytes(entry, foldedAssistants.has(index)),
    )
  ) {
    return entries;
  }
  return entries.map((entry, index) => {
    const max = initClampBytes(entry, foldedAssistants.has(index));
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
      : INIT_WIRE_CLAMP_BYTES;
  return Math.min(storedBytes, wireBudget);
}

function initClampBytes(entry: SeqEntry, foldedAssistant: boolean): number {
  if (entry.type === "tool_result") return INIT_TOOL_RESULT_CLAMP_BYTES;
  if (foldedAssistant) return INIT_COLLAPSED_MESSAGE_CLAMP_BYTES;
  return INIT_WIRE_CLAMP_BYTES;
}

/** Assistant notes hidden by TranscriptBlocks' default work fold. */
function foldedAssistantIndexes(entries: SeqEntry[]): Set<number> {
  const folded = new Set<number>();
  let start = 0;
  const finishTurn = (end: number) => {
    let hasTool = false;
    let lastTurnItem = -1;
    for (let index = start; index < end; index++) {
      const type = entries[index]?.type;
      if (type === "tool_use") hasTool = true;
      if (type === "assistant" || type === "tool_use") lastTurnItem = index;
    }
    if (!hasTool) return;
    const finalAssistant =
      lastTurnItem >= start && entries[lastTurnItem]?.type === "assistant"
        ? lastTurnItem
        : -1;
    for (let index = start; index < end; index++) {
      if (entries[index]?.type === "assistant" && index !== finalAssistant)
        folded.add(index);
    }
  };

  for (let index = 0; index < entries.length; index++) {
    const type = entries[index]?.type;
    if (type === "user" || type === "system") {
      finishTurn(index);
      start = index + 1;
    }
  }
  finishTurn(entries.length);
  return folded;
}
