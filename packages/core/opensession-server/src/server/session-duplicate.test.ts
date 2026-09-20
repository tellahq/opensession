import { describe, expect, test } from "bun:test";
import {
  duplicateContextSessionIds,
  readDuplicateSessionTranscript,
} from "./session-duplicate";
import type { TranscriptEntry, UnifiedSession } from "./types";

function entry(id: string, content: string): TranscriptEntry {
  return { id, type: "assistant", content, timestamp: "2026-09-01T09:00:00Z" };
}

const duplicate = {
  id: "os-copy",
  claudeSessionId: null,
  duplicatedFromSessionId: "bks-source",
};

describe("duplicateContextSessionIds", () => {
  test("uses its frozen copied chat, not the live source, for the first turn", () => {
    expect(
      duplicateContextSessionIds(duplicate, ["bks-attached", "os-copy"]),
    ).toEqual(["bks-attached", "os-copy"]);
  });

  test.each([
    { claudeSessionId: "engine-session" },
    { codexThreadId: "engine-session" },
    { piSessionId: "engine-session" },
  ])("stops injecting it after an engine session exists: %j", (engine) => {
    expect(
      duplicateContextSessionIds({ ...duplicate, ...engine }, ["os-copy"]),
    ).toEqual([]);
  });

  test("ordinary sessions cannot attach themselves", () => {
    expect(
      duplicateContextSessionIds({ id: "os-session", claudeSessionId: null }, [
        "os-session",
        "other",
        "other",
      ]),
    ).toEqual(["other"]);
  });
});

describe("readDuplicateSessionTranscript", () => {
  const source = { id: "bks-source" } as UnifiedSession;
  const entries = [
    entry("one", "First"),
    entry("two", "Second"),
    entry("three", "Later"),
  ];
  const load = async (loaded: UnifiedSession) => {
    expect(loaded).toBe(source);
    return entries;
  };

  test("copies the complete source chat at the tip", async () => {
    expect(
      await readDuplicateSessionTranscript(source, undefined, load),
    ).toEqual(entries);
  });

  test("copies through the selected message, excluding later turns", async () => {
    expect(await readDuplicateSessionTranscript(source, "two", load)).toEqual(
      entries.slice(0, 2),
    );
    expect(await readDuplicateSessionTranscript(source, "one", load)).toEqual(
      entries.slice(0, 1),
    );
    expect(entries).toHaveLength(3);
  });

  test("rejects a missing boundary instead of silently copying the full chat", async () => {
    expect(
      await readDuplicateSessionTranscript(source, "missing", load),
    ).toBeNull();
  });

  test("allows an empty tip but not a missing message in an empty source", async () => {
    expect(
      await readDuplicateSessionTranscript(source, undefined, async () => []),
    ).toEqual([]);
    expect(
      await readDuplicateSessionTranscript(source, "missing", async () => []),
    ).toBeNull();
  });
});
