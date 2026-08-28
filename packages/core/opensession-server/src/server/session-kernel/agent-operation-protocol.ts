import type {
  AgentOperationKind,
  AgentTranscriptReceiptRefV1,
} from "@tellahq/opensession-protocol/agent-operation";

export const AGENT_OPERATION_EVIDENCE_HORIZON_MS = 7 * 24 * 60 * 60 * 1_000;
export const SESSION_KERNEL_MAX_AGENT_OPERATIONS_PER_TURN = 256;
export const SESSION_KERNEL_MAX_AGENT_OPERATIONS_PER_SESSION = 4_096;
export const MAX_AGENT_OPERATION_PROTOCOL_BYTES = 64 * 1024;
export const MAX_AGENT_OPERATION_PROTOCOL_DEPTH = 12;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const OUTCOME = /^[a-z][a-z0-9_]{0,63}$/;
const FORBIDDEN =
  /^(?:accountId|apiKey|args|arguments|authorization|authToken|baseUrl|body|cookie|credentials?|env|environment|headers?|password|prompt|providerConfig|requestBody|responseBody|secret|token|accessToken|url|metadata)$/i;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const id = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);
const digest = (value: unknown): value is `sha256:${string}` =>
  typeof value === "string" && DIGEST.test(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function safe(value: unknown): boolean {
  const seen = new Set<object>();
  let count = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > MAX_AGENT_OPERATION_PROTOCOL_DEPTH || ++count > 2_048)
      return false;
    if (typeof item === "number") return Number.isFinite(item);
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return true;
    if (typeof item !== "object" || seen.has(item as object)) return false;
    seen.add(item as object);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype) return false;
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Reflect.ownKeys(descriptors);
      if (
        keys.some((key) => typeof key !== "string") ||
        keys.length !== item.length + 1
      )
        return false;
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[String(index)];
        if (
          !descriptor ||
          !("value" in descriptor) ||
          !descriptor.enumerable ||
          descriptor.value === undefined ||
          !visit(descriptor.value, depth + 1)
        )
          return false;
      }
      return true;
    }
    if (!record(item)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(item);
    return Reflect.ownKeys(descriptors).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key];
      return (
        !!descriptor &&
        "value" in descriptor &&
        descriptor.enumerable &&
        descriptor.value !== undefined &&
        !FORBIDDEN.test(key) &&
        visit(descriptor.value, depth + 1)
      );
    });
  };
  try {
    if (!visit(value, 0)) return false;
    const snapshot = structuredClone(value);
    return (
      Buffer.byteLength(JSON.stringify(snapshot)) <=
      MAX_AGENT_OPERATION_PROTOCOL_BYTES
    );
  } catch {
    return false;
  }
}

export type AgentOperationAnchor = {
  throughChangeSeq: number;
  digest: `sha256:${string}`;
  entryIds: readonly string[];
};
export type AgentOperationIdentity = {
  sessionId: string;
  runId: string;
  turnId: string;
  generation: number;
  operationId: string;
  kind: AgentOperationKind;
  descriptorDigest: `sha256:${string}`;
  payloadDigest: `sha256:${string}`;
  adapterId: string;
  adapterVersion: string;
  authorityHash: `sha256:${string}`;
  supervisorEpoch: number;
  planHash: `sha256:${string}`;
  hostId: string;
  hostGeneration: number;
  hostIncarnation: string;
  transcriptAnchor: AgentOperationAnchor;
  /** Required only for MCP operations and bound to the exact durable model tool-use entry. */
  toolUseEntryId?: string;
};
export type AgentOperationAdmit = {
  op: "admit";
  identity: AgentOperationIdentity;
};
export type AgentOperationTerminal = {
  op: "settle" | "indeterminate";
  identity: AgentOperationIdentity;
  gatewayReceiptDigest: `sha256:${string}`;
  outputDigest: `sha256:${string}`;
  outcomeCode: string;
  transcriptReceipts: readonly AgentTranscriptReceiptRefV1[];
  /** Required only for model terminals. Ordered, bounded, and unique. */
  pendingToolUseEntryIds?: readonly string[];
};
export type AgentOperationQuery = {
  op: "query";
  identity: AgentOperationIdentity;
};
export const AGENT_OPERATION_CANCELLATION_REASONS = [
  "user",
  "turn_deadline",
  "shutdown",
  "reconnect_deadline",
] as const;
export type AgentOperationCancellationReason =
  (typeof AGENT_OPERATION_CANCELLATION_REASONS)[number];
export type AgentOperationCancel = {
  op: "cancel";
  identity: AgentOperationIdentity;
  cancelId: string;
  reason: AgentOperationCancellationReason;
};
export type AgentOperationRequest =
  | AgentOperationAdmit
  | AgentOperationTerminal
  | AgentOperationQuery
  | AgentOperationCancel;
export type AgentOperationReceipt = {
  identity: AgentOperationIdentity;
  sequence: number;
  state: "admitted" | "settled" | "indeterminate";
  admittedAtMs: number;
  terminalAtMs?: number;
  gatewayReceiptDigest?: `sha256:${string}`;
  outputDigest?: `sha256:${string}`;
  outcomeCode?: string;
  transcriptReceipts?: readonly AgentTranscriptReceiptRefV1[];
  pendingToolUseEntryIds?: readonly string[];
};
export type AgentOperationCancellationIntent = {
  identity: AgentOperationIdentity;
  cancelId: string;
  reason: AgentOperationCancellationReason;
  disposition: "requested" | "too_late";
  requestedAtMs: number;
};
export type AgentOperationCancellationResult =
  | {
      accepted: true;
      replayed: boolean;
      intent: AgentOperationCancellationIntent;
    }
  | {
      accepted: false;
      reason: "invalid_request" | "not_found" | "operation_barrier";
    };
export type AgentOperationResult =
  | { accepted: true; replayed: boolean; receipt: AgentOperationReceipt }
  | {
      accepted: false;
      reason:
        | "invalid_request"
        | "stale_run"
        | "terminal_run"
        | "plan_unregistered"
        | "plan_mismatch"
        | "authority_inactive"
        | "authority_mismatch"
        | "operation_barrier"
        | "operation_order"
        | "transcript_barrier"
        | "indeterminate_turn"
        | "receipt_capacity"
        | "not_found";
    };

const IDENTITY_KEYS = [
  "sessionId",
  "runId",
  "turnId",
  "generation",
  "operationId",
  "kind",
  "descriptorDigest",
  "payloadDigest",
  "adapterId",
  "adapterVersion",
  "authorityHash",
  "supervisorEpoch",
  "planHash",
  "hostId",
  "hostGeneration",
  "hostIncarnation",
  "transcriptAnchor",
] as const;
function decodeAnchor(value: unknown): AgentOperationAnchor | undefined {
  if (
    !record(value) ||
    !exact(value, ["throughChangeSeq", "digest", "entryIds"]) ||
    !integer(value.throughChangeSeq) ||
    !digest(value.digest) ||
    !Array.isArray(value.entryIds) ||
    value.entryIds.length > 512 ||
    !value.entryIds.every(id) ||
    new Set(value.entryIds).size !== value.entryIds.length
  )
    return;
  return {
    throughChangeSeq: value.throughChangeSeq,
    digest: value.digest,
    entryIds: Object.freeze([...value.entryIds]),
  };
}
export function decodeAgentOperationIdentity(
  value: unknown,
): AgentOperationIdentity | undefined {
  if (!record(value)) return;
  const identityKeys =
    value.kind === "mcp" ? [...IDENTITY_KEYS, "toolUseEntryId"] : IDENTITY_KEYS;
  if (!exact(value, identityKeys)) return;
  const anchor = decodeAnchor(value.transcriptAnchor);
  if (
    !id(value.sessionId) ||
    !id(value.runId) ||
    !id(value.turnId) ||
    !integer(value.generation) ||
    !id(value.operationId) ||
    (value.kind !== "model" && value.kind !== "mcp") ||
    !digest(value.descriptorDigest) ||
    !digest(value.payloadDigest) ||
    !id(value.adapterId) ||
    typeof value.adapterVersion !== "string" ||
    !VERSION.test(value.adapterVersion) ||
    !digest(value.authorityHash) ||
    !integer(value.supervisorEpoch) ||
    value.supervisorEpoch < 1 ||
    !digest(value.planHash) ||
    !id(value.hostId) ||
    !integer(value.hostGeneration) ||
    value.hostGeneration < 1 ||
    !id(value.hostIncarnation) ||
    !anchor ||
    (value.kind === "mcp"
      ? !id(value.toolUseEntryId)
      : value.toolUseEntryId !== undefined)
  )
    return;
  return Object.freeze({
    sessionId: value.sessionId,
    runId: value.runId,
    turnId: value.turnId,
    generation: value.generation,
    operationId: value.operationId,
    kind: value.kind,
    descriptorDigest: value.descriptorDigest,
    payloadDigest: value.payloadDigest,
    adapterId: value.adapterId,
    adapterVersion: value.adapterVersion,
    authorityHash: value.authorityHash,
    supervisorEpoch: value.supervisorEpoch,
    planHash: value.planHash,
    hostId: value.hostId,
    hostGeneration: value.hostGeneration,
    hostIncarnation: value.hostIncarnation,
    transcriptAnchor: Object.freeze(anchor),
    ...(value.kind === "mcp"
      ? { toolUseEntryId: value.toolUseEntryId as string }
      : {}),
  });
}
function decodeTranscriptReceipt(
  value: unknown,
): AgentTranscriptReceiptRefV1 | undefined {
  if (
    !record(value) ||
    !exact(value, [
      "appendId",
      "entryIds",
      "firstSeq",
      "lastSeq",
      "throughChangeSeq",
      "requestDigest",
    ]) ||
    !id(value.appendId) ||
    !Array.isArray(value.entryIds) ||
    value.entryIds.length === 0 ||
    value.entryIds.length > 512 ||
    !value.entryIds.every(id) ||
    new Set(value.entryIds).size !== value.entryIds.length ||
    !integer(value.firstSeq) ||
    !integer(value.lastSeq) ||
    value.lastSeq < value.firstSeq ||
    value.entryIds.length !== value.lastSeq - value.firstSeq + 1 ||
    !integer(value.throughChangeSeq) ||
    !digest(value.requestDigest)
  )
    return;
  return Object.freeze({
    ...value,
    entryIds: Object.freeze([...value.entryIds]),
  }) as AgentTranscriptReceiptRefV1;
}
function decodePendingToolUseEntryIds(
  refs: readonly AgentTranscriptReceiptRefV1[],
  value: unknown,
): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    !value.every(id) ||
    new Set(value).size !== value.length
  )
    return;
  const flattened = refs.flatMap((ref) => [...ref.entryIds]);
  if (new Set(flattened).size !== flattened.length) return;
  let priorIndex = -1;
  for (const entryId of value) {
    const index = flattened.indexOf(entryId);
    if (index <= priorIndex) return;
    priorIndex = index;
  }
  return Object.freeze([...value]);
}

export function decodeAgentOperationRequest(
  value: unknown,
): AgentOperationRequest | undefined {
  if (
    !safe(value) ||
    !record(value) ||
    !["admit", "settle", "indeterminate", "query", "cancel"].includes(
      String(value.op),
    )
  )
    return;
  const terminal = value.op === "settle" || value.op === "indeterminate";
  const cancellation = value.op === "cancel";
  if (
    !exact(
      value,
      terminal
        ? [
            "op",
            "identity",
            "gatewayReceiptDigest",
            "outputDigest",
            "outcomeCode",
            "transcriptReceipts",
            ...(record(value.identity) && value.identity.kind === "model"
              ? ["pendingToolUseEntryIds"]
              : []),
          ]
        : cancellation
          ? ["op", "identity", "cancelId", "reason"]
          : ["op", "identity"],
    )
  )
    return;
  const identity = decodeAgentOperationIdentity(value.identity);
  if (!identity) return;
  if (cancellation) {
    if (
      !id(value.cancelId) ||
      !AGENT_OPERATION_CANCELLATION_REASONS.includes(
        value.reason as AgentOperationCancellationReason,
      )
    )
      return;
    return Object.freeze({
      op: "cancel",
      identity,
      cancelId: value.cancelId,
      reason: value.reason,
    }) as AgentOperationCancel;
  }
  if (!terminal)
    return Object.freeze({ op: value.op, identity }) as
      AgentOperationAdmit | AgentOperationQuery;
  if (
    !digest(value.gatewayReceiptDigest) ||
    !digest(value.outputDigest) ||
    typeof value.outcomeCode !== "string" ||
    !OUTCOME.test(value.outcomeCode) ||
    !Array.isArray(value.transcriptReceipts) ||
    value.transcriptReceipts.length === 0 ||
    value.transcriptReceipts.length > 64
  )
    return;
  const refs = value.transcriptReceipts.map(decodeTranscriptReceipt);
  if (
    refs.some((entry) => !entry) ||
    refs.some(
      (entry, index) =>
        index > 0 &&
        (entry!.firstSeq <= refs[index - 1]!.lastSeq ||
          entry!.throughChangeSeq <= refs[index - 1]!.throughChangeSeq),
    )
  )
    return;
  const pending =
    identity.kind === "model"
      ? decodePendingToolUseEntryIds(
          refs as AgentTranscriptReceiptRefV1[],
          value.pendingToolUseEntryIds,
        )
      : undefined;
  if (
    (identity.kind === "model" && !pending) ||
    (identity.kind === "mcp" && value.pendingToolUseEntryIds !== undefined)
  )
    return;
  return Object.freeze({
    op: value.op,
    identity,
    gatewayReceiptDigest: value.gatewayReceiptDigest,
    outputDigest: value.outputDigest,
    outcomeCode: value.outcomeCode,
    transcriptReceipts: Object.freeze(refs as AgentTranscriptReceiptRefV1[]),
    ...(identity.kind === "model" ? { pendingToolUseEntryIds: pending } : {}),
  }) as AgentOperationTerminal;
}

export function decodeAgentOperationReceipt(
  value: unknown,
): AgentOperationReceipt | undefined {
  if (!safe(value) || !record(value)) return;
  const identity = decodeAgentOperationIdentity(value.identity);
  if (
    !identity ||
    !integer(value.sequence) ||
    value.sequence < 1 ||
    !integer(value.admittedAtMs) ||
    !["admitted", "settled", "indeterminate"].includes(String(value.state))
  )
    return;
  if (value.state === "admitted") {
    if (!exact(value, ["identity", "sequence", "state", "admittedAtMs"]))
      return;
    return Object.freeze({
      identity,
      sequence: value.sequence,
      state: "admitted",
      admittedAtMs: value.admittedAtMs,
    });
  }
  const terminalKeys = [
    "identity",
    "sequence",
    "state",
    "admittedAtMs",
    "terminalAtMs",
    "gatewayReceiptDigest",
    "outputDigest",
    "outcomeCode",
    "transcriptReceipts",
    ...(identity.kind === "model" ? ["pendingToolUseEntryIds"] : []),
  ];
  if (
    !exact(value, terminalKeys) ||
    !integer(value.terminalAtMs) ||
    value.terminalAtMs < value.admittedAtMs ||
    !digest(value.gatewayReceiptDigest) ||
    !digest(value.outputDigest) ||
    typeof value.outcomeCode !== "string" ||
    !OUTCOME.test(value.outcomeCode) ||
    !Array.isArray(value.transcriptReceipts) ||
    value.transcriptReceipts.length < 1 ||
    value.transcriptReceipts.length > 64
  )
    return;
  const refs = value.transcriptReceipts.map(decodeTranscriptReceipt);
  if (
    refs.some((entry) => !entry) ||
    refs.some(
      (entry, index) =>
        index > 0 &&
        (entry!.firstSeq <= refs[index - 1]!.lastSeq ||
          entry!.throughChangeSeq <= refs[index - 1]!.throughChangeSeq),
    )
  )
    return;
  const pending =
    identity.kind === "model"
      ? decodePendingToolUseEntryIds(
          refs as AgentTranscriptReceiptRefV1[],
          value.pendingToolUseEntryIds,
        )
      : undefined;
  if (
    (identity.kind === "model" && !pending) ||
    (identity.kind === "mcp" && value.pendingToolUseEntryIds !== undefined)
  )
    return;
  return Object.freeze({
    identity,
    sequence: value.sequence,
    state: value.state,
    admittedAtMs: value.admittedAtMs,
    terminalAtMs: value.terminalAtMs,
    gatewayReceiptDigest: value.gatewayReceiptDigest,
    outputDigest: value.outputDigest,
    outcomeCode: value.outcomeCode,
    transcriptReceipts: Object.freeze(refs as AgentTranscriptReceiptRefV1[]),
    ...(identity.kind === "model" ? { pendingToolUseEntryIds: pending } : {}),
  }) as AgentOperationReceipt;
}

export function decodeAgentOperationCancellationIntent(
  value: unknown,
): AgentOperationCancellationIntent | undefined {
  if (
    !safe(value) ||
    !record(value) ||
    !exact(value, [
      "identity",
      "cancelId",
      "reason",
      "disposition",
      "requestedAtMs",
    ])
  )
    return;
  const identity = decodeAgentOperationIdentity(value.identity);
  if (
    !identity ||
    !id(value.cancelId) ||
    !AGENT_OPERATION_CANCELLATION_REASONS.includes(
      value.reason as AgentOperationCancellationReason,
    ) ||
    (value.disposition !== "requested" && value.disposition !== "too_late") ||
    !integer(value.requestedAtMs)
  )
    return;
  return Object.freeze({
    identity,
    cancelId: value.cancelId,
    reason: value.reason,
    disposition: value.disposition,
    requestedAtMs: value.requestedAtMs,
  }) as AgentOperationCancellationIntent;
}

export function canonicalAgentOperationIdentity(
  value: AgentOperationIdentity,
): string {
  return JSON.stringify(decodeAgentOperationIdentity(value));
}
export function canonicalAgentOperationTerminal(
  value: AgentOperationTerminal,
): string {
  return JSON.stringify(decodeAgentOperationRequest(value));
}
export function canonicalAgentOperationCancellation(
  value: AgentOperationCancel,
): string {
  return JSON.stringify(decodeAgentOperationRequest(value));
}
