/** Thin Pi adapter over the engine-neutral, turn-scoped MCP runtime. */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpRuntime, McpRuntimeTool } from "./mcp-runtime";

export interface PiMcpBridge {
  /** Mutable post-policy view retained for diagnostics and existing callers. */
  tools: ToolDefinition<any, any, any>[];
  /** Exactly mcp_search and mcp_call when the runtime has any catalog source. */
  discoveryTools: ToolDefinition<any, any, any>[];
}

type BoundTool = McpRuntimeTool & { runtime: McpRuntime };

function definitionOf(tool: BoundTool): ToolDefinition<any, any, any> {
  return {
    name: tool.id,
    label: tool.label,
    description: tool.description,
    parameters: tool.inputSchema as any,
    // Runtime tools are never exposed directly to Pi. Keeping execute here
    // preserves the diagnostic `tools` contract and exact call semantics.
    execute: (toolCallId, params, signal) =>
      tool.runtime
        .callExact(tool.id, (params ?? {}) as Record<string, unknown>, {
          toolCallId,
          signal,
        })
        .then(({ content }) => ({ content, details: undefined })),
  };
}

export async function createPiMcpBridge(
  runtime: McpRuntime,
): Promise<PiMcpBridge> {
  const tools: ToolDefinition<any, any, any>[] = [];
  const byName = new Map<string, ToolDefinition<any, any, any>>();
  const seen = new Set<string>();
  const syncCatalog = async (hydrate: boolean) => {
    for (const tool of await runtime.catalog({ hydrate })) {
      if (seen.has(tool.id)) continue;
      seen.add(tool.id);
      const definition = definitionOf({ ...tool, runtime } as BoundTool);
      tools.push(definition);
      byName.set(definition.name, definition);
    }
  };
  await syncCatalog(false);

  const describedWeight = (length: number) =>
    Math.min(1, 400 / Math.max(length, 400));
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
        limit: {
          type: "number",
          description: "Maximum matches to return, 1 to 12 (default 6)",
        },
      },
      required: ["query"],
    } as any,
    async execute(_toolCallId, params) {
      const query = String((params as { query?: unknown })?.query ?? "")
        .trim()
        .toLowerCase();
      if (!query) throw new Error("mcp_search requires a query");
      await syncCatalog(true);
      const requested = Number((params as { limit?: unknown })?.limit);
      const limit = Number.isFinite(requested)
        ? Math.max(1, Math.min(12, Math.floor(requested)))
        : 6;
      const terms = query.split(/\s+/).filter(Boolean);
      const compact = query.replace(/[\s_-]+/g, "");
      const matches = tools
        .map((definition) => ({
          definition,
          name: definition.name.toLowerCase(),
          label: (definition.label || "").toLowerCase(),
          description: (definition.description || "").toLowerCase(),
        }))
        .map((entry) => {
          const weight = describedWeight(entry.description.length);
          let score = 0;
          for (const term of terms) {
            if (entry.name.includes(term)) score += 10;
            else if (entry.label.includes(term)) score += 5;
            else if (entry.description.includes(term)) score += 3 * weight;
          }
          if (compact && entry.name.replace(/[_-]/g, "").includes(compact))
            score += 15;
          return { entry, score };
        })
        .filter(({ score }) => score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            a.entry.description.length - b.entry.description.length ||
            a.entry.name.localeCompare(b.entry.name),
        )
        .slice(0, limit);
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
        name: {
          type: "string",
          description: "Exact tool name returned by mcp_search",
        },
        arguments: { type: "object", description: "Arguments for that tool" },
      },
      required: ["name", "arguments"],
    } as any,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const name = String((params as { name?: unknown })?.name ?? "");
      const definition = byName.get(name);
      if (!definition)
        throw new Error(
          `MCP tool "${name}" is unavailable. Search the catalog first.`,
        );
      const args = (params as { arguments?: unknown })?.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("mcp_call arguments must be an object");
      }
      return definition.execute(toolCallId, args as any, signal, onUpdate, ctx);
    },
  };

  return {
    tools,
    discoveryTools: runtime.hasCatalog ? [searchCatalog, callCatalog] : [],
  };
}
