import { randomBytes } from "node:crypto";
import {
  decodeAgentGatewayDispatchGrant,
  encodeAgentGatewayDispatchGrant,
  type AgentGatewayDispatchGrant,
  type AgentOperationDigest,
  type AgentOperationKind,
  type AgentTranscriptAnchorV1,
} from "@tellahq/opensession-protocol/agent-operation";
import type { AgentTurnFence } from "@tellahq/opensession-protocol/agent-host";

const GRANT_HASH_DOMAIN = "opensession.agent-gateway-grant-registry.v1\0";
const POLICY_PREFIX = "osag_policy_v1.";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const POLICY_ID = /^[A-Za-z0-9_-]{16,256}$/;
const MAX_ANCHOR_IDS = 512;
const DEFAULT_CAPACITY = 100_000;
const DEFAULT_MAX_TTL_MS = 5 * 60_000;
const MAX_COLLISION_ATTEMPTS = 4;

declare const policyHandleBrand: unique symbol;
export type AgentGatewayPolicyHandle = string & {
  readonly [policyHandleBrand]: "AgentGatewayPolicyHandle";
};

export function encodeAgentGatewayPolicyHandle(
  id: string,
): AgentGatewayPolicyHandle {
  if (!POLICY_ID.test(id)) throw new TypeError("invalid gateway policy handle");
  return `${POLICY_PREFIX}${id}` as AgentGatewayPolicyHandle;
}

export function decodeAgentGatewayPolicyHandle(
  value: unknown,
): AgentGatewayPolicyHandle | undefined {
  if (
    typeof value !== "string" ||
    !value.startsWith(POLICY_PREFIX) ||
    !POLICY_ID.test(value.slice(POLICY_PREFIX.length))
  )
    return undefined;
  return value as AgentGatewayPolicyHandle;
}

export interface AgentGatewayGrantBinding {
  readonly operationId: string;
  readonly kind: AgentOperationKind;
  readonly fence: Readonly<AgentTurnFence>;
  readonly planHash: AgentOperationDigest;
  readonly authorityHash: AgentOperationDigest;
  readonly supervisorEpoch: number;
  readonly hostId: string;
  readonly hostGeneration: number;
  readonly hostIncarnation: string;
  readonly descriptorDigest: AgentOperationDigest;
  readonly payloadDigest: AgentOperationDigest;
  readonly transcriptAnchor: Readonly<AgentTranscriptAnchorV1>;
  readonly toolUseEntryId?: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly deadlineMs: number;
  readonly authorityExpiresAtMs: number;
  readonly policyHandle: AgentGatewayPolicyHandle;
}

export type AgentGatewayGrantExpectation = Omit<
  AgentGatewayGrantBinding,
  "policyHandle" | "deadlineMs" | "authorityExpiresAtMs"
>;

export interface AgentGatewayGrantEvidence
  extends AgentGatewayGrantBinding {
  readonly grantHash: `sha256:${string}`;
  readonly issuedAtMs: number;
}

export type AgentGatewayGrantDiagnosticEvidence = Omit<
  AgentGatewayGrantEvidence,
  "policyHandle"
>;

export type AgentGatewayGrantAuthorization =
  | { readonly authorized: true; readonly evidence: AgentGatewayGrantEvidence }
  | {
      readonly authorized: false;
      readonly reason:
        | "invalid_grant"
        | "expired"
        | "identity_mismatch";
    };

export interface AgentGatewayGrantRegistryOptions {
  readonly now?: () => number;
  readonly entropy?: () => string;
  readonly capacity?: number;
  readonly maxTtlMs?: number;
}

/**
 * Bounded, import-inert, gateway-memory-only dispatch authority. Raw grants are
 * returned once and never retained; the registry indexes only a domain-separated
 * hash. There is deliberately no timer and no persistence path.
 */
export class AgentGatewayGrantRegistry {
  readonly #now: () => number;
  readonly #entropy: () => string;
  readonly #capacity: number;
  readonly #maxTtlMs: number;
  readonly #records = new Map<string, AgentGatewayGrantEvidence>();
  #lastObservedNow = -1;

  constructor(options: AgentGatewayGrantRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#entropy =
      options.entropy ?? (() => randomBytes(32).toString("base64url"));
    this.#capacity = positive(options.capacity ?? DEFAULT_CAPACITY, "capacity");
    this.#maxTtlMs = positive(
      options.maxTtlMs ?? DEFAULT_MAX_TTL_MS,
      "maximum grant TTL",
    );
  }

  issue(input: AgentGatewayGrantBinding): AgentGatewayDispatchGrant {
    const now = this.#readNow();
    this.#pruneExpired(now);
    const binding = decodeBinding(input);
    if (
      binding.deadlineMs <= now ||
      binding.deadlineMs > binding.authorityExpiresAtMs ||
      binding.deadlineMs - now > this.#maxTtlMs
    )
      throw new AgentGatewayGrantPolicyError("invalid grant deadline");
    if (this.#records.size >= this.#capacity)
      throw new AgentGatewayGrantCapacityError();

    for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt++) {
      const grant = encodeAgentGatewayDispatchGrant(this.#entropy());
      const grantHash = hashGrant(grant);
      if (this.#records.has(grantHash)) continue;
      this.#records.set(
        grantHash,
        freezeEvidence({ ...binding, grantHash, issuedAtMs: now }),
      );
      return grant;
    }
    throw new AgentGatewayGrantEntropyError();
  }

  authorize(
    grantInput: unknown,
    expectationInput: AgentGatewayGrantExpectation,
  ): AgentGatewayGrantAuthorization {
    const grant = decodeAgentGatewayDispatchGrant(grantInput);
    if (!grant)
      return Object.freeze({ authorized: false, reason: "invalid_grant" });
    const expectation = decodeExpectation(expectationInput);
    const grantHash = hashGrant(grant);
    const evidence = this.#records.get(grantHash);
    if (!evidence)
      return Object.freeze({ authorized: false, reason: "invalid_grant" });
    const now = this.#readNow();
    if (
      now >= evidence.deadlineMs ||
      now >= evidence.authorityExpiresAtMs
    ) {
      this.#records.delete(grantHash);
      return Object.freeze({ authorized: false, reason: "expired" });
    }
    if (!sameExpectation(evidence, expectation))
      return Object.freeze({
        authorized: false,
        reason: "identity_mismatch",
      });
    return Object.freeze({ authorized: true, evidence });
  }

  revoke(grantInput: unknown): boolean {
    const grant = decodeAgentGatewayDispatchGrant(grantInput);
    return grant ? this.#records.delete(hashGrant(grant)) : false;
  }

  revokeSession(sessionId: string): number {
    const exactSessionId = exactId(sessionId, "session ID");
    return this.#deleteWhere(
      (record) => record.fence.sessionId === exactSessionId,
    );
  }

  revokeHost(hostId: string, hostIncarnation?: string): number {
    const exactHostId = exactId(hostId, "Host ID");
    const exactIncarnation =
      hostIncarnation === undefined
        ? undefined
        : exactId(hostIncarnation, "Host incarnation");
    return this.#deleteWhere(
      (record) =>
        record.hostId === exactHostId &&
        (exactIncarnation === undefined ||
          record.hostIncarnation === exactIncarnation),
    );
  }

  /** Bounded evidence for doctor/tests. It contains hashes and policy handles,
   * never bearer grants or policy/config values. */
  evidence(): readonly AgentGatewayGrantDiagnosticEvidence[] {
    this.#pruneExpired(this.#readNow());
    return Object.freeze(
      [...this.#records.values()].map(({ policyHandle: _redacted, ...record }) =>
        Object.freeze(record),
      ),
    );
  }

  clear(): void {
    this.#records.clear();
  }

  get size(): number {
    this.#pruneExpired(this.#readNow());
    return this.#records.size;
  }

  #readNow(): number {
    const now = exactTime(this.#now(), "clock");
    if (now < this.#lastObservedNow) {
      this.#records.clear();
      throw new AgentGatewayGrantClockError();
    }
    this.#lastObservedNow = now;
    return now;
  }

  #pruneExpired(now: number): void {
    this.#deleteWhere(
      (record) =>
        now >= record.deadlineMs || now >= record.authorityExpiresAtMs,
    );
  }

  #deleteWhere(predicate: (record: AgentGatewayGrantEvidence) => boolean) {
    let deleted = 0;
    for (const [hash, record] of this.#records) {
      if (!predicate(record)) continue;
      this.#records.delete(hash);
      deleted++;
    }
    return deleted;
  }
}

export class AgentGatewayGrantCapacityError extends Error {
  constructor() {
    super("Agent gateway grant registry is full");
    this.name = "AgentGatewayGrantCapacityError";
  }
}

export class AgentGatewayGrantPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentGatewayGrantPolicyError";
  }
}

export class AgentGatewayGrantClockError extends Error {
  constructor() {
    super("Agent gateway grant clock moved backwards");
    this.name = "AgentGatewayGrantClockError";
  }
}

export class AgentGatewayGrantEntropyError extends Error {
  constructor() {
    super("Agent gateway grant entropy collided repeatedly");
    this.name = "AgentGatewayGrantEntropyError";
  }
}

const BASE_KEYS = [
  "operationId",
  "kind",
  "fence",
  "planHash",
  "authorityHash",
  "supervisorEpoch",
  "hostId",
  "hostGeneration",
  "hostIncarnation",
  "descriptorDigest",
  "payloadDigest",
  "transcriptAnchor",
  "adapterId",
  "adapterVersion",
  "deadlineMs",
  "authorityExpiresAtMs",
  "policyHandle",
] as const;
const EXPECTATION_KEYS = BASE_KEYS.filter(
  (key) =>
    key !== "policyHandle" &&
    key !== "deadlineMs" &&
    key !== "authorityExpiresAtMs",
);

function decodeBinding(value: unknown): AgentGatewayGrantBinding {
  const snapshot = snapshotJson(value, "grant binding");
  const record = exactRecord(
    snapshot,
    (snapshot as { kind?: unknown }).kind === "mcp"
      ? [...BASE_KEYS, "toolUseEntryId"]
      : BASE_KEYS,
    "grant binding",
  );
  return decodeCommon(record, true) as AgentGatewayGrantBinding;
}

function decodeExpectation(value: unknown): AgentGatewayGrantExpectation {
  const snapshot = snapshotJson(value, "grant expectation");
  const record = exactRecord(
    snapshot,
    (snapshot as { kind?: unknown }).kind === "mcp"
      ? [...EXPECTATION_KEYS, "toolUseEntryId"]
      : EXPECTATION_KEYS,
    "grant expectation",
  );
  return decodeCommon(record, false) as AgentGatewayGrantExpectation;
}

function decodeCommon(
  record: Record<string, unknown>,
  binding: boolean,
): AgentGatewayGrantBinding | AgentGatewayGrantExpectation {
  const kind = record.kind;
  if (kind !== "model" && kind !== "mcp")
    throw new TypeError("invalid grant operation kind");
  const fenceRecord = exactRecord(
    record.fence,
    ["sessionId", "runId", "turnId", "generation"],
    "grant fence",
  );
  const fence = Object.freeze({
    sessionId: exactId(fenceRecord.sessionId, "session ID"),
    runId: exactId(fenceRecord.runId, "run ID"),
    turnId: exactId(fenceRecord.turnId, "turn ID"),
    generation: nonnegative(fenceRecord.generation, "generation"),
  });
  const anchorRecord = exactRecord(
    record.transcriptAnchor,
    ["throughChangeSeq", "entryIds", "digest"],
    "transcript anchor",
  );
  if (
    !Array.isArray(anchorRecord.entryIds) ||
    anchorRecord.entryIds.length > MAX_ANCHOR_IDS
  )
    throw new TypeError("invalid transcript anchor entries");
  const entryIds = anchorRecord.entryIds.map((entryId) =>
    exactId(entryId, "transcript anchor entry ID"),
  );
  if (new Set(entryIds).size !== entryIds.length)
    throw new TypeError("duplicate transcript anchor entry ID");
  const transcriptAnchor = Object.freeze({
    throughChangeSeq: nonnegative(
      anchorRecord.throughChangeSeq,
      "transcript anchor cursor",
    ),
    entryIds: Object.freeze(entryIds),
    digest: exactDigest(anchorRecord.digest, "transcript anchor digest"),
  });
  const common = {
    operationId: exactId(record.operationId, "operation ID"),
    kind: kind as AgentOperationKind,
    fence,
    planHash: exactDigest(record.planHash, "plan hash"),
    authorityHash: exactDigest(record.authorityHash, "authority hash"),
    supervisorEpoch: positive(record.supervisorEpoch, "supervisor epoch"),
    hostId: exactId(record.hostId, "Host ID"),
    hostGeneration: positive(record.hostGeneration, "Host generation"),
    hostIncarnation: exactId(record.hostIncarnation, "Host incarnation"),
    descriptorDigest: exactDigest(
      record.descriptorDigest,
      "descriptor digest",
    ),
    payloadDigest: exactDigest(record.payloadDigest, "payload digest"),
    transcriptAnchor,
    ...(kind === "mcp"
      ? { toolUseEntryId: exactId(record.toolUseEntryId, "tool-use entry ID") }
      : {}),
    adapterId: exactId(record.adapterId, "adapter ID"),
    adapterVersion: exactVersion(record.adapterVersion, "adapter version"),
  };
  if (!binding) return Object.freeze(common);
  const policyHandle = decodeAgentGatewayPolicyHandle(record.policyHandle);
  if (!policyHandle) throw new TypeError("invalid gateway policy handle");
  return Object.freeze({
    ...common,
    deadlineMs: nonnegative(record.deadlineMs, "grant deadline"),
    authorityExpiresAtMs: nonnegative(
      record.authorityExpiresAtMs,
      "authority expiry",
    ),
    policyHandle,
  });
}

function sameExpectation(
  evidence: AgentGatewayGrantEvidence,
  expectation: AgentGatewayGrantExpectation,
): boolean {
  return (
    evidence.operationId === expectation.operationId &&
    evidence.kind === expectation.kind &&
    evidence.fence.sessionId === expectation.fence.sessionId &&
    evidence.fence.runId === expectation.fence.runId &&
    evidence.fence.turnId === expectation.fence.turnId &&
    evidence.fence.generation === expectation.fence.generation &&
    evidence.planHash === expectation.planHash &&
    evidence.authorityHash === expectation.authorityHash &&
    evidence.supervisorEpoch === expectation.supervisorEpoch &&
    evidence.hostId === expectation.hostId &&
    evidence.hostGeneration === expectation.hostGeneration &&
    evidence.hostIncarnation === expectation.hostIncarnation &&
    evidence.descriptorDigest === expectation.descriptorDigest &&
    evidence.payloadDigest === expectation.payloadDigest &&
    evidence.transcriptAnchor.throughChangeSeq ===
      expectation.transcriptAnchor.throughChangeSeq &&
    evidence.transcriptAnchor.digest === expectation.transcriptAnchor.digest &&
    sameStrings(
      evidence.transcriptAnchor.entryIds,
      expectation.transcriptAnchor.entryIds,
    ) &&
    evidence.toolUseEntryId === expectation.toolUseEntryId &&
    evidence.adapterId === expectation.adapterId &&
    evidence.adapterVersion === expectation.adapterVersion
  );
}

function freezeEvidence(
  evidence: AgentGatewayGrantEvidence,
): AgentGatewayGrantEvidence {
  return Object.freeze({ ...evidence });
}

function hashGrant(grant: AgentGatewayDispatchGrant): `sha256:${string}` {
  const digest = new Bun.CryptoHasher("sha256")
    .update(GRANT_HASH_DOMAIN)
    .update(grant)
    .digest("hex");
  return `sha256:${digest}`;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new TypeError(`invalid ${name}`);
  return value as Record<string, unknown>;
}

function snapshotJson(value: unknown, name: string): unknown {
  assertSafeJson(value, name);
  try {
    const snapshot = structuredClone(value);
    assertSafeJson(snapshot, name);
    return snapshot;
  } catch {
    throw new TypeError(`invalid ${name}`);
  }
}

function assertSafeJson(
  value: unknown,
  name: string,
  seen = new Set<object>(),
  depth = 0,
): void {
  if (depth > 12) throw new TypeError(`${name} is too deeply nested`);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`invalid ${name}`);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value))
    throw new TypeError(`invalid ${name}`);
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string"))
    throw new TypeError(`invalid ${name}`);
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      keys.length !== value.length + 1
    )
      throw new TypeError(`invalid ${name}`);
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        descriptor.value === undefined
      )
        throw new TypeError(`invalid ${name}`);
      assertSafeJson(descriptor.value, name, seen, depth + 1);
    }
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype)
      throw new TypeError(`invalid ${name}`);
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        descriptor.value === undefined
      )
        throw new TypeError(`invalid ${name}`);
      assertSafeJson(descriptor.value, name, seen, depth + 1);
    }
  }
  seen.delete(value);
}

function exactId(value: unknown, name: string): string {
  if (typeof value !== "string" || !ID.test(value))
    throw new TypeError(`invalid ${name}`);
  return value;
}
function exactVersion(value: unknown, name: string): string {
  if (typeof value !== "string" || !VERSION.test(value))
    throw new TypeError(`invalid ${name}`);
  return value;
}
function exactDigest(value: unknown, name: string): AgentOperationDigest {
  if (typeof value !== "string" || !DIGEST.test(value))
    throw new TypeError(`invalid ${name}`);
  return value as AgentOperationDigest;
}
function nonnegative(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`invalid ${name}`);
  return value as number;
}
function positive(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new TypeError(`invalid ${name}`);
  return value as number;
}
function exactTime(value: unknown, name: string): number {
  return nonnegative(value, name);
}
