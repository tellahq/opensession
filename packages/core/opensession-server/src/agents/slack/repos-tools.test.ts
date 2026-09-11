import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createReposMcpServer, type ReposToolContext } from "./repos-tools";

function harness(overrides: Partial<ReposToolContext> = {}) {
  const labelCalls: Array<Record<string, unknown>> = [];
  const readyCalls: Array<Record<string, unknown>> = [];
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
    checkPrReady: async (input) => {
      readyCalls.push(input);
      return {
        ready: false,
        summary:
          'PR #368 "Keep budgets visible" is not ready to merge: it has merge conflicts with main and 1 check is failing (Native client CI / build-and-test).',
        blockers: [
          "it has merge conflicts with main",
          "1 check is failing (Native client CI / build-and-test)",
        ],
        warnings: [],
        pr: {
          repo: "opensession",
          ghRepo: "acme/opensession",
          number: 368,
          title: "Keep budgets visible",
          url: "https://github.com/acme/opensession/pull/368",
          author: "louise",
          base: "main",
          head: "budgets",
          headSha: "0123456789abcdef",
        },
        state: "OPEN",
        draft: false,
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        checks: {
          total: 2,
          passing: [
            {
              name: "CI / Type-check and tests",
              outcome: "passing",
              required: false,
            },
          ],
          failing: [
            {
              name: "Native client CI / build-and-test",
              outcome: "failing",
              required: false,
            },
          ],
          pending: [],
          skipped: [],
          missingRequired: [],
        },
        review: {
          decision: "NONE",
          approvedBy: [],
          changesRequestedBy: [],
          awaiting: [],
          requiredApprovals: 0,
        },
        rules: {
          readable: true,
          requiredChecks: [],
          requiredApprovals: 0,
          strictUpToDate: false,
        },
      };
    },
    ...overrides,
  };
  return { server: createReposMcpServer(ctx), labelCalls, readyCalls };
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

describe("check_pr_ready", () => {
  test("passes the target through and leads with the spoken verdict", async () => {
    const { server, readyCalls } = harness();
    const out = await call(server, "check_pr_ready", {
      url: "https://github.com/acme/opensession/pull/368",
    });
    expect(readyCalls).toEqual([
      { url: "https://github.com/acme/opensession/pull/368" },
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toBe(
      'PR #368 "Keep budgets visible" is not ready to merge: it has merge conflicts with main and 1 check is failing (Native client CI / build-and-test).',
    );
    expect(out).toContain("✗ Native client CI / build-and-test");
    expect(out).toContain("✓ CI / Type-check and tests");
    // The verdict rides along as JSON for callers that branch on it.
    const json = out.slice(out.indexOf("```json") + 7, out.lastIndexOf("```"));
    expect(JSON.parse(json).ready).toBe(false);
  });

  test("a session with no PR comes back as a message, not a tool error", async () => {
    const { server } = harness({
      checkPrReady: async () => {
        throw new Error(
          "Session os-x has no pull request yet (opensession:feat)",
        );
      },
    });
    const out = await call(server, "check_pr_ready", { session: "os-x" });
    expect(out).toBe(
      "Couldn't check that PR: Session os-x has no pull request yet (opensession:feat)",
    );
  });
});
