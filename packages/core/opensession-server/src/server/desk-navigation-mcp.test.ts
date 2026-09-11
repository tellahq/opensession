import { expect, test } from "bun:test";
import { z } from "zod";
import type { DeskNavigationCommand } from "../shared/desk-navigation";
import { deskTextNavigation } from "./desk-text-navigation";
import { deskNavigationMcp } from "./desk-navigation-mcp";
import { registerSessionControl, type SessionSummary } from "./session-control";
import {
  dispatchRunRpc,
  registerInteractiveMcpBuilder,
  registerRunToken,
  unregisterRunToken,
} from "./run-rpc";
import { handleDeskNavigationRoutes } from "./routes/desk-navigation";

const resultSchema = z.object({
  result: z.object({
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  }),
});

test("the real text MCP uses server-owned prompt identity and the same acknowledged navigation action", async () => {
  const sessionId = "desk-nav-mcp-test";
  const requestId = crypto.randomUUID();
  const promptEntryId = crypto.randomUUID();
  const connection = deskTextNavigation.connect(sessionId, "alice-login");
  if (!connection) throw new Error("No connection");
  deskTextNavigation.bind(
    "alice-login",
    connection.connectionId,
    connection.token,
    requestId,
  );
  deskTextNavigation.accept(sessionId, requestId, "alice-login");
  const finish = deskTextNavigation.begin(sessionId, promptEntryId, [
    requestId,
  ]);
  const target: SessionSummary = {
    id: "session-target",
    title: "Fix uploads",
    state: "idle",
    queuedCount: 0,
    controllable: true,
    claudeSessionId: null,
    source: "opensession",
    branch: null,
    worktreeDir: null,
    startedBy: "Alice",
    lastActivity: "2026-09-10T00:00:00Z",
    createdAt: "2026-09-10T00:00:00Z",
    isRunning: false,
    transcriptPath: null,
  };
  registerSessionControl({
    listSessions: () => [target],
    getSession: (id) => (id === target.id ? target : undefined),
    transcriptTail: async () => [],
    answerQuestion: () => false,
    deliverToSession: async () => ({ status: "error", message: "unused" }),
    cancelSession: () => false,
    reparentSession: async () => ({ ok: false, error: "unused" }),
    createSession: async () => ({
      id: "unused",
      createdBy: "Test",
      createdAt: "2026-09-10T00:00:00Z",
    }),
  });
  registerInteractiveMcpBuilder((id, _user, prompt) =>
    deskNavigationMcp(id, prompt),
  );
  const token = crypto.randomUUID();
  const oldToken = crypto.randomUUID();
  registerRunToken(token, { sessionId, user: "Alice", promptEntryId });
  registerRunToken(oldToken, {
    sessionId,
    user: "Alice",
    promptEntryId: "old-turn",
  });
  try {
    expect(deskNavigationMcp(sessionId)).toEqual({});
    const listed = await dispatchRunRpc("/mcp/list", {
      token,
      server: "opensession-desk",
    });
    expect(listed.kind).toBe("immediate");
    if (listed.kind !== "immediate") throw new Error("Expected list");
    expect(JSON.stringify(listed.body)).toContain("show_in_app");
    expect(JSON.stringify(listed.body)).not.toContain(connection.token);
    const forged = await dispatchRunRpc("/mcp/list", {
      token: oldToken,
      server: "opensession-desk",
      promptEntryId,
    });
    expect(forged).toMatchObject({ kind: "immediate", body: { tools: [] } });
    const called = await dispatchRunRpc("/mcp/call", {
      token,
      server: "opensession-desk",
      tool: "show_in_app",
      args: { session: "uploads" },
    });
    if (called.kind !== "call") throw new Error("Expected tool call");
    // The SDK schedules the handler through its in-memory transport.
    let command: DeskNavigationCommand | undefined;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const response = deskTextNavigation.handle("alice-login", {
        action: "poll",
        ...connection,
      });
      if (response && "command" in response && response.command) {
        command = response.command;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (!command) throw new Error("No navigation command");
    expect(command.target).toEqual({ kind: "session", id: "session-target" });
    deskTextNavigation.handle("alice-login", {
      action: "ack",
      ...connection,
      commandId: command.id,
      shown: true,
    });
    const result = resultSchema.parse(await called.done);
    expect(JSON.parse(result.result.content[0]!.text)).toMatchObject({
      shown: true,
      id: "session-target",
    });
    finish();
    expect(
      await dispatchRunRpc("/mcp/list", { token, server: "opensession-desk" }),
    ).toMatchObject({ kind: "immediate", body: { tools: [] } });
  } finally {
    finish();
    deskTextNavigation.disconnect(
      "alice-login",
      connection.connectionId,
      connection.token,
    );
    unregisterRunToken(token);
    unregisterRunToken(oldToken);
  }
});

test("text navigation HTTP refuses unsigned and malformed requests before looking up a session", async () => {
  const url = new URL("http://localhost/api/desk/navigation/connect");
  const unsigned = await handleDeskNavigationRoutes({
    req: new Request(url, {
      method: "POST",
      body: JSON.stringify({ sessionId: "desk", user: "Alice" }),
    }),
    url,
    path: url.pathname,
    publicPrefix: "",
    authUser: null,
  });
  expect(unsigned?.status).toBe(401);
  const invalid = await handleDeskNavigationRoutes({
    req: new Request(url, {
      method: "POST",
      body: JSON.stringify({ sessionId: "desk", user: "Alice" }),
    }),
    url,
    path: url.pathname,
    publicPrefix: "",
    authUser: { login: "alice", name: "Alice" },
  });
  expect(invalid?.status).toBe(400);
});
