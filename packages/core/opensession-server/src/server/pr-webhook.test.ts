import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TeamMember } from "./config";
import {
  CI_COALESCE_MS,
  isCiWebhookEvent,
  reviewerRemovalClearsSessionRequest,
  sandboxEnvironmentInvalidationNeeded,
} from "./pr-webhook";
import { __setIdentitiesForTest } from "./shared/user-mappings";

// The reviewer check resolves a request's first name to a GitHub login
// through the roster, which is baked from this host's config at module load.
// On a host with no roster (CI) "Kent" resolves to nothing and the check
// reads a remaining "kentdebruin" as someone else, so the roster is a
// fixture here rather than whatever the machine happens to have.
const TEAM: TeamMember[] = [
  {
    name: "Kent de Bruin",
    email: "kent@example.com",
    aliases: ["kent"],
    github: "kentdebruin",
  },
];

let restore: (() => void) | undefined;
beforeAll(() => {
  restore = __setIdentitiesForTest(TEAM);
});
afterAll(() => restore?.());

describe("CI delivery coalescing", () => {
  test("folds check and workflow progress, not PR activity", () => {
    for (const event of ["check_run", "check_suite", "status", "workflow_run"])
      expect(isCiWebhookEvent(event)).toBe(true);
    for (const event of [
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
      "issue_comment",
      "push",
    ])
      expect(isCiWebhookEvent(event)).toBe(false);
  });

  test("waits long enough to absorb a job fan-out", () => {
    // A pipeline reports each job start and finish; one refresh per window
    // keeps a 25-minute run to a few dozen one-point detail reads per branch.
    expect(CI_COALESCE_MS).toBeGreaterThanOrEqual(15_000);
  });
});

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
