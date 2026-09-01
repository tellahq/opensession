import { describe, expect, test } from "bun:test";
import { canAutoExpandDiffFile, reviewDiffLoadPolicy } from "./review-diff";

describe("reviewDiffLoadPolicy", () => {
  test("keeps ordinary reviews expanded and organized", () => {
    expect(reviewDiffLoadPolicy(80_000, 12)).toEqual({
      defaultExpandedFiles: Infinity,
      groupFiles: true,
      allowExpandAll: true,
    });
  });

  test("collapses multi-megabyte reviews without grouping the patch", () => {
    expect(reviewDiffLoadPolicy(13_353_345, 489)).toEqual({
      defaultExpandedFiles: 2,
      groupFiles: false,
      allowExpandAll: false,
    });
  });

  test("also bounds reviews with many small files", () => {
    expect(reviewDiffLoadPolicy(90_000, 100)).toEqual({
      defaultExpandedFiles: 2,
      groupFiles: false,
      allowExpandAll: false,
    });
  });
});

describe("canAutoExpandDiffFile", () => {
  test("leaves oversized source files collapsed", () => {
    expect(canAutoExpandDiffFile("src/generated.ts", 2_001)).toBe(false);
    expect(canAutoExpandDiffFile("src/generated.ts", 2_000)).toBe(true);
  });

  test("leaves lock files collapsed", () => {
    expect(canAutoExpandDiffFile("packages/core/Cargo.lock", 20)).toBe(false);
  });
});
