import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashAgentOperationDescriptorV1,
  type AgentOperationReceiptV1,
} from "@tellahq/opensession-protocol";
import {
  AgentHostClient,
  decodeAgentHostServerMessageV5,
} from "./agent-host-client";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const fence = {
  sessionId: "session-1",
  runId: "run-1",
  turnId: "turn-1",
  generation: 1,
} as const;
const descriptor = {
  version: 1,
  kind: "model",
  stepId: "step-1",
  transcript: {
    throughChangeSeq: 1,
    entryIds: ["entry-1"],
    digest: digest("c"),
  },
  modelPolicyHash: digest("d"),
  adapterRequestVersion: "v1",
} as const;

function receipt(
  descriptorDigest: `sha256:${string}`,
): AgentOperationReceiptV1 {
  return {
    version: 1,
    operationId: "operation-1",
    kind: "model",
    fence,
    planHash: digest("a"),
    authorityHash: digest("b"),
    descriptorDigest,
    payloadDigest: digest("e"),
    actorIdentity: {
      supervisorEpoch: 1,
      hostId: "host-000000000001",
      hostGeneration: 1,
      hostIncarnation: "incarnation-0001",
      transcriptAnchor: descriptor.transcript,
    },
    state: "prepared",
    acceptedAtMs: 1,
    providerRef: { adapterId: "adapter-1", adapterVersion: "v1" },
  };
}

async function rawHost(onFrame: (frame: any, socket: Socket) => void) {
  const root = mkdtempSync(join(tmpdir(), "agent-host-client-"));
  roots.push(root);
  const socketPath = join(root, "host.sock");
  const server = createServer((socket) => {
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        onFrame(JSON.parse(line), socket);
      }
    });
  });
  await new Promise<void>((resolve, reject) =>
    server.listen(socketPath, resolve).once("error", reject),
  );
  return {
    socketPath,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
const send = (socket: Socket, value: unknown) =>
  socket.write(`${JSON.stringify(value)}\n`);

describe("AgentHostClient v5", () => {
  test("strictly decodes Host frames", async () => {
    const hello = {
      t: "hello",
      version: 5,
      requestId: "request-1",
      accepted: true,
      hostId: "host-000000000001",
      hostGeneration: 1,
      hostIncarnation: "incarnation-0001",
      hostChallenge: "challenge-00000001",
    } as const;
    expect(await decodeAgentHostServerMessageV5(hello)).toEqual(hello);
    expect(
      await decodeAgentHostServerMessageV5({ ...hello, provider: "forbidden" }),
    ).toBeUndefined();
    expect(
      await decodeAgentHostServerMessageV5({ ...hello, version: 4 }),
    ).toBeUndefined();
    const terminal = {
      t: "turn_terminal",
      version: 5,
      requestId: "terminal-1",
      fence,
      hostSeq: 2,
      hostGeneration: 1,
      hostIncarnation: "incarnation-0001",
      result: { status: "cancelled" },
      resultDigest: digest("f"),
      receiptsDigest: digest("9"),
      finalAckHostSeq: 1,
      operations: [],
    } as const;
    expect(await decodeAgentHostServerMessageV5(terminal)).toEqual(terminal);
    expect(await decodeAgentHostServerMessageV5({ ...terminal, fallback: true })).toBeUndefined();
  });

  test("dispatches descriptors through injected authority and streams opaque bytes", async () => {
    const descriptorDigest = await hashAgentOperationDescriptorV1(descriptor);
    const frames: any[] = [];
    let dispatches = 0;
    let resolveReceipt!: () => void;
    const gotReceipt = new Promise<void>((resolve) => {
      resolveReceipt = resolve;
    });
    const host = await rawHost((frame, socket) => {
      frames.push(frame);
      if (frame.t === "hello")
        send(socket, {
          t: "hello",
          version: 5,
          requestId: frame.requestId,
          accepted: true,
          hostId: "host-000000000001",
          hostGeneration: 1,
          hostIncarnation: "incarnation-0001",
          hostChallenge: "challenge-00000001",
        });
      if (frame.t === "attach") {
        send(socket, {
          t: "attached",
          version: 5,
          requestId: frame.requestId,
          fence,
          planHash: digest("a"),
          supervisorEpoch: 1,
          mode: "fresh",
          replayFromHostSeq: 1,
        });
        send(socket, {
          t: "operation_request",
          version: 5,
          requestId: "request-operation-1",
          fence,
          hostSeq: 1,
          operationId: "operation-1",
          descriptor,
          descriptorDigest,
          deadlineMs: Date.now() + 60_000,
        });
      }
      if (frame.t === "operation_receipt") resolveReceipt();
    });
    const client = new AgentHostClient({
      socketPath: host.socketPath,
      obtainSignedAttach: async () =>
        ({
          expected: { supervisorEpoch: 1 },
          envelope: {
            version: 1,
            algorithm: "Ed25519",
            domain: "opensession.agent-host.supervision.v2",
            authorityBytes: "AQ",
            signature: Buffer.alloc(64).toString("base64url"),
          },
        }) as any,
      dispatchOperation: async (intent) => {
        dispatches++;
        expect(intent.descriptor).toEqual(descriptor);
        expect(intent.descriptorDigest).toBe(descriptorDigest);
        return {
          receipt: receipt(descriptorDigest),
          chunks: [new Uint8Array([1, 2, 3])],
        };
      },
      queryOperation: async () => {
        throw new Error("unexpected query");
      },
      cancelOperation: async () => {
        throw new Error("unexpected cancel");
      },
      acknowledgeOperationStream: async () => {},
    });
    await client.connect(fence, digest("a"));
    await gotReceipt;
    expect(dispatches).toBe(1);
    expect(
      frames.find((frame) => frame.t === "operation_stream"),
    ).toMatchObject({
      operationId: "operation-1",
      streamSeq: 1,
      bytes: "AQID",
    });
    expect(
      frames.find((frame) => frame.t === "operation_receipt"),
    ).toMatchObject({ ackHostSeq: 1, operationId: "operation-1" });
    client.close();
    await host.close();
  });

  test("rejects stream gaps without dispatching", async () => {
    const descriptorDigest = await hashAgentOperationDescriptorV1(descriptor);
    let dispatches = 0;
    let sawError!: (error: Error) => void;
    const error = new Promise<Error>((resolve) => {
      sawError = resolve;
    });
    const host = await rawHost((frame, socket) => {
      if (frame.t === "hello")
        send(socket, {
          t: "hello",
          version: 5,
          requestId: frame.requestId,
          accepted: true,
          hostId: "host-000000000001",
          hostGeneration: 1,
          hostIncarnation: "incarnation-0001",
          hostChallenge: "challenge-00000001",
        });
      if (frame.t === "attach") {
        send(socket, {
          t: "attached",
          version: 5,
          requestId: frame.requestId,
          fence,
          planHash: digest("a"),
          supervisorEpoch: 1,
          mode: "fresh",
          replayFromHostSeq: 1,
        });
        send(socket, {
          t: "operation_request",
          version: 5,
          requestId: "request-operation-2",
          fence,
          hostSeq: 2,
          operationId: "operation-1",
          descriptor,
          descriptorDigest,
          deadlineMs: Date.now() + 60_000,
        });
      }
    });
    const client = new AgentHostClient({
      socketPath: host.socketPath,
      obtainSignedAttach: async () =>
        ({ expected: { supervisorEpoch: 1 }, envelope: {} }) as any,
      dispatchOperation: async () => {
        dispatches++;
        return { receipt: receipt(descriptorDigest) };
      },
      queryOperation: async () => {
        throw new Error("unexpected query");
      },
      cancelOperation: async () => {
        throw new Error("unexpected cancel");
      },
      acknowledgeOperationStream: async () => {},
      onError: sawError,
    });
    await client.connect(fence, digest("a"));
    expect((await error).message).toContain("stream gap");
    expect(dispatches).toBe(0);
    client.close();
    await host.close();
  });
});
