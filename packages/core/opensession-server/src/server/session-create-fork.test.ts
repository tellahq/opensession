import { afterEach, describe, expect, test } from "bun:test";
import {
  appendTranscriptEvents,
  deleteSessionTranscript,
} from "./actor-transcript";
import { forkHandoffContext } from "./session-create";
import type { UnifiedSession } from "./types";

const sessionIds = new Set<string>();

afterEach(async () => {
  await Promise.all([...sessionIds].map(deleteSessionTranscript));
  sessionIds.clear();
});

function sourceSession(id: string): UnifiedSession {
  return {
    id,
    claudeSessionId: null,
    source: "opensession",
    branch: null,
    worktreeDir: null,
    startedBy: "Ada",
    title: "Investigate native forking",
    lastActivity: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    isRunning: false,
    transcriptPath: null,
    model: "pi/openai/gpt-5.6-sol",
  };
}

describe("forkHandoffContext", () => {
  test("loads actor-owned transcript context when no legacy transcript path exists", async () => {
    const source = sourceSession("os-fork-context-actor");
    sessionIds.add(source.id);
    await appendTranscriptEvents(source.id, [
      {
        id: "user-1",
        type: "user",
        content: "Keep the native composer state visible.",
        timestamp: "2026-09-01T00:00:01.000Z",
      },
      {
        id: "assistant-1",
        type: "assistant",
        content: "The fork state belongs above the input field.",
        timestamp: "2026-09-01T00:00:02.000Z",
      },
    ]);

    const handoff = await forkHandoffContext({
      source,
      canFork: false,
      needsHandoff: true,
    });

    expect(handoff).toContain("Keep the native composer state visible.");
    expect(handoff).toContain("The fork state belongs above the input field.");
  });
});
