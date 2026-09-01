import { afterEach, describe, expect, test } from "bun:test";
import { GithubAgent, recoveryPermitted } from "./index";
import { SlackAgent } from "../slack/index";
import type { GithubPrState } from "./state";

const originalGithub = process.env.ENABLE_GITHUB_AGENT;
const originalSlack = process.env.ENABLE_SLACK_AGENT;
const originalWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

afterEach(() => {
  if (originalGithub === undefined) delete process.env.ENABLE_GITHUB_AGENT;
  else process.env.ENABLE_GITHUB_AGENT = originalGithub;
  if (originalSlack === undefined) delete process.env.ENABLE_SLACK_AGENT;
  else process.env.ENABLE_SLACK_AGENT = originalSlack;
  if (originalWebhookSecret === undefined)
    delete process.env.GITHUB_WEBHOOK_SECRET;
  else process.env.GITHUB_WEBHOOK_SECRET = originalWebhookSecret;
});

describe("webhook route ownership", () => {
  test("GitHub-only registration belongs to GitHub", () => {
    process.env.ENABLE_GITHUB_AGENT = "true";
    process.env.ENABLE_SLACK_AGENT = "false";
    expect(new GithubAgent().getRoutes().has("POST /github/webhook")).toBe(
      true,
    );
    expect(new SlackAgent().getRoutes().has("POST /github/webhook")).toBe(
      false,
    );
  });

  test("Slack-only registration uses the GitHub compatibility handler", () => {
    process.env.ENABLE_GITHUB_AGENT = "false";
    process.env.ENABLE_SLACK_AGENT = "true";
    process.env.GITHUB_WEBHOOK_SECRET = "configured";
    expect(new SlackAgent().getRoutes().has("POST /github/webhook")).toBe(true);
    expect(new SlackAgent().health()).toMatchObject({
      githubWebhookConfigured: true,
      githubCredentialMode: "app",
      githubWebhooksReceived: expect.any(Number),
    });
  });

  test("both enabled leaves route ownership with GitHub", () => {
    process.env.ENABLE_GITHUB_AGENT = "true";
    process.env.ENABLE_SLACK_AGENT = "true";
    expect(new GithubAgent().getRoutes().has("POST /github/webhook")).toBe(
      true,
    );
    expect(new SlackAgent().getRoutes().has("POST /github/webhook")).toBe(
      false,
    );
    expect(new SlackAgent().health()).not.toHaveProperty(
      "githubWebhooksReceived",
    );
  });
});

const AT = "2026-08-25T15:42:45.000Z";

function prState(patch: Partial<GithubPrState>): GithubPrState {
  return {
    prNumber: 99,
    headRef: "harden-personal-mcp-oauth",
    reviewedShas: [],
    updatedAt: AT,
    ...patch,
  };
}

describe("boot recovery trust gate", () => {
  // Regression (PR #99, 2026-08-25): a webhook/reconcile review interrupted by a
  // restart was refused as "untrusted @unknown" and its marker cleared, throwing
  // away the finished run's durable reviewResult and leaving the PR comment
  // spinning "Reviewing..." forever.
  test("an automation review with no requester is resumable", () => {
    const s = prState({
      activeRun: { kind: "review", requestedBy: "", startedAt: AT },
    });
    expect(recoveryPermitted(s, "run")).toBe(true);
  });

  test("the exemption does not extend to simplify or adversarial", () => {
    for (const kind of ["simplify", "adversarial"] as const) {
      const s = prState({
        activeRun: { kind, requestedBy: "", startedAt: AT },
      });
      expect(recoveryPermitted(s, "run")).toBe(false);
    }
  });

  test("a review requested by an untrusted person is still refused", () => {
    const s = prState({
      activeRun: {
        kind: "review",
        requestedBy: "not-on-the-team-2b9f1c",
        startedAt: AT,
      },
    });
    expect(recoveryPermitted(s, "run")).toBe(false);
  });

  test("person-initiated markers still require a trusted requester", () => {
    expect(
      recoveryPermitted(
        prState({
          autoFix: {
            active: true,
            iterations: 1,
            startedAt: AT,
            requestedBy: "",
          },
        }),
        "auto-fix",
      ),
    ).toBe(false);
    expect(
      recoveryPermitted(
        prState({ pendingAutoFix: { requestedBy: "", receivedAt: AT } }),
        "pending-auto-fix",
      ),
    ).toBe(false);
    expect(
      recoveryPermitted(
        prState({
          activeMention: {
            author: "",
            body: "hi",
            kind: "issue",
            startedAt: AT,
          },
        }),
        "mention",
      ),
    ).toBe(false);
    expect(
      recoveryPermitted(
        prState({
          pendingMention: {
            kind: "issue",
            commentId: 7,
            body: "hi",
            author: "",
            receivedAt: AT,
          },
        }),
        "pending-mention",
      ),
    ).toBe(false);
  });
});
