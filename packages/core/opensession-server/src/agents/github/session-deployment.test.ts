import { describe, expect, test } from "bun:test";
import {
  isSessionDeploymentFor,
  sessionDeploymentTarget,
} from "./session-deployment";

const BODY =
  "Fixes the thing.\n\nStarted by Ada in [this OS session](https://os.example.test/session/os-abc123)";

function target(
  overrides: Partial<Parameters<typeof sessionDeploymentTarget>[0]> = {},
) {
  return sessionDeploymentTarget({
    action: "opened",
    body: BODY,
    headRef: "feature-x",
    externalFork: false,
    state: "open",
    ...overrides,
  });
}

describe("sessionDeploymentTarget", () => {
  test("a session-opened PR deploys its branch to the footer's session", () => {
    expect(target()).toEqual({ sessionId: "os-abc123", headRef: "feature-x" });
  });

  test("pushes and body edits look too, so a failed first try is retried", () => {
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
    expect(target({ headRef: undefined })).toBeNull();
  });
});

describe("isSessionDeploymentFor", () => {
  test("the PR's existing link to the same session is reused", () => {
    expect(
      isSessionDeploymentFor(
        { payload: { pr: 7, sessionId: "os-abc123" } },
        7,
        "os-abc123",
      ),
    ).toBe(true);
    expect(
      isSessionDeploymentFor(
        { payload: '{"pr":7,"sessionId":"os-abc123"}' },
        7,
        "os-abc123",
      ),
    ).toBe(true);
  });

  test("another PR on the same branch, or another session, gets a new one", () => {
    const d = { payload: { pr: 7, sessionId: "os-abc123" } };
    expect(isSessionDeploymentFor(d, 8, "os-abc123")).toBe(false);
    expect(isSessionDeploymentFor(d, 7, "os-other")).toBe(false);
    expect(isSessionDeploymentFor({ payload: "" }, 7, "os-abc123")).toBe(false);
    expect(isSessionDeploymentFor({}, 7, "os-abc123")).toBe(false);
  });
});
