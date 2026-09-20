import { mergedSessionTranscriptAsync } from "./sessions";
import type { TranscriptEntry, UnifiedSession } from "./types";

type DuplicateContextSession = Pick<
  UnifiedSession,
  | "id"
  | "claudeSessionId"
  | "codexThreadId"
  | "piSessionId"
  | "duplicatedFromSessionId"
>;

/** Use the duplicate's frozen chat, never later messages from the source. */
export function duplicateContextSessionIds(
  session: DuplicateContextSession,
  explicitIds: readonly string[],
): string[] {
  const needsCopiedContext =
    session.duplicatedFromSessionId &&
    !session.claudeSessionId &&
    !session.codexThreadId &&
    !session.piSessionId;
  return [
    ...new Set([
      ...explicitIds.filter((id) => id !== session.id),
      ...(needsCopiedContext ? [session.id] : []),
    ]),
  ];
}

/** Snapshot before creating the sibling. A missing boundary must not copy the tip. */
export async function readDuplicateSessionTranscript(
  source: UnifiedSession,
  messageId?: string,
  load: (
    source: UnifiedSession,
  ) => Promise<TranscriptEntry[]> = mergedSessionTranscriptAsync,
): Promise<TranscriptEntry[] | null> {
  const entries = await load(source);
  if (messageId === undefined) return entries;
  const index = entries.findIndex((entry) => entry.id === messageId);
  return index < 0 ? null : entries.slice(0, index + 1);
}
