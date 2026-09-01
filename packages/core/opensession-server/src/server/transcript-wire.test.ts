import { describe, expect, test } from "bun:test";
import type { SeqEntry } from "./transcript-store";
import {
  clampV2InitEntries,
  INIT_COLLAPSED_MESSAGE_CLAMP_BYTES,
  INIT_TOOL_RESULT_CLAMP_BYTES,
  v2SnapshotEntryWeight,
} from "./transcript-wire";

function entry(
  id: string,
  type: SeqEntry["type"],
  content: string,
  extra: Partial<SeqEntry> = {},
): SeqEntry {
  return {
    id,
    type,
    content,
    timestamp: "2026-08-20T12:00:00.000Z",
    seq: 1,
    changeSeq: 1,
    ...extra,
  };
}

describe("v2 transcript wire previews", () => {
  test("clamps folded tool results more tightly than visible messages", () => {
    const assistant = entry("a", "assistant", "a".repeat(3_000));
    const result = entry("r", "tool_result", "r".repeat(3_000), {
      contentLength: 9_000,
    });

    const clamped = clampV2InitEntries([assistant, result]);

    expect(clamped[0]).toBe(assistant);
    expect(clamped[0].content).toHaveLength(3_000);
    expect(clamped[1]).toMatchObject({
      contentClamped: true,
      contentLength: 9_000,
    });
    expect(clamped[1].content).toHaveLength(INIT_TOOL_RESULT_CLAMP_BYTES);
  });

  test("loads intermediate assistant notes separately from visible answers", () => {
    const prompt = entry("u", "user", "prompt");
    const note = entry("n", "assistant", "n".repeat(3_000));
    const call = entry("t", "tool_use", "Using Read", { toolUseId: "call" });
    const result = entry("r", "tool_result", "result", { toolUseId: "call" });
    const answer = entry("a", "assistant", "a".repeat(3_000));

    const clamped = clampV2InitEntries([prompt, note, call, result, answer]);

    expect(clamped[1]).toMatchObject({
      contentClamped: true,
      contentLength: 3_000,
    });
    expect(clamped[1].content).toHaveLength(INIT_COLLAPSED_MESSAGE_CLAMP_BYTES);
    expect(clamped[4]).toBe(answer);
    expect(clamped[4].content).toHaveLength(3_000);
  });

  test("keeps assistant-only conversations visible in full", () => {
    const entries = [entry("a", "assistant", "a".repeat(3_000))];
    expect(clampV2InitEntries(entries)).toBe(entries);
  });

  test("returns the original batch when no entry needs clamping", () => {
    const entries = [entry("r", "tool_result", "short")];
    expect(clampV2InitEntries(entries)).toBe(entries);
  });

  test("uses the same clamp budgets when sizing a snapshot", () => {
    expect(v2SnapshotEntryWeight("tool_result", 100_000)).toBe(
      INIT_TOOL_RESULT_CLAMP_BYTES + 512,
    );
    expect(v2SnapshotEntryWeight("assistant", 100_000)).toBe(8 * 1024);
    expect(v2SnapshotEntryWeight("assistant", 900)).toBe(900);
  });
});
