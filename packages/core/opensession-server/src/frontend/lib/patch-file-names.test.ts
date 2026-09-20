import { describe, expect, test } from "bun:test";
import { patchFileNames } from "./patch-file-names";

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/old name.md b/new name.md",
  "similarity index 90%",
  "rename from old name.md",
  "rename to new name.md",
  'diff --git "a/sp ace/q.txt" "b/sp ace/q.txt"',
  "deleted file mode 100644",
  "--- a/sp ace/q.txt",
  "+++ /dev/null",
].join("\n");

describe("patchFileNames", () => {
  test("names every file by its post-image path", () => {
    expect([...patchFileNames(patch)]).toEqual([
      "src/a.ts",
      "new name.md",
      "sp ace/q.txt",
    ]);
  });

  test("ignores diff lines that merely mention a header", () => {
    expect(patchFileNames("+diff --git a/x b/x\n").size).toBe(0);
    expect(patchFileNames("").size).toBe(0);
  });
});
