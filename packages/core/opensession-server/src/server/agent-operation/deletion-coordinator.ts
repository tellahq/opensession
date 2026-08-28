import { types as utilTypes } from "node:util";

/** Production-unwired, durable cross-owner Agent session deletion coordinator. */

export const AGENT_DELETION_SCHEMA_VERSION = 1 as const;
export const AGENT_DELETION_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const AGENT_DELETION_PHASES = [
  "stop_and_detach",
  "enumerate_pins",
  "delete_hosts",
  "settle_gateway",
  "verify_and_release_pins",
  "delete_transcript",
  "finish_kernel",
  "completed",
] as const;
export type AgentDeletionPhase = (typeof AGENT_DELETION_PHASES)[number];
type ActivePhase = Exclude<AgentDeletionPhase, "completed">;
export type AgentDeletionDigest = `sha256:${string}`;

export interface AgentDeletionIdentity {
  readonly sessionId: string;
  readonly deleteRequestId: string;
}

export interface AgentDeletionFence {
  readonly generationId: string;
  readonly runGeneration: number;
}

export type AgentDeletionHostLedgerState = "active" | "draining" | "blocked";

export interface AgentDeletionHostTarget extends AgentDeletionFence {
  readonly hostId: string;
  readonly ledgerState: AgentDeletionHostLedgerState;
}

export interface AgentDeletionHostReceipt extends AgentDeletionHostTarget {
  readonly schemaVersion: typeof AGENT_DELETION_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly deleteRequestId: string;
  readonly disposition: "tombstoned" | "already_tombstoned";
  readonly tombstoneDigest: AgentDeletionDigest;
}

export interface AgentDeletionEnumeration {
  readonly pins: readonly AgentDeletionFence[];
  readonly hosts: readonly AgentDeletionHostTarget[];
}

export interface AgentDeletionEnumerationReceipt extends AgentDeletionIdentity,
  AgentDeletionEnumeration {
  readonly schemaVersion: typeof AGENT_DELETION_SCHEMA_VERSION;
  readonly digest: AgentDeletionDigest;
}

export interface AgentDeletionOwnerReceipt<P extends ActivePhase = ActivePhase>
  extends AgentDeletionIdentity {
  readonly schemaVersion: typeof AGENT_DELETION_SCHEMA_VERSION;
  readonly phase: P;
  readonly digest: AgentDeletionDigest;
}

/** Authoritative owner output. Its exact pin and Host receipt sets are verified. */
export interface AgentDeletionPinVerificationReceipt extends AgentDeletionIdentity {
  readonly schemaVersion: typeof AGENT_DELETION_SCHEMA_VERSION;
  readonly phase: "verify_and_release_pins";
  readonly digest: AgentDeletionDigest;
  readonly pins: readonly AgentDeletionFence[];
  readonly hostReceipts: readonly AgentDeletionHostReceipt[];
}

/** Durable phase evidence contains only bounded canonical digests. */
export interface AgentDeletionPhaseReceipt {
  readonly phase: ActivePhase;
  readonly completedAtMs: number;
  readonly evidenceDigests: readonly AgentDeletionDigest[];
}

export interface AgentDeletionRecord extends AgentDeletionIdentity {
  readonly schemaVersion: typeof AGENT_DELETION_SCHEMA_VERSION;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly phase: AgentDeletionPhase;
  readonly receipts: readonly AgentDeletionPhaseReceipt[];
  readonly enumeration?: AgentDeletionEnumeration;
  readonly hostReceipts?: readonly AgentDeletionHostReceipt[];
  readonly completedAtMs?: number;
  readonly lastFailure?: Readonly<{
    phase: ActivePhase;
    failedAtMs: number;
    retryable: true;
    code: "owner_unavailable" | "invalid_receipt";
  }>;
}

export type AgentDeletionCasResult = Readonly<{
  status: "committed" | "conflict";
  record: unknown;
}>;

/** Every returned snapshot is treated as untrusted and decoded exactly. */
export interface AgentDeletionDurableStore {
  claim(input: Readonly<AgentDeletionIdentity & {
    schemaVersion: typeof AGENT_DELETION_SCHEMA_VERSION;
    createdAtMs: number;
  }>): Promise<unknown>;
  load(identity: Readonly<AgentDeletionIdentity>): Promise<unknown>;
  compareAndSwap(expectedRevision: number, next: Readonly<AgentDeletionRecord>): Promise<unknown>;
  cleanupCompleted(completedBeforeMs: number): Promise<number>;
}

export interface AgentDeletionOwners {
  stopLiveTurnAndDetachRoute(
    input: AgentDeletionIdentity,
  ): Promise<AgentDeletionOwnerReceipt<"stop_and_detach">>;
  enumeratePinsAndHosts(input: AgentDeletionIdentity): Promise<AgentDeletionEnumerationReceipt>;
  deleteFromHost(
    input: AgentDeletionIdentity & Readonly<{ target: AgentDeletionHostTarget }>,
  ): Promise<AgentDeletionHostReceipt>;
  settleGatewayPrivateRegistries(
    input: AgentDeletionIdentity,
  ): Promise<AgentDeletionOwnerReceipt<"settle_gateway">>;
  settleOperationLedger(
    input: AgentDeletionIdentity,
  ): Promise<AgentDeletionOwnerReceipt<"settle_gateway">>;
  verifyHostDeletionAndReleasePins(
    input: AgentDeletionIdentity & Readonly<{
      pins: readonly AgentDeletionFence[];
      hostReceipts: readonly AgentDeletionHostReceipt[];
    }>,
  ): Promise<AgentDeletionPinVerificationReceipt>;
  deleteTranscriptAndResetWake(
    input: AgentDeletionIdentity,
  ): Promise<AgentDeletionOwnerReceipt<"delete_transcript">>;
  tombstoneKernelAndFinishArtifacts(
    input: AgentDeletionIdentity,
  ): Promise<AgentDeletionOwnerReceipt<"finish_kernel">>;
}

export interface AgentDeletionResult extends AgentDeletionIdentity {
  readonly ok: true;
  readonly completedAtMs: number;
}

export interface AgentDeletionReadiness {
  readonly ready: boolean;
  readonly retryable: boolean;
  readonly failedPhase?: ActivePhase;
}

export class AgentDeletionReceiptError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "AgentDeletionReceiptError";
  }
}

export class AgentDeletionCoordinator {
  constructor(
    private readonly store: AgentDeletionDurableStore,
    private readonly owners: AgentDeletionOwners,
    private readonly now: () => number = Date.now,
  ) {}

  async deleteSession(identity: AgentDeletionIdentity): Promise<AgentDeletionResult> {
    validateIdentity(identity);
    let record = decodeRecord(await this.store.claim({
      ...identity,
      schemaVersion: AGENT_DELETION_SCHEMA_VERSION,
      createdAtMs: this.now(),
    }), identity);

    while (record.phase !== "completed") {
      try {
        record = await this.runPhase(record);
      } catch (error) {
        await this.checkpointFailure(record, error);
        throw error;
      }
    }
    return success(record);
  }

  readiness(snapshot: unknown): AgentDeletionReadiness {
    const record = decodeRecord(snapshot);
    return record.lastFailure && record.phase !== "completed"
      ? { ready: false, retryable: true, failedPhase: record.lastFailure.phase }
      : { ready: true, retryable: false };
  }

  cleanupExpiredSuccesses(): Promise<number> {
    return this.store.cleanupCompleted(this.now() - AGENT_DELETION_RECEIPT_RETENTION_MS);
  }

  private async runPhase(record: AgentDeletionRecord): Promise<AgentDeletionRecord> {
    const identity = identityOf(record);
    switch (record.phase) {
      case "stop_and_detach": {
        const receipt = decodeOwnerReceipt(
          await this.owners.stopLiveTurnAndDetachRoute(identity), identity, record.phase,
        );
        return this.advance(record, "stop_and_detach", [receipt.digest], "enumerate_pins");
      }
      case "enumerate_pins": {
        const receipt = decodeEnumerationReceipt(
          await this.owners.enumeratePinsAndHosts(identity), identity,
        );
        return this.advance(
          withChanges(record, { enumeration: { pins: receipt.pins, hosts: receipt.hosts } }),
          "enumerate_pins", [receipt.digest], "delete_hosts",
        );
      }
      case "delete_hosts":
        return this.deleteHosts(record);
      case "settle_gateway": {
        const settled = await Promise.allSettled([
          this.owners.settleGatewayPrivateRegistries(identity),
          this.owners.settleOperationLedger(identity),
        ]);
        if (settled[0].status === "rejected" || settled[1].status === "rejected")
          throw new Error("gateway deletion owners did not all settle");
        const receipts = settled.map((item) => decodeOwnerReceipt(
          (item as PromiseFulfilledResult<unknown>).value, identity, "settle_gateway",
        ));
        return this.advance(record, "settle_gateway", receipts.map(({ digest }) => digest),
          "verify_and_release_pins");
      }
      case "verify_and_release_pins": {
        const enumeration = requireEnumeration(record);
        const hostReceipts = requireCompleteHostReceipts(record);
        const receipt = decodeVerificationReceipt(
          await this.owners.verifyHostDeletionAndReleasePins({
            ...identity, pins: enumeration.pins, hostReceipts,
          }), identity, enumeration.pins, hostReceipts,
        );
        return this.advance(record, "verify_and_release_pins", [receipt.digest],
          "delete_transcript");
      }
      case "delete_transcript": {
        const receipt = decodeOwnerReceipt(
          await this.owners.deleteTranscriptAndResetWake(identity), identity, record.phase,
        );
        return this.advance(record, "delete_transcript", [receipt.digest], "finish_kernel");
      }
      case "finish_kernel": {
        const receipt = decodeOwnerReceipt(
          await this.owners.tombstoneKernelAndFinishArtifacts(identity), identity, record.phase,
        );
        return this.advance(record, "finish_kernel", [receipt.digest], "completed");
      }
    }
    throw new AgentDeletionReceiptError("invalid active deletion phase");
  }

  private async deleteHosts(record: AgentDeletionRecord): Promise<AgentDeletionRecord> {
    const identity = identityOf(record);
    const targets = requireEnumeration(record).hosts;
    const existing = canonicalHostReceipts(identity, targets, record.hostReceipts ?? [], false);
    const existingKeys = new Set(existing.map(hostKey));
    const unresolved = targets.filter((target) => !existingKeys.has(hostKey(target)));
    const settled = await Promise.allSettled(unresolved.map((target) =>
      this.owners.deleteFromHost({ ...identity, target })));
    const accepted = [...existing];
    let firstError: unknown;
    for (let index = 0; index < settled.length; index++) {
      const result = settled[index]!;
      if (result.status === "rejected") {
        firstError ??= result.reason;
        continue;
      }
      try {
        accepted.push(decodeHostReceipt(result.value, identity, unresolved[index]!));
      } catch (error) {
        firstError ??= error;
      }
    }
    const canonical = canonicalHostReceipts(identity, targets, accepted, false);
    if (firstError || canonical.length !== targets.length) {
      const persisted = await this.checkpointSamePhase(
        withChanges(record, { hostReceipts: canonical }),
      );
      // A concurrent coordinator may already have completed this phase.
      if (persisted.phase !== "delete_hosts") return persisted;
      const failure = firstError ?? new Error("Host deletion owners did not all settle");
      await this.checkpointFailure(persisted, failure);
      throw failure;
    }
    return this.advance(
      withChanges(record, { hostReceipts: canonical }),
      "delete_hosts", canonical.map(({ tombstoneDigest }) => tombstoneDigest), "settle_gateway",
    );
  }

  private async advance(
    record: AgentDeletionRecord,
    phase: ActivePhase,
    evidenceDigests: readonly AgentDeletionDigest[],
    nextPhase: AgentDeletionPhase,
  ): Promise<AgentDeletionRecord> {
    if (record.phase !== phase)
      throw new AgentDeletionReceiptError(`deletion phase changed before ${phase} checkpoint`);
    const completedAtMs = this.now();
    const next = withChanges(record, {
      phase: nextPhase,
      updatedAtMs: completedAtMs,
      revision: record.revision + 1,
      receipts: [...record.receipts, {
        phase, completedAtMs, evidenceDigests: Object.freeze([...evidenceDigests]),
      }],
      clearFailure: true,
      ...(nextPhase === "completed" ? { completedAtMs } : {}),
    });
    return this.casOrReload(record, next);
  }

  private async checkpointSamePhase(record: AgentDeletionRecord): Promise<AgentDeletionRecord> {
    const next = withChanges(record, {
      revision: record.revision + 1,
      updatedAtMs: this.now(),
      clearFailure: true,
    });
    return this.casOrReload(record, next);
  }

  private async checkpointFailure(record: AgentDeletionRecord, error: unknown): Promise<void> {
    if (record.phase === "completed") return;
    const code = error instanceof AgentDeletionReceiptError
      ? "invalid_receipt" as const : "owner_unavailable" as const;
    const failedAtMs = this.now();
    const next = withChanges(record, {
      revision: record.revision + 1,
      updatedAtMs: failedAtMs,
      lastFailure: { phase: record.phase, failedAtMs, retryable: true, code },
    });
    try {
      await this.casOrReload(record, next);
    } catch {
      // Never replace the owner/storage error, and never blind-write a failure.
    }
  }

  private async casOrReload(
    expected: AgentDeletionRecord,
    next: AgentDeletionRecord,
  ): Promise<AgentDeletionRecord> {
    const result = decodeCasResult(
      await this.store.compareAndSwap(expected.revision, next), identityOf(expected),
    );
    if (result.status === "committed") {
      if (result.record.revision !== next.revision)
        throw new AgentDeletionReceiptError("committed deletion revision mismatch");
      return result.record;
    }
    if (result.record.revision <= expected.revision)
      throw new AgentDeletionReceiptError("deletion CAS conflict returned a stale revision");
    // Reload after conflict rather than trusting a potentially transient conflict snapshot.
    const loaded = decodeRecord(await this.store.load(identityOf(expected)), identityOf(expected));
    if (loaded.revision < result.record.revision)
      throw new AgentDeletionReceiptError("deletion reload regressed the durable revision");
    return loaded;
  }
}

type RecordChanges = Partial<Pick<AgentDeletionRecord,
  "revision" | "updatedAtMs" | "phase" | "receipts" | "enumeration" |
  "hostReceipts" | "completedAtMs" | "lastFailure">> & { clearFailure?: boolean };

function withChanges(record: AgentDeletionRecord, changes: RecordChanges): AgentDeletionRecord {
  const result: Record<string, unknown> = {
    schemaVersion: record.schemaVersion,
    revision: changes.revision ?? record.revision,
    sessionId: record.sessionId,
    deleteRequestId: record.deleteRequestId,
    createdAtMs: record.createdAtMs,
    updatedAtMs: changes.updatedAtMs ?? record.updatedAtMs,
    phase: changes.phase ?? record.phase,
    receipts: changes.receipts ?? record.receipts,
  };
  const enumeration = changes.enumeration ?? record.enumeration;
  const hostReceipts = changes.hostReceipts ?? record.hostReceipts;
  const completedAtMs = changes.completedAtMs ?? record.completedAtMs;
  const lastFailure = changes.clearFailure ? undefined : changes.lastFailure ?? record.lastFailure;
  if (enumeration !== undefined) result.enumeration = enumeration;
  if (hostReceipts !== undefined) result.hostReceipts = hostReceipts;
  if (completedAtMs !== undefined) result.completedAtMs = completedAtMs;
  if (lastFailure !== undefined) result.lastFailure = lastFailure;
  return decodeRecord(result, record);
}

function decodeCasResult(value: unknown, identity: AgentDeletionIdentity): {
  status: "committed" | "conflict"; record: AgentDeletionRecord;
} {
  const data = exactObject(value, ["status", "record"], "deletion CAS result");
  if (data.status !== "committed" && data.status !== "conflict")
    throw new AgentDeletionReceiptError("invalid deletion CAS status");
  return { status: data.status, record: decodeRecord(data.record, identity) };
}

function decodeRecord(value: unknown, identity?: AgentDeletionIdentity): AgentDeletionRecord {
  const data = exactObject(value, [
    "schemaVersion", "revision", "sessionId", "deleteRequestId", "createdAtMs", "updatedAtMs",
    "phase", "receipts", "enumeration?", "hostReceipts?", "completedAtMs?", "lastFailure?",
  ], "deletion record");
  if (data.schemaVersion !== AGENT_DELETION_SCHEMA_VERSION)
    throw new AgentDeletionReceiptError("unsupported deletion record schema");
  const recordIdentity = decodeIdentity(data);
  if (identity) assertIdentity(recordIdentity, identity);
  const revision = safeNonnegativeInteger(data.revision, "deletion revision");
  const createdAtMs = safeNonnegativeInteger(data.createdAtMs, "deletion created time");
  const updatedAtMs = safeNonnegativeInteger(data.updatedAtMs, "deletion updated time");
  if (!isPhase(data.phase)) throw new AgentDeletionReceiptError("invalid deletion phase");
  const receiptValues = exactArray(data.receipts, 7, "deletion phase receipts");
  const receipts = receiptValues.map(decodePhaseReceipt);
  const expectedReceiptPhases = AGENT_DELETION_PHASES.slice(0, phaseIndex(data.phase));
  if (receipts.length !== expectedReceiptPhases.length || receipts.some(
    (receipt, index) => receipt.phase !== expectedReceiptPhases[index]))
    throw new AgentDeletionReceiptError("deletion receipt phases are not an exact prefix");
  const enumeration = data.enumeration === undefined ? undefined : decodeEnumeration(data.enumeration);
  const hostReceipts = data.hostReceipts === undefined ? undefined
    : decodeHostReceiptArray(data.hostReceipts, recordIdentity);
  if (phaseIndex(data.phase) >= phaseIndex("delete_hosts") && !enumeration)
    throw new AgentDeletionReceiptError("durable deletion enumeration is missing");
  if (hostReceipts && !enumeration)
    throw new AgentDeletionReceiptError("Host receipts have no deletion enumeration");
  const completedAtMs = data.completedAtMs === undefined ? undefined
    : safeNonnegativeInteger(data.completedAtMs, "deletion completion time");
  if ((data.phase === "completed") !== (completedAtMs !== undefined))
    throw new AgentDeletionReceiptError("invalid deletion completion checkpoint");
  let lastFailure: AgentDeletionRecord["lastFailure"];
  if (data.lastFailure !== undefined) {
    const failure = exactObject(data.lastFailure,
      ["phase", "failedAtMs", "retryable", "code"], "deletion failure");
    if (!isActivePhase(failure.phase) || failure.retryable !== true ||
      (failure.code !== "owner_unavailable" && failure.code !== "invalid_receipt"))
      throw new AgentDeletionReceiptError("invalid deletion failure");
    lastFailure = {
      phase: failure.phase,
      failedAtMs: safeNonnegativeInteger(failure.failedAtMs, "deletion failure time"),
      retryable: true,
      code: failure.code,
    };
  }
  const result: AgentDeletionRecord = {
    schemaVersion: AGENT_DELETION_SCHEMA_VERSION, revision, ...recordIdentity,
    createdAtMs, updatedAtMs, phase: data.phase, receipts: Object.freeze(receipts),
    ...(enumeration ? { enumeration } : {}),
    ...(hostReceipts ? { hostReceipts } : {}),
    ...(completedAtMs !== undefined ? { completedAtMs } : {}),
    ...(lastFailure ? { lastFailure } : {}),
  };
  if (enumeration && hostReceipts)
    canonicalHostReceipts(recordIdentity, enumeration.hosts, hostReceipts, false);
  for (const receipt of receipts) {
    const expectedDigests = receipt.phase === "settle_gateway" ? 2
      : receipt.phase === "delete_hosts" ? enumeration?.hosts.length ?? -1
      : 1;
    if (receipt.evidenceDigests.length !== expectedDigests)
      throw new AgentDeletionReceiptError("deletion phase has the wrong evidence digest count");
  }
  return Object.freeze(result);
}

function decodePhaseReceipt(value: unknown): AgentDeletionPhaseReceipt {
  const data = exactObject(value, ["phase", "completedAtMs", "evidenceDigests"],
    "deletion phase receipt");
  if (!isActivePhase(data.phase))
    throw new AgentDeletionReceiptError("invalid deletion phase receipt");
  const evidenceDigests = exactArray(data.evidenceDigests, 1_024, "deletion evidence digests");
  return Object.freeze({
    phase: data.phase,
    completedAtMs: safeNonnegativeInteger(data.completedAtMs, "phase receipt time"),
    evidenceDigests: Object.freeze(evidenceDigests.map(decodeDigest)),
  });
}

function decodeOwnerReceipt<P extends ActivePhase>(
  value: unknown, identity: AgentDeletionIdentity, phase: P,
): AgentDeletionOwnerReceipt<P> {
  const data = exactObject(value,
    ["schemaVersion", "sessionId", "deleteRequestId", "phase", "digest"], "owner receipt");
  if (data.schemaVersion !== AGENT_DELETION_SCHEMA_VERSION || data.phase !== phase)
    throw new AgentDeletionReceiptError("invalid deletion owner receipt");
  const receiptIdentity = decodeIdentity(data);
  assertIdentity(receiptIdentity, identity);
  return Object.freeze({
    schemaVersion: AGENT_DELETION_SCHEMA_VERSION, ...receiptIdentity, phase,
    digest: decodeDigest(data.digest),
  });
}

function decodeEnumerationReceipt(
  value: unknown, identity: AgentDeletionIdentity,
): AgentDeletionEnumerationReceipt {
  const data = exactObject(value, [
    "schemaVersion", "sessionId", "deleteRequestId", "digest", "pins", "hosts",
  ], "enumeration receipt");
  if (data.schemaVersion !== AGENT_DELETION_SCHEMA_VERSION)
    throw new AgentDeletionReceiptError("invalid deletion enumeration receipt");
  const receiptIdentity = decodeIdentity(data);
  assertIdentity(receiptIdentity, identity);
  const enumeration = decodeEnumeration({ pins: data.pins, hosts: data.hosts });
  return Object.freeze({
    schemaVersion: AGENT_DELETION_SCHEMA_VERSION, ...receiptIdentity,
    digest: decodeDigest(data.digest), ...enumeration,
  });
}

function decodeEnumeration(value: unknown): AgentDeletionEnumeration {
  const data = exactObject(value, ["pins", "hosts"], "deletion enumeration");
  const pinValues = exactArray(data.pins, 1_024, "deletion pins");
  const hostValues = exactArray(data.hosts, 1_024, "deletion Hosts");
  const pins = uniqueSorted(pinValues.map(decodeFence), fenceKey);
  const hosts = uniqueSorted(hostValues.map((item) => decodeHostTarget(item)), hostKey);
  return Object.freeze({ pins: Object.freeze(pins), hosts: Object.freeze(hosts) });
}

function decodeHostReceipt(
  value: unknown, identity: AgentDeletionIdentity, target?: AgentDeletionHostTarget,
): AgentDeletionHostReceipt {
  const data = exactObject(value, [
    "schemaVersion", "sessionId", "deleteRequestId", "hostId", "ledgerState",
    "generationId", "runGeneration", "disposition", "tombstoneDigest",
  ], "Host deletion receipt");
  if (data.schemaVersion !== AGENT_DELETION_SCHEMA_VERSION ||
    (data.disposition !== "tombstoned" && data.disposition !== "already_tombstoned"))
    throw new AgentDeletionReceiptError("invalid Host deletion receipt");
  const receiptIdentity = decodeIdentity(data);
  assertIdentity(receiptIdentity, identity);
  const receipt: AgentDeletionHostReceipt = Object.freeze({
    schemaVersion: AGENT_DELETION_SCHEMA_VERSION, ...receiptIdentity,
    ...decodeHostTarget(data, true), disposition: data.disposition,
    tombstoneDigest: decodeDigest(data.tombstoneDigest),
  });
  if (target && hostKey(receipt) !== hostKey(target))
    throw new AgentDeletionReceiptError("stale Host deletion receipt");
  return receipt;
}

function decodeHostReceiptArray(
  value: unknown, identity: AgentDeletionIdentity,
): readonly AgentDeletionHostReceipt[] {
  const values = exactArray(value, 1_024, "durable Host receipts");
  return Object.freeze(values.map((item) => decodeHostReceipt(item, identity)));
}

function decodeVerificationReceipt(
  value: unknown,
  identity: AgentDeletionIdentity,
  expectedPins: readonly AgentDeletionFence[],
  expectedHosts: readonly AgentDeletionHostReceipt[],
): AgentDeletionPinVerificationReceipt {
  const data = exactObject(value, [
    "schemaVersion", "sessionId", "deleteRequestId", "phase", "digest", "pins", "hostReceipts",
  ], "pin verification receipt");
  if (data.schemaVersion !== AGENT_DELETION_SCHEMA_VERSION ||
    data.phase !== "verify_and_release_pins")
    throw new AgentDeletionReceiptError("invalid pin verification receipt");
  const receiptIdentity = decodeIdentity(data);
  assertIdentity(receiptIdentity, identity);
  const pinValues = exactArray(data.pins, 1_024, "verified pin set");
  const pins = uniqueSorted(pinValues.map(decodeFence), fenceKey);
  const hosts = decodeHostReceiptArray(data.hostReceipts, identity);
  if (!sameKeys(pins, expectedPins, fenceKey) || !sameHostReceipts(hosts, expectedHosts))
    throw new AgentDeletionReceiptError("pin verification did not bind the full owner set");
  return Object.freeze({
    schemaVersion: AGENT_DELETION_SCHEMA_VERSION, ...receiptIdentity,
    phase: "verify_and_release_pins", digest: decodeDigest(data.digest),
    pins: Object.freeze(pins), hostReceipts: hosts,
  });
}

function canonicalHostReceipts(
  identity: AgentDeletionIdentity,
  targets: readonly AgentDeletionHostTarget[],
  receipts: readonly AgentDeletionHostReceipt[],
  requireComplete: boolean,
): readonly AgentDeletionHostReceipt[] {
  const targetKeys = new Set(targets.map(hostKey));
  const byTarget = new Map<string, AgentDeletionHostReceipt>();
  for (const raw of receipts) {
    const receipt = decodeHostReceipt(raw, identity);
    const key = hostKey(receipt);
    if (!targetKeys.has(key) || byTarget.has(key))
      throw new AgentDeletionReceiptError("unexpected or duplicate Host deletion receipt");
    byTarget.set(key, receipt);
  }
  if (requireComplete && byTarget.size !== targets.length)
    throw new AgentDeletionReceiptError("incomplete Host deletion receipts");
  return Object.freeze(targets.flatMap((target) => {
    const receipt = byTarget.get(hostKey(target));
    return receipt ? [receipt] : [];
  }));
}

function requireEnumeration(record: AgentDeletionRecord): AgentDeletionEnumeration {
  if (!record.enumeration)
    throw new AgentDeletionReceiptError("durable deletion enumeration is missing");
  return record.enumeration;
}

function requireCompleteHostReceipts(record: AgentDeletionRecord): readonly AgentDeletionHostReceipt[] {
  return canonicalHostReceipts(record, requireEnumeration(record).hosts,
    record.hostReceipts ?? [], true);
}

function decodeFence(value: unknown): AgentDeletionFence {
  const data = exactObject(value, ["generationId", "runGeneration"], "generation fence");
  return Object.freeze({
    generationId: boundedString(data.generationId, "generation id"),
    runGeneration: safeNonnegativeInteger(data.runGeneration, "run generation"),
  });
}

function decodeHostTarget(value: unknown, embedded = false): AgentDeletionHostTarget {
  const data = exactObject(value,
    ["hostId", "ledgerState", "generationId", "runGeneration"], "Host target", embedded);
  if (data.ledgerState !== "active" && data.ledgerState !== "draining" &&
    data.ledgerState !== "blocked")
    throw new AgentDeletionReceiptError("invalid Host ledger state");
  return Object.freeze({
    hostId: boundedString(data.hostId, "Host id"), ledgerState: data.ledgerState,
    generationId: boundedString(data.generationId, "generation id"),
    runGeneration: safeNonnegativeInteger(data.runGeneration, "run generation"),
  });
}

function exactObject(
  value: unknown,
  keySpec: readonly string[],
  label: string,
  allowAdditional = false,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype)
    throw new AgentDeletionReceiptError(`${label} must be a plain non-Proxy snapshot`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const required = new Set(keySpec.filter((key) => !key.endsWith("?")));
  const allowed = new Set(keySpec.map((key) => key.replace(/\?$/, "")));
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || (!allowAdditional && !allowed.has(key)))
      throw new AgentDeletionReceiptError(`${label} has an unexpected key`);
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor))
      throw new AgentDeletionReceiptError(`${label} contains an accessor`);
  }
  for (const key of required) {
    if (!Object.hasOwn(descriptors, key))
      throw new AgentDeletionReceiptError(`${label} is missing ${key}`);
  }
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) result[key] = descriptor.value;
  return result;
}

function exactArray(value: unknown, maxLength: number, label: string): unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype)
    throw new AgentDeletionReceiptError(`${label} must be a non-Proxy array snapshot`);
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const lengthValue = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value : undefined;
  if (typeof lengthValue !== "number" || !Number.isSafeInteger(lengthValue) ||
    lengthValue < 0 || lengthValue > maxLength)
    throw new AgentDeletionReceiptError(`${label} has an invalid length`);
  const length = lengthValue;
  const result: unknown[] = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)
      throw new AgentDeletionReceiptError(`${label} has an unexpected key`);
    if (!("value" in descriptors[key]!))
      throw new AgentDeletionReceiptError(`${label} contains an accessor`);
  }
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor))
      throw new AgentDeletionReceiptError(`${label} contains a hole or accessor`);
    result.push(descriptor.value);
  }
  return result;
}

function decodeIdentity(value: Record<string, unknown>): AgentDeletionIdentity {
  return Object.freeze({
    sessionId: boundedString(value.sessionId, "session id"),
    deleteRequestId: boundedString(value.deleteRequestId, "delete request id"),
  });
}

function validateIdentity(identity: AgentDeletionIdentity): void {
  // Exact owner-bound input is copied before crossing any owner boundary.
  decodeIdentity(exactObject(identity, ["sessionId", "deleteRequestId"], "deletion identity"));
}

function assertIdentity(actual: AgentDeletionIdentity, expected: AgentDeletionIdentity): void {
  if (actual.sessionId !== expected.sessionId || actual.deleteRequestId !== expected.deleteRequestId)
    throw new AgentDeletionReceiptError("durable deletion identity mismatch");
}

function identityOf(record: AgentDeletionIdentity): AgentDeletionIdentity {
  return Object.freeze({ sessionId: record.sessionId, deleteRequestId: record.deleteRequestId });
}

function decodeDigest(value: unknown): AgentDeletionDigest {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value))
    throw new AgentDeletionReceiptError("invalid deletion evidence digest");
  return value as AgentDeletionDigest;
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f]/.test(value))
    throw new AgentDeletionReceiptError(`invalid ${label}`);
  return value;
}

function safeNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new AgentDeletionReceiptError(`invalid ${label}`);
  return value as number;
}

function phaseIndex(phase: AgentDeletionPhase): number {
  return AGENT_DELETION_PHASES.indexOf(phase);
}
function isPhase(value: unknown): value is AgentDeletionPhase {
  return typeof value === "string" && (AGENT_DELETION_PHASES as readonly string[]).includes(value);
}
function isActivePhase(value: unknown): value is ActivePhase {
  return isPhase(value) && value !== "completed";
}
function fenceKey(value: AgentDeletionFence): string {
  return `${value.generationId}\u0000${value.runGeneration}`;
}
function hostKey(value: AgentDeletionHostTarget): string {
  return `${value.hostId}\u0000${value.ledgerState}\u0000${fenceKey(value)}`;
}
function uniqueSorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  const map = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (map.has(id)) throw new AgentDeletionReceiptError("duplicate deletion owner fence");
    map.set(id, value);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}
function sameKeys<T>(left: readonly T[], right: readonly T[], key: (value: T) => string): boolean {
  return left.length === right.length && left.every((value, index) => key(value) === key(right[index]!));
}
function sameHostReceipts(
  left: readonly AgentDeletionHostReceipt[], right: readonly AgentDeletionHostReceipt[],
): boolean {
  return left.length === right.length && left.every((value, index) => {
    const other = right[index]!;
    return hostKey(value) === hostKey(other) && value.disposition === other.disposition &&
      value.tombstoneDigest === other.tombstoneDigest;
  });
}
function success(record: AgentDeletionRecord): AgentDeletionResult {
  if (record.phase !== "completed" || record.completedAtMs === undefined)
    throw new AgentDeletionReceiptError("deletion is not complete");
  return Object.freeze({
    ok: true, ...identityOf(record), completedAtMs: record.completedAtMs,
  });
}
