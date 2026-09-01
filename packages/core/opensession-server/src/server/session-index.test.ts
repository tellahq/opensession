import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import type { TranscriptEntry } from "./types";
import {
  extractSessionIndexTexts,
  mergeSessionIndexWindows,
} from "./session-index";

function entry(
  id: string,
  type: TranscriptEntry["type"],
  content: string,
  seq: number,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    id,
    type,
    content,
    seq,
    timestamp: new Date(seq * 1000).toISOString(),
    ...extra,
  };
}

describe("pushed session history indexing", () => {
  test("merges bounded head and tail windows in transcript order", () => {
    const overlap = entry("overlap", "assistant", "newer form", 3);
    const merged = mergeSessionIndexWindows(
      [
        entry("first", "user", "question", 1),
        entry("overlap", "assistant", "older form", 3),
      ],
      [overlap, entry("last", "assistant", "answer", 9)],
    );

    expect(merged.map((item) => item.id)).toEqual(["first", "overlap", "last"]);
    expect(merged[1]?.content).toBe("newer form");
  });

  test("registers a pushed timer without retaining the fleet ticker", () => {
    const indexSource = readFileSync(
      new URL("./session-index.ts", import.meta.url),
      "utf8",
    );
    const bootSource = readFileSync(
      new URL("../../opensession.ts", import.meta.url),
      "utf8",
    );
    const runSource = readFileSync(
      new URL("./run-session.ts", import.meta.url),
      "utf8",
    );
    const outcomeExecutor = runSource.slice(
      runSource.indexOf('registerSessionEffectExecutor("turn_outcome_project"'),
      runSource.indexOf(
        "interruptExecutorGlobal.__opensessionTurnOutcomeProjectionExecutorRegistered = true",
      ),
    );

    expect(indexSource).toContain("registerSessionTimerHandler");
    expect(indexSource).not.toContain("setInterval(");
    expect(bootSource).toContain("startSessionHistoryIndexing();");
    expect(bootSource).not.toContain("startSessionIndexSweeper");
    expect(
      outcomeExecutor.indexOf('op: "settle_outcome_projection"'),
    ).toBeLessThan(
      outcomeExecutor.lastIndexOf("await scheduleSessionHistoryIndex("),
    );
  });

  test("extracts the opening prompt, latest answer, and touched paths", () => {
    const extracted = extractSessionIndexTexts([
      entry("prompt", "user", "Fix transcript loading", 1),
      entry("first-answer", "assistant", "Looking", 2),
      entry("edit", "tool_use", "", 3, {
        toolName: "edit",
        toolInput: { file_path: "src/session-index.ts" },
      }),
      entry("answer", "assistant", "Indexed on completion", 4),
    ]);

    expect(extracted.userTexts).toEqual(["Fix transcript loading"]);
    expect(extracted.lastAssistant).toBe("Indexed on completion");
    expect(extracted.files).toEqual(["src/session-index.ts"]);
  });
});
