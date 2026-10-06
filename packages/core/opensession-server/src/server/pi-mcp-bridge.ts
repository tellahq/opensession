/** Thin Pi adapter over the engine-neutral, turn-scoped MCP runtime. */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpRuntime, McpRuntimeTool } from "./mcp-runtime";

export interface PiMcpBridge {
  /** Mutable post-policy view retained for diagnostics and existing callers. */
  tools: ToolDefinition<any, any, any>[];
  /** Exactly mcp_search and mcp_call when the runtime has any catalog source. */
  discoveryTools: ToolDefinition<any, any, any>[];
  /** The few catalog tools also offered by name (DIRECT_MCP_TOOLS), only
   *  when this run's post-policy catalog carries them. */
  directTools: ToolDefinition<any, any, any>[];
}

/**
 * Catalog tools the model is handed directly, keyed by runtime id, valued by
 * the name it sees. Everything else stays behind mcp_search. A tool earns a
 * place here only when the two-step search is itself what stops the model
 * from using it: `schedule_prompt` competes with a one-line `sleep`, and
 * searching for it first made the wrong choice the easy one. `wait_for`
 * (pr_checks) loses to an inline `until gh pr checks` loop the same way.
 * It is registered only for admin runs, so runs without it get no direct
 * `wait_for` either.
 */
export const DIRECT_MCP_TOOLS: Readonly<Record<string, string>> = {
  "opensession-schedule_schedule_prompt": "schedule_prompt",
  "opensession-sessions_wait_for": "wait_for",
};

/** Servers behind DIRECT_MCP_TOOLS. A detached run reaches them through
 *  deferred run-scoped proxies, so the bridge lists these before picking
 *  direct tools. Server names never contain `_`; tool names may. */
const DIRECT_MCP_SERVERS = [
  ...new Set(Object.keys(DIRECT_MCP_TOOLS).map((id) => id.split("_")[0]!)),
];

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
  const seen = new Set<string>();
  const syncCatalog = async (hydrate: boolean | readonly string[]) => {
    for (const tool of await runtime.catalog({ hydrate })) {
      if (seen.has(tool.id)) continue;
      seen.add(tool.id);
      const definition = definitionOf({ ...tool, runtime } as BoundTool);
      tools.push(definition);
    }
  };
  // Read before listing the direct servers: one that turns out unbound must
  // not take discovery away with it, exactly as when listing was lazy.
  const hasCatalog = runtime.hasCatalog;
  await syncCatalog(DIRECT_MCP_SERVERS);

  const describedWeight = (length: number) =>
    Math.min(1, 400 / Math.max(length, 400));
  const searchCatalog: ToolDefinition<any, any, any> = {
    name: "mcp_search",
    label: "Search MCP tools",
    description:
      "Search the available MCP tool catalog before calling mcp_call. " +
      "Prefix a required term with + to narrow results (e.g. +opensession-sessions list_sessions). " +
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
      const terms = query.split(/\s+/).map((term) => ({
        text: term.startsWith("+") ? term.slice(1) : term,
        required: term.startsWith("+"),
      }));
      if (terms.some((term) => !term.text))
        throw new Error("mcp_search requires a term after +");
      const compact = terms
        .map((term) => term.text)
        .join("")
        .replace(/[_-]/g, "");
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
            if (entry.name.includes(term.text)) score += 10;
            else if (entry.label.includes(term.text)) score += 5;
            else if (entry.description.includes(term.text)) score += 3 * weight;
            else if (term.required) return { entry, score: 0 };
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
    async execute(toolCallId, params, signal) {
      const name = String((params as { name?: unknown })?.name ?? "");
      const args = (params as { arguments?: unknown })?.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("mcp_call arguments must be an object");
      }
      const { content } = await runtime.callExact(
        name,
        args as Record<string, unknown>,
        { toolCallId, signal },
      );
      return { content, details: undefined };
    },
  };

  const directTools = tools.flatMap((definition) => {
    const name = DIRECT_MCP_TOOLS[definition.name];
    return name ? [{ ...definition, name }] : [];
  });

  return {
    tools,
    discoveryTools: hasCatalog ? [searchCatalog, callCatalog] : [],
    directTools,
  };
}
