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
 *    forwards tools/list + tools/call from each run host's relay
 *    (src/runner-host/run-rpc-relay.ts).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
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

/**
 * A JSON Schema validator that builds its Ajv instance on first use.
 *
 * The SDK's Server and Client each construct an Ajv instance up front, and
 * that was a third of building a session's in-process servers, which happens
 * on every tool call a run makes. A server only validates for elicitation and
 * a client only for tool output schemas after listing tools, so most
 * instances never need one.
 */
export function lazyJsonSchemaValidator(): jsonSchemaValidator {
  let inner: AjvJsonSchemaValidator | undefined;
  return {
    getValidator(schema) {
      inner ??= new AjvJsonSchemaValidator();
      return inner.getValidator(schema);
    },
  };
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
    {
      capabilities: { tools: options.tools ? {} : undefined },
      jsonSchemaValidator: lazyJsonSchemaValidator(),
    },
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

/**
 * A server set whose entries are built on first read.
 *
 * Every run tool call resolves a session's whole interactive server set to
 * pick one server out of it, and building all of them (each tool's zod
 * schemas, each McpServer) cost tens of milliseconds on the gateway thread.
 * A thunk entry becomes an enumerable getter that builds once and keeps the
 * result, so `servers[name]` and `Object.keys(servers)` build only what they
 * touch, while spreads and `Object.entries` still see every server. Entries
 * that are not functions are kept as they are. Writes and deletes behave like
 * ordinary properties.
 */
export function lazyServerRecord(
  entries: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(entries)) {
    if (typeof entry !== "function") {
      out[name] = entry;
      continue;
    }
    const settle = (value: unknown) => {
      Object.defineProperty(out, name, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      return value;
    };
    Object.defineProperty(out, name, {
      enumerable: true,
      configurable: true,
      get: () => settle((entry as () => unknown)()),
      set: settle,
    });
  }
  return out;
}
