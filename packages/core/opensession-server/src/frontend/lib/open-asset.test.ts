import { expect, test } from "bun:test";
import { collectWrittenAssets } from "./open-asset";
import type { TranscriptEntry } from "./types";

interface ToolInput {
  content?: string;
  file_path?: string;
  path?: string;
}

function toolUse(
  toolName: string,
  toolInput: ToolInput,
  id = "1",
): TranscriptEntry {
  return {
    id,
    type: "tool_use",
    content: "",
    timestamp: "2026-08-10T00:00:00.000Z",
    toolName,
    toolInput,
  };
}

test("collects the scratch files a turn wrote, in first-write order", () => {
  const entries = [
    toolUse("Write", { file_path: "/repo/src/a.ts", content: "x" }, "a"),
    toolUse("opensession-assets_write_asset", { path: "report.html" }, "b"),
    toolUse("opensession-assets_read_asset", { path: "data.json" }, "c"),
    toolUse("opensession-assets_write_asset", { path: "chart.png" }, "d"),
  ];
  expect(collectWrittenAssets(entries)).toEqual(["report.html", "chart.png"]);
});

test("one chip per path, however often the turn rewrote it", () => {
  const entries = [
    toolUse("opensession-assets_write_asset", { path: "report.html" }, "a"),
    toolUse(
      "mcp__opensession-assets__write_asset",
      { path: "report.html" },
      "b",
    ),
  ];
  expect(collectWrittenAssets(entries)).toEqual(["report.html"]);
});

test("a delete leaves nothing to open, and non-tool entries are ignored", () => {
  const entries: TranscriptEntry[] = [
    toolUse("opensession-assets_delete_asset", { path: "old.html" }),
    {
      id: "z",
      type: "assistant",
      content: "wrote report.html",
      timestamp: "2026-08-10T00:00:00.000Z",
    },
  ];
  expect(collectWrittenAssets(entries)).toEqual([]);
});
