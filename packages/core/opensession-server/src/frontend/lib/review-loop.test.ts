import { describe, expect, test } from "bun:test";
import { reviewLoopResult } from "./review-loop";

const base = {
  prNumber: 42,
  prState: "OPEN" as const,
  prReviewDecision: "",
  prChecks: { total: 8, passed: 8, failed: 0, pending: 0 },
  prOsReview: {
    verdict: "approve",
    confidence: 5,
    findings: 0,
    blocking: 0,
    stale: false,
    at: "2026-08-12T12:00:00Z",
  },
};

describe("reviewLoopResult", () => {
  test("passes when the latest review and checks are green", () => {
    expect(reviewLoopResult(base)).toEqual({
      status: "passed",
      confidence: 5,
      checksPassed: 8,
      checksFailed: 0,
      blocking: 0,
    });
  });

  test("fails for unresolved review findings or failed checks", () => {
    expect(
      reviewLoopResult({
        ...base,
        prOsReview: {
          ...base.prOsReview,
          verdict: "request_changes",
          findings: 2,
          blocking: 1,
        },
      }),
    ).toMatchObject({ status: "failed", blocking: 1 });
    expect(
      reviewLoopResult({
        ...base,
        prChecks: { total: 8, passed: 7, failed: 1, pending: 0 },
      }),
    ).toMatchObject({ status: "failed", checksFailed: 1 });
  });

  test("stays pending while the branch needs a fresh review", () => {
    expect(
      reviewLoopResult({
        ...base,
        prOsReview: { ...base.prOsReview, stale: true },
      }),
    ).toMatchObject({ status: "pending" });
    expect(
      reviewLoopResult({
        ...base,
        prChecks: { total: 8, passed: 7, failed: 0, pending: 1 },
      }),
    ).toMatchObject({ status: "pending" });
  });
});
