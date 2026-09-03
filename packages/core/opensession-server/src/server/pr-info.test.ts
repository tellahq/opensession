import { describe, expect, test } from "bun:test";
import {
  cachedPrDetailsForSession,
  ghApiErrorMessage,
  isNoPrError,
  knownPrNumberForBranch,
  latestWorkflowChecks,
  notePrNumberForBranch,
  prApiErrorMessage,
  reconcilePrDetails,
  type PrDetails,
} from "./pr-info";
import type { UnifiedSession } from "./types";

describe("branch to PR number memo", () => {
  const repo = "tellahq/pr-info-memo-test";

  test("remembers an open PR and forgets it once it is not open", () => {
    notePrNumberForBranch(repo, "feature", 41, "OPEN");
    expect(knownPrNumberForBranch(repo, "feature")).toBe(41);
    notePrNumberForBranch(repo, "feature", 41, "MERGED");
    expect(knownPrNumberForBranch(repo, "feature")).toBeUndefined();
  });

  test("never memoizes a malformed number", () => {
    notePrNumberForBranch(repo, "odd", "41", "OPEN");
    expect(knownPrNumberForBranch(repo, "odd")).toBeUndefined();
  });

  test("keys by repository so a shared branch name cannot collide", () => {
    notePrNumberForBranch(repo, "shared", 7, "OPEN");
    expect(knownPrNumberForBranch("tellahq/other", "shared")).toBeUndefined();
  });
});

describe("isNoPrError", () => {
  test("only accepts GitHub's explicit no-PR response", () => {
    expect(isNoPrError('no pull requests found for branch "missing"')).toBe(
      true,
    );
    expect(
      isNoPrError("Could not resolve to a PullRequest with the number of 999"),
    ).toBe(true);
    expect(isNoPrError("Could not resolve host: api.github.com")).toBe(false);
    expect(
      isNoPrError(
        "Could not resolve to a Repository with the name 'owner/repo'",
      ),
    ).toBe(false);
  });
});

describe("prApiErrorMessage", () => {
  test("explains GitHub rate limits without exposing CLI output", () => {
    expect(
      prApiErrorMessage(
        "GraphQL: API rate limit already exceeded for user ID 123",
      ),
    ).toBe(
      "GitHub's API rate limit has been reached. Try again after it resets.",
    );
  });

  test("explains authentication failures", () => {
    expect(prApiErrorMessage("HTTP 401: Bad credentials")).toBe(
      "GitHub authentication failed. Check the GitHub connection.",
    );
  });

  test("keeps unknown upstream failures generic", () => {
    expect(prApiErrorMessage("stream error: INTERNAL_ERROR")).toBe(
      "GitHub's pull request API is unavailable right now.",
    );
  });
});

describe("latestWorkflowChecks", () => {
  test("keeps only the newest run of a workflow job", () => {
    const checks = latestWorkflowChecks([
      {
        name: "Deploy",
        workflowName: "Preview",
        status: "COMPLETED",
        conclusion: "FAILURE",
        startedAt: "2026-08-04T15:50:53Z",
      },
      {
        name: "Deploy",
        workflowName: "Preview",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        startedAt: "2026-08-10T10:11:27Z",
      },
    ]);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.conclusion).toBe("SUCCESS");
  });

  test("does not combine commit status contexts", () => {
    const checks = latestWorkflowChecks([
      { name: "Vercel", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Vercel", status: "COMPLETED", conclusion: "SUCCESS" },
    ]);

    expect(checks).toHaveLength(2);
  });
});

describe("cached session PR details", () => {
  const session = {
    repo: "tella-fusion",
    branch: "feature",
    prNumber: 5016,
    prUrl: "https://github.com/tellahq/tella-fusion/pull/5016",
    prState: "MERGED",
    prTitle: "Merged feature",
    prAdditions: 10,
    prDeletions: 2,
    prs: [
      {
        repo: "tella-fusion",
        branch: "feature",
        source: "primary",
        number: 5016,
        url: "https://github.com/tellahq/tella-fusion/pull/5016",
        state: "MERGED",
        title: "Merged feature",
      },
      {
        repo: "shared-infra",
        branch: "infra-feature",
        source: "attached",
      },
    ],
  } as UnifiedSession;

  test("serves the known merged PR when the detail query is unavailable", () => {
    const fallback = cachedPrDetailsForSession(
      session,
      "tella-fusion",
      "feature",
    );

    expect(fallback?.state).toBe("MERGED");
    expect(fallback?.number).toBe(5016);
    expect(fallback?.headRefName).toBe("feature");
  });

  test("does not invent a PR for a bare attached branch", () => {
    expect(
      cachedPrDetailsForSession(session, "shared-infra", "infra-feature"),
    ).toBeNull();
  });

  test("keeps irreversible merged state over stale OPEN details", () => {
    const fallback = cachedPrDetailsForSession(
      session,
      "tella-fusion",
      "feature",
    )!;
    const stale = { ...fallback, state: "OPEN" } as PrDetails;

    expect(reconcilePrDetails(stale, fallback)?.state).toBe("MERGED");
    expect(reconcilePrDetails(stale, fallback)?.isDraft).toBe(false);
  });

  test("does not synthesize actionable details for an open PR", () => {
    expect(
      cachedPrDetailsForSession(
        { ...session, prState: "OPEN", prs: undefined } as UnifiedSession,
        "tella-fusion",
        "feature",
      ),
    ).toBeNull();
  });
});

describe("ghApiErrorMessage", () => {
  // Verbatim bodies from POST /pulls/{n}/reviews, whose stderr line is only
  // ever "gh: Unprocessable Entity (HTTP 422)".
  const bareStderr = "gh: Unprocessable Entity (HTTP 422)\n";

  test("recovers the reason gh drops, and says what to do about it", () => {
    expect(
      ghApiErrorMessage(
        '{"message":"Unprocessable Entity","errors":["Line could not be resolved"],"status":"422"}',
        bareStderr,
        "gh api failed",
      ),
    ).toBe(
      "Line could not be resolved. The comment no longer matches the PR's current diff. Reload the diff and add it again.",
    );
    expect(
      ghApiErrorMessage(
        '{"message":"Unprocessable Entity","errors":["Path could not be resolved"],"status":"422"}',
        bareStderr,
        "gh api failed",
      ),
    ).toContain("Path could not be resolved.");
  });

  test("keeps a message that carries information, and object-shaped errors", () => {
    expect(
      ghApiErrorMessage(
        '{"message":"Validation Failed","errors":[{"resource":"PullRequestReview","code":"custom","message":"Can not approve your own pull request"}]}',
        "gh: Validation Failed (HTTP 422)",
        "gh api failed",
      ),
    ).toBe("Validation Failed: Can not approve your own pull request");
  });

  test("falls back to stderr, then to the caller's fallback", () => {
    expect(
      ghApiErrorMessage(
        "not json",
        "gh: Not Found (HTTP 404)",
        "gh api failed",
      ),
    ).toBe("gh: Not Found (HTTP 404)");
    expect(ghApiErrorMessage("", "", "gh api failed")).toBe("gh api failed");
  });
});

describe("durable PR detail restart grace", () => {
  test("does not replay an expired rich refresh immediately after boot", async () => {
    const { shouldRefreshPrDetails } = await import("./pr-info");
    const now = 1_000_000;
    expect(shouldRefreshPrDetails(now - 6 * 60_000, now, now - 30_000)).toBe(
      false,
    );
    expect(
      shouldRefreshPrDetails(now - 6 * 60_000, now, now - 11 * 60_000),
    ).toBe(true);
  });

  test("keeps a still-fresh durable row fresh regardless of process age", async () => {
    const { shouldRefreshPrDetails } = await import("./pr-info");
    const now = 1_000_000;
    expect(shouldRefreshPrDetails(now - 60_000, now, 0)).toBe(false);
  });
});
