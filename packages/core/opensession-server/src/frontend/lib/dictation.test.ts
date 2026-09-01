import { describe, expect, test } from "bun:test";
import { appendDictation } from "./dictation";

describe("appendDictation", () => {
  test("uses the first transcript as the draft", () => {
    expect(appendDictation("", "First thought")).toBe("First thought");
  });

  test("appends another transcript with one joining space", () => {
    expect(appendDictation("First thought   ", "and another")).toBe(
      "First thought and another",
    );
  });

  test("preserves meaningful whitespace in an existing draft", () => {
    expect(appendDictation("  First thought", "and another")).toBe(
      "  First thought and another",
    );
  });
});
