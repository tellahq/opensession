import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const clients: Client[] = [];
const transports: StdioClientTransport[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
});

async function tools(mode: "build" | "release") {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      new URL("../../../../scripts/cli.ts", import.meta.url).pathname,
      "apple-mobile-mcp",
      "--mode",
      mode,
    ],
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  transports.push(transport);
  clients.push(client);
  await client.connect(transport);
  return client.listTools();
}

describe("MCP surfaces", () => {
  test("build mode exposes no release mutators", async () => {
    const result = await tools("build");
    const names = result.tools.map((tool) => tool.name);
    expect(names).toContain("apple_mobile_build_unsigned");
    expect(names.some((name) => name.startsWith("apple_release"))).toBe(false);
  });

  test("release mode exposes planning and execution separately", async () => {
    const result = await tools("release");
    const names = result.tools.map((tool) => tool.name);
    expect(names).toContain("apple_release_plan_testflight");
    expect(names).toContain("apple_release_execute");
    expect(names.some((name) => name.startsWith("apple_mobile_build"))).toBe(
      false,
    );
  });
});
