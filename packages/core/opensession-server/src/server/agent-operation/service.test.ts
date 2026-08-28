import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashAgentModelPayloadV1,
  hashAgentOperationDescriptorV1,
  type AgentOperationDigest,
} from "@tellahq/opensession-protocol/agent-operation";
import type { AgentHostSupervisionAuthorityV2 } from "@tellahq/opensession-protocol/agent-host";
import {
  AgentGatewayGrantRegistry,
  encodeAgentGatewayPolicyHandle,
} from "./grants";
import { AgentGatewayAmbiguousExecutionError } from "./gateway";
import { AgentOperationService, type AgentOperationPlan } from "./service";
import { SQLiteAgentOperationLedger } from "./sqlite-ledger";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const digest = (c: string) => `sha256:${c.repeat(64)}` as AgentOperationDigest;
const envelope = {
  version: 1, algorithm: "Ed25519", domain: "opensession.agent-host.supervision.v2",
  authorityBytes: "AQ", signature: Buffer.alloc(64).toString("base64url"),
} as const;
const payloadBytes = new TextEncoder().encode('{"prompt":"safe"}');
const descriptor = {
  version: 1, kind: "model", stepId: "step-1",
  transcript: { throughChangeSeq: 2, entryIds: ["entry-1"], digest: digest("c") },
  modelPolicyHash: digest("d"), adapterRequestVersion: "v1",
} as const;
const fence = { sessionId: "session-1", runId: "run-1", turnId: "turn-1", generation: 1 } as const;
const authority: AgentHostSupervisionAuthorityV2 = {
  version: 2, fence, planHash: digest("a"), hostId: "host-000000000001",
  hostGeneration: 1, hostIncarnation: "incarnation-0001", supervisorEpoch: 1,
  kernelServiceEpoch: "kernel-epoch-0001", hostChallenge: "challenge-00000001",
  audience: "opensession-agent-host", purpose: "agent-host-supervision",
  issuedAtMs: 1, expiresAtMs: 1_000_000, nonce: "nonce-000000000001",
  keyId: "key-0000000000001",
};

type Mode = "success" | "wait" | "unknown" | "ambiguous" | "cancel";
async function fixture(options: { dbPath?: string; mode?: Mode; recoveryGate?: Promise<void> } = {}) {
  const root = options.dbPath ? undefined : mkdtempSync(join(tmpdir(), "agent-service-"));
  if (root) roots.push(root);
  const dbPath = options.dbPath ?? join(root!, "ledger.sqlite");
  const ledger = new SQLiteAgentOperationLedger({ dbPath });
  let now = 10;
  let currentAuthorityHash = digest("b");
  let grantsIssued = 0, physical = 0, admits = 0, terminals = 0;
  let releasePhysical!: () => void;
  const physicalGate = new Promise<void>((resolve) => { releasePhysical = resolve; });
  const grants = new AgentGatewayGrantRegistry({
    now: () => now,
    entropy: () => `${String(++grantsIssued).padStart(43, "x")}`,
  });
  const descriptorDigest = await hashAgentOperationDescriptorV1(descriptor);
  const payloadDigest = await hashAgentModelPayloadV1(payloadBytes);
  const order: string[] = [];
  const service = new AgentOperationService({
    grants,
    gateway: {
      ledger,
      now: () => Date.now(),
      admission: {
        async admit() { admits++; order.push("admit"); return { accepted: true }; },
        async settle() { terminals++; order.push("actor-terminal"); },
        async indeterminate() { terminals++; order.push("actor-indeterminate"); },
      },
      adapterFor: () => ({
        id: "adapter-1", version: "1.0",
        async execute(_request, signal, sink) {
          physical++; order.push("physical");
          if (options.mode === "wait") await physicalGate;
          if (options.mode === "unknown") throw new Error("provider vanished");
          if (options.mode === "ambiguous")
            throw new AgentGatewayAmbiguousExecutionError("disconnect_ambiguous");
          if (options.mode === "cancel") {
            await new Promise<void>((resolve) => {
              const done = () => resolve();
              signal.addEventListener("abort", done, { once: true });
              if (signal.aborted) done();
            });
            return { outcome: { status: "cancelled" as const, code: "cancelled" }, transcript: {} };
          }
          await sink?.publish({ delta: "one" });
          return { outcome: { status: "succeeded" as const, outputDigest: digest("e") }, transcript: {} };
        },
      }),
      decodePayload: (kind, payload) => payload && kind === "model"
        ? { kind, value: payload, canonicalBytes: payloadBytes }
        : undefined,
      appendTerminal: async (_identity, result) => {
        order.push("append");
        const code = result.outcome.status === "cancelled" ? "cancelled" : "ok";
        const refs = [{ appendId: `append-${code}`, entryIds: ["entry-terminal"], firstSeq: 3, lastSeq: 3, throughChangeSeq: 3, requestDigest: digest("1") }];
        return { refs, kernelTerminal: { outputDigest: digest("e"), outcomeCode: code, transcriptRefs: refs, pendingToolUseEntryIds: [] } };
      },
      appendIndeterminateNotice: async (record, appendId) => {
        await options.recoveryGate;
        const refs = [{ appendId, entryIds: ["entry-indeterminate"], firstSeq: 3, lastSeq: 3, throughChangeSeq: 3, requestDigest: digest("2") }];
        return { outputDigest: digest("f"), outcomeCode: record.terminalReservation?.reason ?? "reconciliation_unsupported", transcriptRefs: refs, pendingToolUseEntryIds: [] };
      },
    },
    verifySupervision: async () => ({ authority, authorityHash: currentAuthorityHash }),
    authorizedReceiptReader: (query) => ledger.queryAuthorized(query),
    cancellation: {
      async request(identity) {
        order.push("cancel-persist");
        const record = await ledger.getExact(identity);
        return record && (record.receipt.state === "prepared" || record.receipt.state === "executing")
          ? "requested" : "too_late";
      },
    },
    closeTimeoutMs: 1,
    scheduleTimeout: (callback) => { let active = true; queueMicrotask(() => { if (active) callback(); }); return () => { active = false; }; },
  });
  const plan: AgentOperationPlan = {
    operationId: "operation-1", fence, kind: "model", descriptor, descriptorDigest,
    payload: { prompt: "safe" }, canonicalPayloadBytes: payloadBytes,
    transcriptAnchor: descriptor.transcript, adapterId: "adapter-1", adapterVersion: "1.0",
    deadlineMs: 500, policyHandle: encodeAgentGatewayPolicyHandle("policy00000000001"),
  };
  const dispatch = { operationId: plan.operationId, fence, kind: plan.kind, descriptorDigest,
    supervisionEnvelope: envelope, descriptor, deadlineMs: plan.deadlineMs } as const;
  const query = { operationId: plan.operationId, fence, kind: plan.kind, descriptorDigest,
    supervisionEnvelope: envelope, payloadDigest, descriptor, afterStreamSeq: 0, recovery: true } as const;
  return { service, ledger, plan, dispatch, query, grants,
    counts: () => ({ grantsIssued, physical, admits, terminals }), order,
    releasePhysical, dbPath, payloadDigest,
    setAuthorityHash: (value: AgentOperationDigest) => { currentAuthorityHash = value; },
  };
}
async function consumeOne(result: { chunks?: AsyncIterable<Uint8Array> | Iterable<Uint8Array> }) {
  const iterator = (result.chunks as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  const value = await iterator.next();
  return { iterator, text: new TextDecoder().decode(value.value) };
}

describe("AgentOperationService integration", () => {
  test("dispatches exactly once across repeated requests and returns executing before stream ACK", async () => {
    const f = await fixture();
    await f.service.start();
    await f.service.registerPlan(f.plan);
    const first = await f.service.dispatchOperation(f.dispatch, new AbortController().signal);
    expect(first.receipt.state).toBe("executing");
    const streamed = await consumeOne(first);
    expect(streamed.text).toContain('"delta":"one"');
    expect(f.counts()).toMatchObject({ grantsIssued: 1, physical: 1, admits: 1 });
    const repeatedPromise = f.service.dispatchOperation(f.dispatch, new AbortController().signal);
    await f.service.acknowledgeOperationStream({ ...f.dispatch, throughStreamSeq: 1 });
    const repeated = await repeatedPromise;
    expect(["executing", "settled"]).toContain(repeated.receipt.state);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settled = await f.service.queryOperation({ ...f.query, afterStreamSeq: 1 }, new AbortController().signal);
    expect(settled.receipt.state).toBe("settled");
    expect(f.counts()).toMatchObject({ grantsIssued: 1, physical: 1, admits: 1, terminals: 1 });
    expect(f.service.healthSnapshot().activeOperations).toBe(0);
    await f.service.close();
  });

  test("publication is ACK-gated before append and actor terminal", async () => {
    const f = await fixture();
    await f.service.start(); await f.service.registerPlan(f.plan);
    const receipt = await f.service.dispatchOperation(f.dispatch, new AbortController().signal);
    await consumeOne(receipt);
    expect(f.order).toEqual(["admit", "physical"]);
    await f.service.acknowledgeOperationStream({ ...f.dispatch, throughStreamSeq: 1 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await f.service.queryOperation({ ...f.query, afterStreamSeq: 1 }, new AbortController().signal);
    expect(f.order).toEqual(["admit", "physical", "append", "actor-terminal"]);
    await f.service.close();
  });

  test("settled receipt survives restart with a fresh registry and no bearer grant", async () => {
    const first = await fixture();
    await first.service.start(); await first.service.registerPlan(first.plan);
    const result = await first.service.dispatchOperation(first.dispatch, new AbortController().signal);
    await consumeOne(result);
    await first.service.acknowledgeOperationStream({ ...first.dispatch, throughStreamSeq: 1 });
    await first.service.queryOperation({ ...first.query, afterStreamSeq: 1 }, new AbortController().signal);
    await first.service.close();

    const second = await fixture({ dbPath: first.dbPath });
    await second.service.start(); await second.service.registerPlan(second.plan);
    const queried = await second.service.queryOperation(second.query, new AbortController().signal);
    expect(queried.receipt.state).toBe("settled");
    expect(second.grants.size).toBe(0);
    expect(second.counts().physical).toBe(0);
    await second.service.close();
  });

  test("wrong authority, payload digest, or descriptor gives zero new physical evidence", async () => {
    const f = await fixture();
    await f.service.start(); await f.service.registerPlan(f.plan);
    await expect(f.service.queryOperation({ ...f.query, payloadDigest: digest("9") }, new AbortController().signal)).rejects.toThrow("payload digest");
    const altered = { ...descriptor, stepId: "different" };
    await expect(f.service.queryOperation({ ...f.query, descriptor: altered }, new AbortController().signal)).rejects.toThrow("descriptor");
    expect(f.counts()).toEqual({ grantsIssued: 0, physical: 0, admits: 0, terminals: 0 });

    const running = await f.service.dispatchOperation(f.dispatch, new AbortController().signal);
    await consumeOne(running);
    await f.service.acknowledgeOperationStream({ ...f.dispatch, throughStreamSeq: 1 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.setAuthorityHash(digest("9"));
    await expect(f.service.queryOperation({ ...f.query, afterStreamSeq: 1 }, new AbortController().signal)).rejects.toThrow("operation not found");
    expect(f.counts().physical).toBe(1);
    f.setAuthorityHash(digest("b"));
    expect((await f.service.queryOperation({ ...f.query, afterStreamSeq: 1 }, new AbortController().signal)).receipt.state).toBe("settled");
    await f.service.close();
  });

  test("unknown execution error is observed as executing then recovered indeterminate", async () => {
    const first = await fixture({ mode: "unknown" });
    await first.service.start(); await first.service.registerPlan(first.plan);
    const executing = await first.service.dispatchOperation(first.dispatch, new AbortController().signal);
    expect(executing.receipt.state).toBe("executing");
    await Promise.resolve();
    await first.service.close();
    const second = await fixture({ dbPath: first.dbPath });
    await second.service.start(); await second.service.registerPlan(second.plan);
    const recovered = await second.service.queryOperation(second.query, new AbortController().signal);
    expect(recovered.receipt.state).toBe("indeterminate");
    await second.service.close();
  });

  test("persists cancellation before abort and returns the truthful cancelled terminal", async () => {
    const f = await fixture({ mode: "cancel" });
    await f.service.start(); await f.service.registerPlan(f.plan);
    const executing = await f.service.dispatchOperation(f.dispatch, new AbortController().signal);
    expect(executing.receipt.state).toBe("executing");
    const cancelled = await f.service.cancelOperation({ ...f.dispatch, cancelId: "cancel-1", reason: "user" }, new AbortController().signal);
    expect(cancelled.disposition).toBe("cancelled");
    expect(cancelled.receipt.state).toBe("settled");
    expect(f.order.indexOf("cancel-persist")).toBeLessThan(f.order.indexOf("append"));
    expect(f.service.healthSnapshot().activeOperations).toBe(0);
    await f.service.close();
  });

  test("prephysical cancellation is explicit and terminal cancellation is too late", async () => {
    const f = await fixture();
    await f.service.start(); await f.service.registerPlan(f.plan);
    await expect(f.service.cancelOperation({ ...f.dispatch, cancelId: "cancel-pre", reason: "user" }, new AbortController().signal)).rejects.toThrow("operation not found");
    const running = await f.service.dispatchOperation(f.dispatch, new AbortController().signal);
    await consumeOne(running);
    await f.service.acknowledgeOperationStream({ ...f.dispatch, throughStreamSeq: 1 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const late = await f.service.cancelOperation({ ...f.dispatch, cancelId: "cancel-late", reason: "user" }, new AbortController().signal);
    expect(late.disposition).toBe("too_late");
    expect(late.receipt.state).toBe("settled");
    await f.service.close();
  });

  test("startup recovery blocks readiness and does not hold actor admission during physical wait", async () => {
    const seed = await fixture({ mode: "unknown" });
    await seed.service.start(); await seed.service.registerPlan(seed.plan);
    await seed.service.dispatchOperation(seed.dispatch, new AbortController().signal);
    await Promise.resolve(); await seed.service.close();
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const recovering = await fixture({ dbPath: seed.dbPath, recoveryGate });
    const starting = recovering.service.start();
    await Promise.resolve();
    await expect(recovering.service.registerPlan(recovering.plan)).rejects.toThrow("not ready");
    releaseRecovery(); await starting; await recovering.service.close();

    const waiting = await fixture({ mode: "wait" });
    await waiting.service.start(); await waiting.service.registerPlan(waiting.plan);
    const receipt = await waiting.service.dispatchOperation(waiting.dispatch, new AbortController().signal);
    expect(receipt.receipt.state).toBe("executing");
    expect(waiting.counts().admits).toBe(1);
    waiting.releasePhysical(); await Promise.resolve();
    await waiting.service.close();

    const bounded = await fixture({ mode: "wait" });
    await bounded.service.start(); await bounded.service.registerPlan(bounded.plan);
    await bounded.service.dispatchOperation(bounded.dispatch, new AbortController().signal);
    await expect(bounded.service.close()).resolves.toBeUndefined();
  });

  test("bounds plans and bytes, rejects getters and Proxies, and preserves explicit immutable capability identity", async () => {
    const f = await fixture();
    await f.service.start();
    const getter = { ...f.plan } as any;
    Object.defineProperty(getter, "payload", { enumerable: true, get() { throw new Error("getter invoked"); } });
    await expect(f.service.registerPlan(getter)).rejects.toThrow("invalid operation plan");
    await expect(f.service.registerPlan(new Proxy(f.plan, {}))).rejects.toThrow("invalid operation plan");
    await expect(f.service.registerPlan({ ...f.plan, canonicalPayloadBytes: new Uint8Array(1024 * 1024 + 1) })).rejects.toThrow("canonical payload");
    const capability = Object.freeze({ token: Object.freeze({ ref: "private" }) });
    await f.service.registerPlan({ ...f.plan, payload: capability, retainPayloadIdentity: true });
    await expect(f.service.registerPlan({ ...f.plan, operationId: "operation-2", payload: { mutable: true }, retainPayloadIdentity: true })).rejects.toThrow("retained model capability");
    await f.service.deleteSession(fence.sessionId);
    expect(f.service.healthSnapshot().activeOperations).toBe(0);
    await f.service.close();
  });
});
