import { describe, expect, test } from "bun:test";
import {
  duplicateContextSessionIds,
  duplicateSessionTranscript,
} from "./session-duplicate";
import type { TranscriptEntry, UnifiedSession } from "./types";

function entry(id: string, content: string): TranscriptEntry {
  return { id, type: "user", content, timestamp: "2026-09-01T09:00:00Z" };
}

describe("duplicateContextSessionIds", () => {
  test("uses the copied chat as context for the first turn", () => {
    expect(
      duplicateContextSessionIds(
        {
          claudeSessionId: null,
          duplicatedFromSessionId: "bks-source",
        },
        ["bks-attached"],
      ),
    ).toEqual(["bks-attached", "bks-source"]);
  });

  test("stops injecting it after an engine session exists", () => {
    expect(
      duplicateContextSessionIds(
        {
          claudeSessionId: "engine-session",
          duplicatedFromSessionId: "bks-source",
        },
        [],
      ),
    ).toEqual([]);
  });
});

describe("duplicateSessionTranscript", () => {
  test("copies the complete source chat into the sibling", async () => {
    const source = { id: "bks-source" } as UnifiedSession;
    const entries = [entry("one", "First"), entry("two", "Second")];
    const replacements: Array<{
      sessionId: string;
      entries: TranscriptEntry[];
    }> = [];

    const count = await duplicateSessionTranscript(source, "os-copy", {
      load: async (loaded) => {
        expect(loaded).toBe(source);
        return entries;
      },
      replace: async (sessionId, copied) => {
        replacements.push({ sessionId, entries: copied });
      },
    });

    expect(count).toBe(2);
    expect(replacements).toEqual([{ sessionId: "os-copy", entries }]);
  });

  test("does not create an empty transcript actor", async () => {
    let replacements = 0;
    const count = await duplicateSessionTranscript(
      { id: "bks-empty" } as UnifiedSession,
      "os-copy",
      {
        load: async () => [],
        replace: async () => {
          replacements++;
        },
      },
    );

    expect(count).toBe(0);
    expect(replacements).toBe(0);
  });
});
