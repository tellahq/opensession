import { describe, expect, test } from "bun:test";
import {
  diffGroupsFingerprint,
  normalizeDiffGroups,
  type DiffGroupFile,
} from "./diff-groups";

const files: DiffGroupFile[] = [
  { path: "src/widget.ts", status: "modified", additions: 12, deletions: 2 },
  { path: "src/widget.test.ts", status: "added", additions: 30, deletions: 0 },
  { path: "README.md", status: "modified", additions: 4, deletions: 1 },
];

describe("normalizeDiffGroups", () => {
  test("keeps valid paths once and collects missing files", () => {
    const raw = JSON.stringify({
      groups: [
        { title: "Implementation", files: ["src/widget.ts", "invented.ts"] },
        { title: "Tests", files: ["src/widget.test.ts", "src/widget.ts"] },
      ],
    });
    expect(normalizeDiffGroups(raw, files)).toEqual([
      { title: "Implementation", files: ["src/widget.ts"] },
      { title: "Tests", files: ["src/widget.test.ts"] },
      { title: "Other", files: ["README.md"] },
    ]);
  });

  test("accepts a fenced response and rejects a single group", () => {
    const raw =
      '```json\n{"groups":[{"title":"Everything","files":["src/widget.ts","src/widget.test.ts","README.md"]}]}\n```';
    expect(normalizeDiffGroups(raw, files)).toBeNull();
  });

  test("removes duplicate paths within the same group", () => {
    const raw = JSON.stringify({
      groups: [
        { title: "Implementation", files: ["src/widget.ts", "src/widget.ts"] },
        { title: "Tests", files: ["src/widget.test.ts", "README.md"] },
      ],
    });
    expect(normalizeDiffGroups(raw, files)).toEqual([
      { title: "Implementation", files: ["src/widget.ts"] },
      { title: "Tests", files: ["src/widget.test.ts", "README.md"] },
    ]);
  });

  test("fingerprint changes with file metadata", () => {
    const changed = files.map((file) => ({ ...file }));
    changed[0]!.additions++;
    expect(diffGroupsFingerprint("opensession", files)).not.toBe(
      diffGroupsFingerprint("opensession", changed),
    );
  });

  test("fingerprint changes with diff contents", () => {
    expect(diffGroupsFingerprint("opensession", files, "+old")).not.toBe(
      diffGroupsFingerprint("opensession", files, "+new"),
    );
  });
});
