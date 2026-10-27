/**
 * run-rpc-relay — the client side of opensession's run-rpc (src/server/run-rpc.ts)
 * for the opensession-* MCP servers, which execute inside the opensession
 * process because their tools close over live state.
 *
 * One relay serves every opensession-* server of a run: each request names
 * its server, so a single unix-socket client or a single /rpc-ws connection
 * carries them all. The run host mounts `relayMcpServer(relay, name)` per
 * server straight into its in-process MCP runtime, so the agent sees the same
 * server and tool names without a relay process per server. The stdio
 * `opensession mcp-proxy` (mcp-proxy.ts) wraps the same relay for one server.
 *
 * Importing this module has no live effects; connections and the keepalive
 * timer belong to the relay createRunRpcRelay() returns, until close().
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export interface RunRpcRelayConfig {
  /** opensession's run-rpc unix socket path, OR */
  socket?: string;
  /** opensession's /rpc-ws WebSocket route (remote sandboxes, where a unix
   *  socket can't cross the boundary). */
  wsUrl?: string;
  /** WS mode: this run's hostId (the rpc-ws upgrade is authenticated per
   *  ws-transport run, not per rpc token). */
  wsHost?: string;
  /** WS mode: the run's wsToken, the upgrade bearer. */
  wsAuth?: string;
  /** Per-run bearer sent IN each request (maps to session + user via
   *  dispatchRunRpc; also the unix-socket bearer). */
  token: string;
}

export interface RunRpcRelay {
  rpc(
    server: string,
    path: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<Record<string, any>>;
  close(): void;
}

/** A config error message, or undefined when the config can reach opensession. */
export function runRpcRelayConfigError(
  cfg: Partial<RunRpcRelayConfig>,
): string | undefined {
  if (
    (!cfg.socket && !cfg.wsUrl) ||
    !cfg.token ||
    (cfg.wsUrl && (!cfg.wsHost || !cfg.wsAuth))
  )
    return "a run-rpc socket or WS URL (+ host and auth), plus a run token, are required";
  return undefined;
}

/**
 * An error the opensession side answered with. Most are terminal, but an
 * unknown run token is special: after an opensession restart the detached
 * engine and this relay are still alive before boot recovery has re-registered
 * the token. Retrying that one answer lets the relay bridge the recovery gap.
 */
class RpcError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function rpcError(status: number, data: any): RpcError {
  const message = data?.error || `opensession RPC ${status}`;
  // A token that is genuinely invalid is no more privileged by waiting: this
  // only gives an in-flight detached run time for the restarted server to
  // restore its in-memory token registry. All other answered authz/tool
  // errors remain immediate failures.
  return new RpcError(message, message === "unauthorized (unknown run token)");
}

/**
 * The body of an answered call. Long calls stream heartbeat padding before
 * the JSON, so a call cut short by a restart arrives as a 200 with no body.
 * That is not an answer, and the tool may already have acted, so it is not
 * retried either.
 */
function answeredBody(status: number, data: any): Record<string, any> {
  if (status !== 200) throw rpcError(status, data);
  if (!data || typeof data !== "object")
    throw new RpcError(
      "opensession closed the call before answering, probably a restart. The tool may or may not have finished: check its result before calling it again.",
    );
  // Long tool calls report failures in the body instead of the status.
  if (typeof data.error === "string" && data.error)
    throw rpcError(status, data);
  return data;
}

export function createRunRpcRelay(cfg: RunRpcRelayConfig): RunRpcRelay {
  const configError = runRpcRelayConfigError(cfg);
  if (configError) throw new Error(`run-rpc relay: ${configError}`);
  const SOCK = cfg.socket || "";
  const WS_URL = cfg.wsUrl || "";
  /** The rpc-ws upgrade authenticates per ws-transport run: hostId in the URL,
   *  wsToken as the bearer (src/server/run-ws.ts). Frames still carry the token. */
  const WS_DIAL_URL = WS_URL
    ? `${WS_URL}${WS_URL.includes("?") ? "&" : "?"}host=${encodeURIComponent(cfg.wsHost!)}`
    : "";
  let closed = false;

  // ── WS transport: one persistent connection, request/response frames by id ─
  // Frames out: {id, path, token, server, tool?, args?}; frames in:
  // {id, status, body}. A dropped connection rejects the in-flight waiters as
  // retryable — same semantics as a unix-socket connect failure (the attempt
  // is re-sent after reconnect until the deadline).
  let wsLive: WebSocket | null = null;
  let wsDialing: Promise<WebSocket> | null = null;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const wsPending = new Map<
    string,
    {
      resolve: (v: { status: number; body: any }) => void;
      reject: (e: unknown) => void;
    }
  >();

  function ensureWs(): Promise<WebSocket> {
    if (closed) return Promise.reject(new Error("run-rpc relay closed"));
    if (wsLive && wsLive.readyState === WebSocket.OPEN)
      return Promise.resolve(wsLive);
    if (wsDialing) return wsDialing;
    // Keepalive: quiet minutes-long tool calls must not look idle to
    // Bun.serve's per-socket timer on the opensession side.
    keepalive ??= setInterval(() => {
      try {
        if (wsLive?.readyState === WebSocket.OPEN) wsLive.send('{"t":"ping"}');
      } catch {}
    }, 30_000);
    (keepalive as { unref?: () => void }).unref?.();
    wsDialing = new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      let sock: WebSocket;
      try {
        // Bun extension: custom headers on the client handshake.
        sock = new WebSocket(WS_DIAL_URL, {
          headers: { authorization: `Bearer ${cfg.wsAuth}` },
        } as unknown as string[]);
      } catch (e) {
        wsDialing = null;
        reject(e);
        return;
      }
      sock.onopen = () => {
        wsLive = sock;
        wsDialing = null;
        if (!settled) {
          settled = true;
          resolve(sock);
        }
      };
      sock.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg?.t === "pong") return;
        const waiter = wsPending.get(String(msg?.id || ""));
        if (waiter) {
          wsPending.delete(String(msg.id));
          waiter.resolve({ status: Number(msg.status) || 0, body: msg.body });
        }
      };
      sock.onclose = () => {
        if (wsLive === sock) wsLive = null;
        wsDialing = null;
        const err = new Error("rpc-ws connection dropped");
        for (const [id, w] of [...wsPending]) {
          wsPending.delete(id);
          w.reject(err); // retryable — rpc()'s loop re-sends after reconnect
        }
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      sock.onerror = () => {}; // onclose follows and owns the rejection
    });
    return wsDialing;
  }

  async function rpcOnceWs(
    server: string,
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<any> {
    const sock = await ensureWs();
    const id = crypto.randomUUID();
    const res = await new Promise<{ status: number; body: any }>(
      (resolve, reject) => {
        wsPending.set(id, { resolve, reject });
        // Our caller gave up: tell opensession to cancel the tool call.
        signal?.addEventListener(
          "abort",
          () => {
            if (!wsPending.delete(id)) return;
            try {
              sock.send(JSON.stringify({ t: "cancel", id }));
            } catch {}
            reject(signal.reason);
          },
          { once: true },
        );
        try {
          sock.send(
            JSON.stringify({ id, path, token: cfg.token, server, ...body }),
          );
        } catch (e) {
          wsPending.delete(id);
          reject(e);
        }
      },
    );
    return answeredBody(res.status, res.body);
  }

  async function rpcOnceSocket(
    server: string,
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<any> {
    // Aborting drops the request, which cancels the tool call on the far side.
    const res = await fetch(`http://backstage${path}`, {
      method: "POST",
      signal,
      // Bun extension: route the request over a unix socket.
      unix: SOCK,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: cfg.token, server, ...body }),
    } as any);
    let data: any = null;
    try {
      data = await res.json();
    } catch {}
    return answeredBody(res.status, data);
  }

  return {
    /**
     * One RPC to opensession over whichever transport is configured.
     * Connection-level failures (socket gone / WS dropped — opensession
     * restarting) retry until the deadline. Answered errors surface
     * immediately, except an unknown run token during restart recovery.
     */
    async rpc(server, path, body, timeoutMs = 120_000, signal) {
      const deadline = Date.now() + timeoutMs;
      let lastErr: unknown;
      for (;;) {
        signal?.throwIfAborted();
        if (closed) throw new Error("run-rpc relay closed");
        try {
          return await (WS_URL
            ? rpcOnceWs(server, path, body, signal)
            : rpcOnceSocket(server, path, body, signal));
        } catch (e) {
          if (signal?.aborted) throw e;
          if (e instanceof RpcError && !e.retryable) throw e;
          lastErr = e; // connect failure — opensession likely restarting
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `opensession unreachable at ${WS_URL || SOCK} for ${Math.round(timeoutMs / 1000)}s: ${lastErr}`,
          );
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    },
    close() {
      closed = true;
      if (keepalive) clearInterval(keepalive);
      keepalive = undefined;
      try {
        wsLive?.close();
      } catch {}
      wsLive = null;
    },
  };
}

/**
 * An MCP server that answers tools/list and tools/call for one opensession-*
 * server through `relay`. Fresh per connection: an MCP Server instance serves
 * one transport at a time.
 */
export function relayMcpServer(relay: RunRpcRelay, serverName: string): Server {
  const server = new Server(
    { name: `backstage-proxy-${serverName}`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // tools/list happens during the engine's MCP init, BEFORE the turn's
    // first output — so its retry budget must stay well under the runner's
    // 90s liveness guard. It must also cover detached-run recovery: adoption
    // plus reattach can take tens of seconds after the new server opens its
    // socket.
    const data = await relay.rpc(serverName, "/mcp/list", {}, 45_000);
    return { tools: data.tools || [] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    try {
      const args: Record<string, unknown> = {
        ...(req.params.arguments ?? {}),
      };
      // Tool calls may block for many minutes (e.g. ask_human/ask_user
      // waiting on a teammate) — allow reconnect retries well past the
      // opensession side's 30-minute per-call ceiling (run-rpc.ts) instead of
      // the default 2 minutes.
      const data = await relay.rpc(
        serverName,
        "/mcp/call",
        { tool: req.params.name, args },
        32 * 60_000,
        // The engine cancelled or timed out the call: forward that, so the
        // tool stops waiting instead of holding its answer for a dead call.
        extra.signal,
      );
      if (!data.result || typeof data.result !== "object")
        throw new Error("opensession answered without a tool result");
      return data.result;
    } catch (e: any) {
      return {
        content: [
          { type: "text", text: `Tool call failed: ${e?.message || e}` },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * The run host's mounts for its opensession-* servers: every name shares
 * `relay`, so one connection serves them all and no process is spawned.
 * Shape: src/server/mcp-runtime.ts RelayMcpMount.
 */
export function relayMcpMounts(
  relay: RunRpcRelay,
  names: readonly string[],
): Record<string, { type: "run-rpc-relay"; server: () => Server }> {
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        type: "run-rpc-relay" as const,
        server: () => relayMcpServer(relay, name),
      },
    ]),
  );
}
