import { connect, type Socket } from "node:net";
import {
  AGENT_HOST_PROTOCOL_VERSION,
  INITIAL_AGENT_HOST_STREAM_BYTES,
  INITIAL_AGENT_HOST_STREAM_CHUNKS,
  decodeAgentHostAttached,
  decodeAgentHostTurnTerminal,
  decodeAgentHostOperationCancel,
  decodeAgentHostOperationQuery,
  decodeAgentHostOperationRequest,
  decodeAgentHostOperationStreamAck,
  decodeAgentHostTurnStarted,
  hashAgentOperationReceiptV1,
  hashAgentTurnTerminalReceiptsV1,
  decodeAgentOperationReceiptV1,
  decodeExecutorId,
  isAgentTurnFence,
  type AgentHostAttachResumeCursorV4,
  type AgentHostChallengeDescriptorV4,
  type AgentHostClientMessage,
  type AgentHostOperationCancelV4,
  type AgentHostOperationQueryV4,
  type AgentHostOperationRequestV4,
  type AgentHostOperationStreamAckV4,
  type AgentHostServerMessage,
  type AgentHostSignedAttachReceiptV4,
  type AgentHostTurnTerminalV5,
  type AgentHostTerminalOperationV5,
  type AgentOperationDescriptorV1,
  type AgentOperationDigest,
  type AgentOperationKind,
  type AgentOperationReceiptV1,
  type AgentTurnFence,
  type AgentTurnSpec,
  decodeAgentTurnSpec,
} from "@tellahq/opensession-protocol";
import type { SignedAgentHostSupervisionEnvelopeV1 } from "@tellahq/opensession-protocol/agent-host-supervision";
import {
  AGENT_HOST_MAX_FRAME_BYTES,
  BoundedNdjsonDecoder,
  encodeNdjsonFrame,
} from "../agent-host/socket-framing";

export type AgentHostClientFailpoint =
  | "after_host_message"
  | "after_coordinator_result"
  | "after_stream_chunk"
  | "before_receipt_write"
  | "after_receipt_write";

export interface AgentHostCoordinatorIntent {
  readonly operationId: string;
  readonly fence: Readonly<AgentTurnFence>;
  readonly kind: AgentOperationKind;
  readonly descriptorDigest: AgentOperationDigest;
  readonly supervisionEnvelope: SignedAgentHostSupervisionEnvelopeV1;
}
export interface AgentHostOperationStreamAckIntent {
  readonly operationId: string;
  readonly fence: Readonly<AgentTurnFence>;
  readonly kind: AgentOperationKind;
  readonly descriptorDigest: AgentOperationDigest;
  readonly throughStreamSeq: number;
}
export interface AgentHostDispatchIntent extends AgentHostCoordinatorIntent {
  readonly descriptor: AgentOperationDescriptorV1;
  readonly deadlineMs: number;
}
export interface AgentHostQueryIntent extends AgentHostCoordinatorIntent {
  readonly payloadDigest?: AgentOperationDigest;
  readonly afterStreamSeq: number;
  /** Present for exact recovery when the raw dispatch grant and payload digest are gone. */
  readonly descriptor?: AgentOperationDescriptorV1;
  readonly recovery: boolean;
}
export interface AgentHostCancelIntent extends AgentHostCoordinatorIntent {
  readonly cancelId: string;
  readonly reason: AgentHostOperationCancelV4["reason"];
}
export interface AgentHostOperationResult {
  readonly receipt: AgentOperationReceiptV1;
  readonly chunks?: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}
export interface AgentHostQueryResult extends AgentHostOperationResult {
  readonly fromStreamSeq: number;
}
export interface AgentHostCancelResult {
  readonly disposition:
    "not_started" | "cancelled" | "too_late" | "indeterminate";
  readonly receipt: AgentOperationReceiptV1;
}

export interface AgentHostClientOptions {
  readonly socketPath: string;
  readonly timeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly obtainSignedAttach: (
    challenge: Readonly<AgentHostChallengeDescriptorV4>,
    requested: Readonly<{ fence: AgentTurnFence; planHash: string }>,
  ) => Promise<AgentHostSignedAttachReceiptV4>;
  /** These callbacks are the only operation authority. The client never selects an adapter,
   * provider, model, MCP server, identity, or policy, and never creates a dispatch grant. */
  readonly dispatchOperation: (
    intent: Readonly<AgentHostDispatchIntent>,
    signal: AbortSignal,
  ) => Promise<AgentHostOperationResult>;
  readonly queryOperation: (
    intent: Readonly<AgentHostQueryIntent>,
    signal: AbortSignal,
  ) => Promise<AgentHostQueryResult>;
  readonly cancelOperation: (
    intent: Readonly<AgentHostCancelIntent>,
    signal: AbortSignal,
  ) => Promise<AgentHostCancelResult>;
  /** Durably advances coordinator publication only after the Host Driver has
   * consumed the cumulative operation stream prefix. */
  readonly acknowledgeOperationStream: (
    intent: Readonly<AgentHostOperationStreamAckIntent>,
  ) => Promise<void>;
  /** Resolves before the exact terminal frame is acknowledged to the Host. */
  readonly onTurnTerminal?: (
    terminal: Readonly<AgentHostTurnTerminalV5>,
  ) => void | Promise<void>;
  readonly onError?: (error: Error) => void;
  readonly failpoint?: (
    point: AgentHostClientFailpoint,
  ) => void | Promise<void>;
}

type ServerHello = Extract<AgentHostServerMessage, { t: "hello" }>;
type ServerError = Extract<AgentHostServerMessage, { t: "error" }>;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const id = (value: unknown): value is string =>
  typeof value === "string" && !!decodeExecutorId(value);
const sameFence = (a: Readonly<AgentTurnFence>, b: Readonly<AgentTurnFence>) =>
  a.sessionId === b.sessionId &&
  a.runId === b.runId &&
  a.turnId === b.turnId &&
  a.generation === b.generation;

/** Strict gateway-side v5 hello codec. */
export function decodeAgentHostServerHelloV5(
  value: unknown,
): ServerHello | undefined {
  if (
    !record(value) ||
    !exact(value, [
      "t",
      "version",
      "requestId",
      "accepted",
      "hostId",
      "hostGeneration",
      "hostIncarnation",
      "hostChallenge",
    ]) ||
    value.t !== "hello" ||
    value.version !== AGENT_HOST_PROTOCOL_VERSION ||
    !id(value.requestId) ||
    value.accepted !== true ||
    !id(value.hostId) ||
    !Number.isSafeInteger(value.hostGeneration) ||
    (value.hostGeneration as number) < 1 ||
    typeof value.hostIncarnation !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(value.hostIncarnation) ||
    typeof value.hostChallenge !== "string" ||
    !/^[A-Za-z0-9_-]{16,256}$/.test(value.hostChallenge)
  )
    return undefined;
  return Object.freeze(structuredClone(value)) as unknown as ServerHello;
}
/** Strict gateway-side v5 error codec. */
export function decodeAgentHostServerErrorV5(
  value: unknown,
): ServerError | undefined {
  if (!record(value)) return undefined;
  const keys = [
    "t",
    "version",
    "requestId",
    "code",
    "message",
    ...(value.fence === undefined ? [] : ["fence"]),
  ];
  if (
    !exact(value, keys) ||
    value.t !== "error" ||
    value.version !== AGENT_HOST_PROTOCOL_VERSION ||
    !id(value.requestId) ||
    ![
      "unsupported_version",
      "invalid_request",
      "stale_generation",
      "host_busy",
      "turn_failed",
    ].includes(String(value.code)) ||
    typeof value.message !== "string" ||
    (value.fence !== undefined && !isAgentTurnFence(value.fence))
  )
    return undefined;
  return Object.freeze(structuredClone(value)) as unknown as ServerError;
}
/** Strict decoder for every Host-to-gateway v5 frame. */
export async function decodeAgentHostServerMessageV5(
  value: unknown,
  nowMs = Date.now(),
  turnDeadlineMs?: number,
): Promise<AgentHostServerMessage | undefined> {
  return (
    decodeAgentHostServerHelloV5(value) ??
    decodeAgentHostAttached(value) ??
    decodeAgentHostTurnStarted(value) ??
    decodeAgentHostTurnTerminal(value) ??
    (await decodeAgentHostOperationRequest(value, nowMs, turnDeadlineMs)) ??
    decodeAgentHostOperationQuery(value) ??
    decodeAgentHostOperationCancel(value) ??
    decodeAgentHostOperationStreamAck(value) ??
    decodeAgentHostServerErrorV5(value)
  );
}

interface PendingRequest {
  expected: "hello" | "attached" | "turn_started";
  resolve: (message: AgentHostServerMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface OperationState {
  readonly operationId: string;
  readonly kind: AgentOperationKind;
  readonly descriptorDigest: AgentOperationDigest;
  readonly descriptor?: AgentOperationDescriptorV1;
  payloadDigest?: AgentOperationDigest;
  receipt?: AgentOperationReceiptV1;
  receiptRank: number;
  throughStreamSeq: number;
  sentStreamSeq: number;
  creditBytes: number;
  creditChunks: number;
  waiters: Set<() => void>;
  launched: boolean;
  uncertain: boolean;
}

export class AgentHostClient {
  private socket?: Socket;
  private connecting?: Promise<void>;
  private fence?: AgentTurnFence;
  private planHash?: string;
  private receipt?: AgentHostSignedAttachReceiptV4;
  private turnDeadlineMs = Number.MAX_SAFE_INTEGER;
  private ready = false;
  private closed = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly operations = new Map<string, OperationState>();
  private readonly consumedHostSeq = new Set<number>();
  private lastHostSeq = 0;
  private highestHostSeq = 0;
  private requestSequence = 0;
  private receiveChain = Promise.resolve();
  private generation = 0;
  private terminal?: AgentHostTurnTerminalV5;
  private terminalNotified = false;
  private readonly terminalWaiters = new Set<{
    resolve: (terminal: Readonly<AgentHostTurnTerminalV5>) => void;
    reject: (error: Error) => void;
  }>();

  constructor(private readonly options: AgentHostClientOptions) {}

  connect(fence: AgentTurnFence, planHash: string): Promise<void> {
    if (!isAgentTurnFence(fence) || !/^sha256:[a-f0-9]{64}$/.test(planHash))
      throw new Error("Invalid Agent Host attachment request");
    if (this.closed) throw new Error("Agent Host client is closed");
    if (
      this.fence &&
      (!sameFence(this.fence, fence) || this.planHash !== planHash)
    )
      throw new Error("Agent Host client is attached to another turn");
    if (this.connecting) return this.connecting;
    if (this.ready && this.socket && !this.socket.destroyed)
      return Promise.resolve();
    this.fence = { ...fence };
    this.planHash = planHash;
    const generation = ++this.generation;
    this.connecting = this.open(generation).finally(() => {
      if (generation === this.generation) this.connecting = undefined;
    });
    return this.connecting;
  }

  private open(generation: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = connect(this.options.socketPath);
      const decoder = new BoundedNdjsonDecoder(
        this.options.maxFrameBytes ?? AGENT_HOST_MAX_FRAME_BYTES,
      );
      this.socket = socket;
      this.ready = false;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve();
      };
      const fail = (error: Error) => {
        if (generation !== this.generation) return;
        this.disconnect(socket, error);
        finish(error);
      };
      socket.on(
        "connect",
        () =>
          void (async () => {
            try {
              const hello = await this.request("hello", {
                t: "hello",
                version: AGENT_HOST_PROTOCOL_VERSION,
                requestId: this.nextRequestId(),
              });
              if (hello.t !== "hello")
                throw new Error("Agent Host hello mismatch");
              const requested = Object.freeze({
                fence: Object.freeze({ ...this.fence! }),
                planHash: this.planHash!,
              });
              const receipt = await this.options.obtainSignedAttach(
                Object.freeze({
                  hostId: hello.hostId,
                  hostGeneration: hello.hostGeneration,
                  hostIncarnation: hello.hostIncarnation,
                  hostChallenge: hello.hostChallenge,
                }),
                requested,
              );
              const resume = this.resumeCursor();
              const attached = await this.request("attached", {
                t: "attach",
                version: AGENT_HOST_PROTOCOL_VERSION,
                requestId: this.nextRequestId(),
                fence: requested.fence,
                planHash: requested.planHash as AgentOperationDigest,
                receipt,
                resume,
              });
              if (
                attached.t !== "attached" ||
                !sameFence(attached.fence, requested.fence) ||
                attached.planHash !== requested.planHash ||
                attached.supervisorEpoch !== receipt.expected.supervisorEpoch
              )
                throw new Error("Agent Host attach acknowledgement mismatch");
              this.receipt = receipt;
              if (attached.mode === "recovery_required") {
                const recoveryBaseline = attached.replayFromHostSeq - 1;
                if (recoveryBaseline < this.lastHostSeq)
                  throw new Error("Agent Host recovery baseline regressed");
                this.consumedHostSeq.clear();
                this.lastHostSeq = recoveryBaseline;
                this.highestHostSeq = recoveryBaseline;
              }
              this.ready = true;
              if (this.terminal) this.writeTerminalAck(this.terminal);
              finish();
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
            }
          })(),
      );
      socket.on("data", (chunk) => {
        try {
          for (const value of decoder.push(Buffer.from(chunk)))
            this.receiveChain = this.receiveChain
              .then(() => this.receive(socket, generation, value))
              .catch((error) =>
                fail(error instanceof Error ? error : new Error(String(error))),
              );
        } catch {
          fail(new Error("Malformed Agent Host frame"));
        }
      });
      socket.on("end", () => {
        try {
          decoder.finish();
        } catch {
          fail(new Error("Malformed Agent Host frame"));
        }
      });
      socket.on("error", fail);
      socket.on("close", () => fail(new Error("Agent Host disconnected")));
    });
  }

  async startTurn(spec: AgentTurnSpec): Promise<void> {
    if (!this.ready || !this.fence || !this.planHash)
      throw new Error("Agent Host handshake is not complete");
    const decoded = decodeAgentTurnSpec(spec);
    if (!decoded || !sameFence(decoded.fence, this.fence))
      throw new Error("Invalid Agent Host turn specification");
    this.turnDeadlineMs = decoded.limits.turnDeadlineMs;
    const result = await this.request("turn_started", {
      t: "start_turn",
      version: AGENT_HOST_PROTOCOL_VERSION,
      requestId: this.nextRequestId(),
      planHash: this.planHash as AgentOperationDigest,
      spec: decoded,
    });
    if (result.t !== "turn_started")
      throw new Error("Agent Host turn start mismatch");
  }

  getTurnTerminal(): Readonly<AgentHostTurnTerminalV5> | undefined {
    return this.terminal;
  }

  waitForTurnTerminal(): Promise<Readonly<AgentHostTurnTerminalV5>> {
    if (this.terminal) return Promise.resolve(this.terminal);
    if (this.closed)
      return Promise.reject(new Error("Agent Host client is closed"));
    return new Promise((resolve, reject) =>
      this.terminalWaiters.add({ resolve, reject }),
    );
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.terminalWaiters)
      waiter.reject(new Error("Agent Host client is closed"));
    this.terminalWaiters.clear();
    this.generation++;
    if (this.socket)
      this.disconnect(this.socket, new Error("Agent Host client closed"));
  }

  private resumeCursor(): AgentHostAttachResumeCursorV4 | null {
    if (!this.lastHostSeq && !this.operations.size) return null;
    return {
      lastHostSeq: this.lastHostSeq,
      operations: [...this.operations.values()]
        .map((op) => ({
          operationId: op.operationId,
          throughStreamSeq: op.throughStreamSeq,
        }))
        .sort((a, b) => a.operationId.localeCompare(b.operationId)),
    };
  }

  private async receive(
    socket: Socket,
    generation: number,
    raw: unknown,
  ): Promise<void> {
    if (socket !== this.socket || generation !== this.generation) return;
    const message = await decodeAgentHostServerMessageV5(
      raw,
      Date.now(),
      this.turnDeadlineMs,
    );
    if (!message) throw new Error("Invalid Agent Host message");
    await this.options.failpoint?.("after_host_message");
    const pending = this.pending.get(message.requestId);
    if (message.t === "error") {
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.requestId);
        pending.reject(new Error(`${message.code}: ${message.message}`));
      } else
        this.options.onError?.(
          new Error(`${message.code}: ${message.message}`),
        );
      return;
    }
    if (message.t === "hello" || message.t === "attached") {
      if (pending && pending.expected === message.t) {
        clearTimeout(pending.timer);
        this.pending.delete(message.requestId);
        pending.resolve(message);
      }
      return;
    }
    if (!this.fence || !sameFence(this.fence, message.fence))
      throw new Error("Stale Agent Host fence");
    if (message.hostSeq <= this.highestHostSeq) return;
    if (message.hostSeq !== this.highestHostSeq + 1)
      throw new Error("Agent Host stream gap requires recovery");
    this.highestHostSeq = message.hostSeq;
    if (message.t === "turn_started") {
      if (this.markConsumed(message.hostSeq))
        this.writeConsumptionAck(generation);
      if (pending && pending.expected === message.t) {
        clearTimeout(pending.timer);
        this.pending.delete(message.requestId);
        pending.resolve(message);
      }
      return;
    }
    if (message.t === "turn_terminal") {
      await this.consumeTerminal(message, generation);
      return;
    }
    if (message.t === "operation_stream_ack") {
      await this.consumeStreamAck(message);
      if (this.markConsumed(message.hostSeq))
        this.writeConsumptionAck(generation);
      return;
    }
    void this.consumeIntent(message, generation).catch((error) =>
      this.desynchronize(
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
  }

  private async consumeIntent(
    message:
      | AgentHostOperationRequestV4
      | AgentHostOperationQueryV4
      | AgentHostOperationCancelV4,
    generation: number,
  ): Promise<void> {
    const op = this.operationFor(message);
    const signal = new AbortController().signal;
    if (message.t === "operation_request") {
      const repeated = op.launched;
      op.launched = true;
      if (repeated) {
        const result = await this.options.queryOperation(
          this.queryIntent(op, op.throughStreamSeq, true),
          signal,
        );
        await this.options.failpoint?.("after_coordinator_result");
        await this.sendResult(
          op,
          result,
          "operation_query_receipt",
          message.hostSeq,
          generation,
        );
        op.uncertain = false;
      } else {
        const result = await this.options.dispatchOperation(
          Object.freeze({
            ...this.intent(op),
            descriptor: message.descriptor,
            deadlineMs: message.deadlineMs,
          }),
          signal,
        );
        await this.options.failpoint?.("after_coordinator_result");
        await this.sendResult(
          op,
          { ...result, fromStreamSeq: op.sentStreamSeq + 1 },
          "operation_receipt",
          message.hostSeq,
          generation,
        );
      }
    } else if (message.t === "operation_query") {
      op.payloadDigest = message.payloadDigest;
      const result = await this.options.queryOperation(
        this.queryIntent(op, message.afterStreamSeq, op.uncertain),
        signal,
      );
      await this.options.failpoint?.("after_coordinator_result");
      await this.sendResult(
        op,
        result,
        "operation_query_receipt",
        message.hostSeq,
        generation,
      );
      op.uncertain = false;
    } else {
      const result = await this.options.cancelOperation(
        Object.freeze({
          ...this.intent(op),
          cancelId: message.cancelId,
          reason: message.reason,
        }),
        signal,
      );
      await this.options.failpoint?.("after_coordinator_result");
      this.acceptReceipt(op, result.receipt);
      await this.writeReceipt(
        {
          t: "operation_cancel_receipt",
          version: AGENT_HOST_PROTOCOL_VERSION,
          requestId: this.nextRequestId(),
          fence: this.fence!,
          ackHostSeq: message.hostSeq,
          operationId: op.operationId,
          cancelId: message.cancelId,
          disposition: result.disposition,
          receipt: result.receipt,
        },
        generation,
      );
      if (this.markConsumed(message.hostSeq))
        this.writeConsumptionAck(generation);
      op.uncertain = false;
    }
  }

  private operationFor(
    message:
      | AgentHostOperationRequestV4
      | AgentHostOperationQueryV4
      | AgentHostOperationCancelV4,
  ): OperationState {
    const existing = this.operations.get(message.operationId);
    if (existing) {
      if (
        existing.descriptorDigest !==
          ("descriptorDigest" in message
            ? message.descriptorDigest
            : existing.descriptorDigest) ||
        ("kind" in message && existing.kind !== message.kind) ||
        (message.t === "operation_request" &&
          JSON.stringify(existing.descriptor) !==
            JSON.stringify(message.descriptor))
      )
        throw new Error("Agent Host operation descriptor identity changed");
      return existing;
    }
    if (message.t === "operation_cancel")
      throw new Error("Agent Host cancelled an unknown operation");
    const op: OperationState = {
      operationId: message.operationId,
      kind:
        message.t === "operation_request"
          ? message.descriptor.kind
          : message.kind,
      descriptorDigest: message.descriptorDigest,
      ...(message.t === "operation_request"
        ? { descriptor: message.descriptor }
        : {}),
      ...(message.t === "operation_query"
        ? { payloadDigest: message.payloadDigest }
        : {}),
      receiptRank: -1,
      throughStreamSeq:
        message.t === "operation_query" ? message.afterStreamSeq : 0,
      sentStreamSeq:
        message.t === "operation_query" ? message.afterStreamSeq : 0,
      creditBytes: INITIAL_AGENT_HOST_STREAM_BYTES,
      creditChunks: INITIAL_AGENT_HOST_STREAM_CHUNKS,
      waiters: new Set(),
      launched: message.t === "operation_query",
      uncertain: false,
    };
    this.operations.set(op.operationId, op);
    return op;
  }

  private intent(op: OperationState): AgentHostCoordinatorIntent {
    if (!this.fence || !this.receipt)
      throw new Error("Agent Host supervision unavailable");
    return Object.freeze({
      operationId: op.operationId,
      fence: Object.freeze({ ...this.fence }),
      kind: op.kind,
      descriptorDigest: op.descriptorDigest,
      supervisionEnvelope: this.receipt.envelope,
    });
  }
  private queryIntent(
    op: OperationState,
    afterStreamSeq: number,
    recovery: boolean,
  ): AgentHostQueryIntent {
    return Object.freeze({
      ...this.intent(op),
      ...(op.payloadDigest ? { payloadDigest: op.payloadDigest } : {}),
      afterStreamSeq,
      ...(op.descriptor ? { descriptor: op.descriptor } : {}),
      recovery,
    });
  }

  private async sendResult(
    op: OperationState,
    result: AgentHostQueryResult,
    type: "operation_receipt" | "operation_query_receipt",
    hostSeq: number,
    generation: number,
  ): Promise<void> {
    this.acceptReceipt(op, result.receipt);
    if (result.fromStreamSeq < 1 || result.fromStreamSeq > op.sentStreamSeq + 1)
      throw new Error("Invalid operation replay cursor");
    const common = {
      version: AGENT_HOST_PROTOCOL_VERSION,
      requestId: this.nextRequestId(),
      fence: this.fence!,
      ackHostSeq: hostSeq,
      operationId: op.operationId,
      receipt: result.receipt,
    };
    await this.writeReceipt(
      type === "operation_receipt"
        ? { ...common, t: type }
        : { ...common, t: type, fromStreamSeq: result.fromStreamSeq },
      generation,
    );
    if (this.markConsumed(hostSeq)) this.writeConsumptionAck(generation);
    let seq = result.fromStreamSeq;
    for await (const raw of result.chunks ?? []) {
      if (
        result.receipt.state === "settled" ||
        result.receipt.state === "indeterminate"
      )
        throw new Error(
          "Terminal operation receipt cannot precede stream data",
        );
      const bytes = raw instanceof Uint8Array ? raw.slice() : undefined;
      if (!bytes?.byteLength)
        throw new Error("Invalid empty operation stream chunk");
      await this.awaitCredit(op, bytes.byteLength, generation);
      this.write({
        t: "operation_stream",
        version: AGENT_HOST_PROTOCOL_VERSION,
        requestId: this.nextRequestId(),
        fence: this.fence!,
        operationId: op.operationId,
        streamSeq: seq,
        encoding: "base64url+opensession-operation-v1",
        bytes: Buffer.from(bytes).toString("base64url"),
      });
      op.creditBytes -= bytes.byteLength;
      op.creditChunks--;
      op.sentStreamSeq = Math.max(op.sentStreamSeq, seq);
      seq++;
      await this.options.failpoint?.("after_stream_chunk");
    }
  }

  private acceptReceipt(
    op: OperationState,
    receipt: AgentOperationReceiptV1,
  ): void {
    const decoded = decodeAgentOperationReceiptV1(receipt);
    if (
      !decoded ||
      decoded.operationId !== op.operationId ||
      decoded.kind !== op.kind ||
      decoded.descriptorDigest !== op.descriptorDigest ||
      !this.fence ||
      !sameFence(decoded.fence, this.fence)
    )
      throw new Error("Coordinator returned a mismatched operation receipt");
    const rank = ["prepared", "executing", "settled", "indeterminate"].indexOf(
      decoded.state,
    );
    if (
      op.receipt &&
      (rank < op.receiptRank ||
        (op.receiptRank >= 2 &&
          JSON.stringify(decoded) !== JSON.stringify(op.receipt)))
    )
      throw new Error(
        "Coordinator receipt state regressed or changed terminal identity",
      );
    op.receipt = decoded;
    op.receiptRank = rank;
    op.payloadDigest = decoded.payloadDigest;
  }

  private async consumeStreamAck(
    message: AgentHostOperationStreamAckV4,
  ): Promise<void> {
    const op = this.operations.get(message.operationId);
    if (
      !op ||
      message.throughStreamSeq < op.throughStreamSeq ||
      message.throughStreamSeq > op.sentStreamSeq
    )
      throw new Error("Invalid operation stream acknowledgement");

    // Initial and replayed cumulative ACKs have already been reflected in the
    // operation cursor/window, so accepting them again must have no effect.
    if (message.throughStreamSeq === op.throughStreamSeq) return;
    if (!this.fence) throw new Error("Agent Host supervision unavailable");
    await this.options.acknowledgeOperationStream(
      Object.freeze({
        operationId: op.operationId,
        fence: Object.freeze({ ...this.fence }),
        kind: op.kind,
        descriptorDigest: op.descriptorDigest,
        throughStreamSeq: message.throughStreamSeq,
      }),
    );
    op.throughStreamSeq = message.throughStreamSeq;
    op.creditBytes += message.creditBytes;
    op.creditChunks += message.creditChunks;
    for (const wake of op.waiters) wake();
    op.waiters.clear();
  }
  private async awaitCredit(
    op: OperationState,
    bytes: number,
    generation: number,
  ): Promise<void> {
    while (op.creditBytes < bytes || op.creditChunks < 1) {
      if (generation !== this.generation || !this.ready)
        throw new Error("Agent Host disconnected during operation stream");
      await new Promise<void>((resolve) => op.waiters.add(resolve));
    }
  }
  private markConsumed(hostSeq: number): boolean {
    const previous = this.lastHostSeq;
    this.consumedHostSeq.add(hostSeq);
    while (this.consumedHostSeq.delete(this.lastHostSeq + 1))
      this.lastHostSeq++;
    return this.lastHostSeq !== previous;
  }
  private writeConsumptionAck(generation: number): void {
    if (generation !== this.generation || !this.fence) return;
    this.write({
      t: "consumption_ack",
      version: AGENT_HOST_PROTOCOL_VERSION,
      requestId: this.nextRequestId(),
      fence: this.fence,
      ackHostSeq: this.lastHostSeq,
      operations: [...this.operations.values()]
        .map((operation) => ({
          operationId: operation.operationId,
          throughStreamSeq: operation.throughStreamSeq,
        }))
        .sort((a, b) => a.operationId.localeCompare(b.operationId)),
    });
  }
  private async consumeTerminal(
    message: AgentHostTurnTerminalV5,
    generation: number,
  ): Promise<void> {
    if (message.finalAckHostSeq !== this.lastHostSeq)
      throw new Error("Agent Host terminal acknowledgement cursor mismatch");
    const expected: AgentHostTerminalOperationV5[] = [];
    for (const operation of [...this.operations.values()].sort((a, b) =>
      a.operationId.localeCompare(b.operationId),
    )) {
      if (!operation.receipt || operation.receiptRank < 2)
        throw new Error(
          "Agent Host terminal preceded an operation terminal receipt",
        );
      expected.push({
        operationId: operation.operationId,
        receiptDigest: await hashAgentOperationReceiptV1(operation.receipt),
        throughStreamSeq: operation.throughStreamSeq,
      });
    }
    if (
      JSON.stringify(expected) !== JSON.stringify(message.operations) ||
      (await hashAgentTurnTerminalReceiptsV1(expected)) !==
        message.receiptsDigest
    )
      throw new Error("Agent Host terminal receipt projection mismatch");
    const authority = this.receipt?.expected;
    if (
      authority &&
      (message.hostGeneration !== authority.hostGeneration ||
        message.hostIncarnation !== authority.hostIncarnation)
    )
      throw new Error("Agent Host terminal supervision identity mismatch");
    if (
      this.terminal &&
      (this.terminal.resultDigest !== message.resultDigest ||
        this.terminal.receiptsDigest !== message.receiptsDigest ||
        this.terminal.hostSeq !== message.hostSeq)
    )
      throw new Error("Agent Host terminal identity changed");
    if (!this.terminal) this.terminal = Object.freeze(structuredClone(message));
    if (!this.terminalNotified) {
      this.terminalNotified = true;
      for (const waiter of this.terminalWaiters) waiter.resolve(this.terminal);
      this.terminalWaiters.clear();
      await this.options.onTurnTerminal?.(this.terminal);
    }
    if (this.markConsumed(message.hostSeq) && generation !== this.generation)
      return;
    this.writeTerminalAck(this.terminal);
  }
  private writeTerminalAck(terminal: AgentHostTurnTerminalV5): void {
    if (!this.fence) throw new Error("Agent Host supervision unavailable");
    this.write({
      t: "turn_terminal_ack",
      version: AGENT_HOST_PROTOCOL_VERSION,
      requestId: this.nextRequestId(),
      fence: this.fence,
      ackHostSeq: terminal.hostSeq,
      resultDigest: terminal.resultDigest,
      receiptsDigest: terminal.receiptsDigest,
    });
  }
  private async writeReceipt(
    message: AgentHostClientMessage,
    generation: number,
  ): Promise<void> {
    await this.options.failpoint?.("before_receipt_write");
    if (generation !== this.generation)
      throw new Error("Agent Host receipt write became uncertain");
    this.write(message);
    await this.options.failpoint?.("after_receipt_write");
  }

  private request(
    expected: PendingRequest["expected"],
    message: AgentHostClientMessage,
  ): Promise<AgentHostServerMessage> {
    return new Promise((resolve, reject) => {
      const requestId = message.requestId;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Agent Host ${expected} timed out`));
      }, this.options.timeoutMs ?? 5_000);
      timer.unref?.();
      this.pending.set(requestId, { expected, resolve, reject, timer });
      try {
        this.write(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  private write(message: AgentHostClientMessage): void {
    if (!this.socket || this.socket.destroyed || !this.socket.writable)
      throw new Error("Agent Host is disconnected");
    this.socket.write(encodeNdjsonFrame(message, this.options.maxFrameBytes));
  }
  private disconnect(socket: Socket, error: Error): void {
    if (socket !== this.socket) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.socket = undefined;
    this.ready = false;
    this.highestHostSeq = this.lastHostSeq;
    for (const op of this.operations.values()) {
      op.uncertain = true;
      for (const wake of op.waiters) wake();
      op.waiters.clear();
    }
    socket.removeAllListeners();
    socket.destroy();
    this.options.onError?.(error);
  }
  private desynchronize(error: Error): void {
    if (this.socket) this.disconnect(this.socket, error);
    else this.options.onError?.(error);
  }
  private nextRequestId(): string {
    return `agent-host-${++this.requestSequence}-${crypto.randomUUID()}`;
  }
}
