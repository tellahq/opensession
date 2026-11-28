import { expect, test } from "bun:test";
import { prCheckGroups, prCommitDays } from "./pr-commit-days";

test("groups commits by the day they were authored", () => {
  const days = prCommitDays(
    [
      {
        oid: "a",
        messageHeadline: "A",
        author: "x",
        authoredDate: "2026-11-26T10:00:00Z",
      },
      {
        oid: "b",
        messageHeadline: "B",
        author: "x",
        authoredDate: "2026-11-26T12:00:00Z",
      },
      {
        oid: "c",
        messageHeadline: "C",
        author: "x",
        authoredDate: "2026-11-27T12:00:00Z",
      },
      { oid: "d", messageHeadline: "D", author: "x" },
    ],
    "en-US",
  );
  expect(days.map((d) => [d.label, d.commits.map((c) => c.oid)])).toEqual([
    ["Nov 26, 2026", ["a", "b"]],
    ["Nov 27, 2026", ["c"]],
    ["", ["d"]],
  ]);
});

test("groups checks by workflow, ungrouped ones last", () => {
  const check = (name: string, workflowName?: string) => ({
    name,
    status: "COMPLETED",
    conclusion: "SUCCESS",
    workflowName,
  });
  expect(
    prCheckGroups([
      check("deploy"),
      check("lint", "CI"),
      check("test", "CI"),
    ]).map((g) => [g.name, g.checks.map((c) => c.name)]),
  ).toEqual([
    ["CI", ["lint", "test"]],
    ["", ["deploy"]],
  ]);
});
