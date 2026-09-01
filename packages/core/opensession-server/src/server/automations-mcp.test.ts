import { describe, expect, test } from "bun:test";
import {
  automationBaselineMcpServers,
  automationWorkflowSessionPolicy,
} from "./automations";

describe("automation MCP fallback", () => {
  test("rebuilds the complete always-mounted automation-safe set", () => {
    const servers = automationBaselineMcpServers(
      { id: "auto-health", name: "Health Monitor" },
      "os-health-run",
    );

    expect(Object.keys(servers).sort()).toEqual([
      "opensession-audit",
      "opensession-health",
      "opensession-report",
      "opensession-turn",
    ]);
    for (const server of Object.values(servers)) {
      expect(server).toMatchObject({ type: "sdk" });
      expect((server as { instance?: unknown }).instance).toBeTruthy();
    }
  });

  test("durable sessions require a separate repository and Runner policy", () => {
    expect(
      automationWorkflowSessionPolicy({
        id: "auto-renderer",
        name: "Renderer",
        workflows: true,
        workflowSessions: true,
      }),
    ).toBeUndefined();
    expect(
      automationWorkflowSessionPolicy({
        id: "auto-renderer",
        name: "Renderer",
        workflows: true,
        workflowSessions: true,
        workflowSessionRepos: ["renderer"],
        workflowSessionRunners: ["mac-studio"],
      }),
    ).toEqual({
      automationId: "auto-renderer",
      automationName: "Renderer",
      allowedRepos: ["renderer"],
      allowedRunners: ["mac-studio"],
    });
  });
});
