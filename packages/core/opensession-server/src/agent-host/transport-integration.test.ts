import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_HOST_SUPERVISION_AUDIENCE,
  AGENT_HOST_SUPERVISION_PURPOSE,
  AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM,
  AGENT_HOST_SUPERVISION_SIGNATURE_DOMAIN,
  MAX_AGENT_HOST_REPLAY_BYTES,
  MAX_AGENT_HOST_REPLAY_FRAMES,
  hashAgentOperationDescriptorV1,
  hashAgentTurnSpecV2,
  serializeAgentHostSupervisionAuthorityV2,
  type AgentHostChallengeDescriptorV4,
  type AgentHostSupervisionPublicKeyringV2,
  type AgentOperationReceiptV1,
  type AgentTurnFence,
  type AgentHostTurnTerminalV5,
  type AgentTurnSpec,
} from "@tellahq/opensession-protocol";
import { AgentHostClient } from "../server/agent-host-client";
import { createAgentHostSupervisionSigner } from "../server/session-kernel/agent-host-supervision-signer";
import type {
  AgentHostOperationQuery,
  AgentHostOperationTransport,
  AgentTurnDriver,
  AgentTurnResult,
} from "./driver";
import { createAgentHost, type AgentHost } from "./host";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const fence: AgentTurnFence = {
  sessionId: "session-transport-1",
  runId: "run-transport-1",
  turnId: "turn-transport-1",
  generation: 1,
};
const descriptor = {
  version: 1 as const,
  kind: "model" as const,
  stepId: "step-transport-1",
  transcript: {
    throughChangeSeq: 4,
    entryIds: ["entry-transport-1"],
    digest: digest("a"),
  },
  modelPolicyHash: digest("b"),
  adapterRequestVersion: "model.v1",
};
const descriptorDigest = await hashAgentOperationDescriptorV1(descriptor);
const secondDescriptor = {
  ...descriptor,
  stepId: "step-transport-2",
  transcript: {
    throughChangeSeq: 4,
    entryIds: ["entry-transport-2"],
    digest: digest("f"),
  },
};
const secondDescriptorDigest =
  await hashAgentOperationDescriptorV1(secondDescriptor);
const startedAt = Date.now();
const spec: AgentTurnSpec = {
  fence,
  initialOperation: {
    operationId: "operation-transport-1",
    descriptor,
    descriptorDigest,
    deadlineMs: startedAt + 120_000,
  },
  transcript: { afterChangeSeq: 4, maxAppendBytes: 4096, requireAck: true },
  limits: {
    turnDeadlineMs: startedAt + 180_000,
    maxInFlightOperations: 2,
    maxBufferedStreamBytes: 512 * 1024,
    maxBufferedStreamChunks: 32,
  },
};
const planHash = await hashAgentTurnSpecV2(spec);

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function eventually(check: () => boolean, message: string) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

class FakeDriver implements AgentTurnDriver {
  transport?: AgentHostOperationTransport;
  readonly delivered: { seq: number; bytes: string }[] = [];
  readonly deliveredOperationIds: string[] = [];
  readonly deliveryStarted: number[] = [];
  readonly deliveryGates = new Map<number, ReturnType<typeof deferred<void>>>();
  cancelCalls = 0;
  shutdownCalls = 0;
  private readonly result = deferred<AgentTurnResult>();

  constructor(private readonly requestSecondOperation = false) {}

  async run(_spec: AgentTurnSpec, transport: AgentHostOperationTransport) {
    this.transport = transport;
    await transport.requestOperation(spec.initialOperation);
    if (this.requestSecondOperation)
      await transport.requestOperation({
        operationId: "operation-transport-2",
        descriptor: secondDescriptor,
        descriptorDigest: secondDescriptorDigest,
        deadlineMs: spec.initialOperation.deadlineMs,
      });
    return this.result.promise;
  }
  async deliverOperationStream(stream: {
    operationId: string;
    streamSeq: number;
    bytes: string;
  }) {
    this.deliveryStarted.push(stream.streamSeq);
    await this.deliveryGates.get(stream.streamSeq)?.promise;
    this.delivered.push({
      seq: stream.streamSeq,
      bytes: Buffer.from(stream.bytes, "base64url").toString(),
    });
    this.deliveredOperationIds.push(stream.operationId);
  }
  async query(afterStreamSeq: number) {
    const query: AgentHostOperationQuery = {
      operationId: spec.initialOperation.operationId,
      kind: descriptor.kind,
      descriptorDigest,
      payloadDigest: digest("d"),
      afterStreamSeq,
    };
    await this.transport!.queryOperation(query);
  }
  async cancelOperation() {
    await this.transport!.cancelOperation({
      operationId: spec.initialOperation.operationId,
      cancelId: "cancel-transport-1",
      reason: "user",
    });
  }
  finish(status: AgentTurnResult = { status: "completed" }) {
    this.result.resolve(status);
  }
  async cancel() {
    this.cancelCalls++;
  }
  async shutdown() {
    this.shutdownCalls++;
  }
}

function signing() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = "transport-supervision-key-1";
  const signer = createAgentHostSupervisionSigner({
    keyId,
    privateKeyPkcs8: Uint8Array.from(
      privateKey.export({ type: "pkcs8", format: "der" }) as Buffer,
    ),
    publicKeySpki: Uint8Array.from(
      publicKey.export({ type: "spki", format: "der" }) as Buffer,
    ),
    signingNotBeforeMs: startedAt - 60_000,
    signingNotAfterMs: startedAt + 3_600_000,
    verifyUntilMs: startedAt + 7_200_000,
    status: "active",
  });
  const keyring: AgentHostSupervisionPublicKeyringV2 = {
    version: 2,
    algorithm: AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM,
    domain: AGENT_HOST_SUPERVISION_SIGNATURE_DOMAIN,
    keys: [
      {
        keyId,
        status: "active",
        publicKeySpki: (
          publicKey.export({ type: "spki", format: "der" }) as Buffer
        ).toString("base64url"),
        signingNotBeforeMs: startedAt - 60_000,
        signingNotAfterMs: startedAt + 3_600_000,
        verifyUntilMs: startedAt + 7_200_000,
      },
    ],
  };
  let epoch = 0;
  return {
    keyring,
    obtainSignedAttach: async (challenge: AgentHostChallengeDescriptorV4) => {
      const issuedAtMs = Date.now();
      const expected = {
        fence,
        planHash,
        ...challenge,
        supervisorEpoch: ++epoch,
        kernelServiceEpoch: `transport-kernel-${epoch}`,
        nonce: `transport-${crypto.randomUUID()}`,
        audience: AGENT_HOST_SUPERVISION_AUDIENCE,
        purpose: AGENT_HOST_SUPERVISION_PURPOSE,
        keyId,
        issuedAtMs,
        expiresAtMs: issuedAtMs + 60_000,
      };
      return {
        expected,
        envelope: signer.sign(
          serializeAgentHostSupervisionAuthorityV2({ version: 2, ...expected }),
          issuedAtMs,
        ),
      };
    },
  };
}

function operationReceipt(
  state: AgentOperationReceiptV1["state"],
  operationId = spec.initialOperation.operationId,
  operationDescriptorDigest = descriptorDigest,
): AgentOperationReceiptV1 {
  const terminal = state === "settled";
  const terminalRef = {
    appendId: "append-transport-1",
    entryIds: ["entry-output-transport-1"],
    firstSeq: 5,
    lastSeq: 5,
    throughChangeSeq: 5,
    requestDigest: digest("9"),
  };
  return {
    version: 1,
    operationId,
    kind: descriptor.kind,
    fence,
    planHash,
    authorityHash: digest("c"),
    descriptorDigest: operationDescriptorDigest,
    payloadDigest: digest("d"),
    actorIdentity: {
      supervisorEpoch: 1,
      hostId: "agent-host-transport-1",
      hostGeneration: 1,
      hostIncarnation: "transport-incarnation-1",
      transcriptAnchor: descriptor.transcript,
    },
    state,
    acceptedAtMs: startedAt,
    ...(state === "prepared" ? {} : { executingAtMs: startedAt + 1 }),
    ...(terminal
      ? {
          completedAtMs: startedAt + 2,
          outcome: { status: "succeeded" as const, code: "ok" as const },
          transcriptRefs: [terminalRef],
          kernelTerminal: {
            outputDigest: digest("e"),
            outcomeCode: "ok",
            transcriptRefs: [terminalRef],
            pendingToolUseEntryIds: [],
          },
        }
      : {}),
    providerRef: { adapterId: "opaque-test", adapterVersion: "1" },
  };
}

const resources: {
  host: AgentHost;
  root: string;
  clients: AgentHostClient[];
}[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    for (const client of resource.clients) client.close();
    await resource.host.stop();
    await rm(resource.root, { recursive: true, force: true });
  }
});

type SetupOptions = {
  chunks?: string[];
  chunkSource?: AsyncIterable<Uint8Array>;
  settleQueries?: boolean;
  twoOperations?: boolean;
  dispatchGates?: Map<string, ReturnType<typeof deferred<void>>>;
  failpoint?: ConstructorParameters<typeof AgentHostClient>[0]["failpoint"];
  acknowledgeOperationStream?: ConstructorParameters<
    typeof AgentHostClient
  >[0]["acknowledgeOperationStream"];
  hostFailpoint?: ConstructorParameters<typeof AgentHost>[0]["failpoint"];
};
async function setup(options: SetupOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "agent-host-transport-"));
  const socketPath = join(root, "host.sock");
  const driver = new FakeDriver(options.twoOperations);
  const signature = signing();
  const host = createAgentHost({
    socketPath,
    createDriver: () => driver,
    hostId: "agent-host-transport-1",
    hostGeneration: 1,
    hostIncarnation: "transport-incarnation-1",
    supervisionKeyring: signature.keyring,
    reconnectGraceMs: 2_000,
    failpoint: options.hostFailpoint,
  });
  const dispatchIntents: unknown[] = [];
  const queryIntents: any[] = [];
  const cancelIntents: unknown[] = [];
  const streamAckIntents: unknown[] = [];
  const terminalEvents: AgentHostTurnTerminalV5[] = [];
  const errors: Error[] = [];
  let dispatches = 0;
  const clients: AgentHostClient[] = [];
  const client = new AgentHostClient({
    socketPath,
    obtainSignedAttach: signature.obtainSignedAttach,
    dispatchOperation: async (intent) => {
      dispatches++;
      dispatchIntents.push(intent);
      await options.dispatchGates?.get(intent.operationId)?.promise;
      return {
        receipt: operationReceipt(
          "executing",
          intent.operationId,
          intent.descriptorDigest,
        ),
        chunks:
          options.chunkSource ??
          (options.chunks ?? ["one", "two"]).map((value) => Buffer.from(value)),
      };
    },
    queryOperation: async (intent) => {
      queryIntents.push(intent);
      return {
        receipt: operationReceipt(
          intent.recovery || options.settleQueries === false
            ? "executing"
            : "settled",
          intent.operationId,
          intent.descriptorDigest,
        ),
        fromStreamSeq: intent.afterStreamSeq + 1,
        chunks: intent.recovery
          ? (options.chunks ?? ["one", "two"])
              .slice(intent.afterStreamSeq)
              .map((value) => Buffer.from(value))
          : [],
      };
    },
    cancelOperation: async (intent) => {
      cancelIntents.push(intent);
      return {
        disposition: "indeterminate",
        receipt: {
          ...operationReceipt(
            "executing",
            intent.operationId,
            intent.descriptorDigest,
          ),
          state: "indeterminate",
          completedAtMs: Date.now(),
          kernelTerminal: {
            outputDigest: digest("f"),
            outcomeCode: "cancellation_ambiguous",
            transcriptRefs: [
              {
                appendId: "append-transport-1",
                entryIds: ["entry-output-transport-1"],
                firstSeq: 5,
                lastSeq: 5,
                throughChangeSeq: 5,
                requestDigest: digest("9"),
              },
            ],
            pendingToolUseEntryIds: [],
          },
          transcriptRefs: [
            {
              appendId: "append-transport-1",
              entryIds: ["entry-output-transport-1"],
              firstSeq: 5,
              lastSeq: 5,
              throughChangeSeq: 5,
              requestDigest: digest("9"),
            },
          ],
          errorCode: "cancellation_ambiguous",
        } as AgentOperationReceiptV1,
      };
    },
    acknowledgeOperationStream: async (intent) => {
      streamAckIntents.push(intent);
      await options.acknowledgeOperationStream?.(intent);
    },
    onTurnTerminal: async (terminal) => {
      terminalEvents.push(terminal);
    },
    failpoint: options.failpoint,
    onError: (error) => errors.push(error),
  });
  clients.push(client);
  resources.push({ host, root, clients });
  await host.start();
  return {
    client,
    host,
    driver,
    dispatchIntents,
    queryIntents,
    cancelIntents,
    streamAckIntents,
    terminalEvents,
    errors,
    clients,
    get dispatches() {
      return dispatches;
    },
  };
}

function assertNoForbiddenAuthority(value: unknown) {
  const serialized = JSON.stringify(value).toLowerCase();
  for (const forbidden of [
    "prompt",
    "providerconfig",
    "mcp",
    "credential",
    "https://",
    "authorization",
    "cookie",
    "process.env",
    "executorgrant",
  ])
    expect(serialized).not.toContain(forbidden);
}

describe("Agent Host v5 end-to-end transport", () => {
  test("Driver consumption and durable coordinator ACK gate live publication", async () => {
    const driverGate = deferred();
    const coordinatorGate = deferred();
    let coordinatorAckStarted = false;
    let publicationResolved = false;
    const harness = await setup({
      chunks: ["published"],
      acknowledgeOperationStream: async () => {
        coordinatorAckStarted = true;
        await coordinatorGate.promise;
        publicationResolved = true;
      },
    });
    harness.driver.deliveryGates.set(1, driverGate);

    await harness.client.connect(fence, planHash);
    await harness.client.startTurn(spec);
    await eventually(
      () => harness.driver.deliveryStarted.includes(1),
      "stream chunk was not written through to the Host",
    );
    expect(harness.driver.delivered).toEqual([]);
    expect(coordinatorAckStarted).toBe(false);
    expect(publicationResolved).toBe(false);

    driverGate.resolve();
    await eventually(
      () => coordinatorAckStarted,
      "Host consumption did not produce a coordinator ACK",
    );
    expect(publicationResolved).toBe(false);
    expect(harness.streamAckIntents).toEqual([
      {
        operationId: spec.initialOperation.operationId,
        fence,
        kind: descriptor.kind,
        descriptorDigest,
        throughStreamSeq: 1,
      },
    ]);
    expect(Object.isFrozen(harness.streamAckIntents[0])).toBe(true);
    expect(Object.isFrozen((harness.streamAckIntents[0] as any).fence)).toBe(
      true,
    );
    assertNoForbiddenAuthority(harness.streamAckIntents);

    coordinatorGate.resolve();
    await eventually(
      () => publicationResolved,
      "durable coordinator ACK did not release publication",
    );
    expect(harness.errors).toEqual([]);
  });

  test("coordinator ACK rejection closes uncertain without pulling a fallback chunk", async () => {
    const publication = deferred();
    let chunksPulled = 0;
    async function* chunks() {
      chunksPulled++;
      yield Buffer.from("first");
      await publication.promise;
      chunksPulled++;
      yield Buffer.from("fallback");
    }
    const harness = await setup({
      chunkSource: chunks(),
      acknowledgeOperationStream: async () => {
        publication.reject(new Error("coordinator stream ACK rejected"));
        throw new Error("coordinator stream ACK rejected");
      },
    });

    await harness.client.connect(fence, planHash);
    await harness.client.startTurn(spec);
    await eventually(
      () =>
        harness.errors.some((error) =>
          error.message.includes("coordinator stream ACK rejected"),
        ),
      "coordinator ACK rejection did not close the client",
    );
    expect(chunksPulled).toBe(1);
    expect(harness.driver.delivered).toEqual([{ seq: 1, bytes: "first" }]);
    expect(harness.queryIntents).toEqual([]);
    expect(
      (harness.client as any).operations.get(spec.initialOperation.operationId)
        .uncertain,
    ).toBe(true);
  });

  test("fresh attach dispatches once, streams in order under consumption credit, and terminal waits for drain", async () => {
    const harness = await setup({ chunks: ["first", "second"] });
    const secondGate = deferred();
    harness.driver.deliveryGates.set(2, secondGate);

    await harness.client.connect(fence, planHash);
    await harness.client.startTurn(spec);
    await eventually(
      () =>
        harness.driver.deliveryStarted.includes(2) || harness.errors.length > 0,
      "second stream chunk was not offered to the Driver",
    );
    expect(harness.errors).toEqual([]);
    expect(harness.dispatches).toBe(1);
    expect(harness.driver.delivered).toEqual([{ seq: 1, bytes: "first" }]);

    await harness.driver.query(2);
    harness.driver.finish();
    await Promise.resolve();
    expect(harness.errors).toEqual([]);

    secondGate.resolve();
    await eventually(
      () => harness.driver.delivered.length === 2,
      "stream did not drain",
    );
    await eventually(
      () =>
        harness.errors.some((error) =>
          error.message.includes("disconnected"),
        ) || !(harness.host as any).active,
      "terminal receipt did not complete the drained turn",
    );
    expect((harness.host as any).active).toBeUndefined();
    expect(harness.terminalEvents).toHaveLength(1);
    expect(harness.client.getTurnTerminal()).toBe(harness.terminalEvents[0]);
    expect(await harness.client.waitForTurnTerminal()).toBe(harness.terminalEvents[0]);
    expect(harness.terminalEvents[0]).toMatchObject({
      result: { status: "completed" },
      hostGeneration: 1,
      operations: [{ operationId: spec.initialOperation.operationId, throughStreamSeq: 2 }],
    });
    expect(harness.driver.delivered).toEqual([
      { seq: 1, bytes: "first" },
      { seq: 2, bytes: "second" },
    ]);
    expect(harness.queryIntents).toHaveLength(1);
    expect(harness.queryIntents[0].afterStreamSeq).toBe(2);
    assertNoForbiddenAuthority({
      spec,
      dispatchIntents: harness.dispatchIntents,
      queryIntents: harness.queryIntents,
    });
  });

  test("binds concurrent operation, query, and cancel receipts to their exact Host intents", async () => {
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const harness = await setup({
      chunks: [],
      settleQueries: false,
      twoOperations: true,
      dispatchGates: new Map([
        [spec.initialOperation.operationId, firstGate],
        ["operation-transport-2", secondGate],
      ]),
    });

    await harness.client.connect(fence, planHash);
    await harness.client.startTurn(spec);
    await eventually(
      () => harness.dispatches === 2,
      "operations did not overlap",
    );

    secondGate.resolve();
    await eventually(
      () =>
        (harness.host as any).active?.ops.get("operation-transport-2")?.receipt
          ?.state === "executing",
      "second operation receipt used the wrong Host sequence",
    );
    firstGate.resolve();
    await eventually(
      () =>
        (harness.host as any).active?.ops.get(spec.initialOperation.operationId)
          ?.receipt?.state === "executing",
      "first operation receipt used another operation's Host sequence",
    );

    const transport = harness.driver.transport!;
    await Promise.all([
      transport.queryOperation({
        operationId: spec.initialOperation.operationId,
        kind: descriptor.kind,
        descriptorDigest,
        payloadDigest: digest("d"),
        afterStreamSeq: 0,
      }),
      transport.queryOperation({
        operationId: spec.initialOperation.operationId,
        kind: descriptor.kind,
        descriptorDigest,
        payloadDigest: digest("d"),
        afterStreamSeq: 0,
      }),
      transport.cancelOperation({
        operationId: "operation-transport-2",
        cancelId: "cancel-transport-2",
        reason: "user",
      }),
    ]);
    await eventually(
      () =>
        harness.queryIntents.length === 2 && harness.cancelIntents.length === 1,
      "query/cancel intents were not acknowledged",
    );
    expect(harness.errors).toEqual([]);
    expect(harness.dispatches).toBe(2);
    expect(
      (harness.host as any).active.ops.get("operation-transport-2").receipt
        .state,
    ).toBe("indeterminate");
  });

  test.each([
    "after_host_message",
    "after_coordinator_result",
    "before_receipt_write",
    "after_receipt_write",
    "after_stream_chunk",
  ] as const)(
    "client crash at %s resumes by query without physical relaunch",
    async (point) => {
      let crashed = false;
      let hostMessages = 0;
      const harness = await setup({
        chunks: ["only"],
        twoOperations: true,
        failpoint: (candidate) => {
          if (candidate === "after_host_message") hostMessages++;
          const armed =
            candidate === point &&
            (candidate !== "after_host_message" || hostMessages > 3);
          if (!crashed && armed) {
            crashed = true;
            throw new Error(`crash:${point}`);
          }
        },
      });
      await harness.client.connect(fence, planHash);
      await harness.client.startTurn(spec).catch(() => {});
      await eventually(
        () =>
          harness.errors.some((error) =>
            error.message.includes(`crash:${point}`),
          ),
        `failpoint ${point} did not disconnect the gateway client`,
      );

      await harness.client.connect(fence, planHash);
      await eventually(
        () => harness.dispatches === 2,
        `failpoint ${point} did not recover both operations`,
      );
      expect(harness.dispatches).toBe(2);
      expect(
        new Set(
          harness.dispatchIntents.map((intent: any) => intent.operationId),
        ),
      ).toEqual(
        new Set([spec.initialOperation.operationId, "operation-transport-2"]),
      );
      expect(harness.queryIntents.every((intent) => intent.recovery)).toBe(
        true,
      );
    },
  );

  test("Host recovers coordinator state as well as owed Driver-consumption credit", async () => {
    let failed = false;
    const harness = await setup({
      chunks: ["only"],
      twoOperations: true,
      hostFailpoint: (point) => {
        if (point === "afterDriverDeliveryBeforeStreamAck" && !failed) {
          failed = true;
          throw new Error("crash:driver-consumption-ack");
        }
      },
    });

    await harness.client.connect(fence, planHash);
    await harness.client.startTurn(spec);
    await eventually(
      () => failed,
      "Driver-consumption ACK failpoint was not reached",
    );
    await eventually(
      () => harness.errors.length > 0,
      "Driver-consumption ACK failpoint did not detach the client",
    );
    await harness.client.connect(fence, planHash);
    await eventually(
      () =>
        harness.queryIntents.filter((intent) => intent.recovery).length === 2,
      "Host did not query both operations while restoring owed credit",
    );

    expect(harness.dispatches).toBe(2);
    expect(
      harness.driver.deliveredOperationIds.filter(
        (operationId) => operationId === spec.initialOperation.operationId,
      ),
    ).toHaveLength(1);
    expect(harness.queryIntents.every((intent) => intent.recovery)).toBe(true);
    for (const op of (harness.host as any).active.ops.values()) {
      expect(op.owedCreditBytes).toBe(0);
      expect(op.owedCreditChunks).toBe(0);
    }
  });

  test("bounds replay while repeated real queries preserve one physical dispatch", async () => {
    const harness = await setup({ chunks: [], settleQueries: false });
    await harness.client.connect(fence, planHash);
    await harness.client.startTurn(spec);
    await eventually(
      () =>
        (harness.host as any).active?.ops.get(spec.initialOperation.operationId)
          ?.receipt?.state === "executing",
      "initial executing receipt was not accepted",
    );

    for (let index = 0; index < MAX_AGENT_HOST_REPLAY_FRAMES + 32; index++)
      await harness.driver.query(0);
    await eventually(
      () => harness.queryIntents.length === MAX_AGENT_HOST_REPLAY_FRAMES + 32,
      "repeated queries did not traverse the real transport",
    );

    const active = (harness.host as any).active;
    expect(active.replay.length).toBeLessThanOrEqual(
      MAX_AGENT_HOST_REPLAY_FRAMES,
    );
    expect(active.replayBytes).toBeLessThanOrEqual(MAX_AGENT_HOST_REPLAY_BYTES);
    expect(harness.dispatches).toBe(1);
  });

  test("query and cancellation receipts stay monotonic and cancellation remains uncertain", async () => {
    const harness = await setup({ chunks: [], settleQueries: false });
    await harness.client.connect(fence, planHash);
    await harness.client.startTurn(spec);
    await eventually(
      () => harness.dispatches === 1,
      "operation was not dispatched",
    );

    await harness.driver.query(0);
    await eventually(
      () => harness.queryIntents.length === 1,
      "operation query was not dispatched",
    );
    await harness.driver.cancelOperation();
    await eventually(
      () => harness.cancelIntents.length === 1,
      "operation cancellation was not dispatched",
    );
    harness.driver.finish();

    expect(harness.dispatches).toBe(1);
    expect(harness.cancelIntents).toHaveLength(1);
    expect(JSON.stringify(harness.cancelIntents[0])).not.toContain("cancelled");
    expect(harness.driver.cancelCalls).toBe(0);
  });
});
