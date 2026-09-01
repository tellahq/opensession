import { describe, expect, test } from "bun:test";
import {
  assertAutomationDescendantOpeningIsolation,
  openingCreateTrustPolicy,
} from "./session-create";
import { sandboxRunSecuritySpec } from "./run-session";
import type { UnifiedSession } from "./types";
import {
  restoreResolvedCreate,
  snapshotOpeningCreate,
} from "./session-create-plan";

describe("automation descendant opening policy", () => {
  const descendant = {
    automationId: "auto-renderer",
    automationName: "Renderer swarm",
    mcpServers: [] as string[],
    repo: "renderer",
    publicationRepo: "tellahq/renderer",
    baseBranch: "main",
    allowedRunners: ["mac-studio"],
    publication: "branch-pr-only" as const,
  };

  test("opening dispatch rejects default-local and admits an explicit sandbox", () => {
    expect(() =>
      assertAutomationDescendantOpeningIsolation({
        automationDescendantPolicy: descendant,
        sandboxProvider: null,
        runnerTarget: undefined,
      }),
    ).toThrow(/isolated sandbox or Runner/);
    expect(() =>
      assertAutomationDescendantOpeningIsolation({
        automationDescendantPolicy: descendant,
        sandboxProvider: "docker",
        runnerTarget: undefined,
      }),
    ).not.toThrow();
  });

  test("opening turn is automation-scoped with no user, AWS, or MCP", () => {
    expect(
      openingCreateTrustPolicy({
        automationDescendantPolicy: descendant,
        branch: "compat/layout",
        runMcpServers: ["dangerous-parent-server"],
        user: "Automation (automation)",
      }),
    ).toEqual({
      automation: true,
      mcpServers: [],
      user: undefined,
      aws: false,
      trustProfile: "automation",
      publicationPolicy: {
        repo: "tellahq/renderer",
        branch: "main",
        headBranch: "compat/layout",
      },
    });
  });

  test("sandbox host spec preserves the complete descendant security boundary", () => {
    expect(
      sandboxRunSecuritySpec(
        {
          id: "os-child",
          startedBy: "human@example.com",
          branch: "compat/layout",
          automationDescendantPolicy: descendant,
        } as UnifiedSession,
        {
          isAutomationSession: true,
          user: "human@example.com",
          mcpServers: [],
          deniedTools: { mcp__stripe__refund: "automation policy" },
        },
      ),
    ).toEqual({
      mcpServers: [],
      proxyMcpServers: [],
      reposNote: undefined,
      deniedTools: { mcp__stripe__refund: "automation policy" },
      publicationPolicy: {
        repo: "tellahq/renderer",
        branch: "main",
        headBranch: "compat/layout",
      },
      aws: false,
      user: undefined,
      mcpGrantUser: undefined,
      journalKind: "automation",
      trustProfile: "automation",
    });
  });

  test("crash recovery preserves immutable descendant provenance", () => {
    const snapshot = snapshotOpeningCreate({
      id: "os-child",
      automationDescendantPolicy: descendant,
    });
    const restored = restoreResolvedCreate<{
      automationDescendantPolicy: typeof descendant;
    }>(snapshot);
    expect(restored.automationDescendantPolicy).toEqual(descendant);
  });
});
