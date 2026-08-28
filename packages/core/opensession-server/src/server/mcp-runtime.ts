/**
 * Engine-neutral, turn-scoped MCP runtime.
 *
 * Importing this module has no live effects. Connections, child processes and
 * timers are created only by createMcpRuntime(), and are owned by the returned
 * runtime until close().
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { filterMcpServers, type McpScope } from "./runner-shared";
import { readCachedTools, toolsCacheKey, writeCachedTools } from "./mcp-tools-cache";
import type { InProcessMcpServer } from "./inprocess-mcp";

const DEFAULT_CALL_TIMEOUT_MS = 120_000;
export const MAX_MCP_SAFE_JSON_BYTES = 64 * 1024;
const MAX_SAFE_JSON_DEPTH = 12;
const MAX_SAFE_JSON_VALUES = 2_048;

export type McpRuntimeContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpRuntimeTool {
  readonly id: string;
  readonly server: string;
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpRuntimeCallResult {
  readonly content: McpRuntimeContent[];
}

export interface McpRuntime {
  /** Returns the post-policy catalog. hydrate:false never opens deferred servers. */
  catalog(options?: { hydrate?: boolean }): Promise<readonly McpRuntimeTool[]>;
  /** Calls only an exact identity returned by catalog(). */
  callExact(
    id: string,
    args: Record<string, unknown>,
    options: { toolCallId: string; signal?: AbortSignal },
  ): Promise<McpRuntimeCallResult>;
  /** True when a catalog may exist, including not-yet-hydrated servers. */
  readonly hasCatalog: boolean;
  close(): Promise<void>;
}

export interface McpAuditEvent {
  server: string;
  tool: string;
  ok: boolean;
  ms: number;
}

/** Explicit migration boundary for detached runner-host proxy configs.
 * New Agent Host/Executor operation routing must not use this shape. */
export interface LegacyProxyMcpBoundary {
  readonly configs: Record<string, unknown>;
}

interface ServerConn {
  client: Client;
  instance?: InProcessMcpServer["instance"];
}
interface Entry {
  name: string;
  factory: () => Promise<ServerConn>;
  cacheKey?: string;
}
interface RegisteredTool extends McpRuntimeTool {
  entry: Entry;
}

function isDeniedTool(server: string, tool: string, denied: ReadonlySet<string>): boolean {
  return denied.has(`${server}_${tool}`) || denied.has(`*_${tool}`) || denied.has(tool);
}
function isInProcessServer(value: unknown): value is InProcessMcpServer {
  return !!value && typeof value === "object" &&
    (value as { type?: unknown }).type === "sdk" &&
    !!(value as { instance?: unknown }).instance;
}
function isProxyMcpConfig(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const cfg = value as { command?: unknown; url?: unknown };
  return typeof cfg.command === "string" || typeof cfg.url === "string";
}

const VOLATILE_PROXY_ENV = [
  "OPENSESSION_RPC_TOKEN",
  "OPENSESSION_RPC_WS_AUTH",
  "OPENSESSION_RPC_WS_HOST",
] as const;
export function legacyProxyToolsCacheKey(cfg: Record<string, unknown>): string {
  const env = cfg.env && typeof cfg.env === "object"
    ? { ...(cfg.env as Record<string, unknown>) }
    : undefined;
  if (env) for (const key of VOLATILE_PROXY_ENV) delete env[key];
  return toolsCacheKey(env ? { ...cfg, env } : cfg);
}

/** Separates SDK instances from the legacy proxy config compatibility shape. */
export function splitMcpMigrationBoundary(inProcessMcp?: Record<string, unknown>): {
  sdk: Record<string, InProcessMcpServer>;
  legacyProxy?: LegacyProxyMcpBoundary;
} {
  const sdk: Record<string, InProcessMcpServer> = {};
  const configs: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(inProcessMcp ?? {})) {
    if (isInProcessServer(value)) sdk[name] = value;
    else if (isProxyMcpConfig(value)) configs[name] = value;
  }
  return {
    sdk,
    ...(Object.keys(configs).length ? { legacyProxy: { configs } } : {}),
  };
}

/** In-process mounts are coordinator-owned replacements for same-named external
 * servers. Resolve that ownership before any external connection can open. */
export function withoutInProcessMcpShadows<T>(
  external: Readonly<Record<string, T>>,
  inProcess: Readonly<Record<string, unknown>>,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [name, cfg] of Object.entries(external)) {
    if (!Object.hasOwn(inProcess, name)) out[name] = cfg;
  }
  return out;
}

function abortError(): Error {
  const error = new Error("MCP operation aborted");
  error.name = "AbortError";
  return error;
}
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new Error(message))), ms);
    const onAbort = () => finish(() => reject(abortError()));
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** JSON fallback for non-text MCP blocks. It never throws, walks cyclic input,
 * or emits more than MAX_MCP_SAFE_JSON_BYTES. */
export function boundedSafeJson(value: unknown): string {
  let values = 0;
  const seen = new WeakSet<object>();
  const visit = (input: unknown, depth: number): unknown => {
    if (++values > MAX_SAFE_JSON_VALUES) return "[value limit]";
    if (depth > MAX_SAFE_JSON_DEPTH) return "[depth limit]";
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : String(input);
    if (typeof input === "bigint") return `${input}n`;
    if (typeof input === "undefined") return "[undefined]";
    if (typeof input === "symbol" || typeof input === "function") return String(input);
    if (seen.has(input as object)) return "[circular]";
    seen.add(input as object);
    let output: unknown;
    if (Array.isArray(input)) output = input.map((item) => visit(item, depth + 1));
    else {
      const record: Record<string, unknown> = {};
      for (const key of Object.keys(input as object).sort()) {
        try { record[key] = visit((input as Record<string, unknown>)[key], depth + 1); }
        catch { record[key] = "[unreadable]"; }
      }
      output = record;
    }
    seen.delete(input as object);
    return output;
  };
  let json: string;
  try { json = JSON.stringify(visit(value, 0)) ?? "null"; }
  catch { json = '"[unserializable]"'; }
  const bytes = Buffer.byteLength(json);
  if (bytes <= MAX_MCP_SAFE_JSON_BYTES) return json;
  const suffix = "…[truncated]";
  // Oversize fallbacks remain valid JSON: encode a bounded preview as one JSON
  // string rather than cutting through an object, escape, or UTF-8 sequence.
  let end = Math.min(json.length, MAX_MCP_SAFE_JSON_BYTES - 32);
  let bounded = JSON.stringify(`${json.slice(0, end)}${suffix}`);
  while (end > 0 && Buffer.byteLength(bounded) > MAX_MCP_SAFE_JSON_BYTES) {
    end -= Math.max(1, Math.ceil((Buffer.byteLength(bounded) - MAX_MCP_SAFE_JSON_BYTES) / 2));
    bounded = JSON.stringify(`${json.slice(0, end)}${suffix}`);
  }
  return bounded;
}

function mapContent(result: Record<string, unknown>): McpRuntimeContent[] {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const out: McpRuntimeContent[] = [];
  for (const value of blocks) {
    const block = value as Record<string, unknown> | null;
    if (block?.type === "text" && typeof block.text === "string") {
      out.push({ type: "text", text: block.text });
    } else if (block?.type === "image" && typeof block.data === "string") {
      out.push({
        type: "image",
        data: block.data,
        mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png",
      });
    } else if (value != null) out.push({ type: "text", text: boundedSafeJson(value) });
  }
  if (!out.length) {
    const fallback = result.structuredContent ?? result.toolResult;
    out.push({ type: "text", text: fallback === undefined ? "" : boundedSafeJson(fallback) });
  }
  return out;
}
function errorText(content: McpRuntimeContent[]): string {
  return content.filter((item): item is Extract<McpRuntimeContent, { type: "text" }> => item.type === "text")
    .map((item) => item.text).filter(Boolean).join("\n");
}
function validListedTools(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools = value.filter((tool): tool is Record<string, unknown> =>
    !!tool && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string" &&
    !!(tool as { name: string }).name &&
    ((tool as { inputSchema?: unknown }).inputSchema === undefined ||
      (!!(tool as { inputSchema?: unknown }).inputSchema && typeof (tool as { inputSchema: unknown }).inputSchema === "object" &&
       !Array.isArray((tool as { inputSchema: unknown }).inputSchema))));
  return tools.length === value.length ? tools : undefined;
}

export async function createMcpRuntime(opts: {
  mcpServers: McpScope;
  user?: string;
  deniedToolIds: ReadonlySet<string>;
  inProcessMcp?: Readonly<Record<string, InProcessMcpServer>>;
  legacyProxyMcp?: LegacyProxyMcpBoundary;
  onAudit?: (event: McpAuditEvent) => void;
  callTimeoutMs?: number;
}): Promise<McpRuntime> {
  const timeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  let closed = false;
  const live = new Set<ServerConn>();
  const conns = new Map<string, Promise<ServerConn>>();

  const connectExternal = async (name: string, cfg: Record<string, unknown>): Promise<ServerConn> => {
    const client = new Client({ name: "opensession-mcp-runtime", version: "1.0.0" });
    const record: ServerConn = { client };
    live.add(record);
    let transport: Transport;
    if (cfg.type === "http" || cfg.type === "sse" || cfg.url) {
      const headers = { ...((cfg.headers as Record<string, string>) || {}) };
      const requestInit = Object.keys(headers).length ? { headers } : undefined;
      transport = cfg.type === "sse"
        ? new SSEClientTransport(new URL(String(cfg.url)), { requestInit })
        : new StreamableHTTPClientTransport(new URL(String(cfg.url)), { requestInit });
    } else if (cfg.command) {
      transport = new StdioClientTransport({
        command: String(cfg.command),
        args: (cfg.args as string[]) || [],
        env: { ...getDefaultEnvironment(), ...((cfg.env as Record<string, string>) || {}) },
      });
    } else throw new Error(`MCP server "${name}" has neither url nor command`);
    await client.connect(transport);
    return record;
  };
  const connectInProcess = async (server: InProcessMcpServer): Promise<ServerConn> => {
    const client = new Client({ name: "opensession-mcp-runtime", version: "1.0.0" });
    const record: ServerConn = { client, instance: server.instance };
    live.add(record);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    return record;
  };
  const ensure = (entry: Entry) => {
    let promise = conns.get(entry.name);
    if (!promise) {
      promise = entry.factory();
      conns.set(entry.name, promise);
      promise.catch(() => conns.delete(entry.name));
    }
    return promise;
  };
  const listAllTools = async (client: Client) => {
    const out: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
      const page = validListedTools(result.tools);
      if (!page) throw new Error("MCP tools/list returned an invalid catalog");
      out.push(...page);
      cursor = result.nextCursor;
    } while (cursor);
    return out;
  };

  const entries: Entry[] = [];
  const inProcess = opts.inProcessMcp ?? {};
  const external = withoutInProcessMcpShadows(
    filterMcpServers(opts.mcpServers, opts.user) as Record<string, Record<string, unknown>>,
    inProcess,
  );
  for (const [name, cfg] of Object.entries(external)) {
    entries.push({ name, factory: () => connectExternal(name, cfg), cacheKey: toolsCacheKey(cfg) });
  }
  const taken = new Set(entries.map((entry) => entry.name));
  for (const [name, server] of Object.entries(inProcess)) {
    entries.push({ name, factory: () => connectInProcess(server) });
    taken.add(name);
  }
  for (const [name, value] of Object.entries(opts.legacyProxyMcp?.configs ?? {})) {
    if (taken.has(name) || !isProxyMcpConfig(value)) continue;
    entries.push({ name, factory: () => connectExternal(name, value), cacheKey: legacyProxyToolsCacheKey(value) });
    taken.add(name);
  }

  const tools: RegisteredTool[] = [];
  const byId = new Map<string, RegisteredTool>();
  const pending = new Map<string, Entry>();
  const register = (entry: Entry, listed: Array<Record<string, unknown>>) => {
    for (const raw of listed) {
      const name = raw.name as string;
      if (isDeniedTool(entry.name, name, opts.deniedToolIds)) continue;
      const id = `${entry.name}_${name}`;
      if (byId.has(id)) continue;
      const tool: RegisteredTool = {
        id,
        server: entry.name,
        name,
        label: typeof raw.title === "string" && raw.title ? raw.title : `${entry.name}: ${name}`,
        description: typeof raw.description === "string" && raw.description
          ? raw.description : `${name} (MCP tool from ${entry.name})`,
        inputSchema: (raw.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        entry,
      };
      tools.push(tool);
      byId.set(id, tool);
    }
  };
  const listEntry = async (entry: Entry) => {
    const conn = await withTimeout(ensure(entry), timeoutMs, `MCP server "${entry.name}" connect timed out`);
    const listed = await listAllTools(conn.client);
    if (entry.cacheKey) writeCachedTools(entry.name, entry.cacheKey, listed);
    return listed;
  };
  const unavailable = (entry: Entry, started: number, error: unknown) => {
    console.warn(`[mcp-runtime] server "${entry.name}" unavailable, skipping:`, error);
    opts.onAudit?.({ server: entry.name, tool: "tools/list", ok: false, ms: Date.now() - started });
  };
  for (const entry of entries) {
    const started = Date.now();
    const cached = entry.cacheKey ? validListedTools(readCachedTools(entry.name, entry.cacheKey)) : undefined;
    if (cached) register(entry, cached);
    else if (entry.cacheKey) pending.set(entry.name, entry);
    else {
      try { register(entry, await listEntry(entry)); }
      catch (error) { unavailable(entry, started, error); }
    }
  }

  let hydration: Promise<void> | undefined;
  const hydrate = async () => {
    if (hydration) return hydration;
    const deferred = [...pending.values()];
    if (!deferred.length) return;
    pending.clear();
    hydration = Promise.all(deferred.map(async (entry) => {
      const started = Date.now();
      try {
        const listed = await listEntry(entry);
        if (!closed) register(entry, listed);
      } catch (error) { unavailable(entry, started, error); }
    })).then(() => {});
    try { await hydration; } finally { hydration = undefined; }
  };

  return {
    get hasCatalog() { return tools.length > 0 || pending.size > 0; },
    async catalog(options) {
      if (closed) throw new Error("MCP runtime is closed");
      if (options?.hydrate !== false) await hydrate();
      return tools;
    },
    async callExact(id, args, options) {
      const started = Date.now();
      const tool = byId.get(id);
      if (!tool) throw new Error(`MCP tool "${id}" is unavailable. Search the catalog first.`);
      try {
        if (closed) throw new Error("MCP runtime is closed");
        const conn = await withTimeout(
          ensure(tool.entry), timeoutMs,
          `MCP server "${tool.server}" connect timed out`, options.signal,
        );
        const result = await conn.client.callTool({
          name: tool.name,
          arguments: args,
          _meta: { opensessionToolCallId: options.toolCallId },
        }, undefined, { timeout: timeoutMs, maxTotalTimeout: timeoutMs, signal: options.signal }) as Record<string, unknown>;
        const content = mapContent(result);
        if (result.isError) throw new Error(errorText(content) || `${id} failed`);
        opts.onAudit?.({ server: tool.server, tool: tool.name, ok: true, ms: Date.now() - started });
        return { content };
      } catch (error) {
        opts.onAudit?.({ server: tool.server, tool: tool.name, ok: false, ms: Date.now() - started });
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const record of live) {
        try { await record.client.close(); } catch {}
        try { await record.instance?.close(); } catch {}
      }
      live.clear();
      conns.clear();
    },
  };
}
