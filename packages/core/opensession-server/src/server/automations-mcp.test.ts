import { describe, expect, test } from "bun:test";
import {
  automationBaselineMcpServers,
  automationMode,
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
      "opensession-charts",
      "opensession-databases",
      "opensession-health",
      "opensession-report",
      "opensession-turn",
    ]);
    for (const server of Object.values(servers)) {
      expect(server).toMatchObject({ type: "sdk" });
      expect((server as { instance?: unknown }).instance).toBeTruthy();
    }
  });

  test("mounts opensession-web only when the allowlist names it", () => {
    expect(
      automationBaselineMcpServers(
        { id: "auto-web", name: "Watch", mcpServers: ["slack"] },
        "os-web-run",
      ),
    ).not.toHaveProperty("opensession-web");
    const servers = automationBaselineMcpServers(
      { id: "auto-web", name: "Watch", mcpServers: ["opensession-web"] },
      "os-web-run",
    );
    expect(servers["opensession-web"]).toMatchObject({ type: "sdk" });
  });

  test("mode accepts scratch and falls back to ask", () => {
    expect(automationMode("scratch")).toBe("scratch");
    expect(automationMode("code")).toBe("code");
    expect(automationMode("write")).toBe("ask");
    expect(automationMode(undefined)).toBe("ask");
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
