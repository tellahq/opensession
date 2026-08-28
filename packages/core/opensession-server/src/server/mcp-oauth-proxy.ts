/**
 * Server-side MCP proxies for personal OAuth connections.
 *
 * The engine gets the existing run-rpc MCP capability and a tool catalog. The
 * provider credential is decrypted only in the coordinator, immediately before
 * opening the upstream HTTP transport. Provider tokens therefore never cross
 * into an engine process or remote sandbox. Stdio grants remain available to
 * coordinator-owned UI actions, but are never handed to the mutable local
 * executable.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { InProcessMcpServer } from "./inprocess-mcp";
import { readMcpConfig } from "./connections";
import {
  hasMcpOauthProxyGrantForUsers,
  mcpAuthHeaderFresh,
  mcpOauthBindingMatches,
} from "./mcp-oauth";
import {
  filterMcpServerCatalog,
  type McpScope,
} from "./runner-shared";
import { audit } from "./audit";

function grantUsers(input: Array<string | undefined>): string[] {
  return [...new Set(input.filter((u): u is string => !!u))];
}

async function connectUpstream(
  name: string,
  cfg: Record<string, any>,
  users: string[],
): Promise<{ client: Client; slot: string }> {
  if (!mcpOauthBindingMatches(name, cfg)) {
    throw new Error("Personal connection configuration changed");
  }
  const grant = await mcpAuthHeaderFresh(name, users);
  if (!grant) throw new Error("Personal connection is unavailable");
  const client = new Client({ name: "opensession-oauth-proxy", version: "1.0.0" });
  if (!(cfg.type === "http" || cfg.type === "sse" || cfg.url)) {
    throw new Error("Personal OAuth is supported only for remote HTTP MCP servers");
  }
  const headers = new Headers(cfg.headers || {});
  headers.set("Authorization", grant.header);
  const requestInit = { headers };
  const transport: Transport =
    cfg.type === "sse"
      ? new SSEClientTransport(new URL(cfg.url), { requestInit })
      : new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit });
  try {
    await client.connect(transport);
    return { client, slot: grant.slot };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

function createProxy(
  name: string,
  cfg: Record<string, any>,
  users: string[],
  actor?: string,
): InProcessMcpServer {
  const server = new Server(
    { name: `opensession-oauth-${name}`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let client: Client | undefined;
    try {
      ({ client } = await connectUpstream(name, cfg, users));
      const tools: any[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return { tools };
    } catch {
      throw new Error(`The ${name} personal connection is unavailable.`);
    } finally {
      await client?.close().catch(() => {});
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const started = Date.now();
    let client: Client | undefined;
    let slot: string | undefined;
    try {
      ({ client, slot } = await connectUpstream(name, cfg, users));
      const result = await client.callTool({
        name: request.params.name,
        arguments: request.params.arguments || {},
      });
      audit({
        kind: "mcp_oauth_proxy_call",
        server: name,
        tool: request.params.name,
        actor,
        slot,
        ok: true,
        ms: Date.now() - started,
      });
      return result;
    } catch {
      audit({
        kind: "mcp_oauth_proxy_call",
        server: name,
        tool: request.params.name,
        actor,
        slot,
        ok: false,
        ms: Date.now() - started,
      });
      return {
        content: [{ type: "text", text: `The ${name} personal connection call failed.` }],
        isError: true,
      };
    } finally {
      await client?.close().catch(() => {});
    }
  });
  return {
    type: "sdk",
    name,
    // Low-level Server and McpServer share the connect/close contract consumed
    // by run-rpc and the Pi bridge; the low-level form supports dynamic tools.
    instance: server as unknown as McpServer,
  };
}

export function mcpOauthProxyServers(
  scope: McpScope,
  user: string | undefined,
  identities: Array<string | undefined>,
): Record<string, InProcessMcpServer> {
  const users = grantUsers(identities);
  const visible = filterMcpServerCatalog(
    readMcpConfig().mcpServers,
    scope,
    user,
    identities,
  ) as Record<string, Record<string, any>>;
  const out: Record<string, InProcessMcpServer> = {};
  for (const [name, cfg] of Object.entries(visible)) {
    if (name.startsWith("opensession-") || name.startsWith("michael-")) continue;
    if (!hasMcpOauthProxyGrantForUsers(name, users)) continue;
    out[name] = createProxy(name, cfg, users, user);
  }
  return out;
}
