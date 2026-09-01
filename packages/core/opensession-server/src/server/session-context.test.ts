import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";
import { sessionStartContext } from "./context-log";
import { sessionContextSnapshot } from "./session-context";

function context(
  id: string,
  source: string,
  content: string,
  seq: number,
): TranscriptEntry {
  return {
    id,
    type: "system",
    content,
    timestamp: new Date(seq * 1000).toISOString(),
    seq,
    contextInjection: { source },
  };
}

describe("session context snapshot", () => {
  test("contains the final system prompt and active tool schemas", () => {
    const content = sessionStartContext("You are the effective prompt.", [
      {
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ]);
    expect(content).toContain(
      "# System prompt\n\nYou are the effective prompt.",
    );
    expect(content).toContain('"name": "read"');
    expect(content).toContain('"path"');
  });

  test("prefers the exact initial provider snapshot", () => {
    const result = sessionContextSnapshot([
      context("instructions", "instructions", "partial", 2),
      context("exact", "session-start", "complete", 3),
    ]);
    expect(result?.content).toBe("complete");
    expect(result?.exact).toBe(true);
    expect(result?.bytes).toBe(8);
  });

  test("builds a clearly partial fallback for older sessions", () => {
    const result = sessionContextSnapshot([
      context("tools", "tools", "policy", 3),
      context("instructions", "instructions", "memory lives here", 1),
      context("servers", "mcp-servers", "tool catalog", 2),
    ]);
    expect(result?.exact).toBe(false);
    expect(result?.content).toContain(
      "# Open Session instructions\n\nmemory lives here",
    );
    expect(result?.content).toContain("# Active tools\n\ntool catalog");
    expect(result?.content).toContain("# Tool policy\n\npolicy");
  });

  test("returns null when a session has no context audit", () => {
    expect(sessionContextSnapshot([])).toBeNull();
  });
});
