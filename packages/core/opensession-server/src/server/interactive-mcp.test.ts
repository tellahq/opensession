import { describe, expect, spyOn, test } from "bun:test";
import * as sessionCache from "./session-cache";
import { GITHUB_ACTOR, scheduledActor } from "./session-actors";
import { scopeSessionsForSidebar } from "./sidebar-session-scope";
import type { UnifiedSession } from "./types";
import type { SessionControl, SessionSummary } from "./session-control";
import { registerSessionControl } from "./session-control";
import {
  dispatchRunRpc,
  registerRunToken,
  unregisterRunToken,
} from "./run-rpc";
import { editorFixtureGrantUser } from "./interactive-mcp";

function session(
  id: string,
  createdBy: string,
  createdByLogin: string,
): SessionSummary {
  return {
    id,
    title: `${createdBy}'s session`,
    state: "idle",
    queuedCount: 0,
    controllable: true,
    createdBy,
    createdByLogin,
    createdAt: "2026-08-06T09:30:00.000Z",
    lastActivity: "2026-08-06T10:00:00.000Z",
  } as SessionSummary;
}

describe("interactive opensession-sessions MCP", () => {
  test("publishes and applies the createdBy filter through run-rpc", async () => {
    const sessions = [
      session("os-alex", "Alex Rivera", "arivera"),
      session("os-grant", "Grant Lee", "grantlee"),
    ];
    const control = {
      listSessions: () => sessions,
      getSession: (id: string) => sessions.find((s) => s.id === id),
      transcriptTail: async () => [],
      answerQuestion: () => false,
      deliverToSession: async () => ({
        status: "error" as const,
        message: "not used",
      }),
      cancelSession: () => false,
      reparentSession: async () => ({ ok: false as const, error: "not used" }),
      createSession: async () => ({
        id: "unused",
        createdBy: "Test",
        createdAt: "2026-08-06T09:30:00.000Z",
      }),
    } satisfies SessionControl;
    registerSessionControl(control);

    const token = `interactive-created-by-${crypto.randomUUID()}`;
    registerRunToken(token, { sessionId: "os-caller", user: "Test" });
    try {
      const listed = await dispatchRunRpc("/mcp/list", {
        token,
        server: "opensession-sessions",
      });
      expect(listed.kind).toBe("immediate");
      if (listed.kind !== "immediate")
        throw new Error("expected tools/list response");
      const tools = listed.body.tools as Array<{
        name: string;
        inputSchema: { properties?: Record<string, unknown> };
      }>;
      const listSessions = tools.find((tool) => tool.name === "list_sessions");
      expect(listSessions?.inputSchema.properties).toHaveProperty("createdBy");

      const called = await dispatchRunRpc("/mcp/call", {
        token,
        server: "opensession-sessions",
        tool: "list_sessions",
        args: { createdBy: "ARIVERA" },
      });
      expect(called.kind).toBe("call");
      if (called.kind !== "call")
        throw new Error("expected tools/call response");
      const response = await called.done;
      const text = (
        response.result as { content: Array<{ type: string; text: string }> }
      ).content[0].text;
      expect(text).toContain("os-alex");
      expect(text).toContain('createdBy="Alex Rivera"');
      expect(text).not.toContain("os-grant");
    } finally {
      unregisterRunToken(token);
    }
  });
});

describe("editor fixture grant identity", () => {
  test("requires the verified creator login", () => {
    expect(editorFixtureGrantUser({ createdByLogin: "kentdebruin" })).toBe(
      "kentdebruin",
    );
    expect(
      editorFixtureGrantUser({ createdByLogin: undefined }),
    ).toBeUndefined();
    expect(editorFixtureGrantUser(undefined)).toBeUndefined();
  });
});

describe("sessions created from a machine-started turn", () => {
  const owner = "Ada Lovelace";

  function ownedSession(
    overrides: Partial<UnifiedSession> = {},
  ): UnifiedSession {
    return {
      id: "os-owned",
      claudeSessionId: "",
      source: "opensession",
      branch: "main",
      worktreeDir: null,
      createdBy: owner,
      createdByLogin: "ada",
      startedBy: owner,
      title: "Ada's session",
      lastActivity: "2026-09-28T10:00:00.000Z",
      createdAt: "2026-09-28T09:00:00.000Z",
      isRunning: true,
      transcriptPath: "",
      ...overrides,
    };
  }

  async function createStandaloneFrom(
    turnSender: string,
    caller: UnifiedSession,
  ): Promise<{ user?: string; createdByLogin?: string }> {
    const created: Array<{ user?: string; createdByLogin?: string }> = [];
    registerSessionControl({
      listSessions: () => [],
      getSession: () => undefined,
      transcriptTail: async () => [],
      answerQuestion: () => false,
      deliverToSession: async () => ({
        status: "error" as const,
        message: "not used",
      }),
      cancelSession: () => false,
      reparentSession: async () => ({ ok: false as const, error: "not used" }),
      createSession: async (opts) => {
        created.push(opts);
        return {
          id: "os-new",
          createdBy: opts.user || "unknown",
          createdAt: "2026-09-28T10:05:00.000Z",
        };
      },
    } satisfies SessionControl);
    const find = spyOn(sessionCache, "findSession").mockReturnValue(caller);
    const findAsync = spyOn(sessionCache, "findSessionAsync").mockResolvedValue(
      caller,
    );
    const token = `machine-turn-${crypto.randomUUID()}`;
    registerRunToken(token, { sessionId: caller.id, user: turnSender });
    try {
      const called = await dispatchRunRpc("/mcp/call", {
        token,
        server: "opensession-sessions",
        tool: "create_session",
        args: { prompt: "fix the flaky deploy check", standalone: true },
      });
      if (called.kind !== "call")
        throw new Error("expected tools/call response");
      await called.done;
    } finally {
      unregisterRunToken(token);
      find.mockRestore();
      findAsync.mockRestore();
    }
    expect(created).toHaveLength(1);
    return created[0];
  }

  function visibleInSidebarOf(person: string, startedBy?: string): boolean {
    const row = ownedSession({
      id: "os-new",
      startedBy: startedBy ?? null,
      createdBy: startedBy ?? null,
      isRunning: false,
    });
    return scopeSessionsForSidebar(
      [row],
      {
        user: person,
        person: "me",
        repo: "all",
        autoCreated: "hide",
      },
      {
        pins: new Set(),
        lanes: new Set(),
        snoozes: new Set(),
        hides: new Set(),
        mentions: new Set(),
        workspaces: new Map(),
        automations: new Map(),
        defaultRepo: "acme/app",
      },
      Date.parse("2026-09-28T12:00:00.000Z"),
    ).some((s) => s.id === "os-new");
  }

  test("a webhook turn in a person's session creates the session for that person", async () => {
    const opts = await createStandaloneFrom(GITHUB_ACTOR, ownedSession());
    expect(opts.user).toBe(owner);
    expect(opts.createdByLogin).toBe("ada");
    expect(visibleInSidebarOf(owner, opts.user)).toBe(true);
  });

  test("the person who steered the webhook turn owns the new session", async () => {
    const opts = await createStandaloneFrom(
      GITHUB_ACTOR,
      ownedSession({ lastPromptedBy: "Grace Hopper" }),
    );
    expect(opts.user).toBe("Grace Hopper");
    expect(visibleInSidebarOf("Grace Hopper", opts.user)).toBe(true);
  });

  test("a scheduled check-back turn creates the session for the session's person", async () => {
    const opts = await createStandaloneFrom(
      scheduledActor(owner),
      ownedSession(),
    );
    expect(opts.user).toBe(owner);
    expect(visibleInSidebarOf(owner, opts.user)).toBe(true);
    // The scheduled turn records its own sender as the last prompter.
    const recorded = await createStandaloneFrom(
      scheduledActor(owner),
      ownedSession({ lastPromptedBy: scheduledActor(owner) }),
    );
    expect(recorded.user).toBe(owner);
  });

  test("a person's own turn still creates the session for them", async () => {
    const opts = await createStandaloneFrom(
      "Grace Hopper",
      ownedSession({ lastPromptedBy: "Grace Hopper" }),
    );
    expect(opts.user).toBe("Grace Hopper");
  });

  test("a session no person owns keeps the machine identity", async () => {
    const opts = await createStandaloneFrom(
      GITHUB_ACTOR,
      ownedSession({
        createdBy: GITHUB_ACTOR,
        startedBy: GITHUB_ACTOR,
        createdByLogin: undefined,
      }),
    );
    expect(opts.user).toBe(GITHUB_ACTOR);
  });
});
