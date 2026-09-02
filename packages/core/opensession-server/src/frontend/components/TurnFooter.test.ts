import { expect, test } from "bun:test";
import type { TranscriptEntry } from "../lib/types";
import {
  collectTouchedFiles,
  touchedFilesFromTool,
  turnTouchedFiles,
} from "./TurnFooter";

function edit<T>(id: string, toolName: string, toolInput: T): TranscriptEntry {
  return {
    id,
    type: "tool_use",
    content: "",
    timestamp: "2026-08-16T10:00:00.000Z",
    toolUseId: `tu-${id}`,
    toolName,
    toolInput,
  };
}

test("an edit's line counts come from the old and new strings", () => {
  const files = touchedFilesFromTool(
    edit("a", "Edit", {
      file_path: "/repo/src/a.ts",
      old_string: "one\ntwo",
      new_string: "one\ntwo\nthree\nfour",
    }),
  );
  expect(files).toEqual([
    {
      path: "/repo/src/a.ts",
      additions: 4,
      deletions: 2,
      hunks: ["-one\n-two\n+one\n+two\n+three\n+four"],
    },
  ]);
});

// A trailing newline is a line the split counts, and the counter that replaced
// it has to agree: "a\n".split("\n") is ["a", ""].
test("a trailing newline counts the same as splitting did", () => {
  const [file] = touchedFilesFromTool(
    edit("b", "Write", { file_path: "/repo/src/b.ts", content: "a\nb\n" }),
  );
  expect(file.additions).toBe(3);
  expect(file.deletions).toBe(0);
});

test("a write with no content adds nothing", () => {
  const [file] = touchedFilesFromTool(
    edit("c", "Write", { file_path: "/repo/src/c.ts", content: "" }),
  );
  expect(file.additions).toBe(0);
  expect(file.hunks).toEqual([""]);
});

test("a multi-edit sums its hunks against one file", () => {
  const [file] = touchedFilesFromTool(
    edit("d", "Edit", {
      filePath: "/repo/src/d.ts",
      edits: [
        { oldString: "x", newString: "y\nz" },
        { oldString: "p\nq", newString: "r" },
      ],
    }),
  );
  expect(file.additions).toBe(3);
  expect(file.deletions).toBe(3);
  expect(file.hunks).toEqual(["-x\n+y\n+z", "-p\n-q\n+r"]);
});

// The result is cached per entry object, so the merge it feeds must copy
// before it accumulates: without that, a second collect would read counts a
// first one had already added to.
test("collecting a turn's files twice reports the same counts", () => {
  const turn = [
    edit("e1", "Edit", {
      file_path: "/repo/src/e.ts",
      old_string: "a",
      new_string: "b",
    }),
    edit("e2", "Edit", {
      file_path: "/repo/src/e.ts",
      old_string: "c",
      new_string: "d\ne",
    }),
  ];
  const first = collectTouchedFiles(turn);
  const second = collectTouchedFiles(turn);
  expect(first).toEqual([
    {
      path: "/repo/src/e.ts",
      additions: 3,
      deletions: 2,
      hunks: ["-a\n+b", "-c\n+d\n+e"],
    },
  ]);
  expect(second).toEqual(first);
});

test("the same entry is read once, an equal one is read again", () => {
  const entry = edit("f", "Write", {
    file_path: "/repo/src/f.ts",
    content: "hello",
  });
  expect(touchedFilesFromTool(entry)).toBe(touchedFilesFromTool(entry));
  const replacement = edit("f", "Write", {
    file_path: "/repo/src/f.ts",
    content: "hello there",
  });
  expect(touchedFilesFromTool(replacement)[0].additions).toBe(1);
  expect(touchedFilesFromTool(replacement)).not.toBe(
    touchedFilesFromTool(entry),
  );
});

test("a tool that only reports a path carries no hunks", () => {
  const files = touchedFilesFromTool(
    edit("g", "FileChange", { changes: ["update src/g.ts", "add src/h.ts"] }),
  );
  expect(files).toEqual([
    { path: "src/g.ts", additions: 0, deletions: 0, hunks: [] },
    { path: "src/h.ts", additions: 0, deletions: 0, hunks: [] },
  ]);
});

test("a bash call touches nothing", () => {
  expect(touchedFilesFromTool(edit("h", "Bash", { command: "ls" }))).toEqual(
    [],
  );
});

function answer(id: string): TranscriptEntry {
  return {
    id,
    type: "assistant",
    content: "done",
    timestamp: "2026-08-16T10:00:01.000Z",
  };
}

// The caller builds the turn array in render, so an equal turn arrives as a
// fresh array on every frame. Holding one identity is the whole point: the
// footer takes it as a prop.
test("an unchanged turn keeps one array identity", () => {
  const tool = edit("i1", "Write", {
    file_path: "/repo/src/i.ts",
    content: "a",
  });
  const final = answer("i2");
  const files = turnTouchedFiles([tool, final]);
  expect(turnTouchedFiles([tool, final])).toBe(files);
  expect(files).toEqual(collectTouchedFiles([tool, final]));
});

// The cache is keyed on the turn's last entry, which a mid-turn edit leaves
// alone — so the members are compared, or a settled answer would keep showing
// the counts its tool call had when it was first read.
test("replacing an entry inside the turn re-collects it", () => {
  const final = answer("j3");
  const before = turnTouchedFiles([
    edit("j1", "Write", { file_path: "/repo/src/j.ts", content: "a" }),
    final,
  ]);
  expect(before[0].additions).toBe(1);
  const after = turnTouchedFiles([
    edit("j1", "Write", { file_path: "/repo/src/j.ts", content: "a\nb\nc" }),
    final,
  ]);
  expect(after).not.toBe(before);
  expect(after[0].additions).toBe(3);
});

test("an empty turn touches nothing", () => {
  expect(turnTouchedFiles([])).toEqual([]);
});
