import { describe, expect, test } from "bun:test";
import {
  assertAutomationDescendantOpeningIsolation,
  openingCreateTrustPolicy,
} from "./session-create";
import { sandboxRunSecuritySpec } from "./run-session";
import { runAccountSpec } from "./session-run-inputs";
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
        sandboxProvider: "daytona",
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
      mcpGrantUser: undefined,
      aws: false,
      trustProfile: "automation",
      publicationPolicy: {
        repo: "tellahq/renderer",
        branch: "main",
        headBranch: "compat/layout",
      },
    });
  });

  test("interactive opening and sandbox runs use the verified creator login", () => {
    expect(
      openingCreateTrustPolicy({
        automationDescendantPolicy: undefined,
        branch: "preview",
        runMcpServers: ["tella-stage"],
        user: "Alex",
        createdByLogin: "alex-two",
      }).mcpGrantUser,
    ).toBe("alex-two");
    expect(
      sandboxRunSecuritySpec(
        {
          id: "os-interactive",
          startedBy: "Alex",
          createdByLogin: "alex-two",
        } as UnifiedSession,
        {
          isAutomationSession: false,
          user: "Alex",
          mcpServers: ["tella-stage"],
        },
      ).mcpGrantUser,
    ).toBe("alex-two");
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
          accountUser: "human@example.com",
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
      // Only the person's provider subscription follows them across the
      // boundary; MCP, GitHub and trust identities stay dropped.
      accountUser: "human@example.com",
      journalKind: "automation",
      trustProfile: "automation",
    });
  });

  test("account routing keeps the automation pin for machine turns only", () => {
    const session = { accountId: "shared-triage" };
    const automation = { accountId: "shared-triage", usageCredits: true };
    const machineTurn = { isAutomationSession: true, accountUser: undefined };
    const humanTurn = {
      isAutomationSession: true,
      accountUser: "human@example.com",
    };
    const noPin = {
      accountId: undefined,
      accountStrict: undefined,
      usageCredits: undefined,
    };
    // A disposable sandbox resume hard-pins the automation's own turns.
    expect(runAccountSpec(session, machineTurn, automation)).toEqual({
      accountId: "shared-triage",
      accountStrict: true,
      usageCredits: true,
    });
    // Host, Runner and pi-host turns keep the session's soft pin for the
    // automation's own turns.
    expect(runAccountSpec(session, machineTurn)).toEqual({
      accountId: "shared-triage",
      accountStrict: undefined,
      usageCredits: undefined,
    });
    // The person who took the session over spends their own subscription
    // first with the pool as backup on every launch path: no pin (a pin is
    // tried before personal accounts), no strict cap, their own credit
    // policy.
    expect(runAccountSpec(session, humanTurn, automation)).toEqual(noPin);
    expect(runAccountSpec(session, humanTurn)).toEqual(noPin);
    // Interactive sessions keep their own soft pin.
    expect(
      runAccountSpec(
        { accountId: "mine" },
        { isAutomationSession: false, accountUser: "human@example.com" },
      ),
    ).toEqual({
      accountId: "mine",
      accountStrict: undefined,
      usageCredits: undefined,
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
