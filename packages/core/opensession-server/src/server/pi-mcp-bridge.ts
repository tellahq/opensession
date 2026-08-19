/**
 * MCP → Pi tool bridge: turns a run's MCP surface — external servers from
 * mcp-config.json plus the in-process opensession-* servers — into Pi
 * `customTools` (ToolDefinition objects) for the in-process pi engine
 * (pi-runner.ts). Hand-rolled on @modelcontextprotocol/sdk (the v1 stack we
 * already ship everywhere else); mcporter/pi-mcporter were rejected — parallel
 * MCP v2 stack, default interactive-OAuth hazard, and policy living in their
 * config files instead of ours.
 *
 * Policy is enforced by ABSENCE, in our layer:
 *  - External servers resolve ONLY through `filterMcpServers` (per-run
 *    allowlist + per-user `allowedUsers` gating, metadata stripped) — the
 *    same helper every other runner enforces with.
 *  - `deniedToolIds` are dropped BEFORE a ToolDefinition is built, so the
 *    model never sees them. Ids follow the engine-neutral `<server>_<tool>`
 *    convention (opencodeDeniedToolIds); the broad forms `*_<tool>` and bare
 *    `<tool>` are honored too so the money-mover confirm set strips the same
 *    way it does on the opencode engine.
 *
 * Wiring notes:
 *  - In-process servers (instances from inprocess-mcp.ts, built per-session
 *    by interactive-mcp.ts) connect directly over an InMemoryTransport pair —
 *    no stdio proxy hop, no run-rpc token: we're in the same process.
 *  - `inProcessMcp` has a SECOND shape, and it is the one detached run hosts
 *    and sandboxed runs use: a stdio proxy CONFIG (runner-host/mcp-proxy.ts)
 *    that forwards tools/list and tools/call back to the opensession process
 *    over the run-rpc socket, because the real instances live there and not
 *    in the host. Those mount through the ordinary external stdio path (see
 *    classifyInProcessMcp). Accepting only the instance shape is what silently
 *    stripped every opensession-* server from hosted pi runs until 2026-08-19.
 *  - OAuth-granted servers are omitted here and mounted as coordinator-side
 *    in-process proxies (mcp-oauth-proxy.ts), so provider tokens never enter
 *    Pi state or a model-controlled process.
 *  - stdio servers spawn with getDefaultEnvironment() + the server's own
 *    configured env — never this process's env (it holds Open Session tokens).
 *
 * Lifecycle: MCP has no offline tool discovery — `tools/list` needs a live
 * connection — so the catalog is cached per config entry (mcp-tools-cache.ts)
 * and a warm external server contributes its tools with NO connection at all.
 * Its connect then happens on first real use, because `ensure()` is called
 * inside each tool's `execute` rather than at build. A cold server (new,
 * changed config, or past the cache TTL) connects once at build and populates
 * the cache; in-process servers always list live, since an InMemoryTransport
 * hop in this process costs nothing to open. This is the "unused stdio servers
 * never spawn" case that v1 deferred. A server that fails to connect/list
 * degrades to absent tools (warn + audit), never a failed turn; a wedged call
 * times out and fails that call, not the turn; a cached tool that has since
 * vanished upstream fails that one call and the entry is rewritten next build.
 * `close()` tears down every client and connected in-process instance.
 *
 * The pi package is imported TYPE-ONLY here: the bridge must be importable
 * (tests, pi-runner module load) without triggering the pi dep tree's cold
 * Bun transpile.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { filterMcpServers, type McpScope } from "./runner-shared";
import { readCachedTools, toolsCacheKey, writeCachedTools } from "./mcp-tools-cache";
import { hasMcpOauthGrantForUsers } from "./mcp-oauth";
import type { InProcessMcpServer } from "./inprocess-mcp";

const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/** Pi tool-result content blocks (structural match for pi-ai's
 *  TextContent/ImageContent — declared locally to keep the import type-only). */
type PiContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface PiMcpBridge {
  /** Full post-policy catalog, used by the bridge's compact dispatcher. */
  tools: ToolDefinition<any, any, any>[];
  /**
   * Small MCP surface exposed to Pi. Keeping hundreds of JSON schemas out of
   * every provider request avoids turning a normal code task into a massive
   * cached prompt. Search always returns only tools already admitted to
   * `tools`, and call can execute only a catalogued definition.
   */
  discoveryTools: ToolDefinition<any, any, any>[];
  /** Tear down every transport (and connected in-process instance). */
  close(): Promise<void>;
}

interface ServerConn {
  client: Client;
  /** Present for in-process servers so close() disconnects the instance too. */
  instance?: InProcessMcpServer["instance"];
}

/** `<server>_<tool>` denied-set membership, exact + the broad forms the
 *  money-mover confirm set uses (see opencodeDeniedToolIds: `*_<tool>` and
 *  bare `<tool>` over-block same-named tools by design there — mirror it). */
function isDeniedTool(
  server: string,
  tool: string,
  denied: ReadonlySet<string>,
): boolean {
  return (
    denied.has(`${server}_${tool}`) || denied.has(`*_${tool}`) || denied.has(tool)
  );
}

function isInProcessServer(v: unknown): v is InProcessMcpServer {
  return (
    !!v &&
    typeof v === "object" &&
    (v as { type?: unknown }).type === "sdk" &&
    !!(v as { instance?: unknown }).instance
  );
}

/**
 * The SECOND shape `RunAgentOpts.inProcessMcp` carries: a stdio (or HTTP) MCP
 * config for a PROXY that forwards tools/list and tools/call back to the
 * opensession process (runner-host/mcp-proxy.ts over the run-rpc socket).
 *
 * A detached run host passes this instead of SDK instances (host.ts's
 * proxyMcpConfigs), and so does every sandboxed run, because the in-process
 * servers live in the opensession process and simply do not exist there. Pi
 * only ever accepted the instance shape and silently `continue`d past the
 * rest, so a hosted pi run lost every opensession-* server while keeping all
 * its external ones — the failure looked like the tools had never been
 * configured (2026-08-19).
 *
 * Mounting these widens nothing: membership is fixed by the spec's
 * `proxyMcpServers`, and each call still authenticates with the run's own rpc
 * token, which dispatchRunRpc resolves back to this session and user (and the
 * interactive builder stays fail-closed for automation-owned sessions).
 */
function isProxyMcpConfig(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object") return false;
  const cfg = v as { command?: unknown; url?: unknown };
  return typeof cfg.command === "string" || typeof cfg.url === "string";
}

/** Per-run secrets inside a proxy config's env. Hashing them would give every
 *  run a fresh cache key, so the catalog cache could never hit and each turn
 *  would spawn one stdio child per opensession-* server purely to list tools
 *  (20 of them, sequentially, before the first token). A proxied catalog is a
 *  property of the server NAME, not of this run's token.
 *
 *  INVARIANT this relies on: a proxied server's tool LIST does not vary by
 *  session or user. It doesn't today — the run token scopes what a CALL does
 *  (dispatchRunRpc resolves it to a session and user, and the builder is
 *  fail-closed for automation-owned sessions), while which servers a run
 *  mounts at all is fixed by the spec's proxyMcpServers, and per-session
 *  servers carry their own distinct names (opensession-goal-self). If a server
 *  ever returns a different tool list per caller, that distinguishing bit has
 *  to enter this key, or one caller's catalog shape is served to another. */
const VOLATILE_PROXY_ENV = [
  "OPENSESSION_RPC_TOKEN",
  "OPENSESSION_RPC_WS_AUTH",
  "OPENSESSION_RPC_WS_HOST",
] as const;

function proxyToolsCacheKey(cfg: Record<string, unknown>): string {
  const env =
    cfg.env && typeof cfg.env === "object"
      ? { ...(cfg.env as Record<string, unknown>) }
      : undefined;
  if (env) for (const key of VOLATILE_PROXY_ENV) delete env[key];
  return toolsCacheKey(env ? { ...cfg, env } : cfg);
}

/** One mountable `inProcessMcp` entry: an SDK instance connected over an
 *  InMemoryTransport, or a proxy config connected like any other stdio/HTTP
 *  server. */
export type InProcessMount =
  | { name: string; kind: "sdk"; server: InProcessMcpServer }
  | { name: string; kind: "proxy"; cfg: Record<string, unknown>; cacheKey: string };

/**
 * Which `inProcessMcp` entries this bridge can mount, and how. Split out and
 * exported because the proxy branch is the one hosted runs depend on and it
 * cannot be reached from an in-memory fixture — an unrecognized shape is
 * dropped silently by design (a caller may pass a server this engine has no
 * transport for), which is exactly what made the original bug invisible.
 */
export function classifyInProcessMcp(
  inProcessMcp: Record<string, unknown> | undefined,
  taken: ReadonlySet<string> = new Set(),
): InProcessMount[] {
  const out: InProcessMount[] = [];
  for (const [name, v] of Object.entries(inProcessMcp ?? {})) {
    // An external server of the same name wins; never double-mount.
    if (taken.has(name)) continue;
    if (isInProcessServer(v)) out.push({ name, kind: "sdk", server: v });
    else if (isProxyMcpConfig(v))
      out.push({ name, kind: "proxy", cfg: v, cacheKey: proxyToolsCacheKey(v) });
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** MCP result content → Pi content blocks. text/image map 1:1 (pi
 *  auto-resizes oversize images on entry to history); resource/audio/unknown
 *  blocks and compat/structured-only results JSON-stringify to text. */
function mapContent(res: Record<string, unknown>): PiContent[] {
  const blocks = Array.isArray(res?.content) ? res.content : [];
  const out: PiContent[] = [];
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") {
      out.push({ type: "text", text: b.text });
    } else if (b?.type === "image" && typeof b.data === "string") {
      out.push({
        type: "image",
        data: b.data,
        mimeType: typeof b.mimeType === "string" ? b.mimeType : "image/png",
      });
    } else if (b != null) {
      out.push({ type: "text", text: JSON.stringify(b) });
    }
  }
  if (!out.length) {
    const fallback = res?.structuredContent ?? res?.toolResult;
    out.push({
      type: "text",
      text: fallback !== undefined ? JSON.stringify(fallback) : "",
    });
  }
  return out;
}

function errorText(content: PiContent[]): string {
  return content
    .filter((c): c is Extract<PiContent, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .filter(Boolean)
    .join("\n");
}

export async function createPiMcpBridge(opts: {
  /** Same as RunAgentOpts.mcpServers ("all" | string[]) — pass [] for none. */
  mcpServers: McpScope;
  user?: string;
  /** OAuth grant identity override (session creator) — same priority order
   *  as buildOpencodeMcpConfig: creator first, prompter second. */
  mcpGrantUser?: string;
  /** `<server>_<tool>` ids (plus broad `*_<tool>`/bare forms) dropped BEFORE
   *  registration — the model never sees them. */
  deniedToolIds: ReadonlySet<string>;
  /** RunAgentOpts.inProcessMcp — instances from inprocess-mcp.ts. */
  inProcessMcp?: Record<string, unknown>;
  onAudit?: (e: { server: string; tool: string; ok: boolean; ms: number }) => void;
  /** Per tool call (and per connect/list at creation). Default 120s. */
  callTimeoutMs?: number;
}): Promise<PiMcpBridge> {
  const timeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const grantUsers = [opts.user];
  let closed = false;

  // Every ServerConn ever built, memoized or not, so close() reaches clients
  // whose connect never resolved (client.close() tears the transport down
  // mid-connect, killing a wedged stdio child).
  const live = new Set<ServerConn>();
  const conns = new Map<string, Promise<ServerConn>>();

  const connectExternal = async (
    name: string,
    cfg: Record<string, unknown>,
  ): Promise<ServerConn> => {
    const client = new Client({ name: "opensession-pi-bridge", version: "1.0.0" });
    const rec: ServerConn = { client };
    live.add(rec);
    let transport: Transport;
    if (cfg.type === "http" || cfg.type === "sse" || cfg.url) {
      const url = String(cfg.url);
      const headers = { ...((cfg.headers as Record<string, string>) || {}) };
      const requestInit = Object.keys(headers).length ? { headers } : undefined;
      // sse: requestInit covers the POST side; the GET event stream can't
      // carry custom headers through EventSource — matches the engine-side
      // limitation, and our configured servers are streamable-http.
      transport =
        cfg.type === "sse"
          ? new SSEClientTransport(new URL(url), { requestInit })
          : new StreamableHTTPClientTransport(new URL(url), { requestInit });
    } else if (cfg.command) {
      transport = new StdioClientTransport({
        command: String(cfg.command),
        args: (cfg.args as string[]) || [],
        // Safe inherit-set + the server's own configured credentials — never
        // this process's env (it holds Open Session tokens).
        env: {
          ...getDefaultEnvironment(),
          ...((cfg.env as Record<string, string>) || {}),
        },
      });
    } else {
      throw new Error(`MCP server "${name}" has neither url nor command`);
    }
    await client.connect(transport);
    return rec;
  };

  const connectInProcess = async (
    server: InProcessMcpServer,
  ): Promise<ServerConn> => {
    const client = new Client({ name: "opensession-pi-bridge", version: "1.0.0" });
    const rec: ServerConn = { client, instance: server.instance };
    live.add(rec);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    return rec;
  };

  const ensure = (name: string, factory: () => Promise<ServerConn>) => {
    let p = conns.get(name);
    if (!p) {
      p = factory();
      conns.set(name, p);
      p.catch(() => conns.delete(name));
    }
    return p;
  };

  const listAllTools = async (client: Client) => {
    const out: Array<Record<string, any>> = [];
    let cursor: string | undefined;
    do {
      const res = await client.listTools(cursor ? { cursor } : undefined, {
        timeout: timeoutMs,
      });
      out.push(...(res.tools as Array<Record<string, any>>));
      cursor = res.nextCursor;
    } while (cursor);
    return out;
  };

  const bridgedTool = (
    server: string,
    tool: Record<string, any>,
    getConn: () => Promise<ServerConn>,
  ): ToolDefinition<any, any, any> => {
    const id = `${server}_${tool.name}`;
    return {
      name: id,
      label:
        typeof tool.title === "string" && tool.title
          ? tool.title
          : `${server}: ${tool.name}`,
      description:
        typeof tool.description === "string" && tool.description
          ? tool.description
          : `${tool.name} (MCP tool from ${server})`,
      // MCP inputSchema is JSON Schema; TypeBox IS JSON Schema — passthrough.
      parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as any,
      execute: async (_toolCallId, params, signal) => {
        const started = Date.now();
        try {
          if (closed) throw new Error("MCP bridge is closed");
          const conn = await withTimeout(
            getConn(),
            timeoutMs,
            `MCP server "${server}" connect timed out`,
          );
          const res = (await conn.client.callTool(
            { name: tool.name, arguments: (params ?? {}) as Record<string, unknown> },
            undefined,
            { timeout: timeoutMs, maxTotalTimeout: timeoutMs, signal },
          )) as Record<string, unknown>;
          const content = mapContent(res);
          // Pi convention: tool errors are THROWN, not encoded in the result.
          if (res.isError) throw new Error(errorText(content) || `${id} failed`);
          opts.onAudit?.({ server, tool: tool.name, ok: true, ms: Date.now() - started });
          return { content, details: undefined };
        } catch (e) {
          opts.onAudit?.({ server, tool: tool.name, ok: false, ms: Date.now() - started });
          throw e instanceof Error ? e : new Error(String(e));
        }
      },
    };
  };

  // ── Resolve the server set ─────────────────────────────────────────────────
  // `cacheKey` keys the catalog cache on the server's own config entry, so
  // editing command/args/env/url re-lists at once. SDK instances get none —
  // listing one is a function call in this process. Proxy configs DO get one
  // (minus the per-run token, see proxyToolsCacheKey): they are stdio children
  // like any other external server, and a warm cache is what keeps a hosted
  // run from spawning twenty of them before its first token.
  const entries: Array<{
    name: string;
    factory: () => Promise<ServerConn>;
    cacheKey?: string;
  }> = [];
  const external = filterMcpServers(
    opts.mcpServers,
    opts.user,
    opts.mcpGrantUser ? grantUsers : undefined,
  ) as Record<string, Record<string, unknown>>;
  for (const [name, cfg] of Object.entries(external)) {
    // Personal OAuth servers arrive below as coordinator-side in-process
    // proxies. Do not build a second connection whose config could contain or
    // fall back to a provider credential.
    if (hasMcpOauthGrantForUsers(name, grantUsers)) continue;
    entries.push({
      name,
      factory: () => connectExternal(name, cfg),
      cacheKey: toolsCacheKey(cfg),
    });
  }
  for (const mount of classifyInProcessMcp(
    opts.inProcessMcp,
    new Set(entries.map((e) => e.name)),
  )) {
    entries.push(
      mount.kind === "sdk"
        ? { name: mount.name, factory: () => connectInProcess(mount.server) }
        : {
            name: mount.name,
            factory: () => connectExternal(mount.name, mount.cfg),
            cacheKey: mount.cacheKey,
          },
    );
  }

  // ── List + register (deny BEFORE defineTool; dead servers degrade) ─────────
  const tools: ToolDefinition<any, any, any>[] = [];
  const seen = new Set<string>();
  for (const { name, factory, cacheKey } of entries) {
    const started = Date.now();
    // A cache hit is the whole point: no connect, no stdio child, no dial —
    // the server is only reached if the model actually calls one of its tools.
    let listed: Array<Record<string, any>> | undefined = cacheKey
      ? (readCachedTools(name, cacheKey) as Array<Record<string, any>> | undefined)
      : undefined;
    if (!listed) {
      try {
        const conn = await withTimeout(
          ensure(name, factory),
          timeoutMs,
          `MCP server "${name}" connect timed out`,
        );
        listed = await listAllTools(conn.client);
        if (cacheKey) writeCachedTools(name, cacheKey, listed);
      } catch (e) {
        console.warn(`[pi-mcp-bridge] server "${name}" unavailable, skipping:`, e);
        opts.onAudit?.({ server: name, tool: "tools/list", ok: false, ms: Date.now() - started });
        continue;
      }
    }
    for (const t of listed) {
      if (typeof t?.name !== "string" || !t.name) continue;
      if (isDeniedTool(name, t.name, opts.deniedToolIds)) continue;
      const def = bridgedTool(name, t, () => ensure(name, factory));
      if (seen.has(def.name)) continue;
      seen.add(def.name);
      tools.push(def);
    }
  }

  // Pi forwards every custom tool's JSON schema through the Agent SDK on
  // every model request. The full catalog is often hundreds of tools, which
  // can turn into a several-hundred-thousand-token cached prefix and make a
  // healthy turn look wedged. Keep the catalog server-side and expose a
  // two-step surface instead. This is discovery, not an access grant: both
  // tools close over the already policy-filtered `tools` list above.
  const byName = new Map(tools.map((definition) => [definition.name, definition]));
  // Fields are kept APART rather than concatenated into one haystack: a hit in
  // the tool's NAME is real evidence, a hit in a 20,000-character vendor
  // description is usually an accident. A flat substring count over a single
  // haystack made every verbose tool match every query (a long enough
  // description contains "run", "workflow", "agent" somewhere), and the
  // alphabetical tie-break then handed the results to whichever server sorts
  // first — so searching for a capability returned unrelated tools while the
  // tool literally named after it never surfaced.
  const searchable = tools.map((definition) => ({
    definition,
    name: definition.name.toLowerCase(),
    label: (definition.label || "").toLowerCase(),
    description: (definition.description || "").toLowerCase(),
  }));
  /** Description hits are damped by length, so a short precise description
   *  outweighs an encyclopaedic one that merely contains the word. */
  const describedWeight = (length: number) => Math.min(1, 400 / Math.max(length, 400));
  const searchCatalog: ToolDefinition<any, any, any> = {
    name: "mcp_search",
    label: "Search MCP tools",
    description:
      "Search the available MCP tool catalog before calling mcp_call. " +
      "Use the returned tool name and argument schema exactly.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What capability you need" },
        limit: { type: "number", description: "Maximum matches to return, 1 to 12 (default 6)" },
      },
      required: ["query"],
    } as any,
    async execute(_toolCallId, params) {
      const query = String((params as { query?: unknown })?.query ?? "").trim().toLowerCase();
      if (!query) throw new Error("mcp_search requires a query");
      const requested = Number((params as { limit?: unknown })?.limit);
      const limit = Number.isFinite(requested) ? Math.max(1, Math.min(12, Math.floor(requested))) : 6;
      const terms = query.split(/\s+/).filter(Boolean);
      const compact = query.replace(/[\s_-]+/g, "");
      const matches = searchable
        .map((entry) => {
          const weight = describedWeight(entry.description.length);
          let score = 0;
          for (const term of terms) {
            if (entry.name.includes(term)) score += 10;
            else if (entry.label.includes(term)) score += 5;
            else if (entry.description.includes(term)) score += 3 * weight;
          }
          // The whole query spelled as a tool name ("run workflow" →
          // run_workflow) is the strongest signal there is.
          if (compact && entry.name.replace(/[_-]/g, "").includes(compact)) score += 15;
          return { entry, score };
        })
        .filter(({ score }) => score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            // Then the more specific tool, not whichever server sorts first.
            a.entry.description.length - b.entry.description.length ||
            a.entry.name.localeCompare(b.entry.name),
        )
        .slice(0, limit);
      // Descriptions are trimmed here but schemas are not: the model needs the
      // exact arguments to call, and some vendor descriptions are longer than
      // everything else in the result put together.
      const brief = (text: string) =>
        text.length > 700 ? `${text.slice(0, 700)}… [truncated]` : text;
      const text = matches.length
        ? matches
            .map(
              ({ entry }) =>
                `${entry.definition.name}: ${brief(entry.definition.description || "")}\narguments: ${JSON.stringify(entry.definition.parameters)}`,
            )
            .join("\n\n")
        : `No permitted MCP tools matched "${query}". Try broader capability words.`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
  const callCatalog: ToolDefinition<any, any, any> = {
    name: "mcp_call",
    label: "Call MCP tool",
    description:
      "Call a tool returned by mcp_search. Pass its exact name and an arguments object matching its schema.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact tool name returned by mcp_search" },
        arguments: { type: "object", description: "Arguments for that tool" },
      },
      required: ["name", "arguments"],
    } as any,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const name = String((params as { name?: unknown })?.name ?? "");
      const definition = byName.get(name);
      if (!definition) throw new Error(`MCP tool "${name}" is unavailable. Search the catalog first.`);
      const args = (params as { arguments?: unknown })?.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("mcp_call arguments must be an object");
      }
      return definition.execute(toolCallId, args as any, signal, onUpdate, ctx);
    },
  };
  const discoveryTools = tools.length ? [searchCatalog, callCatalog] : [];

  const close = async () => {
    if (closed) return;
    closed = true;
    for (const rec of live) {
      try {
        await rec.client.close();
      } catch {}
      try {
        await rec.instance?.close();
      } catch {}
    }
    live.clear();
    conns.clear();
  };

  return { tools, discoveryTools, close };
}
