import { describe, expect, test } from "bun:test";
import { encodeExecutorGrant } from "./executor";
import {
  AGENT_GATEWAY_DISPATCH_GRANT_PREFIX,
  AGENT_MCP_ARGUMENTS_DIGEST_DOMAIN,
  AGENT_MCP_PAYLOAD_DIGEST_DOMAIN,
  AGENT_MODEL_PAYLOAD_DIGEST_DOMAIN,
  AGENT_OPERATION_DESCRIPTOR_DIGEST_DOMAIN,
  AGENT_OPERATION_RECEIPT_DIGEST_DOMAIN,
  MAX_AGENT_OPERATION_DEPTH,
  decodeAgentGatewayDispatchGrant,
  decodeAgentOperationDescriptorV1,
  decodeAgentOperationQueryV1,
  decodeAgentOperationReceiptV1,
  decodeAgentOperationRequestV1,
  decodeAgentTranscriptReceiptRefV1,
  encodeAgentGatewayDispatchGrant,
  hashAgentMcpArgumentsV1,
  hashAgentMcpPayloadV1,
  hashAgentModelPayloadV1,
  hashAgentOperationDescriptorV1,
  hashAgentOperationReceiptV1,
  serializeAgentOperationDescriptorV1,
  serializeAgentOperationQueryV1,
  serializeAgentOperationReceiptV1,
  serializeAgentOperationRequestV1,
  unsupportedAgentOperationReconciliation,
  type AgentModelOperationDescriptorV1,
  type AgentOperationReceiptV1,
} from "./agent-operation";

const d = (char: string) => `sha256:${char.repeat(64)}` as const;
const fence = {
  sessionId: "session-1",
  runId: "run-1",
  turnId: "turn-1",
  generation: 3,
};
const grant = encodeAgentGatewayDispatchGrant("g".repeat(43));
const supervisionEnvelope = {
  version: 1 as const,
  algorithm: "Ed25519" as const,
  domain: "opensession.agent-host.supervision.v2" as const,
  authorityBytes: "YQ",
  signature: "A".repeat(86),
};
const model: AgentModelOperationDescriptorV1 = {
  version: 1,
  kind: "model",
  stepId: "step-1",
  transcript: { throughChangeSeq: 4, entryIds: ["entry-1"], digest: d("a") },
  modelPolicyHash: d("b"),
  adapterRequestVersion: "model-request.v1",
};
const request = {
  version: 1 as const,
  operationId: "op-1",
  kind: "model" as const,
  fence,
  supervisionEnvelope,
  dispatchGrant: grant,
  descriptor: model,
  descriptorDigest: d("c"),
};
const receipt: AgentOperationReceiptV1 = {
  version: 1,
  operationId: "op-1",
  kind: "model",
  fence,
  planHash: d("d"),
  authorityHash: d("e"),
  descriptorDigest: d("c"),
  payloadDigest: d("f"),
  actorIdentity: {
    supervisorEpoch: 4,
    hostId: "host-1",
    hostGeneration: 2,
    hostIncarnation: "incarnation-1",
    transcriptAnchor: model.transcript,
  },
  state: "prepared",
  acceptedAtMs: 1,
  providerRef: { adapterId: "adapter-1", adapterVersion: "1.0" },
};

describe("Agent operation protocol v1", () => {
  test("brands a gateway grant in a domain separate from Agent Host and Executor grants", () => {
    expect(decodeAgentGatewayDispatchGrant(grant)).toBe(grant);
    expect(grant.startsWith(AGENT_GATEWAY_DISPATCH_GRANT_PREFIX)).toBe(true);
    expect(
      decodeAgentGatewayDispatchGrant(encodeExecutorGrant("e".repeat(32))),
    ).toBeUndefined();
    expect(() => encodeAgentGatewayDispatchGrant("short")).toThrow();
  });

  test("strictly decodes exact request, kind and query authority bindings", () => {
    expect(decodeAgentOperationRequestV1(request)).toEqual(request);
    expect(
      decodeAgentOperationRequestV1({ ...request, extra: true }),
    ).toBeUndefined();
    expect(
      decodeAgentOperationRequestV1({ ...request, version: 2 }),
    ).toBeUndefined();
    expect(
      decodeAgentOperationRequestV1({ ...request, kind: "mcp" }),
    ).toBeUndefined();
    expect(
      decodeAgentOperationRequestV1({ ...request, descriptorDigest: d("C") }),
    ).toBeUndefined();
    const query = {
      version: 1 as const,
      operationId: "op-1",
      kind: "model" as const,
      fence,
      supervisionEnvelope,
      dispatchGrant: grant,
      descriptorDigest: d("c"),
      payloadDigest: d("f"),
    };
    expect(decodeAgentOperationQueryV1(query)).toEqual(query);
    expect(
      decodeAgentOperationQueryV1({
        ...query,
        operationId: "op-1",
        fence: { ...fence, generation: 4 },
      }),
    ).toBeDefined();
    expect(
      decodeAgentOperationQueryV1({ version: 1, operationId: "op-1" }),
    ).toBeUndefined();
  });

  test("rejects descriptor crossover, raw bodies and recursively forbidden secret/config keys", () => {
    expect(decodeAgentOperationDescriptorV1(model)).toEqual(model);
    expect(
      decodeAgentOperationDescriptorV1({ ...model, prompt: "secret" }),
    ).toBeUndefined();
    expect(
      decodeAgentOperationDescriptorV1({
        ...model,
        transcript: { ...model.transcript, headers: { Authorization: "x" } },
      }),
    ).toBeUndefined();
    expect(
      decodeAgentOperationDescriptorV1({ ...model, kind: "mcp" }),
    ).toBeUndefined();
    expect(
      decodeAgentOperationDescriptorV1({
        version: 1,
        kind: "mcp",
        toolUseEntryId: "e",
        toolUseId: "t",
        server: "s",
        tool: "x",
        argumentsDigest: d("a"),
        adapterRequestVersion: "v1",
        arguments: {},
      }),
    ).toBeUndefined();
  });

  test("rejects non-JSON values, prototypes, nonfinite numbers and excessive depth", () => {
    expect(
      decodeAgentOperationDescriptorV1(
        Object.assign(Object.create({ inherited: true }), model),
      ),
    ).toBeUndefined();
    expect(
      decodeAgentOperationDescriptorV1({
        ...model,
        transcript: { ...model.transcript, throughChangeSeq: Infinity },
      }),
    ).toBeUndefined();
    let nested: unknown = "leaf";
    for (let i = 0; i < MAX_AGENT_OPERATION_DEPTH + 2; i++) nested = { nested };
    expect(
      decodeAgentOperationDescriptorV1({ ...model, extra: nested }),
    ).toBeUndefined();
    expect(
      decodeAgentOperationDescriptorV1({
        ...model,
        transcript: { ...model.transcript, entryIds: [undefined] },
      }),
    ).toBeUndefined();
    let reads = 0;
    const accessor = { ...model } as Record<string, unknown>;
    Object.defineProperty(accessor, "stepId", {
      enumerable: true,
      get: () => (++reads === 1 ? "step-1" : "secret-value"),
    });
    expect(decodeAgentOperationDescriptorV1(accessor)).toBeUndefined();
    const accessorIds = ["entry-1"];
    Object.defineProperty(accessorIds, "0", {
      enumerable: true,
      get: () => "secret-value",
    });
    expect(
      decodeAgentOperationDescriptorV1({
        ...model,
        transcript: { ...model.transcript, entryIds: accessorIds },
      }),
    ).toBeUndefined();
    const proxy = new Proxy({ ...model }, {});
    expect(decodeAgentOperationDescriptorV1(proxy)).toBeUndefined();
  });

  test("uses deterministic canonical serialization and distinct digest domains", async () => {
    const bytes = serializeAgentOperationDescriptorV1(model);
    expect(new TextDecoder().decode(bytes)).toBe(
      '{"version":1,"kind":"model","stepId":"step-1","transcript":{"throughChangeSeq":4,"entryIds":["entry-1"],"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"modelPolicyHash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","adapterRequestVersion":"model-request.v1"}',
    );
    const values = await Promise.all([
      hashAgentOperationDescriptorV1(model),
      hashAgentModelPayloadV1(bytes),
      hashAgentMcpPayloadV1(bytes),
      hashAgentMcpArgumentsV1(bytes),
    ]);
    expect(new Set(values).size).toBe(4);
    expect(
      serializeAgentOperationRequestV1({
        ...request,
        fence: {
          generation: 3,
          turnId: "turn-1",
          runId: "run-1",
          sessionId: "session-1",
        },
      }),
    ).toEqual(serializeAgentOperationRequestV1(request));
    const query = {
      version: 1 as const,
      operationId: "op-1",
      kind: "model" as const,
      fence,
      supervisionEnvelope,
      dispatchGrant: grant,
      descriptorDigest: d("c"),
      payloadDigest: d("f"),
    };
    expect(
      serializeAgentOperationQueryV1({
        payloadDigest: query.payloadDigest,
        descriptorDigest: query.descriptorDigest,
        dispatchGrant: query.dispatchGrant,
        supervisionEnvelope: query.supervisionEnvelope,
        fence: query.fence,
        kind: query.kind,
        operationId: query.operationId,
        version: query.version,
      }),
    ).toEqual(serializeAgentOperationQueryV1(query));
    expect([
      AGENT_OPERATION_DESCRIPTOR_DIGEST_DOMAIN,
      AGENT_OPERATION_RECEIPT_DIGEST_DOMAIN,
      AGENT_MODEL_PAYLOAD_DIGEST_DOMAIN,
      AGENT_MCP_PAYLOAD_DIGEST_DOMAIN,
      AGENT_MCP_ARGUMENTS_DIGEST_DOMAIN,
    ]).toHaveLength(5);
  });

  test("strictly decodes immutable transcript destination receipt references", () => {
    const reference = {
      appendId: "append-1",
      entryIds: ["entry-1", "entry-2"],
      firstSeq: 4,
      lastSeq: 5,
      throughChangeSeq: 8,
      requestDigest: d("a"),
    };
    const decoded = decodeAgentTranscriptReceiptRefV1(reference);
    expect(decoded).toEqual(reference);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded!.entryIds)).toBe(true);
    for (const invalid of [
      { ...reference, unknown: true },
      { ...reference, entryIds: [] },
      { ...reference, entryIds: ["entry-1", "entry-1"] },
      { ...reference, firstSeq: 0, lastSeq: 1 },
      { ...reference, lastSeq: 6 },
      { ...reference, throughChangeSeq: 0 },
      { ...reference, requestDigest: "sha256:not-a-digest" },
    ])
      expect(decodeAgentTranscriptReceiptRefV1(invalid)).toBeUndefined();
    const accessor = { ...reference };
    Object.defineProperty(accessor, "lastSeq", {
      enumerable: true,
      get: () => 5,
    });
    expect(decodeAgentTranscriptReceiptRefV1(accessor)).toBeUndefined();
    expect(
      decodeAgentTranscriptReceiptRefV1(new Proxy(reference, {})),
    ).toBeUndefined();
  });

  test("durably binds exact SessionKernel terminal replay material", async () => {
    const transcriptRefs = [
      {
        appendId: "append-1",
        entryIds: ["entry-2", "tool-1"],
        firstSeq: 5,
        lastSeq: 6,
        throughChangeSeq: 6,
        requestDigest: d("1"),
      },
    ];
    const kernelTerminal = {
      outputDigest: d("2"),
      outcomeCode: "ok",
      transcriptRefs,
      pendingToolUseEntryIds: ["tool-1"],
    };
    const terminal: AgentOperationReceiptV1 = {
      ...receipt,
      state: "settled",
      executingAtMs: 2,
      completedAtMs: 3,
      outcome: {
        status: "succeeded",
        code: "ok",
        outputDigest: d("2"),
      },
      transcriptRefs,
      kernelTerminal,
    };
    expect(decodeAgentOperationReceiptV1(terminal)).toEqual(terminal);
    expect(await hashAgentOperationReceiptV1(terminal)).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(serializeAgentOperationReceiptV1(terminal)).toEqual(
      serializeAgentOperationReceiptV1(
        decodeAgentOperationReceiptV1(terminal)!,
      ),
    );
    expect(
      decodeAgentOperationReceiptV1({
        ...terminal,
        kernelTerminal: {
          ...kernelTerminal,
          pendingToolUseEntryIds: ["missing-tool"],
        },
      }),
    ).toBeUndefined();
    expect(
      decodeAgentOperationReceiptV1({
        ...terminal,
        kernelTerminal: { ...kernelTerminal, outputDigest: d("3") },
      }),
    ).toBeUndefined();
    expect(
      decodeAgentOperationReceiptV1({
        ...terminal,
        kernelTerminal: undefined,
      }),
    ).toBeUndefined();
    const indeterminate = {
      ...receipt,
      state: "indeterminate" as const,
      executingAtMs: 2,
      completedAtMs: 3,
      transcriptRefs,
      errorCode: "reconciliation_failed" as const,
      kernelTerminal: {
        ...kernelTerminal,
        outcomeCode: "reconciliation_failed",
      },
    };
    expect(decodeAgentOperationReceiptV1(indeterminate)).toEqual(indeterminate);
    expect(
      decodeAgentOperationReceiptV1({
        ...indeterminate,
        kernelTerminal: {
          ...indeterminate.kernelTerminal,
          outcomeCode: "ambiguous_completion",
        },
      }),
    ).toBeUndefined();
  });

  test("strictly binds terminal reservations only to executing receipts", () => {
    const terminalReservation = {
      reservationId: `reservation:${"1".repeat(64)}`,
      reason: "reconciliation_unsupported" as const,
      reservedAtMs: 3,
    };
    const executing = {
      ...receipt,
      state: "executing" as const,
      executingAtMs: 2,
      terminalReservation,
    };
    expect(decodeAgentOperationReceiptV1(executing)).toEqual(executing);
    expect(serializeAgentOperationReceiptV1(executing)).toEqual(
      serializeAgentOperationReceiptV1(
        decodeAgentOperationReceiptV1(executing)!,
      ),
    );
    expect(
      decodeAgentOperationReceiptV1({
        ...executing,
        terminalReservation: {
          ...terminalReservation,
          reservedAtMs: 1,
        },
      }),
    ).toBeUndefined();
    expect(
      decodeAgentOperationReceiptV1({
        ...executing,
        terminalReservation: {
          ...terminalReservation,
          reason: "operation_failed",
        },
      }),
    ).toBeUndefined();
    expect(
      decodeAgentOperationReceiptV1({
        ...receipt,
        terminalReservation,
      }),
    ).toBeUndefined();
  });

  test("receipts are strict bounded metadata and cannot contain bodies or secrets", () => {
    expect(decodeAgentOperationReceiptV1(receipt)).toEqual(receipt);
    expect(
      new TextDecoder().decode(serializeAgentOperationReceiptV1(receipt)),
    ).not.toMatch(/body|prompt|credential|secret/i);
    expect(
      serializeAgentOperationReceiptV1({
        providerRef: receipt.providerRef,
        acceptedAtMs: receipt.acceptedAtMs,
        state: receipt.state,
        payloadDigest: receipt.payloadDigest,
        descriptorDigest: receipt.descriptorDigest,
        authorityHash: receipt.authorityHash,
        actorIdentity: receipt.actorIdentity,
        planHash: receipt.planHash,
        fence: receipt.fence,
        kind: receipt.kind,
        operationId: receipt.operationId,
        version: receipt.version,
      }),
    ).toEqual(serializeAgentOperationReceiptV1(receipt));
    for (const forbidden of [
      "body",
      "prompt",
      "credentials",
      "headers",
      "url",
      "arguments",
    ])
      expect(
        decodeAgentOperationReceiptV1({ ...receipt, [forbidden]: "x" }),
      ).toBeUndefined();
    expect(
      decodeAgentOperationReceiptV1({
        ...receipt,
        state: "settled",
        completedAtMs: 2,
      }),
    ).toBeUndefined();
    expect(
      decodeAgentOperationReceiptV1({
        ...receipt,
        providerRef: { ...receipt.providerRef, requestId: "contains spaces" },
      }),
    ).toBeUndefined();
  });

  test("default reconciliation is explicitly fail-closed", async () => {
    expect(await unsupportedAgentOperationReconciliation()).toEqual({
      status: "indeterminate",
      reason: "reconciliation_unsupported",
    });
  });
});
