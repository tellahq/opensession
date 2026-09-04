import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SessionSummary } from "../../server/session-control";
import { createAssetsMcpServer } from "./assets-tools";

function session(): SessionSummary {
  return {
    id: "os-assets-source",
    title: "Asset source",
    source: "opensession",
    lastActivity: new Date().toISOString(),
    state: "idle",
    queuedCount: 0,
    controllable: true,
    worktreeDir: "/workspace",
  } as SessionSummary;
}

function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text || "";
}

async function withClient(
  server: ReturnType<typeof createAssetsMcpServer>,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({
    name: "assets-tools-test",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.instance.close();
  }
}

describe("assets MCP tools", () => {
  test("write_asset publishes an existing workspace file without base64", async () => {
    let published:
      | {
          sourcePath: string;
          destination: string;
          description?: string;
        }
      | undefined;
    const server = createAssetsMcpServer(
      { sessionId: "os-assets-source" },
      {
        findSession: () => session(),
        publishSessionFile: async (input) => {
          published = {
            sourcePath: input.sourcePath,
            destination: input.destination,
            description: input.description,
          };
          return {
            path: input.destination,
            size: 57_496,
            source: "workspace",
          };
        },
      },
    );
    await withClient(server, async (client) => {
      const listed = await client.listTools();
      const write = listed.tools.find((tool) => tool.name === "write_asset");
      expect(write?.inputSchema.properties).toHaveProperty("sourcePath");
      expect(write?.inputSchema.required).not.toContain("content");

      const result = await client.callTool({
        name: "write_asset",
        arguments: {
          path: "exports/report.docx",
          sourcePath: "report.docx",
          description: "Generated report",
        },
      });
      expect(published).toEqual({
        sourcePath: "report.docx",
        destination: "exports/report.docx",
        description: "Generated report",
      });
      expect(resultText(result)).toContain(
        "Saved exports/report.docx (56.1 KB)",
      );
    });
  });

  test("write_asset requires one content source", async () => {
    const server = createAssetsMcpServer(
      { sessionId: "os-assets-source" },
      { findSession: () => session() },
    );
    await withClient(server, async (client) => {
      const neither = await client.callTool({
        name: "write_asset",
        arguments: { path: "report.docx" },
      });
      expect(resultText(neither)).toContain(
        "provide exactly one of content or sourcePath",
      );

      const both = await client.callTool({
        name: "write_asset",
        arguments: {
          path: "report.docx",
          content: "data",
          sourcePath: "report.docx",
        },
      });
      expect(resultText(both)).toContain(
        "provide exactly one of content or sourcePath",
      );
    });
  });
});
