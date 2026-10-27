import { describe, expect, test } from "bun:test";
import { htmlRenderFromResult } from "@tellahq/opensession-protocol/html-render";
import type { SeqEntry } from "./transcript-store";
import { MESSAGE_COLLAPSE_CHARS } from "../shared/message-preview";
import {
  clampV2InitEntries,
  INIT_COLLAPSED_MESSAGE_CLAMP_BYTES,
  INIT_MESSAGE_CLAMP_BYTES,
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

  test("ships an html_render result whole, and only a small one", () => {
    const reference = `{"htmlRender":{"url":"/api/sessions/s/assets/raw/html-renders/a.html","heights":[${"[320,570],".repeat(20)}[1160,497]]},"message":"ok"}`;
    const render = entry("r", "tool_result", reference);
    const forged = entry(
      "f",
      "tool_result",
      `{"htmlRender":${"x".repeat(5_000)}`,
    );

    const clamped = clampV2InitEntries([render, forged]);

    expect(clamped[0]).toBe(render);
    expect(clamped[1].content).toHaveLength(INIT_TOOL_RESULT_CLAMP_BYTES);
  });

  test("keeps a render reference a codemode report carries", () => {
    const reference = `{"htmlRender":{"url":"/api/sessions/s/assets/raw/html-renders/a.html","path":"html-renders/a.html","title":"A","height":360},"message":"ok"}`;
    const report = `Script completed\nWall time 1.8 seconds\nOutput:\n${"x".repeat(400)}\n${reference}\nConsole: (empty)`;
    const result = entry("r", "tool_result", report);

    const [clamped] = clampV2InitEntries([result]);

    expect(clamped.contentClamped).toBe(true);
    expect(clamped.content).toBe(
      `${report.slice(0, INIT_TOOL_RESULT_CLAMP_BYTES)}\n${reference}`,
    );
    expect(htmlRenderFromResult(clamped.content)?.url).toBe(
      "/api/sessions/s/assets/raw/html-renders/a.html",
    );
  });

  test("loads intermediate assistant notes separately from visible answers", () => {
    const prompt = entry("u", "user", "prompt");
    const note = entry("n", "assistant", "n".repeat(8_000));
    const call = entry("t", "tool_use", "Using Read", { toolUseId: "call" });
    const result = entry("r", "tool_result", "result", { toolUseId: "call" });
    const answer = entry("a", "assistant", "a".repeat(8_000));

    const clamped = clampV2InitEntries([prompt, note, call, result, answer]);

    expect(clamped[1]).toMatchObject({
      contentClamped: true,
      contentLength: 8_000,
    });
    expect(clamped[1].content).toHaveLength(INIT_COLLAPSED_MESSAGE_CLAMP_BYTES);
    expect(clamped[4]).toBe(answer);
    expect(clamped[4].content).toHaveLength(8_000);
  });

  test("sends short and near-limit intermediate notes whole", () => {
    const prompt = entry("u", "user", "prompt");
    const short = entry("s", "assistant", "s".repeat(303));
    const nearLimit = entry(
      "n",
      "assistant",
      "n".repeat(INIT_COLLAPSED_MESSAGE_CLAMP_BYTES + 500),
    );
    const call = entry("t", "tool_use", "Using Read", { toolUseId: "call" });
    const result = entry("r", "tool_result", "result", { toolUseId: "call" });
    const answer = entry("a", "assistant", "done");

    const clamped = clampV2InitEntries([
      prompt,
      short,
      nearLimit,
      call,
      result,
      answer,
    ]);

    expect(clamped[1]).toBe(short);
    expect(clamped[2]).toBe(nearLimit);
    expect(clamped[2].contentClamped).toBeUndefined();
  });

  test("does not send message text the UI would hide behind its expander", () => {
    const visible = entry("visible", "assistant", "a".repeat(3_000));
    const long = entry("long", "assistant", "b".repeat(36_000));

    const clamped = clampV2InitEntries([visible, long]);

    expect(clamped[0]).toBe(visible);
    expect(clamped[1]).toMatchObject({
      contentClamped: true,
      contentLength: 36_000,
    });
    expect(clamped[1].content).toHaveLength(INIT_MESSAGE_CLAMP_BYTES);
  });

  test.each([24_000, 24_001, 29_999])(
    "preserves near-limit visible messages of %i characters",
    (length) => {
      const entries = [
        entry("u", "user", "u".repeat(length)),
        entry("a", "assistant", "a".repeat(length)),
      ];
      expect(clampV2InitEntries(entries)).toBe(entries);
    },
  );

  test("clamps at exactly 20% hidden", () => {
    const entries = [
      entry("a", "assistant", "a".repeat(MESSAGE_COLLAPSE_CHARS)),
    ];
    const [clamped] = clampV2InitEntries(entries);
    expect(clamped.content).toHaveLength(INIT_MESSAGE_CLAMP_BYTES);
    expect(clamped.contentClamped).toBe(true);
    expect(clamped.contentLength).toBe(MESSAGE_COLLAPSE_CHARS);
  });

  test("cuts the uncompressed size of a long 100-message opening batch", () => {
    const entries = Array.from({ length: 100 }, (_, index) =>
      entry(`a-${index}`, "assistant", "answer ".repeat(5_200)),
    );
    const originalBytes = Buffer.byteLength(JSON.stringify(entries));
    const clampedBytes = Buffer.byteLength(
      JSON.stringify(clampV2InitEntries(entries)),
    );

    expect(clampedBytes).toBeLessThan(originalBytes * 0.7);
  });

  test("returns the original batch when no entry needs clamping", () => {
    const entries = [entry("r", "tool_result", "short")];
    expect(clampV2InitEntries(entries)).toBe(entries);
  });

  test("uses the same clamp budgets when sizing a snapshot", () => {
    expect(v2SnapshotEntryWeight("tool_result", 100_000)).toBe(
      INIT_TOOL_RESULT_CLAMP_BYTES + 512,
    );
    expect(v2SnapshotEntryWeight("assistant", 100_000)).toBe(
      MESSAGE_COLLAPSE_CHARS,
    );
    expect(v2SnapshotEntryWeight("assistant", 29_999)).toBe(29_999);
    expect(v2SnapshotEntryWeight("assistant", 900)).toBe(900);
  });
});
