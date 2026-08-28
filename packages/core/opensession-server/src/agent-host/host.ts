import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { connect, createServer, type Server, type Socket } from "node:net";
import { createLinuxPeerCredentialVerifier } from "../server/security/transport/linux-peer-credentials";
import {
  createVerifiedUnixSocketServer,
  type VerifiedUnixSocketServer,
} from "../server/security/transport/unix-socket-security";
import {
  AGENT_HOST_PROTOCOL_VERSION,
  AGENT_HOST_SUPERVISION_AUDIENCE,
  AGENT_HOST_SUPERVISION_PURPOSE,
  INITIAL_AGENT_HOST_STREAM_BYTES,
  INITIAL_AGENT_HOST_STREAM_CHUNKS,
  MAX_AGENT_HOST_REPLAY_BYTES,
  MAX_AGENT_HOST_REPLAY_FRAMES,
  MAX_AGENT_HOST_STREAM_BYTES,
  MAX_AGENT_HOST_STREAM_CHUNKS,
  MAX_AGENT_HOST_WRITABLE_BYTES,
  decodeAgentHostAttach,
  decodeAgentHostConsumptionAck,
  decodeAgentHostHello,
  decodeAgentHostOperationCancel,
  decodeAgentHostOperationCancelReceipt,
  decodeAgentHostOperationQuery,
  decodeAgentHostOperationQueryReceipt,
  decodeAgentHostOperationReceipt,
  decodeAgentHostOperationRequest,
  decodeAgentHostOperationStream,
  decodeAgentHostOperationStreamAck,
  decodeAgentHostStartTurn,
  decodeAgentHostTurnStarted,
  decodeAgentHostTurnTerminal,
  decodeAgentHostTurnTerminalAck,
  decodeAgentOperationReceiptV1,
  decodeAgentTurnSpec,
  decodeAgentHostSupervisionPublicKeyringV2,
  decodeExecutorId,
  hashAgentTurnSpecV2,
  hashAgentTurnResultV1,
  hashAgentTurnTerminalReceiptsV1,
  projectAgentTurnTerminalOperationsV1,
  verifySignedAgentHostSupervisionEnvelopeV2,
  type AgentHostAttachResumeCursorV4,
  type AgentHostClientMessage,
  type AgentHostInitialOperationV4,
  type AgentHostOperationCancelV4,
  type AgentHostServerMessage,
  type AgentHostSupervisionPublicKeyringV2,
  type AgentHostTurnTerminalV5,
  type AgentOperationReceiptV1,
  type AgentTurnFence,
  type AgentTurnSpec,
} from "@tellahq/opensession-protocol";
import type {
  AgentHostOperationCancel,
  AgentHostOperationQuery,
  AgentHostOperationRequest,
  AgentHostOperationTransport,
  AgentTurnDriver,
  AgentTurnDriverFactory,
  AgentTurnResult,
} from "./driver";
import {
  AGENT_HOST_MAX_FRAME_BYTES,
  BoundedNdjsonDecoder,
  encodeNdjsonFrame,
} from "./socket-framing";

export type AgentHostFailpoint =
  | "afterAttachChallengeConsumed"
  | "afterAttachVerifiedBeforeOwnerSwap"
  | "afterOwnerSwapBeforeAttachedWrite"
  | "afterOperationIntentBufferedBeforeWrite"
  | "afterStreamAcceptedBeforeDriverDelivery"
  | "afterDriverDeliveryBeforeStreamAck"
  | "onReconnectDeadline";
export interface AgentHostOptions {
  /** Legacy test/development listener. Production must use inheritedFd. */
  socketPath?: string;
  /** Already-listening AF_UNIX descriptor supplied by systemd socket activation. */
  inheritedFd?: number;
  /** Exact non-root gateway UID accepted through SO_PEERCRED. */
  expectedPeerUid?: number;
  createDriver: AgentTurnDriverFactory;
  readonly hostId: string;
  readonly hostGeneration: number;
  readonly hostIncarnation: string;
  readonly supervisionKeyring: AgentHostSupervisionPublicKeyringV2;
  maxFrameBytes?: number;
  cancellationDeadlineMs?: number;
  livenessProbeTimeoutMs?: number;
  attachDeadlineMs?: number;
  reconnectGraceMs?: number;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  failpoint?: (point: AgentHostFailpoint) => void | Promise<void>;
}
export type AgentHostReplayMessageV5 = Extract<
  AgentHostServerMessage,
  { readonly hostSeq: number }
>;
export interface AgentHostHydratedOperationV5 {
  readonly request: Readonly<AgentHostInitialOperationV4>;
  readonly receipt?: Readonly<AgentOperationReceiptV1>;
  readonly sentHostSeqs: readonly number[];
  readonly throughStreamSeq: number;
  readonly acknowledgedThroughStreamSeq: number;
  readonly creditsBytes: number;
  readonly creditsChunks: number;
  readonly owedCreditBytes: number;
  readonly owedCreditChunks: number;
}
export interface AgentHostHydratedTurnV5 {
  readonly spec: Readonly<AgentTurnSpec>;
  readonly planHash: string;
  readonly supervisorEpoch: number;
  readonly requestId: string;
  readonly hostSeq: number;
  readonly acknowledgedHostSeq: number;
  readonly replay: readonly Readonly<AgentHostReplayMessageV5>[];
  readonly operations: readonly Readonly<AgentHostHydratedOperationV5>[];
  readonly result?: Readonly<AgentTurnResult>;
  readonly terminal?: Readonly<AgentHostTurnTerminalV5>;
}
type Timer = ReturnType<typeof setTimeout>;
interface Authority {
  fence: Readonly<AgentTurnFence>;
  planHash: string;
  supervisorEpoch: number;
  envelope: unknown;
}
interface Peer {
  socket: Socket;
  hello: boolean;
  challenge?: string;
  attached?: Authority;
  closed: boolean;
  timer?: Timer;
  reads: Promise<void>;
  writes: Promise<void>;
  queuedBytes: number;
}
interface Op {
  request: Readonly<AgentHostInitialOperationV4>;
  receipt?: AgentOperationReceiptV1;
  receiptJson?: string;
  sent: Set<number>;
  through: number;
  pending: number;
  creditsBytes: number;
  creditsChunks: number;
  terminal: boolean;
  delivery: Promise<void>;
  owedCreditBytes: number;
  owedCreditChunks: number;
  timer?: Timer;
}
interface Frame {
  seq: number;
  bytes: Buffer;
}
interface Turn {
  fence: Readonly<AgentTurnFence>;
  spec: AgentTurnSpec;
  driver: AgentTurnDriver;
  owner?: Peer;
  authority: Authority;
  requestId: string;
  ops: Map<string, Op>;
  seq: number;
  replay: Frame[];
  replayBytes: number;
  reconnect?: Timer;
  deadline?: Timer;
  runSettled: boolean;
  result?: AgentTurnResult;
  cancelling: boolean;
  cancelSettled: boolean;
  acknowledgedHostSeq: number;
  acknowledgedStreams: Map<string, number>;
  terminal?: AgentHostTurnTerminalV5;
  completing: boolean;
}
interface Identity {
  dev: number;
  ino: number;
}
const rec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const sameFence = (a: AgentTurnFence, b: AgentTurnFence) =>
  a.sessionId === b.sessionId &&
  a.runId === b.runId &&
  a.turnId === b.turnId &&
  a.generation === b.generation;
const terminal = (s: AgentOperationReceiptV1["state"]) =>
  s === "settled" || s === "indeterminate";
const rank = (s: AgentOperationReceiptV1["state"]) =>
  s === "prepared" ? 0 : s === "executing" ? 1 : 2;

export class AgentHost {
  private server?: Server;
  private inheritedServer?: VerifiedUnixSocketServer;
  private peerVerifier?: Awaited<
    ReturnType<typeof createLinuxPeerCredentialVerifier>
  >;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private active?: Turn;
  private attaching?: Peer;
  private owner?: Peer;
  private poisoned = false;
  private socketIdentity?: Identity;
  private claimIdentity?: Identity;
  private claimNonce?: string;
  private peers = new Set<Peer>();
  private epochs = new Map<string, number>();
  private generations = new Map<string, number>();
  private keyring: AgentHostSupervisionPublicKeyringV2;
  constructor(private options: AgentHostOptions) {
    const ring = decodeAgentHostSupervisionPublicKeyringV2(
      options.supervisionKeyring,
    );
    if (
      !decodeExecutorId(options.hostId) ||
      !Number.isSafeInteger(options.hostGeneration) ||
      options.hostGeneration < 1 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(options.hostIncarnation) ||
      !ring
    )
      throw new Error("Invalid Agent Host v5 identity or public keyring");
    this.keyring = ring;
  }
  start() {
    if (this.server?.listening) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.listen().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  stop() {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopInner().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
  /** Restores one exact v5 turn before the inherited listener starts. The
   * caller must derive this snapshot from authenticated durable Host state. */
  async hydrateV5(snapshot: Readonly<AgentHostHydratedTurnV5>): Promise<void> {
    if (this.active || this.starting || this.server || this.inheritedServer)
      throw new Error("Agent Host hydration must precede start");
    const admissionNow = Math.min(
      this.now(),
      snapshot.spec.initialOperation.deadlineMs - 1,
      snapshot.spec.limits.turnDeadlineMs - 1,
    );
    const spec = decodeAgentTurnSpec(snapshot.spec, admissionNow);
    if (!spec || (await hashAgentTurnSpecV2(spec, admissionNow)) !== snapshot.planHash)
      throw new Error("Invalid hydrated Agent Host turn plan");
    if (
      !id(snapshot.requestId) ||
      !Number.isSafeInteger(snapshot.supervisorEpoch) ||
      snapshot.supervisorEpoch < 1 ||
      !Number.isSafeInteger(snapshot.hostSeq) ||
      snapshot.hostSeq < 1 ||
      !Number.isSafeInteger(snapshot.acknowledgedHostSeq) ||
      snapshot.acknowledgedHostSeq < 0 ||
      snapshot.acknowledgedHostSeq > snapshot.hostSeq ||
      !Array.isArray(snapshot.replay) ||
      !Array.isArray(snapshot.operations) ||
      snapshot.operations.length > spec.limits.maxInFlightOperations ||
      (!!snapshot.terminal !== !!snapshot.result)
    )
      throw new Error("Invalid hydrated Agent Host turn state");
    const replay: Frame[] = [];
    let replayBytes = 0;
    let previousSeq = 0;
    for (const raw of snapshot.replay) {
      const message = await this.decodeReplayMessage(raw, spec);
      if (
        !message ||
        message.requestId !== snapshot.requestId ||
        !sameFence(message.fence, spec.fence) ||
        message.hostSeq <= previousSeq ||
        message.hostSeq > snapshot.hostSeq
      )
        throw new Error("Invalid hydrated Agent Host replay");
      const bytes = encodeNdjsonFrame(message, this.options.maxFrameBytes);
      replay.push({ seq: message.hostSeq, bytes });
      replayBytes += bytes.length;
      previousSeq = message.hostSeq;
    }
    if (
      replay.length > MAX_AGENT_HOST_REPLAY_FRAMES ||
      replayBytes > MAX_AGENT_HOST_REPLAY_BYTES
    )
      throw new Error("Hydrated Agent Host replay exceeds bounds");
    const operations = new Map<string, Op>();
    const acknowledgedStreams = new Map<string, number>();
    for (const hydrated of snapshot.operations) {
      const request = hydrated.request;
      if (
        !request ||
        operations.has(request.operationId) ||
        request.deadlineMs > spec.limits.turnDeadlineMs ||
        !Number.isSafeInteger(hydrated.throughStreamSeq) ||
        hydrated.throughStreamSeq < 0 ||
        !Number.isSafeInteger(hydrated.acknowledgedThroughStreamSeq) ||
        hydrated.acknowledgedThroughStreamSeq < 0 ||
        hydrated.acknowledgedThroughStreamSeq > hydrated.throughStreamSeq ||
        !Number.isSafeInteger(hydrated.creditsBytes) ||
        hydrated.creditsBytes < 0 ||
        hydrated.creditsBytes > spec.limits.maxBufferedStreamBytes ||
        !Number.isSafeInteger(hydrated.creditsChunks) ||
        hydrated.creditsChunks < 0 ||
        hydrated.creditsChunks > spec.limits.maxBufferedStreamChunks ||
        !Number.isSafeInteger(hydrated.owedCreditBytes) ||
        hydrated.owedCreditBytes < 0 ||
        hydrated.owedCreditBytes > spec.limits.maxBufferedStreamBytes ||
        !Number.isSafeInteger(hydrated.owedCreditChunks) ||
        hydrated.owedCreditChunks < 0 ||
        hydrated.owedCreditChunks > spec.limits.maxBufferedStreamChunks ||
        !Array.isArray(hydrated.sentHostSeqs)
      )
        throw new Error("Invalid hydrated Agent Host operation");
      const descriptor = await decodeAgentHostOperationRequest(
        {
          t: "operation_request",
          version: AGENT_HOST_PROTOCOL_VERSION,
          requestId: snapshot.requestId,
          fence: spec.fence,
          hostSeq: 1,
          operationId: request.operationId,
          descriptor: request.descriptor,
          descriptorDigest: request.descriptorDigest,
          deadlineMs: request.deadlineMs,
        },
        Math.min(this.now(), request.deadlineMs - 1),
        spec.limits.turnDeadlineMs,
      );
      if (!descriptor) throw new Error("Invalid hydrated Agent Host operation descriptor");
      const sent = new Set<number>();
      for (const seq of hydrated.sentHostSeqs) {
        if (!Number.isSafeInteger(seq) || seq < 1 || seq > snapshot.hostSeq || sent.has(seq))
          throw new Error("Invalid hydrated Agent Host sent cursor");
        sent.add(seq);
      }
      const receipt = hydrated.receipt
        ? decodeAgentOperationReceiptV1(hydrated.receipt)
        : undefined;
      if (
        hydrated.receipt &&
        (!receipt ||
          receipt.operationId !== request.operationId ||
          receipt.descriptorDigest !== request.descriptorDigest ||
          !sameFence(receipt.fence, spec.fence))
      )
        throw new Error("Invalid hydrated Agent Host receipt");
      const operation: Op = {
        request: Object.freeze({ ...request, descriptor: descriptor.descriptor }),
        ...(receipt ? { receipt, receiptJson: JSON.stringify(receipt) } : {}),
        sent,
        through: hydrated.throughStreamSeq,
        pending: 0,
        creditsBytes: hydrated.creditsBytes,
        creditsChunks: hydrated.creditsChunks,
        terminal: !!receipt && terminal(receipt.state),
        delivery: Promise.resolve(),
        owedCreditBytes: hydrated.owedCreditBytes,
        owedCreditChunks: hydrated.owedCreditChunks,
      };
      operations.set(request.operationId, operation);
      acknowledgedStreams.set(
        request.operationId,
        hydrated.acknowledgedThroughStreamSeq,
      );
    }
    for (const raw of snapshot.replay) {
      if (raw.t === "turn_started" || raw.t === "turn_terminal") continue;
      const operation = operations.get(raw.operationId);
      if (!operation) throw new Error("Hydrated replay references an unknown operation");
      if (
        raw.t === "operation_request" &&
        (raw.descriptorDigest !== operation.request.descriptorDigest ||
          raw.deadlineMs !== operation.request.deadlineMs ||
          JSON.stringify(raw.descriptor) !== JSON.stringify(operation.request.descriptor))
      )
        throw new Error("Hydrated replay operation identity changed");
      if (
        raw.t === "operation_query" &&
        (!operation.receipt ||
          raw.descriptorDigest !== operation.request.descriptorDigest ||
          raw.payloadDigest !== operation.receipt.payloadDigest)
      )
        throw new Error("Hydrated replay query identity changed");
      if (
        raw.t === "operation_stream_ack" &&
        raw.throughStreamSeq > operation.through
      )
        throw new Error("Hydrated replay stream cursor is ahead");
    }
    const driver = this.options.createDriver(spec);
    const authority: Authority = {
      fence: spec.fence,
      planHash: snapshot.planHash,
      supervisorEpoch: snapshot.supervisorEpoch,
      envelope: null,
    };
    const turn: Turn = {
      fence: spec.fence,
      spec,
      driver,
      authority,
      requestId: snapshot.requestId,
      ops: operations,
      seq: snapshot.hostSeq,
      replay,
      replayBytes,
      runSettled: !!snapshot.result,
      ...(snapshot.result ? { result: structuredClone(snapshot.result) } : {}),
      cancelling: false,
      cancelSettled: false,
      acknowledgedHostSeq: snapshot.acknowledgedHostSeq,
      acknowledgedStreams,
      ...(snapshot.terminal ? { terminal: structuredClone(snapshot.terminal) } : {}),
      completing: false,
    };
    if (snapshot.terminal) {
      const terminalMessage = decodeAgentHostTurnTerminal(snapshot.terminal);
      const projectedOperations = await projectAgentTurnTerminalOperationsV1(
        [...operations].map(([operationId, operation]) => {
          if (!operation.receipt || !operation.terminal)
            throw new Error("Hydrated terminal has a nonterminal operation");
          return {
            operationId,
            receipt: operation.receipt,
            throughStreamSeq: operation.through,
          };
        }),
      );
      if (
        !terminalMessage ||
        !sameFence(terminalMessage.fence, spec.fence) ||
        terminalMessage.hostSeq !== snapshot.hostSeq ||
        terminalMessage.hostGeneration !== this.options.hostGeneration ||
        terminalMessage.hostIncarnation !== this.options.hostIncarnation ||
        terminalMessage.finalAckHostSeq !== snapshot.acknowledgedHostSeq ||
        terminalMessage.result.status !== snapshot.result!.status ||
        (await hashAgentTurnResultV1(snapshot.result!)) !== terminalMessage.resultDigest ||
        (await hashAgentTurnTerminalReceiptsV1(projectedOperations)) !== terminalMessage.receiptsDigest ||
        JSON.stringify(projectedOperations) !== JSON.stringify(terminalMessage.operations) ||
        !snapshot.replay.some(
          (message) =>
            message.t === "turn_terminal" &&
            JSON.stringify(message) === JSON.stringify(terminalMessage),
        )
      )
        throw new Error("Invalid hydrated Agent Host terminal");
    }
    this.active = turn;
    this.epochs.set(spec.fence.sessionId, snapshot.supervisorEpoch);
    this.generations.set(spec.fence.sessionId, spec.fence.generation);
    if (!snapshot.terminal) {
      turn.deadline = this.set(
        () => this.cancelTurn(turn, "turn_deadline"),
        Math.max(0, spec.limits.turnDeadlineMs - this.now()),
      );
      for (const operation of operations.values())
        if (!operation.terminal)
          operation.timer = this.set(
            () => void this.cancelOp(turn, {
              operationId: operation.request.operationId,
              cancelId: `deadline-${crypto.randomUUID()}`,
              reason: "turn_deadline",
            }).catch(() => {}),
            Math.max(0, operation.request.deadlineMs - this.now()),
          );
      this.runDriver(turn);
    }
  }
  private async decodeReplayMessage(
    value: unknown,
    spec: AgentTurnSpec,
  ): Promise<AgentHostReplayMessageV5 | undefined> {
    if (!rec(value) || typeof value.t !== "string") return undefined;
    const decoded =
      decodeAgentHostTurnStarted(value) ??
      decodeAgentHostTurnTerminal(value) ??
      (await decodeAgentHostOperationRequest(
        value,
        Math.min(this.now(), spec.limits.turnDeadlineMs - 1),
        spec.limits.turnDeadlineMs,
      )) ??
      decodeAgentHostOperationQuery(value) ??
      decodeAgentHostOperationCancel(value) ??
      decodeAgentHostOperationStreamAck(value);
    return decoded as AgentHostReplayMessageV5 | undefined;
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private duration(v: number | undefined, fallback: number, name: string) {
    const n = v ?? fallback;
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`${name} must be positive`);
    return n;
  }
  private set(fn: () => void, ms: number) {
    const t = (this.options.setTimeout ?? setTimeout)(fn, ms);
    t.unref?.();
    return t;
  }
  private clear(t?: Timer) {
    if (t) (this.options.clearTimeout ?? clearTimeout)(t);
  }
  private async hit(point: AgentHostFailpoint) {
    await this.options.failpoint?.(point);
  }

  private async listen() {
    if (this.poisoned)
      throw new Error("Agent Host requires process replacement");
    if (this.options.inheritedFd !== undefined) {
      if (this.options.socketPath !== undefined)
        throw new Error(
          "Agent Host inherited listener cannot name a socket path",
        );
      const expectedPeerUid = this.options.expectedPeerUid;
      if (
        !Number.isSafeInteger(expectedPeerUid) ||
        expectedPeerUid! <= 0 ||
        expectedPeerUid! > 0xffff_ffff
      )
        throw new Error(
          "Agent Host inherited listener requires an exact non-root gateway UID",
        );
      const verifier = await createLinuxPeerCredentialVerifier();
      this.peerVerifier = verifier;
      const inherited = createVerifiedUnixSocketServer(
        verifier,
        { uid: expectedPeerUid! },
        (accepted) => {
          accepted.assertCurrent();
          this.accept(accepted.socket);
          accepted.socket.resume();
        },
        () => {},
        { listenerMode: "inherited-fd-only" },
      );
      this.inheritedServer = inherited;
      try {
        await inherited.listen({ inheritedFd: this.options.inheritedFd });
        return;
      } catch (error) {
        verifier.close();
        this.peerVerifier = undefined;
        this.inheritedServer = undefined;
        throw error;
      }
    }
    if (!this.options.socketPath)
      throw new Error("Agent Host listener is unavailable");
    await this.prepareParent();
    try {
      await this.claim();
      await this.removeStale();
      const server = createServer((s) => this.accept(s));
      this.server = server;
      await new Promise<void>((ok, fail) => {
        server.once("error", fail);
        server.listen(this.options.socketPath, ok);
      });
      const st = await lstat(this.options.socketPath);
      if (!st.isSocket() || st.isSymbolicLink())
        throw new Error("unsafe Agent Host socket");
      await chmod(this.options.socketPath, 0o600);
      this.socketIdentity = { dev: st.dev, ino: st.ino };
    } catch (e) {
      await this.unlinkSocket();
      await this.releaseClaim();
      throw e;
    }
  }
  private async stopInner() {
    await this.starting?.catch(() => {});
    const server = this.server;
    const inheritedServer = this.inheritedServer;
    this.server = undefined;
    this.inheritedServer = undefined;
    const active = this.active;
    if (active) this.poisoned = true;
    for (const p of this.peers) {
      p.closed = true;
      p.socket.destroy();
    }
    this.peers.clear();
    if (server?.listening)
      await new Promise<void>((ok) => server.close(() => ok()));
    if (inheritedServer) await inheritedServer.closeAndDrain(5_000);
    if (active) {
      await Promise.allSettled([
        Promise.resolve().then(() => active.driver.cancel()),
        Promise.resolve().then(() => active.driver.shutdown()),
      ]);
    }
    this.peerVerifier?.close();
    this.peerVerifier = undefined;
    if (this.options.socketPath) {
      await this.unlinkSocket();
      if (!this.active) await this.releaseClaim();
    }
  }
  private async prepareParent() {
    const path = this.options.socketPath!;
    if (!isAbsolute(path) || resolve(path) !== path)
      throw new Error("Agent Host socket path must be absolute and normalized");
    const parent = dirname(path),
      root = parse(parent).root;
    if (parent === root) throw new Error("invalid socket parent");
    let current = root;
    for (const part of parent.slice(root.length).split("/").filter(Boolean)) {
      current = resolve(current, part);
      try {
        const st = await lstat(current);
        if (!st.isDirectory() || st.isSymbolicLink())
          throw new Error("unsafe socket parent");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        await mkdir(current, { mode: 0o700 });
      }
    }
    const st = await lstat(parent),
      uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid)
      throw new Error("socket parent owner mismatch");
    await chmod(parent, 0o700);
  }
  private get claimPath() {
    return `${this.options.socketPath!}.claim`;
  }
  private async claim() {
    const nonce = crypto.randomUUID(),
      tmp = `${this.claimPath}.tmp-${nonce}`;
    await writeFile(tmp, JSON.stringify({ pid: process.pid, nonce }), {
      flag: "wx",
      mode: 0o400,
    });
    const st = await lstat(tmp);
    try {
      await link(tmp, this.claimPath);
      this.claimNonce = nonce;
      this.claimIdentity = { dev: st.dev, ino: st.ino };
      await this.verifyClaim(this.claimPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST")
        throw Object.assign(new Error("Agent Host socket is already claimed"), {
          code: "EADDRINUSE",
        });
      throw e;
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
  private async verifyClaim(path: string) {
    const st = await lstat(path),
      data = JSON.parse(await readFile(path, "utf8"));
    const i = this.claimIdentity;
    if (
      !i ||
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.dev !== i.dev ||
      st.ino !== i.ino ||
      data.nonce !== this.claimNonce
    ) {
      this.poisoned = true;
      throw new Error("Agent Host claim ownership changed");
    }
  }
  private async removeStale() {
    const path = this.options.socketPath!;
    try {
      const st = await lstat(path);
      if (!st.isSocket() || st.isSymbolicLink())
        throw new Error("unsafe socket");
      if (await this.probe())
        throw Object.assign(new Error("Agent Host socket is already live"), {
          code: "EADDRINUSE",
        });
      const old = `${path}.stale-${crypto.randomUUID()}`;
      await rename(path, old);
      await unlink(old);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  private probe() {
    const path = this.options.socketPath!;
    return new Promise<boolean>((ok, fail) => {
      const s = connect(path);
      let done = false;
      const finish = (v: boolean, e?: Error) => {
        if (done) return;
        done = true;
        this.clear(timer);
        s.destroy();
        e ? fail(e) : ok(v);
      };
      const timer = this.set(
        () => finish(false, new Error("liveness probe timed out")),
        this.duration(
          this.options.livenessProbeTimeoutMs,
          250,
          "livenessProbeTimeoutMs",
        ),
      );
      s.once("connect", () => finish(true));
      s.once("error", (e: NodeJS.ErrnoException) =>
        e.code === "ENOENT" || e.code === "ECONNREFUSED"
          ? finish(false)
          : finish(false, e),
      );
    });
  }
  private async unlinkSocket() {
    const path = this.options.socketPath!;
    const i = this.socketIdentity;
    this.socketIdentity = undefined;
    if (!i) return;
    try {
      const st = await lstat(path);
      if (
        st.isSocket() &&
        !st.isSymbolicLink() &&
        st.dev === i.dev &&
        st.ino === i.ino
      ) {
        const q = `${path}.cleanup-${crypto.randomUUID()}`;
        await rename(path, q);
        await unlink(q);
      }
    } catch {}
  }
  private async releaseClaim() {
    if (!this.claimNonce || !this.claimIdentity) return;
    await this.verifyClaim(this.claimPath);
    const q = `${this.claimPath}.release-${this.claimNonce}`;
    await rename(this.claimPath, q);
    await this.verifyClaim(q);
    await unlink(q);
    this.claimNonce = undefined;
    this.claimIdentity = undefined;
  }

  private accept(socket: Socket) {
    const p: Peer = {
      socket,
      hello: false,
      closed: false,
      reads: Promise.resolve(),
      writes: Promise.resolve(),
      queuedBytes: 0,
    };
    this.peers.add(p);
    const decoder = new BoundedNdjsonDecoder(
      this.options.maxFrameBytes ?? AGENT_HOST_MAX_FRAME_BYTES,
    );
    p.timer = this.set(
      () => this.close(p),
      this.duration(this.options.attachDeadlineMs, 5_000, "attachDeadlineMs"),
    );
    socket.on("data", (b) => {
      try {
        for (const v of decoder.push(Buffer.from(b)))
          p.reads = p.reads
            .then(() => this.receive(p, v))
            .catch(() => this.close(p));
      } catch {
        this.close(p);
      }
    });
    socket.on("end", () => {
      try {
        decoder.finish();
      } catch {
        this.close(p);
      }
    });
    socket.on("error", () => this.close(p));
    socket.on("close", () => this.disconnected(p));
  }
  private async receive(p: Peer, raw: unknown) {
    if (p.closed) return;
    if (!p.hello) {
      const hello = decodeAgentHostHello(raw);
      if (!hello) {
        if (
          rec(raw) &&
          id(raw.requestId) &&
          raw.version !== AGENT_HOST_PROTOCOL_VERSION
        )
          this.send(p, {
            t: "error",
            version: AGENT_HOST_PROTOCOL_VERSION,
            requestId: raw.requestId,
            code: "unsupported_version",
            message: "Unsupported Agent Host protocol version",
          });
        this.close(p);
        return;
      }
      p.hello = true;
      p.challenge = crypto.randomUUID();
      this.send(p, {
        ...hello,
        accepted: true,
        hostId: this.options.hostId,
        hostGeneration: this.options.hostGeneration,
        hostIncarnation: this.options.hostIncarnation,
        hostChallenge: p.challenge,
      });
      return;
    }
    if (!p.attached) {
      await this.attach(p, raw);
      return;
    }
    const m =
      decodeAgentHostStartTurn(raw, this.now()) ??
      decodeAgentHostOperationReceipt(raw) ??
      decodeAgentHostOperationQueryReceipt(raw) ??
      decodeAgentHostOperationCancelReceipt(raw) ??
      decodeAgentHostOperationStream(raw) ??
      decodeAgentHostConsumptionAck(raw) ??
      decodeAgentHostTurnTerminalAck(raw);
    if (!m) return this.invalid(p, raw);
    if (m.t === "start_turn") return this.startTurn(p, m);
    const turn = this.active;
    if (!turn || turn.owner !== p || !sameFence(turn.fence, m.fence))
      return this.close(p);
    if (m.t === "consumption_ack") return this.consumptionAck(turn, m);
    if (m.t === "turn_terminal_ack") return this.terminalAck(turn, m);
    await this.operationMessage(turn, m);
  }
  private invalid(p: Peer, raw: unknown) {
    this.send(p, {
      t: "error",
      version: AGENT_HOST_PROTOCOL_VERSION,
      requestId: rec(raw) && id(raw.requestId) ? raw.requestId : "invalid",
      code: "invalid_request",
      message: "Invalid Agent Host request",
    });
    this.close(p);
  }
  private async attach(p: Peer, raw: unknown) {
    const challenge = p.challenge;
    p.challenge = undefined;
    await this.hit("afterAttachChallengeConsumed");
    const m = decodeAgentHostAttach(raw);
    if (!challenge || !m || this.attaching || this.poisoned)
      return this.close(p);
    const e = m.receipt.expected;
    if (
      !sameFence(e.fence, m.fence) ||
      e.planHash !== m.planHash ||
      e.hostId !== this.options.hostId ||
      e.hostGeneration !== this.options.hostGeneration ||
      e.hostIncarnation !== this.options.hostIncarnation ||
      e.hostChallenge !== challenge ||
      e.audience !== AGENT_HOST_SUPERVISION_AUDIENCE ||
      e.purpose !== AGENT_HOST_SUPERVISION_PURPOSE
    )
      return this.close(p);
    this.attaching = p;
    const a = await verifySignedAgentHostSupervisionEnvelopeV2(
      m.receipt.envelope,
      this.keyring,
      e,
      this.now(),
    );
    await this.hit("afterAttachVerifiedBeforeOwnerSwap");
    if (!a || p.closed || this.attaching !== p) return this.close(p);
    const turn = this.active,
      resumed =
        !!turn &&
        sameFence(turn.fence, a.fence) &&
        turn.authority.planHash === a.planHash;
    const oldEpoch = this.epochs.get(a.fence.sessionId) ?? 0,
      oldGen = this.generations.get(a.fence.sessionId) ?? 0;
    if (
      a.supervisorEpoch <= oldEpoch ||
      a.fence.generation < oldGen ||
      (turn && !resumed) ||
      (resumed && m.resume === null) ||
      (!turn && m.resume !== null)
    ) {
      this.attaching = undefined;
      return this.close(p);
    }
    const authority: Authority = {
      fence: Object.freeze({ ...a.fence }),
      planHash: a.planHash,
      supervisorEpoch: a.supervisorEpoch,
      envelope: m.receipt.envelope,
    };
    const old = resumed ? turn.owner : this.owner;
    p.attached = authority;
    this.owner = p;
    if (resumed) turn.owner = p;
    this.epochs.set(a.fence.sessionId, a.supervisorEpoch);
    this.generations.set(a.fence.sessionId, a.fence.generation);
    this.attaching = undefined;
    this.clear(p.timer);
    p.timer = undefined;
    if (resumed) {
      this.clear(turn.reconnect);
      turn.reconnect = undefined;
      if (m.resume!.lastHostSeq <= turn.seq)
        turn.acknowledgedHostSeq = Math.max(
          turn.acknowledgedHostSeq,
          m.resume!.lastHostSeq,
        );
      for (const cursor of m.resume!.operations) {
        const operation = turn.ops.get(cursor.operationId);
        if (operation && cursor.throughStreamSeq <= operation.through)
          turn.acknowledgedStreams.set(
            cursor.operationId,
            Math.max(
              turn.acknowledgedStreams.get(cursor.operationId) ?? 0,
              cursor.throughStreamSeq,
            ),
          );
      }
    }
    if (old && old !== p) this.close(old);
    await this.hit("afterOwnerSwapBeforeAttachedWrite");
    const recovery = resumed && this.needsRecovery(turn, m.resume!);
    this.send(p, {
      t: "attached",
      version: AGENT_HOST_PROTOCOL_VERSION,
      requestId: m.requestId,
      fence: authority.fence,
      planHash: authority.planHash as `sha256:${string}`,
      supervisorEpoch: authority.supervisorEpoch,
      mode: resumed ? (recovery ? "recovery_required" : "resumed") : "fresh",
      replayFromHostSeq: resumed
        ? recovery
          ? turn.seq + 1
          : m.resume!.lastHostSeq + 1
        : 0,
    });
    if (resumed) {
      if (recovery) await this.recover(turn, m.resume!);
      else
        for (const f of turn.replay)
          if (f.seq > m.resume!.lastHostSeq) this.sendBytes(p, f.bytes);
    } else
      p.timer = this.set(
        () => {
          if (this.owner === p && !this.active) this.close(p);
        },
        this.duration(this.options.attachDeadlineMs, 5000, "attachDeadlineMs"),
      );
  }
  private async startTurn(
    p: Peer,
    m: Extract<AgentHostClientMessage, { t: "start_turn" }>,
  ) {
    const a = p.attached;
    if (
      !a ||
      this.owner !== p ||
      !sameFence(a.fence, m.spec.fence) ||
      a.planHash !== m.planHash
    )
      return this.close(p);
    let hash;
    try {
      hash = await hashAgentTurnSpecV2(m.spec, this.now());
    } catch {
      return this.close(p);
    }
    if (hash !== a.planHash) return this.close(p);
    if (this.active) return this.invalid(p, m);
    this.clear(p.timer);
    p.timer = undefined;
    let driver;
    try {
      driver = this.options.createDriver(m.spec);
    } catch (e) {
      this.send(p, {
        t: "error",
        version: AGENT_HOST_PROTOCOL_VERSION,
        requestId: m.requestId,
        code: "turn_failed",
        message: String(e),
        fence: m.spec.fence,
      });
      return;
    }
    const t: Turn = {
      fence: m.spec.fence,
      spec: m.spec,
      driver,
      owner: p,
      authority: a,
      requestId: m.requestId,
      ops: new Map(),
      seq: 0,
      replay: [],
      replayBytes: 0,
      runSettled: false,
      cancelling: false,
      cancelSettled: false,
      acknowledgedHostSeq: 0,
      acknowledgedStreams: new Map(),
      completing: false,
    };
    this.active = t;
    t.deadline = this.set(
      () => this.cancelTurn(t, "turn_deadline"),
      Math.max(0, m.spec.limits.turnDeadlineMs - this.now()),
    );
    this.sequenced(t, {
      t: "turn_started",
      version: AGENT_HOST_PROTOCOL_VERSION,
      requestId: m.requestId,
      fence: t.fence,
    } as never);
    this.runDriver(t);
  }
  private runDriver(t: Turn) {
    const transport: AgentHostOperationTransport = {
      requestOperation: (request) => this.requestOp(t, request),
      queryOperation: (query) => this.queryOp(t, query),
      cancelOperation: (cancel) => this.cancelOp(t, cancel),
    };
    let run: Promise<AgentTurnResult>;
    try {
      run = Promise.resolve(t.driver.run(t.spec, transport));
    } catch (error) {
      run = Promise.reject(error);
    }
    void run.then(
      (result) => {
        t.runSettled = true;
        t.result = result;
        this.complete(t);
      },
      (error) => {
        t.runSettled = true;
        t.result = { status: "failed", error: String(error) };
        this.complete(t);
      },
    );
  }
  private async requestOp(t: Turn, r: AgentHostOperationRequest) {
    if (this.active !== t || t.cancelling) throw Error("turn unavailable");
    const existing = t.ops.get(r.operationId);
    if (existing) {
      if (
        existing.request.descriptorDigest !== r.descriptorDigest ||
        existing.request.deadlineMs !== r.deadlineMs ||
        JSON.stringify(existing.request.descriptor) !== JSON.stringify(r.descriptor)
      )
        throw Error("recovered operation identity changed");
      if (existing.receipt)
        await this.queryOp(t, {
          operationId: r.operationId,
          kind: r.descriptor.kind,
          descriptorDigest: r.descriptorDigest,
          payloadDigest: existing.receipt.payloadDigest,
          afterStreamSeq: existing.through,
        });
      else {
        existing.sent.add(
          this.sequenced(t, {
            t: "operation_request",
            version: AGENT_HOST_PROTOCOL_VERSION,
            requestId: t.requestId,
            fence: t.fence,
            operationId: r.operationId,
            descriptor: r.descriptor,
            descriptorDigest: r.descriptorDigest,
            deadlineMs: r.deadlineMs,
          } as never),
        );
      }
      return;
    }
    if (t.ops.size >= Math.min(8, t.spec.limits.maxInFlightOperations))
      throw Error("operation limit");
    if (
      r.deadlineMs <= this.now() ||
      r.deadlineMs > t.spec.limits.turnDeadlineMs
    )
      throw Error("invalid deadline");
    const o: Op = {
      request: r,
      sent: new Set(),
      through: 0,
      pending: 0,
      creditsBytes: 0,
      creditsChunks: 0,
      terminal: false,
      delivery: Promise.resolve(),
      owedCreditBytes: 0,
      owedCreditChunks: 0,
    };
    t.ops.set(r.operationId, o);
    const seq = this.buffer(t, {
      t: "operation_request",
      version: AGENT_HOST_PROTOCOL_VERSION,
      requestId: t.requestId,
      fence: t.fence,
      operationId: r.operationId,
      descriptor: r.descriptor,
      descriptorDigest: r.descriptorDigest,
      deadlineMs: r.deadlineMs,
    } as never);
    o.sent.add(seq);
    await this.hit("afterOperationIntentBufferedBeforeWrite");
    this.writeBuffered(t, seq);
    this.credit(
      t,
      o,
      0,
      INITIAL_AGENT_HOST_STREAM_BYTES,
      INITIAL_AGENT_HOST_STREAM_CHUNKS,
    );
    o.timer = this.set(
      () => {
        void this.cancelOp(t, {
          operationId: r.operationId,
          cancelId: `deadline-${crypto.randomUUID()}`,
          reason: "turn_deadline",
        });
      },
      Math.max(0, r.deadlineMs - this.now()),
    );
  }
  private async queryOp(t: Turn, q: AgentHostOperationQuery) {
    const o = t.ops.get(q.operationId);
    if (
      !o ||
      o.receipt?.payloadDigest !== q.payloadDigest ||
      o.request.descriptorDigest !== q.descriptorDigest ||
      o.request.descriptor.kind !== q.kind
    )
      throw Error("invalid query");
    o.sent.add(
      this.sequenced(t, {
        t: "operation_query",
        version: AGENT_HOST_PROTOCOL_VERSION,
        requestId: t.requestId,
        fence: t.fence,
        ...q,
      } as never),
    );
  }
  private async cancelOp(t: Turn, c: AgentHostOperationCancel) {
    const o = t.ops.get(c.operationId);
    if (!o) throw Error("unknown operation");
    o.sent.add(
      this.sequenced(t, {
        t: "operation_cancel",
        version: AGENT_HOST_PROTOCOL_VERSION,
        requestId: t.requestId,
        fence: t.fence,
        ...c,
      } as never),
    );
  }
  private async operationMessage(
    t: Turn,
    m: Exclude<
      AgentHostClientMessage,
      {
        t:
          | "hello"
          | "attach"
          | "start_turn"
          | "consumption_ack"
          | "turn_terminal_ack";
      }
    >,
  ) {
    const o = t.ops.get(m.operationId);
    if (!o) return this.invalid(t.owner!, m);
    if (m.t === "operation_stream") return this.stream(t, o, m);
    if (
      !o.sent.has(m.ackHostSeq) ||
      !this.applyReceipt(o, m.receipt) ||
      (m.t === "operation_query_receipt" && m.fromStreamSeq !== o.through + 1)
    )
      return this.invalid(t.owner!, m);
    this.complete(t);
  }
  private applyReceipt(o: Op, r: AgentOperationReceiptV1) {
    if (
      r.kind !== o.request.descriptor.kind ||
      r.descriptorDigest !== o.request.descriptorDigest
    )
      return false;
    const json = JSON.stringify(r),
      old = o.receipt;
    if (
      old &&
      (rank(r.state) < rank(old.state) ||
        (r.state === old.state && json !== o.receiptJson) ||
        (terminal(old.state) && json !== o.receiptJson) ||
        r.planHash !== old.planHash ||
        r.authorityHash !== old.authorityHash ||
        r.payloadDigest !== old.payloadDigest ||
        JSON.stringify(r.actorIdentity) !== JSON.stringify(old.actorIdentity))
    )
      return false;
    o.receipt = r;
    o.receiptJson = json;
    o.terminal = terminal(r.state);
    if (o.terminal) {
      this.clear(o.timer);
      o.timer = undefined;
    }
    return true;
  }
  private async stream(
    t: Turn,
    o: Op,
    m: Extract<AgentHostClientMessage, { t: "operation_stream" }>,
  ) {
    const n = Buffer.from(m.bytes, "base64url").byteLength;
    if (
      o.terminal ||
      !o.receipt ||
      o.receipt.state === "prepared" ||
      m.streamSeq !== o.through + o.pending + 1 ||
      n > o.creditsBytes ||
      o.creditsChunks < 1
    )
      return this.close(t.owner!);
    o.creditsBytes -= n;
    o.creditsChunks--;
    o.pending++;
    try {
      await this.hit("afterStreamAcceptedBeforeDriverDelivery");
    } catch (error) {
      o.pending--;
      throw error;
    }
    o.delivery = o.delivery.then(async () => {
      try {
        await t.driver.deliverOperationStream({
          operationId: m.operationId,
          streamSeq: m.streamSeq,
          encoding: m.encoding,
          bytes: m.bytes,
        });
      } catch {
        o.pending--;
        this.cancelTurn(t, "shutdown");
        return;
      }
      o.through = m.streamSeq;
      o.pending--;
      o.owedCreditBytes += n;
      o.owedCreditChunks += 1;
      await this.hit("afterDriverDeliveryBeforeStreamAck");
      if (this.active === t) {
        this.credit(t, o, o.through, o.owedCreditBytes, o.owedCreditChunks);
        o.owedCreditBytes = 0;
        o.owedCreditChunks = 0;
      }
      this.complete(t);
    });
    await o.delivery;
  }
  private credit(
    t: Turn,
    o: Op,
    through: number,
    bytes: number,
    chunks: number,
  ) {
    const b = Math.min(
        bytes,
        MAX_AGENT_HOST_STREAM_BYTES - o.creditsBytes,
        t.spec.limits.maxBufferedStreamBytes - o.creditsBytes,
      ),
      c = Math.min(
        chunks,
        MAX_AGENT_HOST_STREAM_CHUNKS - o.creditsChunks,
        t.spec.limits.maxBufferedStreamChunks - o.creditsChunks,
      );
    if (b <= 0 || c <= 0) return;
    o.creditsBytes += b;
    o.creditsChunks += c;
    o.sent.add(
      this.sequenced(t, {
        t: "operation_stream_ack",
        version: AGENT_HOST_PROTOCOL_VERSION,
        requestId: t.requestId,
        fence: t.fence,
        operationId: o.request.operationId,
        throughStreamSeq: through,
        creditBytes: b,
        creditChunks: c,
      } as never),
    );
  }
  private buffer(t: Turn, m: Omit<AgentHostServerMessage, "hostSeq">) {
    const seq = ++t.seq,
      bytes = encodeNdjsonFrame(
        { ...m, hostSeq: seq },
        this.options.maxFrameBytes,
      );
    t.replay.push({ seq, bytes });
    t.replayBytes += bytes.length;
    while (
      t.replay.length > MAX_AGENT_HOST_REPLAY_FRAMES ||
      t.replayBytes > MAX_AGENT_HOST_REPLAY_BYTES
    ) {
      const f = t.replay.shift()!;
      t.replayBytes -= f.bytes.length;
    }
    return seq;
  }
  private writeBuffered(t: Turn, seq: number) {
    const f = t.replay.find((x) => x.seq === seq);
    if (!f) throw Error("intent evicted before write");
    if (t.owner) this.sendBytes(t.owner, f.bytes);
  }
  private sequenced(t: Turn, m: Omit<AgentHostServerMessage, "hostSeq">) {
    const s = this.buffer(t, m);
    this.writeBuffered(t, s);
    return s;
  }
  private needsRecovery(t: Turn, r: AgentHostAttachResumeCursorV4) {
    const oldest = t.replay[0]?.seq ?? t.seq + 1;
    if (r.lastHostSeq > t.seq || r.lastHostSeq < oldest - 1) return true;
    const c = new Map(
      r.operations.map((x) => [x.operationId, x.throughStreamSeq]),
    );
    return [...t.ops].some(
      ([k, o]) => !o.terminal || (c.get(k) ?? 0) !== o.through,
    );
  }
  private async recover(t: Turn, r: AgentHostAttachResumeCursorV4) {
    const c = new Map(
      r.operations.map((x) => [x.operationId, x.throughStreamSeq]),
    );
    for (const o of t.ops.values()) {
      if (o.owedCreditChunks > 0) {
        this.credit(t, o, o.through, o.owedCreditBytes, o.owedCreditChunks);
        o.owedCreditBytes = 0;
        o.owedCreditChunks = 0;
      }
      if (!o.receipt) {
        o.sent.add(
          this.sequenced(t, {
            t: "operation_request",
            version: AGENT_HOST_PROTOCOL_VERSION,
            requestId: t.requestId,
            fence: t.fence,
            operationId: o.request.operationId,
            descriptor: o.request.descriptor,
            descriptorDigest: o.request.descriptorDigest,
            deadlineMs: o.request.deadlineMs,
          } as never),
        );
      } else
        await this.queryOp(t, {
          operationId: o.request.operationId,
          kind: o.request.descriptor.kind,
          descriptorDigest: o.request.descriptorDigest,
          payloadDigest: o.receipt.payloadDigest,
          afterStreamSeq: c.get(o.request.operationId) ?? 0,
        });
    }
  }
  private send(p: Peer, m: AgentHostServerMessage) {
    try {
      return this.sendBytes(
        p,
        encodeNdjsonFrame(m, this.options.maxFrameBytes),
      );
    } catch {
      return false;
    }
  }
  private sendBytes(p: Peer, b: Buffer) {
    if (
      p.closed ||
      !p.socket.writable ||
      p.socket.writableLength + p.queuedBytes + b.length >
        MAX_AGENT_HOST_WRITABLE_BYTES
    ) {
      this.close(p);
      return false;
    }
    p.queuedBytes += b.length;
    p.writes = p.writes
      .then(
        () =>
          new Promise<void>((ok, fail) => {
            if (
              p.closed ||
              p.socket.writableLength + b.length > MAX_AGENT_HOST_WRITABLE_BYTES
            )
              return fail();
            p.socket.write(b, (e) => (e ? fail(e) : ok()));
          }),
      )
      .finally(() => {
        p.queuedBytes -= b.length;
      })
      .catch(() => this.close(p));
    return true;
  }
  private disconnected(p: Peer) {
    p.closed = true;
    this.peers.delete(p);
    this.clear(p.timer);
    if (this.attaching === p) this.attaching = undefined;
    const t = this.active;
    if (t?.owner === p)
      t.reconnect = this.set(
        () => {
          void this.hit("onReconnectDeadline").finally(() =>
            this.cancelTurn(t, "reconnect_deadline"),
          );
        },
        this.duration(
          this.options.reconnectGraceMs,
          30_000,
          "reconnectGraceMs",
        ),
      );
    else if (this.owner === p) this.owner = undefined;
  }
  private cancelTurn(t: Turn, reason: AgentHostOperationCancelV4["reason"]) {
    if (this.active !== t || t.cancelling) return;
    t.cancelling = true;
    for (const o of t.ops.values())
      if (!o.terminal)
        void this.cancelOp(t, {
          operationId: o.request.operationId,
          cancelId: `cancel-${crypto.randomUUID()}`,
          reason,
        }).catch(() => {});
    let p;
    try {
      p = Promise.resolve(t.driver.cancel());
    } catch (e) {
      p = Promise.reject(e);
    }
    const timer = this.set(
      () => {
        if (!t.cancelSettled) this.poisoned = true;
      },
      this.duration(
        this.options.cancellationDeadlineMs,
        5000,
        "cancellationDeadlineMs",
      ),
    );
    void p.finally(() => {
      this.clear(timer);
      t.cancelSettled = true;
      this.complete(t);
    });
  }
  private consumptionAck(
    t: Turn,
    m: Extract<AgentHostClientMessage, { t: "consumption_ack" }>,
  ) {
    if (m.ackHostSeq < t.acknowledgedHostSeq || m.ackHostSeq > t.seq)
      return this.invalid(t.owner!, m);
    const cursors = new Map(
      m.operations.map((item) => [item.operationId, item.throughStreamSeq]),
    );
    for (const [operationId, throughStreamSeq] of cursors) {
      const operation = t.ops.get(operationId);
      const previous = t.acknowledgedStreams.get(operationId) ?? 0;
      if (
        !operation ||
        throughStreamSeq < previous ||
        throughStreamSeq > operation.through
      )
        return this.invalid(t.owner!, m);
    }
    t.acknowledgedHostSeq = m.ackHostSeq;
    for (const [operationId, throughStreamSeq] of cursors)
      t.acknowledgedStreams.set(operationId, throughStreamSeq);
    this.complete(t);
  }
  private terminalAck(
    t: Turn,
    m: Extract<AgentHostClientMessage, { t: "turn_terminal_ack" }>,
  ) {
    const terminal = t.terminal;
    if (
      !terminal ||
      m.ackHostSeq !== terminal.hostSeq ||
      m.resultDigest !== terminal.resultDigest ||
      m.receiptsDigest !== terminal.receiptsDigest
    )
      return this.invalid(t.owner!, m);
    this.clear(t.deadline);
    this.clear(t.reconnect);
    for (const operation of t.ops.values()) this.clear(operation.timer);
    this.active = undefined;
    if (this.owner === t.owner) this.owner = undefined;
    this.close(t.owner!);
  }
  private complete(t: Turn) {
    if (
      this.active !== t ||
      t.terminal ||
      t.completing ||
      !t.runSettled ||
      [...t.ops.values()].some((o) => !o.terminal || o.pending) ||
      (t.cancelling && !t.cancelSettled) ||
      t.acknowledgedHostSeq !== t.seq ||
      [...t.ops].some(
        ([operationId, operation]) =>
          (t.acknowledgedStreams.get(operationId) ?? 0) !== operation.through,
      )
    )
      return;
    t.completing = true;
    void this.projectTerminal(t).catch(() => {
      t.completing = false;
      this.cancelTurn(t, "shutdown");
    });
  }
  private async projectTerminal(t: Turn) {
    const result = t.result!;
    const operations = await projectAgentTurnTerminalOperationsV1(
      [...t.ops].map(([operationId, operation]) => ({
        operationId,
        receipt: operation.receipt!,
        throughStreamSeq: operation.through,
      })),
    );
    const [resultDigest, receiptsDigest] = await Promise.all([
      hashAgentTurnResultV1(result),
      hashAgentTurnTerminalReceiptsV1(operations),
    ]);
    if (this.active !== t || t.terminal) return;
    const finalAckHostSeq = t.acknowledgedHostSeq;
    const frame = {
      t: "turn_terminal" as const,
      version: AGENT_HOST_PROTOCOL_VERSION,
      requestId: t.requestId,
      fence: t.fence,
      hostGeneration: this.options.hostGeneration,
      hostIncarnation: this.options.hostIncarnation,
      result: { status: result.status },
      resultDigest,
      receiptsDigest,
      finalAckHostSeq,
      operations,
    };
    const hostSeq = this.buffer(t, frame as never);
    t.terminal = Object.freeze({
      ...frame,
      hostSeq,
      result: Object.freeze(frame.result),
    });
    this.writeBuffered(t, hostSeq);
  }
  private close(p: Peer) {
    if (!p.closed) {
      p.closed = true;
      p.socket.destroy();
    }
  }
}
export function createAgentHost(options: AgentHostOptions) {
  return new AgentHost(options);
}
