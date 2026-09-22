import { describe, expect, test } from "bun:test";
import { FileTree } from "@pierre/trees";
import {
  filterReviewFiles,
  reviewFileDecoration,
  syncReviewTreeSelection,
} from "./pr-file-navigator";

const files = [
  { path: "src/components/Review.tsx", additions: 1, deletions: 0 },
  { path: "src/lib/review.ts", additions: 2, deletions: 1 },
  { path: "README.md", additions: 1, deletions: 1 },
];

describe("review file navigation", () => {
  test("matches filenames and paths case-insensitively without modifying input", () => {
    expect(filterReviewFiles(files, " REVIEW ", false)).toEqual(
      files.slice(0, 2),
    );
    expect(filterReviewFiles(files, "src/lib/", false)).toEqual([files[1]]);
    expect(filterReviewFiles(files, "missing", false)).toEqual([]);
    expect(filterReviewFiles(files, "", false)).toBe(files);
    expect(files).toHaveLength(3);
  });

  test("combines local search with the unreviewed filter", () => {
    const reviewed = new Set([files[0]!.path]);
    expect(filterReviewFiles(files, "review", true, reviewed)).toEqual([
      files[1],
    ]);
    expect(
      filterReviewFiles(
        files,
        "",
        true,
        new Set(files.map((file) => file.path)),
      ),
    ).toEqual([]);
    expect(filterReviewFiles(files, "", true)).toEqual(files);
  });

  test("labels reviewed markers", () => {
    expect(reviewFileDecoration("a")).toBeNull();
    expect(reviewFileDecoration("a", new Set(["a"]))).toEqual({
      text: "✓",
      title: "Reviewed",
    });
  });

  test("controlled selection preserves focus and avoids redundant selection events", () => {
    let changes = 0;
    const model = new FileTree({
      paths: files.map((file) => file.path),
      onSelectionChange: () => changes++,
    });
    const initialFocus = model.getFocusedPath();
    syncReviewTreeSelection(model, files[0]!.path);
    expect(model.getSelectedPaths()).toEqual([files[0]!.path]);
    expect(model.getFocusedPath()).toBe(initialFocus);
    const previous = changes;
    syncReviewTreeSelection(model, files[0]!.path);
    expect(changes).toBe(previous);
    syncReviewTreeSelection(model, undefined);
    expect(model.getSelectedPaths()).toEqual([files[0]!.path]);
    syncReviewTreeSelection(model, "missing");
    expect(model.getSelectedPaths()).toEqual([]);
    syncReviewTreeSelection(model, "src");
    expect(model.getSelectedPaths()).toEqual([]);
    model.cleanUp();
  });
});
