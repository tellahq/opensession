import type { UnifiedSession } from "./types";

export interface ReviewLoopResult {
  status: "pending" | "passed" | "failed";
  confidence?: number;
  checksPassed?: number;
  checksFailed?: number;
  blocking?: number;
}

type SessionReviewState = Pick<
  UnifiedSession,
  "prNumber" | "prState" | "prReviewDecision" | "prChecks" | "prOsReview"
>;

/** Turn the latest GitHub facts into the state shown on the review-loop row. */
export function reviewLoopResult(
  session: SessionReviewState,
): ReviewLoopResult | undefined {
  if (!session.prNumber || session.prState !== "OPEN" || !session.prOsReview)
    return undefined;

  const review = session.prOsReview;
  const checks = session.prChecks;
  const facts = {
    confidence: review.confidence,
    checksPassed: checks?.passed,
    checksFailed: checks?.failed,
    blocking: review.blocking,
  };

  if (review.stale || (checks?.pending || 0) > 0) {
    return { status: "pending", ...facts };
  }

  const failed =
    (checks?.failed || 0) > 0 ||
    session.prReviewDecision === "CHANGES_REQUESTED" ||
    review.verdict === "request_changes" ||
    review.blocking > 0 ||
    (review.findings > 0 && (review.confidence ?? 0) < 4);
  return { status: failed ? "failed" : "passed", ...facts };
}
