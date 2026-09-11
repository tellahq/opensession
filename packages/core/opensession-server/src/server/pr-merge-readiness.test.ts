import { describe, expect, test } from "bun:test";
import {
  assessPrMergeReadiness,
  formatPrMergeVerdict,
  type PrReadinessSource,
} from "./pr-merge-readiness";
import type { PrCheck } from "./pr-contract";

function check(
  name: string,
  conclusion: string,
  extra: Partial<PrCheck> = {},
): PrCheck {
  return {
    name,
    status: conclusion ? "COMPLETED" : "IN_PROGRESS",
    conclusion,
    workflowName: "CI",
    startedAt: "2026-09-11T12:00:00Z",
    ...extra,
  };
}

function source(overrides: Partial<PrReadinessSource> = {}): PrReadinessSource {
  return {
    repoId: "opensession",
    ghRepo: "acme/opensession",
    number: 374,
    title: "Port the dashboard",
    url: "https://github.com/acme/opensession/pull/374",
    author: "louise",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "dashboard",
    headRefOid: "8442c0c35b7502b514579f9f6589efadf01ca01b",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "",
    checks: [
      check("Type-check and tests", "SUCCESS"),
      check("Install", "SUCCESS"),
    ],
    latestReviews: [],
    reviewRequests: [],
    rules: { requiredChecks: [], requiredApprovals: 0, strictUpToDate: false },
    ...overrides,
  };
}

describe("assessPrMergeReadiness", () => {
  test("an open, clean, green PR with no review rule is ready", () => {
    const v = assessPrMergeReadiness(source());
    expect(v.ready).toBe(true);
    expect(v.blockers).toEqual([]);
    expect(v.summary).toBe(
      'PR #374 "Port the dashboard" is ready to merge: all 2 checks passing, no review required, no conflicts.',
    );
    expect(v.warnings).toEqual([
      "nobody has approved it, and no branch rule requires a review",
    ]);
    expect(v.checks.passing.map((c) => c.name)).toEqual([
      "CI / Type-check and tests",
      "CI / Install",
    ]);
  });

  test("names the approver when there is one", () => {
    const v = assessPrMergeReadiness(
      source({
        reviewDecision: "APPROVED",
        latestReviews: [
          { login: "bot", state: "COMMENTED" },
          { login: "michiel", state: "APPROVED" },
        ],
      }),
    );
    expect(v.ready).toBe(true);
    expect(v.review).toEqual({
      decision: "APPROVED",
      approvedBy: ["michiel"],
      changesRequestedBy: [],
      awaiting: [],
      requiredApprovals: 0,
    });
    expect(v.summary).toContain("approved by michiel");
    expect(v.warnings).toEqual([]);
  });

  test("conflicts plus a failing check list both, in fix order", () => {
    const v = assessPrMergeReadiness(
      source({
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        checks: [
          check("build-and-test", "FAILURE", {
            workflowName: "Native client CI",
          }),
          check("Type-check and tests", "SUCCESS"),
          check("Deploy preview", "", { workflowName: "Vercel" }),
        ],
      }),
    );
    expect(v.ready).toBe(false);
    expect(v.blockers).toEqual([
      "it has merge conflicts with main",
      "1 check is failing (Native client CI / build-and-test)",
      "1 check is still running (Vercel / Deploy preview)",
    ]);
    expect(v.summary).toBe(
      'PR #374 "Port the dashboard" is not ready to merge: it has merge conflicts with main, 1 check is failing (Native client CI / build-and-test), and 1 check is still running (Vercel / Deploy preview).',
    );
    expect(v.checks.failing[0].name).toBe("Native client CI / build-and-test");
    expect(v.checks.pending[0].name).toBe("Vercel / Deploy preview");
  });

  test("a draft is not ready even when everything else is green", () => {
    const v = assessPrMergeReadiness(
      source({ isDraft: true, mergeStateStatus: "DRAFT" }),
    );
    expect(v.ready).toBe(false);
    expect(v.blockers).toEqual(["it is still a draft"]);
  });

  test("changes requested names who asked", () => {
    const v = assessPrMergeReadiness(
      source({
        reviewDecision: "CHANGES_REQUESTED",
        latestReviews: [
          { login: "michiel", state: "CHANGES_REQUESTED" },
          { login: "louise", state: "APPROVED" },
        ],
      }),
    );
    expect(v.blockers).toEqual(["michiel requested changes"]);
    expect(v.review.decision).toBe("CHANGES_REQUESTED");
    expect(v.review.approvedBy).toEqual(["louise"]);
  });

  test("derives changes requested from reviews when GitHub gives no decision", () => {
    const v = assessPrMergeReadiness(
      source({
        latestReviews: [{ login: "michiel", state: "CHANGES_REQUESTED" }],
      }),
    );
    expect(v.ready).toBe(false);
    expect(v.review.decision).toBe("CHANGES_REQUESTED");
  });

  test("review required by a rule blocks, and counts approvals against the rule", () => {
    const required = assessPrMergeReadiness(
      source({
        reviewDecision: "REVIEW_REQUIRED",
        mergeStateStatus: "BLOCKED",
      }),
    );
    expect(required.blockers).toEqual(["it needs an approving review"]);

    const short = assessPrMergeReadiness(
      source({
        rules: {
          requiredChecks: [],
          requiredApprovals: 2,
          strictUpToDate: false,
        },
        latestReviews: [{ login: "louise", state: "APPROVED" }],
      }),
    );
    expect(short.blockers).toEqual(["it needs 2 approving reviews and has 1"]);
  });

  test("a required check that has not reported blocks, and required ones are marked", () => {
    const v = assessPrMergeReadiness(
      source({
        rules: {
          requiredChecks: ["Type-check and tests", "Secret scan"],
          requiredApprovals: 0,
          strictUpToDate: true,
        },
      }),
    );
    expect(v.blockers).toEqual([
      "1 required check has not reported (Secret scan)",
    ]);
    expect(v.checks.missingRequired).toEqual(["Secret scan"]);
    expect(
      v.checks.passing.find((c) => c.name === "CI / Type-check and tests")
        ?.required,
    ).toBe(true);
    expect(v.rules).toEqual({
      readable: true,
      requiredChecks: ["Type-check and tests", "Secret scan"],
      requiredApprovals: 0,
      strictUpToDate: true,
    });
  });

  test("unknown mergeability is not ready and says to ask again", () => {
    const v = assessPrMergeReadiness(
      source({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }),
    );
    expect(v.ready).toBe(false);
    expect(v.blockers).toEqual([
      "GitHub is still computing whether it merges cleanly, so ask again in a moment",
    ]);
  });

  test("BLOCKED with nothing readable wrong is reported, never called ready", () => {
    const v = assessPrMergeReadiness(
      source({ mergeStateStatus: "BLOCKED", rules: null }),
    );
    expect(v.ready).toBe(false);
    expect(v.blockers).toEqual([
      "GitHub reports the merge is blocked by a branch rule that is not readable here",
    ]);
    expect(v.rules.readable).toBe(false);
    expect(v.warnings[0]).toBe(
      "branch rules could not be read, so the verdict leans on GitHub's merge state",
    );
  });

  test("BEHIND asks for an update", () => {
    const v = assessPrMergeReadiness(source({ mergeStateStatus: "BEHIND" }));
    expect(v.blockers).toEqual([
      "the branch is behind main and needs updating",
    ]);
  });

  test("merged and closed PRs are terminal, not blockers to fix", () => {
    const merged = assessPrMergeReadiness(
      source({
        state: "MERGED",
        mergeable: "UNKNOWN",
        mergeStateStatus: "UNKNOWN",
      }),
    );
    expect(merged.ready).toBe(false);
    expect(merged.summary).toBe(
      'PR #374 "Port the dashboard" was already merged.',
    );
    expect(merged.blockers).toEqual(["it was already merged"]);

    const closed = assessPrMergeReadiness(source({ state: "CLOSED" }));
    expect(closed.summary).toBe(
      'PR #374 "Port the dashboard" is closed and was not merged.',
    );
  });

  test("status contexts and skipped runs are classified", () => {
    const v = assessPrMergeReadiness(
      source({
        checks: [
          { name: "Vercel", status: "COMPLETED", conclusion: "PENDING" },
          {
            name: "Lint",
            status: "COMPLETED",
            conclusion: "SKIPPED",
            workflowName: "CI",
            startedAt: "2026-09-11T12:00:00Z",
          },
          {
            name: "Build",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            workflowName: "CI",
            startedAt: "2026-09-11T12:00:00Z",
          },
        ],
      }),
    );
    expect(v.checks.pending.map((c) => c.name)).toEqual(["Vercel"]);
    expect(v.checks.skipped.map((c) => c.name)).toEqual(["CI / Lint"]);
    expect(v.blockers).toEqual(["1 check is still running (Vercel)"]);
    expect(v.warnings).toContain("1 check skipped");
  });

  test("pending review requests are a note, not a blocker", () => {
    const v = assessPrMergeReadiness(source({ reviewRequests: ["michiel"] }));
    expect(v.ready).toBe(true);
    expect(v.warnings).toContain("still awaiting a review from michiel");
  });
});

describe("formatPrMergeVerdict", () => {
  test("leads with the sentence, lists checks by state, ends with the JSON verdict", () => {
    const v = assessPrMergeReadiness(
      source({
        checks: [
          check("build-and-test", "FAILURE", {
            workflowName: "Native client CI",
          }),
          check("Type-check and tests", "SUCCESS"),
        ],
        rules: {
          requiredChecks: ["Type-check and tests"],
          requiredApprovals: 1,
          strictUpToDate: false,
        },
        latestReviews: [{ login: "michiel", state: "APPROVED" }],
      }),
    );
    const out = formatPrMergeVerdict(v);
    const lines = out.split("\n");
    expect(lines[0]).toBe(v.summary);
    expect(lines[1]).toBe(v.pr.url);
    expect(lines[2]).toBe(
      "State: open · mergeable MERGEABLE (CLEAN) · dashboard → main @ 8442c0c",
    );
    expect(out).toContain("Checks: 1 passing, 1 failing, 0 pending");
    expect(out).toContain("  ✗ Native client CI / build-and-test");
    expect(out).toContain("  ✓ CI / Type-check and tests (required)");
    expect(out).toContain("Review: approved · approved by michiel");
    expect(out).toContain(
      "Branch rules on main: required checks Type-check and tests · 1 approval required",
    );
    const json = out.slice(out.indexOf("```json") + 7, out.lastIndexOf("```"));
    expect(JSON.parse(json)).toEqual(v);
  });
});
