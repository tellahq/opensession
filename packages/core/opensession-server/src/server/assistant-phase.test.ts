import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piMessagePhase } from "./pi-message-phase";
import { piAssistantTranscriptEntries } from "./pi-runner";
import { readPiNativeTranscript } from "./pi-native-transcript";
import { transcriptLineForEntry } from "./transcript-persistence";
import { parseJsonlLines } from "./jsonl-parser";

const content = [
  { type: "thinking", thinking: "Compare the samples" },
  {
    type: "text",
    text: "I will compare grain and alignment.",
    textSignature: JSON.stringify({ v: 1, id: "msg_1", phase: "commentary" }),
  },
  {
    type: "text",
    text: "The grain size now matches.",
    textSignature: JSON.stringify({ v: 1, id: "msg_2", phase: "final_answer" }),
  },
  { type: "text", text: "Legacy response" },
];

describe("assistant phases through transcript ingestion", () => {
  test("reads only valid versioned Pi text signatures", () => {
    expect(piMessagePhase(content[1].textSignature)).toBe("commentary");
    for (const value of [
      undefined,
      "opaque",
      "{",
      "null",
      JSON.stringify({ v: 2, id: "x", phase: "final_answer" }),
      JSON.stringify({ v: 1, phase: "final_answer" }),
      JSON.stringify({ v: 1, id: "x", phase: "unknown" }),
    ]) {
      expect(piMessagePhase(value)).toBeUndefined();
    }
  });
  test("preserves live Pi phases through JSONL normalization", () => {
    const entries = piAssistantTranscriptEntries(
      content,
      "2026-09-08T10:00:00Z",
      "test-model",
      "message",
    );
    expect(entries.map((entry) => entry.assistantPhase)).toEqual([
      undefined,
      "commentary",
      "final_answer",
      undefined,
    ]);
    const lines = entries
      .map(transcriptLineForEntry)
      .map((line) => JSON.stringify(line));
    const restored = parseJsonlLines(lines);
    expect(restored.map((entry) => entry.assistantPhase)).toEqual(
      entries.map((entry) => entry.assistantPhase),
    );
    expect(restored[0].isReasoning).toBe(true);
  });
  test("native Pi transcript replay preserves the same phases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "os-assistant-phase-"));
    try {
      const path = join(dir, "session.jsonl");
      await writeFile(
        path,
        JSON.stringify({
          type: "message",
          id: "m",
          timestamp: "2026-09-08T10:00:00Z",
          message: { role: "assistant", content },
        }),
      );
      expect(
        readPiNativeTranscript(path).map((entry) => entry.assistantPhase),
      ).toEqual([undefined, "commentary", "final_answer", undefined]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
