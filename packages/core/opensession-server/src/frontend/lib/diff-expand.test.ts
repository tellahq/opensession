import { describe, expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { diffFilesFromNewText } from "./diff-expand";

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`);

function parse(patch: string) {
  const fd = parsePatchFiles(patch).flatMap((p) => p.files)[0];
  if (!fd) throw new Error("no file parsed");
  return fd;
}

describe("diffFilesFromNewText", () => {
  // old: line 1..30. new: line 10 changed, line 25 removed, a line appended.
  const oldArr = lines(30);
  const newArr = [...oldArr];
  newArr[9] = "line ten";
  newArr.splice(24, 1);
  newArr.push("line 31");
  const oldText = `${oldArr.join("\n")}\n`;
  const newText = `${newArr.join("\n")}\n`;
  const patch = [
    "diff --git a/f.txt b/f.txt",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -7,7 +7,7 @@",
    " line 7",
    " line 8",
    " line 9",
    "-line 10",
    "+line ten",
    " line 11",
    " line 12",
    " line 13",
    "@@ -22,9 +22,9 @@",
    " line 22",
    " line 23",
    " line 24",
    "-line 25",
    " line 26",
    " line 27",
    " line 28",
    " line 29",
    " line 30",
    "+line 31",
    "",
  ].join("\n");

  test("rebuilds the old file from the new file and the hunks", () => {
    const files = diffFilesFromNewText(parse(patch), newText);
    expect(files.newFile.contents).toBe(newText);
    expect(files.oldFile?.contents).toBe(oldText);
  });

  test("rejects new text that does not match the patch", () => {
    const drifted = newText.replace("line ten", "line 10");
    expect(() => diffFilesFromNewText(parse(patch), drifted)).toThrow(
      "does not match",
    );
  });

  test("keeps a missing trailing newline", () => {
    const noEol = [
      "diff --git a/g.txt b/g.txt",
      "--- a/g.txt",
      "+++ b/g.txt",
      "@@ -9,2 +9,2 @@",
      " line 9",
      "-line 10",
      "\\ No newline at end of file",
      "+line ten",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const newG = [...lines(9), "line ten"].join("\n");
    const files = diffFilesFromNewText(parse(noEol), newG);
    expect(files.oldFile?.contents).toBe(lines(10).join("\n"));
  });
});
