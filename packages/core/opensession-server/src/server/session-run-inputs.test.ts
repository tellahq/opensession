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
  createdByLogin: "michiel",
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

  test("a person's turn in an automation-owned session adds the spawn suite", () => {
    expect(
      sessionInProcessMcpBranch(
        { ...plain, automation: "Health monitor" },
        "Michiel",
      ),
    ).toBe("automation+human-spawn");
  });

  test("a sandboxed descendant stays on the automation branch even for a person", () => {
    expect(
      sessionInProcessMcpBranch(
        {
          ...plain,
          automation: "Health monitor",
          automationDescendantPolicy: {
            automationId: "auto-1",
            automationName: "Health monitor",
            mcpServers: [],
            repo: "opensession",
            publicationRepo: "opensession",
            baseBranch: "main",
            allowedRunners: [],
            publication: "branch-pr-only",
          },
        },
        "Michiel",
      ),
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

  test("a Plain discussion session gets only its approval server", () => {
    expect(
      sessionInProcessMcpBranch({ ...plain, plainDiscussionId: "disc_1" }),
    ).toBe("plain-discussion");
    // Even with a goal: the interactive set never reaches ticket text.
    expect(
      sessionInProcessMcpBranch({
        ...plain,
        plainDiscussionId: "disc_1",
        goalId: "g1",
      }),
    ).toBe("plain-discussion");
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
    expect(inputs.mcpGrantUser).toBe("michiel");
    expect(inputs.accountUser).toBe("Kent");
    expect(inputs.sessionNote).toBe(true);
  });

  test("does not use the legacy starter as a grant identity", async () => {
    const inputs = await resolveSessionRunInputs(
      { ...plain, createdByLogin: undefined },
      { user: "Kent" },
    );
    expect(inputs.mcpGrantUser).toBeUndefined();
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
    // Kent is a person, so this turn may spawn work for him; the allowlist,
    // denials and dropped user above are unchanged by that.
    expect(inputs.accountUser).toBe("Kent");
    expect(inputs.inProcessMcpBranch).toBe("automation+human-spawn");
  });

  test("an automation's own tick never gets the spawn suite", async () => {
    const inputs = await resolveSessionRunInputs(
      { ...plain, automation: "Plain ticket triage" },
      { user: "Plain ticket triage (automation)" },
    );
    expect(inputs.accountUser).toBeUndefined();
    expect(inputs.humanPrompter).toBeUndefined();
    expect(inputs.inProcessMcpBranch).toBe("automation-self-improve");
  });

  test("a Plain discussion session drops the user and denies customer and money writes", async () => {
    const inputs = await resolveSessionRunInputs(
      { ...plain, plainDiscussionId: "disc_1" },
      { user: "Kent" },
    );
    expect(inputs.isAutomationSession).toBe(false);
    // Untrusted ticket text: no user for the allowedUsers gate, same as an
    // automation run, even when a person prompts it from the UI.
    expect(inputs.user).toBeUndefined();
    expect(inputs.accountUser).toBe("Kent");
    expect(inputs.deniedTools).toHaveProperty("mcp__plain__reply_to_thread");
    expect(inputs.deniedTools).toHaveProperty("mcp__stripe__create_refund");
    expect(inputs.deniedTools).toHaveProperty(
      "mcp__workos__get_impersonation_url",
    );
    expect(inputs.inProcessMcpBranch).toBe("plain-discussion");
  });

  test("an auto-triage session that reports into a discussion keeps its automation branch with the wider deny-set", async () => {
    const session = {
      ...plain,
      automation: "Plain ticket triage",
      plainDiscussionId: "thd_1",
    };
    // A follow-up relayed from the discussion: the sender is the channel,
    // not a person, so no spawn suite and no subscription to bill.
    const relayed = await resolveSessionRunInputs(session, { user: "Plain" });
    expect(relayed.isAutomationSession).toBe(true);
    expect(relayed.user).toBeUndefined();
    expect(relayed.accountUser).toBeUndefined();
    expect(relayed.humanPrompter).toBeUndefined();
    expect(relayed.inProcessMcpBranch).toBe("automation-self-improve");
    expect(relayed.deniedTools).toHaveProperty("mcp__stripe__create_refund");
    expect(relayed.deniedTools).toHaveProperty("mcp__plain__reply_to_thread");
    // A person steering the same session from the UI keeps what #399 gives
    // an automation-owned session.
    const steered = await resolveSessionRunInputs(session, { user: "Kent" });
    expect(steered.humanPrompter).toBe("Kent");
    expect(steered.inProcessMcpBranch).toBe("automation+human-spawn");
    expect(steered.deniedTools).toHaveProperty("mcp__stripe__create_refund");
  });

  test("the wake of a person's wait gets the continuation branch, not the spawn suite", async () => {
    const inputs = await resolveSessionRunInputs(
      { ...plain, automation: "Plain ticket triage" },
      { user: "Kent (wait)" },
    );
    expect(inputs.humanPrompter).toBe("Kent (wait)");
    expect(inputs.inProcessMcpBranch).toBe("automation+wait-continuation");
    expect(inputs.user).toBeUndefined();
  });

  test("a scheduled loop tick in a person's name never gets the spawn suite", async () => {
    // Kent set the loop, so the turn is still billed to him, but nobody
    // pressed send: scheduled prompt text must not start person-owned
    // sessions on every tick.
    for (const user of ["Kent (loop)", "loop"]) {
      const inputs = await resolveSessionRunInputs(
        { ...plain, automation: "Plain ticket triage" },
        { user },
      );
      expect(inputs.humanPrompter).toBeUndefined();
      expect(inputs.inProcessMcpBranch).toBe("automation-self-improve");
    }
    expect(
      (
        await resolveSessionRunInputs(
          { ...plain, automation: "Plain ticket triage" },
          { user: "Kent (loop)" },
        )
      ).accountUser,
    ).toBe("Kent (loop)");
  });

  test("a person taking over an automation-owned session keeps their provider account", async () => {
    // Johnny switched a Plain triage session back to Fable and prompted it;
    // every turn still ran pool-only and bounced to the fallback while his
    // own subscription had headroom. The identity reaches account selection
    // only: `user` (the MCP gate) stays dropped.
    const inputs = await resolveSessionRunInputs(
      { ...plain, automation: "Plain ticket triage" },
      { user: "Johnny" },
    );
    expect(inputs.user).toBeUndefined();
    expect(inputs.accountUser).toBe("Johnny");
  });

  test("machine senders never become an account user", async () => {
    for (const user of [
      "Plain ticket triage (automation)",
      "GitHub",
      "auto-continue",
      "Anonymous",
      undefined,
    ]) {
      const inputs = await resolveSessionRunInputs(
        { ...plain, automation: "Plain ticket triage" },
        { user },
      );
      expect(inputs.accountUser).toBeUndefined();
    }
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
