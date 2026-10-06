import { describe, expect, test } from "bun:test";
import { createPiMcpBridge } from "./pi-mcp-bridge";
import type { McpRuntime, McpRuntimeTool } from "./mcp-runtime";

function fakeRuntime(catalog: McpRuntimeTool[]): McpRuntime & {
  calls: Array<{
    id: string;
    args: Record<string, unknown>;
    toolCallId: string;
    signal?: AbortSignal;
  }>;
} {
  const calls: Array<{
    id: string;
    args: Record<string, unknown>;
    toolCallId: string;
    signal?: AbortSignal;
  }> = [];
  return {
    calls,
    hasCatalog: catalog.length > 0,
    async catalog() {
      return catalog;
    },
    async callExact(id, args, options) {
      if (!catalog.some((tool) => tool.id === id))
        throw new Error(`MCP tool "${id}" is unavailable`);
      calls.push({
        id,
        args,
        toolCallId: options.toolCallId,
        signal: options.signal,
      });
      return { content: [{ type: "text", text: `called:${id}` }] };
    },
    async close() {},
  };
}
const tool = (id: string, description: string, label = id): McpRuntimeTool => {
  const split = id.indexOf("_");
  return {
    id,
    server: id.slice(0, split),
    name: id.slice(split + 1),
    label,
    description,
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
  };
};
const exec = (
  definition: { execute: Function },
  params: unknown,
  signal?: AbortSignal,
) => definition.execute("call-42", params, signal, undefined, {} as any);

describe("Pi MCP adapter", () => {
  test("exposes exactly the compact dispatcher names", async () => {
    const bridge = await createPiMcpBridge(
      fakeRuntime([tool("alpha_echo", "Echo text")]),
    );
    expect(bridge.discoveryTools.map((item) => item.name)).toEqual([
      "mcp_search",
      "mcp_call",
    ]);
    expect(bridge.tools.map((item) => item.name)).toEqual(["alpha_echo"]);
    expect(bridge.tools[0]!.parameters).toEqual({
      type: "object",
      properties: { value: { type: "string" } },
    });
  });

  test("preserves ranking, argument schema and 700-character display truncation", async () => {
    const runtime = fakeRuntime([
      tool("zeta_run_workflow", "Run one workflow"),
      tool("alpha_unrelated", `run ${"verbose ".repeat(200)}`),
    ]);
    const bridge = await createPiMcpBridge(runtime);
    const search = bridge.discoveryTools.find(
      (item) => item.name === "mcp_search",
    )!;
    const result = await exec(search, { query: "run workflow", limit: 1 });
    expect(result.content[0].text).toContain("zeta_run_workflow");
    expect(result.content[0].text).toContain('arguments: {"type":"object"');

    const verbose = await exec(search, { query: "verbose" });
    expect(verbose.content[0].text).toContain("… [truncated]");
  });

  test("required server terms exclude unrelated session tools", async () => {
    const bridge = await createPiMcpBridge(
      fakeRuntime([
        tool("opensession-sessions_list_sessions", "List sessions"),
        tool("opensession-sessions_get_session", "Get session detail"),
        tool("workos_list_sessions", "List sessions for a user"),
        tool("vercel_get_session", "Get session detail"),
      ]),
    );
    const search = bridge.discoveryTools[0]!;
    for (const query of [
      "+opensession-sessions list_sessions get_session",
      "+opensession-sessions_",
      "+opensession-sessions",
    ]) {
      const result = await exec(search, { query, limit: 12 });
      expect(result.content[0].text).toContain(
        "opensession-sessions_list_sessions",
      );
      expect(result.content[0].text).toContain(
        "opensession-sessions_get_session",
      );
      expect(result.content[0].text).not.toContain("workos_list_sessions");
      expect(result.content[0].text).not.toContain("vercel_get_session");
    }
    const ranked = await exec(search, {
      query: "+opensession-sessions get_session",
      limit: 1,
    });
    expect(ranked.content[0].text).toContain(
      "opensession-sessions_get_session",
    );
    expect(ranked.content[0].text).not.toContain("list_sessions");
  });

  test("every required term must match the permitted catalog", async () => {
    const bridge = await createPiMcpBridge(
      fakeRuntime([
        tool("alpha_echo", "Echo text"),
        tool("alpha_list", "List items"),
        tool("beta_echo", "Echo text"),
      ]),
    );
    const search = bridge.discoveryTools[0]!;
    const result = await exec(search, { query: "+alpha +echo" });
    expect(result.content[0].text).toContain("alpha_echo");
    expect(result.content[0].text).not.toContain("alpha_list");
    expect(result.content[0].text).not.toContain("beta_echo");
    const missing = await exec(search, { query: "+unavailable echo" });
    expect(missing.content[0].text).toContain("No permitted MCP tools matched");
    await expect(exec(search, { query: "+" })).rejects.toThrow(
      "requires a term after +",
    );
  });

  test("mcp_call preserves exact identity, toolCallId, signal and Pi result shape", async () => {
    const runtime = fakeRuntime([tool("alpha_echo", "Echo")]);
    const bridge = await createPiMcpBridge(runtime);
    const call = bridge.discoveryTools.find(
      (item) => item.name === "mcp_call",
    )!;
    const abort = new AbortController();
    const result = await exec(
      call,
      { name: "alpha_echo", arguments: { value: "hi" } },
      abort.signal,
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "called:alpha_echo" }],
      details: undefined,
    });
    expect(runtime.calls).toEqual([
      {
        id: "alpha_echo",
        args: { value: "hi" },
        toolCallId: "call-42",
        signal: abort.signal,
      },
    ]);
  });

  test("rejects unavailable identities and non-object arguments", async () => {
    const bridge = await createPiMcpBridge(
      fakeRuntime([tool("alpha_echo", "Echo")]),
    );
    const call = bridge.discoveryTools.find(
      (item) => item.name === "mcp_call",
    )!;
    await expect(
      exec(call, { name: "alpha_other", arguments: {} }),
    ).rejects.toThrow(/unavailable/);
    await expect(
      exec(call, { name: "alpha_echo", arguments: [] }),
    ).rejects.toThrow(/must be an object/);
  });

  test("empty runtime exposes no MCP tools", async () => {
    const bridge = await createPiMcpBridge(fakeRuntime([]));
    expect(bridge.discoveryTools).toEqual([]);
    expect(bridge.tools).toEqual([]);
  });

  test("offers schedule_prompt by name only when the catalog carries it", async () => {
    const runtime = fakeRuntime([
      tool("opensession-schedule_schedule_prompt", "Schedule a check-back"),
      tool("opensession-schedule_list_scheduled_prompts", "List them"),
      tool("alpha_echo", "Echo text"),
    ]);
    const bridge = await createPiMcpBridge(runtime);
    expect(bridge.directTools.map((item) => item.name)).toEqual([
      "schedule_prompt",
    ]);
    // Still searchable, and the direct name dispatches to the same runtime id.
    expect(bridge.tools.map((item) => item.name)).toContain(
      "opensession-schedule_schedule_prompt",
    );
    await exec(bridge.directTools[0]!, { value: "x" });
    expect(runtime.calls[0]).toMatchObject({
      id: "opensession-schedule_schedule_prompt",
      args: { value: "x" },
      toolCallId: "call-42",
    });

    const without = await createPiMcpBridge(
      fakeRuntime([tool("alpha_echo", "Echo text")]),
    );
    expect(without.directTools).toEqual([]);
  });

  test("offers wait_for by name only when the catalog carries it", async () => {
    const runtime = fakeRuntime([
      tool("opensession-sessions_wait_for", "Wait for PR checks"),
      tool("opensession-sessions_send_to_session", "Send"),
    ]);
    const bridge = await createPiMcpBridge(runtime);
    expect(bridge.directTools.map((item) => item.name)).toEqual(["wait_for"]);
    await exec(bridge.directTools[0]!, { kind: "pr_checks" });
    expect(runtime.calls[0]).toMatchObject({
      id: "opensession-sessions_wait_for",
      args: { kind: "pr_checks" },
    });

    // Non-admin runs mount opensession-sessions without wait_for.
    const without = await createPiMcpBridge(
      fakeRuntime([tool("opensession-sessions_send_to_session", "Send")]),
    );
    expect(without.directTools).toEqual([]);
  });

  test("hydrates only the direct tools' servers before picking them", async () => {
    const runtime = fakeRuntime([
      tool("opensession-sessions_wait_for", "Wait for PR checks"),
    ]);
    const scopes: unknown[] = [];
    const catalog = runtime.catalog.bind(runtime);
    runtime.catalog = async (options) => {
      scopes.push(options?.hydrate);
      return catalog(options);
    };
    await createPiMcpBridge(runtime);
    expect(scopes).toEqual([["opensession-schedule", "opensession-sessions"]]);
  });
});
