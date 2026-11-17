import { describe, expect, test } from "bun:test";
import type {
  TranscriptEntry,
  TranscriptIndexEntry,
} from "@tellahq/opensession-protocol/session";
import {
  collectProgressUpdates,
  parseProgressUpdate,
} from "./progress-updates";

const entry = (
  id: string,
  content: string,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry => ({
  id,
  type: "assistant",
  content,
  timestamp: "2026-01-01T00:00:00Z",
  ...extra,
});
const wake = (id: string) =>
  entry(id, "", { type: "user", turnBoundary: true });

describe("explicit progress updates", () => {
  test("parses readable Markdown without guessing a verdict", () => {
    expect(parseProgressUpdate(entry("a", "◷ **CI**: Running"))).toEqual({
      topic: "CI",
      state: "running",
      text: "Running",
    });
    expect(
      parseProgressUpdate(entry("a", "✓ **CI**: All checks passed"))?.state,
    ).toBe("done");
    for (const content of [
      "All checks passed",
      "✓ Merge resolved",
      "✓ **CI**: Passed\nPreview remains unverified.",
      "✓ **CI**: Passed\n\nApprove the merge?",
      "```\n✓ **CI**: Passed\n```",
      "! **CI**: Failed",
      "✓ ** **: Passed",
      "✓ **CI**: Passed. Should I merge?",
    ]) {
      expect(parseProgressUpdate(entry("a", content))).toBeNull();
    }
  });

  test("never folds reasoning, user text, errors, attachments or clamped content", () => {
    for (const extra of [
      { type: "user" as const },
      { isReasoning: true },
      { isError: true },
      { contentClamped: true },
      { contentLength: 1000 },
      { images: ["/image.png"] },
      { videos: ["/video.mp4"] },
      { files: [{ name: "report.txt", path: "/report.txt" }] },
      { pastedTexts: ["details"] },
    ]) {
      expect(
        parseProgressUpdate(entry("a", "✓ **CI**: Passed", extra)),
      ).toBeNull();
    }
  });

  test("replaces the label at the first row while retaining every update", () => {
    const first = entry("a", "◷ **CI**: Running");
    const last = entry("b", "✓ **CI**: All checks passed");
    const groups = collectProgressUpdates([first, wake("wake"), last]);
    expect(groups.get("a")).toEqual({
      latest: { topic: "CI", state: "done", text: "All checks passed" },
      entries: [first, last],
    });
    expect(groups.has("b")).toBe(true);
    expect(groups.get("b")).toBeNull();
  });

  test("a new human request starts a fresh row, even for the same topic", () => {
    const groups = collectProgressUpdates([
      entry("a", "✓ **CI**: Passed"),
      entry("user", "Make another change", { type: "user" }),
      entry("b", "◷ **CI**: Running"),
    ]);
    expect(groups.get("a")?.entries).toHaveLength(1);
    expect(groups.get("b")?.entries).toHaveLength(1);
  });

  test("keeps separate topics and resets at team notes", () => {
    const groups = collectProgressUpdates(
      [
        entry("a", "◷ **CI**: Running"),
        wake("start-build"),
        entry("b", "◷ **Build**: Running"),
        wake("w"),
        entry("c", "✓ **CI**: Passed", { timestamp: "2026-01-01T00:02:00Z" }),
      ],
      [],
      [Date.parse("2026-01-01T00:01:00Z")],
    );
    expect([...groups.values()].every(Boolean)).toBe(true);
  });

  test("unloaded user boundaries in the outline prevent cross-task merging", () => {
    const index: TranscriptIndexEntry[] = [
      {
        id: "a",
        seq: 1,
        changeSeq: 1,
        role: "assistant",
        contentLength: 20,
        timestampMs: 0,
      },
      {
        id: "unloaded-user",
        seq: 2,
        changeSeq: 2,
        role: "user",
        contentLength: 20,
        timestampMs: 0,
      },
      {
        id: "b",
        seq: 3,
        changeSeq: 3,
        role: "assistant",
        contentLength: 20,
        timestampMs: 0,
      },
    ];
    const groups = collectProgressUpdates(
      [
        entry("a", "✓ **CI**: Passed", { seq: 1 }),
        entry("b", "◷ **CI**: Running", { seq: 3 }),
      ],
      index,
    );
    expect(groups.get("a")?.entries).toHaveLength(1);
    expect(groups.get("b")?.entries).toHaveLength(1);
  });

  test("does not use intermediate narration as a hidden anchor", () => {
    const groups = collectProgressUpdates([
      entry("a", "◷ **CI**: Running"),
      entry("tool", "", { type: "tool_use" }),
      entry("b", "✓ **CI**: Passed"),
    ]);
    expect(groups.has("a")).toBe(false);
    expect(groups.get("b")?.entries).toHaveLength(1);
  });
});
