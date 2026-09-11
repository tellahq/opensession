import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("relay forwards authenticated requests and rejects other servers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-relay-"));
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      expect(req.headers.get("authorization")).toBe("Bearer fixture-secret");
      expect(req.method).toBe("POST");
      expect(await req.json()).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      return Response.json(
        { tools: [] },
        { headers: { "mcp-session-id": "fixture-session" } },
      );
    },
  });
  try {
    const configPath = join(directory, "mcp-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          observability: {
            type: "http",
            url: upstream.url.href,
            headers: { Authorization: "Bearer fixture-secret" },
          },
        },
      }),
    );
    // All state/config isolation is installed before the child's first import.
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { mintMcpRelayToken, handleMcpRelay } from ${JSON.stringify(join(import.meta.dir, "mcp-relay.ts"))};
       const token = mintMcpRelayToken("observability", ["Example"]);
       const req = new Request("http://127.0.0.1/relay/observability", {
         method: "POST", headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
         body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
       });
       const denied = await handleMcpRelay(req.clone(), "other-server", token);
       const unknown = await handleMcpRelay(req.clone(), "observability", "invalid");
       const response = await handleMcpRelay(req, "observability", token);
       console.log(JSON.stringify({ denied: denied.status, unknown: unknown.status, status: response.status,
         session: response.headers.get("mcp-session-id"), body: await response.json() }));
       process.exit(0);`,
      ],
      {
        env: {
          HOME: directory,
          OPENSESSION_STATE_DIR: directory,
          OPENSESSION_DEV: "1",
          OPENSESSION_MCP_CONFIG: configPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({
      denied: 401,
      unknown: 401,
      status: 200,
      session: "fixture-session",
      body: { tools: [] },
    });
  } finally {
    upstream.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
