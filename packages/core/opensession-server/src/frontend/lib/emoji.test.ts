import { describe, expect, test } from "bun:test";
import {
  EMOJI,
  emojiContextAt,
  emojiMatches,
  emojiMentionSuggestions,
} from "./emoji";

describe("emoji shortcodes", () => {
  test("two letters are enough, and the exact-prefix name leads", () => {
    const names = emojiMatches("cr").map((e) => e.name);
    expect(names[0]).toBe("cry");
    expect(names).toContain("crown");
  });

  test("an exact name wins even when longer names also prefix-match", () => {
    expect(emojiMatches("star")[0]?.name).toBe("star");
  });

  test("one character never opens the picker", () => {
    expect(emojiMatches("c")).toEqual([]);
    expect(emojiMatches("")).toEqual([]);
  });

  test("aliases match but sort behind name hits", () => {
    const names = emojiMatches("lgtm").map((e) => e.name);
    expect(names).toEqual(["thumbsup"]);
  });

  test("suggestions insert the character and label the shortcode", () => {
    const row = emojiMentionSuggestions("cry")[0];
    expect(row?.insert).toBe("😢");
    expect(row?.display).toBe("😢");
    expect(row?.sub).toBe(":cry:");
    expect(row?.kind).toBe("emoji");
  });

  test("every entry has a unique name", () => {
    const names = EMOJI.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("emoji trigger context", () => {
  test("finds the shortcode at the caret", () => {
    expect(emojiContextAt("hey :cr", 7)).toEqual({ start: 4, query: "cr" });
    expect(emojiContextAt(":cr", 3)).toEqual({ start: 0, query: "cr" });
  });

  test("keeps a finished shortcode selectable", () => {
    expect(emojiContextAt(":cry:", 5)).toEqual({ start: 0, query: "cry" });
  });

  test("ignores colons that are part of other text", () => {
    expect(emojiContextAt("https://ex.com", 8)).toBeNull();
    expect(emojiContextAt("at 10:30", 8)).toBeNull();
    expect(emojiContextAt("note:cr", 7)).toBeNull();
    expect(emojiContextAt("::cr", 4)).toBeNull();
  });

  test("opens right after a picked emoji, which leaves no trailing space", () => {
    const value = "😢:cr";
    expect(emojiContextAt(value, value.length)).toEqual({
      start: value.indexOf(":"),
      query: "cr",
    });
  });

  test("opens after punctuation and brackets too", () => {
    expect(emojiContextAt("done!:cr", 8)).toEqual({ start: 5, query: "cr" });
    expect(emojiContextAt("(:cr", 4)).toEqual({ start: 1, query: "cr" });
  });

  test("stops at whitespace and at non-shortcode characters", () => {
    expect(emojiContextAt(": cr", 4)).toBeNull();
    expect(emojiContextAt("plain text", 10)).toBeNull();
  });
});
