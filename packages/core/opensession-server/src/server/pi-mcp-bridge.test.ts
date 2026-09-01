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
});
