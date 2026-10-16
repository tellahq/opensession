import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, tool } from "../server/inprocess-mcp";
import {
  createMcpRuntime,
  splitMcpMigrationBoundary,
  type McpRuntime,
} from "../server/mcp-runtime";
import {
  dispatchRunRpc,
  registerInteractiveMcpBuilder,
  registerRunToken,
  unregisterRunToken,
} from "../server/run-rpc";
import {
  createRunRpcRelay,
  relayMcpMounts,
  type RunRpcRelay,
} from "./run-rpc-relay";

let dir: string;
let token: string;
let runtime: McpRuntime | undefined;
let relay: RunRpcRelay | undefined;
let servers: Array<{ stop(force?: boolean): unknown }> = [];

const echoServer = (name: string, tools: string[]) =>
  createSdkMcpServer({
    name,
    tools: tools.map((t) =>
      tool(t, `${t} on ${name}`, {}, async () => ({
        content: [{ type: "text", text: `${name}:${t}` }],
      })),
    ),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "run-rpc-relay-"));
  token = crypto.randomUUID();
  registerRunToken(token, { sessionId: "relay-run" });
  registerInteractiveMcpBuilder(() => ({
    "opensession-sessions": echoServer("opensession-sessions", [
      "spawn_task",
      "task_status",
    ]),
    "opensession-assets": echoServer("opensession-assets", ["write_asset"]),
  }));
});

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  relay?.close();
  relay = undefined;
  for (const s of servers) s.stop(true);
  servers = [];
  unregisterRunToken(token);
  registerInteractiveMcpBuilder(() => ({}));
  rmSync(dir, { recursive: true, force: true });
});

/** run-rpc over a unix socket, counting requests per server. */
function serveSocket() {
  const requests: string[] = [];
  const socket = join(dir, "rpc.sock");
  servers.push(
    Bun.serve({
      unix: socket,
      async fetch(req) {
        const body = await req.json();
        requests.push(`${body.server}${new URL(req.url).pathname}`);
        const dispatched = await dispatchRunRpc(
          new URL(req.url).pathname,
          body,
        );
        return dispatched.kind === "immediate"
          ? Response.json(dispatched.body, { status: dispatched.status })
          : Response.json(await dispatched.done);
      },
    }),
  );
  return { socket, requests };
}

async function runtimeFor(names: string[], r: RunRpcRelay) {
  const mounts = splitMcpMigrationBoundary(relayMcpMounts(r, names));
  runtime = await createMcpRuntime({
    mcpServers: [],
    deniedToolIds: new Set(),
    inProcessMcp: mounts.sdk,
    legacyProxyMcp: mounts.legacyProxy,
  });
  return runtime;
}

test("every server shares one relay and keeps its agent-visible tool ids", async () => {
  const { socket, requests } = serveSocket();
  relay = createRunRpcRelay({ socket, token });
  const rt = await runtimeFor(
    ["opensession-sessions", "opensession-assets"],
    relay,
  );

  // Deferred like the stdio proxies were: nothing is listed until needed.
  expect(requests).toEqual([]);
  expect(rt.hasCatalog).toBe(true);

  const ids = (await rt.catalog()).map((t) => t.id).sort();
  expect(ids).toEqual([
    "opensession-assets_write_asset",
    "opensession-sessions_spawn_task",
    "opensession-sessions_task_status",
  ]);
  expect(
    await rt.callExact(
      "opensession-sessions_spawn_task",
      {},
      { toolCallId: "1" },
    ),
  ).toEqual({
    content: [{ type: "text", text: "opensession-sessions:spawn_task" }],
  });
  expect(
    await rt.callExact(
      "opensession-assets_write_asset",
      {},
      { toolCallId: "2" },
    ),
  ).toEqual({
    content: [{ type: "text", text: "opensession-assets:write_asset" }],
  });
  expect(requests.sort()).toEqual([
    "opensession-assets/mcp/call",
    "opensession-assets/mcp/list",
    "opensession-sessions/mcp/call",
    "opensession-sessions/mcp/list",
  ]);
});

test("a server outside the run's binding stays unavailable through the relay", async () => {
  registerInteractiveMcpBuilder(() => ({
    "opensession-sessions": echoServer("opensession-sessions", ["task_status"]),
  }));
  const { socket } = serveSocket();
  relay = createRunRpcRelay({ socket, token });
  const rt = await runtimeFor(
    ["opensession-sessions", "opensession-admin"],
    relay,
  );

  expect((await rt.catalog()).map((t) => t.id)).toEqual([
    "opensession-sessions_task_status",
  ]);
  await expect(
    rt.callExact("opensession-admin_list_automations", {}, { toolCallId: "1" }),
  ).rejects.toThrow(/"opensession-admin" is not available.*MCP policy/);
});

test("a token the server never issued is refused for every server", async () => {
  const { socket } = serveSocket();
  relay = createRunRpcRelay({ socket, token: "not-a-run-token-" + token });
  await expect(
    relay.rpc("opensession-sessions", "/mcp/list", {}, 200),
  ).rejects.toThrow(/unauthorized|unreachable/);
});

test("over /rpc-ws one connection carries every server's requests", async () => {
  let upgrades = 0;
  const frames: string[] = [];
  const ws = Bun.serve({
    port: 0,
    fetch(req, srv) {
      expect(new URL(req.url).searchParams.get("host")).toBe("host-1");
      expect(req.headers.get("authorization")).toBe("Bearer ws-secret");
      upgrades++;
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      async message(sock, raw) {
        const msg = JSON.parse(String(raw));
        if (msg.t === "ping") return;
        frames.push(`${msg.server}${msg.path}`);
        const { id, path, ...body } = msg;
        const dispatched = await dispatchRunRpc(path, body);
        sock.send(
          JSON.stringify(
            dispatched.kind === "immediate"
              ? { id, status: dispatched.status, body: dispatched.body }
              : { id, status: 200, body: await dispatched.done },
          ),
        );
      },
    },
  });
  servers.push(ws);
  relay = createRunRpcRelay({
    wsUrl: `ws://127.0.0.1:${ws.port}/rpc-ws`,
    wsHost: "host-1",
    wsAuth: "ws-secret",
    token,
  });
  const rt = await runtimeFor(
    ["opensession-sessions", "opensession-assets"],
    relay,
  );
  expect((await rt.catalog()).length).toBe(3);
  await rt.callExact("opensession-assets_write_asset", {}, { toolCallId: "1" });
  expect(upgrades).toBe(1);
  expect(frames.sort()).toEqual([
    "opensession-assets/mcp/call",
    "opensession-assets/mcp/list",
    "opensession-sessions/mcp/list",
  ]);
});

test("a relay without a reachable transport or token is rejected up front", () => {
  expect(() => createRunRpcRelay({ token: "t" })).toThrow(/required/);
  expect(() => createRunRpcRelay({ socket: "/x.sock", token: "" })).toThrow(
    /required/,
  );
  expect(() =>
    createRunRpcRelay({ wsUrl: "ws://example.test/rpc-ws", token: "t" }),
  ).toThrow(/required/);
});
