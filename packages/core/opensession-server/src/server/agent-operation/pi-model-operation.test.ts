import { describe, expect, test } from "bun:test";
import type { AgentOperationDigest } from "@tellahq/opensession-protocol/agent-operation";
import {
  MAX_PI_MODEL_EVENT_PAYLOAD_BYTES,
  MAX_PI_MODEL_INVOCATION_BYTES,
  PiModelEventChainDecoder,
  PiModelInvocationRegistry,
  decodePiModelEventV1,
  decodePiModelGatewayPayload,
  decodePiModelOperationReferenceV1,
  encodePiModelEventV1,
  hashPiModelInvocationV1,
} from "./pi-model-operation";

const digest = (char: string) => `sha256:${char.repeat(64)}` as AgentOperationDigest;
const ref = (char: number) => Buffer.alloc(32, char).toString("base64url");
const fence = Object.freeze({
  sessionId: "session-1",
  runId: "run-1",
  turnId: "turn-1",
  generation: 2,
});
const invocation = Object.freeze({
  prompt: "private prompt sentinel",
  messages: Object.freeze([Object.freeze({ role: "user", content: "secret sentinel" })]),
  tools: Object.freeze([]),
  options: Object.freeze({ apiKey: "private credential sentinel" }),
});

function input(overrides: Record<string, unknown> = {}) {
  return {
    fence,
    operationId: "operation-1",
    bindingRef: ref(1),
    invocationRef: ref(2),
    descriptorDigest: digest("a"),
    invocation,
    canonicalBytes: new TextEncoder().encode(JSON.stringify(invocation)),
    deadlineMs: 2_000,
    ...overrides,
  } as any;
}

function lookup(reference: { invocationDigest: AgentOperationDigest }, overrides: Record<string, unknown> = {}) {
  return {
    fence,
    operationId: "operation-1",
    bindingRef: ref(1),
    invocationRef: ref(2),
    descriptorDigest: digest("a"),
    invocationDigest: reference.invocationDigest,
    ...overrides,
  } as any;
}

describe("Pi model invocation reference and registry", () => {
  test("every full invocation byte participates in the domain-separated digest", () => {
    const original = new Uint8Array([0, 1, 2, 3]);
    const expected = hashPiModelInvocationV1(original);
    for (let index = 0; index < original.length; index++) {
      const changed = original.slice();
      changed[index] ^= 1;
      expect(hashPiModelInvocationV1(changed)).not.toBe(expected);
    }
    expect(() => hashPiModelInvocationV1(new Uint8Array(MAX_PI_MODEL_INVOCATION_BYTES + 1))).toThrow("byte limit");
  });

  test("peek is non-consuming and consume is exactly once", () => {
    const registry = new PiModelInvocationRegistry({ now: () => 1_000 });
    const owner = registry.register(input());
    expect(registry.peekForDecode(lookup(owner.reference))?.invocation).toBe(invocation);
    expect(registry.peekForDecode(lookup(owner.reference))?.invocation).toBe(invocation);
    expect(registry.consumeExact(lookup(owner.reference))?.invocation).toBe(invocation);
    expect(registry.consumeExact(lookup(owner.reference))).toBeUndefined();
    expect(owner.close()).toBe(false);
    expect(owner.close()).toBe(false);
  });

  test("tamper, cross-fence, cross-binding, descriptor mismatch, and expiry fail", () => {
    let now = 1_000;
    const registry = new PiModelInvocationRegistry({ now: () => now });
    const a = registry.register(input());
    expect(registry.peekForDecode(lookup(a.reference, { invocationDigest: digest("b") }))).toBeUndefined();
    expect(registry.peekForDecode(lookup(a.reference, { bindingRef: ref(3) }))).toBeUndefined();
    expect(registry.peekForDecode(lookup(a.reference, { descriptorDigest: digest("b") }))).toBeUndefined();
    expect(registry.peekForDecode(lookup(a.reference, { fence: Object.freeze({ ...fence, generation: 3 }) }))).toBeUndefined();
    now = 2_000;
    expect(registry.peekForDecode(lookup(a.reference))).toBeUndefined();
    expect(registry.deleteExpired()).toBe(0);
  });

  test("registration is bounded, cannot replace identity, and owner close is scoped", () => {
    const registry = new PiModelInvocationRegistry({ now: () => 1_000, capacity: 2 });
    const owner = registry.register(input());
    expect(() => registry.register(input())).toThrow("already registered");
    const secondOwner = registry.register(input({ invocationRef: ref(4) }));
    expect(() => registry.register(input({ invocationRef: ref(5) }))).toThrow("full");
    expect(owner.close()).toBe(true);
    expect(() => registry.register(input())).toThrow("already registered");
    expect(() => registry.register(input({ invocationRef: ref(5) }))).toThrow("full");
    expect(owner.close()).toBe(false);
    expect(registry.peekForDecode(lookup(secondOwner.reference, { invocationRef: ref(4) }))).toBeDefined();
  });

  test("strict decoding rejects getters, prototypes, and extra keys without registry access", () => {
    const valid = {
      version: 1 as const,
      bindingRef: ref(1),
      invocationRef: ref(2),
      invocationDigest: digest("a"),
    };
    expect(decodePiModelOperationReferenceV1(valid)).toEqual(valid);
    expect(decodePiModelOperationReferenceV1({ ...valid, prompt: "leak" })).toBeUndefined();
    expect(decodePiModelOperationReferenceV1(Object.assign(Object.create({}), valid))).toBeUndefined();
    expect(decodePiModelOperationReferenceV1(Object.assign(Object.create(null), valid))).toBeUndefined();
    let getterReads = 0;
    const getter = { ...valid } as any;
    Object.defineProperty(getter, "bindingRef", { enumerable: true, get() { getterReads++; return ref(1); } });
    expect(decodePiModelOperationReferenceV1(getter)).toBeUndefined();
    expect(getterReads).toBe(0);

    let accesses = 0;
    const registry = new Proxy({ consumeExact() { accesses++; } }, { get(target, key) { accesses++; return (target as any)[key]; } });
    expect(decodePiModelGatewayPayload(registry as any, {
      fence, operationId: "operation-1", bindingRef: ref(1), descriptorDigest: digest("a"),
    }, getter)).toBeUndefined();
    expect(accesses).toBe(0);
  });

  test("gateway helper returns full canonical bytes, not reference bytes", () => {
    const registry = new PiModelInvocationRegistry({ now: () => 1_000 });
    const owner = registry.register(input());
    const decoded = decodePiModelGatewayPayload(registry, {
      fence, operationId: "operation-1", bindingRef: ref(1), descriptorDigest: digest("a"),
    }, owner.reference);
    expect(decoded?.kind).toBe("model");
    const adapterPayload = decoded!.value as any;
    expect(adapterPayload.invocation).toBe(invocation);
    expect((decoded as any).retainValueIdentity).toBe(true);
    expect(Buffer.from(decoded!.canonicalBytes)).toEqual(Buffer.from(input().canonicalBytes));
    expect(Buffer.from(decoded!.canonicalBytes).equals(Buffer.from(JSON.stringify(owner.reference)))).toBe(false);
    expect(decodePiModelGatewayPayload(registry, {
      fence, operationId: "operation-1", bindingRef: ref(1), descriptorDigest: digest("a"),
    }, owner.reference)?.value).toBe(adapterPayload);
    expect(registry.consumeExact(lookup(owner.reference))?.invocation).toBe(invocation);
    expect(registry.consumeExact(lookup(owner.reference))).toBeUndefined();
  });

  test("refs and diagnostics contain no invocation or provider material", () => {
    const registry = new PiModelInvocationRegistry({ now: () => 1_000 });
    const owner = registry.register(input());
    const visible = JSON.stringify(owner.reference);
    for (const secret of ["private prompt", "secret sentinel", "credential", "apiKey", "provider"])
      expect(visible).not.toContain(secret);
    for (const bad of [
      input({ bindingRef: "private prompt sentinel" }),
      input({ canonicalBytes: new Uint8Array(MAX_PI_MODEL_INVOCATION_BYTES + 1) }),
      input({ deadlineMs: 999 }),
    ]) {
      let message = "";
      try { registry.register(bad); } catch (error) { message = String(error); }
      expect(message).not.toContain("private prompt sentinel");
      expect(message).not.toContain("credential sentinel");
    }
  });
});

describe("Pi live model event codec", () => {
  test("enforces the 48 KiB boundary and canonical Base64URL", () => {
    const boundary = new Uint8Array(MAX_PI_MODEL_EVENT_PAYLOAD_BYTES).fill(255);
    const envelope = encodePiModelEventV1({ operationId: "operation-1", eventSeq: 0, previousDigest: null, payload: boundary });
    expect(envelope.payload).not.toContain("=");
    expect(decodePiModelEventV1(envelope)?.payloadBytes).toEqual(boundary);
    expect(() => encodePiModelEventV1({ operationId: "operation-1", eventSeq: 0, previousDigest: null, payload: new Uint8Array(MAX_PI_MODEL_EVENT_PAYLOAD_BYTES + 1) })).toThrow("byte limit");
    expect(decodePiModelEventV1({ ...envelope, payload: `${envelope.payload}=` })).toBeUndefined();
  });

  test("rejects sequence, predecessor, payload digest, and event digest tampering", () => {
    const first = encodePiModelEventV1({ operationId: "operation-1", eventSeq: 0, previousDigest: null, payload: new Uint8Array([1]) });
    const second = encodePiModelEventV1({ operationId: "operation-1", eventSeq: 1, previousDigest: first.eventDigest, payload: new Uint8Array([2]) });
    const chain = new PiModelEventChainDecoder("operation-1");
    expect(chain.decode(second)).toBeUndefined();
    expect(chain.decode(first)).toBeDefined();
    expect(chain.decode({ ...second, previousDigest: digest("c") })).toBeUndefined();
    expect(chain.decode({ ...second, payloadDigest: digest("d") })).toBeUndefined();
    expect(chain.decode({ ...second, eventDigest: digest("e") })).toBeUndefined();
    expect(chain.decode(second)).toBeDefined();
    expect(chain.decode(second)).toBeUndefined();
  });

  test("envelope carries no raw provider metadata", () => {
    const envelope = encodePiModelEventV1({ operationId: "operation-1", eventSeq: 0, previousDigest: null, payload: new TextEncoder().encode("opaque") });
    expect(Object.keys(envelope).sort()).toEqual([
      "eventDigest", "eventSeq", "operationId", "payload", "payloadDigest", "previousDigest", "version",
    ]);
    for (const key of ["provider", "model", "headers", "configuration", "apiKey", "prompt"])
      expect(JSON.stringify(envelope)).not.toContain(key);
  });
});
