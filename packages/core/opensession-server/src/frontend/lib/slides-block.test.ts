import { describe, expect, test } from "bun:test";
import { splitSlides } from "./slides-block";

describe("splitSlides", () => {
  test("splits on lines that are exactly ---", () => {
    expect(splitSlides("# One\n---\n# Two\n---\n# Three")).toEqual([
      "# One",
      "# Two",
      "# Three",
    ]);
  });

  test("allows trailing whitespace but not a longer rule", () => {
    expect(splitSlides("a\n---  \nb")).toEqual(["a", "b"]);
    expect(splitSlides("a\n----\nb")).toEqual(["a\n----\nb"]);
    expect(splitSlides("a\n - - -\nb")).toEqual(["a\n - - -\nb"]);
  });

  test("leaves a --- inside a nested fence to that fence", () => {
    const src = "# Diff\n```diff\n---\n+++\n```\n---\n# Next";
    expect(splitSlides(src)).toEqual([
      "# Diff\n```diff\n---\n+++\n```",
      "# Next",
    ]);
  });

  test("honours tilde fences and longer closers", () => {
    const src = "~~~\n---\n~~~\n---\n````\n---\n```\n---\n````\n---\nend";
    expect(splitSlides(src)).toEqual([
      "~~~\n---\n~~~",
      "````\n---\n```\n---\n````",
      "end",
    ]);
  });

  test("drops blank slides and trims the rest", () => {
    expect(splitSlides("---\n\n  a  \n\n---\n---\nb\n---\n")).toEqual([
      "a",
      "b",
    ]);
    expect(splitSlides("")).toEqual([]);
    expect(splitSlides("---\n---")).toEqual([]);
  });

  test("accepts CRLF line endings", () => {
    expect(splitSlides("a\r\n---\r\nb")).toEqual(["a", "b"]);
  });
});
