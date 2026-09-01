/**
 * run-rpc — a local unix-socket RPC that lets detached run hosts reach the
 * in-process opensession-* MCP servers (opensession-sessions / -admin / -goals /
 * -humans / -repos / -goal-self), which can only execute inside the opensession
 * process (they close over live state: SessionControl, pendingAsks, attachRepo…).
 *
 * A run host injects a stdio proxy (src/runner-host/mcp-proxy.ts) per server
 * into its run's MCP config; the proxy forwards tools/list + tools/call here.
 * Because the proxy reconnects with retry, these tools now SURVIVE a opensession
 * restart mid-run — with the old in-process wiring they died with the process.
 *
 * Auth: same-uid is the trust boundary on this box, but automation runs are
 * deliberately fail-closed — every request needs a per-run bearer token that
 * opensession minted when it spawned the host (and re-registers on reattach).
 * Automation-owned runs never get a token, so untrusted ticket text can't
 * reach session-control/self-admin tools through this socket.
 *
 * Execution: per request, the registered builder constructs the SDK MCP server
 * instances for the token's {sessionId, user}, and we call the requested tool
 * through an InMemoryTransport client pair. Building per request keeps this
 * stateless across hot reloads (every mutable bit is parked on globalThis).
 */

import { existsSync, unlinkSync, chmodSync, mkdirSync } from "fs";
import { dirname } from "path";
import { timingSafeEqual } from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { audit } from "./audit";
import { devInstanceBootError, isDevInstance } from "./dev-mode";
import { MCP_HTTP_PORT, rpcSocketPath } from "./run-rpc-protocol";

const g = globalThis as any;

// Proxied tool calls can legitimately block for many minutes (opensession-humans
// ask_human in block mode waits ~20 min for a teammate; opensession-ask's ask_user
// waits on the UI question card + Slack escalation). The MCP SDK's default
// request timeout is 60s, which killed those mid-wait — pass an explicit long
// ceiling instead. Bun.serve gets idleTimeout: 0 below for the same reason
// (its default silently closes any response slower than 10s).
const RPC_TOOL_CALL_TIMEOUT_MS = 30 * 60 * 1000;

export interface RunTokenContext {
  sessionId: string;
  user?: string;
}

// token → run context. Parked on globalThis (hot reload keeps live runs'
// tokens); repopulated from host specs on boot reattach after a real restart.
// Refcounted: a SHARED engine server carries one stable token that several
// concurrent runs register/unregister (engine-runner) — the token must stay
// valid until the LAST of them finishes. ctx is the most recent registration:
// it is only the fallback identity for calls that arrive without a per-call
// ocSession tag (see dispatchRunRpc below).
const tokens: Map<string, RunTokenContext & { refs: number }> =
  (g.__runRpcTokens ??= new Map());

export function registerRunToken(token: string, ctx: RunTokenContext): void {
  const existing = tokens.get(token);
  tokens.set(token, { ...ctx, refs: (existing?.refs || 0) + 1 });
}

export function unregisterRunToken(token: string | undefined): void {
  if (!token) return;
  const existing = tokens.get(token);
  if (!existing || existing.refs <= 1) tokens.delete(token);
  else existing.refs -= 1;
}

/** Constant-time string compare (length mismatch short-circuits — the length
 *  of a random UUID token is not a secret). Used by the WS upgrade checks in
 *  src/server/run-ws.ts. NOTE: the tokens registry above is deliberately NOT
 *  consulted by any network-reachable auth check — it stays local to the unix
 *  RPC socket (frame-level context lookup); the WS routes authenticate against
 *  their own per-launch wsToken registry. */
export function timingSafeEqStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Builds the interactive MCP server set for a session — the same set the old
 * inProcessMcp wiring passed to runClaude. Registered by opensession.ts on every
 * (re)load; parked on globalThis so the long-lived socket handler always calls
 * the freshest implementation.
 */
export type InteractiveMcpBuilder = (
  sessionId: string,
  user?: string,
) => Record<string, any>;

export function registerInteractiveMcpBuilder(b: InteractiveMcpBuilder): void {
  g.__runRpcMcpBuilder = b;
}

// Per-session in-process MCP overrides: an agent loop (Slack) registers the
// exact server objects it built for its run — with loop-specific context the
// generic interactive builder can't reconstruct (channel memory, the Slack
// ask handler, opensession-github's report-back channel) — so the stdio proxies
// execute THOSE for the run's duration. Keyed by bks session id; parked on
// globalThis so a hot reload keeps live runs' overrides.
const sessionServers: Map<
  string,
  Record<string, any>
> = (g.__runRpcSessionServers ??= new Map());

export function registerSessionMcpServers(
  sessionId: string,
  servers: Record<string, any>,
): void {
  sessionServers.set(sessionId, servers);
}

export function unregisterSessionMcpServers(sessionId: string): void {
  sessionServers.delete(sessionId);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A dispatched RPC request. `immediate` carries a ready status+body (auth
 * failures, lookups, tools/list). `call` is a tool call in flight: `done`
 * resolves to `{ result }` or `{ error }` once the tool finishes (transports
 * are cleaned up internally) — the transport layer decides how to wait it out
 * (HTTP streams heartbeats around it; the WS bridge just awaits it).
 */
export type RunRpcDispatch =
  | { kind: "immediate"; status: number; body: Record<string, unknown> }
  | { kind: "call"; done: Promise<Record<string, unknown>> };

const imm = (
  status: number,
  body: Record<string, unknown>,
): RunRpcDispatch => ({
  kind: "immediate",
  status,
  body,
});

/**
 * Transport-agnostic core shared by the unix-socket HTTP handler below and
 * the WS bridge (src/server/run-ws.ts): validate the run token, build the
 * server, run tools/list or tools/call. Never throws.
 */
export async function dispatchRunRpc(
  path: string,
  body: any,
): Promise<RunRpcDispatch> {
  const token = String(body?.token || "");
  let ctx: RunTokenContext | undefined = tokens.get(token);
  if (!ctx) return imm(403, { error: "unauthorized (unknown run token)" });

  const builder: InteractiveMcpBuilder | undefined = g.__runRpcMcpBuilder;
  if (!builder) return imm(503, { error: "MCP builder not registered yet" });

  const serverName = String(body?.server || "");
  const perSession = sessionServers.get(ctx.sessionId);
  const cfg =
    perSession?.[serverName] ?? builder(ctx.sessionId, ctx.user)[serverName];
  if (!cfg?.instance) {
    // tools/list for a server this session doesn't carry (shared servers list
    // the union of in-process servers in their config) answers with an empty
    // tool list rather than an error — the proxy stays healthy and the
    // session simply sees no tools from it. Calls still 404.
    if (path === "/mcp/list") return imm(200, { tools: [] });
    return imm(404, {
      error: `no interactive MCP server "${serverName}" for this run`,
    });
  }

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "backstage-run-rpc", version: "1.0.0" });
  const cleanup = async () => {
    try {
      await client.close();
    } catch {}
    try {
      await cfg.instance.close();
    } catch {}
  };
  try {
    await cfg.instance.connect(serverTransport);
    await client.connect(clientTransport);
    if (path === "/mcp/list") {
      const res = await client.listTools();
      await cleanup();
      return imm(200, { tools: res.tools });
    }
    if (path === "/mcp/call") {
      const done: Promise<Record<string, unknown>> = client
        .callTool(
          {
            name: String(body?.tool || ""),
            arguments: body?.args ?? {},
          },
          undefined,
          { timeout: RPC_TOOL_CALL_TIMEOUT_MS },
        )
        .then(
          (res) => ({ result: res }),
          (e: any) => ({ error: e?.message || String(e) }),
        )
        .then(async (respBody) => {
          await cleanup();
          return respBody;
        });
      return { kind: "call", done };
    }
    await cleanup();
    return imm(404, { error: `unknown path ${path}` });
  } catch (e: any) {
    await cleanup();
    return imm(500, { error: e?.message || String(e) });
  }
}

async function handleRpc(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const path = new URL(req.url).pathname;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const dispatched = await dispatchRunRpc(path, body);
  if (dispatched.kind === "immediate") {
    return json(dispatched.body, dispatched.status);
  }
  // Long tool calls stream heartbeat whitespace while the call runs: Bun's
  // fetch client aborts any response idle for 300s (hard-coded — a signal
  // doesn't override it), which would kill legitimately-blocking tools
  // like ask_human/ask_user mid-wait. JSON.parse skips leading whitespace,
  // so the proxy's res.json() sees only the final body. Errors ride the
  // body as { error } (the stream is already 200 by then) — the proxy
  // treats a body-level error like a non-OK status. If the caller goes away
  // mid-call, the call still runs to completion (bounded by the call-level
  // timeout) and dispatchRunRpc's internal cleanup releases the transports.
  const done = dispatched.done;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(" "));
        } catch {}
      }, 30_000);
      void done.then((respBody) => {
        clearInterval(heartbeat);
        try {
          controller.enqueue(enc.encode(JSON.stringify(respBody)));
          controller.close();
        } catch {}
      });
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/json" },
  });
}

/**
 * Bind the socket, but ONLY when the path is free or provably dead.
 *
 * A unix bind fails outright if the path exists, so the old code unlinked
 * first — which made "take the socket" the default outcome for whoever ran
 * last. Probe instead: a path that answers a connect belongs to a live
 * process, and we decline rather than unlink it. Only a path nobody answers
 * (the previous process exited, or a stray one unlinked and left a dead
 * inode) is cleared and rebound. That makes stealing a HEALTHY server's
 * socket impossible, whatever imports it.
 *
 * The probe → unlink → bind sequence is not atomic, but it does not have to
 * be: if someone binds in between, our bind throws EADDRINUSE and we decline,
 * so the loser never clobbers the winner.
 */
async function bindRunRpcSocket(): Promise<boolean> {
  if (g.__runRpcServer) return true;
  const sock = rpcSocketPath(OPENSESSION_SESSIONS_DIR);
  mkdirSync(dirname(sock), { recursive: true });
  if (existsSync(sock)) {
    if (await rpcSocketPathAlive(sock)) {
      console.error(
        `[run-rpc] ${sock} is already served by a live process — not binding. ` +
          "In-process MCP tools stay with that process; the heal ticker takes " +
          "the path over if it ever goes dead.",
      );
      audit({ msg: "run_rpc_bind_declined", socket: sock });
      return false;
    }
    try {
      unlinkSync(sock);
    } catch {}
  }
  try {
    g.__runRpcServer = Bun.serve({
      unix: sock,
      // Bun.serve's default idleTimeout (10s) closes the socket under any
      // response slower than that — proxied tool calls routinely block longer
      // (worktree prep, blocking human asks). 0 = no idle limit; the call-level
      // timeout above is the real ceiling. (Supported at runtime on unix
      // servers; Bun's types only allow it for TCP, hence the cast.)
      idleTimeout: 0,
      fetch: (req: Request) => (g.__runRpcHandler as typeof handleRpc)(req),
    } as unknown as Parameters<typeof Bun.serve>[0]);
  } catch (e) {
    // Lost the race, or the path is unusable. Never fatal: the heal ticker
    // retries, and runs fall back to whatever the config already named.
    console.error(`[run-rpc] bind on ${sock} failed:`, e);
    audit({ msg: "run_rpc_bind_failed", socket: sock, error: String(e) });
    return false;
  }
  try {
    chmodSync(sock, 0o600);
  } catch {}
  console.log(`[run-rpc] listening on ${sock}`);
  return true;
}

/** Boot the RPC socket once; safe to call on every reload (handler is
 *  re-pointed through globalThis so new code applies without a rebind).
 *
 *  Call this from the ENTRY FILE only. It used to run as a module side effect
 *  of interactive-mcp.ts, so any script or test whose import chain reached
 *  that file bound the socket too (2026-07-16, 2026-07-17 and 2026-08-16 —
 *  each time every interactive run's MCP calls died until the heal ticker
 *  rebound). The guards below stay as belts; the fix is the missing call. */
export function startRunRpcServer(): void {
  g.__runRpcHandler = handleRpc;
  // `bun test` belt: a suite that reaches this file must never touch the
  // live socket. bun test sets NODE_ENV=test; the Bun.main check covers
  // suites that override it.
  if (process.env.NODE_ENV === "test" || /\.test\.tsx?$/.test(Bun.main || "")) {
    return;
  }
  // Fail-closed belt for the dev-instance refuse-to-boot guard in
  // opensession.ts: an unisolated dev instance must never take the live
  // socket. With isolation set (OPENSESSION_STATE_DIR /
  // OPENSESSION_SESSIONS_DIR), the socket path derives from the isolated
  // sessions dir and binding is safe.
  if (devInstanceBootError()) return;
  if (!g.__runRpcServer) void bindRunRpcSocket();
  startRunRpcSocketHeal();
}

// ── Streamable-HTTP MCP endpoint (loopback) ──────────────────────────────────
// Host-local engine runs consume the in-process opensession-* servers as
// `type:"remote"` MCP entries against this listener instead of spawning a
// `bun run mcp-proxy.ts` stdio subprocess per server per instance — which
// reached 664 processes / ~42GB RSS on 2026-07-27. Sandbox/runner-host runs
// keep the stdio proxy (inside a container 127.0.0.1 isn't opensession).
//
// Deliberately hand-rolled rather than the SDK's HTTP server transport:
// session routing must pull `__bks_oc_session` out of the raw arguments
// BEFORE dispatch picks the session's server instance, and long tool calls
// need SSE heartbeats (Bun's fetch client hard-aborts responses idle >300s —
// same constraint the unix-socket path solves with whitespace). The method
// surface engine's MCP client uses is tiny; everything funnels into the
// same dispatchRunRpc core (token auth, ocSession refinement, per-session
// overrides, automation fail-closed builder, audit).

function jsonRpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleMcpHttp(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Fresh-auth relay for OAuth-connected EXTERNAL servers (mcp-relay.ts):
  // per-request Authorization from the grant store, so short-lived tokens
  // never 401 mid-turn. Gated by its own minted token.
  const relay = url.pathname.match(/^\/relay\/([A-Za-z0-9_-]+)$/);
  if (relay) {
    const t = url.searchParams.get("t") || "";
    if (!t) return json({ error: "missing relay token" }, 401);
    const { handleMcpRelay } = await import("./mcp-relay");
    return handleMcpRelay(req, decodeURIComponent(relay[1]), t);
  }
  const m = url.pathname.match(/^\/mcp\/([A-Za-z0-9_-]+)$/);
  if (!m) return json({ error: "not found" }, 404);
  const server = m[1];
  if (req.method !== "POST") {
    // GET is the client's optional standalone SSE stream probe — a 405 tells
    // it we don't push server-initiated messages, which is true.
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  const token = (req.headers.get("authorization") || "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!token || !tokens.has(token)) {
    return json({ error: "unauthorized (unknown run token)" }, 401);
  }
  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return json(jsonRpcError(null, -32700, "parse error"), 400);
  }
  if (Array.isArray(msg)) {
    // engine's client never batches; keep the surface minimal.
    return json(jsonRpcError(null, -32600, "batching not supported"), 400);
  }
  const method = String(msg?.method || "");
  const id = msg?.id;

  // Notifications (no id) need only acknowledgement.
  if (id === undefined || id === null)
    return new Response(null, { status: 202 });

  if (method === "initialize") {
    return json(
      jsonRpcResult(id, {
        protocolVersion: msg?.params?.protocolVersion || "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: `opensession-http-${server}`, version: "1.0.0" },
      }),
    );
  }
  if (method === "ping") return json(jsonRpcResult(id, {}));

  if (method === "tools/list") {
    const d = await dispatchRunRpc("/mcp/list", { token, server });
    if (d.kind !== "immediate")
      return json(jsonRpcError(id, -32603, "unexpected dispatch"), 500);
    if (d.status !== 200) {
      return json(
        jsonRpcError(
          id,
          -32000,
          String((d.body as any)?.error || `status ${d.status}`),
        ),
      );
    }
    return json(jsonRpcResult(id, { tools: (d.body as any)?.tools ?? [] }));
  }

  if (method === "tools/call") {
    const args: Record<string, unknown> = { ...(msg?.params?.arguments ?? {}) };
    const d = await dispatchRunRpc("/mcp/call", {
      token,
      server,
      tool: String(msg?.params?.name || ""),
      args,
    });
    const toResult = (
      respBody: Record<string, unknown>,
    ): Record<string, unknown> =>
      respBody.error
        ? jsonRpcResult(id, {
            content: [
              { type: "text", text: `Tool call failed: ${respBody.error}` },
            ],
            isError: true,
          })
        : jsonRpcResult(id, respBody.result);
    if (d.kind === "immediate") {
      return json(
        d.status === 200
          ? toResult(d.body)
          : toResult({ error: (d.body as any)?.error || `status ${d.status}` }),
      );
    }
    // Long call: SSE with comment heartbeats until the dispatch resolves.
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(enc.encode(": hb\n\n"));
          } catch {}
        }, 30_000);
        void d.done.then((respBody) => {
          clearInterval(heartbeat);
          try {
            controller.enqueue(
              enc.encode(
                `event: message\ndata: ${JSON.stringify(toResult(respBody))}\n\n`,
              ),
            );
            controller.close();
          } catch {}
        });
      },
      cancel() {
        // Caller went away; the call runs to completion under its own timeout
        // and dispatchRunRpc's cleanup releases the transports.
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      },
    });
  }

  return json(jsonRpcError(id, -32601, `method not supported: ${method}`));
}

/** Boot the loopback MCP HTTP listener once; handler re-pointed through
 *  globalThis so hot reloads apply new code without a rebind. Same bun-test
 *  guard as the unix socket — a suite must never steal the live port. */
export function startMcpHttpServer(): void {
  g.__mcpHttpHandler = handleMcpHttp;
  if (process.env.NODE_ENV === "test" || /\.test\.tsx?$/.test(Bun.main || "")) {
    return;
  }
  // Dev instances must not contend for the fixed default port (3852 is held
  // by the live instance; the bind failure below is graceful but silent) —
  // bind only when a port was explicitly chosen for this instance. Config
  // generation then falls back to stdio proxies, which work everywhere.
  if (isDevInstance() && !process.env.OPENSESSION_MCP_HTTP_PORT) return;
  if (g.__mcpHttpServer) return;
  try {
    g.__mcpHttpServer = Bun.serve({
      hostname: "127.0.0.1",
      port: MCP_HTTP_PORT,
      // Proxied tool calls block for minutes; SSE heartbeats keep the client
      // side alive, idleTimeout 0 keeps ours from closing under them.
      idleTimeout: 0,
      fetch: (req: Request) =>
        (g.__mcpHttpHandler as typeof handleMcpHttp)(req),
    } as unknown as Parameters<typeof Bun.serve>[0]);
    console.log(`[run-rpc] MCP HTTP listening on 127.0.0.1:${MCP_HTTP_PORT}`);
  } catch (e) {
    // Port taken (a second instance?): config generation falls back to stdio
    // proxies when the listener isn't up — see remotePiMcpConfigs.
    console.error(`[run-rpc] MCP HTTP bind on ${MCP_HTTP_PORT} failed:`, e);
  }
}

/** True when the loopback MCP listener is actually bound in this process. */
export function mcpHttpServerActive(): boolean {
  return !!g.__mcpHttpServer;
}

/** True when a connect to the socket PATH is answered. Distinguishes a healthy
 *  bind from the stolen-socket state: an external process (a test run) that
 *  unlinked + re-bound the path and exited leaves a dead inode there while our
 *  server keeps "listening" on the orphaned one — connects get refused. */
async function rpcSocketPathAlive(sock: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      Bun.connect({
        unix: sock,
        socket: {
          open(s) {
            resolve();
            try {
              s.end();
            } catch {}
          },
          data() {},
          close() {},
          error(_s, e) {
            reject(e);
          },
          connectError(_s, e) {
            reject(e);
          },
        },
      }).catch(reject);
    });
    return true;
  } catch {
    return false;
  }
}

/** Self-heal ticker: if the socket path stops answering (unlinked, or stolen
 *  by another process that then exited), drop the orphaned listener and
 *  rebind. Turns the stolen-socket incident class from "every interactive run
 *  wedges until a human restarts the service" into a ≤30s blip.
 *
 *  It only ever binds a path nobody answers, so it cannot take a healthy
 *  socket either — which is also what lets it cover the declined-bind case: a
 *  server that found the path already served picks it up as soon as the other
 *  process lets go. */
function startRunRpcSocketHeal(): void {
  if (g.__runRpcHealTicker) return;
  g.__runRpcHealTicker = setInterval(() => {
    void (async () => {
      const sock = rpcSocketPath(OPENSESSION_SESSIONS_DIR);
      if (await rpcSocketPathAlive(sock)) return;
      if (g.__runRpcServer) {
        console.warn(
          `[run-rpc] socket path dead or stolen — rebinding ${sock}`,
        );
        audit({ msg: "run_rpc_socket_heal", socket: sock });
        try {
          (g.__runRpcServer as { stop?: (force?: boolean) => void })?.stop?.(
            true,
          );
        } catch {}
        g.__runRpcServer = undefined;
      }
      await bindRunRpcSocket();
    })();
  }, 30_000);
  (g.__runRpcHealTicker as { unref?: () => void }).unref?.();
}
