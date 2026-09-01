import { expect, test } from "bun:test";
import {
  mergeWorkflowSeed,
  runningAgentCount,
  sessionPrTargetKeys,
} from "./runtime-controller";

test("workflow seeds keep live snapshots and add only missing runs", () => {
  const live = { runId: "live", revision: 2 };
  const current = [live];
  const merged = mergeWorkflowSeed(current, [
    { runId: "live", revision: 1 },
    { runId: "seeded", revision: 1 },
  ]);

  expect(merged).toEqual([live, { runId: "seeded", revision: 1 }]);
  expect(mergeWorkflowSeed(current, [{ runId: "live", revision: 1 }])).toBe(
    current,
  );
});

test("PR target keys include primary, attached, and linked branches", () => {
  expect(
    sessionPrTargetKeys({
      repo: "primary",
      branch: "feature",
      attachedRepos: [
        {
          repo: "attached",
          branch: "attached-feature",
          dir: "/tmp/attached",
        },
      ],
      prs: [
        {
          repo: "linked",
          branch: "linked-feature",
          source: "linked",
        },
      ],
    }),
  ).toEqual([
    "primary\0feature",
    "attached\0attached-feature",
    "linked\0linked-feature",
  ]);
});

test("running agent count combines workflow and direct subagents", () => {
  expect(
    runningAgentCount(
      [
        {
          agents: [
            { status: "running" },
            { status: "done" },
            { status: "running" },
          ],
        },
      ],
      [{ status: "running" }, { status: "done" }],
    ),
  ).toBe(3);
});
