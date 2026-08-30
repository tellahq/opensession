import { describe, expect, test } from "bun:test";
import { mcpServerAllowedForRun } from "./runner-shared";

describe("Apple release MCP run policy", () => {
  test("requires the current prompter even when the session creator is allowed", () => {
    expect(
      mcpServerAllowedForRun("apple-release", ["Alice"], "Bob", ["Alice"]),
    ).toBe(false);
    expect(
      mcpServerAllowedForRun("apple-release", ["Alice"], "Alice", ["Bob"]),
    ).toBe(true);
  });

  test("preserves creator fallback for ordinary user-restricted servers", () => {
    expect(
      mcpServerAllowedForRun("ordinary-server", ["Alice"], "Bob", ["Alice"]),
    ).toBe(true);
  });
});
