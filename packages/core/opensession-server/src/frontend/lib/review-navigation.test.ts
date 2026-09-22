import { describe, expect, test } from "bun:test";
import {
  adjacentReviewFile,
  canCommentOnReview,
  nextUnreviewedFile,
} from "./review-navigation";

describe("review navigation", () => {
  const paths = ["a.ts", "b.ts", "c.ts"];
  test("adjacent navigation stops at the edges", () => {
    expect(adjacentReviewFile(paths, "a.ts", -1)).toBeNull();
    expect(adjacentReviewFile(paths, "a.ts", 1)).toBe("b.ts");
    expect(adjacentReviewFile(paths, "c.ts", 1)).toBeNull();
    expect(adjacentReviewFile(paths, null, 1)).toBe("a.ts");
    expect(adjacentReviewFile([], null, 1)).toBeNull();
  });
  test("unfinished navigation skips reviewed files and wraps", () => {
    expect(nextUnreviewedFile(paths, "a.ts", new Set(["b.ts"]))).toBe("c.ts");
    expect(nextUnreviewedFile(paths, "c.ts", new Set(["c.ts"]))).toBe("a.ts");
    expect(nextUnreviewedFile(paths, "b.ts", new Set(["a.ts", "c.ts"]))).toBe(
      "b.ts",
    );
    expect(nextUnreviewedFile(paths, null, new Set(paths))).toBeNull();
    expect(nextUnreviewedFile([], null, new Set())).toBeNull();
  });
  test("open PRs accept comments irrespective of draft readiness", () => {
    for (const isDraft of [true, false]) {
      const pr = { state: "OPEN", isDraft };
      expect(canCommentOnReview(pr.state, true)).toBe(true);
    }
    expect(canCommentOnReview("CLOSED", true)).toBe(false);
    expect(canCommentOnReview("MERGED", true)).toBe(false);
    expect(canCommentOnReview("OPEN", false)).toBe(false);
    expect(canCommentOnReview(undefined, true)).toBe(false);
  });
});
