/**
 * The per-turn run inputs a session resolves to. These branches are the
 * security-relevant half of run-session.ts: an automation-owned session must
 * keep its allowlist and denials on an interactive resume, and must pass no
 * user so an allowedUsers-gated MCP server stays invisible to it.
 */

import { describe, expect, test } from "bun:test";
import {
  resolveSessionRunInputs,
  sessionInProcessMcpBranch,
  sessionMcpScopeSource,
  type RunInputsSession,
} from "./session-run-inputs";

const plain: RunInputsSession = {
  automation: undefined,
  mcpServers: undefined,
  externalRefs: undefined,
  goalId: undefined,
  startedBy: "Michiel",
};

describe("sessionMcpScopeSource", () => {
  test("an automation-owned session is scoped by its automation", () => {
    expect(
      sessionMcpScopeSource({ ...plain, automation: "Plain ticket triage" }),
    ).toBe("automation");
  });

  test("the automation wins over a stamped session allowlist", () => {
    expect(
      sessionMcpScopeSource({
        ...plain,
        automation: "Plain ticket triage",
        mcpServers: ["slack"],
      }),
    ).toBe("automation");
  });

  test("a stamped allowlist is used when there is no automation", () => {
    expect(sessionMcpScopeSource({ ...plain, mcpServers: ["slack"] })).toBe(
      "session",
    );
  });

  test("an EMPTY stamped allowlist is not an allowlist", () => {
    // [] is truthy, and reading it as a restriction is what once kicked every
    // follow-up prompt off the shared server pool (bks-019f818d).
    expect(sessionMcpScopeSource({ ...plain, mcpServers: [] })).toBe("all");
  });

  test("a feed-workspace session falls back to its feed's servers", () => {
    expect(
      sessionMcpScopeSource({
        ...plain,
        externalRefs: [{ kind: "tella-video", id: "v1" }],
      }),
    ).toBe("feed");
  });

  test("a plain session has no allowlist", () => {
    expect(sessionMcpScopeSource(plain)).toBe("all");
  });
});

describe("sessionInProcessMcpBranch", () => {
  test("automation-owned sessions never get the interactive servers", () => {
    expect(
      sessionInProcessMcpBranch({ ...plain, automation: "Health monitor" }),
    ).toBe("automation-self-improve");
  });

  test("an automation-owned GOAL session still stays on the automation branch", () => {
    expect(
      sessionInProcessMcpBranch({
        ...plain,
        automation: "Health monitor",
        goalId: "g1",
      }),
    ).toBe("automation-self-improve");
  });

  test("a goal session adds its own controls", () => {
    expect(sessionInProcessMcpBranch({ ...plain, goalId: "g1" })).toBe(
      "interactive+goal-self",
    );
  });

  test("a normal session gets the interactive set", () => {
    expect(sessionInProcessMcpBranch(plain)).toBe("interactive");
  });
});

describe("resolveSessionRunInputs", () => {
  test("a normal session keeps the prompter and gets no denials", async () => {
    const inputs = await resolveSessionRunInputs(plain, { user: "Kent" });
    expect(inputs.isAutomationSession).toBe(false);
    expect(inputs.mcpServers).toBeUndefined();
    expect(inputs.mcpServersSource).toBe("all");
    expect(inputs.deniedTools).toBeUndefined();
    expect(inputs.user).toBe("Kent");
    expect(inputs.mcpGrantUser).toBe("Michiel");
    expect(inputs.sessionNote).toBe(true);
  });

  test("a stamped allowlist rides through verbatim", async () => {
    const inputs = await resolveSessionRunInputs(
      { ...plain, mcpServers: ["slack", "linear"] },
      { user: "Kent" },
    );
    expect(inputs.mcpServers).toEqual(["slack", "linear"]);
    expect(inputs.mcpServersSource).toBe("session");
  });

  test("an automation-owned session drops the user and carries the denials", async () => {
    const inputs = await resolveSessionRunInputs(
      { ...plain, automation: "Plain ticket triage" },
      { user: "Kent" },
    );
    expect(inputs.isAutomationSession).toBe(true);
    // The gate that keeps allowedUsers-scoped servers invisible to untrusted
    // text: an automation run passes no user at all.
    expect(inputs.user).toBeUndefined();
    expect(inputs.deniedTools).toBeDefined();
    expect(inputs.deniedTools).toHaveProperty("mcp__plain__reply_to_thread");
    // No memory / repos / personal-prompt note for an automation run.
    expect(inputs.sessionNote).toBe(false);
    expect(inputs.inProcessMcpBranch).toBe("automation-self-improve");
  });

  test("an automation descendant keeps immutable empty scope on resume", async () => {
    const inputs = await resolveSessionRunInputs(
      {
        ...plain,
        automation: undefined,
        mcpServers: ["dangerous-later-config"],
        automationDescendantPolicy: {
          automationId: "auto-1",
          automationName: "Renderer swarm",
          mcpServers: [],
          repo: "renderer",
          publicationRepo: "tellahq/renderer",
          baseBranch: "main",
          allowedRunners: [],
          publication: "branch-pr-only",
        },
      },
      { user: "Kent" },
    );
    expect(inputs.isAutomationSession).toBe(true);
    expect(inputs.mcpServers).toEqual([]);
    expect(inputs.mcpServersSource).toBe("automation");
    expect(inputs.deniedTools).toBeDefined();
    expect(inputs.user).toBeUndefined();
    expect(inputs.sessionNote).toBe(false);
  });

  test("an allowlist that resolves to nothing reports itself as unscoped", async () => {
    // An automation record that is gone (or names no servers) leaves the run
    // unscoped — say so rather than claiming an allowlist that isn't there.
    const inputs = await resolveSessionRunInputs(
      { ...plain, automation: "no-such-automation-xyz" },
      { user: "Kent" },
    );
    expect(inputs.mcpServers).toBeUndefined();
    expect(inputs.mcpServersSource).toBe("all");
  });
});
