/**
 * Server-side MCP tool calls against configured HTTP MCP servers — the same
 * servers sessions get, authenticated the same way (mcp-oauth grants /
 * static headers via withDynamicCredentials' source of truth). Powers
 * server-side features that should ride the MCP surface instead of a
 * parallel REST client + API key: the sidebar feeds (the feeds design
 * — "the left sidebar gets filled by a tool call to an MCP") and the
 * feed-item context injection.
 *
 * Per-user: pass the requesting user and the call runs on THEIR grant
 * (workspace grant as fallback) — so a feed band shows what the signed-in
 * viewer's account can see.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readMcpConfig } from "./connections";
import { mcpAuthHeader, mcpUserGrantHeader } from "./mcp-oauth";

export class McpToolError extends Error {}

export interface McpToolCallOptions {
  /** Require this user's own OAuth grant. Never fall back to shared or static credentials. */
  requireUserGrant?: boolean;
}

export function selectMcpAuthorization(input: {
  personal?: string;
  standard?: string;
  staticAuthorization?: string;
  requireUserGrant: boolean;
}): string | undefined {
  if (!input.requireUserGrant)
    return input.standard ?? input.staticAuthorization;
  if (!input.personal)
    throw new McpToolError("A personal OAuth grant is required");
  return input.personal;
}

/** List a server's tool catalog (name + description) — powers the New
 *  project flow's tool picker. */
export async function listMcpTools(
  serverName: string,
  user?: string,
): Promise<Array<{ name: string; description?: string }>> {
  const cfg = readMcpConfig().mcpServers[serverName] as
    | { url?: string; headers?: Record<string, string> }
    | undefined;
  if (!cfg?.url) throw new McpToolError(`No HTTP MCP server "${serverName}"`);
  const oauth = mcpAuthHeader(serverName, user);
  const auth = oauth || cfg.headers?.Authorization;
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: {
      headers: {
        ...(cfg.headers || {}),
        ...(auth ? { Authorization: auth } : {}),
      },
    },
  });
  const client = new Client({ name: "opensession-feeds", version: "1.0.0" });
  try {
    await client.connect(transport);
    const res = await client.listTools();
    return res.tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description.slice(0, 200) } : {}),
    }));
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Call one tool on a configured HTTP MCP server and return the first text
 * content, JSON-parsed when possible. Opens a fresh session per call —
 * simple and stateless; feeds cache above this layer.
 */
export async function callMcpTool<T = unknown>(
  serverName: string,
  tool: string,
  args: Record<string, unknown>,
  user?: string,
  options: McpToolCallOptions = {},
): Promise<T> {
  const cfg = readMcpConfig().mcpServers[serverName] as
    | { url?: string; headers?: Record<string, string> }
    | undefined;
  if (!cfg?.url) throw new McpToolError(`No HTTP MCP server "${serverName}"`);
  const auth = selectMcpAuthorization({
    personal: options.requireUserGrant
      ? mcpUserGrantHeader(serverName, user)
      : undefined,
    standard: options.requireUserGrant
      ? undefined
      : mcpAuthHeader(serverName, user),
    staticAuthorization: cfg.headers?.Authorization,
    requireUserGrant: options.requireUserGrant === true,
  });
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: {
      headers: {
        ...(cfg.headers || {}),
        ...(auth ? { Authorization: auth } : {}),
      },
    },
  });
  const client = new Client({ name: "opensession-feeds", version: "1.0.0" });
  const timeout = setTimeout(() => void client.close().catch(() => {}), 20_000);
  try {
    await client.connect(transport);
    const res = await client.callTool({ name: tool, arguments: args });
    const first = Array.isArray(res.content)
      ? (res.content as Array<{ type?: string; text?: string }>).find(
          (c) => c.type === "text",
        )
      : undefined;
    const text = first?.text ?? "";
    if (res.isError)
      throw new McpToolError(
        `${serverName}.${tool} failed: ${text.slice(0, 200) || "tool error"}`,
      );
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  } finally {
    clearTimeout(timeout);
    await client.close().catch(() => {});
  }
}
