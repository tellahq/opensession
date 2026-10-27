import { expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { preloadFileDiff } from "@pierre/diffs/ssr";

// Guards patches/@pierre%2Fdiffs@1.3.2.patch: word emphasis skips indentation
// and steps aside when a line was mostly rewritten, so re-indented code is not
// painted as solid red and green bars.
async function emphasized(patch: string) {
  const fileDiff = parsePatchFiles(patch)[0].files[0];
  const { prerenderedHTML } = await preloadFileDiff({
    fileDiff,
    options: {
      theme: "github-dark-default",
      lineDiffType: "word-alt",
      disableFileHeader: true,
    },
  });
  return [...prerenderedHTML.matchAll(/<span data-diff-span="">(.*?)<\/span>/g)]
    .map((match) => match[1].replace(/<[^>]+>/g, ""))
    .filter(Boolean);
}

const patchOf = (before: string, after: string) =>
  `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-${before}\n+${after}\n }\n`;

test("re-indented lines carry no word emphasis", async () => {
  expect(await emphasized(patchOf("  call(a);", "      call(a);"))).toEqual([]);
});

test("a small edit still marks just the changed word", async () => {
  expect(
    await emphasized(
      patchOf("    const x = foo(a);", "      const x = foo(b);"),
    ),
  ).toEqual(["a", "b"]);
});

test("a mostly rewritten line keeps only its row tint", async () => {
  expect(
    await emphasized(patchOf("    format!(", "    anyhow::ensure!(")),
  ).toEqual([]);
});
