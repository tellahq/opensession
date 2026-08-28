import { describe, expect, test } from "bun:test";
import { AgentGatewayAmbiguousExecutionError } from "./gateway";
import type { AgentOperationIdentity } from "./ledger";
import type { McpRuntime, McpRuntimeTool } from "../mcp-runtime";
import {
  MAX_MCP_AGENT_TRANSCRIPT_BYTES,
  MCP_AGENT_OPERATION_RECONCILER,
  MCP_AGENT_OPERATION_REQUEST_VERSION,
  McpAgentOperationAmbiguityError,
  McpTurnRuntimeRegistry,
  createMcpAgentOperationAdapter,
} from "./mcp-adapter";

const digest = (char: string) => `sha256:${char.repeat(64)}` as const;
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>))
      freeze(child);
    Object.freeze(value);
  }
  return value;
};
const fence = (overrides = {}) =>
  freeze({
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1",
    generation: 1,
    ...overrides,
  });
function identity(
  overrides: Partial<AgentOperationIdentity> = {},
): AgentOperationIdentity {
  const turnFence = overrides.fence ?? fence();
  return freeze({
    operationId: "operation-1",
    kind: "mcp" as const,
    fence: turnFence,
    planHash: digest("a"),
    authorityHash: digest("b"),
    supervisorEpoch: 1,
    hostId: "host-1",
    hostGeneration: 1,
    hostIncarnation: "incarnation-1",
    transcriptAnchor: freeze({
      throughChangeSeq: 1,
      entryIds: freeze(["entry-1"]),
      digest: digest("c"),
    }),
    toolUseEntryId: "entry-1",
    descriptor: freeze({
      version: 1 as const,
      kind: "mcp" as const,
      toolUseEntryId: "entry-1",
      toolUseId: "tool-use-1",
      server: "search",
      tool: "lookup",
      argumentsDigest: digest("d"),
      adapterRequestVersion: MCP_AGENT_OPERATION_REQUEST_VERSION,
    }),
    descriptorDigest: digest("e"),
    payloadDigest: digest("f"),
    adapterId: "mcp-runtime",
    adapterVersion: "1.0",
    ...overrides,
  });
}
const payload = (args: Record<string, unknown> = { query: "safe" }) =>
  freeze({ arguments: freeze(args) });
const listedTool = (overrides: Partial<McpRuntimeTool> = {}): McpRuntimeTool =>
  freeze({
    id: "search_lookup",
    server: "search",
    name: "lookup",
    label: "Lookup",
    description: "Lookup",
    inputSchema: freeze({ type: "object" }),
    ...overrides,
  });
function runtime(
  options: {
    tools?: readonly McpRuntimeTool[];
    call?: McpRuntime["callExact"];
    close?: () => Promise<void>;
  } = {},
): McpRuntime {
  return {
    hasCatalog: true,
    async catalog() {
      return options.tools ?? [listedTool()];
    },
    callExact:
      options.call ??
      (async () => ({ content: [{ type: "text", text: "result" }] })),
    close: options.close ?? (async () => {}),
  };
}

async function installed(value: McpRuntime, turnFence = fence()) {
  const registry = new McpTurnRuntimeRegistry();
  const owner = registry.register(turnFence, value);
  return {
    registry,
    owner,
    adapter: createMcpAgentOperationAdapter(registry),
    turnFence,
  };
}

describe("turn-scoped MCP Agent operation adapter", () => {
  test("makes exactly one physical exact-identity call with descriptor tool-use identity", async () => {
    const calls: unknown[] = [];
    const controller = new AbortController();
    const setup = await installed(
      runtime({
        call: async (...args) => {
          calls.push(args);
          return { content: [{ type: "text", text: "done" }] };
        },
      }),
    );
    const result = await setup.adapter.execute(
      freeze({
        identity: identity({ fence: setup.turnFence }),
        payload: payload(),
      }),
      controller.signal,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "search_lookup",
      { query: "safe" },
      { toolCallId: "tool-use-1", signal: controller.signal },
    ]);
    expect(result).toEqual({
      outcome: { status: "succeeded", code: "ok" },
      transcript: { kind: "mcp", content: [{ type: "text", text: "done" }] },
    });
  });

  test("denied, missing, duplicate and crossover catalog identities make zero calls", async () => {
    for (const tools of [
      [],
      [listedTool({ name: "denied" })],
      [listedTool(), listedTool()],
      [listedTool({ server: "other" })],
      [listedTool({ id: "other_lookup" })],
    ]) {
      let calls = 0;
      const setup = await installed(
        runtime({
          tools,
          call: async () => {
            calls++;
            return { content: [] };
          },
        }),
      );
      const result = await setup.adapter.execute(
        freeze({
          identity: identity({ fence: setup.turnFence }),
          payload: payload(),
        }),
        new AbortController().signal,
      );
      expect(calls).toBe(0);
      expect(result.outcome).toEqual({ status: "failed", code: "tool_error" });
    }
  });

  test("rejects request-version mismatch before catalog or call", async () => {
    let catalogs = 0;
    let calls = 0;
    const value = runtime({
      call: async () => {
        calls++;
        return { content: [] };
      },
    });
    value.catalog = async () => {
      catalogs++;
      return [listedTool()];
    };
    const setup = await installed(value);
    const base = identity({ fence: setup.turnFence });
    const result = await setup.adapter.execute(
      freeze({
        identity: identity({
          fence: setup.turnFence,
          descriptor: freeze({
            ...base.descriptor,
            adapterRequestVersion: "other",
          }),
        }),
        payload: payload(),
      }),
      new AbortController().signal,
    );
    expect(result.outcome.status).toBe("failed");
    expect({ catalogs, calls }).toEqual({ catalogs: 0, calls: 0 });
  });

  test("rejects prototypes, accessors and extra payload keys without executing getters", async () => {
    let calls = 0;
    let getterCalls = 0;
    const setup = await installed(
      runtime({
        call: async () => {
          calls++;
          return { content: [] };
        },
      }),
    );
    const accessor = Object.create(null);
    Object.defineProperty(accessor, "arguments", {
      enumerable: true,
      get: () => {
        getterCalls++;
        return {};
      },
    });
    Object.freeze(accessor);
    const hostile = [
      freeze(
        Object.assign(Object.create({ inherited: true }), {
          arguments: freeze({}),
        }),
      ),
      accessor,
      freeze({ arguments: freeze({}), extra: true }),
      { arguments: freeze({}) },
    ];
    for (const raw of hostile) {
      const result = await setup.adapter.execute(
        { identity: identity({ fence: setup.turnFence }), payload: raw },
        new AbortController().signal,
      );
      expect(result.outcome.status).toBe("failed");
    }
    expect({ calls, getterCalls }).toEqual({ calls: 0, getterCalls: 0 });
  });

  test("a signal aborted before invocation makes zero calls", async () => {
    let calls = 0;
    const setup = await installed(
      runtime({
        call: async () => {
          calls++;
          return { content: [] };
        },
      }),
    );
    const controller = new AbortController();
    controller.abort();
    const result = await setup.adapter.execute(
      freeze({
        identity: identity({ fence: setup.turnFence }),
        payload: payload(),
      }),
      controller.signal,
    );
    expect(result.outcome).toEqual({ status: "cancelled", code: "cancelled" });
    expect(calls).toBe(0);
  });

  test("cancellation after the physical call begins is typed ambiguous", async () => {
    const controller = new AbortController();
    let calls = 0;
    const setup = await installed(
      runtime({
        call: async () => {
          calls++;
          controller.abort();
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        },
      }),
    );
    const promise = setup.adapter.execute(
      freeze({
        identity: identity({ fence: setup.turnFence }),
        payload: payload(),
      }),
      controller.signal,
    );
    await expect(promise).rejects.toBeInstanceOf(
      McpAgentOperationAmbiguityError,
    );
    await expect(promise).rejects.toBeInstanceOf(
      AgentGatewayAmbiguousExecutionError,
    );
    await expect(promise).rejects.toMatchObject({
      reason: "cancellation_ambiguous",
    });
    expect(calls).toBe(1);
  });

  test("timeout and disconnect after invocation are typed ambiguous and reconciliation fails closed", async () => {
    for (const [message, reason] of [
      ["request timed out", "timeout_ambiguous"],
      ["connection closed", "disconnect_ambiguous"],
    ] as const) {
      let calls = 0;
      const setup = await installed(
        runtime({
          call: async () => {
            calls++;
            throw new Error(message);
          },
        }),
      );
      const promise = setup.adapter.execute(
        freeze({
          identity: identity({ fence: setup.turnFence }),
          payload: payload(),
        }),
        new AbortController().signal,
      );
      await expect(promise).rejects.toMatchObject({
        name: "McpAgentOperationAmbiguityError",
        reason,
      });
      expect(calls).toBe(1);
    }
    expect(await MCP_AGENT_OPERATION_RECONCILER.reconcile({} as never)).toEqual(
      {
        status: "indeterminate",
        reason: "reconciliation_unsupported",
      },
    );
  });

  test("deterministic tool errors fail without exposing raw error material", async () => {
    const setup = await installed(
      runtime({
        call: async () => {
          throw new Error("secret credential abc");
        },
      }),
    );
    const result = await setup.adapter.execute(
      freeze({
        identity: identity({ fence: setup.turnFence }),
        payload: payload(),
      }),
      new AbortController().signal,
    );
    expect(result.outcome).toEqual({ status: "failed", code: "tool_error" });
    expect(JSON.stringify(result)).not.toContain("secret credential abc");
  });

  test("normalizes text and images into bounded ephemeral transcript content", async () => {
    const setup = await installed(
      runtime({
        call: async () => ({
          content: [
            {
              type: "text",
              text: "x".repeat(MAX_MCP_AGENT_TRANSCRIPT_BYTES * 2),
            },
            {
              type: "image",
              data: "y".repeat(MAX_MCP_AGENT_TRANSCRIPT_BYTES * 2),
              mimeType: "image/png",
            },
          ],
        }),
      }),
    );
    const result = await setup.adapter.execute(
      freeze({
        identity: identity({ fence: setup.turnFence }),
        payload: payload(),
      }),
      new AbortController().signal,
    );
    expect(
      Buffer.byteLength(JSON.stringify(result.transcript)),
    ).toBeLessThanOrEqual(MAX_MCP_AGENT_TRANSCRIPT_BYTES);
    expect(JSON.stringify(result.transcript)).not.toContain("server");
    expect(Object.isFrozen(result.transcript)).toBe(true);
  });

  test("isolates full fences and gives close/unregister ownership only to the registration", async () => {
    let closes = 0;
    let callsA = 0;
    let callsB = 0;
    const registry = new McpTurnRuntimeRegistry();
    const a = fence();
    const b = fence({ generation: 2 });
    const ownerA = registry.register(
      a,
      runtime({
        call: async () => {
          callsA++;
          return { content: [] };
        },
        close: async () => {
          closes++;
        },
      }),
    );
    registry.register(
      b,
      runtime({
        call: async () => {
          callsB++;
          return { content: [] };
        },
      }),
    );
    const adapter = createMcpAgentOperationAdapter(registry);
    await adapter.execute(
      freeze({ identity: identity({ fence: b }), payload: payload() }),
      new AbortController().signal,
    );
    expect({ callsA, callsB }).toEqual({ callsA: 0, callsB: 1 });
    await Promise.all([ownerA.close(), ownerA.close()]);
    expect(closes).toBe(1);
    expect(registry.get(a)).toBeUndefined();
    expect(() => registry.register(a, runtime())).toThrow();
    expect(Object.keys(ownerA)).toEqual(["close"]);
    expect(JSON.stringify({ registry, ownerA, adapter })).not.toMatch(
      /credential|config|grant/i,
    );
  });
});
