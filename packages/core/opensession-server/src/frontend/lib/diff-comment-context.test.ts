import { describe, expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { diffCommentContext } from "./diff-comment-context";

const patch = `diff --git a/demo.ts b/demo.ts
--- a/demo.ts
+++ b/demo.ts
@@ -10,3 +10,3 @@
 context
-old value
+new value
 trailing
@@ -40,2 +40,2 @@
-old later
+new later
 last
`;
const file = parsePatchFiles(patch)[0].files[0];

describe("selected diff comment context", () => {
  test("maps actual line numbers through gaps in a partial patch", () => {
    expect(
      diffCommentContext(file, { start: 40, end: 41, side: "additions" }),
    ).toEqual([
      { number: 40, text: "new later" },
      { number: 41, text: "last" },
    ]);
  });
  test("preserves removed-side context and normalizes backwards selections", () => {
    expect(
      diffCommentContext(file, { start: 12, end: 10, side: "deletions" }),
    ).toEqual([
      { number: 10, text: "context" },
      { number: 11, text: "old value" },
      { number: 12, text: "trailing" },
    ]);
  });
  test("does not invent lines omitted between hunks", () => {
    expect(
      diffCommentContext(file, { start: 12, end: 40, side: "additions" }),
    ).toEqual([
      { number: 12, text: "trailing" },
      { number: 40, text: "new later" },
    ]);
  });
});
