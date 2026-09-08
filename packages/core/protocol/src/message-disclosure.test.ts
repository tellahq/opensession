import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "./session";
import { assistantPhase, foldedAssistantIds } from "./message-disclosure";

function entry(
  id: string,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    id,
    type: "assistant",
    content: id,
    timestamp: "2026-09-08T10:00:00Z",
    ...extra,
  };
}
const progress = entry("progress", { assistantPhase: "commentary" });
const answer = entry("answer", { assistantPhase: "final_answer" });
const tool = entry("tool", { type: "tool_use" });

describe("assistant message disclosure", () => {
  test("preserves only recognized provider phases", () => {
    expect(assistantPhase("commentary")).toBe("commentary");
    expect(assistantPhase("final_answer")).toBe("final_answer");
    for (const value of [undefined, null, "final", {}, 1])
      expect(assistantPhase(value)).toBeUndefined();
  });
  test("a later tool or interrupted run cannot hide progress", () => {
    expect([...foldedAssistantIds([progress, tool])]).toEqual([]);
  });
  test("only an explicit subsequent answer supersedes progress", () => {
    expect([...foldedAssistantIds([progress, tool, entry("unknown")])]).toEqual(
      [],
    );
    expect([...foldedAssistantIds([progress, tool, answer])]).toEqual([
      "progress",
    ]);
  });
  test("answers and unclassified text survive subsequent work", () => {
    expect([
      ...foldedAssistantIds([
        answer,
        entry("unknown", { content: "**Important result**" }),
        tool,
      ]),
    ]).toEqual([]);
  });
  test("progress after an answer remains visible until another answer", () => {
    expect([...foldedAssistantIds([answer, progress, tool])]).toEqual([]);
  });
  test("an answer in another turn cannot supersede earlier progress", () => {
    for (const boundary of [
      entry("user", { type: "user" }),
      entry("system", { type: "system" }),
      entry("wake", { type: "user", turnBoundary: true }),
    ]) {
      expect([...foldedAssistantIds([progress, boundary, answer])]).toEqual([]);
    }
  });
  test("shared media and errors stay visible even in commentary", () => {
    for (const extra of [
      { images: ["/image.png"] },
      { videos: ["/video.mp4"] },
      { files: [{ name: "report.md", path: "/report.md" }] },
      { isError: true },
    ]) {
      expect([
        ...foldedAssistantIds([{ ...progress, ...extra }, tool, answer]),
      ]).toEqual([]);
    }
  });
  test("reasoning remains work, regardless of text phase", () => {
    expect([
      ...foldedAssistantIds([
        entry("thinking", {
          isReasoning: true,
          assistantPhase: "final_answer",
        }),
        progress,
        tool,
      ]),
    ]).toEqual(["thinking"]);
  });
});
