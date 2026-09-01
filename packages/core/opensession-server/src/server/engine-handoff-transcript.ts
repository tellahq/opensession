import type { TranscriptEntry } from "./types";

interface HandoffTranscriptRef {
  id?: string;
  transcriptPath: null;
  claudeSessionId: null;
}

type HandoffTranscriptLoader = (
  session: HandoffTranscriptRef,
) => Promise<TranscriptEntry[]>;

async function loadMergedTranscript(
  session: HandoffTranscriptRef,
): Promise<TranscriptEntry[]> {
  // Dynamic to avoid a module cycle: sessions.ts reads pi-transcript,
  // while the Pi runner reaches this helper through the same module graph.
  const { mergedSessionTranscriptAsync } = await import("./sessions");
  return mergedSessionTranscriptAsync(session);
}

/**
 * Recover the transcript for a fresh engine session that replaced an
 * unresumable Pi session (account/model shard rotation).
 *
 * The unified session id is important: post-mirror-retirement history lives in
 * transcript v2, not in per-engine JSONL files. mergedSessionTranscriptAsync
 * serves that store first and retains the legacy engine-store fallback.
 */
export async function recoverFreshEngineTranscript(
  input: {
    unifiedSessionId?: string;
    priorEngineSessionId: string;
    currentEntryId?: string;
  },
  loadTranscript: HandoffTranscriptLoader = loadMergedTranscript,
): Promise<TranscriptEntry[]> {
  const entries = await loadTranscript({
    id: input.unifiedSessionId,
    transcriptPath: null,
    claudeSessionId: null,
  });

  // Intake durability writes the current user prompt to transcript v2 before
  // account selection. The handoff describes history *before* that prompt;
  // the prompt itself is appended below the handoff by the runner.
  return input.currentEntryId
    ? entries.filter((entry) => entry.id !== input.currentEntryId)
    : entries;
}
