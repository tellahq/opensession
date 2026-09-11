import { describe, expect, it } from "bun:test";
import {
  matchTreePath,
  parseTree,
  treeFilePaths,
  type TreeNode,
} from "./tree-block";

const file = (name: string, note?: string): TreeNode =>
  note
    ? { name, dir: false, note, children: [] }
    : { name, dir: false, children: [] };
const dir = (name: string, children: TreeNode[]): TreeNode => ({
  name,
  dir: true,
  children,
});

describe("parseTree", () => {
  it("reads an indented tree, two spaces per level", () => {
    expect(
      parseTree("src/\n  upload.ts\n  lib/\n    retry.ts\npackage.json\n"),
    ).toEqual([
      dir("src", [file("upload.ts"), dir("lib", [file("retry.ts")])]),
      file("package.json"),
    ]);
  });

  it("reads tabs and four-space indents as one level each", () => {
    expect(parseTree("src/\n\tupload.ts\n\tlib/\n\t\tretry.ts")).toEqual([
      dir("src", [file("upload.ts"), dir("lib", [file("retry.ts")])]),
    ]);
    expect(parseTree("src/\n    a.ts\n    b/\n        c.ts")).toEqual([
      dir("src", [file("a.ts"), dir("b", [file("c.ts")])]),
    ]);
  });

  it("reads tree CLI box drawing, including the summary line", () => {
    const source = [
      "acme-todo/",
      "├── src/",
      "│   ├── upload.ts",
      "│   └── upload.test.ts",
      "├── NOTES.md",
      "└── package.json",
      "",
      "1 directory, 4 files",
    ].join("\n");
    expect(parseTree(source)).toEqual([
      dir("acme-todo", [
        dir("src", [file("upload.ts"), file("upload.test.ts")]),
        file("NOTES.md"),
        file("package.json"),
      ]),
    ]);
  });

  it("reads the ASCII charset and deeper nesting", () => {
    const source = [
      ".",
      "|-- src",
      "|   `-- lib",
      "|       `-- retry.ts",
      "`-- package.json",
    ].join("\n");
    expect(parseTree(source)).toEqual([
      dir(".", [
        dir("src", [dir("lib", [file("retry.ts")])]),
        file("package.json"),
      ]),
    ]);
  });

  it("keeps a trailing # note beside the name", () => {
    expect(parseTree("src/\n  upload.ts  # retry loop")).toEqual([
      dir("src", [file("upload.ts", "retry loop")]),
    ]);
  });

  it("declines anything that is not a tree", () => {
    expect(parseTree("")).toBeNull();
    expect(parseTree("a.ts\n    b.ts\n  c.ts")).toBeNull();
    expect(parseTree("  indented first line")).toBeNull();
    expect(parseTree("root/\n├── a\n  b")).toBeNull();
    expect(parseTree("│   orphan prefix")).toBeNull();
  });
});

describe("treeFilePaths", () => {
  it("drops a lone root directory from the paths", () => {
    const nodes = parseTree("acme-todo/\n  src/\n    upload.ts\n  README.md");
    expect(treeFilePaths(nodes!)).toEqual(["src/upload.ts", "README.md"]);
  });

  it("keeps every top-level name when there are several", () => {
    const nodes = parseTree("src/\n  upload.ts\npackage.json");
    expect(treeFilePaths(nodes!)).toEqual(["src/upload.ts", "package.json"]);
  });
});

describe("matchTreePath", () => {
  const changed = ["src/upload.ts", "src/lib/retry.ts", "docs/upload.ts"];

  it("prefers the exact path", () => {
    expect(matchTreePath("src/upload.ts", changed)).toBe("src/upload.ts");
    expect(matchTreePath("./src/upload.ts", changed)).toBe("src/upload.ts");
  });

  it("matches a tree drawn from a subdirectory by its one tail", () => {
    expect(matchTreePath("lib/retry.ts", changed)).toBe("src/lib/retry.ts");
    expect(matchTreePath("upload.ts", changed)).toBeUndefined();
    expect(matchTreePath("missing.ts", changed)).toBeUndefined();
  });
});
