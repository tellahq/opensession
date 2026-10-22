import { describe, expect, test } from "bun:test";
import { appleReleasePlanId, isAppleReleasePlanTool } from "./apple-release";

describe("Apple release plan calls", () => {
  test("recognizes planning tools from either MCP naming", () => {
    expect(
      isAppleReleasePlanTool("mcp__apple-release__apple_release_plan_submit"),
    ).toBe(true);
    expect(
      isAppleReleasePlanTool("apple-release_apple_release_plan_testflight"),
    ).toBe(true);
    expect(
      isAppleReleasePlanTool("mcp__apple-release__apple_release_execute"),
    ).toBe(false);
    expect(isAppleReleasePlanTool("Bash")).toBe(false);
  });

  test("reads the plan ID from the tool's JSON result", () => {
    const id = "0f8b3c2e-1a2b-4c3d-8e9f-001122334455";
    const content = JSON.stringify(
      {
        plan: { schemaVersion: 1, id, action: "submit" },
        approvalRequired: true,
      },
      null,
      2,
    );
    expect(appleReleasePlanId(content)).toBe(id);
    expect(appleReleasePlanId(`{"planId":"${id}"}`)).toBeNull();
  });
});
