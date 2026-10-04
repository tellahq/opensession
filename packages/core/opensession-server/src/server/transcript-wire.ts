import type { TranscriptEntry } from "./types";
import type { SeqEntry } from "./transcript-store";
import {
  MESSAGE_COLLAPSE_CHARS,
  MESSAGE_PREVIEW_CHARS,
} from "../shared/message-preview";

/** Match the web's preview, allowing near-limit messages through in full. */
export const INIT_MESSAGE_CLAMP_BYTES = MESSAGE_PREVIEW_CHARS;
/** Tool results open folded and hydrate from the full-entry endpoint when a
 * reader expands them. The opening frame only needs a compact preview. */
export const INIT_TOOL_RESULT_CLAMP_BYTES = 256;
/** Intermediate assistant notes live inside a closed work turn. Most are a
 * paragraph or two of narration, so 4,000 characters ships nearly all of them
 * whole; anything longer loads through the entry endpoint when requested. */
export const INIT_COLLAPSED_MESSAGE_CLAMP_BYTES = 4_000;
/** Skip the clamp when it would hide less than 20% of a folded note, the
 * same rule MESSAGE_COLLAPSE_CHARS applies to visible messages. */
export const INIT_COLLAPSED_MESSAGE_COLLAPSE_BYTES =
  INIT_COLLAPSED_MESSAGE_CLAMP_BYTES / 0.8;

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
      : MESSAGE_COLLAPSE_CHARS;
  return Math.min(storedBytes, wireBudget);
}

function initClampBytes(entry: SeqEntry, foldedAssistant: boolean): number {
  if (entry.type === "tool_result") return INIT_TOOL_RESULT_CLAMP_BYTES;
  if (foldedAssistant)
    return nearLimitClamp(
      entry,
      INIT_COLLAPSED_MESSAGE_CLAMP_BYTES,
      INIT_COLLAPSED_MESSAGE_COLLAPSE_BYTES,
    );
  return nearLimitClamp(
    entry,
    INIT_MESSAGE_CLAMP_BYTES,
    MESSAGE_COLLAPSE_CHARS,
  );
}

/** Content just past the preview goes through whole rather than losing a
 * short tail behind an expander. */
function nearLimitClamp(
  entry: SeqEntry,
  preview: number,
  collapseAt: number,
): number {
  return entry.content.length < collapseAt ? collapseAt : preview;
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

/** The backwards history wire frame, shared by paging and its budget tests. */
export const TRANSCRIPT_HISTORY_MAX_ENTRIES = 200;
export function transcriptHistoryLimit(limit = 40): number {
  return Number.isFinite(limit)
    ? Math.min(Math.max(1, Math.floor(limit)), TRANSCRIPT_HISTORY_MAX_ENTRIES)
    : 40;
}
export function transcriptHistoryFrame(
  sessionId: string,
  page: { entries: SeqEntry[]; firstSeq: number; lastSeq: number },
) {
  return {
    type: "transcript_history" as const,
    sessionId,
    entries: clampV2InitEntries(page.entries),
    firstSeq: page.firstSeq,
    lastSeq: page.lastSeq,
    truncated: page.firstSeq > 1,
    v2: true,
  };
}

/** Live tool previews hydrate from the same durable entry endpoint after commit.
 * Never repeat large file bodies or base64 images in transient feed frames. */
export const LIVE_TOOL_INPUT_MAX_BYTES = 4096;
export function liveToolEntryForWire(entry: TranscriptEntry): TranscriptEntry {
  const projected = { ...entry };
  if (
    entry.type === "tool_result" &&
    entry.content.length > INIT_TOOL_RESULT_CLAMP_BYTES
  ) {
    projected.content = entry.content.slice(0, INIT_TOOL_RESULT_CLAMP_BYTES);
    projected.contentClamped = true;
    projected.contentLength = entry.contentLength ?? entry.content.length;
  }
  if (entry.toolInput !== undefined) {
    const byteSize = Buffer.byteLength(JSON.stringify(entry.toolInput));
    if (byteSize > LIVE_TOOL_INPUT_MAX_BYTES)
      projected.toolInput = {
        toolName: entry.toolName ?? "",
        byteSize,
        keys:
          typeof entry.toolInput === "object" && entry.toolInput !== null
            ? Object.keys(entry.toolInput).slice(0, 50)
            : [],
      };
  }
  if (entry.images)
    projected.images = entry.images.map((source, index) =>
      source.startsWith("data:") ? `os-blob:${entry.id}/${index}` : source,
    );
  return projected;
}
