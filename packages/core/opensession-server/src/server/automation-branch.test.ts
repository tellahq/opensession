import { describe, expect, test } from "bun:test";
import { automationBranchName } from "./automation-branch";

const startedAt = new Date("2026-09-02T13:15:42.000Z");

describe("automation branch names", () => {
  test("separates concurrent event runs accepted in the same minute", () => {
    const first = automationBranchName({
      automationName: "Export failure investigation",
      startedAt,
      sessionId: "os-01a06660-ea9c-74e5-8c58-b6decf78f422",
    });
    const second = automationBranchName({
      automationName: "Export failure investigation",
      startedAt,
      sessionId: "os-01a06660-ea9c-74e5-8c58-111111111111",
    });

    expect(first).toBe(
      "auto-export-failure-investigation-202609021315-os-01a06660-ea9c-74e5-8c58-b6decf78f422",
    );
    expect(second).not.toBe(first);
  });

  test("keeps the branch stable when a durable intent resumes", () => {
    const input = {
      automationName: "Export failure investigation",
      startedAt,
      sessionId: "os-01a06660-ea9c-74e5-8c58-b6decf78f422",
    };

    expect(automationBranchName(input)).toBe(automationBranchName(input));
  });
});
