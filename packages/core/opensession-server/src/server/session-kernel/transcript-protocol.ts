import type { TranscriptIndexEntry } from "@tellahq/opensession-protocol/session";
/**
 * Transcript-destination wire contracts, relocated here from the removed
 * protocol/agent-operation module. The currently deployed release wrote
 * destination appends and receipts with these exact shapes, so the surviving
 * transcript actor keeps validating and serving them unchanged.
 */
export type AgentOperationDigest = `sha256:${string}`;
export interface AgentTranscriptAnchorV1 {
  throughChangeSeq: number;
  entryIds: readonly string[];
  digest: AgentOperationDigest;
}
export interface AgentTranscriptReceiptRefV1 {
  appendId: string;
  entryIds: readonly string[];
  firstSeq: number;
  lastSeq: number;
  throughChangeSeq: number;
  requestDigest: AgentOperationDigest;
}

const MAX_RECEIPT_REF_DEPTH = 12;
const MAX_RECEIPT_REF_VALUES = 2_048;
const MAX_RECEIPT_REF_BYTES = 64 * 1024;
const MAX_RECEIPT_REF_IDS = 512;
const RECEIPT_REF_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RECEIPT_REF_DIGEST = /^sha256:[a-f0-9]{64}$/;
const RECEIPT_REF_FORBIDDEN =
  /^(?:accountId|apiKey|args|arguments|authorization|authToken|baseUrl|body|cookie|credentials?|env|environment|headers?|password|prompt|providerConfig|requestBody|responseBody|secret|token|accessToken|url)$/i;
const receiptRefEncoder = new TextEncoder();
const receiptRefRecord = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const receiptRefExact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length &&
  Object.keys(v).every((key) => keys.includes(key));
const receiptRefValidId = (v: unknown): v is string =>
  typeof v === "string" && RECEIPT_REF_ID.test(v);
const receiptRefValidDigest = (v: unknown): v is AgentOperationDigest =>
  typeof v === "string" && RECEIPT_REF_DIGEST.test(v);
const receiptRefTime = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;
function receiptRefIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_RECEIPT_REF_IDS &&
    value.every(receiptRefValidId) &&
    new Set(value).size === value.length
  );
}
function receiptRefSafeJson(value: unknown): boolean {
  let count = 0;
  const visit = (v: unknown, depth: number): boolean => {
    if (++count > MAX_RECEIPT_REF_VALUES || depth > MAX_RECEIPT_REF_DEPTH)
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
    if (!receiptRefRecord(v)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(v);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) return false;
    return keys.every((key) => {
      const descriptor = descriptors[key as string];
      return (
        !!descriptor &&
        "value" in descriptor &&
        descriptor.enumerable &&
        !RECEIPT_REF_FORBIDDEN.test(key as string) &&
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
      receiptRefEncoder.encode(JSON.stringify(snapshot)).byteLength <=
      MAX_RECEIPT_REF_BYTES
    );
  } catch {
    return false;
  }
}
export function decodeAgentTranscriptReceiptRefV1(
  value: unknown,
): AgentTranscriptReceiptRefV1 | undefined {
  if (
    !receiptRefSafeJson(value) ||
    !receiptRefRecord(value) ||
    !receiptRefExact(value, [
      "appendId",
      "entryIds",
      "firstSeq",
      "lastSeq",
      "throughChangeSeq",
      "requestDigest",
    ]) ||
    !receiptRefValidId(value.appendId) ||
    !receiptRefIds(value.entryIds) ||
    value.entryIds.length === 0 ||
    !receiptRefTime(value.firstSeq) ||
    value.firstSeq < 1 ||
    !receiptRefTime(value.lastSeq) ||
    value.lastSeq < value.firstSeq ||
    value.entryIds.length !== value.lastSeq - value.firstSeq + 1 ||
    !receiptRefTime(value.throughChangeSeq) ||
    value.throughChangeSeq < 1 ||
    !receiptRefValidDigest(value.requestDigest)
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
import type { TranscriptEntry } from "../types";
import type {
  AppendResult,
  DestinationTranscriptAppendResult,
  SeqEntry,
  TranscriptHydratedPage,
  TailWindowOpts,
  TranscriptImportInfo,
  TranscriptOutline,
  TranscriptPage,
  TranscriptRangePage,
} from "../transcript-store";

export const TRANSCRIPT_ACTOR_MAX_ENTRIES = 10_000;
export const TRANSCRIPT_ACTOR_MAX_REQUEST_BYTES = 80 * 1024 * 1024;
export const TRANSCRIPT_ACTOR_MAX_RESPONSE_BYTES = 80 * 1024 * 1024;
export const TRANSCRIPT_ACTOR_MAX_READ_LIMIT = 200;
export const TRANSCRIPT_ACTOR_RANGE_PAGE_LIMIT = 500;
export const TRANSCRIPT_ACTOR_SNAPSHOT_PAGE_LIMIT = 1_400;
export const TRANSCRIPT_ACTOR_OUTLINE_PAGE_LIMIT = 2_000;
const TRANSCRIPT_ACTOR_MAX_STRING_BYTES = 72 * 1024 * 1024;
const TRANSCRIPT_ACTOR_MAX_SCALARS = 250_000;

export type TranscriptMutationFence = {
  requestId: string;
  /** Reset epoch observed before a destructive replacement or deletion. */
  expectedEpoch?: number;
  runId?: string;
  turnId?: string;
  generation?: number;
};

type SessionRequest = { sessionId: string };
type MutationRequest = SessionRequest & TranscriptMutationFence;
export type AgentTranscriptDestinationAppendRequest = {
  op: "agent_append_destination";
  sessionId: string;
  requestId: string;
  appendId: string;
  runId: string;
  turnId: string;
  generation: number;
  transcriptAnchor: Readonly<AgentTranscriptAnchorV1>;
  entries: readonly TranscriptEntry[];
};
export type AgentTranscriptReceiptQueryRequest = {
  op: "agent_query_destination_receipt";
  sessionId: string;
  appendId: string;
  runId: string;
  turnId: string;
  generation: number;
  transcriptAnchor: Readonly<AgentTranscriptAnchorV1>;
  requestDigest: `sha256:${string}`;
};
export type AgentTranscriptReceiptValidationRequest = {
  op: "agent_validate_destination_receipt";
  sessionId: string;
  runId: string;
  turnId: string;
  generation: number;
  transcriptAnchor: Readonly<AgentTranscriptAnchorV1>;
  receipt: Readonly<AgentTranscriptReceiptRefV1>;
};
export type TranscriptTailWindowOptions = Omit<TailWindowOpts, "weigh"> & {
  weightProfile?: "v2_snapshot" | "handoff";
};

export type TranscriptActorRequest =
  | AgentTranscriptDestinationAppendRequest
  | AgentTranscriptReceiptQueryRequest
  | AgentTranscriptReceiptValidationRequest
  | (MutationRequest & { op: "append"; entries: TranscriptEntry[] })
  | (MutationRequest & {
      op: "append_destination";
      appendId: string;
      runId: string;
      turnId: string;
      generation: number;
      entries: TranscriptEntry[];
    })
  | (MutationRequest & {
      op: "import";
      entries: TranscriptEntry[];
      src: string;
      watermark: number | null;
      final?: boolean;
    })
  | (MutationRequest & { op: "replace"; entries: TranscriptEntry[] })
  | (MutationRequest & { op: "delete" })
  | (SessionRequest & { op: "needs_import" })
  | (SessionRequest & { op: "import_info" })
  | (SessionRequest & { op: "tail"; limit?: number })
  | (SessionRequest & {
      op: "tail_window";
      options: TranscriptTailWindowOptions;
    })
  | (SessionRequest & { op: "since"; sinceSeq: number; limit?: number })
  | (SessionRequest & {
      op: "changes_since";
      changeSeq: number;
      limit?: number;
    })
  | (SessionRequest & {
      op: "hydrated_since";
      sinceSeq: number;
      limit?: number;
      maxBytes: number;
    })
  | (SessionRequest & { op: "before"; beforeSeq: number; limit?: number })
  | (SessionRequest & {
      op: "range";
      fromSeq: number;
      toSeq: number;
      afterSeq?: number;
      limit?: number;
    })
  | (SessionRequest & { op: "outline"; afterSeq?: number; limit?: number })
  | (SessionRequest & { op: "full_entry"; entryId: string })
  | (SessionRequest & { op: "last_seq" })
  | (SessionRequest & { op: "last_change_seq" })
  | (SessionRequest & { op: "last_reset_change_seq" })
  | (SessionRequest & { op: "count" })
  | (SessionRequest & { op: "summary" })
  | (SessionRequest & { op: "pending_wake" })
  | (SessionRequest & { op: "ack_wake"; cursor: number });

export type TranscriptMutationResult<T> = {
  result: T;
  wakeCursor: number;
  replay: boolean;
};

export type TranscriptWake = {
  cursor: number;
  ackedCursor: number;
  firstChangeSeq: number;
  lastChangeSeq: number;
  resetEpoch: number;
  ackedResetEpoch: number;
};

export type TranscriptActorResult<T extends TranscriptActorRequest> =
  T extends { op: "agent_append_destination" }
    ? TranscriptMutationResult<AgentTranscriptReceiptRefV1>
    : T extends {
          op:
            | "agent_query_destination_receipt"
            | "agent_validate_destination_receipt";
        }
      ? AgentTranscriptReceiptRefV1 | null
      : T extends { op: "append" }
        ? TranscriptMutationResult<AppendResult | null>
        : T extends { op: "append_destination" }
          ? TranscriptMutationResult<DestinationTranscriptAppendResult>
          : T extends { op: "import" | "replace" }
            ? TranscriptMutationResult<{ inserted: number; updated: number }>
            : T extends { op: "delete" }
              ? TranscriptMutationResult<void>
              : T extends { op: "needs_import" }
                ? boolean
                : T extends { op: "import_info" }
                  ? TranscriptImportInfo | null
                  : T extends {
                        op:
                          | "tail"
                          | "tail_window"
                          | "since"
                          | "changes_since"
                          | "before";
                      }
                    ? TranscriptPage
                    : T extends { op: "hydrated_since" }
                      ? TranscriptHydratedPage
                      : T extends { op: "range" }
                        ? TranscriptRangePage
                        : T extends { op: "outline" }
                          ? TranscriptOutline
                          : T extends { op: "full_entry" }
                            ? TranscriptEntry | null
                            : T extends { op: "summary" }
                              ? {
                                  lastTs: number | null;
                                  seqHighWater: number;
                                } | null
                              : T extends { op: "pending_wake" }
                                ? TranscriptWake | null
                                : T extends { op: "ack_wake" }
                                  ? boolean
                                  : T extends {
                                        op:
                                          | "last_seq"
                                          | "last_change_seq"
                                          | "last_reset_change_seq"
                                          | "count";
                                      }
                                    ? number
                                    : never;

export type TranscriptSearchHit = {
  sessionId: string;
  seq: number;
  entry: TranscriptIndexEntry | SeqEntry;
};

export function isTranscriptMutation(
  request: TranscriptActorRequest,
): request is Extract<TranscriptActorRequest, TranscriptMutationFence> {
  return [
    "agent_append_destination",
    "append",
    "append_destination",
    "import",
    "replace",
    "delete",
  ].includes(request.op);
}

export function isTranscriptRead(request: TranscriptActorRequest): boolean {
  return !isTranscriptMutation(request) && request.op !== "ack_wake";
}

function wireBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined)
    throw new TypeError("Transcript actor payload is not JSON");
  return Buffer.byteLength(json);
}

function assertBoundedJson(value: unknown): void {
  let scalars = 0;
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64)
      throw new RangeError("Transcript actor payload is too deeply nested");
    if (item === null || typeof item === "boolean") {
      scalars++;
    } else if (typeof item === "number") {
      if (!Number.isFinite(item))
        throw new TypeError("Transcript actor payload has a non-finite number");
      scalars++;
    } else if (typeof item === "string") {
      if (Buffer.byteLength(item) > TRANSCRIPT_ACTOR_MAX_STRING_BYTES)
        throw new RangeError("Transcript actor string is too large");
      scalars++;
    } else if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
    } else if (typeof item === "object") {
      for (const child of Object.values(item as Record<string, unknown>))
        if (child !== undefined) visit(child, depth + 1);
    } else if (item !== undefined) {
      throw new TypeError("Transcript actor payload is not JSON");
    }
    if (scalars > TRANSCRIPT_ACTOR_MAX_SCALARS)
      throw new RangeError(
        "Transcript actor payload has too many scalar values",
      );
  };
  visit(value, 0);
}

function assertCursor(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
    throw new RangeError(`Transcript actor ${name} is invalid`);
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new TypeError(`Transcript actor ${label} is invalid`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).some(
      (key) =>
        descriptors[key]?.get ||
        descriptors[key]?.set ||
        descriptors[key]?.enumerable !== true,
    ) ||
    Object.keys(descriptors).sort().join("\0") !== [...keys].sort().join("\0")
  )
    throw new TypeError(`Transcript actor ${label} has invalid keys`);
}

function assertAgentTranscriptAnchor(value: unknown): void {
  exactDataRecord(
    value,
    ["throughChangeSeq", "entryIds", "digest"],
    "Agent anchor",
  );
  if (
    !Number.isSafeInteger(value.throughChangeSeq) ||
    (value.throughChangeSeq as number) < 0 ||
    typeof value.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.digest) ||
    !Array.isArray(value.entryIds) ||
    value.entryIds.length > 512 ||
    value.entryIds.some(
      (id) => typeof id !== "string" || !id || Buffer.byteLength(id) > 256,
    ) ||
    new Set(value.entryIds).size !== value.entryIds.length
  )
    throw new TypeError("Transcript actor Agent anchor is invalid");
}

function assertAgentTranscriptRequest(request: TranscriptActorRequest): void {
  if (request.op === "agent_append_destination")
    exactDataRecord(
      request,
      [
        "op",
        "sessionId",
        "requestId",
        "appendId",
        "runId",
        "turnId",
        "generation",
        "transcriptAnchor",
        "entries",
      ],
      "Agent destination append",
    );
  else if (request.op === "agent_query_destination_receipt")
    exactDataRecord(
      request,
      [
        "op",
        "sessionId",
        "appendId",
        "runId",
        "turnId",
        "generation",
        "transcriptAnchor",
        "requestDigest",
      ],
      "Agent receipt query",
    );
  else if (request.op === "agent_validate_destination_receipt")
    exactDataRecord(
      request,
      [
        "op",
        "sessionId",
        "runId",
        "turnId",
        "generation",
        "transcriptAnchor",
        "receipt",
      ],
      "Agent receipt validation",
    );
  else return;
  assertAgentTranscriptAnchor(request.transcriptAnchor);
  if (!Number.isSafeInteger(request.generation) || request.generation < 1)
    throw new TypeError("Transcript actor Agent generation is invalid");
  if (request.op === "agent_query_destination_receipt") {
    if (!/^sha256:[a-f0-9]{64}$/.test(request.requestDigest))
      throw new TypeError("Transcript actor Agent request digest is invalid");
  } else if (request.op === "agent_validate_destination_receipt") {
    if (!decodeAgentTranscriptReceiptRefV1(request.receipt))
      throw new TypeError("Transcript actor Agent receipt is invalid");
  }
}

type AgentTranscriptActorRequest =
  | AgentTranscriptDestinationAppendRequest
  | AgentTranscriptReceiptQueryRequest
  | AgentTranscriptReceiptValidationRequest;

function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>))
      freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

/** Exact-key decoder used at trusted Agent call sites before crossing the actor wire. */
export function decodeAgentTranscriptActorRequest(
  value: unknown,
): AgentTranscriptActorRequest | undefined {
  try {
    const snapshot = structuredClone(value) as TranscriptActorRequest;
    assertTranscriptActorRequest(snapshot);
    if (!snapshot.op.startsWith("agent_")) return undefined;
    return freezeJson(snapshot as AgentTranscriptActorRequest);
  } catch {
    return undefined;
  }
}

/** Shared by the gateway preflight and the actor-owned store. */
export function assertTranscriptActorRequest(
  request: TranscriptActorRequest,
): void {
  if (!request || typeof request !== "object")
    throw new TypeError("Transcript actor request is invalid");
  if (
    !(
      new Set([
        "agent_append_destination",
        "agent_query_destination_receipt",
        "agent_validate_destination_receipt",
        "append",
        "append_destination",
        "import",
        "replace",
        "delete",
        "needs_import",
        "import_info",
        "tail",
        "tail_window",
        "since",
        "changes_since",
        "hydrated_since",
        "before",
        "range",
        "outline",
        "full_entry",
        "last_seq",
        "last_change_seq",
        "last_reset_change_seq",
        "count",
        "summary",
        "pending_wake",
        "ack_wake",
      ]) as Set<string>
    ).has(request.op)
  )
    throw new TypeError("Transcript actor operation is invalid");
  if (!request.sessionId || Buffer.byteLength(request.sessionId) > 1_024)
    throw new TypeError("Transcript actor request has an invalid session ID");
  if (request.op.startsWith("agent_")) assertAgentTranscriptRequest(request);
  if (
    "requestId" in request &&
    (!request.requestId || Buffer.byteLength(request.requestId) > 256)
  )
    throw new RangeError("Transcript actor mutation identity is too large");
  if (
    "entries" in request &&
    (!Array.isArray(request.entries) ||
      request.entries.length > TRANSCRIPT_ACTOR_MAX_ENTRIES)
  )
    throw new RangeError("Transcript actor request has too many entries");
  for (const [name, value, ceiling] of [
    ["appendId", "appendId" in request ? request.appendId : undefined, 256],
    ["runId", "runId" in request ? request.runId : undefined, 1_024],
    ["turnId", "turnId" in request ? request.turnId : undefined, 1_024],
    ["src", "src" in request ? request.src : undefined, 1_024],
    ["entryId", "entryId" in request ? request.entryId : undefined, 1_024],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== "string" || Buffer.byteLength(value) > ceiling)
    )
      throw new RangeError(`Transcript actor ${name} is invalid`);
  }
  for (const [name, value] of [
    [
      "expectedEpoch",
      "expectedEpoch" in request ? request.expectedEpoch : undefined,
    ],
    ["generation", "generation" in request ? request.generation : undefined],
    [
      "watermark",
      "watermark" in request ? (request.watermark ?? undefined) : undefined,
    ],
  ] as const)
    assertCursor(value, name);
  if ("limit" in request && request.limit !== undefined) {
    const ceiling =
      request.op === "outline"
        ? TRANSCRIPT_ACTOR_OUTLINE_PAGE_LIMIT
        : request.op === "range"
          ? TRANSCRIPT_ACTOR_RANGE_PAGE_LIMIT
          : TRANSCRIPT_ACTOR_MAX_READ_LIMIT;
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > ceiling
    )
      throw new RangeError("Transcript actor read limit is invalid");
  }
  if (request.op === "tail_window") {
    const options = request.options as TranscriptTailWindowOptions;
    if (
      typeof options !== "object" ||
      options === null ||
      "weigh" in options ||
      ("weightProfile" in options &&
        options.weightProfile !== "v2_snapshot" &&
        options.weightProfile !== "handoff")
    )
      throw new TypeError("Transcript actor tail window options are invalid");
    const maxEntriesCeiling =
      options.weightProfile === "v2_snapshot"
        ? TRANSCRIPT_ACTOR_SNAPSHOT_PAGE_LIMIT
        : options.weightProfile === "handoff"
          ? 512
          : TRANSCRIPT_ACTOR_MAX_READ_LIMIT;
    for (const [name, value, ceiling] of [
      ["minEntries", options.minEntries, TRANSCRIPT_ACTOR_MAX_READ_LIMIT],
      ["minMessages", options.minMessages, TRANSCRIPT_ACTOR_MAX_READ_LIMIT],
      [
        "minUserMessagesWithToolWork",
        options.minUserMessagesWithToolWork ?? 0,
        TRANSCRIPT_ACTOR_MAX_READ_LIMIT,
      ],
      ["maxEntries", options.maxEntries, maxEntriesCeiling],
      [
        "maxEstimatedBytes",
        options.maxEstimatedBytes,
        TRANSCRIPT_ACTOR_MAX_RESPONSE_BYTES,
      ],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0 || value > ceiling)
        throw new RangeError(`Transcript actor tail window ${name} is invalid`);
    }
    if (
      options.minEntries < 1 ||
      options.maxEntries < 1 ||
      options.minEntries > options.maxEntries
    )
      throw new RangeError(
        "Transcript actor tail window entry bounds are invalid",
      );
  }
  if (request.op === "since") assertCursor(request.sinceSeq, "sinceSeq");
  if (request.op === "changes_since")
    assertCursor(request.changeSeq, "changeSeq");
  if (request.op === "hydrated_since") {
    assertCursor(request.sinceSeq, "sinceSeq");
    if (
      !Number.isSafeInteger(request.maxBytes) ||
      request.maxBytes < 1 ||
      request.maxBytes > 12 * 1024 * 1024
    )
      throw new RangeError(
        "Transcript actor hydrated page byte limit is invalid",
      );
  }
  if (request.op === "before") assertCursor(request.beforeSeq, "beforeSeq");
  if (request.op === "range") {
    assertCursor(request.fromSeq, "fromSeq");
    assertCursor(request.toSeq, "toSeq");
    assertCursor(request.afterSeq, "afterSeq");
    if (request.toSeq < request.fromSeq)
      throw new RangeError("Transcript actor range is invalid");
  }
  if (request.op === "outline") assertCursor(request.afterSeq, "afterSeq");
  if (request.op === "ack_wake") assertCursor(request.cursor, "wake cursor");
  assertBoundedJson(request);
  if (wireBytes(request) > TRANSCRIPT_ACTOR_MAX_REQUEST_BYTES)
    throw new RangeError(
      "Transcript actor request exceeds the wire byte limit",
    );
}

export function assertTranscriptActorResponse(result: unknown): void {
  assertBoundedJson(result);
  if (wireBytes(result) > TRANSCRIPT_ACTOR_MAX_RESPONSE_BYTES)
    throw new RangeError(
      "Transcript actor response exceeds the wire byte limit",
    );
}
