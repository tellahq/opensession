import { createHash } from "node:crypto";
import type { AgentOperationDigest } from "@tellahq/opensession-protocol/agent-operation";
import type { AgentTurnFence } from "@tellahq/opensession-protocol/agent-host";
import type { AgentGatewayDecodedPayload } from "./gateway";

export const PI_MODEL_INVOCATION_DIGEST_DOMAIN =
  "opensession.pi-model.invocation.v1\0";
export const PI_MODEL_EVENT_PAYLOAD_DIGEST_DOMAIN =
  "opensession.pi-model.event-payload.v1\0";
export const PI_MODEL_EVENT_DIGEST_DOMAIN =
  "opensession.pi-model.event.v1\0";
export const MAX_PI_MODEL_INVOCATION_BYTES = 1024 * 1024;
export const MAX_PI_MODEL_EVENT_PAYLOAD_BYTES = 48 * 1024;
const DEFAULT_REGISTRY_CAPACITY = 256;
const OPAQUE_REF_BYTES = 32;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const encoder = new TextEncoder();

export interface PiModelOperationReferenceV1 {
  readonly version: 1;
  readonly bindingRef: string;
  readonly invocationRef: string;
  readonly invocationDigest: AgentOperationDigest;
}

export interface PiModelInvocationIdentity {
  readonly fence: Readonly<AgentTurnFence>;
  readonly operationId: string;
  readonly bindingRef: string;
  readonly invocationRef: string;
  readonly descriptorDigest: AgentOperationDigest;
}

export interface PiModelInvocationRegistrationInput
  extends PiModelInvocationIdentity {
  /** An already-private, deeply immutable invocation snapshot. */
  readonly invocation: unknown;
  /** Caller-produced canonical encoding of the complete invocation. */
  readonly canonicalBytes: Uint8Array;
  readonly deadlineMs: number;
}

export interface PiModelInvocationRegistration {
  readonly reference: Readonly<PiModelOperationReferenceV1>;
  /** Sole capability for deleting this registration. Safe to repeat. */
  close(): boolean;
}

export interface PiModelInvocationRegistryOptions {
  readonly capacity?: number;
  readonly now?: () => number;
}

export interface PiModelInvocationLookup extends PiModelInvocationIdentity {
  readonly invocationDigest: AgentOperationDigest;
}

export interface PiModelPrivateAdapterPayloadV1 {
  readonly version: 1;
  readonly identity: Readonly<PiModelInvocationLookup>;
  readonly invocation: unknown;
}

export interface PiModelInvocationSnapshot {
  readonly invocation: unknown;
  readonly canonicalBytes: Uint8Array;
  readonly adapterPayload: Readonly<PiModelPrivateAdapterPayloadV1>;
}

interface Entry {
  readonly key: string;
  readonly invocation: unknown;
  readonly canonicalBytes: Uint8Array;
  readonly deadlineMs: number;
  readonly identity: PiModelInvocationLookup;
  readonly adapterPayload: Readonly<PiModelPrivateAdapterPayloadV1>;
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every(
      (key) =>
        typeof key === "string" &&
        keys.includes(key) &&
        "value" in descriptors[key]! &&
        descriptors[key]!.enumerable,
    )
  );
}

function validFence(value: unknown): value is Readonly<AgentTurnFence> {
  if (
    !exactDataRecord(value, ["sessionId", "runId", "turnId", "generation"])
  )
    return false;
  return (
    typeof value.sessionId === "string" && ID.test(value.sessionId) &&
    typeof value.runId === "string" && ID.test(value.runId) &&
    typeof value.turnId === "string" && ID.test(value.turnId) &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) >= 0
  );
}

function validOpaqueRef(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("=")) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    return (
      bytes.byteLength === OPAQUE_REF_BYTES &&
      bytes.toString("base64url") === value
    );
  } catch {
    return false;
  }
}

function validDigest(value: unknown): value is AgentOperationDigest {
  return typeof value === "string" && DIGEST.test(value);
}

function validIdentity(value: PiModelInvocationIdentity): boolean {
  return (
    validFence(value.fence) &&
    typeof value.operationId === "string" && ID.test(value.operationId) &&
    validOpaqueRef(value.bindingRef) &&
    validOpaqueRef(value.invocationRef) &&
    validDigest(value.descriptorDigest)
  );
}

function immutableSnapshot(value: unknown): boolean {
  const seen = new Set<object>();
  let count = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++count > 16_384 || depth > 32) return false;
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      return true;
    if (!item || typeof item !== "object" || seen.has(item)) return false;
    if (!Object.isFrozen(item)) return false;
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(item))
      return false;
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) return false;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === "length") continue;
      if (!("value" in descriptor) || !descriptor.enumerable) return false;
      if (!visit(descriptor.value, depth + 1)) return false;
    }
    return true;
  };
  return visit(value, 0);
}

function fenceKey(fence: Readonly<AgentTurnFence>): string {
  return JSON.stringify([
    fence.sessionId,
    fence.runId,
    fence.turnId,
    fence.generation,
  ]);
}

function identityKey(identity: PiModelInvocationIdentity): string {
  return JSON.stringify([
    fenceKey(identity.fence),
    identity.operationId,
    identity.bindingRef,
    identity.invocationRef,
  ]);
}

function sameIdentity(entry: PiModelInvocationLookup, lookup: PiModelInvocationLookup) {
  return (
    entry.operationId === lookup.operationId &&
    entry.bindingRef === lookup.bindingRef &&
    entry.invocationRef === lookup.invocationRef &&
    entry.descriptorDigest === lookup.descriptorDigest &&
    entry.invocationDigest === lookup.invocationDigest &&
    fenceKey(entry.fence) === fenceKey(lookup.fence)
  );
}

function hash(domain: string, bytes: Uint8Array): AgentOperationDigest {
  return `sha256:${createHash("sha256").update(domain).update(bytes).digest("hex")}`;
}

export function hashPiModelInvocationV1(
  canonicalBytes: Uint8Array,
): AgentOperationDigest {
  if (!(canonicalBytes instanceof Uint8Array))
    throw new TypeError("invalid model invocation bytes");
  if (canonicalBytes.byteLength > MAX_PI_MODEL_INVOCATION_BYTES)
    throw new RangeError("model invocation exceeds byte limit");
  return hash(PI_MODEL_INVOCATION_DIGEST_DOMAIN, canonicalBytes);
}

export function decodePiModelOperationReferenceV1(
  value: unknown,
): Readonly<PiModelOperationReferenceV1> | undefined {
  if (
    !exactDataRecord(value, [
      "version",
      "bindingRef",
      "invocationRef",
      "invocationDigest",
    ]) ||
    value.version !== 1 ||
    !validOpaqueRef(value.bindingRef) ||
    !validOpaqueRef(value.invocationRef) ||
    !validDigest(value.invocationDigest)
  )
    return undefined;
  return Object.freeze({
    version: 1,
    bindingRef: value.bindingRef,
    invocationRef: value.invocationRef,
    invocationDigest: value.invocationDigest,
  });
}

/** Import-inert, bounded store for gateway-private full model invocations. */
export class PiModelInvocationRegistry {
  readonly #active = new Map<string, Entry>();
  /** Decode-only tombstones let the gateway authenticate settled duplicate replays. */
  readonly #decodable = new Map<string, Entry>();
  readonly #used = new Set<string>();
  readonly #capacity: number;
  readonly #now: () => number;

  constructor(options: PiModelInvocationRegistryOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_REGISTRY_CAPACITY;
    if (!Number.isSafeInteger(capacity) || capacity <= 0)
      throw new TypeError("invalid model invocation registry capacity");
    this.#capacity = capacity;
    this.#now = options.now ?? Date.now;
  }

  register(input: PiModelInvocationRegistrationInput): PiModelInvocationRegistration {
    if (!validIdentity(input)) throw new TypeError("invalid model invocation identity");
    if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= this.#now())
      throw new Error("model invocation deadline has expired");
    if (!immutableSnapshot(input.invocation))
      throw new TypeError("model invocation snapshot must be immutable");
    if (!(input.canonicalBytes instanceof Uint8Array))
      throw new TypeError("invalid model invocation bytes");
    if (input.canonicalBytes.byteLength > MAX_PI_MODEL_INVOCATION_BYTES)
      throw new RangeError("model invocation exceeds byte limit");
    const key = identityKey(input);
    if (this.#used.has(key))
      throw new Error("model invocation identity was already registered");
    // Tombstones are retained so consumed/closed identities can never be
    // reinstalled. Bound total lifetime registrations, not merely live entries.
    if (this.#used.size >= this.#capacity)
      throw new Error("model invocation registry is full");
    const canonicalBytes = Uint8Array.from(input.canonicalBytes);
    const invocationDigest = hashPiModelInvocationV1(canonicalBytes);
    const identity = Object.freeze({
      fence: Object.freeze({ ...input.fence }),
      operationId: input.operationId,
      bindingRef: input.bindingRef,
      invocationRef: input.invocationRef,
      descriptorDigest: input.descriptorDigest,
      invocationDigest,
    });
    const adapterPayload = Object.freeze({
      version: 1 as const,
      identity,
      invocation: input.invocation,
    });
    const entry: Entry = Object.freeze({
      key,
      invocation: input.invocation,
      canonicalBytes,
      deadlineMs: input.deadlineMs,
      identity,
      adapterPayload,
    });
    this.#used.add(key);
    this.#active.set(key, entry);
    this.#decodable.set(key, entry);
    const reference = Object.freeze({
      version: 1 as const,
      bindingRef: input.bindingRef,
      invocationRef: input.invocationRef,
      invocationDigest,
    });
    let closed = false;
    return Object.freeze({
      reference,
      close: () => {
        if (closed) return false;
        closed = true;
        if (this.#active.get(key) !== entry) return false;
        this.#decodable.delete(key);
        return this.#active.delete(key);
      },
    });
  }

  /** Deletes entries whose caller-owned absolute deadline has passed. */
  deleteExpired(now = this.#now()): number {
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("invalid expiry time");
    let deleted = 0;
    for (const [key, entry] of this.#decodable) {
      if (entry.deadlineMs <= now) {
        this.#decodable.delete(key);
        if (this.#active.delete(key)) deleted++;
      }
    }
    return deleted;
  }

  peekForDecode(lookup: PiModelInvocationLookup): PiModelInvocationSnapshot | undefined {
    return this.#lookup(lookup, false);
  }

  consumeExact(lookup: PiModelInvocationLookup): PiModelInvocationSnapshot | undefined {
    return this.#lookup(lookup, true);
  }

  /** Consumes only the exact private object emitted by this registry's decoder. */
  consumeAdapterPayloadExact(
    lookup: PiModelInvocationLookup,
    payload: Readonly<PiModelPrivateAdapterPayloadV1>,
  ): PiModelInvocationSnapshot | undefined {
    if (!validIdentity(lookup) || !validDigest(lookup.invocationDigest)) return undefined;
    const entry = this.#active.get(identityKey(lookup));
    if (!entry || entry.adapterPayload !== payload) return undefined;
    return this.#lookup(lookup, true);
  }

  #lookup(
    lookup: PiModelInvocationLookup,
    consume: boolean,
  ): PiModelInvocationSnapshot | undefined {
    if (!validIdentity(lookup) || !validDigest(lookup.invocationDigest)) return undefined;
    const key = identityKey(lookup);
    const entry = consume ? this.#active.get(key) : this.#decodable.get(key);
    if (!entry) return undefined;
    if (entry.deadlineMs <= this.#now()) {
      this.#active.delete(key);
      this.#decodable.delete(key);
      return undefined;
    }
    if (!sameIdentity(entry.identity, lookup)) return undefined;
    if (consume && !this.#active.delete(key)) return undefined;
    return Object.freeze({
      invocation: entry.invocation,
      canonicalBytes: Uint8Array.from(entry.canonicalBytes),
      adapterPayload: entry.adapterPayload,
    });
  }
}

export interface PiModelGatewayLookupExpectation {
  readonly fence: Readonly<AgentTurnFence>;
  readonly operationId: string;
  readonly descriptorDigest: AgentOperationDigest;
  readonly bindingRef: string;
}

/** Strictly decode a host-visible ref without consuming its private invocation.
 * Authorization and admission happen after this gateway decode boundary. The
 * model adapter consumes the exact registration only after execution begins. */
export function decodePiModelGatewayPayload(
  registry: PiModelInvocationRegistry,
  expectation: PiModelGatewayLookupExpectation,
  payload: unknown,
): AgentGatewayDecodedPayload | undefined {
  const reference = decodePiModelOperationReferenceV1(payload);
  if (!reference || !validIdentity({
    ...expectation,
    invocationRef: reference.invocationRef,
  })) return undefined;
  if (reference.bindingRef !== expectation.bindingRef) return undefined;
  const snapshot = registry.peekForDecode({
    ...expectation,
    invocationRef: reference.invocationRef,
    invocationDigest: reference.invocationDigest,
  });
  if (!snapshot) return undefined;
  return Object.freeze({
    kind: "model" as const,
    value: snapshot.adapterPayload,
    canonicalBytes: snapshot.canonicalBytes,
    retainValueIdentity: true as const,
  });
}

export interface PiModelEventEnvelopeV1 {
  readonly version: 1;
  readonly operationId: string;
  readonly eventSeq: number;
  readonly previousDigest: AgentOperationDigest | null;
  readonly payload: string;
  readonly payloadDigest: AgentOperationDigest;
  readonly eventDigest: AgentOperationDigest;
}

function lengthPrefix(value: string | Uint8Array): Buffer {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([prefix, bytes]);
}

function eventDigest(input: {
  operationId: string;
  eventSeq: number;
  previousDigest: AgentOperationDigest | null;
  payloadDigest: AgentOperationDigest;
  payload: Uint8Array;
}): AgentOperationDigest {
  const hashValue = createHash("sha256").update(PI_MODEL_EVENT_DIGEST_DOMAIN);
  for (const part of [
    input.operationId,
    String(input.eventSeq),
    input.previousDigest ?? "",
    input.payloadDigest,
  ]) hashValue.update(lengthPrefix(part));
  hashValue.update(lengthPrefix(input.payload));
  return `sha256:${hashValue.digest("hex")}`;
}

function decodeCanonicalPayload(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || value.includes("=") || !/^[A-Za-z0-9_-]*$/.test(value))
    return undefined;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (
      bytes.byteLength > MAX_PI_MODEL_EVENT_PAYLOAD_BYTES ||
      bytes.toString("base64url") !== value
    ) return undefined;
    return Uint8Array.from(bytes);
  } catch {
    return undefined;
  }
}

export function encodePiModelEventV1(input: {
  readonly operationId: string;
  readonly eventSeq: number;
  readonly previousDigest: AgentOperationDigest | null;
  readonly payload: Uint8Array;
}): Readonly<PiModelEventEnvelopeV1> {
  if (typeof input.operationId !== "string" || !ID.test(input.operationId))
    throw new TypeError("invalid model event operation identity");
  if (!Number.isSafeInteger(input.eventSeq) || input.eventSeq < 0)
    throw new TypeError("invalid model event sequence");
  if ((input.eventSeq === 0) !== (input.previousDigest === null) ||
      (input.previousDigest !== null && !validDigest(input.previousDigest)))
    throw new TypeError("invalid model event predecessor");
  if (!(input.payload instanceof Uint8Array) || input.payload.byteLength > MAX_PI_MODEL_EVENT_PAYLOAD_BYTES)
    throw new RangeError("model event payload exceeds byte limit");
  const payload = Uint8Array.from(input.payload);
  const payloadDigest = hash(PI_MODEL_EVENT_PAYLOAD_DIGEST_DOMAIN, payload);
  return Object.freeze({
    version: 1,
    operationId: input.operationId,
    eventSeq: input.eventSeq,
    previousDigest: input.previousDigest,
    payload: Buffer.from(payload).toString("base64url"),
    payloadDigest,
    eventDigest: eventDigest({ ...input, payload, payloadDigest }),
  });
}

export function decodePiModelEventV1(
  value: unknown,
): Readonly<{ envelope: PiModelEventEnvelopeV1; payloadBytes: Uint8Array }> | undefined {
  if (!exactDataRecord(value, [
    "version", "operationId", "eventSeq", "previousDigest", "payload", "payloadDigest", "eventDigest",
  ]) || value.version !== 1 || typeof value.operationId !== "string" || !ID.test(value.operationId) ||
    !Number.isSafeInteger(value.eventSeq) || (value.eventSeq as number) < 0 ||
    ((value.eventSeq === 0) !== (value.previousDigest === null)) ||
    (value.previousDigest !== null && !validDigest(value.previousDigest)) ||
    !validDigest(value.payloadDigest) || !validDigest(value.eventDigest)) return undefined;
  const payloadBytes = decodeCanonicalPayload(value.payload);
  if (!payloadBytes) return undefined;
  const payloadDigest = hash(PI_MODEL_EVENT_PAYLOAD_DIGEST_DOMAIN, payloadBytes);
  if (payloadDigest !== value.payloadDigest) return undefined;
  const expected = eventDigest({
    operationId: value.operationId,
    eventSeq: value.eventSeq as number,
    previousDigest: value.previousDigest as AgentOperationDigest | null,
    payloadDigest,
    payload: payloadBytes,
  });
  if (expected !== value.eventDigest) return undefined;
  const envelope = Object.freeze({
    version: 1 as const,
    operationId: value.operationId,
    eventSeq: value.eventSeq as number,
    previousDigest: value.previousDigest as AgentOperationDigest | null,
    payload: value.payload as string,
    payloadDigest,
    eventDigest: value.eventDigest,
  });
  return Object.freeze({ envelope, payloadBytes });
}

/** Stateful strict decoder enforcing one operation's sequence and hash chain. */
export class PiModelEventChainDecoder {
  readonly #operationId: string;
  #nextSeq = 0;
  #previousDigest: AgentOperationDigest | null = null;

  constructor(operationId: string) {
    if (!ID.test(operationId)) throw new TypeError("invalid model event operation identity");
    this.#operationId = operationId;
  }

  decode(value: unknown): Readonly<{ envelope: PiModelEventEnvelopeV1; payloadBytes: Uint8Array }> | undefined {
    const decoded = decodePiModelEventV1(value);
    if (!decoded || decoded.envelope.operationId !== this.#operationId ||
      decoded.envelope.eventSeq !== this.#nextSeq ||
      decoded.envelope.previousDigest !== this.#previousDigest) return undefined;
    this.#nextSeq++;
    this.#previousDigest = decoded.envelope.eventDigest;
    return decoded;
  }
}
