import { describe, expect, test } from "bun:test";
import { githubAutomationKind, githubRunCredentialKind } from "./run-policy";

describe("githubAutomationKind", () => {
  test("matches the GitHub agent's github-* code workflow kinds", () => {
    for (const kind of [
      "github-review",
      "github-autofix",
      "github-simplify",
      "github-mention",
      "github-followup",
      "github-adversarial",
      "github-public-review",
    ])
      expect(githubAutomationKind(kind)).toBe(true);
  });

  test("ignores the recovery suffixes baseJournalKind strips", () => {
    expect(githubAutomationKind("github-review-resume")).toBe(true);
    expect(githubAutomationKind("github-autofix-rerun-fallback")).toBe(true);
  });

  test("does not match interactive or event-automation kinds", () => {
    for (const kind of [
      "prompt",
      "goal",
      "slack",
      "linear",
      "plain",
      "automation",
      undefined,
    ])
      expect(githubAutomationKind(kind)).toBe(false);
  });
});

describe("githubRunCredentialKind", () => {
  // (a) GitHub-automation code runs and review/handoff fix rounds earn the
  // repo-scoped App credential.
  test("github-* code workflows earn the repo-scoped App credential", () => {
    expect(
      githubRunCredentialKind({
        mode: "code",
        kind: "github-autofix",
        interactive: false,
      }),
    ).toBe("code");
  });

  test("a review/handoff fix round earns the App credential despite an interactive kind", () => {
    // The owning session is an interactive `prompt`, driven by auto-continue
    // (no user token resolves), so without the fix-round mark it would fall to
    // "user" and post as nobody. The mark lifts it to the App credential.
    expect(
      githubRunCredentialKind({
        mode: "code",
        kind: "prompt",
        fixRound: true,
        interactive: true,
      }),
    ).toBe("code");
  });

  // (b) Event-driven automations never receive the App credential.
  test("event automations never receive the App credential", () => {
    // Unattended event turns resolve nothing at all.
    for (const kind of ["plain", "automation"])
      expect(
        githubRunCredentialKind({ mode: "code", kind, interactive: false }),
      ).toBe("none");
    // slack/linear are interactive kinds, so a mapped user still posts as
    // themselves — but they must NEVER escalate to the repo-scoped App
    // credential the way a fix round does.
    for (const kind of ["slack", "linear"])
      expect(
        githubRunCredentialKind({ mode: "code", kind, interactive: true }),
      ).not.toBe("code");
    // A fix-round mark that somehow rode an event automation still cannot
    // reach the App credential unless the run is genuinely code mode with the
    // mark — an event automation carrying neither stays credential-free.
    expect(
      githubRunCredentialKind({
        mode: "code",
        kind: "plain",
        interactive: false,
      }),
    ).toBe("none");
  });

  // (c) Ordinary interactive turns are unchanged: the owner's own token.
  test("ordinary interactive turns keep the owner token", () => {
    expect(
      githubRunCredentialKind({
        mode: "code",
        kind: "prompt",
        interactive: true,
      }),
    ).toBe("user");
    expect(
      githubRunCredentialKind({
        mode: "ask",
        kind: "prompt",
        interactive: true,
      }),
    ).toBe("user");
  });

  test("a fix-round mark only earns the App credential in code mode", () => {
    // An ask-mode review round reads threads but does not push; it stays on the
    // interactive (user) path rather than minting a push-capable credential.
    expect(
      githubRunCredentialKind({
        mode: "ask",
        kind: "prompt",
        fixRound: true,
        interactive: true,
      }),
    ).toBe("user");
  });
});
