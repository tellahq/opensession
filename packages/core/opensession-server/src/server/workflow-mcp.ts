/**
 * Workflow MCP host — the tool half of code mode.
 *
 * A workflow script fans out agent() calls (a full model turn each). Most of
 * what those agents actually do is one MCP call: query Prometheus, read a
 * Plain thread, list Linear issues. This module lets the SCRIPT make those
 * calls directly, so a 40-lookup fan-out costs 40 function calls instead of 40
 * model turns, and only the reduced result re-enters the conversation.
 *
 * One host per workflow run: clients connect lazily per server (first call
 * pays the handshake), are cached for the run's lifetime, and are closed by
 * close() when the run finishes — a stdio server is a child process, so a
 * leaked client is a leaked process. Concurrency, journaling and replay live
 * in workflow-runner.ts; this module is transport + policy only.
 *
 * Two kinds of server are reachable. EXTERNAL ones (linear, plain, grafana…)
 * come from mcp-config.json over stdio/HTTP. IN-PROCESS ones (opensession-*)
 * are McpServer instances living in this process; they are mounted over an
 * InMemoryTransport pair, the same way run-rpc.ts serves them to a run's own
 * stdio proxies. Without that second kind a script could not write an asset,
 * fetch a page or read memory — and the refusal read as "that server was never
 * configured" rather than as a gap in this host (2026-08-21: a run whose whole
 * job was one write_asset died in 1s with 0 agents).
 *
 * POLICY (fail-closed, mirrors the engine's run policy — see runner-shared.ts
 * and runToolPolicy):
 *  - the external surface starts as filterMcpServers(allowlist, user): an
 *    automation's least-privilege allowlist and the per-user `allowedUsers`
 *    gate both apply, exactly as they would for the run's own tools;
 *  - servers carrying money-moving confirm tools (Stripe) are dropped WHOLE.
 *    A script executes without any per-call approval bridge, so a confirm-gated
 *    tool must never be reachable from one;
 *  - the in-process surface is an ALLOWLIST (WORKFLOW_INPROCESS_ALLOWED)
 *    intersected with what the authoring run itself carries, so it can only
 *    ever narrow that set. Reads and session-scoped artifact writes are in;
 *    anything that blocks on a human, mutates agent/infra config, reaches an
 *    external human or system, or writes into future model context unseen is
 *    out (WORKFLOW_INPROCESS_EXCLUDED carries the reason, so the refusal names
 *    the policy instead of listing unrelated servers). Only interactive
 *    sessions supply an in-process builder at all — an automation's script
 *    keeps the external-only surface.
 *  - deniedTools (automation runs: Plain customer-facing writes, WorkOS
 *    identity mutation) are refused per call, plus the built-in denials in
 *    WORKFLOW_INPROCESS_TOOL_DENIALS.
 * A script can therefore never reach a tool the run that authored it couldn't.
 */

import { homeDir } from "./paths";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { readFileSync } from "fs";
import { filterMcpServers, STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import { WORKFLOW_LIMITS } from "./workflow-types";

const HOME = homeDir();

/** Servers dropped wholesale: any server owning a confirm-gated (money-moving)
 *  tool. Derived from the catalog so adding a tool there closes the hole here
 *  too — `mcp__stripe__create_refund` → `stripe`. */
function confirmGatedServers(): Set<string> {
  const out = new Set<string>();
  for (const id of Object.keys(STRIPE_CONFIRM_TOOLS)) {
    const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(id);
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * Bearer token minted by `pi mcp auth <server>` for OAuth-only HTTP
 * servers (the config carries no header for those — see the circle entry).
 * Best-effort: a missing/failed lookup just means the call 401s with the
 * server's own message.
 */
function piAuthHeader(server: string): Record<string, string> | undefined {
  try {
    const store = JSON.parse(
      readFileSync(`${HOME}/.local/share/pi/mcp-auth.json`, "utf-8"),
    ) as Record<string, { tokens?: { accessToken?: string } }>;
    const token = store?.[server]?.tokens?.accessToken;
    if (token) return { Authorization: `Bearer ${token}` };
  } catch {}
  return undefined;
}

/**
 * In-process opensession-* servers a workflow script MAY call. Reads, and
 * writes whose blast radius is this session's own artifacts. Adding a name
 * here means a model-authored script can call every tool it exposes with no
 * human in the loop, so the bar is: could an untrusted-ish script fire this a
 * hundred times and have the result stay inside the session?
 */
export const WORKFLOW_INPROCESS_ALLOWED = new Set([
  // The motivating case: a script that computes a report writes it itself.
  "opensession-assets",
  // Read the web without spending a model turn per source. Address safety is
  // enforced in our own code (web-fetch.ts blocks private/link-local hops on
  // every redirect), which is what makes an unattended fan-out safe here.
  "opensession-web",
  // Read-only over past sessions.
  "opensession-search",
  // Reads only — the write tools are denied below.
  "opensession-memory",
  // The person's own list: session-scoped and low-stakes.
  "opensession-todos",
  // Append-only friction log, read by a human later.
  "opensession-papercuts",
]);

/**
 * Every other in-process server, with the reason it is out. This map exists
 * for the ERROR MESSAGE: a script asking for opensession-admin should be told
 * it is withheld by policy, not handed a list of external servers that makes
 * the tool look like it never existed. The runtime gate is the allowlist
 * above (unknown name = refused), so a missing entry here costs a good
 * message, never access.
 */
export const WORKFLOW_INPROCESS_EXCLUDED: Record<string, string> = {
  "opensession-ask":
    "it blocks on a human answering a question card, and a script has no turn to block in",
  "opensession-humans":
    "it DMs a teammate and waits for the reply; a fan-out would spam them",
  "opensession-slack":
    "it opens a Slack composer a person has to press Send in",
  "opensession-keychain":
    "it borrows a teammate's credential on a model-authored purpose string",
  "opensession-admin":
    "it reconfigures automations and MCP connections, so a script could widen its own surface",
  "opensession-sessions":
    "it creates and steers other sessions; fan out with agent() instead",
  "opensession-workflows":
    "a workflow cannot launch workflows; use agent() and parallel() inside this script",
  "opensession-self-deploy": "it deploys and restarts this instance",
  "opensession-publish": "it publishes long-lived code that outlives the run",
  "opensession-portals": "it starts supervised services that outlive the call",
  "opensession-runners": "it executes commands on trusted persistent machines",
  "opensession-repos":
    "attaching or switching repos changes the session the run is happening in",
  "opensession-github":
    "repository writes need the human gate a PR review provides",
  "opensession-goals": "a goal persists past the run and steers future turns",
  "opensession-goal-self":
    "a goal persists past the run and steers future turns",
  "opensession-walkthrough":
    "publishing a walkthrough is a deliberate act of the session, not of a fan-out",
  "opensession-schedule":
    "it authors a future turn in the session, and a fan-out has no turn to schedule into",
};

/**
 * Tools denied on an ALLOWED in-process server. Memory writes persist into
 * every future run's prompt prefix with nobody reading them first, which is a
 * different risk from the reads that make the server worth mounting.
 */
export const WORKFLOW_INPROCESS_TOOL_DENIALS: Record<string, string> = {
  "mcp__opensession-memory__store_memory":
    "A workflow script cannot write memory (it would persist into future runs unseen). Return the fact in your result and store it from the session.",
  "mcp__opensession-memory__supersede_memory":
    "A workflow script cannot archive legacy memory. Name the entry in your result and change it from the session.",
  "mcp__opensession-memory__update_memory":
    "A workflow script cannot update memory. Return the correction in your result and update it from the session.",
  "mcp__opensession-memory__archive_memory":
    "A workflow script cannot archive memory. Name the entry in your result and archive it from the session.",
  "mcp__opensession-memory__restore_memory":
    "A workflow script cannot restore memory. Name the entry in your result and restore it from the session.",
  "mcp__opensession-memory__confirm_memory":
    "A workflow script cannot confirm memory. Name the entry in your result and confirm it from the session.",
  "mcp__opensession-memory__forget_memory":
    "A workflow script cannot delete memory. Name the entry in your result and remove it from the session.",
};

const WORKFLOW_MEMORY_READ_TOOLS = new Set([
  "search_memory",
  "list_memory",
  "read_memory",
]);

function workflowToolDenied(
  server: string,
  tool: string,
  denied: Record<string, string>,
): string | undefined {
  if (
    server === "opensession-memory" &&
    !WORKFLOW_MEMORY_READ_TOOLS.has(tool)
  ) {
    return "A workflow script can only read memory. Return proposed changes in your result for the session to apply.";
  }
  return denied[`mcp__${server}__${tool}`];
}

export interface WorkflowMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface WorkflowMcpHostOpts {
  /** The automation's MCP allowlist; omitted = every server the user may see. */
  allowlist?: string[];
  /** The run's user — drives the per-server `allowedUsers` gate. */
  user?: string;
  /** Per-call denials (automation runs). Keys are `mcp__<server>__<tool>`. */
  deniedTools?: Record<string, string>;
  /**
   * Builds the in-process opensession-* servers the AUTHORING run carries, so
   * the allowlist below can only narrow that set. Called once per host, and it
   * must return FRESH instances: an McpServer holds a single transport, so
   * connecting the session's own instance here would silently steal it from
   * run-rpc. Omitted (automation runs) = external servers only.
   */
  inProcessMcp?: () => Record<string, unknown>;
  /** Test-only: stand in for the resolved mcp-config surface. Production
   *  callers never set this — the real surface comes from filterMcpServers,
   *  so allowlist/allowedUsers gating can't be bypassed by a caller. */
  configuredForTest?: Record<string, unknown>;
}

/**
 * The server surface a workflow script may call: whatever the run itself may
 * use, minus every server owning a confirm-gated tool. Pure — the caller
 * supplies the already-user-filtered config.
 */
export function workflowMcpServers(
  configured: Record<string, unknown>,
): Record<string, unknown> {
  const gated = confirmGatedServers();
  const out: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(configured)) {
    // Money-moving: a script executes with no per-call approval bridge, so
    // these are never reachable from one.
    if (gated.has(name)) continue;
    out[name] = cfg;
  }
  return out;
}

/**
 * The in-process half: the authoring run's own opensession-* servers, kept only
 * where the allowlist says so. An intersection, never a source — a server this
 * run does not carry (a repo with papercuts off, a dev instance without
 * self-deploy) stays absent.
 */
export function workflowInProcessServers(
  carried: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(carried)) {
    if (!WORKFLOW_INPROCESS_ALLOWED.has(name)) continue;
    // Only the sdk shape can be mounted over an in-memory pair. A proxy
    // config (a detached host's stdio shim) would point back at this process
    // through a socket we have no token for, so it is skipped rather than
    // connected — see pi-mcp-bridge.ts for the two shapes.
    if ((cfg as { type?: string })?.type !== "sdk") continue;
    out[name] = cfg;
  }
  return out;
}

export interface WorkflowMcpHost {
  /** Server names the script may call (no connection made). */
  servers(): string[];
  /** Tool catalog for one server (connects on first use). */
  tools(server: string): Promise<WorkflowMcpTool[]>;
  /** Call one tool. Rejects on unknown/denied server-tool, transport failure,
   *  or an isError result. */
  call(server: string, tool: string, args: unknown): Promise<unknown>;
  /** Close every connected client (kills stdio children). Idempotent. */
  close(): Promise<void>;
}

/** Cap a resolved value so a chatty tool can't blow up the journal or the
 *  postMessage payload. Strings truncate; structures fall back to truncated
 *  JSON so the script still sees the shape. */
function capValue(value: unknown): unknown {
  const max = WORKFLOW_LIMITS.maxMcpResultChars;
  if (typeof value === "string") {
    return value.length > max ? value.slice(0, max) + "…(truncated)" : value;
  }
  let json: string;
  try {
    json = JSON.stringify(value) ?? "";
  } catch {
    return String(value).slice(0, max);
  }
  if (json.length <= max) return value;
  return json.slice(0, max) + "…(truncated)";
}

/** MCP CallToolResult → a plain JS value the script can work with:
 *  structuredContent when the server provides it, else the text blocks
 *  (JSON-parsed when they parse — most servers return JSON as text). */
function normalizeResult(result: unknown): unknown {
  const res = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  const texts = (res?.content || [])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string);
  if (res?.isError) {
    throw new Error(
      texts.join("\n").slice(0, 4000) || "tool returned an error",
    );
  }
  if (res?.structuredContent !== undefined)
    return capValue(res.structuredContent);
  if (!texts.length) return capValue(res?.content ?? null);
  const joined = texts.join("\n");
  try {
    return capValue(JSON.parse(joined));
  } catch {
    return capValue(joined);
  }
}

function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    (timer as { unref?: () => void }).unref?.();
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function createWorkflowMcpHost(
  opts: WorkflowMcpHostOpts,
): WorkflowMcpHost {
  const gated = confirmGatedServers();
  const configured =
    opts.configuredForTest ??
    (filterMcpServers(opts.allowlist ?? "all", opts.user) as Record<
      string,
      unknown
    >);
  const allowed = {
    ...workflowMcpServers(configured),
    ...workflowInProcessServers(opts.inProcessMcp?.() ?? {}),
  } as Record<string, any>;
  const denied = {
    ...WORKFLOW_INPROCESS_TOOL_DENIALS,
    ...(opts.deniedTools || {}),
  };

  // name → connection promise (cached, including in-flight).
  const clients = new Map<string, Promise<Client>>();
  // The server half of each in-memory pair, so close() tears down both ends
  // (these instances are ours — built for this run — not the session's).
  const instances = new Map<string, { close(): Promise<void> }>();
  let closed = false;

  async function connect(server: string): Promise<Client> {
    const cfg = allowed[server];
    const client = new Client(
      { name: "opensession-workflow", version: "1.0.0" },
      { capabilities: {} },
    );
    // In-process: a linked in-memory pair, exactly as run-rpc.ts serves these
    // same servers to a run's stdio proxies. No process, no socket, no port.
    if (cfg.type === "sdk" && cfg.instance) {
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await cfg.instance.connect(serverTransport);
      instances.set(server, cfg.instance);
      await client.connect(clientTransport);
      return client;
    }
    const isHttp = cfg.type === "http" || cfg.type === "sse" || !!cfg.url;
    if (isHttp) {
      const url = new URL(String(cfg.url));
      const headers: Record<string, string> = {
        ...(cfg.headers || {}),
      };
      if (!headers.Authorization && !headers.authorization) {
        Object.assign(headers, piAuthHeader(server) || {});
      }
      const init = { requestInit: { headers } };
      try {
        await client.connect(new StreamableHTTPClientTransport(url, init));
      } catch (e) {
        // Older servers only speak the SSE transport.
        await client.connect(new SSEClientTransport(url, init as any));
      }
      return client;
    }
    if (!cfg.command) {
      throw new Error(`MCP server "${server}" has neither a url nor a command`);
    }
    await client.connect(
      new StdioClientTransport({
        command: String(cfg.command),
        args: (cfg.args || []).map(String),
        // The SDK's default environment is already a minimal safe set
        // (PATH/HOME/…); the server's own credentials come from its config
        // entry — never the server process's full secret-bearing env.
        env: { ...getDefaultEnvironment(), ...(cfg.env || {}) },
        stderr: "ignore",
      }),
    );
    return client;
  }

  function clientFor(server: string): Promise<Client> {
    const cached = clients.get(server);
    if (cached) return cached;
    const promise = withTimeout(
      connect(server),
      WORKFLOW_LIMITS.mcpConnectTimeoutMs,
      `connecting to MCP server "${server}"`,
    ).catch((e) => {
      // Don't cache a failed handshake — a later call may succeed.
      clients.delete(server);
      throw e;
    });
    clients.set(server, promise);
    return promise;
  }

  function assertAllowed(server: string, tool?: string): void {
    if (closed) throw new Error("workflow finished — MCP host is closed");
    if (!allowed[server]) {
      const names = Object.keys(allowed).sort().join(", ");
      // Say WHY, not just what's left: a bare "available: linear, plain, …"
      // reads as "that server was never configured", which sends the script
      // looking for a different tool instead of reporting the policy.
      const excluded = WORKFLOW_INPROCESS_EXCLUDED[server];
      const reason = gated.has(server)
        ? ` — "${server}" is confirm-gated and never reachable from a workflow script; propose the action in your result for a human to run`
        : excluded
          ? ` — "${server}" is an in-process server that workflow scripts cannot call: ${excluded}. Do that part yourself in the session once the run finishes`
          : server.startsWith("opensession-")
            ? ` — in-process opensession-* servers are not available to this workflow. Return what you have in the result and do that part from the session`
            : "";
      throw new Error(
        `no MCP server "${server}" available to this workflow${reason}. Available: ${names || "(none)"}`,
      );
    }
    if (tool) {
      const reason = workflowToolDenied(server, tool, denied);
      if (reason)
        throw new Error(`${server}.${tool} is not available: ${reason}`);
    }
  }

  return {
    servers(): string[] {
      return Object.keys(allowed).sort();
    },

    async tools(server: string): Promise<WorkflowMcpTool[]> {
      assertAllowed(server);
      const client = await clientFor(server);
      const listed = await withTimeout(
        client.listTools(),
        WORKFLOW_LIMITS.mcpCallTimeoutMs,
        `listing ${server} tools`,
      );
      return (listed.tools || [])
        .filter((t) => !workflowToolDenied(server, t.name, denied))
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
    },

    async call(server: string, tool: string, args: unknown): Promise<unknown> {
      assertAllowed(server, tool);
      const client = await clientFor(server);
      const result = await withTimeout(
        client.callTool({
          name: tool,
          arguments: (args ?? {}) as Record<string, unknown>,
        }),
        WORKFLOW_LIMITS.mcpCallTimeoutMs,
        `${server}.${tool}`,
      );
      return normalizeResult(result);
    },

    async close(): Promise<void> {
      closed = true;
      const pending = [...clients.values()];
      clients.clear();
      const servers = [...instances.values()];
      instances.clear();
      await Promise.all(
        pending.map(async (p) => {
          try {
            const client = await p;
            await client.close();
          } catch {
            // A client that never connected (or already died) needs no
            // teardown — never let cleanup surface as a run failure.
          }
        }),
      );
      // The server half of an in-memory pair holds this run's own instance;
      // leaving it connected would leak one per workflow run.
      await Promise.all(
        servers.map(async (instance) => {
          try {
            await instance.close();
          } catch {}
        }),
      );
    },
  };
}
