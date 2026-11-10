import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseJsonlLines } from "./jsonl-parser";
import {
  __setEngineSessionMapPathForTest,
  engineSessionOwnersPersisted,
  recordEngineSessionOwner,
  sessionForEngineId,
  transcriptLineAssistantText,
  transcriptLineCompactionSummary,
  transcriptLineRunnerNotice,
  transcriptLineToolResult,
  transcriptLineToolUse,
  transcriptLineUser,
} from "./transcript-persistence";

let dir = "";
let previous = "";
afterEach(() => {
  if (previous) __setEngineSessionMapPathForTest(previous);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
  previous = "";
});

describe("transcript persistence", () => {
  test("persists engine-session ownership", async () => {
    dir = mkdtempSync(join(tmpdir(), "engine-session-map-"));
    const path = join(dir, "map.json");
    previous = __setEngineSessionMapPathForTest(path);
    recordEngineSessionOwner("engine-1", "session-1");
    expect(await sessionForEngineId("engine-1")).toBe("session-1");
    await engineSessionOwnersPersisted();
    // A fresh process reads the owner back from disk.
    __setEngineSessionMapPathForTest(path);
    expect(await sessionForEngineId("engine-1")).toBe("session-1");
  });

  test("builders round-trip through the shared parser", () => {
    const lines = [
      transcriptLineUser("hello", "u1", "2026-01-01T00:00:00.000Z"),
      transcriptLineAssistantText(
        "hi",
        "a1",
        "2026-01-01T00:00:01.000Z",
        "pi/anthropic/claude-fable-5-2",
      ),
      transcriptLineAssistantText(
        "**Checking the repository**",
        "r1",
        "2026-01-01T00:00:02.000Z",
        "gpt-5.6-sol",
        true,
      ),
      transcriptLineToolUse("tool-1", "read", { path: "README.md" }),
      transcriptLineToolResult("tool-1", "contents"),
      transcriptLineRunnerNotice("retrying"),
      transcriptLineCompactionSummary("summary"),
    ];
    const entries = parseJsonlLines(lines.map((line) => JSON.stringify(line)));
    expect(entries.map((entry) => entry.type)).toEqual([
      "user",
      "assistant",
      "assistant",
      "tool_use",
      "tool_result",
      "system",
      "system",
    ]);
    expect(entries[2]).toMatchObject({
      type: "assistant",
      content: "**Checking the repository**",
      isReasoning: true,
    });
  });
});
