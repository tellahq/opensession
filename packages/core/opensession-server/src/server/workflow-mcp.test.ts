import { describe, expect, test } from "bun:test";
import {
  WORKFLOW_INPROCESS_ALLOWED,
  WORKFLOW_INPROCESS_EXCLUDED,
  WORKFLOW_INPROCESS_TOOL_DENIALS,
  createWorkflowMcpHost,
  workflowInProcessServers,
  workflowMcpServers,
} from "./workflow-mcp";
import { STRIPE_CONFIRM_TOOLS } from "./runner-shared";

// Policy only — no transport is opened: every assertion here is refused
// BEFORE a client connects (that's the point of checking first).

describe("workflowMcpServers", () => {
  test("drops servers owning a confirm-gated tool, keeps the rest", () => {
    const out = workflowMcpServers({
      grafana: { command: "mcp-grafana" },
      stripe: { type: "http", url: "https://mcp.stripe.com" },
      linear: { type: "http", url: "https://mcp.linear.app/mcp" },
    });
    expect(Object.keys(out).sort()).toEqual(["grafana", "linear"]);
  });

  test("every confirm-gated server in the catalog is covered", () => {
    // The drop is derived from STRIPE_CONFIRM_TOOLS, so a tool added there
    // closes the hole here too — assert the derivation, not a literal list.
    const servers = new Set(
      Object.keys(STRIPE_CONFIRM_TOOLS).map((id) => id.split("__")[1]),
    );
    const configured: Record<string, unknown> = { safe: {} };
    for (const s of servers) configured[s] = {};
    expect(Object.keys(workflowMcpServers(configured))).toEqual(["safe"]);
  });

  test("an empty surface stays empty", () => {
    expect(workflowMcpServers({})).toEqual({});
  });
});

describe("workflow MCP host policy", () => {
  const host = (deniedTools?: Record<string, string>) =>
    createWorkflowMcpHost({
      deniedTools,
      configuredForTest: {
        grafana: { command: "mcp-grafana" },
        plain: { command: "plain-mcp" },
        stripe: { type: "http", url: "https://mcp.stripe.com" },
      },
    });

  test("servers() lists the allowed surface without the gated server", () => {
    expect(host().servers()).toEqual(["grafana", "plain"]);
  });

  test("calling a confirm-gated server is refused with the propose-it hint", async () => {
    await expect(host().call("stripe", "create_refund", {})).rejects.toThrow(
      /confirm-gated/i,
    );
  });

  test("an unknown server is refused and lists what IS available", async () => {
    const promise = host().call("nope", "whatever", {});
    await expect(promise).rejects.toThrow(/no MCP server "nope"/);
    await expect(promise).rejects.toThrow(/grafana, plain/);
  });

  test("a denied tool is refused with the denial's own reason", async () => {
    const denied = host({
      mcp__plain__reply_to_thread: "Use an internal note instead.",
    });
    await expect(
      denied.call("plain", "reply_to_thread", { text: "hi" }),
    ).rejects.toThrow(/Use an internal note instead/);
    // Sibling tools on the same server stay reachable (the denial is
    // per-tool, not per-server) — this one fails on transport, not policy.
    await expect(denied.call("plain", "get_thread", {})).rejects.not.toThrow(
      /not available/,
    );
  });

  test("a closed host refuses further calls", async () => {
    const h = host();
    await h.close();
    await expect(h.call("grafana", "anything", {})).rejects.toThrow(/closed/i);
  });
});

describe("in-process opensession-* surface", () => {
  // A stand-in for an McpServer: only the shape the host branches on matters
  // (type "sdk" + an instance), and nothing here is ever connected because
  // every assertion is refused before a transport is opened.
  const sdk = (name: string) => ({ type: "sdk", instance: { name } });

  test("keeps only allowlisted servers from what the run carries", () => {
    expect(
      Object.keys(
        workflowInProcessServers({
          "opensession-assets": sdk("assets"),
          "opensession-web": sdk("web"),
          "opensession-admin": sdk("admin"),
          "opensession-sessions": sdk("sessions"),
        }),
      ).sort(),
    ).toEqual(["opensession-assets", "opensession-web"]);
  });

  test("an allowlisted server the run does not carry stays absent", () => {
    // Intersection, never a source: the allowlist can only ever narrow.
    expect(workflowInProcessServers({})).toEqual({});
  });

  test("skips a proxy config — only the sdk shape can be mounted in-memory", () => {
    expect(
      workflowInProcessServers({
        "opensession-assets": { command: "mcp-proxy", args: ["--rpc"] },
      }),
    ).toEqual({});
  });

  test("every excluded name is genuinely outside the allowlist", () => {
    // The excluded map only exists for the error message; a name landing in
    // both would mean a server documented as refused is actually reachable.
    for (const name of Object.keys(WORKFLOW_INPROCESS_EXCLUDED)) {
      expect(WORKFLOW_INPROCESS_ALLOWED.has(name)).toBe(false);
    }
  });

  const inProcessHost = () =>
    createWorkflowMcpHost({
      configuredForTest: { grafana: { command: "mcp-grafana" } },
      inProcessMcp: () => ({
        "opensession-assets": sdk("assets"),
        "opensession-memory": sdk("memory"),
        "opensession-admin": sdk("admin"),
      }),
    });

  test("servers() includes the allowlisted in-process servers", () => {
    expect(inProcessHost().servers()).toEqual([
      "grafana",
      "opensession-assets",
      "opensession-memory",
    ]);
  });

  test("an excluded in-process server is refused with its policy reason", async () => {
    const promise = inProcessHost().call(
      "opensession-admin",
      "list_automations",
      {},
    );
    await expect(promise).rejects.toThrow(/opensession-admin/);
    await expect(promise).rejects.toThrow(/reconfigures automations/);
  });

  test("an unknown opensession-* server says why, not just what's left", async () => {
    await expect(
      inProcessHost().call("opensession-invented", "x", {}),
    ).rejects.toThrow(/in-process opensession-\* servers are not available/);
  });

  test("memory writes are denied even though the server is mounted", async () => {
    for (const tool of [
      "store_memory",
      "update_memory",
      "archive_memory",
      "restore_memory",
      "confirm_memory",
      "forget_memory",
    ]) {
      await expect(
        inProcessHost().call("opensession-memory", tool, {}),
      ).rejects.toThrow(
        /(?:cannot (?:write|update|archive|restore|confirm|delete) memory|can only read memory)/,
      );
    }
  });

  test("memory reads are not denied by the built-in denials", () => {
    expect(
      WORKFLOW_INPROCESS_TOOL_DENIALS["mcp__opensession-memory__search_memory"],
    ).toBeUndefined();
  });

  test("future memory mutations fail closed", async () => {
    await expect(
      inProcessHost().call("opensession-memory", "future_mutation", {}),
    ).rejects.toThrow(/can only read memory/);
  });

  test("without an inProcessMcp builder the surface stays external-only", () => {
    // Automation runs supply no builder: their scripts must not gain the
    // session-scoped servers an interactive run carries.
    const host = createWorkflowMcpHost({
      configuredForTest: { grafana: { command: "mcp-grafana" } },
    });
    expect(host.servers()).toEqual(["grafana"]);
  });
});
