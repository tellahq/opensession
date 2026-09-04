import { describe, expect, test } from "bun:test";
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
