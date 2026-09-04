import { describe, expect, test } from "bun:test";
import { fuzzyMatch, fuzzyScore } from "./fuzzy-match";

describe("fuzzyScore", () => {
  test("ranks exact, prefix, word prefix, then substring", () => {
    expect(fuzzyScore("release", "Release")).toBe(100);
    expect(fuzzyScore("rel", "Release work")).toBe(90);
    expect(fuzzyScore("work", "Release work")).toBe(80);
    expect(fuzzyScore("lease", "Release work")).toBe(70);
  });

  test("forgives a typo in longer terms", () => {
    expect(fuzzyScore("relase", "Release work")).toBeGreaterThan(0);
    expect(fuzzyScore("wrokspace", "Workspace cleanup")).toBeGreaterThan(0);
    expect(fuzzyScore("billng audit", "Billing audit")).toBeGreaterThan(0);
  });

  test("keeps short terms strict", () => {
    expect(fuzzyScore("cat", "cut")).toBe(0);
    expect(fuzzyScore("api", "apple")).toBe(0);
  });

  test("matches abbreviations inside one word", () => {
    expect(fuzzyScore("wksp", "workspace")).toBe(20);
  });

  test("needs every term to land somewhere", () => {
    expect(fuzzyScore("release billing", "Release work")).toBe(0);
    expect(fuzzyScore("work release", "Release work")).toBeGreaterThan(0);
  });

  test("ignores case and accents; empty query matches all", () => {
    expect(fuzzyScore("jaap", "Jääp")).toBe(100);
    expect(fuzzyScore("", "anything")).toBe(1);
    expect(fuzzyScore("x", "")).toBe(0);
  });
});

test("fuzzyMatch takes the best field", () => {
  expect(fuzzyMatch("audit", [null, "Billing", "audit/billing"])).toBe(90);
  expect(fuzzyMatch("nothing", ["a", undefined])).toBe(0);
});
