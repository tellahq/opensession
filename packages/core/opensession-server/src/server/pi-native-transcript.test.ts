import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  findPiNativeTranscriptByPrompt,
  readPiNativeTranscript,
} from "./pi-native-transcript";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("readPiNativeTranscript", () => {
  test("recovers a missed engine id from the journal prompt and timing", () => {
    dir = mkdtempSync(join(tmpdir(), "opensession-pi-transcript-"));
    const root = join(dir, "pi");
    const sessionDir = join(root, "sessions", "worker");
    mkdirSync(sessionDir, { recursive: true });
    const prompt = "Inspect the uploader contract\nand report every mismatch.";
    const session = (id: string, answer: string) =>
      [
        JSON.stringify({
          type: "session",
          id,
          timestamp: "2026-08-31T12:00:01.000Z",
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: `Worker preamble\n\n${prompt}` }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: answer }],
          },
        }),
      ].join("\n") + "\n";
    writeFileSync(
      join(
        sessionDir,
        "2026-08-31T12-00-01-000Z_01a00000-0000-7000-8000-000000000001.jsonl",
      ),
      session("first", "short"),
    );
    const expected = join(
      sessionDir,
      "2026-08-31T12-00-02-000Z_01a00000-0000-7000-8000-000000000002.jsonl",
    );
    writeFileSync(expected, session("second", "full answer ".repeat(100)));
    writeFileSync(
      join(
        sessionDir,
        "2026-08-31T12-00-03-000Z_01a00000-0000-7000-8000-000000000003.jsonl",
      ),
      session("other", "unrelated").replace(prompt, "Different task"),
    );

    expect(
      findPiNativeTranscriptByPrompt(
        {
          prompt,
          startedAt: "2026-08-31T12:00:00.000Z",
          endedAt: "2026-08-31T12:05:00.000Z",
        },
        join(root, "sessions"),
      ),
    ).toBe(expected);
  });

  test("keeps assistant thinking and text visible in provider order", () => {
    dir = mkdtempSync(join(tmpdir(), "opensession-pi-transcript-"));
    const path = join(dir, "session.jsonl");
    writeFileSync(
      path,
      JSON.stringify({
        type: "message",
        id: "message-1",
        timestamp: "2026-08-24T12:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should inspect the repository." },
            {
              type: "toolCall",
              id: "tool-1",
              name: "read",
              arguments: { path: "README.md" },
            },
            { type: "text", text: "The repository is ready." },
          ],
        },
      }) + "\n",
    );

    expect(readPiNativeTranscript(path)).toEqual([
      {
        id: "message-1",
        type: "assistant",
        content: "I should inspect the repository.",
        timestamp: "2026-08-24T12:00:00.000Z",
        isReasoning: true,
      },
      {
        id: "tool-1",
        type: "tool_use",
        content: "Using read",
        timestamp: "2026-08-24T12:00:00.000Z",
        toolName: "read",
        toolInput: { path: "README.md" },
        toolUseId: "tool-1",
      },
      {
        id: "message-1-b1",
        type: "assistant",
        content: "The repository is ready.",
        timestamp: "2026-08-24T12:00:00.000Z",
      },
    ]);
  });
});
