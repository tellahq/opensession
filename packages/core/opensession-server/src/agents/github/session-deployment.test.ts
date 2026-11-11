import { describe, expect, test } from "bun:test";
import { sessionDeploymentTarget } from "./session-deployment";

const BODY =
  "Fixes the thing.\n\nStarted by Ada in [this OS session](https://os.example.test/session/os-abc123)";

function target(
  overrides: Partial<Parameters<typeof sessionDeploymentTarget>[0]> = {},
) {
  return sessionDeploymentTarget({
    action: "opened",
    body: BODY,
    headSha: "deadbeef",
    externalFork: false,
    state: "open",
    ...overrides,
  });
}

describe("sessionDeploymentTarget", () => {
  test("a session-opened PR deploys its head to the footer's session", () => {
    expect(target()).toEqual({ sessionId: "os-abc123", headSha: "deadbeef" });
  });

  test("new heads and body edits deploy too", () => {
    for (const action of [
      "synchronize",
      "edited",
      "reopened",
      "ready_for_review",
    ])
      expect(target({ action })?.sessionId).toBe("os-abc123");
  });

  test("a body without the attribution footer deploys nothing", () => {
    expect(
      target({ body: "See https://os.example.test/session/os-abc123" }),
    ).toBeNull();
    expect(target({ body: null })).toBeNull();
  });

  test("forks, closed PRs, and unrelated actions deploy nothing", () => {
    expect(target({ externalFork: true })).toBeNull();
    expect(target({ action: "edited", state: "closed" })).toBeNull();
    expect(target({ action: "labeled" })).toBeNull();
    expect(target({ action: "closed" })).toBeNull();
    expect(target({ headSha: undefined })).toBeNull();
  });
});
