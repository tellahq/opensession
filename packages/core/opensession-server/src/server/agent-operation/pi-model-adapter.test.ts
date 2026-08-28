import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashAgentModelPayloadV1,
  hashAgentOperationDescriptorV1,
  type AgentOperationDigest,
  type AgentOperationRequestV1,
} from "@tellahq/opensession-protocol/agent-operation";
import type { AgentHostSupervisionAuthorityV2 } from "@tellahq/opensession-protocol/agent-host";
import type { PiRuntimeBinding } from "../pi-runtime-binding";
import {
  PI_MODEL_AGENT_OPERATION_ADAPTER_ID,
  PI_MODEL_AGENT_OPERATION_ADAPTER_VERSION,
  PI_MODEL_AGENT_OPERATION_RECONCILER,
  PI_MODEL_AGENT_OPERATION_REQUEST_VERSION,
  PiRuntimeBindingRegistry,
  createPiModelAgentOperationAdapter,
} from "./pi-model-adapter";
import { AgentGatewayGrantRegistry, encodeAgentGatewayPolicyHandle } from "./grants";
import { AgentOperationGateway } from "./gateway";
import { SQLiteAgentOperationLedger } from "./sqlite-ledger";
import {
  PiModelEventChainDecoder,
  PiModelInvocationRegistry,
  decodePiModelGatewayPayload,
} from "./pi-model-operation";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const d = (c: string) => `sha256:${c.repeat(64)}` as AgentOperationDigest;
const ref = (n: number) => Buffer.alloc(32, n).toString("base64url");
const fence = Object.freeze({ sessionId: "session-1", runId: "run-1", turnId: "turn-1", generation: 1 });
const invocation = Object.freeze({ messages: Object.freeze([Object.freeze({ role: "user", content: "private prompt" })]) });
const descriptor = Object.freeze({
  version: 1 as const,
  kind: "model" as const,
  stepId: "step-1",
  transcript: Object.freeze({ throughChangeSeq: 1, entryIds: Object.freeze(["entry-1"]), digest: d("c") }),
  modelPolicyHash: d("d"),
  adapterRequestVersion: PI_MODEL_AGENT_OPERATION_REQUEST_VERSION,
});
const identity = Object.freeze({
  operationId: "operation-1",
  kind: "model" as const,
  fence,
  planHash: d("a"),
  authorityHash: d("b"),
  supervisorEpoch: 1,
  hostId: "host-1",
  hostGeneration: 1,
  hostIncarnation: "incarnation-1",
  transcriptAnchor: descriptor.transcript,
  descriptor,
  descriptorDigest: d("e"),
  payloadDigest: d("f"),
  adapterId: PI_MODEL_AGENT_OPERATION_ADAPTER_ID,
  adapterVersion: PI_MODEL_AGENT_OPERATION_ADAPTER_VERSION,
});

function binding(): PiRuntimeBinding {
  return { model: { provider: "anthropic", id: "claude-test" } } as PiRuntimeBinding;
}

function setup(options: { executor?: (input: any) => Promise<any>; bind?: boolean } = {}) {
  const invocations = new PiModelInvocationRegistry({ now: () => 1_000 });
  const owner = invocations.register({
    fence,
    operationId: identity.operationId,
    bindingRef: ref(1),
    invocationRef: ref(2),
    descriptorDigest: identity.descriptorDigest,
    invocation,
    canonicalBytes: new TextEncoder().encode(JSON.stringify(invocation)),
    deadlineMs: 2_000,
  });
  const decoded = decodePiModelGatewayPayload(invocations, {
    fence,
    operationId: identity.operationId,
    bindingRef: ref(1),
    descriptorDigest: identity.descriptorDigest,
  }, owner.reference)!;
  const bindings = new PiRuntimeBindingRegistry();
  const runtimeBinding = binding();
  const bindingOwner = options.bind === false ? undefined : bindings.register({
    fence,
    bindingRef: ref(1),
    binding: runtimeBinding,
    descriptorDigest: identity.descriptorDigest,
    modelPolicyHash: descriptor.modelPolicyHash,
    modelIdentity: { provider: "anthropic", id: "claude-test" },
  });
  let calls = 0;
  const executor = {
    async execute(input: any) {
      calls++;
      return options.executor?.(input) ?? {
        outcome: Object.freeze({ status: "succeeded", code: "ok" }),
        transcript: Object.freeze({ text: "ephemeral response" }),
        providerRequestRef: "request-opaque",
        providerResponseRef: "response-opaque",
      };
    },
  };
  const adapter = createPiModelAgentOperationAdapter(bindings, invocations, executor);
  const events: unknown[] = [];
  const sink = {
    async publish(event: unknown) { events.push(event); },
    async close() {},
    async fail() {},
  };
  return { adapter, decoded, owner, bindingOwner, runtimeBinding, events, sink, calls: () => calls, invocations };
}

function request(payload: unknown, overrides: Record<string, unknown> = {}) {
  return Object.freeze({ identity: Object.freeze({ ...identity, ...overrides }) as any, payload });
}

async function gatewayHarness(options: {
  executor?: (input: any) => Promise<any>;
  forgedGrant?: boolean;
  publish?: (event: unknown) => Promise<void>;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-model-gateway-"));
  roots.push(root);
  const ledger = new SQLiteAgentOperationLedger({ dbPath: join(root, "ledger.sqlite") });
  let now = 10;
  const grants = new AgentGatewayGrantRegistry({ now: () => now, entropy: () => "g".repeat(43) });
  const descriptorDigest = await hashAgentOperationDescriptorV1(descriptor);
  const canonicalBytes = new TextEncoder().encode(JSON.stringify(invocation));
  const payloadDigest = await hashAgentModelPayloadV1(canonicalBytes);
  const authority: AgentHostSupervisionAuthorityV2 = {
    version: 2,
    fence,
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
    expiresAtMs: 1_000,
    nonce: "nonce-000000000001",
    keyId: "key-0000000000001",
  };
  const invocationRegistry = new PiModelInvocationRegistry({ now: () => now });
  const invocationOwner = invocationRegistry.register({
    fence,
    operationId: identity.operationId,
    bindingRef: ref(1),
    invocationRef: ref(2),
    descriptorDigest,
    invocation,
    canonicalBytes,
    deadlineMs: 900,
  });
  const bindingRegistry = new PiRuntimeBindingRegistry();
  bindingRegistry.register({
    fence,
    bindingRef: ref(1),
    binding: binding(),
    descriptorDigest,
    modelPolicyHash: descriptor.modelPolicyHash,
    modelIdentity: { provider: "anthropic", id: "claude-test" },
  });
  let calls = 0;
  const adapter = createPiModelAgentOperationAdapter(bindingRegistry, invocationRegistry, {
    async execute(input) {
      calls++;
      return options.executor?.(input) ?? { outcome: { status: "succeeded", code: "ok" }, transcript: { text: "ephemeral" } };
    },
  });
  const grant = grants.issue({
    operationId: identity.operationId,
    kind: "model",
    fence,
    planHash: d("a"),
    authorityHash: d("b"),
    supervisorEpoch: 1,
    hostId: authority.hostId,
    hostGeneration: 1,
    hostIncarnation: authority.hostIncarnation,
    descriptorDigest,
    payloadDigest,
    transcriptAnchor: descriptor.transcript,
    adapterId: adapter.id,
    adapterVersion: options.forgedGrant ? "forged" : adapter.version,
    deadlineMs: 800,
    authorityExpiresAtMs: 900,
    policyHandle: encodeAgentGatewayPolicyHandle("policy00000000001"),
  });
  const requestValue: AgentOperationRequestV1 = {
    version: 1,
    operationId: identity.operationId,
    kind: "model",
    fence,
    supervisionEnvelope: {
      version: 1,
      algorithm: "Ed25519",
      domain: "opensession.agent-host.supervision.v2",
      authorityBytes: "AQ",
      signature: Buffer.alloc(64).toString("base64url"),
    },
    dispatchGrant: grant,
    descriptor,
    descriptorDigest,
  };
  const events: unknown[] = [];
  const terminal = (appendId: string, outputDigest: AgentOperationDigest, outcomeCode: string) => {
    const refs = [{
      appendId,
      entryIds: [`entry-${appendId}`],
      firstSeq: 3,
      lastSeq: 3,
      throughChangeSeq: 3,
      requestDigest: d("1"),
    }];
    return { refs, kernelTerminal: { outputDigest, outcomeCode, transcriptRefs: refs, pendingToolUseEntryIds: [] } };
  };
  const gateway = new AgentOperationGateway({
    ledger,
    grants,
    now: () => ++now,
    verifySupervision: async () => ({ authority, authorityHash: d("b") }),
    admission: { async admit() { return { accepted: true }; }, async settle() {}, async indeterminate() {} },
    adapterFor: () => adapter,
    decodePayload: (kind, payload) => kind === "model" ? decodePiModelGatewayPayload(invocationRegistry, { fence, operationId: identity.operationId, bindingRef: ref(1), descriptorDigest }, payload) : undefined,
    beginLiveExecution: async () => ({
      async publish(event) { events.push(event); await options.publish?.(event); },
      async close() {},
      async fail() {},
    }),
    appendTerminal: async () => terminal("pi-terminal", d("7"), "ok"),
    appendIndeterminateNotice: async (record, appendId) => terminal(appendId, d("8"), record.terminalReservation?.reason ?? "reconciliation_unsupported").kernelTerminal,
  });
  return { gateway, request: requestValue, reference: invocationOwner.reference, invocationRegistry, calls: () => calls, events };
}

describe("Pi runtime binding ownership", () => {
  test("is exact by fence and binding ref, cannot replace, and only owner unregisters", () => {
    const registry = new PiRuntimeBindingRegistry();
    const value = binding();
    const input = { fence, bindingRef: ref(1), binding: value, descriptorDigest: d("e"), modelPolicyHash: d("d"), modelIdentity: { provider: "anthropic", id: "claude-test" } } as const;
    const owner = registry.register(input);
    expect(registry.get(fence, ref(1))?.binding).toBe(value);
    expect(registry.get({ ...fence, generation: 2 }, ref(1))).toBeUndefined();
    expect(registry.get(fence, ref(2))).toBeUndefined();
    expect(() => registry.register(input)).toThrow("already registered");
    expect(owner.close()).toBe(true);
    expect(owner.close()).toBe(false);
    expect(registry.get(fence, ref(1))).toBeUndefined();
    expect(() => registry.register(input)).toThrow("already registered");
  });

  test("rejects a binding whose selected model identity differs", () => {
    const registry = new PiRuntimeBindingRegistry();
    expect(() => registry.register({ fence, bindingRef: ref(1), binding: binding(), descriptorDigest: d("e"), modelPolicyHash: d("d"), modelIdentity: { provider: "openai", id: "other" } })).toThrow("model identity mismatch");
  });
});

describe("Pi model operation adapter", () => {
  test("real gateway leaves invocation intact for a forged grant, then consumes once on exact authorized dispatch", async () => {
    const forged = await gatewayHarness({ forgedGrant: true });
    await expect(forged.gateway.dispatch(forged.request, forged.reference)).rejects.toThrow("identity_mismatch");
    expect(forged.calls()).toBe(0);
    const decoded = decodePiModelGatewayPayload(forged.invocationRegistry, {
      fence,
      operationId: identity.operationId,
      bindingRef: ref(1),
      descriptorDigest: forged.request.descriptorDigest,
    }, forged.reference);
    expect(decoded).toBeDefined();

    const live = await gatewayHarness({ executor: async ({ invocation: seen, publish }) => {
      expect(seen).toBe(invocation);
      await publish(new Uint8Array([1]));
      await publish(new Uint8Array([2]));
      return { outcome: { status: "succeeded", code: "ok" }, transcript: { text: "ephemeral" } };
    } });
    const settled = await live.gateway.dispatch(live.request, live.reference);
    expect(settled.receipt.state).toBe("settled");
    expect(live.calls()).toBe(1);
    const replay = await live.gateway.dispatch(live.request, live.reference);
    expect(replay.receipt.state).toBe("settled");
    expect(live.calls()).toBe(1);
    const chain = new PiModelEventChainDecoder(identity.operationId);
    expect(chain.decode(live.events[0])?.payloadBytes).toEqual(new Uint8Array([1]));
    expect(chain.decode(live.events[1])?.payloadBytes).toEqual(new Uint8Array([2]));
  });

  test("real gateway immediately settles mid-call cancellation and stream loss as indeterminate", async () => {
    let started!: () => void;
    const physicalStarted = new Promise<void>((resolve) => { started = resolve; });
    const cancelled = await gatewayHarness({ executor: async () => {
      started();
      return new Promise(() => undefined);
    } });
    const controller = new AbortController();
    const pendingCancellation = cancelled.gateway.dispatch(cancelled.request, cancelled.reference, controller.signal);
    await physicalStarted;
    controller.abort();
    const cancelledRecord = await pendingCancellation;
    expect(cancelledRecord.receipt.state).toBe("indeterminate");
    expect(cancelledRecord.receipt.errorCode).toBe("cancellation_ambiguous");
    expect(cancelled.calls()).toBe(1);

    const stream = await gatewayHarness({
      executor: async ({ publish }) => {
        await publish(new Uint8Array([1]));
        return { outcome: { status: "succeeded", code: "ok" }, transcript: {} };
      },
      publish: async () => { throw new Error("transport closed"); },
    });
    const streamRecord = await stream.gateway.dispatch(stream.request, stream.reference);
    expect(streamRecord.receipt.state).toBe("indeterminate");
    expect(streamRecord.receipt.errorCode).toBe("disconnect_ambiguous");
    expect(stream.calls()).toBe(1);
  });

  test("consumes once, calls once, preserves private references, and publishes ordered events with backpressure", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let secondPublishStarted = false;
    const h = setup({ executor: async ({ binding: seenBinding, invocation: seenInvocation, publish }) => {
      expect(seenBinding).toBe(h.runtimeBinding);
      expect(seenInvocation).toBe(invocation);
      await publish(new Uint8Array([1]));
      secondPublishStarted = true;
      await publish(new Uint8Array([2]));
      return { outcome: { status: "succeeded", code: "ok" }, transcript: { text: "ephemeral" } };
    } });
    let publishes = 0;
    h.sink.publish = async (event: unknown) => {
      h.events.push(event);
      publishes++;
      if (publishes === 1) await gate;
    };
    const pending = h.adapter.execute(request(h.decoded.value), new AbortController().signal, h.sink);
    await Promise.resolve();
    expect(secondPublishStarted).toBe(false);
    release();
    const result = await pending;
    expect(result.outcome.status).toBe("succeeded");
    expect(h.calls()).toBe(1);
    expect(secondPublishStarted).toBe(true);
    const chain = new PiModelEventChainDecoder(identity.operationId);
    expect(chain.decode(h.events[0])?.payloadBytes).toEqual(new Uint8Array([1]));
    expect(chain.decode(h.events[1])?.payloadBytes).toEqual(new Uint8Array([2]));
    const replay = await h.adapter.execute(request(h.decoded.value), new AbortController().signal, h.sink);
    expect(replay.outcome.status).toBe("failed");
    expect(h.calls()).toBe(1);
  });

  test("serializes concurrent publishes and drains them when executor returns early", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const h = setup({ executor: async ({ publish }) => {
      void publish(new Uint8Array([1]));
      void publish(new Uint8Array([2]));
      return { outcome: { status: "succeeded", code: "ok" }, transcript: {} };
    } });
    let active = 0;
    let maxActive = 0;
    h.sink.publish = async (event: unknown) => {
      active++;
      maxActive = Math.max(maxActive, active);
      h.events.push(event);
      if (h.events.length === 1) await firstGate;
      active--;
    };
    let settled = false;
    const pending = h.adapter.execute(request(h.decoded.value), new AbortController().signal, h.sink).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.events).toHaveLength(1);
    releaseFirst();
    expect((await pending).outcome.status).toBe("succeeded");
    expect(maxActive).toBe(1);
    const chain = new PiModelEventChainDecoder(identity.operationId);
    expect(chain.decode(h.events[0])?.payloadBytes).toEqual(new Uint8Array([1]));
    expect(chain.decode(h.events[1])?.payloadBytes).toEqual(new Uint8Array([2]));
  });

  test("propagates an unawaited queued publish failure as ambiguous", async () => {
    const h = setup({ executor: async ({ publish }) => {
      void publish(new Uint8Array([1]));
      return { outcome: { status: "succeeded", code: "ok" }, transcript: {} };
    } });
    h.sink.publish = async () => { throw new Error("stream failed"); };
    await expect(h.adapter.execute(request(h.decoded.value), new AbortController().signal, h.sink)).rejects.toMatchObject({ reason: "disconnect_ambiguous" });
    expect(h.calls()).toBe(1);
  });

  test("closes the abort race between the initial check and listener installation", async () => {
    const h = setup();
    let reads = 0;
    const racingSignal = {
      get aborted() { reads++; return false; },
      addEventListener(_type: string, listener: () => void) { listener(); },
      removeEventListener() {},
    } as unknown as AbortSignal;
    const result = await h.adapter.execute(request(h.decoded.value), racingSignal, h.sink);
    expect(result.outcome.status).toBe("cancelled");
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(h.calls()).toBe(0);
    expect(h.invocations.peekForDecode((h.decoded.value as any).identity)).toBeDefined();
  });

  test("pre-abort, missing sink, and missing binding make zero physical calls without consuming", async () => {
    for (const mode of ["abort", "sink", "binding"] as const) {
      const h = setup({ bind: mode !== "binding" });
      const controller = new AbortController();
      if (mode === "abort") controller.abort();
      const result = await h.adapter.execute(request(h.decoded.value), controller.signal, mode === "sink" ? undefined : h.sink);
      expect(result.outcome.status).toBe(mode === "abort" ? "cancelled" : "failed");
      expect(h.calls()).toBe(0);
      expect(h.invocations.peekForDecode((h.decoded.value as any).identity)).toBeDefined();
    }
  });

  test("cross-fence, binding, descriptor, request version, and accessors make zero calls", async () => {
    const mutations = [
      { identity: { ...identity, fence: { ...fence, generation: 2 } }, payload: undefined },
      { identity, payload: Object.freeze({ ...(setup().decoded.value as any), identity: Object.freeze({ ...(setup().decoded.value as any).identity, bindingRef: ref(3) }) }) },
      { identity: { ...identity, descriptorDigest: d("9") }, payload: undefined },
      { identity: { ...identity, descriptor: Object.freeze({ ...descriptor, adapterRequestVersion: "v2" }) }, payload: undefined },
    ];
    for (const mutation of mutations) {
      const h = setup();
      const result = await h.adapter.execute(request(mutation.payload ?? h.decoded.value, mutation.identity as any), new AbortController().signal, h.sink);
      expect(result.outcome.status).toBe("failed");
      expect(h.calls()).toBe(0);
    }
    const h = setup();
    let reads = 0;
    const evil = {} as any;
    Object.defineProperties(evil, {
      version: { enumerable: true, get() { reads++; return 1; } },
      identity: { enumerable: true, value: (h.decoded.value as any).identity },
      invocation: { enumerable: true, value: invocation },
    });
    const result = await h.adapter.execute(request(evil), new AbortController().signal, h.sink);
    expect(result.outcome.status).toBe("failed");
    expect(reads).toBe(0);
    expect(h.calls()).toBe(0);
  });

  test("mid-call cancellation, stream failure, timeout, and unknown loss are typed ambiguous", async () => {
    const cases = [
      { error: new DOMException("aborted", "AbortError"), reason: "cancellation_ambiguous" },
      { error: new Error("deadline timed out"), reason: "timeout_ambiguous" },
      { error: new Error("provider vanished"), reason: "disconnect_ambiguous" },
    ] as const;
    for (const item of cases) {
      const h = setup({ executor: async () => { throw item.error; } });
      await expect(h.adapter.execute(request(h.decoded.value), new AbortController().signal, h.sink)).rejects.toMatchObject({ reason: item.reason });
      expect(h.calls()).toBe(1);
    }
    const h = setup({ executor: async ({ publish }) => { await publish(new Uint8Array([1])); throw new Error("unreachable"); } });
    h.sink.publish = async () => { throw new Error("stream closed"); };
    await expect(h.adapter.execute(request(h.decoded.value), new AbortController().signal, h.sink)).rejects.toMatchObject({ reason: "disconnect_ambiguous" });
    expect(h.calls()).toBe(1);
  });

  test("reconciliation is explicitly unsupported and diagnostics expose no private material", async () => {
    await expect(PI_MODEL_AGENT_OPERATION_RECONCILER.reconcile(identity as any)).resolves.toEqual({ status: "indeterminate", reason: "reconciliation_unsupported" });
    const h = setup();
    const visible = JSON.stringify(h.owner.reference) + JSON.stringify({ id: h.adapter.id, version: h.adapter.version });
    for (const secret of ["private prompt", "messages", "apiKey", "provider", "claude-test"]) expect(visible).not.toContain(secret);
  });
});
