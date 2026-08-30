/**
 * The two attribution helpers behind GET /api/sessions/:id/effective-config.
 * Both are deliberately pure: membership is decided by the real resolvers
 * (filterMcpServers, runToolPolicy) and handed in, so these only have to
 * explain the outcome, never reproduce it.
 */

import { describe, expect, test } from "bun:test";
import { explainMcpServers, describeStrippedTools } from "./effective-config";
import { filterMcpServers, STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import { runToolPolicy } from "./run-policy";

const CATALOG = {
  slack: { command: "bunx", args: ["slack-mcp"] },
  linear: { type: "http", url: "https://mcp.linear.app/mcp" },
  brex: {
    type: "http",
    url: "https://brex.example",
    allowedUsers: ["Michiel", "Grant"],
  },
};

function explain(opts: {
  scope?: string[];
  gateUsers?: string[];
  included: Record<string, unknown>;
}) {
  return explainMcpServers({
    all: CATALOG,
    included: opts.included,
    scope: opts.scope,
    gateUsers: opts.gateUsers ?? [],
    configPath: "/etc/mcp-config.json",
  });
}

function byName(rows: ReturnType<typeof explain>, name: string) {
  const row = rows.find((r) => r.name === name);
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe("explainMcpServers", () => {
  test("no allowlist: every configured server is listed and attributed", () => {
    const rows = explain({
      included: { slack: {}, linear: {}, brex: {} },
      gateUsers: ["Michiel"],
    });
    expect(rows.map((r) => r.name)).toEqual(["brex", "linear", "slack"]);
    expect(rows.every((r) => r.included)).toBe(true);
    expect(byName(rows, "slack").source).toContain("/etc/mcp-config.json");
    expect(byName(rows, "slack").transport).toBe("local");
    expect(byName(rows, "linear").transport).toBe("remote");
  });

  test("a server outside the allowlist says so, and is not dropped from the report", () => {
    const rows = explain({ scope: ["slack"], included: { slack: {} } });
    expect(byName(rows, "linear").included).toBe(false);
    expect(byName(rows, "linear").reason).toBe(
      "outside this run's MCP allowlist",
    );
    expect(byName(rows, "slack").reason).toContain(
      "named by this run's MCP allowlist",
    );
  });

  test("an allowedUsers miss names both the gate and who was tried", () => {
    const rows = explain({
      included: { slack: {}, linear: {} },
      gateUsers: ["Kent"],
    });
    const brex = byName(rows, "brex");
    expect(brex.included).toBe(false);
    expect(brex.allowedUsers).toEqual(["Michiel", "Grant"]);
    expect(brex.reason).toContain("allowedUsers gate");
    expect(brex.reason).toContain("Kent");
    expect(brex.source).toContain("allowedUsers");
  });

  test("Apple release explains its current-prompter-only gate", () => {
    for (const name of [
      "apple-release",
      "APPLE-RELEASE",
      "  Apple-Release  ",
    ]) {
      const [apple] = explainMcpServers({
        all: {
          [name]: {
            command: "opensession",
            allowedUsers: ["Alice"],
          },
        },
        included: {},
        scope: undefined,
        gateUsers: ["Bob", "Alice"],
        configPath: "/tmp/mcp-config.json",
      });
      expect(apple.reason).toContain("none of [Bob]");
      expect(apple.reason).not.toContain("Bob, Alice");
    }
  });

  test("explains invalid protected allowlists as fail-closed", () => {
    for (const allowedUsers of [
      undefined,
      [],
      "Alice",
      [123],
      [""],
      ["Alice", 123],
    ]) {
      const [apple] = explainMcpServers({
        all: {
          "apple-release": {
            command: "opensession",
            allowedUsers,
          },
        },
        included: {},
        scope: undefined,
        gateUsers: ["Alice"],
        configPath: "/tmp/mcp-config.json",
      });
      expect(apple.included).toBe(false);
      expect(apple.reason).toContain("missing, empty, or malformed");
      expect(apple.reason).toContain("denied");
      expect(apple.reason).not.toContain("every configured server");
    }
  });

  test("an automation run (no user at all) reads as a gate miss, not an omission", () => {
    const rows = explain({
      included: { slack: {}, linear: {} },
      gateUsers: [],
    });
    expect(byName(rows, "brex").reason).toContain("no user");

    const [apple] = explainMcpServers({
      all: {
        "APPLE-RELEASE": {
          command: "opensession",
          allowedUsers: ["Alice"],
        },
      },
      included: {},
      scope: undefined,
      gateUsers: [],
      configPath: "/tmp/mcp-config.json",
    });
    expect(apple.reason).toContain("none of [no user]");
  });

  test("an allowlist naming an unconfigured server is reported, not silently dropped", () => {
    const rows = explain({
      scope: ["slack", "ghost"],
      included: { slack: {} },
    });
    const ghost = byName(rows, "ghost");
    expect(ghost.included).toBe(false);
    expect(ghost.reason).toContain("not configured");
    expect(ghost.transport).toBe("unknown");
  });

  test("the real filterMcpServers drives membership", () => {
    // Same inputs through the actual resolver: the explanation must agree with
    // it rather than with a second copy of the rule.
    const included = filterMcpServers("all", "Kent", ["Kent"]);
    const rows = explainMcpServers({
      all: { brex: CATALOG.brex },
      included,
      scope: undefined,
      gateUsers: ["Kent"],
      configPath: "/etc/mcp-config.json",
    });
    expect(byName(rows, "brex").included).toBe("brex" in included);
  });
});

describe("describeStrippedTools", () => {
  const policy = (deniedTools?: Record<string, string>) =>
    runToolPolicy({
      deniedTools,
      confirmTools: STRIPE_CONFIRM_TOOLS,
      journalKind: "prompt",
    });

  test("money-movers are attributed to the confirm catalog on every run", () => {
    const p = policy();
    const rows = describeStrippedTools(p, undefined, STRIPE_CONFIRM_TOOLS);
    const refund = rows.find((r) => r.tool === "mcp__stripe__create_refund");
    expect(refund).toBeDefined();
    expect(refund!.source).toContain("STRIPE_CONFIRM_TOOLS");
    // Money-movers take the broad strip: server-scoped id, wildcard, bare name.
    expect(refund!.ids).toEqual([
      "stripe_create_refund",
      "*_create_refund",
      "create_refund",
    ]);
    for (const id of refund!.ids) expect(p.disables[id]).toBe(false);
  });

  test("automation denials are attributed to the automation catalog", () => {
    const denied = {
      mcp__plain__reply_to_thread: "read-only toward the customer",
    };
    const rows = describeStrippedTools(
      policy(denied),
      denied,
      STRIPE_CONFIRM_TOOLS,
    );
    const reply = rows.find((r) => r.tool === "mcp__plain__reply_to_thread");
    expect(reply!.source).toContain("AUTOMATION_DENIED_TOOLS");
    expect(reply!.reason).toBe("read-only toward the customer");
    // A server-scoped denial stays exact — the wildcard form once stripped
    // slack_reply_to_thread from every automation run.
    expect(reply!.ids).toEqual(["plain_reply_to_thread"]);
  });

  test("every id the policy disables is explained by exactly one row", () => {
    const denied = {
      mcp__plain__reply_to_thread: "read-only toward the customer",
    };
    const p = policy(denied);
    const rows = describeStrippedTools(p, denied, STRIPE_CONFIRM_TOOLS);
    for (const id of Object.keys(p.disables)) {
      expect(rows.filter((r) => r.ids.includes(id)).length).toBe(1);
    }
  });

  test("the engine's own native question tool is explained too", () => {
    const rows = describeStrippedTools(
      policy(),
      undefined,
      STRIPE_CONFIRM_TOOLS,
    );
    const question = rows.find((r) => r.tool === "question");
    expect(question!.reason).toContain("opensession-ask");
  });
});
