import type { TranscriptEntry } from "./types";
import { isLegacyReasoningHeading } from "./reasoning-display";
import { makeUserPref } from "./user-pref";

export type ThinkingMessagesPref = "none" | "latest" | "all";

const pref = makeUserPref<ThinkingMessagesPref>({
  localKey: "opensession-thinking-messages",
  prefKey: "thinking-messages",
  changeEvent: "opensession-thinking-messages-changed",
  defaultValue: "latest",
  decode: (value) =>
    value === "none" || value === "latest" || value === "all" ? value : null,
  encode: (value) => value,
});

export const getThinkingMessagesPref = pref.get;
export const setThinkingMessagesPref = pref.set;
export const onThinkingMessagesChanged = pref.onChanged;

/**
 * Find reasoning rows using the same turn boundary rule as TranscriptBlocks.
 * A legacy bold-only assistant row counts only after a later turn item proves
 * it was an intermediate update, so a bold final answer stays an answer.
 */
export function thinkingMessageEntryIds(
  entries: TranscriptEntry[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  let turn: TranscriptEntry[] = [];

  function flushTurn() {
    const last = turn[turn.length - 1];
    const finalId =
      last?.type === "assistant" && !last.isReasoning ? last.id : null;
    for (const entry of turn) {
      if (
        entry.type === "assistant" &&
        (entry.isReasoning ||
          (entry.id !== finalId && isLegacyReasoningHeading(entry.content)))
      ) {
        ids.add(entry.id);
      }
    }
    turn = [];
  }

  for (const entry of entries) {
    if (entry.type === "tool_result") continue;
    if (entry.type === "assistant" || entry.type === "tool_use") {
      turn.push(entry);
    } else {
      flushTurn();
    }
  }
  flushTurn();
  return ids;
}

export interface ThinkingMessageVisibility {
  mode: ThinkingMessagesPref;
  entryIds: ReadonlySet<string>;
  latestId: string | null;
}

export function thinkingMessageVisibility(
  entries: TranscriptEntry[],
  mode: ThinkingMessagesPref,
): ThinkingMessageVisibility {
  const entryIds = thinkingMessageEntryIds(entries);
  return {
    mode,
    entryIds,
    latestId: Array.from(entryIds).at(-1) ?? null,
  };
}

export function thinkingMessageIsVisible(
  entry: TranscriptEntry,
  visibility: ThinkingMessageVisibility | undefined,
): boolean {
  if (!visibility?.entryIds.has(entry.id)) return true;
  if (visibility.mode === "all") return true;
  return visibility.mode === "latest" && entry.id === visibility.latestId;
}
