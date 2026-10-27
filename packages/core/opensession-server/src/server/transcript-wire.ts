import type { SeqEntry } from "./transcript-store";
import {
  htmlRenderResultObjects,
  isHtmlRenderResultText,
} from "@tellahq/opensession-protocol/html-render";
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
          content: clampedContent(entry, max),
          contentClamped: true,
          contentLength: entry.contentLength ?? entry.content.length,
        };
  });
}

/**
 * A clamped entry's preview. A tool result that showed a page with
 * html_render from inside a longer answer (a codemode script's report around
 * the tool's JSON) keeps each `{"htmlRender": …}` object after the preview:
 * clients show the page under the turn from that reference without
 * expanding the step, so cutting it off hid the page.
 */
function clampedContent(entry: SeqEntry, max: number): string {
  const preview = entry.content.slice(0, max);
  if (entry.type !== "tool_result") return preview;
  const renders = htmlRenderResultObjects(entry.content).filter(
    (object) => !preview.includes(object),
  );
  return renders.length ? `${preview}\n${renders.join("\n")}` : preview;
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
  if (entry.type === "tool_result") {
    // An html_render result is the page's reference, shown under the turn
    // without expanding anything, so it ships whole (it is a few hundred
    // bytes, and the check caps it).
    if (isHtmlRenderResultText(entry.content)) return entry.content.length;
    return INIT_TOOL_RESULT_CLAMP_BYTES;
  }
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
