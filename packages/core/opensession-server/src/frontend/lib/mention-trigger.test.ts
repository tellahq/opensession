import { describe, expect, test } from "bun:test";
import {
  isSpacedQuery,
  mentionContextAt,
  slashContextAt,
} from "./mention-trigger";

describe("mentionContextAt", () => {
  test("finds the token at the caret", () => {
    expect(mentionContextAt("hey @ke", 7)).toEqual({ start: 4, query: "ke" });
    expect(mentionContextAt("@", 1)).toEqual({ start: 0, query: "" });
  });

  test("keeps filtering across spaces", () => {
    const value = "@fix the login";
    expect(mentionContextAt(value, value.length)).toEqual({
      start: 0,
      query: "fix the login",
    });
  });

  test("ends at a line break", () => {
    expect(mentionContextAt("@kent\nhello", 11)).toBeNull();
  });

  test("ignores an @ glued to a word", () => {
    expect(mentionContextAt("me@home", 7)).toBeNull();
    expect(mentionContextAt("@kent said me@home", 18)).toBeNull();
  });

  test("returns the text before the caret only", () => {
    expect(mentionContextAt("@kent hello", 3)).toEqual({
      start: 0,
      query: "ke",
    });
  });
});

describe("slashContextAt", () => {
  test("only opens for a leading slash", () => {
    expect(slashContextAt("/co", 3)).toEqual({ start: 0, query: "co" });
    expect(slashContextAt("see src/foo", 11)).toBeNull();
    expect(slashContextAt("/", 0)).toBeNull();
  });

  test("keeps filtering across spaces", () => {
    expect(slashContextAt("/set goal", 9)).toEqual({
      start: 0,
      query: "set goal",
    });
  });

  test("ends at a line break", () => {
    expect(slashContextAt("/commit\nmore", 12)).toBeNull();
  });
});

test("isSpacedQuery", () => {
  expect(isSpacedQuery("goal")).toBe(false);
  expect(isSpacedQuery("set goal")).toBe(true);
  expect(isSpacedQuery("goal ")).toBe(true);
});
