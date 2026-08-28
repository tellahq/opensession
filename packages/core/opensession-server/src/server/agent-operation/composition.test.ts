import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashAgentMcpArgumentsV1,
  hashAgentMcpPayloadV1,
  hashAgentModelPayloadV1,
  hashAgentOperationDescriptorV1,
  type AgentOperationDigest,
} from "@tellahq/opensession-protocol/agent-operation";
import type { AgentHostSupervisionAuthorityV2 } from "@tellahq/opensession-protocol/agent-host";
import { TranscriptStore } from "../transcript-store";
import type { AgentOperationRequest } from "../session-kernel/agent-operation-protocol";
import { createAgentOperationComposition } from "./composition";
import { encodeAgentGatewayPolicyHandle } from "./grants";
import {
  MCP_AGENT_OPERATION_ADAPTER_ID,
  MCP_AGENT_OPERATION_ADAPTER_VERSION,
} from "./mcp-adapter";
import {
  PI_MODEL_AGENT_OPERATION_ADAPTER_ID,
  PI_MODEL_AGENT_OPERATION_ADAPTER_VERSION,
} from "./pi-model-adapter";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const d = (c: string) => `sha256:${c.repeat(64)}` as AgentOperationDigest;
const freeze = <T>(value: T): Readonly<T> => Object.freeze(value);
const fence = freeze({
  sessionId: "session-1",
  runId: "run-1",
  turnId: "turn-1",
  generation: 1,
});
const anchor = freeze({
  throughChangeSeq: 0,
  entryIds: freeze([] as string[]),
  digest: d("a"),
});
const authority: AgentHostSupervisionAuthorityV2 = {
  version: 2,
  fence,
  planHash: d("b"),
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

function actor() {
  const receipts = new Map<string, any>();
  const events: string[] = [];
  return {
    events,
    client: {
      async decideAgentOperationAsync(request: AgentOperationRequest) {
        const key = request.identity.operationId;
        if (request.op === "admit") {
          events.push("admit");
          const receipt = receipts.get(key) ?? {
            identity: request.identity,
            sequence: 1,
            state: "admitted",
            admittedAtMs: 10,
          };
          receipts.set(key, receipt);
          return { accepted: true, replayed: receipts.has(key), receipt };
        }
        if (request.op === "settle" || request.op === "indeterminate") {
          events.push(request.op);
          const receipt = {
            identity: request.identity,
            sequence: 2,
            state: request.op === "settle" ? "settled" : "indeterminate",
            admittedAtMs: 10,
            terminalAtMs: 20,
            gatewayReceiptDigest: request.gatewayReceiptDigest,
            outputDigest: request.outputDigest,
            outcomeCode: request.outcomeCode,
            transcriptReceipts: request.transcriptReceipts,
            ...(request.identity.kind === "model"
              ? { pendingToolUseEntryIds: request.pendingToolUseEntryIds! }
              : {}),
          };
          receipts.set(key, receipt);
          return { accepted: true, replayed: false, receipt };
        }
        if (request.op === "query") {
          const receipt = receipts.get(key);
          return receipt
            ? { accepted: true, replayed: true, receipt }
            : { accepted: false, reason: "not_found" };
        }
        if (request.op === "cancel") {
          events.push("cancel");
          return {
            accepted: true,
            replayed: false,
            intent: {
              identity: request.identity,
              cancelId: request.cancelId,
              reason: request.reason,
              disposition: "requested",
            },
          };
        }
        throw new Error("unexpected actor operation");
      },
    },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-composition-"));
  roots.push(root);
  const store = new TranscriptStore(join(root, "transcript.sqlite"));
  const kernel = actor();
  let modelPhysical = 0;
  let entropy = 0;
  const composition = createAgentOperationComposition({
    ledger: { dbPath: join(root, "operations.sqlite") },
    grants: {
      now: () => 10,
      entropy: () => Buffer.alloc(32, ++entropy).toString("base64url"),
    },
    actor: kernel.client as any,
    transcript: {
      store,
      render: async (identity, result) =>
        freeze({
          entries: freeze([
            freeze({
              id: `${identity.operationId}-output`,
              type:
                identity.kind === "model"
                  ? ("assistant" as const)
                  : ("tool_result" as const),
              content: JSON.stringify(result.transcript),
              timestamp: "2026-08-23T00:00:00.000Z",
            }),
          ]),
          ...(identity.kind === "model"
            ? { pendingToolUseEntryIds: freeze([] as string[]) }
            : {}),
        }),
      authenticateReservation: async (_identity, reservation) => reservation,
    },
    piInvocations: { now: () => 10 },
    piExecutor: {
      async execute({ publish }) {
        modelPhysical++;
        await publish(new TextEncoder().encode("delta"));
        return {
          outcome: freeze({ status: "succeeded" as const, code: "ok" }),
          transcript: freeze({ text: "model done" }),
        };
      },
    },
    decodeMcpPayload: (payload) => {
      if (!payload || typeof payload !== "object" || !("arguments" in payload))
        return undefined;
      const argumentsBytes = new TextEncoder().encode(
        JSON.stringify((payload as any).arguments),
      );
      return freeze({
        kind: "mcp" as const,
        value: payload,
        canonicalBytes: new TextEncoder().encode(JSON.stringify(payload)),
        canonicalArgumentsBytes: argumentsBytes,
      });
    },
    gateway: {
      now: () => 20,
      resolveTranscriptAnchor: async () => anchor,
      appendIndeterminateNotice: async () => {
        throw new Error("unexpected recovery");
      },
    },
    verifySupervision: async () => ({ authority, authorityHash: d("c") }),
    hostClient: {
      socketPath: join(root, "host.sock"),
      obtainSignedAttach: async () => {
        throw new Error("not connected in composition test");
      },
    },
  });
  return {
    root,
    store,
    kernel,
    composition,
    modelPhysical: () => modelPhysical,
  };
}

async function settle(
  composition: ReturnType<typeof createAgentOperationComposition>,
  dispatch: any,
  query: any,
) {
  const callbacks = (composition.hostClient as any).options;
  const first = await callbacks.dispatchOperation(
    dispatch,
    new AbortController().signal,
  );
  if (first.chunks) {
    let consumed = false;
    for await (const _chunk of first.chunks) {
      consumed = true;
      break;
    }
    if (consumed)
      await callbacks.acknowledgeOperationStream({
        ...dispatch,
        throughStreamSeq: 1,
      });
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = await callbacks.queryOperation(
      query,
      new AbortController().signal,
    );
    if (
      result.receipt.state === "settled" ||
      result.receipt.state === "indeterminate"
    )
      return result;
  }
  return callbacks.queryOperation(query, new AbortController().signal);
}

describe("detached Agent operation boot composition", () => {
  test("model and MCP complete through the real turn-owned adapters with exact transcript receipts", async () => {
    const f = fixture();
    await f.composition.start();

    const modelDescriptor = freeze({
      version: 1 as const,
      kind: "model" as const,
      stepId: "step-model",
      transcript: anchor,
      modelPolicyHash: d("d"),
      adapterRequestVersion: "v1" as const,
    });
    const modelDescriptorDigest =
      await hashAgentOperationDescriptorV1(modelDescriptor);
    const bindingRef = Buffer.alloc(32, 1).toString("base64url");
    const invocationRef = Buffer.alloc(32, 2).toString("base64url");
    f.composition.piBindings.register({
      fence,
      bindingRef,
      binding: { model: { provider: "test", id: "model" } } as any,
      descriptorDigest: modelDescriptorDigest,
      modelPolicyHash: modelDescriptor.modelPolicyHash,
      modelIdentity: { provider: "test", id: "model" },
    });
    const invocation = freeze({ prompt: "private prompt" });
    const invocationBytes = new TextEncoder().encode(
      JSON.stringify(invocation),
    );
    const registration = f.composition.piInvocations.register({
      fence,
      operationId: "operation-model",
      bindingRef,
      invocationRef,
      descriptorDigest: modelDescriptorDigest,
      invocation,
      canonicalBytes: invocationBytes,
      deadlineMs: 500,
    });
    const modelPlan = {
      operationId: "operation-model",
      fence,
      kind: "model" as const,
      descriptor: modelDescriptor,
      descriptorDigest: modelDescriptorDigest,
      payload: registration.reference,
      canonicalPayloadBytes: invocationBytes,
      transcriptAnchor: anchor,
      adapterId: PI_MODEL_AGENT_OPERATION_ADAPTER_ID,
      adapterVersion: PI_MODEL_AGENT_OPERATION_ADAPTER_VERSION,
      deadlineMs: 500,
      policyHandle: encodeAgentGatewayPolicyHandle("modelpolicy0000001"),
    };
    await f.composition.service.registerPlan(modelPlan);
    const modelPayloadDigest = await hashAgentModelPayloadV1(invocationBytes);
    const modelDispatch = {
      operationId: modelPlan.operationId,
      fence,
      kind: modelPlan.kind,
      descriptorDigest: modelDescriptorDigest,
      supervisionEnvelope: envelope,
      descriptor: modelDescriptor,
      deadlineMs: 500,
    };
    const model = await settle(f.composition, modelDispatch, {
      ...modelDispatch,
      payloadDigest: modelPayloadDigest,
      afterStreamSeq: 1,
      recovery: false,
    });
    expect(model.receipt.state).toBe("settled");
    expect(model.receipt.transcriptRefs?.[0]?.entryIds).toEqual([
      "operation-model-output",
    ]);
    expect(f.modelPhysical()).toBe(1);

    const g = fixture();
    await g.composition.start();
    const args = freeze({ query: "safe" });
    const mcpPayload = freeze({ arguments: args });
    const argumentsBytes = new TextEncoder().encode(JSON.stringify(args));
    const payloadBytes = new TextEncoder().encode(JSON.stringify(mcpPayload));
    const mcpDescriptor = freeze({
      version: 1 as const,
      kind: "mcp" as const,
      toolUseEntryId: "entry-tool-use",
      toolUseId: "tool-use-1",
      server: "search-server",
      tool: "search",
      argumentsDigest: await hashAgentMcpArgumentsV1(argumentsBytes),
      adapterRequestVersion: "v1" as const,
    });
    const mcpDescriptorDigest =
      await hashAgentOperationDescriptorV1(mcpDescriptor);
    let mcpPhysical = 0;
    g.composition.mcpRuntimes.register(fence, {
      catalog: async () => [
        { id: "search-server_search", server: "search-server", name: "search" },
      ],
      callExact: async () => {
        mcpPhysical++;
        return { content: [{ type: "text", text: "tool done" }] };
      },
      close: async () => {},
    } as any);
    const mcpPlan = {
      operationId: "operation-mcp",
      fence,
      kind: "mcp" as const,
      descriptor: mcpDescriptor,
      descriptorDigest: mcpDescriptorDigest,
      payload: mcpPayload,
      canonicalPayloadBytes: payloadBytes,
      transcriptAnchor: anchor,
      toolUseEntryId: mcpDescriptor.toolUseEntryId,
      adapterId: MCP_AGENT_OPERATION_ADAPTER_ID,
      adapterVersion: MCP_AGENT_OPERATION_ADAPTER_VERSION,
      deadlineMs: 500,
      policyHandle: encodeAgentGatewayPolicyHandle("mcppolicy000000001"),
    };
    await g.composition.service.registerPlan(mcpPlan);
    const mcpPayloadDigest = await hashAgentMcpPayloadV1(payloadBytes);
    const mcpDispatch = {
      operationId: mcpPlan.operationId,
      fence,
      kind: mcpPlan.kind,
      descriptorDigest: mcpDescriptorDigest,
      supervisionEnvelope: envelope,
      descriptor: mcpDescriptor,
      deadlineMs: 500,
    };
    const mcp = await settle(g.composition, mcpDispatch, {
      ...mcpDispatch,
      payloadDigest: mcpPayloadDigest,
      afterStreamSeq: 0,
      recovery: false,
    });
    expect(mcp.receipt.state).toBe("settled");
    expect(mcp.receipt.transcriptRefs?.[0]?.entryIds).toEqual([
      "operation-mcp-output",
    ]);
    expect(mcpPhysical).toBe(1);
    expect(f.composition.readinessFeed()).toMatchObject({
      gatewayOperationLedger: { schemaVersion: 2, recoverActiveComplete: true },
      infrastructureFallback: false,
    });
    await Promise.all([f.composition.close(), g.composition.close()]);
    f.store.close();
    g.store.close();
  });

  test("startup gates admission, Host callbacks fail wrong authority before physical work, and close is idempotent", async () => {
    const f = fixture();
    expect(
      f.composition.readinessFeed().gatewayOperationLedger
        .recoverActiveComplete,
    ).toBe(false);
    await expect(f.composition.service.registerPlan({} as any)).rejects.toThrow(
      "not ready",
    );
    await Promise.all([f.composition.start(), f.composition.start()]);
    const callbacks = (f.composition.hostClient as any).options;
    await expect(
      callbacks.dispatchOperation(
        {
          operationId: "missing",
          fence,
          kind: "model",
          descriptorDigest: d("f"),
          supervisionEnvelope: envelope,
          descriptor: {},
          deadlineMs: 1,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("plan mismatch");
    expect(f.modelPhysical()).toBe(0);
    await Promise.all([f.composition.close(), f.composition.close()]);
    expect(f.composition.readinessFeed()).toMatchObject({
      gatewayOperationLedger: { recoverActiveComplete: false },
      infrastructureFallback: false,
    });
    f.store.close();
  });
});
