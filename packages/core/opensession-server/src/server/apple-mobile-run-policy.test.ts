import { describe, expect, test } from "bun:test";
import { mcpServerAllowedForRun } from "./runner-shared";

describe("Apple release MCP run policy", () => {
  test("requires the current prompter even when the session creator is allowed", () => {
    for (const name of [
      "apple-release",
      "APPLE-RELEASE",
      "  Apple-Release  ",
    ]) {
      expect(mcpServerAllowedForRun(name, ["Alice"], "Bob", ["Alice"])).toBe(
        false,
      );
      expect(mcpServerAllowedForRun(name, ["Alice"], "Alice", ["Bob"])).toBe(
        true,
      );
    }
  });

  test("preserves creator fallback for ordinary user-restricted servers", () => {
    expect(
      mcpServerAllowedForRun("ordinary-server", ["Alice"], "Bob", ["Alice"]),
    ).toBe(true);
  });
});
