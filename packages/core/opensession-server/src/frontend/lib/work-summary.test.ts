import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "./types";
import { workSummary, workSummaryTitle } from "./work-summary";

let n = 0;
function call(
  toolName: string,
  toolInput: Record<string, string | boolean> = {},
): TranscriptEntry {
  n++;
  return {
    id: `t${n}`,
    type: "tool_use",
    content: "",
    timestamp: "2026-01-01T00:00:00.000Z",
    toolName,
    toolInput,
    toolUseId: `u${n}`,
  };
}

describe("workSummary", () => {
  test("says what the run did, in the order it first did it", () => {
    const items = [
      call("bash", { command: "ls" }),
      call("read", { path: "a.ts" }),
      call("bash", { command: "bun test" }),
      call("edit", { path: "a.ts" }),
      call("grep", { pattern: "x" }),
    ];
    expect(workSummary(items)).toBe(
      "ran 2 commands, read 1 file, edited 1 file, ran 1 search",
    );
  });

  test("counts files, not passes over them", () => {
    const items = [
      call("edit", { path: "a.ts" }),
      call("edit", { path: "a.ts" }),
      call("write", { path: "b.ts" }),
      call("read", { path: "a.ts" }),
      call("read", { path: "a.ts" }),
    ];
    expect(workSummary(items)).toBe("edited 2 files, read 1 file");
  });

  test("an edit that names no file is still an edit", () => {
    expect(workSummary([call("apply_patch", {})])).toBe("edited 1 file");
  });

  test("MCP and unknown tools share one clause", () => {
    const items = [
      call("mcp_call", { name: "linear_list_issues" }),
      call("mcp__slack__post"),
      call("something"),
    ];
    expect(workSummary(items)).toBe("called 3 tools");
  });

  test("looks at a background command are not more commands", () => {
    const items = [
      call("bash", { command: "bun run build", background: true }),
      call("bash_status", { id: "bg1" }),
      call("bash_status", { id: "bg1" }),
      call("bash_kill", { id: "bg1" }),
    ];
    expect(workSummary(items)).toBe("ran 1 command, checked on 1 command");
  });

  test("a plan update has no count worth reading", () => {
    expect(workSummary([call("todowrite"), call("todowrite")])).toBe(
      "updated the plan",
    );
  });

  test("stands alone capitalized, and is empty without tool calls", () => {
    expect(workSummaryTitle([call("bash")])).toBe("Ran 1 command");
    expect(workSummaryTitle([])).toBe("");
  });
});
