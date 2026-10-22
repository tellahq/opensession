import { describe, expect, test } from "bun:test";
import {
  bulkReviewChanges,
  groupReviewProgress,
  lineBreakdown,
  ruleGroupTitle,
  ruleGroups,
} from "./review-groups";

describe("rule groups", () => {
  test("classifies files by role", () => {
    expect(ruleGroupTitle("src/app.ts")).toBe("Code");
    expect(ruleGroupTitle("src/app.test.ts")).toBe("Tests");
    expect(ruleGroupTitle("docs/guide.md")).toBe("Docs");
    expect(ruleGroupTitle(".github/workflows/ci.yml")).toBe("Config");
    expect(ruleGroupTitle("bun.lock")).toBe("Dependencies");
    expect(ruleGroupTitle("package.json")).toBe("Dependencies");
    expect(ruleGroupTitle("src/__snapshots__/a.snap")).toBe("Generated");
  });

  test("orders code first and machine output last", () => {
    expect(
      ruleGroups(["bun.lock", "README.md", "src/a.ts", "src/a.test.ts"]),
    ).toEqual([
      { title: "Code", files: ["src/a.ts"] },
      { title: "Tests", files: ["src/a.test.ts"] },
      { title: "Docs", files: ["README.md"] },
      { title: "Dependencies", files: ["bun.lock"] },
    ]);
  });
});

describe("line breakdown", () => {
  test("sums lines per role in review order and skips empty roles", () => {
    expect(
      lineBreakdown([
        { path: "src/a.test.ts", additions: 7, deletions: 1 },
        { path: "src/a.ts", additions: 50, deletions: 5 },
        { path: "src/b.ts", additions: 5, deletions: 2 },
        { path: "README.md", additions: 0, deletions: 0 },
      ]),
    ).toEqual([
      { title: "Code", additions: 55, deletions: 7 },
      { title: "Tests", additions: 7, deletions: 1 },
    ]);
  });

  test("reports lines the file list does not cover as other", () => {
    expect(
      lineBreakdown([{ path: "src/a.ts", additions: 4, deletions: 1 }], {
        additions: 10,
        deletions: 1,
      }),
    ).toEqual([
      { title: "Code", additions: 4, deletions: 1 },
      { title: "Other", additions: 6, deletions: 0 },
    ]);
  });
});

describe("group progress", () => {
  test("counts reviewed files and collects unclaimed ones", () => {
    expect(
      groupReviewProgress(
        [{ title: "Core", files: ["b.ts", "a.ts", "missing.ts"] }],
        ["a.ts", "b.ts", "c.ts"],
        new Set(["a.ts"]),
        new Set(["b.ts"]),
      ),
    ).toEqual([
      { title: "Core", files: ["a.ts", "b.ts"], reviewed: 1, changed: 1 },
      { title: "Everything else", files: ["c.ts"], reviewed: 0, changed: 0 },
    ]);
  });

  test("bulk actions only flip what needs flipping", () => {
    const reviewed = new Set(["a"]);
    expect(bulkReviewChanges(["a", "b"], reviewed, "mark")).toEqual({
      mark: ["b"],
      unmark: [],
    });
    expect(bulkReviewChanges(["a", "b"], reviewed, "reset")).toEqual({
      mark: [],
      unmark: ["a"],
    });
    expect(bulkReviewChanges(["a", "b"], reviewed, "invert")).toEqual({
      mark: ["b"],
      unmark: ["a"],
    });
  });
});
