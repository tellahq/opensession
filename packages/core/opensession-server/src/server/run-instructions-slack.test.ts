import { describe, expect, test } from "bun:test";
import { buildRunInstructions } from "./run-instructions";

describe("Slack run instructions", () => {
  test("keeps interactive posts on the attributed MCP path", () => {
    const instructions = buildRunInstructions({ isAsk: false });

    expect(instructions).toContain("## Slack identity and attribution");
    expect(instructions).toContain("use the configured `slack` MCP tools");
    expect(instructions).toContain("Never call Slack with `curl`");
  });
});
