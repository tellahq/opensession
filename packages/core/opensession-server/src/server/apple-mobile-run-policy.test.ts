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

  test("fails closed when a protected server has no valid allowlist", () => {
    for (const allowedUsers of [
      undefined,
      [],
      "Alice",
      [123],
      [""],
      ["Alice", 123],
    ]) {
      expect(
        mcpServerAllowedForRun("apple-release", allowedUsers, "Alice", [
          "Alice",
        ]),
      ).toBe(false);
      expect(
        mcpServerAllowedForRun("apple-release", allowedUsers, undefined, [
          "Alice",
        ]),
      ).toBe(false);
    }
  });

  test("preserves ordinary server defaults and creator fallback", () => {
    expect(mcpServerAllowedForRun("ordinary-server", undefined, "Bob")).toBe(
      true,
    );
    expect(mcpServerAllowedForRun("ordinary-server", [], undefined)).toBe(true);
    expect(
      mcpServerAllowedForRun("ordinary-server", ["Alice"], "Bob", ["Alice"]),
    ).toBe(true);
  });
});
