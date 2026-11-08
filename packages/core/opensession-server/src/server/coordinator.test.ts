import { describe, expect, test } from "bun:test";
import { coordinatorNote, isCoordinating } from "./coordinator";

describe("isCoordinating", () => {
  test("the session's own setting wins", () => {
    expect(isCoordinating({ coordinator: true }, null)).toBe(true);
    expect(
      isCoordinating(
        { coordinator: false, workspaceId: "ws-a" },
        { id: "ws-a", space: true },
      ),
    ).toBe(false);
  });

  test("a legacy space's root session coordinates until switched off", () => {
    expect(
      isCoordinating({ workspaceId: "ws-a" }, { id: "ws-a", space: true }),
    ).toBe(true);
    expect(
      isCoordinating(
        { workspaceId: "ws-a", parentSessionId: "bks-root" },
        { id: "ws-a", space: true },
      ),
    ).toBe(false);
  });

  test("an ordinary session does not", () => {
    expect(isCoordinating({ workspaceId: "ws-a" }, { id: "ws-a" })).toBe(false);
    expect(isCoordinating({}, null)).toBe(false);
  });
});

describe("coordinatorNote", () => {
  test("asks for delegation and names the workspace, project and goal", () => {
    const note = coordinatorNote({
      workspaceName: "Checkout v2",
      repo: "acme",
      goal: "Ship coupons",
      hasCheckout: false,
    });
    expect(note).toContain('the workspace "Checkout v2"');
    expect(note).toContain("`acme`");
    expect(note).toContain("The workspace's goal: Ship coupons");
    expect(note).toContain("isolatedWorktree true");
    expect(note).toContain("no checkout");
  });

  test("a session with a checkout reads code but changes it in threads", () => {
    const note = coordinatorNote({ repo: "acme", hasCheckout: true });
    expect(note).toContain("You have a checkout");
    expect(note).not.toContain("goal:");
  });

  test("tells a repo-less coordinator to pick a repo per thread", () => {
    expect(coordinatorNote({ hasCheckout: false })).toContain(
      "There is no project repository",
    );
  });
});
