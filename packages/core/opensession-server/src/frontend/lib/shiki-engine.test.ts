import { describe, expect, test } from "bun:test";
import { diffLineKinds, renderShiki } from "./shiki-engine";

describe("diffLineKinds", () => {
  test("marks signed rows and skips file headers before the first hunk", () => {
    expect(
      diffLineKinds([
        "--- a/x.ts",
        "+++ b/x.ts",
        "@@ -1,2 +1,2 @@",
        "-old",
        "+new",
        " same",
      ]),
    ).toEqual([null, null, null, "del", "add", null]);
  });

  test("treats a triple sign after a hunk header as a real row", () => {
    expect(diffLineKinds(["@@ -1 +1 @@", "--- removed comment"])).toEqual([
      null,
      "del",
    ]);
  });

  test("works for a bare +/- diff with no headers", () => {
    expect(diffLineKinds(["+added", "-removed", "context"])).toEqual([
      "add",
      "del",
      null,
    ]);
  });
});

describe("renderShiki diff", () => {
  test("classes the pre and its added and removed rows", async () => {
    const html = await renderShiki({
      code: "@@ -1 +1 @@\n-old\n+new\n same",
      lang: "diff",
      theme: "dark",
    });
    expect(html).toContain('class="shiki github-dark-default md-code-diff"');
    expect(html).toContain('<span class="line diff-del">');
    expect(html).toContain('<span class="line diff-add">');
    expect(html?.match(/class="line"/g)?.length).toBe(2);
  });

  test("drops the fence's trailing newline so no blank row is washed", async () => {
    const html = await renderShiki({
      code: "+a\n",
      lang: "diff",
      theme: "dark",
    });
    expect(html?.match(/<span class="line/g)?.length).toBe(1);
  });

  test("leaves other languages unmarked", async () => {
    const html = await renderShiki({
      code: "-1\n+1",
      lang: "ts",
      theme: "dark",
    });
    expect(html).not.toContain("md-code-diff");
    expect(html).not.toContain("diff-add");
  });
});
