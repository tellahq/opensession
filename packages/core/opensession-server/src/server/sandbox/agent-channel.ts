/**
 * The server half of the Sandbox agent (src/runner-host/sandbox-agent.ts).
 *
 * A remote Sandbox runs a small agent that dials out to /sandbox-agent-ws
 * with a token minted for that one Sandbox. Once it is connected, the
 * Sandbox's commands and file writes travel as frames on that socket instead
 * of one provider API or SSH round trip each (agent-driver.ts decides which
 * lane a call takes and falls back to the provider's own when the agent is
 * not there).
 *
 * Everything here is in memory on purpose. A token lives as long as this
 * process: after a restart or handoff the old agents' tokens are unknown,
 * their probe answers 403, and they exit; the next command that needs a
 * Sandbox launches a fresh agent. That keeps credentials off disk and keeps
 * this module free of filesystem I/O on the gateway thread.
 *
 * One token, and one connection, per Sandbox. Minting a new token revokes the
 * previous one and closes its socket, so a Sandbox restored from a snapshot
 * of another can never answer for it.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import type { ExecResult } from "./provider";

export const SANDBOX_AGENT_PATH = "/sandbox-agent-ws";
const WS_KIND = "sandbox-agent";

type Grant = {
  sandboxId: string;
  provider: string;
  hash: Buffer;
  mintedAt: number;
};

type Pending = {
  resolve: (value: ExecResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Connection = {
  ws: any;
  sandboxId: string;
  provider: string;
  connectedAt: number;
  helloAt?: number;
  pending: Map<string, Pending>;
};

type AgentGlobals = {
  __opensessionSandboxAgentGrants?: Map<string, Grant>;
  __opensessionSandboxAgentConnections?: Map<string, Connection>;
  __opensessionSandboxAgentWaiters?: Map<string, Set<() => void>>;
};
const g = globalThis as AgentGlobals;
const grants = (g.__opensessionSandboxAgentGrants ??= new Map());
const connections = (g.__opensessionSandboxAgentConnections ??= new Map());
const waiters = (g.__opensessionSandboxAgentWaiters ??= new Map());

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** Mint the token a freshly launched agent authenticates with. Revokes the
 *  Sandbox's previous token and closes its connection. */
export function mintSandboxAgentToken(input: {
  sandboxId: string;
  provider: string;
}): string {
  revokeSandboxAgent(input.sandboxId, "replaced");
  const token = randomBytes(32).toString("base64url");
  grants.set(input.sandboxId, {
    sandboxId: input.sandboxId,
    provider: input.provider,
    hash: digest(token),
    mintedAt: Date.now(),
  });
  return token;
}

/** Forget the Sandbox's token and close its agent. Called when a Sandbox is
 *  retired and before a new agent is launched. */
export function revokeSandboxAgent(sandboxId: string, why = "revoked"): void {
  grants.delete(sandboxId);
  const connection = connections.get(sandboxId);
  if (connection) teardown(connection, 1000, why);
}

function grantFor(token: string, sandboxId: string): Grant | null {
  const grant = grants.get(sandboxId);
  if (!grant || !token) return null;
  const candidate = digest(token);
  return candidate.length === grant.hash.length &&
    timingSafeEqual(candidate, grant.hash)
    ? grant
    : null;
}

/**
 * The upgrade (and the agent's token probe) for /sandbox-agent-ws. Answers
 * 403 for an unknown token BEFORE upgrading; a probe with a valid token gets
 * 204 and no socket, so an agent can tell "try again later" from "stop".
 */
export function handleSandboxAgentUpgrade(
  req: Request,
  server: { upgrade(req: Request, opts?: { data?: unknown }): boolean },
  path: string,
): Response | undefined {
  if (path !== SANDBOX_AGENT_PATH) return undefined;
  const url = new URL(req.url);
  const sandboxId = url.searchParams.get("sandbox") || "";
  const auth = req.headers.get("authorization") || "";
  const token = auth.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const grant = grantFor(token, sandboxId);
  if (!grant) return new Response(null, { status: 403 });
  if (url.searchParams.get("probe") === "1")
    return new Response(null, { status: 204 });
  return server.upgrade(req, {
    data: { kind: WS_KIND, sandboxId, provider: grant.provider },
  })
    ? undefined
    : new Response("WebSocket upgrade failed", { status: 400 });
}

export function sandboxAgentOpen(ws: any): boolean {
  if (ws.data?.kind !== WS_KIND) return false;
  const sandboxId = String(ws.data.sandboxId);
  // A token revoked between the upgrade and the open must not slip through.
  if (!grants.has(sandboxId)) {
    try {
      ws.close(1008, "revoked");
    } catch {}
    return true;
  }
  const previous = connections.get(sandboxId);
  if (previous) teardown(previous, 1000, "replaced");
  connections.set(sandboxId, {
    ws,
    sandboxId,
    provider: String(ws.data.provider),
    connectedAt: Date.now(),
    pending: new Map(),
  });
  return true;
}

export function sandboxAgentMessage(ws: any, message: unknown): boolean {
  if (ws.data?.kind !== WS_KIND) return false;
  const connection = connections.get(String(ws.data.sandboxId));
  if (!connection || connection.ws !== ws) return true;
  let frame: any;
  try {
    frame = JSON.parse(String(message));
  } catch {
    return true;
  }
  if (frame?.t === "ping") {
    send(connection, { t: "pong", id: frame.id });
    return true;
  }
  if (frame?.t === "hello") {
    connection.helloAt = Date.now();
    for (const wake of waiters.get(connection.sandboxId) ?? []) wake();
    waiters.delete(connection.sandboxId);
    return true;
  }
  const id = typeof frame?.id === "string" ? frame.id : "";
  const pending = id ? connection.pending.get(id) : undefined;
  if (!pending) return true;
  connection.pending.delete(id);
  clearTimeout(pending.timer);
  if (frame.t === "result")
    pending.resolve({
      exitCode: Number.isInteger(frame.exitCode) ? frame.exitCode : 1,
      stdout: typeof frame.stdout === "string" ? frame.stdout : "",
      stderr: typeof frame.stderr === "string" ? frame.stderr : "",
    });
  else
    pending.resolve({
      exitCode: 1,
      stdout: "",
      stderr: `Sandbox agent: ${String(frame.message || "request failed")}`,
    });
  return true;
}

export function sandboxAgentClose(ws: any): boolean {
  if (ws.data?.kind !== WS_KIND) return false;
  const connection = connections.get(String(ws.data.sandboxId));
  if (connection?.ws === ws) teardown(connection, undefined, "closed");
  return true;
}

/** stderr for a request the agent may or may not have started. Contains
 *  "socket" so makeRemoteSandbox re-checks the machine on the next call. */
export const AGENT_LOST_MESSAGE =
  "Sandbox agent socket closed before the command finished";

function teardown(connection: Connection, code?: number, why?: string) {
  if (connections.get(connection.sandboxId) === connection)
    connections.delete(connection.sandboxId);
  for (const [, pending] of connection.pending) {
    clearTimeout(pending.timer);
    pending.resolve({ exitCode: 1, stdout: "", stderr: AGENT_LOST_MESSAGE });
  }
  connection.pending.clear();
  if (code !== undefined)
    try {
      connection.ws.close(code, why);
    } catch {}
}

function send(connection: Connection, frame: Record<string, unknown>): boolean {
  try {
    const sent = connection.ws.send(JSON.stringify(frame));
    // Bun answers 0 when the frame was dropped (the socket is closing).
    return sent !== 0;
  } catch {
    return false;
  }
}

/** True while the Sandbox's agent is connected and has said hello. */
export function sandboxAgentConnected(sandboxId: string): boolean {
  return Boolean(connections.get(sandboxId)?.helloAt);
}

/** Wait up to `timeoutMs` for the Sandbox's agent to connect. */
export function waitForSandboxAgent(
  sandboxId: string,
  timeoutMs: number,
): Promise<boolean> {
  if (sandboxAgentConnected(sandboxId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const set = waiters.get(sandboxId) ?? new Set<() => void>();
    waiters.set(sandboxId, set);
    const done = () => {
      clearTimeout(timer);
      set.delete(done);
      resolve(sandboxAgentConnected(sandboxId));
    };
    const timer = setTimeout(done, timeoutMs);
    set.add(done);
  });
}

/**
 * Send one request to the Sandbox's agent. Resolves `null` when no agent is
 * connected, so the caller can take the provider's own lane; once a request
 * is on the wire it resolves with the agent's answer, a timeout, or
 * AGENT_LOST_MESSAGE, and is never retried here (it may have run).
 */
export function sandboxAgentRequest(
  sandboxId: string,
  frame: { t: "exec" | "spawn" | "write" } & Record<string, unknown>,
  timeoutMs: number,
): Promise<ExecResult> | null {
  const connection = connections.get(sandboxId);
  if (!connection?.helloAt) return null;
  const id = randomUUID();
  return new Promise<ExecResult>((resolve) => {
    const timer = setTimeout(() => {
      connection.pending.delete(id);
      resolve({
        exitCode: 124,
        stdout: "",
        stderr: `Sandbox agent did not answer within ${timeoutMs}ms`,
      });
    }, timeoutMs);
    connection.pending.set(id, { resolve, timer });
    if (!send(connection, { ...frame, id })) {
      connection.pending.delete(id);
      clearTimeout(timer);
      teardown(connection, 1011, "send failed");
      resolve({ exitCode: 1, stdout: "", stderr: AGENT_LOST_MESSAGE });
    }
  });
}

/** What the Sandbox badge and diagnostics show about the agent lane. */
export function sandboxAgentStatus(sandboxId: string): {
  connected: boolean;
  connectedAt?: string;
} {
  const connection = connections.get(sandboxId);
  return connection?.helloAt
    ? {
        connected: true,
        connectedAt: new Date(connection.connectedAt).toISOString(),
      }
    : { connected: false };
}

/** Test seam. */
export function resetSandboxAgentsForTests(): void {
  for (const connection of [...connections.values()])
    teardown(connection, undefined, "reset");
  grants.clear();
  waiters.clear();
}
