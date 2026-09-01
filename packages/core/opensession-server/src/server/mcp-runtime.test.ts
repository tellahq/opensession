import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import {
  boundedSafeJson,
  createMcpRuntime,
  legacyProxyToolsCacheKey,
  MAX_MCP_SAFE_JSON_BYTES,
  splitMcpMigrationBoundary,
  type McpRuntime,
} from "./mcp-runtime";

let lastMeta: unknown;
let lastSignalAborted = false;
function server() {
  return createSdkMcpServer({
    name: "alpha",
    tools: [
      tool(
        "echo",
        "Echo text",
        { text: z.string() },
        async (args, extra: any) => {
          lastMeta = extra?._meta;
          return { content: [{ type: "text", text: `echo:${args.text}` }] };
        },
      ),
      tool("picture", "Picture", {}, async () => ({
        content: [
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ] as CallToolResult["content"],
      })),
      tool("boom", "Fails", {}, async () => ({
        isError: true,
        content: [{ type: "text", text: "bad input" }],
      })),
      tool("hang", "Hangs", {}, async (_args, extra: any) => {
        extra?.signal?.addEventListener?.("abort", () => {
          lastSignalAborted = true;
        });
        return new Promise<CallToolResult>(() => {});
      }),
    ],
  });
}
const open: McpRuntime[] = [];
afterEach(async () => {
  for (const runtime of open.splice(0)) await runtime.close();
});
async function make(
  overrides: Partial<Parameters<typeof createMcpRuntime>[0]> = {},
) {
  const instance = server();
  const runtime = await createMcpRuntime({
    mcpServers: [],
    deniedToolIds: new Set(),
    inProcessMcp: { alpha: instance },
    ...overrides,
  });
  open.push(runtime);
  return { runtime, instance };
}

describe("MCP runtime catalog and exact calls", () => {
  test("catalog uses exact identities, schema passthrough and deny policy", async () => {
    const { runtime } = await make({
      deniedToolIds: new Set(["alpha_boom", "*_picture"]),
    });
    const catalog = await runtime.catalog();
    expect(catalog.map((item) => item.id).sort()).toEqual([
      "alpha_echo",
      "alpha_hang",
    ]);
    expect(
      (catalog.find((item) => item.id === "alpha_echo")!.inputSchema as any)
        .properties.text.type,
    ).toBe("string");
  });

  test("callExact preserves toolCallId and maps content", async () => {
    const { runtime } = await make();
    const result = await runtime.callExact(
      "alpha_echo",
      { text: "hi" },
      { toolCallId: "call-7" },
    );
    expect(result.content).toEqual([{ type: "text", text: "echo:hi" }]);
    expect(lastMeta).toMatchObject({ opensessionToolCallId: "call-7" });
    const picture = await runtime.callExact(
      "alpha_picture",
      {},
      { toolCallId: "call-8" },
    );
    expect(picture.content[0]).toEqual({
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/png",
    });
  });

  test("errors, timeout, cancellation and audit stay call-scoped", async () => {
    const audits: Array<{ tool: string; ok: boolean }> = [];
    const { runtime } = await make({
      callTimeoutMs: 50,
      onAudit: (event) => audits.push({ tool: event.tool, ok: event.ok }),
    });
    await expect(
      runtime.callExact("alpha_boom", {}, { toolCallId: "x" }),
    ).rejects.toThrow("bad input");
    const abort = new AbortController();
    const hanging = runtime.callExact(
      "alpha_hang",
      {},
      { toolCallId: "y", signal: abort.signal },
    );
    abort.abort();
    await expect(hanging).rejects.toThrow(/abort/i);
    await expect(
      runtime.callExact("alpha_hang", {}, { toolCallId: "timeout" }),
    ).rejects.toThrow(/timed out|timeout/i);
    expect(audits).toEqual([
      { tool: "boom", ok: false },
      { tool: "hang", ok: false },
      { tool: "hang", ok: false },
    ]);
    expect(lastSignalAborted || abort.signal.aborted).toBe(true);
    expect(
      (
        await runtime.callExact(
          "alpha_echo",
          { text: "alive" },
          { toolCallId: "z" },
        )
      ).content[0],
    ).toEqual({ type: "text", text: "echo:alive" });
  });

  test("close owns connections and is idempotent", async () => {
    const { runtime, instance } = await make();
    expect(instance.instance.isConnected()).toBe(true);
    await runtime.close();
    expect(instance.instance.isConnected()).toBe(false);
    await expect(
      runtime.callExact("alpha_echo", {}, { toolCallId: "x" }),
    ).rejects.toThrow(/closed/i);
    await runtime.close();
  });
});

describe("bounded safe JSON", () => {
  test("handles cycles, bigint, depth and byte limits without throwing", () => {
    const cyclic: any = { bigint: 4n };
    cyclic.self = cyclic;
    expect(boundedSafeJson(cyclic)).toContain("[circular]");
    const text = boundedSafeJson({
      huge: "x".repeat(MAX_MCP_SAFE_JSON_BYTES * 2),
    });
    expect(text).toContain("[truncated]");
    expect(() => JSON.parse(text)).not.toThrow();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
      MAX_MCP_SAFE_JSON_BYTES,
    );
  });
});

describe("legacy migration boundary", () => {
  test("separates SDK mounts from runner-host proxy configs and ignores token in cache indirectly", () => {
    const sdk = server();
    const split = splitMcpMigrationBoundary({
      alpha: sdk,
      proxy: { command: "/bun", env: { OPENSESSION_RPC_TOKEN: "secret" } },
      unknown: { type: "other" },
    });
    expect(Object.keys(split.sdk)).toEqual(["alpha"]);
    expect(Object.keys(split.legacyProxy!.configs)).toEqual(["proxy"]);
    const proxy = (token: string) => ({
      command: "/bun",
      env: { OPENSESSION_RPC_TOKEN: token, OPENSESSION_MCP_SERVER: "sessions" },
    });
    expect(legacyProxyToolsCacheKey(proxy("one"))).toBe(
      legacyProxyToolsCacheKey(proxy("two")),
    );
    expect(legacyProxyToolsCacheKey(proxy("one"))).not.toBe(
      legacyProxyToolsCacheKey({ ...proxy("one"), command: "/other" }),
    );
  });
});
