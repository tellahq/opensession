import { expect, test } from "bun:test";
import { REVIEW_TREE_CSS } from "./pr-file-tree-styles";

test("review tree preserves intrinsic names and uses compact, fixed indentation", () => {
  expect(REVIEW_TREE_CSS).toContain("width: max-content");
  expect(REVIEW_TREE_CSS).toContain("min-width: 100%");
  expect(REVIEW_TREE_CSS).toContain("min-width: max-content");
  expect(REVIEW_TREE_CSS).toContain("flex: 0 0 12px");
  expect(REVIEW_TREE_CSS).toContain("margin-left: 0");
});
