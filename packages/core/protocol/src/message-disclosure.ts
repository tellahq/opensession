import type { TranscriptEntry } from "./session";

export function assistantPhase(
  value: unknown,
): TranscriptEntry["assistantPhase"] {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

/** Only explicit progress superseded by an answer may fold. A later tool,
 * cancellation, or conversation boundary is not evidence of an answer.
 * Untagged history remains readable, including short or heading-only replies. */
export function foldedAssistantIds(
  entries: readonly TranscriptEntry[],
): ReadonlySet<string> {
  const folded = new Set<string>();
  let answered = false;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type === "user" || entry.type === "system") {
      answered = false;
    } else if (entry.type === "assistant") {
      if (entry.isReasoning) {
        folded.add(entry.id);
      } else if (entry.assistantPhase === "final_answer") {
        answered = true;
      } else if (
        answered &&
        entry.assistantPhase === "commentary" &&
        !entry.ask &&
        !entry.notice &&
        !entry.isError &&
        !entry.images?.length &&
        !entry.videos?.length &&
        !entry.files?.length
      ) {
        folded.add(entry.id);
      }
    }
  }
  return folded;
}
