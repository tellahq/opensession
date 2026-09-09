import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createReposMcpServer, type ReposToolContext } from "./repos-tools";

function harness(overrides: Partial<ReposToolContext> = {}) {
  const labelCalls: Array<Record<string, unknown>> = [];
  const ctx: ReposToolContext = {
    sessionId: "os-test",
    attach: async () => {
      throw new Error("unused");
    },
    switchPrimary: async () => {
      throw new Error("unused");
    },
    snapshot: () => null,
    repos: () => [],
    linkPr: async () => {
      throw new Error("unused");
    },
    labelPr: async (input) => {
      labelCalls.push(input);
      return {
        repo: "fusion",
        number: input.number ?? 6320,
        labels: ["preview-temporal", ...(input.add ?? [])],
      };
    },
    ...overrides,
  };
  return { server: createReposMcpServer(ctx), labelCalls };
}

async function call(
  server: ReturnType<typeof createReposMcpServer>,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const res = await client.callTool({ name, arguments: args });
    // SAFETY: every tool in this server answers with one text block.
    return (res.content as Array<{ text: string }>)[0].text;
  } finally {
    await client.close();
  }
}

describe("label_pull_request", () => {
  test("passes the target and change through and reports the label set", async () => {
    const { server, labelCalls } = harness();
    const out = await call(server, "label_pull_request", {
      url: "https://github.com/acme/fusion/pull/6320",
      add: ["preview-instant"],
    });
    expect(labelCalls).toEqual([
      {
        url: "https://github.com/acme/fusion/pull/6320",
        add: ["preview-instant"],
      },
    ]);
    expect(out).toBe("fusion#6320 labels: preview-temporal, preview-instant.");
  });

  test("a refused change comes back as a message, not a tool error", async () => {
    const { server } = harness({
      labelPr: async () => {
        throw new Error('Unknown repo "nope"');
      },
    });
    const out = await call(server, "label_pull_request", {
      repo: "nope",
      number: 1,
      add: ["x"],
    });
    expect(out).toBe('Couldn\'t label that PR: Unknown repo "nope"');
  });
});
