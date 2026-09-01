/**
 * Versioned outbound Runner control channel.
 *
 * The server never dials a Runner.  Every command carries a one-use operation
 * token and is bounded in time/output; the channel is deliberately HTTP/agent
 * control only and is not a generic network tunnel.
 */

import { randomBytes } from "crypto";
import { audit } from "./audit";
import {
  authenticateRunner,
  getRunner,
  isTailnetAddress,
  runnerAllowed,
  runnerOwnsWorkspace,
  touchRunner,
  type Runner,
} from "./runners";
import type { RunHostSpec } from "../runner-host/protocol";

const g = globalThis as Record<string, unknown>;
const PROTOCOL_VERSION = 1;
const MAX_OUTPUT = 200_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

type Pending = {
  stdout: string[];
  stderr: string[];
  resolve: (result: RunnerExecResult) => void;
  timer: ReturnType<typeof setTimeout>;
  operationToken: string;
};

type Connection = {
  ws: any;
  connectedAt: number;
  protocolVersion: number;
  capabilities: Runner["capabilities"];
  resources?: Runner["resources"];
  pending: Map<string, Pending>;
};

const connections: Map<string, Connection> =
  (g.__opensessionRunnerConnections ??= new Map()) as Map<string, Connection>;
/** A Runner reports this after its detached run host exits. Absence means the
 * host may reconnect, so the server does not kill a live turn during a brief
 * Runner-channel reconnect. */
const exitedHosts: Set<string> = (g.__opensessionRunnerExitedHosts ??=
  new Set()) as Set<string>;
type RunnerPortalFrameHandler = (
  runnerId: string,
  message: Record<string, unknown>,
) => void;
const portalFrameHandlers: Set<RunnerPortalFrameHandler> =
  (g.__opensessionRunnerPortalFrameHandlers ??=
    new Set()) as Set<RunnerPortalFrameHandler>;
type RunnerTerminalFrameHandler = (
  runnerId: string,
  message: Record<string, unknown>,
) => void;
const terminalFrameHandlers: Set<RunnerTerminalFrameHandler> =
  (g.__opensessionRunnerTerminalFrameHandlers ??=
    new Set()) as Set<RunnerTerminalFrameHandler>;
let executionCounter = 0;

export type RunnerExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  data?: unknown;
};
export type RunnerExecOptions = {
  cwd?: string;
  timeoutMs?: number;
  user?: string;
  repo?: string;
  sessionId?: string;
};

/** Register a narrow terminal frame consumer. Terminal ids are random and
 * scoped to a browser connection, so a Runner cannot attach to another tab. */
export function registerRunnerTerminalHandler(
  handler: RunnerTerminalFrameHandler,
): () => void {
  terminalFrameHandlers.add(handler);
  return () => terminalFrameHandlers.delete(handler);
}

function publishRunnerTerminalFrame(
  runnerId: string,
  message: Record<string, unknown>,
): void {
  for (const handler of terminalFrameHandlers) {
    try {
      handler(runnerId, message);
    } catch (error) {
      console.warn("[runners] Terminal frame handler failed:", error);
    }
  }
}

function sendRunnerTerminalFrame(
  runnerId: string,
  message: Record<string, unknown>,
): void {
  const connection = connections.get(runnerId);
  if (!connection || connection.protocolVersion !== PROTOCOL_VERSION) return;
  try {
    connection.ws.send(JSON.stringify(message));
  } catch {}
}

/** Open an interactive PTY in the exact session workspace. This is a typed
 * control-channel operation, not an SSH fallback or generic remote shell. */
export async function openRunnerTerminal(input: {
  runnerId: string;
  sessionId: string;
  repo: string;
  workspacePath: string;
  user?: string;
  cols?: number;
  rows?: number;
}): Promise<{ terminalId: string; cwd: string }> {
  const connection = connections.get(input.runnerId);
  if (!connection || connection.protocolVersion !== PROTOCOL_VERSION)
    throw new Error(`Runner ${input.runnerId} is not connected`);
  const runner = getRunner(input.runnerId);
  if (
    !runner ||
    !runnerAllowed(runner, {
      user: input.user,
      repo: input.repo,
      permission: "terminals",
    })
  )
    throw new Error(
      `Runner ${runner?.name ?? input.runnerId} is not permitted for terminals`,
    );
  if (!runnerOwnsWorkspace(runner, input.workspacePath, input.sessionId))
    throw new Error("Runner terminal workspace is outside its managed roots");
  const id = `rt${++executionCounter}-${randomBytes(12).toString("base64url")}`;
  const operationToken = randomBytes(18).toString("base64url");
  audit({
    msg: "runner_terminal_start",
    runner_id: input.runnerId,
    session_id: input.sessionId,
    repo: input.repo,
    operation_id: id,
  });
  const result = await new Promise<RunnerExecResult>((resolve) => {
    const timer = setTimeout(() => {
      connection.pending.delete(id);
      resolve({
        code: -1,
        stdout: "",
        stderr: "Runner terminal start timed out",
        timedOut: true,
      });
    }, 30_000);
    connection.pending.set(id, {
      stdout: [],
      stderr: [],
      resolve,
      timer,
      operationToken,
    });
    try {
      connection.ws.send(
        JSON.stringify({
          t: "terminal_start",
          version: PROTOCOL_VERSION,
          id,
          operationToken,
          sessionId: input.sessionId,
          repo: input.repo,
          workspacePath: input.workspacePath,
          cols: input.cols,
          rows: input.rows,
        }),
      );
    } catch (error) {
      clearTimeout(timer);
      connection.pending.delete(id);
      resolve({
        code: -1,
        stdout: "",
        stderr: `Could not reach Runner: ${(error as Error).message}`,
      });
    }
  });
  if (result.code !== 0)
    throw new Error(result.stderr || "Runner terminal could not start");
  return { terminalId: id, cwd: result.stdout || input.workspacePath };
}

export function writeRunnerTerminal(
  runnerId: string,
  terminalId: string,
  data: string,
): void {
  if (/^rt\d+-[A-Za-z0-9_-]{16}$/.test(terminalId) && data.length <= 128_000)
    sendRunnerTerminalFrame(runnerId, {
      t: "terminal_input",
      id: terminalId,
      data,
    });
}
export function resizeRunnerTerminal(
  runnerId: string,
  terminalId: string,
  cols: number,
  rows: number,
): void {
  if (/^rt\d+-[A-Za-z0-9_-]{16}$/.test(terminalId))
    sendRunnerTerminalFrame(runnerId, {
      t: "terminal_resize",
      id: terminalId,
      cols,
      rows,
    });
}
export function stopRunnerTerminal(runnerId: string, terminalId: string): void {
  if (/^rt\d+-[A-Za-z0-9_-]{16}$/.test(terminalId))
    sendRunnerTerminalFrame(runnerId, { t: "terminal_stop", id: terminalId });
}

/**
 * The server chooses this whole path. A Runner never receives a caller's home
 * checkout or an arbitrary `cwd` for a full session.
 */
export type RunnerWorkspaceRequest = {
  sessionId: string;
  repo: string;
  branch: string;
  workspacePath: string;
  repositoryUrl: string;
  /** Short-lived, repository-scoped clone credential. Never persisted. */
  cloneToken?: string;
  user?: string;
  /** Server-authenticated create provenance, never accepted from agent text. */
  automationDescendant?: boolean;
};

export type RunnerWorkspaceResult = { cwd: string };

export type RunnerHostRequest = {
  sessionId: string;
  repo: string;
  user?: string;
  server: string;
  spec: RunHostSpec;
};

/** Internal workspace operations (diff, files, session terminal) use the
 * Runner channel too. The cwd is pinned to the session-owned root before the
 * command crosses the machine boundary. */
export async function execRunnerWorkspace(
  runnerId: string,
  input: {
    sessionId: string;
    repo: string;
    workspacePath: string;
    command: string;
    user?: string;
    timeoutMs?: number;
  },
): Promise<RunnerExecResult> {
  const connection = connections.get(runnerId);
  if (!connection || connection.protocolVersion !== PROTOCOL_VERSION)
    throw new Error(`Runner ${runnerId} is not connected`);
  const runner = getRunner(runnerId);
  if (
    !runner ||
    !runnerAllowed(runner, {
      user: input.user,
      repo: input.repo,
      permission: "fullSessions",
    })
  )
    throw new Error(
      `Runner ${runner?.name ?? runnerId} is not permitted for this session workspace`,
    );
  if (!runnerOwnsWorkspace(runner, input.workspacePath, input.sessionId))
    throw new Error("Runner workspace path is outside its managed roots");
  return execRunnerCommand(connection, runnerId, input.command, {
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
    user: input.user,
    repo: input.repo,
    sessionId: input.sessionId,
    permission: "fullSessions",
    operation: "workspace",
  });
}

/** Remove a session-owned workspace only when the Runner's administrator has
 * explicitly selected deletion retention. The Runner verifies the exact
 * `root/sessions/<sessionId>` shape before touching the filesystem. */
export async function cleanupRunnerWorkspace(input: {
  runnerId: string;
  sessionId: string;
  repo: string;
  workspacePath: string;
  user?: string;
}): Promise<void> {
  const connection = connections.get(input.runnerId);
  if (!connection || connection.protocolVersion !== PROTOCOL_VERSION)
    throw new Error(`Runner ${input.runnerId} is not connected`);
  const runner = getRunner(input.runnerId);
  if (
    !runner ||
    !runnerAllowed(runner, {
      user: input.user,
      repo: input.repo,
      permission: "fullSessions",
    })
  )
    throw new Error(
      `Runner ${runner?.name ?? input.runnerId} is not permitted for workspace cleanup`,
    );
  if (runner.workspaceRetention !== "delete") return;
  if (!runnerOwnsWorkspace(runner, input.workspacePath, input.sessionId))
    throw new Error("Runner cleanup workspace is outside its managed roots");
  const id = `rc${++executionCounter}-${Date.now().toString(36)}`;
  const operationToken = randomBytes(18).toString("base64url");
  audit({
    msg: "runner_workspace_cleanup_start",
    runner_id: input.runnerId,
    session_id: input.sessionId,
    repo: input.repo,
    operation_id: id,
  });
  const result = await new Promise<RunnerExecResult>((resolve) => {
    const timer = setTimeout(() => {
      connection.pending.delete(id);
      resolve({
        code: -1,
        stdout: "",
        stderr: "Runner workspace cleanup timed out",
        timedOut: true,
      });
    }, 60_000);
    connection.pending.set(id, {
      stdout: [],
      stderr: [],
      resolve,
      timer,
      operationToken,
    });
    try {
      connection.ws.send(
        JSON.stringify({
          t: "workspace_cleanup",
          version: PROTOCOL_VERSION,
          id,
          operationToken,
          sessionId: input.sessionId,
          repo: input.repo,
          workspacePath: input.workspacePath,
        }),
      );
    } catch (error) {
      clearTimeout(timer);
      connection.pending.delete(id);
      resolve({
        code: -1,
        stdout: "",
        stderr: `Could not reach Runner: ${(error as Error).message}`,
      });
    }
  });
  audit({
    msg: "runner_workspace_cleanup_finish",
    runner_id: input.runnerId,
    session_id: input.sessionId,
    repo: input.repo,
    operation_id: id,
    outcome: result.code === 0 ? "ok" : "failed",
  });
  if (result.code !== 0)
    throw new Error(result.stderr || "Runner workspace cleanup failed");
}

/** A small, typed request/response seam for Runner-owned services. The caller
 * must still enforce a specific Portal operation and session workspace. */
export async function requestRunnerPortal(
  runnerId: string,
  input: {
    sessionId: string;
    repo: string;
    workspacePath: string;
    operation:
      | "allocate"
      | "start"
      | "list"
      | "stop"
      | "restart"
      | "path"
      | "http";
    payload?: Record<string, unknown>;
    user?: string;
  },
): Promise<unknown> {
  const connection = connections.get(runnerId);
  if (!connection || connection.protocolVersion !== PROTOCOL_VERSION)
    throw new Error(`Runner ${runnerId} is not connected`);
  const runner = getRunner(runnerId);
  if (
    !runner ||
    !runnerAllowed(runner, {
      user: input.user,
      repo: input.repo,
      permission: "portals",
    })
  )
    throw new Error(
      `Runner ${runner?.name ?? runnerId} is not permitted to expose Portals`,
    );
  if (!runnerOwnsWorkspace(runner, input.workspacePath, input.sessionId))
    throw new Error("Runner Portal workspace is outside its managed roots");
  const id = `rp${++executionCounter}-${Date.now().toString(36)}`;
  const operationToken = randomBytes(18).toString("base64url");
  audit({
    msg: "runner_portal_request_start",
    runner_id: runnerId,
    session_id: input.sessionId,
    repo: input.repo,
    operation: input.operation,
    operation_id: id,
  });
  const result = await new Promise<RunnerExecResult>((resolve) => {
    const timer = setTimeout(() => {
      const pending = connection.pending.get(id);
      if (!pending) return;
      connection.pending.delete(id);
      resolve({
        code: -1,
        stdout: "",
        stderr: "Runner Portal request timed out",
        timedOut: true,
      });
    }, 30_000);
    connection.pending.set(id, {
      stdout: [],
      stderr: [],
      resolve,
      timer,
      operationToken,
    });
    try {
      connection.ws.send(
        JSON.stringify({
          t: `portal_${input.operation}`,
          version: PROTOCOL_VERSION,
          id,
          operationToken,
          sessionId: input.sessionId,
          repo: input.repo,
          workspacePath: input.workspacePath,
          ...(input.payload || {}),
        }),
      );
    } catch (error) {
      clearTimeout(timer);
      connection.pending.delete(id);
      resolve({
        code: -1,
        stdout: "",
        stderr: `Could not reach Runner: ${(error as Error).message}`,
      });
    }
  });
  if (result.code !== 0) {
    audit({
      msg: "runner_portal_request_finish",
      runner_id: runnerId,
      session_id: input.sessionId,
      repo: input.repo,
      operation: input.operation,
      operation_id: id,
      outcome: "failed",
    });
    throw new Error(result.stderr || "Runner Portal request failed");
  }
  audit({
    msg: "runner_portal_request_finish",
    runner_id: runnerId,
    session_id: input.sessionId,
    repo: input.repo,
    operation: input.operation,
    operation_id: id,
    outcome: "ok",
  });
  return result.data;
}

export function connectedRunnerIds(): string[] {
  return [...connections.keys()];
}

export function isRunnerConnected(id: string): boolean {
  return connections.has(id);
}

/** Portal HTTP uses request/response. WebSocket traffic needs this narrow
 * frame bridge, still restricted to server-registered Portal connections. */
export function sendRunnerPortalFrame(
  runnerId: string,
  message: Record<string, unknown>,
): boolean {
  const connection = connections.get(runnerId);
  if (!connection || connection.protocolVersion !== PROTOCOL_VERSION)
    return false;
  try {
    connection.ws.send(
      JSON.stringify({ ...message, version: PROTOCOL_VERSION }),
    );
    return true;
  } catch {
    return false;
  }
}

export function registerRunnerPortalFrameHandler(
  handler: RunnerPortalFrameHandler,
): () => void {
  portalFrameHandlers.add(handler);
  return () => portalFrameHandlers.delete(handler);
}

export function runnerHostAlive(hostId: string): boolean {
  return !exitedHosts.has(hostId);
}

/** Ask the Runner whether its detached host is still alive. This remains
 * accurate after the Runner service reconnects, unlike an in-memory map. */
export async function runnerHostStatus(
  runnerId: string,
  input: {
    sessionId: string;
    repo: string;
    workspacePath: string;
    hostId: string;
    user?: string;
  },
): Promise<boolean> {
  const connection = connections.get(runnerId);
  if (!connection || connection.protocolVersion !== PROTOCOL_VERSION)
    return false;
  const runner = getRunner(runnerId);
  if (
    !runner ||
    !runnerAllowed(runner, {
      user: input.user,
      repo: input.repo,
      permission: "fullSessions",
    })
  )
    return false;
  if (!runnerOwnsWorkspace(runner, input.workspacePath, input.sessionId))
    return false;
  const id = `rs${++executionCounter}-${Date.now().toString(36)}`;
  const operationToken = randomBytes(18).toString("base64url");
  const result = await new Promise<RunnerExecResult>((resolve) => {
    const timer = setTimeout(() => {
      const pending = connection.pending.get(id);
      if (!pending) return;
      connection.pending.delete(id);
      resolve({
        code: -1,
        stdout: "",
        stderr: "Runner host status timed out",
        timedOut: true,
      });
    }, 15_000);
    connection.pending.set(id, {
      stdout: [],
      stderr: [],
      resolve,
      timer,
      operationToken,
    });
    try {
      connection.ws.send(
        JSON.stringify({
          t: "host_status",
          version: PROTOCOL_VERSION,
          id,
          operationToken,
          sessionId: input.sessionId,
          repo: input.repo,
          workspacePath: input.workspacePath,
          hostId: input.hostId,
        }),
      );
    } catch (error) {
      clearTimeout(timer);
      connection.pending.delete(id);
      resolve({
        code: -1,
        stdout: "",
        stderr: `Could not reach Runner: ${(error as Error).message}`,
      });
    }
  });
  return result.code === 0 && result.stdout === "alive";
}

export function disconnectRunner(id: string, reason = "revoked"): boolean {
  const connection = connections.get(id);
  if (!connection) return false;
  try {
    connection.ws.close(1008, reason);
  } catch {}
  return true;
}

export function handleRunnerWsUpgrade(
  req: Request,
  server: {
    upgrade(req: Request, opts: any): boolean;
    requestIP?(req: Request): { address: string } | null;
  },
  path: string,
): Response | undefined {
  if (path !== "/runner-ws") return undefined;
  if (!isTailnetAddress(server.requestIP?.(req)?.address ?? ""))
    return new Response("forbidden", { status: 403 });
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  const authorization = req.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  const runner = id && token ? authenticateRunner(id, token) : undefined;
  if (!runner) return new Response("unauthorized", { status: 401 });
  return server.upgrade(req, { data: { kind: "runner", runnerId: runner.id } })
    ? undefined
    : new Response("upgrade failed", { status: 400 });
}

export function runnerWsOpen(ws: any): boolean {
  const runnerId = ws.data?.kind === "runner" ? ws.data.runnerId : undefined;
  if (!runnerId) return false;
  connections.get(runnerId)?.ws?.close?.(1000, "replaced by reconnect");
  const runner = getRunner(runnerId);
  if (!runner) {
    ws.close(1008, "revoked");
    return true;
  }
  connections.set(runnerId, {
    ws,
    connectedAt: Date.now(),
    protocolVersion: 0,
    capabilities: runner.capabilities,
    resources: runner.resources,
    pending: new Map(),
  });
  touchRunner(runnerId);
  console.log(`[runners] ${runner.name} attached (${runnerId})`);
  return true;
}

export function runnerWsMessage(ws: any, raw: string | Buffer): boolean {
  const runnerId = ws.data?.kind === "runner" ? ws.data.runnerId : undefined;
  if (!runnerId) return false;
  const connection = connections.get(runnerId);
  if (!connection) return true;
  let message: any;
  try {
    message = JSON.parse(typeof raw === "string" ? raw : raw.toString());
  } catch {
    return true;
  }

  switch (message?.t) {
    case "hello": {
      const version = Number(message.version ?? 0);
      if (version !== PROTOCOL_VERSION) {
        ws.close(1008, "unsupported protocol");
        return true;
      }
      const runner = getRunner(runnerId);
      if (!runner) {
        ws.close(1008, "revoked");
        return true;
      }
      connection.protocolVersion = version;
      const capabilities =
        message.capabilities && typeof message.capabilities === "object"
          ? message.capabilities
          : runner.capabilities;
      const resources =
        message.resources && typeof message.resources === "object"
          ? message.resources
          : runner.resources;
      connection.capabilities = capabilities;
      connection.resources = resources;
      touchRunner(runnerId, {
        capabilities,
        resources,
        softwareVersion:
          typeof message.softwareVersion === "string"
            ? message.softwareVersion
            : undefined,
      });
      return true;
    }
    case "heartbeat":
      touchRunner(runnerId, {
        capabilities: message.capabilities,
        resources: message.resources,
        softwareVersion:
          typeof message.softwareVersion === "string"
            ? message.softwareVersion
            : undefined,
      });
      return true;
    case "out": {
      const pending = connection.pending.get(String(message.id));
      if (!pending || message.operationToken !== pending.operationToken)
        return true;
      const bucket =
        message.stream === "stderr" ? pending.stderr : pending.stdout;
      if (bucket.join("").length < MAX_OUTPUT)
        bucket.push(String(message.data ?? "").slice(0, MAX_OUTPUT));
      return true;
    }
    case "exit": {
      const id = String(message.id);
      const pending = connection.pending.get(id);
      if (!pending || message.operationToken !== pending.operationToken)
        return true;
      clearTimeout(pending.timer);
      connection.pending.delete(id);
      pending.resolve({
        code: Number(message.code ?? 0),
        stdout: pending.stdout.join(""),
        stderr: pending.stderr.join(""),
      });
      return true;
    }
    case "branch_bundle_result": {
      const id = String(message.id);
      const pending = connection.pending.get(id);
      if (!pending || message.operationToken !== pending.operationToken)
        return true;
      clearTimeout(pending.timer);
      connection.pending.delete(id);
      pending.resolve({
        code: message.ok === true ? 0 : -1,
        stdout: "",
        stderr: String(message.error || ""),
        data: message.bundle,
      });
      return true;
    }
    case "workspace_ready": {
      const id = String(message.id);
      const pending = connection.pending.get(id);
      if (!pending || message.operationToken !== pending.operationToken)
        return true;
      clearTimeout(pending.timer);
      connection.pending.delete(id);
      pending.resolve({
        code: 0,
        stdout: String(message.cwd || ""),
        stderr: "",
      });
      return true;
    }
    case "workspace_error": {
      const id = String(message.id);
      const pending = connection.pending.get(id);
      if (!pending || message.operationToken !== pending.operationToken)
        return true;
      clearTimeout(pending.timer);
      connection.pending.delete(id);
      pending.resolve({
        code: -1,
        stdout: "",
        stderr: String(message.error || "Workspace preparation failed"),
      });
      return true;
    }
    case "workspace_cleaned": {
      const id = String(message.id);
      const pending = connection.pending.get(id);
      if (!pending || message.operationToken !== pending.operationToken)
        return true;
      clearTimeout(pending.timer);
      connection.pending.delete(id);
      pending.resolve({
        code: message.ok === true ? 0 : -1,
        stdout: "",
        stderr: String(message.error || ""),
      });
      return true;
    }
    case "host_started": {
      const id = String(message.id);
      const pending = connection.pending.get(id);
      if (!pending || message.operationToken !== pending.operationToken)
        return true;
      clearTimeout(pending.timer);
      connection.pending.delete(id);
      pending.resolve({
        code: 0,
        stdout: String(message.hostId || ""),
        stderr: "",
      });
      return true;
    }
    case "host_error": {
      const id = String(message.id);
      const pending = connection.pending.get(id);
      if (!pending || message.operationToken !== pending.operationToken)
        return true;
      clearTimeout(pending.timer);
      connection.pending.delete(id);
      pending.resolve({
        code: -1,
        stdout: "",
        stderr: String(message.error || "Runner host launch failed"),
      });
      return true;
    }
    case "host_exited":
      exitedHosts.add(String(message.hostId));
      return true;
    case "host_status": {
      const id = String(message.id);
      const pending = connection.pending.get(id);
      if (!pending || message.operationToken !== pending.operationToken)
        return true;
      clearTimeout(pending.timer);
      connection.pending.delete(id);
      pending.resolve({
        code: message.alive === true ? 0 : 1,
        stdout: message.alive === true ? "alive" : "dead",
        stderr: "",
      });
      return true;
    }
    case "portal_result": {
      const id = String(message.id);
      const pending = connection.pending.get(id);
      if (!pending || message.operationToken !== pending.operationToken)
        return true;
      clearTimeout(pending.timer);
      connection.pending.delete(id);
      pending.resolve({
        code: message.ok === true ? 0 : -1,
        stdout: "",
        stderr: String(message.error || ""),
        data: message.result,
      });
      return true;
    }
    case "portal_ws_opened":
    case "portal_ws_event":
    case "portal_ws_closed":
      for (const handler of portalFrameHandlers) {
        try {
          handler(runnerId, message as Record<string, unknown>);
        } catch (error) {
          console.warn("[runners] Portal frame handler failed:", error);
        }
      }
      return true;
    case "terminal_ready": {
      const pending = connection.pending.get(String(message.id));
      if (!pending || message.operationToken !== pending.operationToken)
        return true;
      clearTimeout(pending.timer);
      connection.pending.delete(String(message.id));
      pending.resolve({
        code: 0,
        stdout: String(message.cwd || ""),
        stderr: "",
      });
      return true;
    }
    case "terminal_error": {
      const pending = connection.pending.get(String(message.id));
      if (!pending || message.operationToken !== pending.operationToken)
        return true;
      clearTimeout(pending.timer);
      connection.pending.delete(String(message.id));
      pending.resolve({
        code: -1,
        stdout: "",
        stderr: String(message.error || "Runner terminal failed"),
      });
      return true;
    }
    case "terminal_data":
    case "terminal_exit":
      publishRunnerTerminalFrame(runnerId, message as Record<string, unknown>);
      return true;
  }
  return true;
}

/** Export one credential-free owned branch from a Runner workspace. */
export async function requestRunnerBranchBundle(
  runnerId: string,
  request: {
    sessionId: string;
    repo: string;
    workspacePath: string;
    branch: string;
  },
): Promise<Buffer> {
  const connection = connections.get(runnerId);
  if (!connection || connection.protocolVersion !== PROTOCOL_VERSION)
    throw new Error(`Runner ${runnerId} is not connected`);
  const runner = getRunner(runnerId);
  if (
    !runner ||
    !runnerAllowed(runner, {
      repo: request.repo,
      permission: "automationDescendants",
    }) ||
    !runnerOwnsWorkspace(runner, request.workspacePath, request.sessionId)
  )
    throw new Error("Runner cannot export this automation workspace");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(request.branch))
    throw new Error("Invalid branch for Runner bundle export");
  const id = `rb${++executionCounter}-${Date.now().toString(36)}`;
  const operationToken = randomBytes(18).toString("base64url");
  const result = await new Promise<RunnerExecResult>((resolve) => {
    const timer = setTimeout(() => {
      connection.pending.delete(id);
      resolve({
        code: -1,
        stdout: "",
        stderr: "Runner bundle export timed out",
      });
    }, 60_000);
    connection.pending.set(id, {
      stdout: [],
      stderr: [],
      resolve,
      timer,
      operationToken,
    });
    connection.ws.send(
      JSON.stringify({
        t: "branch_bundle_export",
        version: PROTOCOL_VERSION,
        id,
        operationToken,
        sessionId: request.sessionId,
        repo: request.repo,
        workspacePath: request.workspacePath,
        branch: request.branch,
      }),
    );
  });
  if (result.code !== 0 || typeof result.data !== "string")
    throw new Error(result.stderr || "Runner branch bundle export failed");
  const bundle = Buffer.from(result.data, "base64");
  if (!bundle.length || bundle.length > 25 * 1024 * 1024)
    throw new Error("Runner branch bundle is empty or too large");
  return bundle;
}

/** Materialize only a session-owned workspace under an admin-approved root. */
export async function prepareRunnerWorkspace(
  runnerId: string,
  request: RunnerWorkspaceRequest,
): Promise<RunnerWorkspaceResult> {
  const connection = connections.get(runnerId);
  if (!connection || connection.protocolVersion !== PROTOCOL_VERSION)
    throw new Error(`Runner ${runnerId} is not connected`);
  const runner = getRunner(runnerId);
  const permission = request.automationDescendant
    ? "automationDescendants"
    : "fullSessions";
  if (
    !runner ||
    !runnerAllowed(runner, {
      user: request.user,
      repo: request.repo,
      permission,
    })
  )
    throw new Error(
      `Runner ${runner?.name ?? runnerId} is not permitted for ${permission}`,
    );
  if (!runner.workspaceRoots.length)
    throw new Error(`Runner ${runner.name} has no managed workspace root`);
  if (!runnerOwnsWorkspace(runner, request.workspacePath, request.sessionId))
    throw new Error("Runner workspace path is outside its managed roots");
  const id = `rw${++executionCounter}-${Date.now().toString(36)}`;
  const operationToken = randomBytes(18).toString("base64url");
  audit({
    msg: "runner_workspace_prepare_start",
    runner_id: runnerId,
    session_id: request.sessionId,
    repo: request.repo,
    operation_id: id,
  });
  const result = await new Promise<RunnerExecResult>((resolve) => {
    const timer = setTimeout(() => {
      const pending = connection.pending.get(id);
      if (!pending) return;
      connection.pending.delete(id);
      try {
        connection.ws.send(JSON.stringify({ t: "cancel", id, operationToken }));
      } catch {}
      resolve({
        code: -1,
        stdout: "",
        stderr: "Runner workspace preparation timed out",
        timedOut: true,
      });
    }, 5 * 60_000);
    connection.pending.set(id, {
      stdout: [],
      stderr: [],
      resolve,
      timer,
      operationToken,
    });
    try {
      connection.ws.send(
        JSON.stringify({
          t: "workspace_prepare",
          version: PROTOCOL_VERSION,
          id,
          operationToken,
          sessionId: request.sessionId,
          repo: request.repo,
          branch: request.branch,
          workspacePath: request.workspacePath,
          repositoryUrl: request.repositoryUrl,
          automationDescendant: request.automationDescendant === true,
          ...(request.cloneToken ? { cloneToken: request.cloneToken } : {}),
        }),
      );
    } catch (error) {
      clearTimeout(timer);
      connection.pending.delete(id);
      resolve({
        code: -1,
        stdout: "",
        stderr: `Could not reach Runner: ${(error as Error).message}`,
      });
    }
  });
  if (result.code !== 0 || result.stdout !== request.workspacePath) {
    audit({
      msg: "runner_workspace_prepare_finish",
      runner_id: runnerId,
      session_id: request.sessionId,
      repo: request.repo,
      operation_id: id,
      outcome: "failed",
    });
    throw new Error(
      result.stderr || "Runner returned an unexpected workspace path",
    );
  }
  audit({
    msg: "runner_workspace_prepare_finish",
    runner_id: runnerId,
    session_id: request.sessionId,
    repo: request.repo,
    operation_id: id,
    outcome: "ok",
  });
  return { cwd: result.stdout };
}

export class RunnerHostLaunchRejectedError extends Error {}

/** Start one run-host in a server-selected Runner workspace. */
export async function launchRunnerHost(
  runnerId: string,
  request: RunnerHostRequest,
): Promise<void> {
  const connection = connections.get(runnerId);
  if (!connection || connection.protocolVersion !== PROTOCOL_VERSION)
    throw new RunnerHostLaunchRejectedError(
      `Runner ${runnerId} is not connected`,
    );
  const runner = getRunner(runnerId);
  const permission =
    request.spec.trustProfile === "automation"
      ? "automationDescendants"
      : "fullSessions";
  if (
    !runner ||
    !runnerAllowed(runner, {
      user: request.user,
      repo: request.repo,
      permission,
    })
  )
    throw new RunnerHostLaunchRejectedError(
      `Runner ${runner?.name ?? runnerId} is not permitted for ${permission}`,
    );
  if (!runnerOwnsWorkspace(runner, request.spec.cwd, request.sessionId))
    throw new RunnerHostLaunchRejectedError(
      "Runner host path is outside its managed workspace roots",
    );
  const id = `rh${++executionCounter}-${Date.now().toString(36)}`;
  const operationToken = randomBytes(18).toString("base64url");
  exitedHosts.delete(request.spec.hostId);
  audit({
    msg: "runner_host_launch_start",
    runner_id: runnerId,
    session_id: request.sessionId,
    repo: request.repo,
    operation_id: id,
    host_id: request.spec.hostId,
  });
  const result = await new Promise<RunnerExecResult>((resolve) => {
    const timer = setTimeout(() => {
      const pending = connection.pending.get(id);
      if (!pending) return;
      connection.pending.delete(id);
      try {
        connection.ws.send(JSON.stringify({ t: "cancel", id, operationToken }));
      } catch {}
      resolve({
        code: -1,
        stdout: "",
        stderr: "Runner host launch timed out",
        timedOut: true,
      });
    }, 60_000);
    connection.pending.set(id, {
      stdout: [],
      stderr: [],
      resolve,
      timer,
      operationToken,
    });
    try {
      connection.ws.send(
        JSON.stringify({
          t: "run_host",
          version: PROTOCOL_VERSION,
          id,
          operationToken,
          sessionId: request.sessionId,
          repo: request.repo,
          server: request.server,
          automationDescendant: request.spec.trustProfile === "automation",
          spec: request.spec,
        }),
      );
    } catch (error) {
      clearTimeout(timer);
      connection.pending.delete(id);
      resolve({
        code: -1,
        stdout: "",
        stderr: `Could not reach Runner: ${(error as Error).message}`,
      });
    }
  });
  if (result.code !== 0 || result.stdout !== request.spec.hostId) {
    audit({
      msg: "runner_host_launch_finish",
      runner_id: runnerId,
      session_id: request.sessionId,
      repo: request.repo,
      operation_id: id,
      host_id: request.spec.hostId,
      outcome: "failed",
    });
    throw new Error(
      result.stderr || "Runner returned an unexpected run host identity",
    );
  }
  audit({
    msg: "runner_host_launch_finish",
    runner_id: runnerId,
    session_id: request.sessionId,
    repo: request.repo,
    operation_id: id,
    host_id: request.spec.hostId,
    outcome: "ok",
  });
}

export function runnerWsClose(ws: any): boolean {
  const runnerId = ws.data?.kind === "runner" ? ws.data.runnerId : undefined;
  if (!runnerId) return false;
  const connection = connections.get(runnerId);
  if (!connection || connection.ws !== ws) return true;
  for (const pending of connection.pending.values()) {
    clearTimeout(pending.timer);
    pending.resolve({
      code: -1,
      stdout: pending.stdout.join(""),
      stderr: `${pending.stderr.join("")}\n[Runner disconnected]`,
    });
  }
  connections.delete(runnerId);
  console.log(
    `[runners] ${getRunner(runnerId)?.name ?? runnerId} detached (${runnerId})`,
  );
  return true;
}

export async function execOnRunner(
  runnerId: string,
  command: string,
  options: RunnerExecOptions = {},
): Promise<RunnerExecResult> {
  const connection = connections.get(runnerId);
  if (!connection || connection.protocolVersion !== PROTOCOL_VERSION)
    throw new Error(`Runner ${runnerId} is not connected`);
  const runner = getRunner(runnerId);
  if (
    !runner ||
    !runnerAllowed(runner, {
      user: options.user,
      repo: options.repo,
      permission: "commands",
    })
  )
    throw new Error(
      `Runner ${runner?.name ?? runnerId} is not permitted for this command`,
    );
  return execRunnerCommand(connection, runnerId, command, {
    ...options,
    permission: "commands",
    operation: "command",
  });
}

async function execRunnerCommand(
  connection: Connection,
  runnerId: string,
  command: string,
  options: RunnerExecOptions & {
    permission: "commands" | "fullSessions";
    operation: string;
  },
): Promise<RunnerExecResult> {
  const id = `r${++executionCounter}-${Date.now().toString(36)}`;
  const operationToken = randomBytes(18).toString("base64url");
  const timeoutMs = Math.min(
    Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000),
    60 * 60_000,
  );
  audit({
    msg: `runner_${options.operation}_start`,
    runner_id: runnerId,
    session_id: options.sessionId,
    user: options.user,
    repo: options.repo,
    command: command.slice(0, 500),
    operation_id: id,
  });
  const result = await new Promise<RunnerExecResult>((resolve) => {
    const timer = setTimeout(() => {
      const pending = connection.pending.get(id);
      if (!pending) return;
      connection.pending.delete(id);
      try {
        connection.ws.send(JSON.stringify({ t: "cancel", id, operationToken }));
      } catch {}
      resolve({
        code: -1,
        stdout: pending.stdout.join(""),
        stderr: pending.stderr.join(""),
        timedOut: true,
      });
    }, timeoutMs);
    connection.pending.set(id, {
      stdout: [],
      stderr: [],
      resolve,
      timer,
      operationToken,
    });
    try {
      connection.ws.send(
        JSON.stringify({
          t: "exec",
          version: PROTOCOL_VERSION,
          id,
          operationToken,
          sessionId: options.sessionId,
          command,
          cwd: options.cwd,
          timeoutMs,
        }),
      );
    } catch (error) {
      clearTimeout(timer);
      connection.pending.delete(id);
      resolve({
        code: -1,
        stdout: "",
        stderr: `Could not reach Runner: ${(error as Error).message}`,
      });
    }
  });
  audit({
    msg: `runner_${options.operation}_finish`,
    runner_id: runnerId,
    session_id: options.sessionId,
    user: options.user,
    repo: options.repo,
    operation_id: id,
    exit_code: result.code,
    timed_out: !!result.timedOut,
  });
  return {
    ...result,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
  };
}

function truncate(value: string): string {
  if (value.length <= MAX_OUTPUT) return value;
  const half = Math.floor(MAX_OUTPUT / 2);
  return `${value.slice(0, half)}\n\n[… ${value.length - MAX_OUTPUT} characters trimmed …]\n\n${value.slice(-half)}`;
}
