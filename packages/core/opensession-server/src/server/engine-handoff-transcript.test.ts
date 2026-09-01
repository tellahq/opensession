import { describe, expect, test } from "bun:test";
import { recoverFreshEngineTranscript } from "./engine-handoff-transcript";
import type { TranscriptEntry } from "./types";

const entry = (
  id: string,
  type: TranscriptEntry["type"],
  content: string,
): TranscriptEntry => ({
  id,
  type,
  content,
  timestamp: "2026-07-28T08:38:25.000Z",
});

describe("recoverFreshEngineTranscript", () => {
  test("loads unified transcript-v2 history after an account-shard rotation", async () => {
    const seen: unknown[] = [];
    const recovered = await recoverFreshEngineTranscript(
      {
        unifiedSessionId: "bks-history",
        priorEngineSessionId: "ses_old_shard",
        currentEntryId: "prompt-current",
      },
      async (ref) => {
        seen.push(ref);
        return [
          entry("prompt-old", "user", "implement the fix"),
          entry("reply-old", "assistant", "I mapped the transition sites"),
          entry("prompt-current", "user", "continue"),
        ];
      },
    );

    expect(seen).toEqual([
      {
        id: "bks-history",
        transcriptPath: null,
        claudeSessionId: null,
      },
    ]);
    expect(recovered.map((item) => item.id)).toEqual([
      "prompt-old",
      "reply-old",
    ]);
  });

  test("keeps legacy engine lookup available when there is no unified id", async () => {
    const recovered = await recoverFreshEngineTranscript(
      { priorEngineSessionId: "ses_legacy" },
      async (ref) => {
        expect(ref.id).toBeUndefined();
        return [entry("old", "assistant", "legacy history")];
      },
    );

    expect(recovered).toHaveLength(1);
  });
});
