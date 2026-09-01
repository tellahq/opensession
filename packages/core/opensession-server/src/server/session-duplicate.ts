import { replaceTranscriptEvents } from "./actor-transcript";
import { mergedSessionTranscriptAsync } from "./sessions";
import type { TranscriptEntry, UnifiedSession } from "./types";

interface DuplicateTranscriptDependencies {
  load(source: UnifiedSession): Promise<TranscriptEntry[]>;
  replace(sessionId: string, entries: TranscriptEntry[]): Promise<unknown>;
}

const dependencies: DuplicateTranscriptDependencies = {
  load: mergedSessionTranscriptAsync,
  replace: replaceTranscriptEvents,
};

type DuplicateContextSession = Pick<
  UnifiedSession,
  | "claudeSessionId"
  | "codexThreadId"
  | "piSessionId"
  | "duplicatedFromSessionId"
>;

/** Add the copied chat as engine context until the duplicate starts its first turn. */
export function duplicateContextSessionIds(
  session: DuplicateContextSession,
  explicitIds: readonly string[],
): string[] {
  const sourceId =
    !session.claudeSessionId && !session.codexThreadId && !session.piSessionId
      ? session.duplicatedFromSessionId
      : undefined;
  return [...new Set([...explicitIds, ...(sourceId ? [sourceId] : [])])];
}

/** Copy one known source chat into its newly created sibling session. */
export async function duplicateSessionTranscript(
  source: UnifiedSession,
  sessionId: string,
  deps: DuplicateTranscriptDependencies = dependencies,
): Promise<number> {
  const entries = await deps.load(source);
  if (entries.length) await deps.replace(sessionId, entries);
  return entries.length;
}
