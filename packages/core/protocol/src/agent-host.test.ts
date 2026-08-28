import { describe, expect, test } from "bun:test";
import {
  AGENT_HOST_PROTOCOL_VERSION,
  MAX_AGENT_HOST_STREAM_BYTES,
  MAX_AGENT_HOST_STREAM_CHUNK_BYTES,
  decodeAgentHostAttachResumeCursorV4,
  decodeAgentHostHello,
  decodeAgentHostOperationCancel,
  decodeAgentHostOperationCancelReceipt,
  decodeAgentHostOperationQuery,
  decodeAgentHostOperationQueryReceipt,
  decodeAgentHostOperationReceipt,
  decodeAgentHostOperationRequest,
  decodeAgentHostOperationRequestExact,
  decodeAgentHostOperationStream,
  decodeAgentHostOperationStreamAck,
  decodeAgentHostStartTurn,
  decodeAgentHostConsumptionAck,
  decodeAgentHostTurnTerminal,
  decodeAgentHostTurnTerminalAck,
  hashAgentTurnResultV1,
  hashAgentTurnTerminalReceiptsV1,
  decodeAgentTurnSpec,
  hashAgentTurnSpecV2,
  type AgentTurnSpec,
} from "./agent-host";
import { hashAgentOperationDescriptorV1, type AgentOperationReceiptV1 } from "./agent-operation";

const now = 1_000;
const d = (char: string) => `sha256:${char.repeat(64)}` as const;
const fence = { sessionId: "session-1", runId: "run-1", turnId: "turn-1", generation: 1 };
const descriptor = {
  version: 1 as const,
  kind: "model" as const,
  stepId: "step-1",
  transcript: { throughChangeSeq: 2, entryIds: ["entry-1"], digest: d("a") },
  modelPolicyHash: d("b"),
  adapterRequestVersion: "model.v1",
};
const receipt: AgentOperationReceiptV1 = {
  version: 1, operationId: "operation-1", kind: "model", fence,
  planHash: d("c"), authorityHash: d("d"), descriptorDigest: d("e"), payloadDigest: d("f"),
  actorIdentity: { supervisorEpoch: 1, hostId: "host-1", hostGeneration: 1, hostIncarnation: "incarnation-1", transcriptAnchor: descriptor.transcript },
  state: "prepared", acceptedAtMs: 1, providerRef: { adapterId: "adapter-1", adapterVersion: "1" },
};
const common = { version: 5 as const, requestId: "request-1", fence };

async function makeSpec(): Promise<AgentTurnSpec> {
  return {
    fence,
    initialOperation: { operationId: "operation-1", descriptor, descriptorDigest: await hashAgentOperationDescriptorV1(descriptor), deadlineMs: now + 60_000 },
    transcript: { afterChangeSeq: 2, maxAppendBytes: 64_000, requireAck: true },
    limits: { turnDeadlineMs: now + 120_000, maxInFlightOperations: 8, maxBufferedStreamBytes: 512 * 1024, maxBufferedStreamChunks: 32 },
  };
}

describe("Agent Host protocol v5", () => {
  test("hard cuts v4 and exact hello keys", () => {
    expect(AGENT_HOST_PROTOCOL_VERSION).toBe(5);
    expect(decodeAgentHostHello({ t: "hello", version: 5, requestId: "request-1" })).toBeDefined();
    expect(decodeAgentHostHello({ t: "hello", version: 4, requestId: "request-1" })).toBeUndefined();
    expect(decodeAgentHostHello({ t: "hello", version: 5, requestId: "request-1", extra: true })).toBeUndefined();
  });

  test("decodes only the frozen descriptor-only turn spec and hashes domain v2", async () => {
    const spec = await makeSpec();
    const decoded = decodeAgentTurnSpec(spec, now)!;
    expect(decoded).toEqual(spec);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.initialOperation.descriptor)).toBe(true);
    const hash = await hashAgentTurnSpecV2(spec, now);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await hashAgentTurnSpecV2({ ...spec, transcript: { ...spec.transcript, afterChangeSeq: 3 } }, now)).not.toBe(hash);
    for (const key of ["input", "prompt", "images", "mode", "modelPolicy", "enginePolicy", "mcpPolicy", "runPolicy", "identityPolicy", "environmentPolicy", "workspacePolicy", "executorPolicy", "accessGrant"])
      expect(decodeAgentTurnSpec({ ...spec, [key]: "forbidden" }, now)).toBeUndefined();
    expect(decodeAgentTurnSpec({ ...spec, limits: { ...spec.limits, maxInFlightOperations: 9 } }, now)).toBeUndefined();
    expect(decodeAgentTurnSpec({ ...spec, initialOperation: { ...spec.initialOperation, deadlineMs: now + 5 * 60_000 + 1 } }, now)).toBeUndefined();
    expect(decodeAgentHostStartTurn({ t: "start_turn", version: 5, requestId: "request-1", planHash: d("1"), spec }, now)).toBeDefined();
  });

  test("strictly decodes sorted immutable attach resume cursors", () => {
    const cursor = { lastHostSeq: 7, operations: [{ operationId: "operation-1", throughStreamSeq: 2 }, { operationId: "operation-2", throughStreamSeq: 0 }] };
    const decoded = decodeAgentHostAttachResumeCursorV4(cursor)!;
    expect(decoded).toEqual(cursor);
    expect(Object.isFrozen(decoded.operations)).toBe(true);
    expect(decodeAgentHostAttachResumeCursorV4(null)).toBeNull();
    expect(decodeAgentHostAttachResumeCursorV4({ ...cursor, extra: true })).toBeUndefined();
    expect(decodeAgentHostAttachResumeCursorV4({ ...cursor, operations: [...cursor.operations].reverse() })).toBeUndefined();
    expect(decodeAgentHostAttachResumeCursorV4({ ...cursor, operations: Array(9).fill(cursor.operations[0]) })).toBeUndefined();
  });

  test("decodes exact operation intents and verifies request digests", async () => {
    const descriptorDigest = await hashAgentOperationDescriptorV1(descriptor);
    const request = { t: "operation_request", ...common, hostSeq: 1, operationId: "operation-1", descriptor, descriptorDigest, deadlineMs: now + 60_000 };
    expect(await decodeAgentHostOperationRequest(request, now)).toBeDefined();
    expect(await decodeAgentHostOperationRequestExact(request, now)).toBeDefined();
    expect(await decodeAgentHostOperationRequestExact({ ...request, descriptorDigest: d("0") }, now)).toBeUndefined();
    const query = { t: "operation_query", ...common, hostSeq: 2, operationId: "operation-1", kind: "model", descriptorDigest, payloadDigest: d("2"), afterStreamSeq: 0 };
    expect(decodeAgentHostOperationQuery(query)).toBeDefined();
    expect(decodeAgentHostOperationQuery({ ...query, prompt: "forbidden" })).toBeUndefined();
    const cancel = { t: "operation_cancel", ...common, hostSeq: 3, operationId: "operation-1", cancelId: "cancel-1", reason: "reconnect_deadline" };
    expect(decodeAgentHostOperationCancel(cancel)).toBeDefined();
    expect(decodeAgentHostOperationCancel({ ...cancel, reason: "timeout" })).toBeUndefined();
  });

  test("decodes bound receipt wrappers and rejects crossover", () => {
    const wrapper = { t: "operation_receipt", ...common, ackHostSeq: 1, operationId: "operation-1", receipt };
    expect(decodeAgentHostOperationReceipt(wrapper)).toBeDefined();
    expect(decodeAgentHostOperationReceipt({ ...wrapper, operationId: "operation-2" })).toBeUndefined();
    expect(decodeAgentHostOperationQueryReceipt({ t: "operation_query_receipt", ...common, ackHostSeq: 2, operationId: "operation-1", fromStreamSeq: 1, receipt })).toBeDefined();
    expect(decodeAgentHostOperationCancelReceipt({ t: "operation_cancel_receipt", ...common, ackHostSeq: 3, operationId: "operation-1", cancelId: "cancel-1", disposition: "indeterminate", receipt })).toBeDefined();
  });

  test("enforces canonical bounded opaque stream chunks and exact ACK credits", () => {
    const stream = { t: "operation_stream", ...common, operationId: "operation-1", streamSeq: 1, encoding: "base64url+opensession-operation-v1", bytes: "aGVsbG8" };
    expect(decodeAgentHostOperationStream(stream)).toBeDefined();
    for (const bytes of ["aGVsbG8=", "aGVsbG8+", "", "A".repeat(Math.ceil((MAX_AGENT_HOST_STREAM_CHUNK_BYTES + 1) * 4 / 3))])
      expect(decodeAgentHostOperationStream({ ...stream, bytes })).toBeUndefined();
    const ack = { t: "operation_stream_ack", ...common, hostSeq: 4, operationId: "operation-1", throughStreamSeq: 1, creditBytes: MAX_AGENT_HOST_STREAM_BYTES, creditChunks: 32 };
    expect(decodeAgentHostOperationStreamAck(ack)).toBeDefined();
    expect(decodeAgentHostOperationStreamAck({ ...ack, creditBytes: MAX_AGENT_HOST_STREAM_BYTES + 1 })).toBeUndefined();
    expect(decodeAgentHostOperationStreamAck({ ...ack, creditChunks: 33 })).toBeUndefined();
  });

  test("decodes exact terminal projection and cumulative acknowledgements", async () => {
    const operations = [{ operationId: "operation-1", receiptDigest: d("8"), throughStreamSeq: 2 }];
    const terminal = {
      t: "turn_terminal" as const, ...common, hostSeq: 5,
      hostGeneration: 7, hostIncarnation: "incarnation-terminal-1",
      result: { status: "failed" as const }, resultDigest: await hashAgentTurnResultV1({ status: "failed", error: "redacted from frame" }),
      receiptsDigest: await hashAgentTurnTerminalReceiptsV1(operations), finalAckHostSeq: 4, operations,
    };
    expect(decodeAgentHostTurnTerminal(terminal)).toEqual(terminal);
    expect(JSON.stringify(terminal)).not.toContain("redacted from frame");
    expect(decodeAgentHostTurnTerminal({ ...terminal, prompt: "forbidden" })).toBeUndefined();
    expect(decodeAgentHostConsumptionAck({ t: "consumption_ack", ...common, ackHostSeq: 4, operations: [{ operationId: "operation-1", throughStreamSeq: 2 }] })).toBeDefined();
    expect(decodeAgentHostTurnTerminalAck({ t: "turn_terminal_ack", ...common, ackHostSeq: 5, resultDigest: terminal.resultDigest, receiptsDigest: terminal.receiptsDigest })).toBeDefined();
    expect(decodeAgentHostTurnTerminalAck({ t: "turn_terminal_ack", ...common, ackHostSeq: 5, resultDigest: terminal.resultDigest, receiptsDigest: terminal.receiptsDigest, fallback: true })).toBeUndefined();
  });

  test("rejects accessors and non-plain objects", async () => {
    const spec = await makeSpec();
    const accessor = { ...spec } as Record<string, unknown>;
    Object.defineProperty(accessor, "fence", { enumerable: true, get: () => fence });
    expect(decodeAgentTurnSpec(accessor, now)).toBeUndefined();
    expect(decodeAgentTurnSpec(Object.assign(Object.create({ inherited: true }), spec), now)).toBeUndefined();
    expect(decodeAgentTurnSpec(new Proxy(spec, {}), now)).toBeUndefined();
  });
});
