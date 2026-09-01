/**
 * In-process MCP servers (opensession-admin / -sessions / -goals / -humans /
 * -repos / -preview / -github / -ask) — our own thin wrapper over
 * @modelcontextprotocol/sdk, replacing the Claude Agent SDK's
 * createSdkMcpServer/tool helpers with the exact same call shape.
 *
 * The server object carries a live McpServer `instance` that executes inside
 * the Open Session process (tools close over live state: SessionControl,
 * pendingAsks, attachRepo…). Consumers:
 *  - run-rpc.ts connects `instance` over an InMemoryTransport pair and
 *    forwards tools/list + tools/call from the per-run stdio proxies
 *    (src/runner-host/mcp-proxy.ts) that pi runs receive.
 *  - pi-runner's proxyPiMcpConfigs turns the server names into
 *    those stdio proxy configs.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z, ZodRawShape } from "zod";

type InferShape<Schema extends ZodRawShape> = z.output<z.ZodObject<Schema>>;

export interface InProcessToolDefinition<
  Schema extends ZodRawShape = ZodRawShape,
> {
  name: string;
  description: string;
  inputSchema: Schema;
  handler: (
    args: InferShape<Schema>,
    extra: unknown,
  ) => Promise<CallToolResult>;
}

/** Define one tool: name, description, zod shape, handler. Same signature as
 *  the Agent SDK's `tool()` so existing tool files only swap the import. */
export function tool<Schema extends ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (
    args: InferShape<Schema>,
    extra: unknown,
  ) => Promise<CallToolResult>,
): InProcessToolDefinition<Schema> {
  return { name, description, inputSchema, handler };
}

export interface InProcessMcpServer {
  /** Kept as "sdk" — run-rpc, the runners and the tests key off this tag. */
  type: "sdk";
  name: string;
  instance: McpServer;
}

/** Build an in-process MCP server from tool definitions. Same signature as
 *  the Agent SDK's `createSdkMcpServer()` so call sites only swap the import. */
export function createSdkMcpServer(options: {
  name: string;
  version?: string;
  tools?: Array<InProcessToolDefinition<any>>;
}): InProcessMcpServer {
  const instance = new McpServer(
    { name: options.name, version: options.version ?? "1.0.0" },
    { capabilities: { tools: options.tools ? {} : undefined } },
  );
  for (const t of options.tools ?? []) {
    instance.registerTool(
      t.name,
      { description: t.description, inputSchema: t.inputSchema },
      t.handler as any,
    );
  }
  return { type: "sdk", name: options.name, instance };
}
