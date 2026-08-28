import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashAgentMcpArgumentsV1,
  hashAgentMcpPayloadV1,
  hashAgentModelPayloadV1,
  hashAgentOperationDescriptorV1,
  type AgentOperationRequestV1,
} from "@tellahq/opensession-protocol/agent-operation";
import type { AgentHostSupervisionAuthorityV2 } from "@tellahq/opensession-protocol/agent-host";
import {
  AgentGatewayGrantRegistry,
  encodeAgentGatewayPolicyHandle,
} from "./grants";
import {
  AgentGatewayAmbiguousExecutionError,
  AgentOperationGateway,
  type AgentGatewayFailpoint,
  type AgentGatewayLiveEventSink,
} from "./gateway";
import { SQLiteAgentOperationLedger } from "./sqlite-ledger";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const d = (c: string) => `sha256:${c.repeat(64)}` as const;
const bytes = new TextEncoder().encode("payload");
const authority: AgentHostSupervisionAuthorityV2 = {
  version: 2,
  fence: {
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1",
    generation: 1,
  },
  planHash: d("a"),
  hostId: "host-000000000001",
  hostGeneration: 1,
  hostIncarnation: "incarnation-0001",
  supervisorEpoch: 1,
  kernelServiceEpoch: "kernel-epoch-0001",
  hostChallenge: "challenge-00000001",
  audience: "opensession-agent-host",
  purpose: "agent-host-supervision",
  issuedAtMs: 1,
  expiresAtMs: 1_000_000,
  nonce: "nonce-000000000001",
  keyId: "key-0000000000001",
};
const envelope = {
  version: 1,
  algorithm: "Ed25519",
  domain: "opensession.agent-host.supervision.v2",
  authorityBytes: "AQ",
  signature: Buffer.alloc(64).toString("base64url"),
} as const;

async function fixture(
  failAt?: AgentGatewayFailpoint,
  beforeAdapterCompletes?: () => Promise<void>,
  lifecycle?: {
    begin?: (recordState: string) => Promise<AgentGatewayLiveEventSink>;
    execute?: (sink?: AgentGatewayLiveEventSink) => Promise<void>;
    onAppend?: () => void;
    onSettle?: () => void;
  },
) {
  const root = mkdtempSync(join(tmpdir(), "agent-gateway-"));
  roots.push(root);
  const ledger = new SQLiteAgentOperationLedger({
    dbPath: join(root, "ledger.sqlite"),
  });
  let now = 10;
  const grants = new AgentGatewayGrantRegistry({
    now: () => now,
    entropy: () => "x".repeat(43),
  });
  const descriptor = {
    version: 1,
    kind: "model",
    stepId: "step-1",
    transcript: { throughChangeSeq: 2, entryIds: ["entry-1"], digest: d("c") },
    modelPolicyHash: d("d"),
    adapterRequestVersion: "v1",
  } as const;
  const descriptorDigest = await hashAgentOperationDescriptorV1(descriptor);
  const payloadDigest = await hashAgentModelPayloadV1(bytes);
  const grant = grants.issue({
    operationId: "operation-1",
    kind: "model",
    fence: authority.fence,
    planHash: d("a"),
    authorityHash: d("b"),
    supervisorEpoch: 1,
    hostId: authority.hostId,
    hostGeneration: 1,
    hostIncarnation: authority.hostIncarnation,
    descriptorDigest,
    payloadDigest,
    transcriptAnchor: descriptor.transcript,
    adapterId: "adapter-1",
    adapterVersion: "1.0",
    deadlineMs: 500,
    authorityExpiresAtMs: 600,
    policyHandle: encodeAgentGatewayPolicyHandle("policy00000000001"),
  });
  const request: AgentOperationRequestV1 = {
    version: 1,
    operationId: "operation-1",
    kind: "model",
    fence: authority.fence,
    supervisionEnvelope: envelope,
    dispatchGrant: grant,
    descriptor,
    descriptorDigest,
  };
  const actor = {
    admits: 0,
    terminals: 0,
    async admit() {
      this.admits++;
      return { accepted: true };
    },
    async settle() {
      lifecycle?.onSettle?.();
      this.terminals++;
    },
    async indeterminate() {
      this.terminals++;
    },
  };
  let executions = 0;
  let terminalAppends = 0;
  let notices = 0;
  let tripped = false;
  const gateway = new AgentOperationGateway({
    ledger,
    grants,
    now: () => ++now,
    verifySupervision: async () => ({ authority, authorityHash: d("b") }),
    admission: actor,
    adapterFor: () => ({
      id: "adapter-1",
      version: "1.0",
      async execute(_request, _signal, sink) {
        executions++;
        await lifecycle?.execute?.(sink);
        await beforeAdapterCompletes?.();
        return {
          outcome: { status: "succeeded", outputDigest: d("e") },
          transcript: { text: "ephemeral" },
        };
      },
    }),
    decodePayload: (kind, payload) => {
      if (kind !== "model" || payload !== "payload") return undefined;
      return Object.freeze({ kind, value: payload, canonicalBytes: bytes });
    },
    appendTerminal: async () => {
      lifecycle?.onAppend?.();
      terminalAppends++;
      return terminal("append-terminal", d("e"), "ok");
    },
    beginLiveExecution: lifecycle?.begin
      ? (record) => lifecycle.begin!(record.receipt.state)
      : undefined,
    appendIndeterminateNotice: async (record, appendId) => {
      notices++;
      return terminal(
        appendId,
        d("f"),
        record.terminalReservation?.reason ?? "reconciliation_unsupported",
      ).kernelTerminal;
    },
    failpoint: async (point) => {
      if (point === failAt && !tripped) {
        tripped = true;
        throw new Error(`fail:${point}`);
      }
    },
  });
  return {
    gateway,
    ledger,
    request,
    actor,
    counts: () => ({ executions, terminalAppends, notices }),
  };
}
async function mcpFixture(options?: {
  canonicalArgumentsBytes?: Uint8Array;
  resolvedAnchor?: {
    throughChangeSeq: number;
    entryIds: string[];
    digest: ReturnType<typeof d>;
  };
  decodedValue?: unknown;
}) {
  const root = mkdtempSync(join(tmpdir(), "agent-gateway-mcp-"));
  roots.push(root);
  const ledger = new SQLiteAgentOperationLedger({
    dbPath: join(root, "ledger.sqlite"),
  });
  let now = 10;
  const grants = new AgentGatewayGrantRegistry({
    now: () => now,
    entropy: () => "m".repeat(43),
  });
  const argumentsBytes = new TextEncoder().encode('{"query":"safe"}');
  const payloadBytes = new TextEncoder().encode(
    '{"arguments":{"query":"safe"}}',
  );
  const transcriptAnchor = {
    throughChangeSeq: 4,
    entryIds: ["entry-tool-use"],
    digest: d("7"),
  } as const;
  const descriptor = {
    version: 1,
    kind: "mcp",
    toolUseEntryId: "entry-tool-use",
    toolUseId: "tool-use-1",
    server: "search-server",
    tool: "search",
    argumentsDigest: await hashAgentMcpArgumentsV1(argumentsBytes),
    adapterRequestVersion: "v1",
  } as const;
  const descriptorDigest = await hashAgentOperationDescriptorV1(descriptor);
  const payloadDigest = await hashAgentMcpPayloadV1(payloadBytes);
  const grant = grants.issue({
    operationId: "operation-mcp-1",
    kind: "mcp",
    fence: authority.fence,
    planHash: d("a"),
    authorityHash: d("b"),
    supervisorEpoch: 1,
    hostId: authority.hostId,
    hostGeneration: 1,
    hostIncarnation: authority.hostIncarnation,
    descriptorDigest,
    payloadDigest,
    transcriptAnchor,
    toolUseEntryId: descriptor.toolUseEntryId,
    adapterId: "mcp-adapter-1",
    adapterVersion: "1.0",
    deadlineMs: 500,
    authorityExpiresAtMs: 600,
    policyHandle: encodeAgentGatewayPolicyHandle("mcppolicy00000001"),
  });
  const request: AgentOperationRequestV1 = {
    version: 1,
    operationId: "operation-mcp-1",
    kind: "mcp",
    fence: authority.fence,
    supervisionEnvelope: envelope,
    dispatchGrant: grant,
    descriptor,
    descriptorDigest,
  };
  let admits = 0;
  let executions = 0;
  let resolverCalls = 0;
  let adapterRequest: unknown;
  const gateway = new AgentOperationGateway({
    ledger,
    grants,
    now: () => ++now,
    verifySupervision: async () => ({ authority, authorityHash: d("b") }),
    admission: {
      async admit() {
        admits++;
        return { accepted: true };
      },
      async settle() {},
      async indeterminate() {},
    },
    adapterFor: () => ({
      id: "mcp-adapter-1",
      version: "1.0",
      async execute(value) {
        executions++;
        adapterRequest = value;
        return {
          outcome: { status: "succeeded", outputDigest: d("8") },
          transcript: { text: "ephemeral" },
        };
      },
    }),
    decodePayload: (kind, payload) =>
      Object.freeze({
        kind: kind as "mcp",
        value:
          options && "decodedValue" in options ? options.decodedValue : payload,
        canonicalBytes: payloadBytes,
        canonicalArgumentsBytes:
          options?.canonicalArgumentsBytes ?? argumentsBytes,
      }),
    resolveTranscriptAnchor: async (resolvedRequest, toolUseEntryId) => {
      resolverCalls++;
      expect(resolvedRequest).toEqual(request);
      expect(toolUseEntryId).toBe(descriptor.toolUseEntryId);
      await Promise.resolve();
      return options?.resolvedAnchor ?? transcriptAnchor;
    },
    appendTerminal: async () => {
      const completed = terminal("append-mcp-terminal", d("8"), "ok");
      return {
        refs: completed.refs,
        kernelTerminal: {
          outputDigest: d("8"),
          outcomeCode: "ok",
          transcriptRefs: completed.refs,
        },
      };
    },
    appendIndeterminateNotice: async () => {
      throw new Error("unexpected recovery");
    },
  });
  return {
    gateway,
    ledger,
    request,
    counts: () => ({ admits, executions, resolverCalls }),
    adapterRequest: () =>
      adapterRequest as
        | {
            identity: {
              operationId: string;
              descriptor: unknown;
              toolUseEntryId?: string;
            };
            payload: unknown;
          }
        | undefined,
  };
}

function terminal(
  appendId: string,
  outputDigest: `sha256:${string}`,
  outcomeCode: string,
) {
  const refs = [
    {
      appendId,
      entryIds: [`entry-${appendId}`],
      firstSeq: 3,
      lastSeq: 3,
      throughChangeSeq: 3,
      requestDigest: d("1"),
    },
  ];
  return {
    refs,
    kernelTerminal: {
      outputDigest,
      outcomeCode,
      transcriptRefs: refs,
      pendingToolUseEntryIds: [],
    },
  };
}

const points: AgentGatewayFailpoint[] = [
  "after_admission",
  "after_prepared",
  "after_executing",
  "after_transcript_append",
  "after_ledger_settlement",
  "after_schema_settlement",
];
describe("Agent operation gateway durable choreography", () => {
  for (const point of points)
    test(`failpoint ${point} never repeats physical work`, async () => {
      const f = await fixture(point);
      await expect(f.gateway.dispatch(f.request, "payload")).rejects.toThrow(
        `fail:${point}`,
      );
      const active = await f.ledger.scanActive();
      if (active.some((record) => record.receipt.state === "executing"))
        await f.gateway.recoverActive();
      else await f.gateway.dispatch(f.request, "payload");
      const records = await f.ledger.scanActive();
      expect(records).toHaveLength(0);
      expect(f.counts().executions).toBeLessThanOrEqual(1);
      if (["after_executing", "after_transcript_append"].includes(point)) {
        expect(f.counts().executions).toBe(point === "after_executing" ? 0 : 1);
        expect(f.counts().notices).toBe(1);
      }
      await f.ledger.close();
    });

  test("orders acknowledged live events before transcript and terminal settlement", async () => {
    const order: string[] = [];
    const f = await fixture(undefined, undefined, {
      begin: async (state) => {
        order.push(`begin:${state}`);
        return {
          async publish() {
            order.push("publish");
          },
          async close() {
            order.push("close");
            return Object.freeze({ frames: 1 });
          },
          async fail() {
            order.push("fail");
          },
        };
      },
      execute: async (sink) => {
        await sink!.publish(Object.freeze({ token: "x" }));
        order.push("execute");
      },
      onAppend: () => order.push("append"),
      onSettle: () => order.push("settle"),
    });
    await f.gateway.dispatch(f.request, "payload");
    expect(order).toEqual([
      "begin:executing",
      "publish",
      "execute",
      "close",
      "append",
      "settle",
    ]);
    expect(f.counts()).toMatchObject({ terminalAppends: 1, executions: 1 });
    await f.ledger.close();
  });

  test("typed ambiguity is immediately reserved, appended, and settled without retry", async () => {
    const f = await fixture(undefined, undefined, {
      execute: async () => {
        throw new AgentGatewayAmbiguousExecutionError("timeout_ambiguous");
      },
    });
    const terminal = await f.gateway.dispatch(f.request, "payload");
    expect(terminal.receipt.state).toBe("indeterminate");
    expect(terminal.receipt.kernelTerminal?.outcomeCode).toBe(
      "timeout_ambiguous",
    );
    expect(f.counts()).toEqual({
      executions: 1,
      terminalAppends: 0,
      notices: 1,
    });
    expect(f.actor.terminals).toBe(1);
    await f.ledger.close();
  });

  test("concurrent duplicate replay invokes the adapter exactly once", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([
      f.gateway.dispatch(f.request, "payload"),
      f.gateway.dispatch(f.request, "payload"),
    ]);
    expect(a.receipt.state).toBe("settled");
    expect(b.receipt.state).toBe("settled");
    expect(f.counts()).toMatchObject({ executions: 1, terminalAppends: 1 });
    await f.ledger.close();
  });

  test("prepared recovery is inert and requires a fresh authorized dispatch", async () => {
    const f = await fixture("after_prepared");
    await expect(f.gateway.dispatch(f.request, "payload")).rejects.toThrow();
    const recovered = await f.gateway.recoverActive();
    expect(recovered.prepared).toHaveLength(1);
    expect(f.counts().executions).toBe(0);
    await f.gateway.dispatch(f.request, "payload");
    expect(f.counts().executions).toBe(1);
    await f.ledger.close();
  });

  test("does not hold the actor while physical work is blocked", async () => {
    let release!: () => void;
    let started!: () => void;
    const adapterStarted = new Promise<void>((resolve) => (started = resolve));
    const adapterRelease = new Promise<void>((resolve) => (release = resolve));
    const f = await fixture(undefined, async () => {
      started();
      await adapterRelease;
    });
    const dispatch = f.gateway.dispatch(f.request, "payload");
    await adapterStarted;
    await expect(f.actor.admit()).resolves.toEqual({ accepted: true });
    release();
    await dispatch;
    expect(f.counts().executions).toBe(1);
    await f.ledger.close();
  });

  test("forged request and stale grant fail before admission or physical work", async () => {
    const f = await fixture();
    await expect(
      f.gateway.dispatch({ ...f.request, descriptorDigest: d("9") }, "payload"),
    ).rejects.toThrow();
    await expect(
      f.gateway.dispatch(
        { ...f.request, dispatchGrant: "osag_dispatch_v1." + "z".repeat(43) },
        "payload",
      ),
    ).rejects.toThrow();
    expect(f.actor.admits).toBe(0);
    expect(f.counts().executions).toBe(0);
    await f.ledger.close();
  });

  test("MCP dispatch binds canonical arguments, exact identity, and server anchor", async () => {
    const payload = { arguments: { query: "safe" } };
    const f = await mcpFixture({ decodedValue: payload });
    const settled = await f.gateway.dispatch(f.request, payload);
    expect(settled.receipt.state).toBe("settled");
    expect(f.counts()).toEqual({ admits: 1, executions: 1, resolverCalls: 1 });
    const execution = f.adapterRequest();
    expect(execution?.identity).toMatchObject({
      operationId: "operation-mcp-1",
      descriptor: f.request.descriptor,
      toolUseEntryId: "entry-tool-use",
    });
    expect(execution?.payload).toEqual(payload);
    expect(execution?.payload).not.toBe(payload);
    expect(Object.isFrozen(execution?.payload)).toBe(true);
    expect(
      Object.isFrozen((execution?.payload as { arguments: object }).arguments),
    ).toBe(true);
    await f.ledger.close();
  });

  test("MCP argument digest mismatch fails before admission or physical work", async () => {
    const f = await mcpFixture({
      canonicalArgumentsBytes: new TextEncoder().encode('{"query":"changed"}'),
    });
    await expect(
      f.gateway.dispatch(f.request, { arguments: {} }),
    ).rejects.toThrow("arguments digest mismatch");
    expect(f.counts()).toEqual({ admits: 0, executions: 0, resolverCalls: 0 });
    await f.ledger.close();
  });

  test("Proxy and getter payloads fail before admission or physical work", async () => {
    let getterCalls = 0;
    const getterPayload = Object.defineProperty({}, "arguments", {
      enumerable: true,
      get() {
        getterCalls++;
        return { query: `mutation-${getterCalls}` };
      },
    });
    const proxyPayload = new Proxy(
      { arguments: { query: "safe" } },
      {
        get(target, property, receiver) {
          if (property === "arguments") getterCalls++;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    for (const payload of [getterPayload, proxyPayload]) {
      const f = await mcpFixture({ decodedValue: payload });
      await expect(f.gateway.dispatch(f.request, payload)).rejects.toThrow(
        "invalid decoded payload",
      );
      expect(f.counts()).toEqual({
        admits: 0,
        executions: 0,
        resolverCalls: 0,
      });
      await f.ledger.close();
    }
    expect(getterCalls).toBe(0);
  });

  test("wrong MCP tool-use anchor fails before admission or physical work", async () => {
    const f = await mcpFixture({
      resolvedAnchor: {
        throughChangeSeq: 4,
        entryIds: ["entry-other-tool-use"],
        digest: d("6"),
      },
    });
    await expect(
      f.gateway.dispatch(f.request, { arguments: {} }),
    ).rejects.toThrow();
    expect(f.counts()).toEqual({ admits: 0, executions: 0, resolverCalls: 1 });
    await f.ledger.close();
  });
});
