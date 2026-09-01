import { describe, expect, test } from "bun:test";
import type { Sandbox } from "./sandbox/provider";
import type { SessionControl, SessionSummary } from "./session-control";
import { registerSessionControl } from "./session-control";
import {
  dispatchRunRpc,
  registerRunToken,
  unregisterRunToken,
} from "./run-rpc";
import { runSessionPreviewAction } from "./interactive-mcp";

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

describe("interactive opensession-preview MCP lifecycle", () => {
  const status = {
    hasPortsConf: true,
    webappPort: 3300,
    running: false,
    starting: true,
    previewUrl: null,
    bootable: true,
    services: [],
  };

  function deps(sandbox: Sandbox | null, calls: string[]) {
    return {
      findSession: (() => ({
        id: "os-preview",
        worktreeDir: "/remote/worktree",
        sandbox: sandbox
          ? { provider: "daytona" as const, sandboxId: sandbox.id }
          : undefined,
      })) as any,
      activeSandboxFor: (async () => sandbox) as any,
      loadPreview: async () =>
        ({
          startPreview: async () => {
            calls.push("host:start");
            return status;
          },
          getPreviewStatus: async () => {
            calls.push("host:status");
            return status;
          },
          stopPreview: async () => {
            calls.push("host:stop");
            return status;
          },
          startSandboxPreview: async (actual: Sandbox) => {
            calls.push(`sandbox:start:${actual.id}`);
            return status;
          },
          getSandboxPreviewStatus: async (actual: Sandbox) => {
            calls.push(`sandbox:status:${actual.id}`);
            return status;
          },
          stopSandboxPreview: async (actual: Sandbox) => {
            calls.push(`sandbox:stop:${actual.id}`);
            return status;
          },
        }) as any,
    };
  }

  test("starts, polls, and stops inside the active sandbox", async () => {
    const calls: string[] = [];
    const sandbox = { id: "daytona-1" } as Sandbox;
    const injected = deps(sandbox, calls);

    await runSessionPreviewAction("os-preview", "start", injected);
    await runSessionPreviewAction("os-preview", "status", injected);
    await runSessionPreviewAction("os-preview", "stop", injected);

    expect(calls).toEqual([
      "sandbox:start:daytona-1",
      "sandbox:status:daytona-1",
      "sandbox:stop:daytona-1",
    ]);
  });

  test("keeps unsandboxed sessions on the host lifecycle", async () => {
    const calls: string[] = [];
    await runSessionPreviewAction("os-preview", "start", deps(null, calls));
    expect(calls).toEqual(["host:start"]);
  });

  test("does not fall through to the host when a session sandbox is unavailable", async () => {
    const calls: string[] = [];
    const injected = deps(null, calls);
    injected.findSession = (() => ({
      id: "os-preview",
      worktreeDir: "/remote/worktree",
      sandbox: { provider: "daytona", sandboxId: "missing" },
    })) as any;

    await expect(
      runSessionPreviewAction("os-preview", "start", injected),
    ).rejects.toThrow("daytona sandbox is not available");
    expect(calls).toEqual([]);
  });
});
