import type { SessionWalkthrough, TranscriptEntry } from "../lib/types";

interface PlacementBlock {
  kind: string;
  entry?: TranscriptEntry;
  items?: TranscriptEntry[];
}

/** The publish_walkthrough tool call, whatever the engine named it. Only
 *  needed for walkthroughs published before the server recorded the entry id
 *  (see SessionWalkthrough.publishedEntryId). */
function isWalkthroughPublish(entry: TranscriptEntry): boolean {
  return (
    entry.type === "tool_use" &&
    /(^|_)publish_walkthrough$/.test(entry.toolName || "")
  );
}

/** Past the rest of the publishing turn: its answer, and the meta footer. */
function afterPublishingTurn(blocks: PlacementBlock[], at: number): number {
  let index = at + 1;
  while (
    index < blocks.length &&
    (blocks[index].kind === "footer" ||
      (blocks[index].kind === "entry" &&
        blocks[index].entry?.type === "assistant"))
  )
    index++;
  return index;
}

/**
 * Where the walkthrough card goes: directly after the turn that published it.
 *
 * The server records that turn's entry id at publish time (`publishedEntryId`)
 * because that is the only moment anything knows it — so the normal path here
 * is a lookup, not a guess. The scan and the timestamp fallback below exist
 * for walkthroughs published before that field, and for the case where the
 * publishing call has been trimmed out of the loaded window.
 */
export function walkthroughInsertIndex(
  blocks: PlacementBlock[],
  walkthrough: SessionWalkthrough,
): number {
  const anchor = walkthrough.publishedEntryId;
  if (anchor) {
    const at = blocks.findIndex((block) =>
      block.kind === "turn"
        ? block.items?.some((e) => e.id === anchor)
        : block.entry?.id === anchor,
    );
    if (at !== -1) return afterPublishingTurn(blocks, at);
  }

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    const hasPublish =
      block.kind === "turn"
        ? block.items?.some(isWalkthroughPublish)
        : block.kind === "entry" && block.entry
          ? isWalkthroughPublish(block.entry)
          : false;
    if (hasPublish) return afterPublishingTurn(blocks, i);
  }

  // Nothing to anchor to: keep it above any turn that came after it.
  const publishedTime = new Date(walkthrough.publishedAt).getTime();
  if (!Number.isFinite(publishedTime)) return blocks.length;
  const firstTimedBlock = blocks.findIndex((block) => {
    const entry = block.entry || block.items?.[0];
    return entry && Number.isFinite(new Date(entry.timestamp).getTime());
  });
  if (firstTimedBlock !== -1) {
    const entry =
      blocks[firstTimedBlock].entry || blocks[firstTimedBlock].items?.[0];
    if (entry && new Date(entry.timestamp).getTime() > publishedTime)
      return firstTimedBlock;
  }
  const nextTurn = blocks.findIndex(
    (block) =>
      block.kind === "entry" &&
      (block.entry?.type === "user" || block.entry?.type === "system") &&
      new Date(block.entry.timestamp).getTime() > publishedTime,
  );
  return nextTurn === -1 ? blocks.length : nextTurn;
}
