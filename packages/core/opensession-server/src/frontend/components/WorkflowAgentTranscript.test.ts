import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./WorkflowAgentTranscript.tsx", import.meta.url),
  "utf8",
);

describe("WorkflowAgentTranscript", () => {
  test("renders inside the workspace panel without the main transcript virtualizer", () => {
    expect(source).toContain("virtualize={false}");
  });
});
