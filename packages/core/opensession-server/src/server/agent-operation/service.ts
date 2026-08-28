import {
  hashAgentMcpPayloadV1,
  hashAgentModelPayloadV1,
  hashAgentOperationDescriptorV1,
  type AgentOperationDescriptorV1,
  type AgentOperationDigest,
  type AgentOperationReceiptV1,
  type AgentTranscriptAnchorV1,
} from "@tellahq/opensession-protocol/agent-operation";
import type { AgentTurnFence } from "@tellahq/opensession-protocol/agent-host";
import type { SignedAgentHostSupervisionEnvelopeV1 } from "@tellahq/opensession-protocol/agent-host-supervision";
import { types as utilTypes } from "node:util";
import type {
  AgentHostCancelIntent,
  AgentHostCancelResult,
  AgentHostDispatchIntent,
  AgentHostOperationResult,
  AgentHostOperationStreamAckIntent,
  AgentHostQueryIntent,
  AgentHostQueryResult,
} from "../agent-host-client";
import {
  AgentOperationGateway,
  type AgentOperationGatewayOptions,
  type VerifiedAgentSupervision,
} from "./gateway";
import type {
  AgentGatewayPolicyHandle,
  AgentGatewayGrantRegistry,
} from "./grants";
import type { AgentOperationAuthorizedQuery } from "./authorized-query";
import type { AgentOperationIdentity, AgentOperationRecord } from "./ledger";
import {
  AgentOperationStreamJournal,
  AgentOperationStreamRecoveryRequiredError,
} from "./stream-journal";

const DEFAULT_MAX_PLANS = 1_024;
const DEFAULT_MAX_CANONICAL_PAYLOAD_BYTES = 1024 * 1024;
const PLAN_KEYS = [
  "operationId", "fence", "kind", "descriptor", "descriptorDigest", "payload",
  "canonicalPayloadBytes", "transcriptAnchor", "toolUseEntryId", "adapterId",
  "adapterVersion", "deadlineMs", "policyHandle", "retainPayloadIdentity",
] as const;

export interface AgentOperationPlan {
  readonly operationId: string;
  readonly fence: Readonly<AgentTurnFence>;
  readonly kind: "model" | "mcp";
  readonly descriptor: AgentOperationDescriptorV1;
  readonly descriptorDigest: AgentOperationDigest;
  readonly payload: unknown;
  readonly canonicalPayloadBytes: Uint8Array;
  readonly transcriptAnchor: Readonly<AgentTranscriptAnchorV1>;
  readonly toolUseEntryId?: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly deadlineMs: number;
  readonly policyHandle: AgentGatewayPolicyHandle;
  /** Only for a deeply immutable, gateway-private model capability whose identity is significant. */
  readonly retainPayloadIdentity?: true;
}
export interface AgentOperationCancellationFacade {
  request(
    identity: AgentOperationIdentity,
    cancelId: string,
    reason: AgentHostCancelIntent["reason"],
  ): Promise<"requested" | "too_late">;
}
export interface AgentOperationServiceOptions {
  readonly grants: AgentGatewayGrantRegistry;
  readonly gateway: Omit<
    AgentOperationGatewayOptions,
    "grants" | "beginLiveExecution" | "verifySupervision"
  >;
  readonly verifySupervision: (
    envelope: SignedAgentHostSupervisionEnvelopeV1,
    intent: Readonly<{
      operationId: string;
      fence: AgentTurnFence;
      kind: "model" | "mcp";
      descriptorDigest: AgentOperationDigest;
    }>,
  ) => Promise<VerifiedAgentSupervision | undefined>;
  readonly authorizedReceiptReader: (
    query: Readonly<AgentOperationAuthorizedQuery>,
  ) => Promise<AgentOperationRecord | undefined>;
  readonly cancellation: AgentOperationCancellationFacade;
  readonly closeOwners?: readonly (() => void | Promise<void>)[];
  readonly closeTimeoutMs?: number;
  readonly maxPlans?: number;
  readonly maxCanonicalPayloadBytes?: number;
  /** Runtime-owned timeout injection. Construction and module import schedule nothing. */
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => () => void;
}
type StoredPlan = AgentOperationPlan & { payloadDigest: AgentOperationDigest };
type Entry = {
  plan: StoredPlan;
  identity?: AgentOperationIdentity;
  journal?: AgentOperationStreamJournal;
  controller?: AbortController;
  task?: Promise<AgentOperationRecord>;
  dispatchStarted: boolean;
  terminal?: AgentOperationRecord;
  started?: Promise<AgentOperationRecord>;
  resolveStarted?: (record: AgentOperationRecord) => void;
  rejectStarted?: (error: unknown) => void;
  removeAbortListener?: () => void;
};

/** Boot-owned, import-inert coordinator. Construction performs no I/O. */
export class AgentOperationService {
  readonly #options: AgentOperationServiceOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #gateway: AgentOperationGateway;
  readonly #maxPlans: number;
  readonly #maxCanonicalPayloadBytes: number;
  #registering = 0;
  #ready = false;
  #recovering = false;
  #startTask?: Promise<void>;
  #failed = false;
  #closing = false;

  constructor(options: AgentOperationServiceOptions) {
    this.#options = options;
    this.#maxPlans = positive(options.maxPlans ?? DEFAULT_MAX_PLANS, "plan capacity");
    this.#maxCanonicalPayloadBytes = positive(
      options.maxCanonicalPayloadBytes ?? DEFAULT_MAX_CANONICAL_PAYLOAD_BYTES,
      "canonical payload byte limit",
    );
    this.#gateway = new AgentOperationGateway({
      ...options.gateway,
      grants: options.grants,
      verifySupervision: (envelope, request) => options.verifySupervision(envelope, request),
      beginLiveExecution: async (record) => {
        const entry = this.#entries.get(key(record.fence, record.operationId));
        if (!entry) throw new Error("operation plan unavailable");
        const journal = (entry.journal ??= new AgentOperationStreamJournal());
        entry.identity = record;
        entry.resolveStarted?.(record);
        return journal;
      },
    });
  }

  start(): Promise<void> {
    if (this.#ready) return Promise.resolve();
    if (this.#closing)
      return Promise.reject(new Error("agent operation service is closing"));
    if (this.#startTask) return this.#startTask;
    this.#recovering = true;
    const task = this.#gateway.recoverActive().then(() => {
      this.#ready = true;
    }, (error) => {
      this.#failed = true;
      throw error;
    }).finally(() => {
      this.#recovering = false;
    });
    this.#startTask = task;
    return task;
  }

  async registerPlan(input: Readonly<AgentOperationPlan>): Promise<void> {
    this.#admit();
    if (this.#entries.size + this.#registering >= this.#maxPlans)
      throw new Error("agent operation plan registry is full");
    this.#registering++;
    try {
      const plan = snapshotPlan(input, this.#maxCanonicalPayloadBytes);
      const descriptorDigest = await hashAgentOperationDescriptorV1(plan.descriptor);
      if (descriptorDigest !== plan.descriptorDigest || plan.kind !== plan.descriptor.kind)
        throw new Error("operation plan digest mismatch");
      const payloadDigest = await payloadHash(plan.kind, plan.canonicalPayloadBytes);
      const stored = Object.freeze({ ...plan, payloadDigest }) as StoredPlan;
      const id = key(plan.fence, plan.operationId);
      if (this.#entries.has(id)) throw new Error("operation plan already registered");
      this.#entries.set(id, { plan: stored, dispatchStarted: false });
    } finally {
      this.#registering--;
    }
  }

  dispatchOperation = async (
    intent: Readonly<AgentHostDispatchIntent>,
    signal: AbortSignal,
  ): Promise<AgentHostOperationResult> => {
    this.#admit();
    const entry = this.#exact(intent);
    const verified = await this.#verified(intent);
    if (intent.deadlineMs !== entry.plan.deadlineMs)
      throw new Error("operation deadline mismatch");
    if (await hashAgentOperationDescriptorV1(intent.descriptor) !== entry.plan.descriptorDigest)
      throw new Error("operation descriptor mismatch");

    const repeated = entry.dispatchStarted;
    if (!repeated) this.#beginDispatch(entry, intent, verified, signal);
    const record = repeated
      ? await this.#readExisting(entry, verified)
      : entry.terminal ?? await Promise.race([entry.started!, entry.task!]);
    entry.identity = record;
    return {
      receipt: record.receipt,
      ...(entry.journal
        ? { chunks: entry.journal.replay(entry.journal.acknowledgedThrough) }
        : {}),
    };
  };

  queryOperation = async (
    intent: Readonly<AgentHostQueryIntent>,
    _signal: AbortSignal,
  ): Promise<AgentHostQueryResult> => {
    this.#admit();
    const entry = this.#exact(intent);
    const verified = await this.#verified(intent);
    if (intent.payloadDigest !== undefined && intent.payloadDigest !== entry.plan.payloadDigest)
      throw new Error("operation payload digest mismatch");
    if (
      intent.descriptor !== undefined &&
      await hashAgentOperationDescriptorV1(intent.descriptor) !== entry.plan.descriptorDigest
    ) throw new Error("operation descriptor mismatch");
    entry.identity ??= identityFrom(entry.plan, verified);
    const record = await this.#options.authorizedReceiptReader(
      authorizedQuery(entry.plan, verified, intent.recovery, intent.payloadDigest),
    );
    if (!record) throw new Error("operation not found");
    entry.terminal = terminal(record) ? record : entry.terminal;
    return {
      receipt: record.receipt,
      fromStreamSeq: intent.afterStreamSeq + 1,
      ...(entry.journal ? { chunks: entry.journal.replay(intent.afterStreamSeq) } : {}),
    };
  };

  cancelOperation = async (
    intent: Readonly<AgentHostCancelIntent>,
    _signal: AbortSignal,
  ): Promise<AgentHostCancelResult> => {
    this.#admit();
    const entry = this.#exact(intent);
    const verified = await this.#verified(intent);
    entry.identity ??= identityFrom(entry.plan, verified);

    // Schema 32 cancellation requires an existing admitted operation. A plan alone
    // is deliberately not represented as a synthetic receipt.
    const receiptQuery = authorizedQuery(
      entry.plan,
      verified,
      false,
      entry.plan.payloadDigest,
    );
    const before = await this.#options.authorizedReceiptReader(receiptQuery);
    if (!before) throw new Error("operation not found");
    const durable = await this.#options.cancellation.request(
      entry.identity,
      intent.cancelId,
      intent.reason,
    );
    if (durable === "requested") entry.controller?.abort();

    let record = before;
    if (durable === "requested" && entry.task) {
      try { record = await entry.task; }
      catch {
        record = (await this.#options.authorizedReceiptReader(receiptQuery)) ?? before;
      }
    } else {
      record = (await this.#options.authorizedReceiptReader(receiptQuery)) ?? before;
    }
    if (!terminal(record))
      throw new Error("operation cancellation has no terminal receipt");
    entry.terminal = record;
    return { disposition: cancellationDisposition(durable, record.receipt), receipt: record.receipt };
  };

  acknowledgeOperationStream = async (
    intent: Readonly<AgentHostOperationStreamAckIntent>,
  ): Promise<void> => {
    this.#admit();
    const entry = this.#exact(intent);
    if (!entry.journal) throw new AgentOperationStreamRecoveryRequiredError();
    entry.journal.acknowledge(intent.throughStreamSeq);
  };

  healthSnapshot() {
    let replayBytes = 0, streams = 0, active = 0;
    for (const entry of this.#entries.values()) {
      if (entry.dispatchStarted && !entry.terminal) active++;
      if (entry.journal) { streams++; replayBytes += entry.journal.bytes; }
    }
    return Object.freeze({
      ready: this.#ready,
      recovering: this.#recovering,
      failed: this.#failed,
      activeOperations: active,
      activeStreams: streams,
      replayBytes,
      infrastructureFallback: false,
    });
  }

  async deleteSession(sessionId: string): Promise<number> {
    const removed: Entry[] = [];
    for (const [id, entry] of this.#entries) {
      if (entry.plan.fence.sessionId !== sessionId) continue;
      this.#entries.delete(id);
      removed.push(entry);
    }
    for (const entry of removed) {
      entry.removeAbortListener?.();
      entry.controller?.abort();
      await entry.journal?.fail();
    }
    this.#options.grants.revokeSession(sessionId);
    return removed.length;
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#ready = false;
    for (const entry of this.#entries.values()) {
      entry.removeAbortListener?.();
      entry.controller?.abort();
      await entry.journal?.fail();
    }
    const tasks = [...this.#entries.values()].flatMap((entry) =>
      entry.task ? [entry.task.catch(() => undefined)] : [],
    );
    const timeoutMs = nonnegative(this.#options.closeTimeoutMs ?? 5_000, "close timeout");
    let cancelTimeout = () => {};
    const timeout = new Promise<void>((resolve) => {
      cancelTimeout = (this.#options.scheduleTimeout ?? defaultScheduleTimeout)(resolve, timeoutMs);
    });
    await Promise.race([Promise.all(tasks).then(() => undefined), timeout]);
    cancelTimeout();
    for (const close of this.#options.closeOwners ?? []) await close();
    this.#options.grants.clear();
    this.#entries.clear();
  }

  async #readExisting(
    entry: Entry,
    verified: VerifiedAgentSupervision,
  ): Promise<AgentOperationRecord> {
    const record = await this.#options.authorizedReceiptReader(
      authorizedQuery(entry.plan, verified, false, entry.plan.payloadDigest),
    );
    if (!record) throw new Error("operation not found");
    if (terminal(record)) entry.terminal = record;
    return record;
  }

  #beginDispatch(
    entry: Entry,
    intent: Readonly<AgentHostDispatchIntent>,
    verified: VerifiedAgentSupervision,
    signal: AbortSignal,
  ) {
    entry.dispatchStarted = true;
    entry.identity = identityFrom(entry.plan, verified);
    entry.controller = new AbortController();
    entry.started = new Promise<AgentOperationRecord>((resolve, reject) => {
      entry.resolveStarted = resolve;
      entry.rejectStarted = reject;
    });
    const onAbort = () => entry.controller?.abort();
    const removeAbortListener = () => {
      signal.removeEventListener("abort", onAbort);
      if (entry.removeAbortListener === removeAbortListener)
        entry.removeAbortListener = undefined;
    };
    entry.removeAbortListener = removeAbortListener;
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      const grant = this.#options.grants.issue({
        operationId: entry.plan.operationId,
        kind: entry.plan.kind,
        fence: entry.plan.fence,
        planHash: verified.authority.planHash as AgentOperationDigest,
        authorityHash: verified.authorityHash,
        supervisorEpoch: verified.authority.supervisorEpoch,
        hostId: verified.authority.hostId,
        hostGeneration: verified.authority.hostGeneration,
        hostIncarnation: verified.authority.hostIncarnation,
        descriptorDigest: entry.plan.descriptorDigest,
        payloadDigest: entry.plan.payloadDigest,
        transcriptAnchor: entry.plan.transcriptAnchor,
        ...(entry.plan.toolUseEntryId ? { toolUseEntryId: entry.plan.toolUseEntryId } : {}),
        adapterId: entry.plan.adapterId,
        adapterVersion: entry.plan.adapterVersion,
        deadlineMs: entry.plan.deadlineMs,
        authorityExpiresAtMs: verified.authority.expiresAtMs,
        policyHandle: entry.plan.policyHandle,
      });
      entry.task = this.#gateway.dispatch({
        version: 1,
        operationId: entry.plan.operationId,
        kind: entry.plan.kind,
        fence: entry.plan.fence,
        supervisionEnvelope: intent.supervisionEnvelope,
        dispatchGrant: grant,
        descriptor: entry.plan.descriptor,
        descriptorDigest: entry.plan.descriptorDigest,
      }, entry.plan.payload, entry.controller.signal);
      void entry.task.then((record) => {
        entry.identity = record;
        if (terminal(record)) entry.terminal = record;
        entry.resolveStarted?.(record);
      }, (error) => entry.rejectStarted?.(error)).finally(removeAbortListener);
    } catch (error) {
      removeAbortListener();
      entry.rejectStarted?.(error);
      entry.task = Promise.reject(error);
      void entry.task.catch(() => undefined);
    }
  }

  #admit() {
    if (!this.#ready || this.#closing || this.#failed)
      throw new Error("agent operation service is not ready");
  }
  #exact(intent: { operationId: string; fence: AgentTurnFence; kind: string; descriptorDigest: string }) {
    const entry = this.#entries.get(key(intent.fence, intent.operationId));
    if (!entry || entry.plan.kind !== intent.kind ||
        entry.plan.descriptorDigest !== intent.descriptorDigest ||
        !sameFence(entry.plan.fence, intent.fence))
      throw new Error("operation plan mismatch");
    return entry;
  }
  async #verified(intent: AgentHostDispatchIntent | AgentHostQueryIntent | AgentHostCancelIntent) {
    const verified = await this.#options.verifySupervision(intent.supervisionEnvelope, intent);
    if (!verified) throw new Error("invalid supervision");
    return verified;
  }
}

function key(fence: Readonly<AgentTurnFence>, operationId: string) {
  return `${fence.sessionId}\0${fence.runId}\0${fence.turnId}\0${fence.generation}\0${operationId}`;
}
function sameFence(a: Readonly<AgentTurnFence>, b: Readonly<AgentTurnFence>) {
  return a.sessionId === b.sessionId && a.runId === b.runId &&
    a.turnId === b.turnId && a.generation === b.generation;
}
function payloadHash(kind: "model" | "mcp", bytes: Uint8Array) {
  return kind === "model" ? hashAgentModelPayloadV1(bytes) : hashAgentMcpPayloadV1(bytes);
}

function snapshotPlan(input: Readonly<AgentOperationPlan>, maxBytes: number): AgentOperationPlan {
  const values = exactDataValues(input, PLAN_KEYS, "operation plan", ["toolUseEntryId", "retainPayloadIdentity"]);
  const bytes = values.canonicalPayloadBytes;
  if (!(bytes instanceof Uint8Array) || utilTypes.isProxy(bytes) || bytes.byteLength > maxBytes)
    throw new TypeError("invalid canonical payload");
  // structuredClone is also the fail-closed Proxy check for all public plan material.
  const fence = immutableClone(values.fence, "operation fence") as Readonly<AgentTurnFence>;
  const descriptor = immutableClone(values.descriptor, "operation descriptor") as AgentOperationDescriptorV1;
  const anchor = immutableClone(values.transcriptAnchor, "transcript anchor") as Readonly<AgentTranscriptAnchorV1>;
  let payload: unknown;
  if (values.retainPayloadIdentity === true) {
    if (values.kind !== "model" || !deeplyImmutableData(values.payload))
      throw new TypeError("invalid retained model capability");
    try { structuredClone(values.payload); } catch { throw new TypeError("invalid retained model capability"); }
    payload = values.payload;
  } else {
    payload = immutableClone(values.payload, "operation payload");
  }
  return Object.freeze({
    operationId: values.operationId as string,
    fence,
    kind: values.kind as "model" | "mcp",
    descriptor,
    descriptorDigest: values.descriptorDigest as AgentOperationDigest,
    payload,
    canonicalPayloadBytes: Uint8Array.from(bytes),
    transcriptAnchor: anchor,
    ...(values.toolUseEntryId === undefined ? {} : { toolUseEntryId: values.toolUseEntryId as string }),
    adapterId: values.adapterId as string,
    adapterVersion: values.adapterVersion as string,
    deadlineMs: values.deadlineMs as number,
    policyHandle: values.policyHandle as AgentGatewayPolicyHandle,
    ...(values.retainPayloadIdentity === true ? { retainPayloadIdentity: true as const } : {}),
  });
}

function exactDataValues(
  value: unknown,
  allowed: readonly string[],
  name: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new TypeError(`invalid ${name}`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key)) ||
      allowed.some((key) => !optional.includes(key) && !descriptors[key]))
    throw new TypeError(`invalid ${name}`);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable)
      throw new TypeError(`invalid ${name}`);
    result[key] = descriptor.value;
  }
  return result;
}
function immutableClone(value: unknown, name: string): unknown {
  if (!safeData(value)) throw new TypeError(`invalid ${name}`);
  try { return deepFreeze(structuredClone(value)); }
  catch { throw new TypeError(`invalid ${name}`); }
}
function safeData(value: unknown, requireFrozen = false, seen = new Set<object>(), depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || utilTypes.isProxy(value) || seen.has(value) || (requireFrozen && !Object.isFrozen(value))) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) return false;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) return false;
  if (Array.isArray(value) && keys.length !== value.length + 1) return false;
  for (const key of keys as string[]) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable || descriptor.value === undefined ||
        !safeData(descriptor.value, requireFrozen, seen, depth + 1)) return false;
  }
  seen.delete(value);
  return true;
}
function deeplyImmutableData(value: unknown) { return safeData(value, true); }
function deepFreeze(value: unknown): unknown {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))
    if ("value" in descriptor) deepFreeze(descriptor.value);
  return Object.freeze(value);
}
function terminal(record: AgentOperationRecord) {
  return record.receipt.state === "settled" || record.receipt.state === "indeterminate";
}
function cancellationDisposition(
  durable: "requested" | "too_late",
  receipt: AgentOperationReceiptV1,
): AgentHostCancelResult["disposition"] {
  if (durable === "too_late") return "too_late";
  if (receipt.state === "indeterminate") return "indeterminate";
  return receipt.outcome?.status === "cancelled" ? "cancelled" : "too_late";
}
function authorizedQuery(
  plan: StoredPlan,
  verified: VerifiedAgentSupervision,
  recovery: boolean,
  payloadDigest: AgentOperationDigest | undefined,
): AgentOperationAuthorizedQuery {
  if (!recovery && payloadDigest === undefined)
    throw new Error("exact operation query requires payload digest");
  const authority = Object.freeze({
    planHash: verified.authority.planHash as AgentOperationDigest,
    authorityHash: verified.authorityHash,
    supervisorEpoch: verified.authority.supervisorEpoch,
    hostId: verified.authority.hostId,
    hostGeneration: verified.authority.hostGeneration,
    hostIncarnation: verified.authority.hostIncarnation,
  });
  const common = {
    operationId: plan.operationId,
    kind: plan.kind,
    fence: plan.fence,
    descriptorDigest: plan.descriptorDigest,
    authority,
  };
  return recovery
    ? Object.freeze({
        ...common,
        mode: "recovery" as const,
        ...(payloadDigest === undefined ? {} : { payloadDigest }),
      })
    : Object.freeze({
        ...common,
        mode: "exact" as const,
        payloadDigest: payloadDigest!,
      });
}
function identityFrom(plan: StoredPlan, verified: VerifiedAgentSupervision): AgentOperationIdentity {
  return {
    operationId: plan.operationId,
    kind: plan.kind,
    fence: plan.fence,
    planHash: verified.authority.planHash as AgentOperationDigest,
    authorityHash: verified.authorityHash,
    supervisorEpoch: verified.authority.supervisorEpoch,
    hostId: verified.authority.hostId,
    hostGeneration: verified.authority.hostGeneration,
    hostIncarnation: verified.authority.hostIncarnation,
    transcriptAnchor: plan.transcriptAnchor,
    ...(plan.toolUseEntryId ? { toolUseEntryId: plan.toolUseEntryId } : {}),
    descriptor: plan.descriptor,
    descriptorDigest: plan.descriptorDigest,
    payloadDigest: plan.payloadDigest,
    adapterId: plan.adapterId,
    adapterVersion: plan.adapterVersion,
  };
}
function positive(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`invalid ${name}`);
  return value;
}
function nonnegative(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`invalid ${name}`);
  return value;
}
function defaultScheduleTimeout(callback: () => void, delayMs: number) {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}
