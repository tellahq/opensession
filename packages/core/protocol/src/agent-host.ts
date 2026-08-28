import {
  decodeAgentOperationDescriptorV1,
  decodeAgentOperationReceiptV1,
  hashAgentOperationDescriptorV1,
  hashAgentOperationReceiptV1,
  type AgentOperationDescriptorV1,
  type AgentOperationDigest,
  type AgentOperationKind,
  type AgentOperationReceiptV1,
} from "./agent-operation";
import { decodeExecutorId } from "./executor";
import { decodeAgentTurnFence, isAgentTurnFence, type AgentTurnFence } from "./agent-host-fence";
import type {
  ExpectedAgentHostSupervisionBindingsV3,
  SignedAgentHostSupervisionEnvelopeV1,
} from "./agent-host-supervision";
export { decodeAgentTurnFence, isAgentTurnFence, type AgentTurnFence } from "./agent-host-fence";

export const AGENT_HOST_PROTOCOL_VERSION = 5 as const;
export const AGENT_HOST_SUPERVISION_VERSION = 2 as const;
export const AGENT_HOST_SUPERVISION_AUDIENCE = "opensession-agent-host" as const;
export const AGENT_HOST_SUPERVISION_PURPOSE = "agent-host-supervision" as const;
export const MAX_AGENT_HOST_SUPERVISION_LEASE_MS = 5 * 60_000;
export const MAX_AGENT_HOST_SUPERVISION_CLOCK_SKEW_MS = 30_000;
export const MAX_AGENT_TRANSCRIPT_APPEND_BYTES = 768 * 1024;
export const MAX_AGENT_OPERATION_DURATION_MS = 5 * 60_000;
export const MAX_AGENT_TURN_DURATION_MS = 24 * 60 * 60_000;
export const MAX_AGENT_HOST_IN_FLIGHT_OPERATIONS = 8;
export const MAX_AGENT_HOST_STREAM_CHUNK_BYTES = 48 * 1024;
export const INITIAL_AGENT_HOST_STREAM_CHUNKS = 16;
export const INITIAL_AGENT_HOST_STREAM_BYTES = 256 * 1024;
export const MAX_AGENT_HOST_STREAM_CHUNKS = 32;
export const MAX_AGENT_HOST_STREAM_BYTES = 512 * 1024;
export const MAX_AGENT_HOST_REPLAY_FRAMES = 128;
export const MAX_AGENT_HOST_REPLAY_BYTES = 1024 * 1024;
export const MAX_AGENT_HOST_WRITABLE_BYTES = 512 * 1024;

const textEncoder = new TextEncoder();
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;
const SUPERVISION_TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;
const STREAM_ENCODING = "base64url+opensession-operation-v1" as const;
const record = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  return keys.every((key) => typeof key === "string" && "value" in descriptors[key]! && descriptors[key]!.enumerable);
};
const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
const boundedString = (value: unknown, maxBytes: number, allowEmpty = false): value is string =>
  typeof value === "string" && (allowEmpty || value.length > 0) && textEncoder.encode(value).byteLength <= maxBytes;
const boundedName = (value: unknown, maxBytes = 16 * 1024): value is string => boundedString(value, maxBytes) && !CONTROL_CHARACTER_RE.test(value);
const id = (value: unknown): value is string => typeof value === "string" && !!decodeExecutorId(value);
const digest = (value: unknown): value is AgentOperationDigest => typeof value === "string" && SHA256_RE.test(value);
const uint = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
function immutable<T>(value: T): T | undefined {
  try {
    const clone = structuredClone(value);
    if (JSON.stringify(clone) !== JSON.stringify(value)) return undefined;
    return deepFreeze(clone);
  } catch { return undefined; }
}

export interface AgentHostInitialOperationV4 {
  readonly operationId: string;
  readonly descriptor: AgentOperationDescriptorV1;
  readonly descriptorDigest: AgentOperationDigest;
  readonly deadlineMs: number;
}
export interface AgentTurnSpec {
  readonly fence: Readonly<AgentTurnFence>;
  readonly initialOperation: Readonly<AgentHostInitialOperationV4>;
  readonly transcript: Readonly<{ afterChangeSeq: number; maxAppendBytes: number; requireAck: true }>;
  readonly limits: Readonly<{ turnDeadlineMs: number; maxInFlightOperations: number; maxBufferedStreamBytes: number; maxBufferedStreamChunks: number }>;
}
export function decodeAgentTurnSpec(value: unknown, nowMs = Date.now()): AgentTurnSpec | undefined {
  if (!record(value) || !exact(value, ["fence", "initialOperation", "transcript", "limits"])) return undefined;
  const snapshot = immutable(value);
  if (!snapshot || !record(snapshot)) return undefined;
  const fence = decodeAgentTurnFence(snapshot.fence), initial = snapshot.initialOperation, transcript = snapshot.transcript, limits = snapshot.limits;
  if (!fence || !record(initial) || !exact(initial, ["operationId", "descriptor", "descriptorDigest", "deadlineMs"]) || !id(initial.operationId) || !digest(initial.descriptorDigest) || !positive(initial.deadlineMs) ||
      !record(transcript) || !exact(transcript, ["afterChangeSeq", "maxAppendBytes", "requireAck"]) || !uint(transcript.afterChangeSeq) || !positive(transcript.maxAppendBytes) || transcript.maxAppendBytes > MAX_AGENT_TRANSCRIPT_APPEND_BYTES || transcript.requireAck !== true ||
      !record(limits) || !exact(limits, ["turnDeadlineMs", "maxInFlightOperations", "maxBufferedStreamBytes", "maxBufferedStreamChunks"]) || !positive(limits.turnDeadlineMs) || limits.turnDeadlineMs <= nowMs || limits.turnDeadlineMs > nowMs + MAX_AGENT_TURN_DURATION_MS ||
      initial.deadlineMs <= nowMs || initial.deadlineMs > nowMs + MAX_AGENT_OPERATION_DURATION_MS || initial.deadlineMs > limits.turnDeadlineMs ||
      !positive(limits.maxInFlightOperations) || limits.maxInFlightOperations > MAX_AGENT_HOST_IN_FLIGHT_OPERATIONS || !positive(limits.maxBufferedStreamBytes) || limits.maxBufferedStreamBytes > MAX_AGENT_HOST_STREAM_BYTES || !positive(limits.maxBufferedStreamChunks) || limits.maxBufferedStreamChunks > MAX_AGENT_HOST_STREAM_CHUNKS) return undefined;
  const descriptor = decodeAgentOperationDescriptorV1(initial.descriptor);
  if (!descriptor) return undefined;
  return deepFreeze({ fence, initialOperation: { operationId: initial.operationId, descriptor, descriptorDigest: initial.descriptorDigest, deadlineMs: initial.deadlineMs }, transcript: { afterChangeSeq: transcript.afterChangeSeq, maxAppendBytes: transcript.maxAppendBytes, requireAck: true }, limits: { turnDeadlineMs: limits.turnDeadlineMs, maxInFlightOperations: limits.maxInFlightOperations, maxBufferedStreamBytes: limits.maxBufferedStreamBytes, maxBufferedStreamChunks: limits.maxBufferedStreamChunks } });
}
const AGENT_TURN_PLAN_HASH_DOMAIN = "OpenSession-Agent-Turn-Plan-v2\0";
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export async function hashAgentTurnSpecV2(spec: AgentTurnSpec, nowMs = Date.now()): Promise<AgentOperationDigest> {
  const decoded = decodeAgentTurnSpec(spec, nowMs);
  if (!decoded) throw new TypeError("Invalid Agent Host turn specification");
  if (await hashAgentOperationDescriptorV1(decoded.initialOperation.descriptor) !== decoded.initialOperation.descriptorDigest) throw new TypeError("Agent Host descriptor digest mismatch");
  const bytes = textEncoder.encode(`${AGENT_TURN_PLAN_HASH_DOMAIN}${JSON.stringify(canonical(decoded))}`);
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...result].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

interface Base { readonly t: string; readonly version: 5; readonly requestId: string }
interface Fenced extends Base { readonly fence: Readonly<AgentTurnFence> }
export interface AgentHostAttachResumeCursorV4 { readonly lastHostSeq: number; readonly operations: readonly Readonly<{ operationId: string; throughStreamSeq: number }>[] }
export interface AgentHostChallengeDescriptorV4 { readonly hostId: string; readonly hostGeneration: number; readonly hostIncarnation: string; readonly hostChallenge: string }
export type AgentHostChallengeDescriptorV3 = AgentHostChallengeDescriptorV4;
export interface AgentHostSignedAttachReceiptV4 { readonly expected: ExpectedAgentHostSupervisionBindingsV3; readonly envelope: SignedAgentHostSupervisionEnvelopeV1 }
export type AgentHostSignedAttachReceiptV3 = AgentHostSignedAttachReceiptV4;
export type AgentHostAttachV4 = Fenced & { readonly t: "attach"; readonly planHash: AgentOperationDigest; readonly receipt: AgentHostSignedAttachReceiptV4; readonly resume: AgentHostAttachResumeCursorV4 | null };
export type AgentHostAttachedV4 = Fenced & { readonly t: "attached"; readonly planHash: AgentOperationDigest; readonly supervisorEpoch: number; readonly mode: "fresh" | "resumed" | "recovery_required"; readonly replayFromHostSeq: number };
export type AgentHostStartTurnV4 = Base & { readonly t: "start_turn"; readonly planHash: AgentOperationDigest; readonly spec: AgentTurnSpec };
type HostAsync = Fenced & { readonly hostSeq: number; readonly operationId: string };
type GatewayResult = Fenced & { readonly ackHostSeq: number; readonly operationId: string };
export type AgentHostOperationRequestV4 = HostAsync & { readonly t: "operation_request"; readonly descriptor: AgentOperationDescriptorV1; readonly descriptorDigest: AgentOperationDigest; readonly deadlineMs: number };
export type AgentHostOperationQueryV4 = HostAsync & { readonly t: "operation_query"; readonly kind: AgentOperationKind; readonly descriptorDigest: AgentOperationDigest; readonly payloadDigest: AgentOperationDigest; readonly afterStreamSeq: number };
export type AgentHostOperationCancelV4 = HostAsync & { readonly t: "operation_cancel"; readonly cancelId: string; readonly reason: "user" | "turn_deadline" | "shutdown" | "reconnect_deadline" };
export type AgentHostOperationReceiptV4 = GatewayResult & { readonly t: "operation_receipt"; readonly receipt: AgentOperationReceiptV1 };
export type AgentHostOperationQueryReceiptV4 = GatewayResult & { readonly t: "operation_query_receipt"; readonly fromStreamSeq: number; readonly receipt: AgentOperationReceiptV1 };
export type AgentHostOperationCancelReceiptV4 = GatewayResult & { readonly t: "operation_cancel_receipt"; readonly cancelId: string; readonly disposition: "not_started" | "cancelled" | "too_late" | "indeterminate"; readonly receipt: AgentOperationReceiptV1 };
export type AgentHostOperationStreamV4 = Fenced & { readonly t: "operation_stream"; readonly operationId: string; readonly streamSeq: number; readonly encoding: typeof STREAM_ENCODING; readonly bytes: string };
export type AgentHostOperationStreamAckV4 = HostAsync & { readonly t: "operation_stream_ack"; readonly throughStreamSeq: number; readonly creditBytes: number; readonly creditChunks: number };
export interface AgentHostTerminalOperationV5 { readonly operationId: string; readonly receiptDigest: AgentOperationDigest; readonly throughStreamSeq: number }
export type AgentHostConsumptionAckV5 = Fenced & { readonly t: "consumption_ack"; readonly ackHostSeq: number; readonly operations: readonly Readonly<{ operationId: string; throughStreamSeq: number }>[] };
export type AgentHostTurnTerminalV5 = Fenced & { readonly t: "turn_terminal"; readonly hostSeq: number; readonly hostGeneration: number; readonly hostIncarnation: string; readonly result: Readonly<{ status: "completed" | "cancelled" | "failed" }>; readonly resultDigest: AgentOperationDigest; readonly receiptsDigest: AgentOperationDigest; readonly finalAckHostSeq: number; readonly operations: readonly Readonly<AgentHostTerminalOperationV5>[] };
export type AgentHostTurnTerminalAckV5 = Fenced & { readonly t: "turn_terminal_ack"; readonly ackHostSeq: number; readonly resultDigest: AgentOperationDigest; readonly receiptsDigest: AgentOperationDigest };
export type AgentHostClientMessage = (Base & { readonly t: "hello" }) | AgentHostAttachV4 | AgentHostStartTurnV4 | AgentHostOperationReceiptV4 | AgentHostOperationQueryReceiptV4 | AgentHostOperationCancelReceiptV4 | AgentHostOperationStreamV4 | AgentHostConsumptionAckV5 | AgentHostTurnTerminalAckV5;
export type AgentHostServerMessage = (Base & { readonly t: "hello"; readonly accepted: true; readonly hostId: string; readonly hostGeneration: number; readonly hostIncarnation: string; readonly hostChallenge: string }) | AgentHostAttachedV4 | (Fenced & { readonly t: "turn_started"; readonly hostSeq: number }) | AgentHostOperationRequestV4 | AgentHostOperationQueryV4 | AgentHostOperationCancelV4 | AgentHostOperationStreamAckV4 | AgentHostTurnTerminalV5 | (Base & { readonly t: "error"; readonly code: "unsupported_version" | "invalid_request" | "stale_generation" | "host_busy" | "turn_failed"; readonly message: string; readonly fence?: Readonly<AgentTurnFence> });

function base(value: unknown, t: string, keys: readonly string[]): value is Record<string, unknown> { return record(value) && exact(value, keys) && value.t === t && value.version === AGENT_HOST_PROTOCOL_VERSION && id(value.requestId); }
function fenced(value: unknown, t: string, tail: readonly string[]): value is Record<string, unknown> { return base(value, t, ["t", "version", "requestId", "fence", ...tail]) && isAgentTurnFence(value.fence); }
function hostAsync(value: unknown, t: string, tail: readonly string[]): value is Record<string, unknown> { return fenced(value, t, ["hostSeq", "operationId", ...tail]) && positive(value.hostSeq) && id(value.operationId); }
function gateway(value: unknown, t: string, tail: readonly string[]): value is Record<string, unknown> { return fenced(value, t, ["ackHostSeq", "operationId", ...tail]) && uint(value.ackHostSeq) && id(value.operationId); }
function decodeResume(value: unknown): AgentHostAttachResumeCursorV4 | null | undefined {
  if (value === null) return null;
  if (!record(value) || !exact(value, ["lastHostSeq", "operations"]) || !uint(value.lastHostSeq) || !Array.isArray(value.operations) || value.operations.length > 8) return undefined;
  const operations: { operationId: string; throughStreamSeq: number }[] = [];
  for (const item of value.operations) { if (!record(item) || !exact(item, ["operationId", "throughStreamSeq"]) || !id(item.operationId) || !uint(item.throughStreamSeq)) return undefined; operations.push({ operationId: item.operationId, throughStreamSeq: item.throughStreamSeq }); }
  if (operations.some((item, index) => index > 0 && operations[index - 1]!.operationId >= item.operationId)) return undefined;
  return deepFreeze({ lastHostSeq: value.lastHostSeq, operations });
}
export const decodeAgentHostAttachResumeCursorV4 = decodeResume;
function decodeOperationCursors(value: unknown): readonly Readonly<{ operationId: string; throughStreamSeq: number }>[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_AGENT_HOST_IN_FLIGHT_OPERATIONS) return undefined;
  const operations: { operationId: string; throughStreamSeq: number }[] = [];
  for (const item of value) { if (!record(item) || !exact(item, ["operationId", "throughStreamSeq"]) || !id(item.operationId) || !uint(item.throughStreamSeq)) return undefined; operations.push({ operationId: item.operationId, throughStreamSeq: item.throughStreamSeq }); }
  if (operations.some((item, index) => index > 0 && operations[index - 1]!.operationId >= item.operationId)) return undefined;
  return deepFreeze(operations);
}
function decodeExpected(value: unknown): ExpectedAgentHostSupervisionBindingsV3 | undefined {
  const keys = ["fence", "planHash", "hostId", "hostGeneration", "hostIncarnation", "supervisorEpoch", "kernelServiceEpoch", "hostChallenge", "nonce", "audience", "purpose", "keyId", "issuedAtMs", "expiresAtMs"];
  if (!record(value) || !exact(value, keys) || !isAgentTurnFence(value.fence) || !digest(value.planHash) || !id(value.hostId) || !positive(value.hostGeneration) || !boundedName(value.hostIncarnation, 256) || !positive(value.supervisorEpoch) || !boundedName(value.kernelServiceEpoch, 256) || typeof value.hostChallenge !== "string" || !SUPERVISION_TOKEN_RE.test(value.hostChallenge) || typeof value.nonce !== "string" || !SUPERVISION_TOKEN_RE.test(value.nonce) || value.audience !== AGENT_HOST_SUPERVISION_AUDIENCE || value.purpose !== AGENT_HOST_SUPERVISION_PURPOSE || !boundedName(value.keyId, 256) || !uint(value.issuedAtMs) || !positive(value.expiresAtMs) || value.expiresAtMs <= value.issuedAtMs) return undefined;
  return immutable(value) as unknown as ExpectedAgentHostSupervisionBindingsV3;
}
function decodeCanonicalBase64Url(value: unknown, exactBytes: number | undefined, maxBytes: number): value is string {
  if (typeof value !== "string" || value.length < 2 || value.length % 4 === 1 || value.includes("=") || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
    if (binary.length > maxBytes || (exactBytes !== undefined && binary.length !== exactBytes)) return false;
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === value;
  } catch { return false; }
}
function decodeEnvelope(value: unknown): SignedAgentHostSupervisionEnvelopeV1 | undefined {
  if (!record(value) || !exact(value, ["version", "algorithm", "domain", "authorityBytes", "signature"]) || value.version !== 1 || value.algorithm !== "Ed25519" || value.domain !== "opensession.agent-host.supervision.v2" || !decodeCanonicalBase64Url(value.authorityBytes, undefined, 4096) || !decodeCanonicalBase64Url(value.signature, 64, 64)) return undefined;
  return immutable(value) as unknown as SignedAgentHostSupervisionEnvelopeV1;
}
function decodeAttachReceipt(value: unknown): AgentHostSignedAttachReceiptV4 | undefined {
  if (!record(value) || !exact(value, ["expected", "envelope"])) return undefined;
  const expected = decodeExpected(value.expected), envelope = decodeEnvelope(value.envelope);
  return expected && envelope ? deepFreeze({ expected, envelope }) : undefined;
}
function boundReceipt(value: unknown, operationId: string, fence: unknown): AgentOperationReceiptV1 | undefined {
  const receipt = decodeAgentOperationReceiptV1(value);
  return receipt && receipt.operationId === operationId && JSON.stringify(receipt.fence) === JSON.stringify(fence) ? receipt : undefined;
}
export function decodeAgentHostHello(value: unknown) { return base(value, "hello", ["t", "version", "requestId"]) ? immutable(value) as unknown as Extract<AgentHostClientMessage, { t: "hello" }> : undefined; }
export function decodeAgentHostAttach(value: unknown): AgentHostAttachV4 | undefined { if (!fenced(value, "attach", ["planHash", "receipt", "resume"]) || !digest(value.planHash)) return; const receipt = decodeAttachReceipt(value.receipt), resume = decodeResume(value.resume); return receipt && resume !== undefined ? deepFreeze({ ...value, fence: decodeAgentTurnFence(value.fence)!, receipt, resume }) as AgentHostAttachV4 : undefined; }
export function decodeAgentHostAttached(value: unknown): AgentHostAttachedV4 | undefined { return fenced(value, "attached", ["planHash", "supervisorEpoch", "mode", "replayFromHostSeq"]) && digest(value.planHash) && positive(value.supervisorEpoch) && ["fresh", "resumed", "recovery_required"].includes(value.mode as string) && uint(value.replayFromHostSeq) ? immutable(value) as unknown as AgentHostAttachedV4 : undefined; }
export function decodeAgentHostTurnStarted(value: unknown): Extract<AgentHostServerMessage, { t: "turn_started" }> | undefined { return fenced(value, "turn_started", ["hostSeq"]) && positive(value.hostSeq) ? immutable(value) as unknown as Extract<AgentHostServerMessage, { t: "turn_started" }> : undefined; }
export function decodeAgentHostStartTurn(value: unknown, nowMs = Date.now()): AgentHostStartTurnV4 | undefined { if (!base(value, "start_turn", ["t", "version", "requestId", "planHash", "spec"]) || !digest(value.planHash)) return; const spec = decodeAgentTurnSpec(value.spec, nowMs); return spec ? deepFreeze({ ...value, spec }) as AgentHostStartTurnV4 : undefined; }
function decodeAgentHostOperationRequestStructure(value: unknown, nowMs: number, turnDeadlineMs: number): AgentHostOperationRequestV4 | undefined { if (!hostAsync(value, "operation_request", ["descriptor", "descriptorDigest", "deadlineMs"]) || !digest(value.descriptorDigest) || !positive(value.deadlineMs) || value.deadlineMs <= nowMs || value.deadlineMs > nowMs + MAX_AGENT_OPERATION_DURATION_MS || value.deadlineMs > turnDeadlineMs) return; const descriptor = decodeAgentOperationDescriptorV1(value.descriptor); return descriptor ? deepFreeze({ ...value, descriptor }) as AgentHostOperationRequestV4 : undefined; }
export async function decodeAgentHostOperationRequest(value: unknown, nowMs = Date.now(), turnDeadlineMs = nowMs + MAX_AGENT_TURN_DURATION_MS): Promise<AgentHostOperationRequestV4 | undefined> { const decoded = decodeAgentHostOperationRequestStructure(value, nowMs, turnDeadlineMs); return decoded && await hashAgentOperationDescriptorV1(decoded.descriptor) === decoded.descriptorDigest ? decoded : undefined; }
export const decodeAgentHostOperationRequestExact = decodeAgentHostOperationRequest;
export function decodeAgentHostOperationQuery(value: unknown): AgentHostOperationQueryV4 | undefined { return hostAsync(value, "operation_query", ["kind", "descriptorDigest", "payloadDigest", "afterStreamSeq"]) && (value.kind === "model" || value.kind === "mcp") && digest(value.descriptorDigest) && digest(value.payloadDigest) && uint(value.afterStreamSeq) ? immutable(value) as unknown as AgentHostOperationQueryV4 : undefined; }
export function decodeAgentHostOperationCancel(value: unknown): AgentHostOperationCancelV4 | undefined { return hostAsync(value, "operation_cancel", ["cancelId", "reason"]) && id(value.cancelId) && ["user", "turn_deadline", "shutdown", "reconnect_deadline"].includes(value.reason as string) ? immutable(value) as unknown as AgentHostOperationCancelV4 : undefined; }
export function decodeAgentHostOperationReceipt(value: unknown): AgentHostOperationReceiptV4 | undefined { if (!gateway(value, "operation_receipt", ["receipt"])) return; const receipt = boundReceipt(value.receipt, value.operationId as string, value.fence); return receipt ? deepFreeze({ ...value, receipt }) as AgentHostOperationReceiptV4 : undefined; }
export function decodeAgentHostOperationQueryReceipt(value: unknown): AgentHostOperationQueryReceiptV4 | undefined { if (!gateway(value, "operation_query_receipt", ["fromStreamSeq", "receipt"]) || !positive(value.fromStreamSeq)) return; const receipt = boundReceipt(value.receipt, value.operationId as string, value.fence); return receipt ? deepFreeze({ ...value, receipt }) as AgentHostOperationQueryReceiptV4 : undefined; }
export function decodeAgentHostOperationCancelReceipt(value: unknown): AgentHostOperationCancelReceiptV4 | undefined { if (!gateway(value, "operation_cancel_receipt", ["cancelId", "disposition", "receipt"]) || !id(value.cancelId) || !["not_started", "cancelled", "too_late", "indeterminate"].includes(value.disposition as string)) return; const receipt = boundReceipt(value.receipt, value.operationId as string, value.fence); return receipt ? deepFreeze({ ...value, receipt }) as AgentHostOperationCancelReceiptV4 : undefined; }
function canonicalStreamBytes(value: unknown): value is string { if (typeof value !== "string" || value.length < 2 || value.length > 65_536 || !/^[A-Za-z0-9_-]+$/.test(value)) return false; try { const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4); const binary = atob(padded); if (binary.length < 1 || binary.length > MAX_AGENT_HOST_STREAM_CHUNK_BYTES) return false; return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === value; } catch { return false; } }
export function decodeAgentHostOperationStream(value: unknown): AgentHostOperationStreamV4 | undefined { return fenced(value, "operation_stream", ["operationId", "streamSeq", "encoding", "bytes"]) && id(value.operationId) && positive(value.streamSeq) && value.encoding === STREAM_ENCODING && canonicalStreamBytes(value.bytes) ? immutable(value) as unknown as AgentHostOperationStreamV4 : undefined; }
export function decodeAgentHostOperationStreamAck(value: unknown): AgentHostOperationStreamAckV4 | undefined { return hostAsync(value, "operation_stream_ack", ["throughStreamSeq", "creditBytes", "creditChunks"]) && uint(value.throughStreamSeq) && uint(value.creditBytes) && value.creditBytes <= MAX_AGENT_HOST_STREAM_BYTES && uint(value.creditChunks) && value.creditChunks <= MAX_AGENT_HOST_STREAM_CHUNKS ? immutable(value) as unknown as AgentHostOperationStreamAckV4 : undefined; }
export function decodeAgentHostConsumptionAck(value: unknown): AgentHostConsumptionAckV5 | undefined { if (!fenced(value, "consumption_ack", ["ackHostSeq", "operations"]) || !uint(value.ackHostSeq)) return; const operations = decodeOperationCursors(value.operations); return operations ? deepFreeze({ ...value, operations }) as AgentHostConsumptionAckV5 : undefined; }
export function decodeAgentHostTurnTerminal(value: unknown): AgentHostTurnTerminalV5 | undefined {
  if (!fenced(value, "turn_terminal", ["hostSeq", "hostGeneration", "hostIncarnation", "result", "resultDigest", "receiptsDigest", "finalAckHostSeq", "operations"]) || !positive(value.hostSeq) || !positive(value.hostGeneration) || !boundedName(value.hostIncarnation, 256) || !record(value.result) || !exact(value.result, ["status"]) || !["completed", "cancelled", "failed"].includes(value.result.status as string) || !digest(value.resultDigest) || !digest(value.receiptsDigest) || !uint(value.finalAckHostSeq) || value.finalAckHostSeq >= value.hostSeq) return;
  if (!Array.isArray(value.operations) || value.operations.length > MAX_AGENT_HOST_IN_FLIGHT_OPERATIONS) return;
  const operations: AgentHostTerminalOperationV5[] = [];
  for (const item of value.operations) { if (!record(item) || !exact(item, ["operationId", "receiptDigest", "throughStreamSeq"]) || !id(item.operationId) || !digest(item.receiptDigest) || !uint(item.throughStreamSeq)) return; operations.push({ operationId: item.operationId, receiptDigest: item.receiptDigest, throughStreamSeq: item.throughStreamSeq }); }
  if (operations.some((item, index) => index > 0 && operations[index - 1]!.operationId >= item.operationId)) return;
  return deepFreeze({ ...value, operations }) as unknown as AgentHostTurnTerminalV5;
}
export function decodeAgentHostTurnTerminalAck(value: unknown): AgentHostTurnTerminalAckV5 | undefined { return fenced(value, "turn_terminal_ack", ["ackHostSeq", "resultDigest", "receiptsDigest"]) && positive(value.ackHostSeq) && digest(value.resultDigest) && digest(value.receiptsDigest) ? immutable(value) as unknown as AgentHostTurnTerminalAckV5 : undefined; }
const AGENT_TURN_RESULT_HASH_DOMAIN = "OpenSession-Agent-Turn-Result-v1\0";
const AGENT_TURN_RECEIPTS_HASH_DOMAIN = "OpenSession-Agent-Turn-Receipts-v1\0";
async function hashTerminalValue(domain: string, value: unknown): Promise<AgentOperationDigest> { const bytes = textEncoder.encode(`${domain}${JSON.stringify(canonical(value))}`); const result = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return `sha256:${[...result].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`; }
export function hashAgentTurnResultV1(result: Readonly<{ status: "completed" | "cancelled" } | { status: "failed"; error: string }>): Promise<AgentOperationDigest> { return hashTerminalValue(AGENT_TURN_RESULT_HASH_DOMAIN, result); }
export async function projectAgentTurnTerminalOperationsV1(operations: readonly Readonly<{ operationId: string; receipt: AgentOperationReceiptV1; throughStreamSeq: number }>[]): Promise<readonly Readonly<AgentHostTerminalOperationV5>[]> { const projected = await Promise.all(operations.map(async (operation) => ({ operationId: operation.operationId, receiptDigest: await hashAgentOperationReceiptV1(operation.receipt), throughStreamSeq: operation.throughStreamSeq }))); projected.sort((a, b) => a.operationId.localeCompare(b.operationId)); return deepFreeze(projected); }
export function hashAgentTurnTerminalReceiptsV1(operations: readonly Readonly<AgentHostTerminalOperationV5>[]): Promise<AgentOperationDigest> { return hashTerminalValue(AGENT_TURN_RECEIPTS_HASH_DOMAIN, operations); }

export interface AgentHostSupervisionAuthorityV2 {
  readonly version: typeof AGENT_HOST_SUPERVISION_VERSION;
  readonly fence: Readonly<AgentTurnFence>;
  readonly planHash: string;
  readonly hostId: string;
  readonly hostGeneration: number;
  readonly hostIncarnation: string;
  readonly supervisorEpoch: number;
  readonly kernelServiceEpoch: string;
  readonly hostChallenge: string;
  readonly audience: typeof AGENT_HOST_SUPERVISION_AUDIENCE;
  readonly purpose: typeof AGENT_HOST_SUPERVISION_PURPOSE;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly nonce: string;
  readonly keyId: string;
}

const SUPERVISION_KEYS = [
  "version",
  "fence",
  "planHash",
  "hostId",
  "hostGeneration",
  "hostIncarnation",
  "supervisorEpoch",
  "kernelServiceEpoch",
  "hostChallenge",
  "audience",
  "purpose",
  "issuedAtMs",
  "expiresAtMs",
  "nonce",
  "keyId",
] as const;

/** Strict structural decode. Time admission is optional so persisted receipts
 * remain decodable after expiry. Unknown fields fail closed. */
export function decodeAgentHostSupervisionAuthorityV2(
  value: unknown,
  nowMs?: number,
): AgentHostSupervisionAuthorityV2 | undefined {
  if (
    !record(value) ||
    Object.keys(value).length !== SUPERVISION_KEYS.length ||
    !exact(value, SUPERVISION_KEYS)
  )
    return undefined;
  if (
    value.version !== AGENT_HOST_SUPERVISION_VERSION ||
    !isAgentTurnFence(value.fence) ||
    typeof value.planHash !== "string" ||
    !SHA256_RE.test(value.planHash) ||
    !decodeExecutorId(value.hostId) ||
    !Number.isSafeInteger(value.hostGeneration) ||
    (value.hostGeneration as number) < 1 ||
    !boundedName(value.hostIncarnation, 256) ||
    !Number.isSafeInteger(value.supervisorEpoch) ||
    (value.supervisorEpoch as number) < 1 ||
    !boundedName(value.kernelServiceEpoch, 256) ||
    typeof value.hostChallenge !== "string" ||
    !SUPERVISION_TOKEN_RE.test(value.hostChallenge) ||
    value.audience !== AGENT_HOST_SUPERVISION_AUDIENCE ||
    value.purpose !== AGENT_HOST_SUPERVISION_PURPOSE ||
    !Number.isSafeInteger(value.issuedAtMs) ||
    (value.issuedAtMs as number) < 0 ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    (value.expiresAtMs as number) <= (value.issuedAtMs as number) ||
    (value.expiresAtMs as number) - (value.issuedAtMs as number) >
      MAX_AGENT_HOST_SUPERVISION_LEASE_MS ||
    typeof value.nonce !== "string" ||
    !SUPERVISION_TOKEN_RE.test(value.nonce) ||
    !boundedName(value.keyId, 256)
  )
    return undefined;
  if (
    nowMs !== undefined &&
    ((value.issuedAtMs as number) >
      nowMs + MAX_AGENT_HOST_SUPERVISION_CLOCK_SKEW_MS ||
      (value.expiresAtMs as number) <= nowMs)
  )
    return undefined;

  return Object.freeze({
    version: AGENT_HOST_SUPERVISION_VERSION,
    fence: Object.freeze({ ...(value.fence as AgentTurnFence) }),
    planHash: value.planHash,
    hostId: value.hostId,
    hostGeneration: value.hostGeneration,
    hostIncarnation: value.hostIncarnation,
    supervisorEpoch: value.supervisorEpoch,
    kernelServiceEpoch: value.kernelServiceEpoch,
    hostChallenge: value.hostChallenge,
    audience: AGENT_HOST_SUPERVISION_AUDIENCE,
    purpose: AGENT_HOST_SUPERVISION_PURPOSE,
    issuedAtMs: value.issuedAtMs,
    expiresAtMs: value.expiresAtMs,
    nonce: value.nonce,
    keyId: value.keyId,
  } as AgentHostSupervisionAuthorityV2);
}

/** Canonical UTF-8 JSON with a fixed field order. The bytes, not a mutable
 * object supplied by a gateway, are the future signer's input. */
export function serializeAgentHostSupervisionAuthorityV2(
  value: AgentHostSupervisionAuthorityV2,
): Uint8Array {
  const decoded = decodeAgentHostSupervisionAuthorityV2(value);
  if (!decoded) throw new Error("Invalid Agent Host supervision authority");
  return textEncoder.encode(
    JSON.stringify({
      version: decoded.version,
      fence: {
        sessionId: decoded.fence.sessionId,
        runId: decoded.fence.runId,
        turnId: decoded.fence.turnId,
        generation: decoded.fence.generation,
      },
      planHash: decoded.planHash,
      hostId: decoded.hostId,
      hostGeneration: decoded.hostGeneration,
      hostIncarnation: decoded.hostIncarnation,
      supervisorEpoch: decoded.supervisorEpoch,
      kernelServiceEpoch: decoded.kernelServiceEpoch,
      hostChallenge: decoded.hostChallenge,
      audience: decoded.audience,
      purpose: decoded.purpose,
      issuedAtMs: decoded.issuedAtMs,
      expiresAtMs: decoded.expiresAtMs,
      nonce: decoded.nonce,
      keyId: decoded.keyId,
    }),
  );
}

export async function hashAgentHostSupervisionAuthorityV2(
  value: AgentHostSupervisionAuthorityV2,
): Promise<string> {
  const bytes = serializeAgentHostSupervisionAuthorityV2(value);
  const source = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
