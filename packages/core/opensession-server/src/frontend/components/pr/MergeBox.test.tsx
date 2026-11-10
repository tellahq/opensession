import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { prStatusMark } from "../../lib/pr-status";
import type { PrDetails } from "../../lib/types";
import { MergeBox } from "./MergeBox";

const pr: PrDetails = {
  number: 7,
  title: "Retry uploads",
  url: "https://github.com/acme/project/pull/7",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "retry-uploads",
  additions: 3,
  deletions: 1,
  changedFiles: 1,
  reviewDecision: "APPROVED",
  author: "acme",
  body: "",
  checks: [],
  reviewers: [{ login: "reviewer", state: "APPROVED" }],
};

function render(
  overrides: Partial<PrDetails>,
  checks = { passed: 4, failed: 0, pending: 0 },
) {
  const details = { ...pr, ...overrides };
  const summary = {
    ...checks,
    total: checks.passed + checks.failed + checks.pending,
  };
  return renderToStaticMarkup(
    <MergeBox
      status={{
        git: null,
        pr: details,
        sessionId: "example-session",
        onRefresh: () => {},
        onMerge: () => {},
        merge: { primary: "merge", all: ["merge"], onChoose: () => {} },
      }}
      statusMark={prStatusMark({ ...details, checks: summary })}
      checks={summary}
      showChecks
      showApprovals
      commentCount={2}
      onShowChecks={() => {}}
      onShowComments={() => {}}
    />,
  );
}

test("a ready pull request leads with its merge action and the readout", () => {
  const html = render({});
  expect(html).toContain("Ready to merge");
  expect(html).toContain("All requirements are met");
  expect(html).toContain(">Merge<");
  expect(html).toContain("4 passed");
  expect(html).toContain("2 comments");
  expect(html).toContain("1 approved");
  expect(html).toContain("grid-cols-3");
});

test("a blocked pull request names what stands in the way", () => {
  const html = render(
    { mergeable: "CONFLICTING" },
    { passed: 3, failed: 1, pending: 0 },
  );
  expect(html).toContain("Merge conflicts");
  expect(html).toContain("Conflicts with main must be resolved first");
  expect(html).toContain("1 failed of 4");
});

test("a merged pull request says where it landed", () => {
  const html = render({ state: "MERGED" });
  expect(html).toContain("Merged");
  expect(html).toContain("Merged into main");
  expect(html).not.toContain(">Merge<");
});
