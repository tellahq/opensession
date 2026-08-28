import { describe, expect, test } from "bun:test";
import type { AgentOperationKernelTerminalV1 } from "@tellahq/opensession-protocol/agent-operation";
import {
  SessionKernelActorError,
  SessionKernelQuarantinedError,
} from "../session-kernel/actor-client";
import type {
  AgentOperationIdentity as ActorIdentity,
  AgentOperationReceipt,
  AgentOperationRequest,
} from "../session-kernel/agent-operation-protocol";
import type { AgentOperationIdentity } from "./ledger";
import {
  AgentOperationKernelEvidenceError,
  AgentOperationKernelFacade,
  AgentOperationKernelQuarantinedError,
  AgentOperationKernelRejectedError,
  AgentOperationKernelTransportError,
  createAgentOperationKernelFacades,
} from "./kernel-facade";

const d = (c: string) => `sha256:${c.repeat(64)}` as const;
const anchor = {
  throughChangeSeq: 7,
  digest: d("a"),
  entryIds: ["input-1", "input-2"],
} as const;
const descriptor = {
  version: 1,
  kind: "model",
  stepId: "step-1",
  transcript: anchor,
  modelPolicyHash: d("b"),
  adapterRequestVersion: "v1",
} as const;

function identity(kind: "model" | "mcp" = "model"): AgentOperationIdentity {
  return {
    operationId: `operation-${kind}`,
    kind,
    fence: { sessionId: "session-1", runId: "run-1", turnId: "turn-1", generation: 3 },
    planHash: d("c"),
    authorityHash: d("d"),
    supervisorEpoch: 4,
    hostId: "host-1",
    hostGeneration: 5,
    hostIncarnation: "host-incarnation-1",
    transcriptAnchor: anchor,
    ...(kind === "mcp" ? { toolUseEntryId: "tool-use-1" } : {}),
    descriptor: kind === "model" ? descriptor : {
      version: 1,
      kind: "mcp",
      serverId: "server-1",
      toolName: "tool-1",
      toolUseEntryId: "tool-use-1",
      argumentsDigest: d("e"),
      adapterRequestVersion: "v1",
    },
    descriptorDigest: d("f"),
    payloadDigest: d("1"),
    adapterId: "adapter-1",
    adapterVersion: "2.3.4",
  } as AgentOperationIdentity;
}

function admitted(id: ActorIdentity): AgentOperationReceipt {
  return { identity: id, sequence: 9, state: "admitted", admittedAtMs: 100 };
}
const refs = [{
  appendId: "append-1",
  entryIds: ["output-1", "pending-1", "pending-2"],
  firstSeq: 10,
  lastSeq: 12,
  throughChangeSeq: 12,
  requestDigest: d("2"),
}] as const;
function terminal(kind: "model" | "mcp" = "model"): AgentOperationKernelTerminalV1 {
  const transcriptRefs = kind === "model" ? refs : [{ ...refs[0], entryIds: ["output-1"], lastSeq: 10 }];
  return {
    outputDigest: d("3"),
    outcomeCode: "ok",
    transcriptRefs,
    ...(kind === "model" ? { pendingToolUseEntryIds: ["pending-1", "pending-2"] } : {}),
  };
}
function terminalReceipt(request: Extract<AgentOperationRequest, { op: "settle" | "indeterminate" }>): AgentOperationReceipt {
  return {
    identity: request.identity,
    sequence: 10,
    state: request.op === "settle" ? "settled" : "indeterminate",
    admittedAtMs: 100,
    terminalAtMs: 200,
    gatewayReceiptDigest: request.gatewayReceiptDigest,
    outputDigest: request.outputDigest,
    outcomeCode: request.outcomeCode,
    transcriptReceipts: request.transcriptReceipts,
    ...(request.identity.kind === "model" ? { pendingToolUseEntryIds: request.pendingToolUseEntryIds! } : {}),
  };
}

type Handler = (request: AgentOperationRequest) => unknown | Promise<unknown>;
function facade(handler: Handler) {
  return new AgentOperationKernelFacade({ decideAgentOperationAsync: handler } as any);
}

describe("AgentOperationKernelFacade", () => {
  test("maps every model identity field and admits exact replay", async () => {
    const seen: AgentOperationRequest[] = [];
    const subject = facade((request) => {
      seen.push(request);
      return { accepted: true, replayed: seen.length > 1, receipt: admitted(request.identity) };
    });
    const expected = {
      sessionId: "session-1", runId: "run-1", turnId: "turn-1", generation: 3,
      operationId: "operation-model", kind: "model", descriptorDigest: d("f"),
      payloadDigest: d("1"), adapterId: "adapter-1", adapterVersion: "2.3.4",
      authorityHash: d("d"), supervisorEpoch: 4, planHash: d("c"), hostId: "host-1",
      hostGeneration: 5, hostIncarnation: "host-incarnation-1", transcriptAnchor: anchor,
    } as const;
    await expect(subject.admit(identity())).resolves.toEqual({ accepted: true });
    await expect(subject.admit(identity())).resolves.toEqual({ accepted: true });
    expect(seen).toEqual([{ op: "admit", identity: expected }, { op: "admit", identity: expected }]);
  });

  test("maps MCP crossover only with its durable tool-use entry", async () => {
    let seen!: AgentOperationRequest;
    const subject = facade((request) => {
      seen = request;
      return { accepted: true, replayed: false, receipt: admitted(request.identity) };
    });
    await subject.admit(identity("mcp"));
    expect(seen.identity).toMatchObject({ kind: "mcp", toolUseEntryId: "tool-use-1", transcriptAnchor: anchor });
    expect("toolUseEntryId" in (await captureAdmit(facade, identity("model"))).identity).toBe(false);
  });

  test("settles model and MCP with exact terminal refs and pending-tool order", async () => {
    const requests: AgentOperationRequest[] = [];
    const subject = facade((request) => {
      requests.push(request);
      if (request.op !== "settle" && request.op !== "indeterminate") throw new Error("unexpected");
      return { accepted: true, replayed: requests.length > 1, receipt: terminalReceipt(request) };
    });
    await subject.settle(identity(), d("4"), terminal());
    await subject.settle(identity(), d("4"), terminal());
    await subject.indeterminate(identity("mcp"), d("5"), terminal("mcp"));
    expect(requests[0]).toMatchObject({ op: "settle", gatewayReceiptDigest: d("4"), transcriptReceipts: refs, pendingToolUseEntryIds: ["pending-1", "pending-2"] });
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]).toMatchObject({ op: "indeterminate", gatewayReceiptDigest: d("5") });
    expect("pendingToolUseEntryIds" in requests[2]!).toBe(false);
  });

  test("fails closed on actor rejection, quarantine, and contradictory accepted evidence", async () => {
    await expect(facade(() => ({ accepted: false, reason: "authority_mismatch" })).admit(identity()))
      .rejects.toMatchObject({ name: AgentOperationKernelRejectedError.name, reason: "authority_mismatch" });
    await expect(facade(() => { throw new SessionKernelQuarantinedError("session-1", "tamper"); }).admit(identity()))
      .rejects.toBeInstanceOf(AgentOperationKernelQuarantinedError);
    await expect(facade((request) => ({ accepted: true, replayed: false, receipt: admitted({ ...request.identity, hostId: "other-host" }) })).admit(identity()))
      .rejects.toBeInstanceOf(AgentOperationKernelEvidenceError);
  });

  test("rejects terminal receipts missing exact terminal evidence", async () => {
    const subject = facade((request) => {
      if (request.op !== "settle") throw new Error("unexpected");
      return { accepted: true, replayed: false, receipt: { ...terminalReceipt(request), outcomeCode: "different" } };
    });
    await expect(subject.settle(identity(), d("4"), terminal())).rejects.toBeInstanceOf(AgentOperationKernelEvidenceError);
  });

  test("persists cancellation before returning requested, too_late, and replay", async () => {
    const events: string[] = [];
    let count = 0;
    const subject = facade(async (request) => {
      events.push("actor:start");
      await Promise.resolve();
      events.push("actor:durable");
      const disposition = request.op === "cancel" && request.cancelId === "late" ? "too_late" : "requested";
      count++;
      return { accepted: true, replayed: count > 1, intent: { identity: request.identity, cancelId: (request as any).cancelId, reason: (request as any).reason, disposition, requestedAtMs: 100 } };
    });
    const requested = subject.request(identity(), "cancel-1", "user").then((value) => { events.push("caller:abort"); return value; });
    await expect(requested).resolves.toBe("requested");
    await expect(subject.request(identity(), "cancel-1", "user")).resolves.toBe("requested");
    await expect(subject.request(identity(), "late", "shutdown")).resolves.toBe("too_late");
    expect(events.slice(0, 3)).toEqual(["actor:start", "actor:durable", "caller:abort"]);
  });

  test("authorized query returns exact receipts, absence, and rejects crossover", async () => {
    const ok = facade((request) => ({ accepted: true, replayed: true, receipt: admitted(request.identity) }));
    await expect(ok.queryAuthorized(identity())).resolves.toMatchObject({ state: "admitted" });
    await expect(facade(() => ({ accepted: false, reason: "not_found" })).queryAuthorized(identity())).resolves.toBeUndefined();
    await expect(facade(() => ({ accepted: false, reason: "operation_barrier" })).queryAuthorized(identity()))
      .rejects.toBeInstanceOf(AgentOperationKernelRejectedError);
  });

  test("never retries ambiguous actor mutations and remains responsive while physical work is blocked", async () => {
    let calls = 0;
    const ambiguous = facade(() => { calls++; throw new SessionKernelActorError("lost reply", true); });
    await expect(ambiguous.admit(identity())).rejects.toMatchObject({
      name: AgentOperationKernelTransportError.name, ambiguous: true, retryable: false,
    });
    expect(calls).toBe(1);

    let release!: () => void;
    const physical = new Promise<void>((resolve) => { release = resolve; });
    const bundle = createAgentOperationKernelFacades({
      decideAgentOperationAsync: async (request: AgentOperationRequest) => ({ accepted: true, replayed: false, receipt: admitted(request.identity) }),
    } as any);
    void physical; // Simulates provider/transcript work owned outside this facade.
    await expect(bundle.admission.admit(identity())).resolves.toEqual({ accepted: true });
    await expect(bundle.queryAuthorized(identity())).resolves.toMatchObject({ state: "admitted" });
    release();
  });
});

async function captureAdmit(make: typeof facade, value: AgentOperationIdentity) {
  let captured!: AgentOperationRequest;
  await make((request) => {
    captured = request;
    return { accepted: true, replayed: false, receipt: admitted(request.identity) };
  }).admit(value);
  return captured;
}
