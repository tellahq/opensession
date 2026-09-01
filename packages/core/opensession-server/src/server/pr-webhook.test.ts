import { describe, expect, test } from "bun:test";
import {
  reviewerRemovalClearsSessionRequest,
  sandboxEnvironmentInvalidationNeeded,
} from "./pr-webhook";

describe("review request webhook sync", () => {
  test("clears a mirrored person request when GitHub removes it", () => {
    expect(
      reviewerRemovalClearsSessionRequest(
        {
          action: "review_request_removed",
          repository: { owner: { login: "tellahq" } },
          pull_request: { requested_reviewers: [], requested_teams: [] },
        },
        "Kent",
      ),
    ).toBe(true);
  });

  test("keeps the local request while its GitHub reviewer or team remains", () => {
    const base = {
      action: "review_request_removed",
      repository: { owner: { login: "tellahq" } },
    };
    expect(
      reviewerRemovalClearsSessionRequest(
        {
          ...base,
          pull_request: {
            requested_reviewers: [{ login: "kentdebruin" }],
            requested_teams: [],
          },
        },
        "Kent",
      ),
    ).toBe(false);
    expect(
      reviewerRemovalClearsSessionRequest(
        {
          ...base,
          pull_request: {
            requested_reviewers: [],
            requested_teams: [{ slug: "infra-reviewers" }],
          },
        },
        "tellahq/infra-reviewers",
      ),
    ).toBe(false);
  });
});

describe("sandbox environment webhook invalidation", () => {
  test("accepts only actual default-branch source updates", () => {
    expect(
      sandboxEnvironmentInvalidationNeeded(
        "push",
        { ref: "refs/heads/main" },
        "main",
      ),
    ).toBe(true);
    expect(
      sandboxEnvironmentInvalidationNeeded(
        "push",
        { ref: "refs/heads/feature" },
        "main",
      ),
    ).toBe(false);
    expect(
      sandboxEnvironmentInvalidationNeeded(
        "pull_request",
        {
          action: "closed",
          pull_request: { merged: true, base: { ref: "main" } },
        },
        "main",
      ),
    ).toBe(true);
  });

  test("does not invalidate for ordinary default-branch workflow activity", () => {
    expect(
      sandboxEnvironmentInvalidationNeeded(
        "workflow_run",
        { workflow_run: { head_branch: "main" } },
        "main",
      ),
    ).toBe(false);
    expect(
      sandboxEnvironmentInvalidationNeeded(
        "check_run",
        { check_run: { check_suite: { head_branch: "main" } } },
        "main",
      ),
    ).toBe(false);
  });
});
