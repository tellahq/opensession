import { afterAll, describe, expect, test } from "bun:test";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import the gateway only after isolating every path, including session fixtures.
const root = mkdtempSync(join(tmpdir(), "settings-rpc-test-"));
const previousEnv = { ...process.env };
process.env.OPENSESSION_STATE_DIR = root;
process.env.OPENSESSION_SESSIONS_DIR = join(root, "sessions");
process.env.OPENSESSION_CONFIG = join(root, "config.json");
mkdirSync(process.env.OPENSESSION_SESSIONS_DIR, { recursive: true });
writeFileSync(process.env.OPENSESSION_CONFIG, "{}");

const { SessionKernelStore, __setSessionKernelStoreForTest } =
  await import("./session-kernel");
const store = new SessionKernelStore(":memory:");
const previousStore = __setSessionKernelStoreForTest(store);
const { dispatchRunRpc, registerRunToken, unregisterRunToken } =
  await import("./run-rpc");
await import("./interactive-mcp");
const { getPersonalPrompt, setPersonalPrompt } =
  await import("./personal-prompts");
const { createWorkflowMcpHost } = await import("./workflow-mcp");
const { createSettingsMcpServer } = await import("./settings-mcp");
const { handlePrefsRoutes } = await import("./routes/prefs");
const { memoryNoteFor } = await import("./session-repos");

afterAll(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
  process.env = previousEnv;
  rmSync(root, { recursive: true, force: true });
});

function run(user?: string, automation?: string) {
  const sessionId = `os-${crypto.randomUUID()}`;
  writeFileSync(
    join(root, "sessions", `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      createdBy: "settings-rpc-owner",
      createdAt: "2026-08-01T00:00:00.000Z",
      lastActivity: "2026-08-01T00:00:00.000Z",
      automation,
    }),
  );
  const token = crypto.randomUUID();
  registerRunToken(token, { sessionId, user });
  return {
    token,
    [Symbol.dispose]() {
      unregisterRunToken(token);
    },
  };
}

const server = "opensession-settings";

describe("settings through the authenticated run-RPC boundary", () => {
  test("the token's prompting user wins over owner and claimed identities", async () => {
    const sender = "settings-rpc-sender";
    const owner = "settings-rpc-owner";
    await setPersonalPrompt(owner, "Owner's private instructions.");
    using context = run(sender);
    const listed = await dispatchRunRpc("/mcp/list", {
      token: context.token,
      server,
    });
    expect(listed.kind).toBe("immediate");
    if (listed.kind !== "immediate") throw new Error("Expected tools/list");
    expect(listed.body.tools).toHaveLength(3);
    const called = await dispatchRunRpc("/mcp/call", {
      token: context.token,
      server,
      user: owner,
      tool: "update_personal_prompt",
      args: {
        user: owner,
        change: { operation: "append", text: "Sender only." },
      },
    });
    if (called.kind !== "call") throw new Error("Expected tools/call");
    const result = CallToolResultSchema.parse((await called.done).result);
    expect(result.isError).toBeFalsy();
    expect(await getPersonalPrompt(sender)).toBe("Sender only.");
    expect(await getPersonalPrompt(owner)).toBe(
      "Owner's private instructions.",
    );
  });

  test("the existing client API and next prompt use the agent's saved settings", async () => {
    using context = run("Settingsreader");
    for (const [tool, args] of [
      [
        "update_personal_prompt",
        { change: { operation: "append", text: "Lead with the answer." } },
      ],
      ["set_output_style", { outputStyle: "concise" }],
    ] as const) {
      const called = await dispatchRunRpc("/mcp/call", {
        token: context.token,
        server,
        tool,
        args,
      });
      if (called.kind !== "call") throw new Error("Expected tools/call");
      expect(
        CallToolResultSchema.parse((await called.done).result).isError,
      ).toBeFalsy();
    }
    for (const [path, expected] of [
      ["/api/personal-prompt", { prompt: "Lead with the answer." }],
      ["/api/personal-output-style", { outputStyle: "concise" }],
    ] as const) {
      const url = new URL(`${path}?user=another-person`, "http://localhost");
      const response = await handlePrefsRoutes({
        req: new Request(url),
        url,
        path,
        publicPrefix: "",
        authUser: { login: "settingsreader", name: "Settingsreader Test" },
      });
      expect(await response?.json()).toEqual(expected);
    }
    const note = await memoryNoteFor("Settingsreader", []);
    expect(note).toContain("Lead with the answer.");
    expect(note).toContain("Personal output style: Concise");
  });

  test("unknown run tokens remain unauthorized", async () => {
    const denied = await dispatchRunRpc("/mcp/call", {
      token: "unregistered",
      server,
      tool: "get_settings",
      args: {},
    });
    expect(denied).toMatchObject({ kind: "immediate", status: 403 });
  });

  for (const scenario of [
    {
      name: "automation-owned human resume",
      user: "settings-rpc-sender",
      automation: "fixture-automation",
    },
    { name: "automation dispatch", automation: "fixture-automation" },
    { name: "missing sender" },
    { name: "machine sender", user: "auto-continue" },
  ]) {
    test(`${scenario.name} has no settings catalog or callable tools`, async () => {
      using context = run(
        scenario.user,
        "automation" in scenario ? scenario.automation : undefined,
      );
      expect(
        await dispatchRunRpc("/mcp/list", { token: context.token, server }),
      ).toEqual({
        kind: "immediate",
        status: 200,
        body: { tools: [] },
      });
      expect(
        await dispatchRunRpc("/mcp/call", {
          token: context.token,
          server,
          tool: "get_settings",
          args: {},
        }),
      ).toMatchObject({ kind: "immediate", status: 404 });
    });
  }

  test("workflow scripts cannot reach settings even when the parent carries them", async () => {
    const host = createWorkflowMcpHost({
      configuredForTest: {},
      inProcessMcp: () => ({
        [server]: createSettingsMcpServer("settings-rpc-sender"),
      }),
    });
    try {
      expect(host.servers()).not.toContain(server);
      await expect(
        host.call(server, "update_personal_prompt", {
          change: { operation: "append", text: "Not allowed." },
        }),
      ).rejects.toThrow("standing instructions");
    } finally {
      await host.close();
    }
  });
});
