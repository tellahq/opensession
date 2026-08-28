import type { SignedAgentHostSupervisionEnvelopeV1 } from "./agent-host-supervision";
import { isAgentTurnFence, type AgentTurnFence } from "./agent-host-fence";

export const AGENT_OPERATION_VERSION = 1 as const;
export const AGENT_GATEWAY_DISPATCH_GRANT_PREFIX = "osag_dispatch_v1." as const;
export const AGENT_OPERATION_DESCRIPTOR_DIGEST_DOMAIN =
  "opensession.agent-operation.descriptor.v1";
export const AGENT_OPERATION_RECEIPT_DIGEST_DOMAIN =
  "opensession.agent-operation.receipt.v1";
export const AGENT_MODEL_PAYLOAD_DIGEST_DOMAIN =
  "opensession.agent-operation.model-payload.v1";
export const AGENT_MCP_PAYLOAD_DIGEST_DOMAIN =
  "opensession.agent-operation.mcp-payload.v1";
export const AGENT_MCP_ARGUMENTS_DIGEST_DOMAIN =
  "opensession.agent-operation.mcp-arguments.v1";
export const MAX_AGENT_OPERATION_BYTES = 64 * 1024;
export const MAX_AGENT_OPERATION_DEPTH = 12;
export const MAX_AGENT_OPERATION_VALUES = 2_048;
const MAX_IDS = 512;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const OUTCOME_CODES: readonly AgentOperationOutcomeCodeV1[] = [
  "ok",
  "policy_rejected",
  "invalid_request",
  "provider_error",
  "tool_error",
  "result_too_large",
  "cancelled",
  "deadline_exceeded",
];
const STOP_REASONS: readonly AgentOperationStopReasonV1[] = [
  "end_turn",
  "tool_use",
  "max_tokens",
  "stop_sequence",
  "cancelled",
  "error",
];
const RESERVATION_REASONS = [
  "reconciliation_unsupported",
  "reconciliation_failed",
  "ambiguous_completion",
  "identity_mismatch",
  "cancellation_ambiguous",
  "timeout_ambiguous",
  "disconnect_ambiguous",
] as const;
const ERROR_CODES = [
  "reconciliation_unsupported",
  "reconciliation_failed",
  "ambiguous_completion",
  "identity_mismatch",
  "cancellation_ambiguous",
  "timeout_ambiguous",
  "disconnect_ambiguous",
  "invalid_response",
  "operation_failed",
] as const;
const ENTROPY = /^[A-Za-z0-9_-]{43,512}$/;
const FORBIDDEN =
  /^(?:accountId|apiKey|args|arguments|authorization|authToken|baseUrl|body|cookie|credentials?|env|environment|headers?|password|prompt|providerConfig|requestBody|responseBody|secret|token|accessToken|url)$/i;
const encoder = new TextEncoder();
const record = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length &&
  Object.keys(v).every((key) => keys.includes(key));
const validId = (v: unknown): v is string =>
  typeof v === "string" && ID.test(v);
const validDigest = (v: unknown): v is AgentOperationDigest =>
  typeof v === "string" && DIGEST.test(v);
const time = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;
function canonicalBase64Url(value: unknown, exactBytes: number | undefined, maxBytes: number): value is string {
  if (typeof value !== "string" || value.length < 2 || value.length % 4 === 1 || value.includes("=") || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
    if (binary.length > maxBytes || (exactBytes !== undefined && binary.length !== exactBytes)) return false;
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") === value;
  } catch { return false; }
}
function decodeSignedAgentHostSupervisionEnvelopeV1(value: unknown): SignedAgentHostSupervisionEnvelopeV1 | undefined {
  if (!record(value) || !exact(value, ["version", "algorithm", "domain", "authorityBytes", "signature"]) || value.version !== 1 || value.algorithm !== "Ed25519" || value.domain !== "opensession.agent-host.supervision.v2" || !canonicalBase64Url(value.authorityBytes, undefined, 4096) || !canonicalBase64Url(value.signature, 64, 64)) return undefined;
  return Object.freeze({ version: 1, algorithm: "Ed25519", domain: "opensession.agent-host.supervision.v2", authorityBytes: value.authorityBytes, signature: value.signature });
}

export type AgentOperationDigest = `sha256:${string}`;
declare const grantBrand: unique symbol;
export type AgentGatewayDispatchGrant = string & {
  readonly [grantBrand]: "AgentGatewayDispatchGrant";
};
export function encodeAgentGatewayDispatchGrant(
  entropy: string,
): AgentGatewayDispatchGrant {
  if (!ENTROPY.test(entropy))
    throw new TypeError("invalid gateway dispatch grant entropy");
  return `${AGENT_GATEWAY_DISPATCH_GRANT_PREFIX}${entropy}` as AgentGatewayDispatchGrant;
}
export function decodeAgentGatewayDispatchGrant(
  value: unknown,
): AgentGatewayDispatchGrant | undefined {
  if (
    typeof value !== "string" ||
    !value.startsWith(AGENT_GATEWAY_DISPATCH_GRANT_PREFIX) ||
    !ENTROPY.test(value.slice(AGENT_GATEWAY_DISPATCH_GRANT_PREFIX.length))
  )
    return undefined;
  return value as AgentGatewayDispatchGrant;
}

export interface AgentTranscriptAnchorV1 {
  throughChangeSeq: number;
  entryIds: readonly string[];
  digest: AgentOperationDigest;
}
export interface AgentModelOperationDescriptorV1 {
  version: 1;
  kind: "model";
  stepId: string;
  transcript: AgentTranscriptAnchorV1;
  modelPolicyHash: AgentOperationDigest;
  adapterRequestVersion: string;
}
export interface AgentMcpOperationDescriptorV1 {
  version: 1;
  kind: "mcp";
  toolUseEntryId: string;
  toolUseId: string;
  server: string;
  tool: string;
  argumentsDigest: AgentOperationDigest;
  adapterRequestVersion: string;
}
export type AgentOperationDescriptorV1 =
  AgentModelOperationDescriptorV1 | AgentMcpOperationDescriptorV1;
export type AgentOperationKind = AgentOperationDescriptorV1["kind"];
export interface AgentOperationRequestV1 {
  version: 1;
  operationId: string;
  kind: AgentOperationKind;
  fence: Readonly<AgentTurnFence>;
  supervisionEnvelope: SignedAgentHostSupervisionEnvelopeV1;
  dispatchGrant: AgentGatewayDispatchGrant;
  descriptor: AgentOperationDescriptorV1;
  descriptorDigest: AgentOperationDigest;
}
export interface AgentOperationQueryV1 {
  version: 1;
  operationId: string;
  kind: AgentOperationKind;
  fence: Readonly<AgentTurnFence>;
  supervisionEnvelope: SignedAgentHostSupervisionEnvelopeV1;
  dispatchGrant: AgentGatewayDispatchGrant;
  descriptorDigest: AgentOperationDigest;
  payloadDigest: AgentOperationDigest;
}
export type AgentOperationState =
  "prepared" | "executing" | "settled" | "indeterminate";
export interface AgentOperationUsageV1 {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
}
export type AgentOperationOutcomeCodeV1 =
  | "ok"
  | "policy_rejected"
  | "invalid_request"
  | "provider_error"
  | "tool_error"
  | "result_too_large"
  | "cancelled"
  | "deadline_exceeded";
export type AgentOperationStopReasonV1 =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "cancelled"
  | "error";
export interface AgentTranscriptReceiptRefV1 {
  appendId: string;
  entryIds: readonly string[];
  firstSeq: number;
  lastSeq: number;
  throughChangeSeq: number;
  requestDigest: AgentOperationDigest;
}
export interface AgentOperationOutcomeV1 {
  status: "succeeded" | "failed" | "cancelled";
  code?: AgentOperationOutcomeCodeV1;
  outputDigest?: AgentOperationDigest;
  usage?: AgentOperationUsageV1;
  stopReason?: AgentOperationStopReasonV1;
}
export interface AgentOperationProviderRefV1 {
  adapterId: string;
  adapterVersion: string;
  requestId?: string;
  responseId?: string;
}
export interface AgentOperationActorIdentityV1 {
  supervisorEpoch: number;
  hostId: string;
  hostGeneration: number;
  hostIncarnation: string;
  transcriptAnchor: Readonly<AgentTranscriptAnchorV1>;
  toolUseEntryId?: string;
}
export interface AgentOperationTerminalReservationV1 {
  reservationId: string;
  reason: (typeof RESERVATION_REASONS)[number];
  reservedAtMs: number;
}
export interface AgentOperationKernelTerminalV1 {
  outputDigest: AgentOperationDigest;
  outcomeCode: string;
  transcriptRefs: readonly AgentTranscriptReceiptRefV1[];
  /** Present for model operations, including an empty list. Forbidden for MCP. */
  pendingToolUseEntryIds?: readonly string[];
}
export interface AgentOperationReceiptV1 {
  version: 1;
  operationId: string;
  kind: AgentOperationKind;
  fence: Readonly<AgentTurnFence>;
  planHash: AgentOperationDigest;
  authorityHash: AgentOperationDigest;
  descriptorDigest: AgentOperationDigest;
  payloadDigest: AgentOperationDigest;
  actorIdentity: Readonly<AgentOperationActorIdentityV1>;
  state: AgentOperationState;
  acceptedAtMs: number;
  executingAtMs?: number;
  completedAtMs?: number;
  outcome?: AgentOperationOutcomeV1;
  transcriptRefs?: readonly AgentTranscriptReceiptRefV1[];
  /** Durable terminal ownership, present only while executing. */
  terminalReservation?: Readonly<AgentOperationTerminalReservationV1>;
  /** Exact actor-terminal replay material, durable before actor settlement. */
  kernelTerminal?: Readonly<AgentOperationKernelTerminalV1>;
  providerRef: AgentOperationProviderRefV1;
  errorCode?:
    | "reconciliation_unsupported"
    | "reconciliation_failed"
    | "ambiguous_completion"
    | "identity_mismatch"
    | "cancellation_ambiguous"
    | "timeout_ambiguous"
    | "disconnect_ambiguous"
    | "invalid_response"
    | "operation_failed";
}

/** Ephemeral payloads are deliberately outside receipts and ledger records. */
export interface AgentModelAdapterRequestV1 {
  descriptor: AgentModelOperationDescriptorV1;
  payload: unknown;
}
export interface AgentMcpAdapterRequestV1 {
  descriptor: AgentMcpOperationDescriptorV1;
  payload: unknown;
}
export type AgentAdapterReconciliationV1 =
  | { status: "settled"; proof: AgentAdapterReconciliationProofV1 }
  | { status: "not_started"; proof: AgentAdapterReconciliationProofV1 }
  | {
      status: "indeterminate";
      reason:
        | "reconciliation_unsupported"
        | "reconciliation_failed"
        | "ambiguous_completion";
    };
export interface AgentAdapterReconciliationProofV1 {
  adapterId: string;
  adapterVersion: string;
  operationId: string;
  kind: AgentOperationKind;
  fence: Readonly<AgentTurnFence>;
  planHash: AgentOperationDigest;
  authorityHash: AgentOperationDigest;
  descriptorDigest: AgentOperationDigest;
  payloadDigest: AgentOperationDigest;
  providerRequestRef?: string;
  providerResponseRef?: string;
}
export interface AgentAdapterTerminalV1 {
  outcome: AgentOperationOutcomeV1;
  transcriptRefs: readonly AgentTranscriptReceiptRefV1[];
  providerRequestRef?: string;
  providerResponseRef?: string;
}
export interface AgentOperationAdapterV1<Request> {
  readonly id: string;
  readonly version: string;
  execute(
    request: Request,
    signal: AbortSignal,
  ): Promise<AgentAdapterTerminalV1>;
  reconcile(
    record: AgentOperationReceiptV1,
  ): Promise<AgentAdapterReconciliationV1>;
}
export type AgentModelOperationAdapterV1 =
  AgentOperationAdapterV1<AgentModelAdapterRequestV1>;
export type AgentMcpOperationAdapterV1 =
  AgentOperationAdapterV1<AgentMcpAdapterRequestV1>;
export async function unsupportedAgentOperationReconciliation(): Promise<AgentAdapterReconciliationV1> {
  return { status: "indeterminate", reason: "reconciliation_unsupported" };
}

function safeJson(value: unknown): boolean {
  let count = 0;
  const visit = (v: unknown, depth: number): boolean => {
    if (
      ++count > MAX_AGENT_OPERATION_VALUES ||
      depth > MAX_AGENT_OPERATION_DEPTH
    )
      return false;
    if (v === null || typeof v === "string" || typeof v === "boolean")
      return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype) return false;
      const descriptors = Object.getOwnPropertyDescriptors(v);
      const keys = Reflect.ownKeys(descriptors);
      if (
        keys.some((key) => typeof key !== "string") ||
        keys.length !== v.length + 1 ||
        !Object.hasOwn(descriptors, "length")
      )
        return false;
      for (let index = 0; index < v.length; index++) {
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
    if (!record(v)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(v);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) return false;
    return keys.every((key) => {
      const descriptor = descriptors[key as string];
      return (
        !!descriptor &&
        "value" in descriptor &&
        descriptor.enumerable &&
        !FORBIDDEN.test(key as string) &&
        descriptor.value !== undefined &&
        visit(descriptor.value, depth + 1)
      );
    });
  };
  if (!visit(value, 0)) return false;
  try {
    // Reject Proxy objects whose traps could change values between inspection
    // and decoder reconstruction.
    const snapshot = structuredClone(value);
    return (
      encoder.encode(JSON.stringify(snapshot)).byteLength <=
      MAX_AGENT_OPERATION_BYTES
    );
  } catch {
    return false;
  }
}
function ids(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_IDS &&
    value.every(validId) &&
    new Set(value).size === value.length
  );
}
function anchor(value: unknown): AgentTranscriptAnchorV1 | undefined {
  if (
    !record(value) ||
    !exact(value, ["throughChangeSeq", "entryIds", "digest"]) ||
    !time(value.throughChangeSeq) ||
    !ids(value.entryIds) ||
    !validDigest(value.digest)
  )
    return undefined;
  return Object.freeze({
    throughChangeSeq: value.throughChangeSeq,
    entryIds: Object.freeze([...value.entryIds]),
    digest: value.digest,
  });
}
export function decodeAgentOperationDescriptorV1(
  value: unknown,
): AgentOperationDescriptorV1 | undefined {
  if (!safeJson(value) || !record(value)) return undefined;
  if (
    value.kind === "model" &&
    exact(value, [
      "version",
      "kind",
      "stepId",
      "transcript",
      "modelPolicyHash",
      "adapterRequestVersion",
    ])
  ) {
    const transcript = anchor(value.transcript);
    if (
      value.version !== 1 ||
      !validId(value.stepId) ||
      !transcript ||
      !validDigest(value.modelPolicyHash) ||
      typeof value.adapterRequestVersion !== "string" ||
      !VERSION.test(value.adapterRequestVersion)
    )
      return undefined;
    return Object.freeze({
      version: 1,
      kind: "model",
      stepId: value.stepId,
      transcript,
      modelPolicyHash: value.modelPolicyHash,
      adapterRequestVersion: value.adapterRequestVersion,
    });
  }
  if (
    value.kind === "mcp" &&
    exact(value, [
      "version",
      "kind",
      "toolUseEntryId",
      "toolUseId",
      "server",
      "tool",
      "argumentsDigest",
      "adapterRequestVersion",
    ])
  ) {
    if (
      value.version !== 1 ||
      !validId(value.toolUseEntryId) ||
      !validId(value.toolUseId) ||
      !validId(value.server) ||
      !validId(value.tool) ||
      !validDigest(value.argumentsDigest) ||
      typeof value.adapterRequestVersion !== "string" ||
      !VERSION.test(value.adapterRequestVersion)
    )
      return undefined;
    return Object.freeze({
      version: 1,
      kind: "mcp",
      toolUseEntryId: value.toolUseEntryId,
      toolUseId: value.toolUseId,
      server: value.server,
      tool: value.tool,
      argumentsDigest: value.argumentsDigest,
      adapterRequestVersion: value.adapterRequestVersion,
    });
  }
  return undefined;
}
export function decodeAgentOperationRequestV1(
  value: unknown,
): AgentOperationRequestV1 | undefined {
  if (
    !safeJson(value) ||
    !record(value) ||
    !exact(value, [
      "version",
      "operationId",
      "kind",
      "fence",
      "supervisionEnvelope",
      "dispatchGrant",
      "descriptor",
      "descriptorDigest",
    ]) ||
    value.version !== 1 ||
    !validId(value.operationId) ||
    (value.kind !== "model" && value.kind !== "mcp") ||
    !isAgentTurnFence(value.fence) ||
    !validDigest(value.descriptorDigest)
  )
    return undefined;
  const supervisionEnvelope = decodeSignedAgentHostSupervisionEnvelopeV1(
    value.supervisionEnvelope,
  );
  const dispatchGrant = decodeAgentGatewayDispatchGrant(value.dispatchGrant);
  const descriptor = decodeAgentOperationDescriptorV1(value.descriptor);
  if (
    !supervisionEnvelope ||
    !dispatchGrant ||
    !descriptor ||
    descriptor.kind !== value.kind
  )
    return undefined;
  return Object.freeze({
    version: 1,
    operationId: value.operationId,
    kind: value.kind,
    fence: Object.freeze({ ...value.fence }),
    supervisionEnvelope,
    dispatchGrant,
    descriptor,
    descriptorDigest: value.descriptorDigest,
  });
}
export function decodeAgentOperationQueryV1(
  value: unknown,
): AgentOperationQueryV1 | undefined {
  if (
    !safeJson(value) ||
    !record(value) ||
    !exact(value, [
      "version",
      "operationId",
      "kind",
      "fence",
      "supervisionEnvelope",
      "dispatchGrant",
      "descriptorDigest",
      "payloadDigest",
    ]) ||
    value.version !== 1 ||
    !validId(value.operationId) ||
    (value.kind !== "model" && value.kind !== "mcp") ||
    !isAgentTurnFence(value.fence) ||
    !validDigest(value.descriptorDigest) ||
    !validDigest(value.payloadDigest)
  )
    return undefined;
  const supervisionEnvelope = decodeSignedAgentHostSupervisionEnvelopeV1(
    value.supervisionEnvelope,
  );
  const dispatchGrant = decodeAgentGatewayDispatchGrant(value.dispatchGrant);
  if (!supervisionEnvelope || !dispatchGrant) return undefined;
  return Object.freeze({
    ...value,
    fence: Object.freeze({ ...value.fence }),
    supervisionEnvelope,
    dispatchGrant,
  }) as AgentOperationQueryV1;
}
function usage(value: unknown): AgentOperationUsageV1 | undefined {
  if (
    !record(value) ||
    !Object.keys(value).every((key) =>
      [
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheCreationTokens",
        "costUsd",
      ].includes(key),
    ) ||
    !Object.entries(value).every(([key, v]) =>
      key === "costUsd"
        ? typeof v === "number" && Number.isFinite(v) && v >= 0
        : Number.isSafeInteger(v) && (v as number) >= 0,
    )
  )
    return undefined;
  return Object.freeze({ ...value }) as AgentOperationUsageV1;
}
export function decodeAgentTranscriptReceiptRefV1(
  value: unknown,
): AgentTranscriptReceiptRefV1 | undefined {
  if (
    !safeJson(value) ||
    !record(value) ||
    !exact(value, [
      "appendId",
      "entryIds",
      "firstSeq",
      "lastSeq",
      "throughChangeSeq",
      "requestDigest",
    ]) ||
    !validId(value.appendId) ||
    !ids(value.entryIds) ||
    value.entryIds.length === 0 ||
    !time(value.firstSeq) ||
    value.firstSeq < 1 ||
    !time(value.lastSeq) ||
    value.lastSeq < value.firstSeq ||
    value.entryIds.length !== value.lastSeq - value.firstSeq + 1 ||
    !time(value.throughChangeSeq) ||
    value.throughChangeSeq < 1 ||
    !validDigest(value.requestDigest)
  )
    return undefined;
  return Object.freeze({
    appendId: value.appendId,
    entryIds: Object.freeze([...value.entryIds]),
    firstSeq: value.firstSeq,
    lastSeq: value.lastSeq,
    throughChangeSeq: value.throughChangeSeq,
    requestDigest: value.requestDigest,
  });
}

function transcriptRef(
  value: unknown,
): AgentTranscriptReceiptRefV1 | undefined {
  return decodeAgentTranscriptReceiptRefV1(value);
}
function decodeActorIdentity(
  kind: AgentOperationKind,
  value: unknown,
): AgentOperationActorIdentityV1 | undefined {
  if (
    !record(value) ||
    !exact(value, [
      "supervisorEpoch",
      "hostId",
      "hostGeneration",
      "hostIncarnation",
      "transcriptAnchor",
      ...(kind === "mcp" ? ["toolUseEntryId"] : []),
    ])
  )
    return undefined;
  const transcriptAnchor = anchor(value.transcriptAnchor);
  if (
    !time(value.supervisorEpoch) ||
    value.supervisorEpoch < 1 ||
    !validId(value.hostId) ||
    !time(value.hostGeneration) ||
    value.hostGeneration < 1 ||
    !validId(value.hostIncarnation) ||
    !transcriptAnchor ||
    (kind === "mcp"
      ? !validId(value.toolUseEntryId)
      : value.toolUseEntryId !== undefined)
  )
    return undefined;
  return Object.freeze({
    supervisorEpoch: value.supervisorEpoch,
    hostId: value.hostId,
    hostGeneration: value.hostGeneration,
    hostIncarnation: value.hostIncarnation,
    transcriptAnchor,
    ...(kind === "mcp"
      ? { toolUseEntryId: value.toolUseEntryId as string }
      : {}),
  });
}
function decodeKernelTerminal(
  kind: AgentOperationKind,
  value: unknown,
): AgentOperationKernelTerminalV1 | undefined {
  if (!record(value)) return undefined;
  const keys = [
    "outputDigest",
    "outcomeCode",
    "transcriptRefs",
    ...(kind === "model" ? ["pendingToolUseEntryIds"] : []),
  ];
  if (
    !exact(value, keys) ||
    !validDigest(value.outputDigest) ||
    typeof value.outcomeCode !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(value.outcomeCode) ||
    !Array.isArray(value.transcriptRefs) ||
    value.transcriptRefs.length < 1 ||
    value.transcriptRefs.length > 64
  )
    return undefined;
  const refs = value.transcriptRefs.map(transcriptRef);
  if (
    refs.some((ref) => !ref) ||
    refs.some(
      (ref, index) =>
        index > 0 &&
        (ref!.firstSeq <= refs[index - 1]!.lastSeq ||
          ref!.throughChangeSeq <= refs[index - 1]!.throughChangeSeq),
    )
  )
    return undefined;
  const flattened = refs.flatMap((ref) => [...ref!.entryIds]);
  if (new Set(flattened).size !== flattened.length) return undefined;
  let pending: readonly string[] | undefined;
  if (kind === "model") {
    if (
      !ids(value.pendingToolUseEntryIds) ||
      value.pendingToolUseEntryIds.length > 64
    )
      return undefined;
    let prior = -1;
    for (const entryId of value.pendingToolUseEntryIds) {
      const index = flattened.indexOf(entryId);
      if (index <= prior) return undefined;
      prior = index;
    }
    pending = Object.freeze([...value.pendingToolUseEntryIds]);
  }
  return Object.freeze({
    outputDigest: value.outputDigest,
    outcomeCode: value.outcomeCode,
    transcriptRefs: Object.freeze(refs as AgentTranscriptReceiptRefV1[]),
    ...(kind === "model" ? { pendingToolUseEntryIds: pending! } : {}),
  });
}
export function decodeAgentOperationReceiptV1(
  value: unknown,
): AgentOperationReceiptV1 | undefined {
  const allowed = [
    "version",
    "operationId",
    "kind",
    "fence",
    "planHash",
    "authorityHash",
    "descriptorDigest",
    "payloadDigest",
    "actorIdentity",
    "state",
    "acceptedAtMs",
    "executingAtMs",
    "completedAtMs",
    "outcome",
    "transcriptRefs",
    "terminalReservation",
    "kernelTerminal",
    "providerRef",
    "errorCode",
  ];
  if (
    !safeJson(value) ||
    !record(value) ||
    !Object.keys(value).every((key) => allowed.includes(key)) ||
    value.version !== 1 ||
    !validId(value.operationId) ||
    (value.kind !== "model" && value.kind !== "mcp") ||
    !isAgentTurnFence(value.fence) ||
    !validDigest(value.planHash) ||
    !validDigest(value.authorityHash) ||
    !validDigest(value.descriptorDigest) ||
    !validDigest(value.payloadDigest) ||
    !["prepared", "executing", "settled", "indeterminate"].includes(
      value.state as string,
    ) ||
    !time(value.acceptedAtMs)
  )
    return undefined;
  if (
    !record(value.providerRef) ||
    !Object.keys(value.providerRef).every((k) =>
      ["adapterId", "adapterVersion", "requestId", "responseId"].includes(k),
    ) ||
    !validId(value.providerRef.adapterId) ||
    typeof value.providerRef.adapterVersion !== "string" ||
    !VERSION.test(value.providerRef.adapterVersion) ||
    ![value.providerRef.requestId, value.providerRef.responseId].every(
      (v) => v === undefined || (typeof v === "string" && REF.test(v)),
    )
  )
    return undefined;
  const actorIdentity = decodeActorIdentity(
    value.kind as AgentOperationKind,
    value.actorIdentity,
  );
  if (!actorIdentity) return undefined;
  const refs =
    value.transcriptRefs === undefined
      ? undefined
      : Array.isArray(value.transcriptRefs) &&
          value.transcriptRefs.length <= MAX_IDS
        ? value.transcriptRefs.map(transcriptRef)
        : undefined;
  if (value.transcriptRefs !== undefined && (!refs || refs.some((v) => !v)))
    return undefined;
  let outcome: AgentOperationOutcomeV1 | undefined;
  if (value.outcome !== undefined) {
    if (
      !record(value.outcome) ||
      !Object.keys(value.outcome).every((k) =>
        ["status", "code", "outputDigest", "usage", "stopReason"].includes(k),
      ) ||
      !["succeeded", "failed", "cancelled"].includes(
        value.outcome.status as string,
      ) ||
      !(
        value.outcome.code === undefined ||
        OUTCOME_CODES.includes(
          value.outcome.code as AgentOperationOutcomeCodeV1,
        )
      ) ||
      !(
        value.outcome.stopReason === undefined ||
        STOP_REASONS.includes(
          value.outcome.stopReason as AgentOperationStopReasonV1,
        )
      ) ||
      !(
        value.outcome.outputDigest === undefined ||
        validDigest(value.outcome.outputDigest)
      )
    )
      return undefined;
    const decodedUsage =
      value.outcome.usage === undefined
        ? undefined
        : usage(value.outcome.usage);
    if (value.outcome.usage !== undefined && !decodedUsage) return undefined;
    outcome = Object.freeze({
      ...value.outcome,
      ...(decodedUsage === undefined ? {} : { usage: decodedUsage }),
    }) as AgentOperationOutcomeV1;
  }
  const terminalReservation = (() => {
    if (value.terminalReservation === undefined) return undefined;
    if (
      !record(value.terminalReservation) ||
      !exact(value.terminalReservation, [
        "reservationId",
        "reason",
        "reservedAtMs",
      ]) ||
      typeof value.terminalReservation.reservationId !== "string" ||
      !/^reservation:[a-f0-9]{64}$/.test(
        value.terminalReservation.reservationId,
      ) ||
      !RESERVATION_REASONS.includes(
        value.terminalReservation
          .reason as (typeof RESERVATION_REASONS)[number],
      ) ||
      !time(value.terminalReservation.reservedAtMs)
    )
      return null;
    return Object.freeze({
      reservationId: value.terminalReservation.reservationId,
      reason: value.terminalReservation
        .reason as (typeof RESERVATION_REASONS)[number],
      reservedAtMs: value.terminalReservation.reservedAtMs as number,
    });
  })();
  if (terminalReservation === null) return undefined;
  const kernelTerminal = decodeKernelTerminal(
    value.kind as AgentOperationKind,
    value.kernelTerminal,
  );
  if (value.kernelTerminal !== undefined && !kernelTerminal) return undefined;
  if (
    kernelTerminal &&
    (JSON.stringify(kernelTerminal.transcriptRefs) !== JSON.stringify(refs) ||
      (outcome?.outputDigest !== undefined &&
        outcome.outputDigest !== kernelTerminal.outputDigest) ||
      (outcome?.code !== undefined &&
        outcome.code !== kernelTerminal.outcomeCode))
  )
    return undefined;
  const state = value.state as AgentOperationState;
  if (
    (state === "prepared" &&
      (value.executingAtMs !== undefined ||
        value.completedAtMs !== undefined ||
        outcome ||
        value.transcriptRefs !== undefined ||
        terminalReservation !== undefined ||
        kernelTerminal !== undefined ||
        value.providerRef.requestId !== undefined ||
        value.providerRef.responseId !== undefined ||
        value.errorCode !== undefined)) ||
    (state === "executing" &&
      (!time(value.executingAtMs) ||
        value.completedAtMs !== undefined ||
        (terminalReservation !== undefined &&
          terminalReservation.reservedAtMs < value.executingAtMs) ||
        outcome ||
        value.transcriptRefs !== undefined ||
        kernelTerminal !== undefined ||
        value.providerRef.requestId !== undefined ||
        value.providerRef.responseId !== undefined ||
        value.errorCode !== undefined)) ||
    ((state === "settled" || state === "indeterminate") &&
      (!time(value.executingAtMs) ||
        !time(value.completedAtMs) ||
        terminalReservation !== undefined)) ||
    (time(value.executingAtMs) && value.executingAtMs < value.acceptedAtMs) ||
    (time(value.completedAtMs) &&
      value.completedAtMs <
        (time(value.executingAtMs)
          ? value.executingAtMs
          : value.acceptedAtMs)) ||
    (state === "settled" &&
      (!outcome || !kernelTerminal || value.errorCode !== undefined)) ||
    (state === "indeterminate" &&
      (outcome !== undefined ||
        !kernelTerminal ||
        !ERROR_CODES.includes(
          value.errorCode as (typeof ERROR_CODES)[number],
        ) ||
        kernelTerminal.outcomeCode !== value.errorCode))
  )
    return undefined;
  return Object.freeze({
    ...value,
    fence: Object.freeze({ ...value.fence }),
    actorIdentity,
    ...(outcome === undefined ? {} : { outcome }),
    ...(refs === undefined ? {} : { transcriptRefs: Object.freeze(refs) }),
    ...(terminalReservation === undefined ? {} : { terminalReservation }),
    ...(kernelTerminal === undefined ? {} : { kernelTerminal }),
  }) as AgentOperationReceiptV1;
}

function canonicalDescriptor(v: AgentOperationDescriptorV1): string {
  return v.kind === "model"
    ? JSON.stringify({
        version: 1,
        kind: "model",
        stepId: v.stepId,
        transcript: {
          throughChangeSeq: v.transcript.throughChangeSeq,
          entryIds: v.transcript.entryIds,
          digest: v.transcript.digest,
        },
        modelPolicyHash: v.modelPolicyHash,
        adapterRequestVersion: v.adapterRequestVersion,
      })
    : JSON.stringify({
        version: 1,
        kind: "mcp",
        toolUseEntryId: v.toolUseEntryId,
        toolUseId: v.toolUseId,
        server: v.server,
        tool: v.tool,
        argumentsDigest: v.argumentsDigest,
        adapterRequestVersion: v.adapterRequestVersion,
      });
}
export function serializeAgentOperationDescriptorV1(
  value: AgentOperationDescriptorV1,
): Uint8Array {
  const decoded = decodeAgentOperationDescriptorV1(value);
  if (!decoded) throw new TypeError("invalid descriptor");
  return encoder.encode(canonicalDescriptor(decoded));
}
function canonicalFence(fence: Readonly<AgentTurnFence>) {
  return {
    sessionId: fence.sessionId,
    runId: fence.runId,
    turnId: fence.turnId,
    generation: fence.generation,
  };
}
function canonicalEnvelope(envelope: SignedAgentHostSupervisionEnvelopeV1) {
  return {
    version: envelope.version,
    algorithm: envelope.algorithm,
    domain: envelope.domain,
    authorityBytes: envelope.authorityBytes,
    signature: envelope.signature,
  };
}
export function serializeAgentOperationRequestV1(
  value: AgentOperationRequestV1,
): Uint8Array {
  const decoded = decodeAgentOperationRequestV1(value);
  if (!decoded) throw new TypeError("invalid Agent operation request");
  return encoder.encode(
    JSON.stringify({
      version: 1,
      operationId: decoded.operationId,
      kind: decoded.kind,
      fence: canonicalFence(decoded.fence),
      supervisionEnvelope: canonicalEnvelope(decoded.supervisionEnvelope),
      dispatchGrant: decoded.dispatchGrant,
      descriptor: JSON.parse(canonicalDescriptor(decoded.descriptor)),
      descriptorDigest: decoded.descriptorDigest,
    }),
  );
}
export function serializeAgentOperationQueryV1(
  value: AgentOperationQueryV1,
): Uint8Array {
  const decoded = decodeAgentOperationQueryV1(value);
  if (!decoded) throw new TypeError("invalid Agent operation query");
  return encoder.encode(
    JSON.stringify({
      version: 1,
      operationId: decoded.operationId,
      kind: decoded.kind,
      fence: canonicalFence(decoded.fence),
      supervisionEnvelope: canonicalEnvelope(decoded.supervisionEnvelope),
      dispatchGrant: decoded.dispatchGrant,
      descriptorDigest: decoded.descriptorDigest,
      payloadDigest: decoded.payloadDigest,
    }),
  );
}
export function serializeAgentOperationReceiptV1(
  value: AgentOperationReceiptV1,
): Uint8Array {
  const v = decodeAgentOperationReceiptV1(value);
  if (!v) throw new TypeError("invalid receipt");
  const outcome = v.outcome && {
    status: v.outcome.status,
    ...(v.outcome.code === undefined ? {} : { code: v.outcome.code }),
    ...(v.outcome.outputDigest === undefined
      ? {}
      : { outputDigest: v.outcome.outputDigest }),
    ...(v.outcome.usage === undefined
      ? {}
      : {
          usage: {
            ...(v.outcome.usage.inputTokens === undefined
              ? {}
              : { inputTokens: v.outcome.usage.inputTokens }),
            ...(v.outcome.usage.outputTokens === undefined
              ? {}
              : { outputTokens: v.outcome.usage.outputTokens }),
            ...(v.outcome.usage.cacheReadTokens === undefined
              ? {}
              : { cacheReadTokens: v.outcome.usage.cacheReadTokens }),
            ...(v.outcome.usage.cacheCreationTokens === undefined
              ? {}
              : { cacheCreationTokens: v.outcome.usage.cacheCreationTokens }),
            ...(v.outcome.usage.costUsd === undefined
              ? {}
              : { costUsd: v.outcome.usage.costUsd }),
          },
        }),
    ...(v.outcome.stopReason === undefined
      ? {}
      : { stopReason: v.outcome.stopReason }),
  };
  return encoder.encode(
    JSON.stringify({
      version: 1,
      operationId: v.operationId,
      kind: v.kind,
      fence: canonicalFence(v.fence),
      planHash: v.planHash,
      authorityHash: v.authorityHash,
      descriptorDigest: v.descriptorDigest,
      payloadDigest: v.payloadDigest,
      actorIdentity: {
        supervisorEpoch: v.actorIdentity.supervisorEpoch,
        hostId: v.actorIdentity.hostId,
        hostGeneration: v.actorIdentity.hostGeneration,
        hostIncarnation: v.actorIdentity.hostIncarnation,
        transcriptAnchor: v.actorIdentity.transcriptAnchor,
        ...(v.kind === "mcp"
          ? { toolUseEntryId: v.actorIdentity.toolUseEntryId }
          : {}),
      },
      state: v.state,
      acceptedAtMs: v.acceptedAtMs,
      ...(v.executingAtMs === undefined
        ? {}
        : { executingAtMs: v.executingAtMs }),
      ...(v.completedAtMs === undefined
        ? {}
        : { completedAtMs: v.completedAtMs }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(v.transcriptRefs === undefined
        ? {}
        : {
            transcriptRefs: v.transcriptRefs.map((ref) => ({
              appendId: ref.appendId,
              entryIds: ref.entryIds,
              firstSeq: ref.firstSeq,
              lastSeq: ref.lastSeq,
              throughChangeSeq: ref.throughChangeSeq,
              requestDigest: ref.requestDigest,
            })),
          }),
      ...(v.terminalReservation === undefined
        ? {}
        : {
            terminalReservation: {
              reservationId: v.terminalReservation.reservationId,
              reason: v.terminalReservation.reason,
              reservedAtMs: v.terminalReservation.reservedAtMs,
            },
          }),
      ...(v.kernelTerminal === undefined
        ? {}
        : {
            kernelTerminal: {
              outputDigest: v.kernelTerminal.outputDigest,
              outcomeCode: v.kernelTerminal.outcomeCode,
              transcriptRefs: v.kernelTerminal.transcriptRefs,
              ...(v.kind === "model"
                ? {
                    pendingToolUseEntryIds:
                      v.kernelTerminal.pendingToolUseEntryIds,
                  }
                : {}),
            },
          }),
      providerRef: {
        adapterId: v.providerRef.adapterId,
        adapterVersion: v.providerRef.adapterVersion,
        ...(v.providerRef.requestId === undefined
          ? {}
          : { requestId: v.providerRef.requestId }),
        ...(v.providerRef.responseId === undefined
          ? {}
          : { responseId: v.providerRef.responseId }),
      },
      ...(v.errorCode === undefined ? {} : { errorCode: v.errorCode }),
    }),
  );
}
async function hash(
  domain: string,
  bytes: Uint8Array,
): Promise<AgentOperationDigest> {
  const prefix = encoder.encode(`${domain}\0`);
  const all = new Uint8Array(prefix.length + bytes.length);
  all.set(prefix);
  all.set(bytes, prefix.length);
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
  return `sha256:${[...result].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
/** Gateway recomputation helpers. Submitted digests are never trusted. */
export const hashAgentOperationDescriptorV1 = (v: AgentOperationDescriptorV1) =>
  hash(
    AGENT_OPERATION_DESCRIPTOR_DIGEST_DOMAIN,
    serializeAgentOperationDescriptorV1(v),
  );
export const hashAgentModelPayloadV1 = (v: Uint8Array) =>
  hash(AGENT_MODEL_PAYLOAD_DIGEST_DOMAIN, v);
export const hashAgentMcpPayloadV1 = (v: Uint8Array) =>
  hash(AGENT_MCP_PAYLOAD_DIGEST_DOMAIN, v);
export const hashAgentMcpArgumentsV1 = (v: Uint8Array) =>
  hash(AGENT_MCP_ARGUMENTS_DIGEST_DOMAIN, v);
export const hashAgentOperationReceiptV1 = (v: AgentOperationReceiptV1) =>
  hash(
    AGENT_OPERATION_RECEIPT_DIGEST_DOMAIN,
    serializeAgentOperationReceiptV1(v),
  );
