import { expect, test } from "bun:test";
import {
  assertPersonalHostMcpNone,
  assertPersonalMcpNone,
  assertPersonalPiPath,
  createRunMcpRuntime,
} from "./personal-repo-runtime-mcp";
import { createPiMcpBridge } from "./pi-mcp-bridge";
import type { PersonalRepoBinding } from "./personal-repo-runtime";
import type { McpRuntime } from "./mcp-runtime";

const personalRepo = {} as PersonalRepoBinding;
const empty: McpRuntime = {
  hasCatalog: false,
  catalog: async () => [],
  callExact: async () => {
    throw new Error("unavailable");
  },
  close: async () => {},
};

test("private configured/shared MCP defaults are never discovered, connected or granted", async () => {
  let configuredReads = 0;
  const configuredShared = {
    billing: { command: "must-not-spawn", env: { TOKEN: "synthetic-shared" } },
  };
  const runtime = await createRunMcpRuntime(
    { personalRepo, mcpServers: [] },
    async () => {
      configuredReads += Object.keys(configuredShared).length;
      throw new Error("Shared MCP factory must not run");
    },
  );
  expect(configuredReads).toBe(0);
  expect(runtime.hasCatalog).toBe(false);
  expect(await runtime.catalog({ hydrate: true })).toEqual([]);
  const bridge = await createPiMcpBridge(runtime);
  expect(bridge.tools).toEqual([]);
  expect(bridge.discoveryTools).toEqual([]);
  await expect(
    runtime.callExact("billing_charge", {}, { toolCallId: "fixture" }),
  ).rejects.toThrow("unavailable");
  await runtime.close();
});

test("private scope/config/proxy defaults and actual caller overrides fail closed", async () => {
  for (const mcpServers of [undefined, "all", ["shared"], {}, null]) {
    expect(() => assertPersonalMcpNone({ personalRepo, mcpServers })).toThrow(
      "empty MCP",
    );
  }
  for (const inProcessMcp of [
    { billing: { type: "sdk", instance: {} } },
    { proxy: { command: "fixture" } },
    null,
    [],
  ]) {
    await expect(
      createRunMcpRuntime(
        { personalRepo, mcpServers: [], inProcessMcp },
        async () => empty,
      ),
    ).rejects.toThrow("MCP configs");
  }
  for (const proxyMcpServers of [undefined, ["opensession-admin"], "all"]) {
    expect(() =>
      assertPersonalHostMcpNone({
        personalRepo,
        mcpServers: [],
        proxyMcpServers,
      }),
    ).toThrow("proxy grants");
  }
  expect(() =>
    assertPersonalHostMcpNone({
      personalRepo,
      mcpServers: [],
      proxyMcpServers: [],
      rpcToken: "synthetic-grant",
    }),
  ).toThrow("proxy grants");
  expect(() =>
    assertPersonalHostMcpNone({
      personalRepo,
      mcpServers: [],
      proxyMcpServers: [],
    }),
  ).not.toThrow();
});

test("shared runs retain existing MCP factory/default behavior", async () => {
  let calls = 0;
  const result = await createRunMcpRuntime(
    { mcpServers: "all", inProcessMcp: { shared: {} } },
    async () => {
      calls++;
      return empty;
    },
  );
  expect(result).toBe(empty);
  expect(calls).toBe(1);
});

test("private unsupported/delegating model paths deny rather than escaping empty MCP boundary", () => {
  for (const resolved of [null, { dial: {} }, { orchestrator: {} }])
    expect(() => assertPersonalPiPath(personalRepo, resolved)).toThrow(
      "non-delegating Pi",
    );
  expect(() => assertPersonalPiPath(personalRepo, {})).not.toThrow();
  expect(() => assertPersonalPiPath(undefined, { dial: {} })).not.toThrow();
});

test("trusted hosted and model-fallback entrypoints reject private shared-MCP overrides before effects", async () => {
  const { runAgentHosted } = await import("./host-client");
  const { runAgent } = await import("./agent-runner");
  const opts = {
    personalRepo,
    osSessionId: "synthetic-no-reservation",
    cwd: "/synthetic",
    prompt: "fixture",
    mcpServers: "all" as const,
    proxyMcpServers: [],
  };
  await expect(runAgentHosted(opts).next()).rejects.toThrow("empty MCP");
  await expect(runAgent(opts).next()).rejects.toThrow("empty MCP");
});
