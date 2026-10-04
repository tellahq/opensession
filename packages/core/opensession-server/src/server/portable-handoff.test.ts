import { describe, expect, it } from "bun:test";
import { HandoffBudgetError, selectPortableHandoff } from "./portable-handoff";
import type { TranscriptEntry } from "./types";
const entry = (
  id: string,
  type: TranscriptEntry["type"],
  content: string,
): TranscriptEntry => ({
  id,
  type,
  content,
  timestamp: "2026-01-01T00:00:00Z",
});

describe("portable handoff selection", () => {
  it("transfers short messages intact in order with markdown and partial answers", () => {
    const text = "## Plan\n\n```ts\n  const x = 1;\n```\n\nStill working...";
    const result = selectPortableHandoff({
      entries: [
        entry("u", "user", "Original request"),
        entry("a", "assistant", text),
      ],
    });
    expect(result).toContain(text);
    expect(result.indexOf("Original request")).toBeLessThan(
      result.indexOf(text),
    );
  });
  it("prioritizes original request and recent answers without clipping long items", () => {
    const result = selectPortableHandoff({
      sessionId: "example-session",
      maxBytes: 900,
      entries: [
        entry("u", "user", "Original request"),
        entry("long", "assistant", "X".repeat(3000)),
        entry("recent", "assistant", "Recent answer"),
      ],
    });
    expect(result).toContain("- User: Original request");
    expect(result).toContain("- Assistant: Recent answer");
    expect(result).toContain("Omitted assistant entry long");
    expect(result).not.toContain("- Assistant: XXX");
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(900);
    expect(result).toContain("read_session_transcript");
  });
  it("fails when references or an unshortenable current request cannot fit", () => {
    expect(() =>
      selectPortableHandoff({
        maxBytes: 10,
        entries: [entry("u", "user", "request")],
      }),
    ).toThrow(HandoffBudgetError);
    expect(() =>
      selectPortableHandoff({
        maxBytes: 700,
        requiredEntryId: "u",
        entries: [entry("u", "user", "request".repeat(1000))],
      }),
    ).toThrow(HandoffBudgetError);
  });
  it("reserves target capacity and charges UTF-8 bytes rather than characters", () => {
    const entries = [entry("u", "user", "😀".repeat(1000))];
    const result = selectPortableHandoff({ entries, maxBytes: 3000 });
    expect(result).toContain("Omitted user entry u");
    expect(() =>
      selectPortableHandoff({
        entries,
        contextWindow: 20_000,
        reservedBytes: 3900,
      }),
    ).toThrow(HandoffBudgetError);
  });
  it("filters context injections and reasoning", () => {
    const result = selectPortableHandoff({
      entries: [
        {
          ...entry("s", "system", "secret injection"),
          noticeKind: "context-injection",
        },
        { ...entry("r", "assistant", "reasoning"), isReasoning: true },
        entry("a", "assistant", "real work"),
      ],
    });
    expect(result).toContain("real work");
    expect(result).not.toContain("secret injection");
    expect(result).not.toContain("reasoning");
  });
  it("includes compact command outcomes and file edits, never raw output", () => {
    const result = selectPortableHandoff({
      entries: [
        {
          ...entry("c", "tool_use", "raw call"),
          toolUseId: "call",
          toolName: "bash",
          toolInput: { command: "bun test" },
        },
        {
          ...entry("r", "tool_result", "RAW OUTPUT\nexit code: 1"),
          toolUseId: "call",
          isError: true,
        },
        {
          ...entry("f", "tool_use", "raw patch"),
          toolName: "edit",
          toolInput: { path: "src/example.ts" },
        },
      ],
    });
    expect(result).toContain("Command: bun test; failed; exit 1");
    expect(result).toContain("File edited: src/example.ts");
    expect(result).not.toContain("RAW OUTPUT");
    expect(result).not.toContain("raw patch");
  });
});
