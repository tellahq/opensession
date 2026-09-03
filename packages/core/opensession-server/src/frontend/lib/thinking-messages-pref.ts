import type { TranscriptEntry } from "./types";
import { isLegacyReasoningHeading } from "./reasoning-display";
import * as UserPrefs from "./user-pref";

export type ThinkingMessagesPref = "none" | "latest" | "all";

const pref = UserPrefs.makeUserPref<ThinkingMessagesPref>({
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
 * A work-rail row where the model is thinking rather than talking. Work never
 * holds a turn's final answer, so a bold-only assistant row here is a legacy
 * reasoning heading, not a bold answer.
 */
export function isThinkingEntry(entry: TranscriptEntry): boolean {
  return (
    entry.type === "assistant" &&
    Boolean(entry.isReasoning || isLegacyReasoningHeading(entry.content))
  );
}

/**
 * Lay out the thinking rows of one turn's work rail.
 *
 * Thinking has two jobs. While the turn is live it is a status: what the
 * model is doing right now. A status belongs at the tail of the rail as one
 * row that is replaced in place and never sits above later steps. Once the
 * turn settles, thinking is a trace: why each step happened. A trace belongs
 * where it happened.
 *
 * - none: no thinking rows.
 * - latest: status only. The newest thought of a live turn follows its last
 *   step; a settled turn shows none.
 * - all: the trace. Every thought stays in transcript order.
 */
export function arrangeThinkingMessages(
  work: TranscriptEntry[],
  mode: ThinkingMessagesPref,
  live: boolean,
): TranscriptEntry[] {
  if (mode === "all") return work;
  const steps = work.filter((entry) => !isThinkingEntry(entry));
  if (mode === "none" || !live) return steps;
  const newest = work.findLast(isThinkingEntry);
  return newest ? [...steps, newest] : steps;
}
