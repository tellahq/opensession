import { dirname } from "node:path";
import {
  SessionKernelStore,
  sessionKernelDbPath,
  sessionKernelSessionDbPath,
  type DurableOutboxItem,
  type DurableSessionQuarantine,
  type DurableTimer,
  type SessionKernelStoreApi,
} from "./store";
import { sessionKernelStoreRoute } from "./store-routing";
import { TranscriptStore } from "../transcript-store";
import {
  assertTranscriptActorRequest,
  type TranscriptActorRequest,
  type TranscriptActorResult,
} from "./transcript-protocol";

const CENTRAL_STORE_FAILURE = "SESSION_KERNEL_CENTRAL_STORE_FAILURE";
// Catalog discovery returns ids only. Each candidate then claims work on its
// own session lane, and this bound prevents crash recovery from flooding those
// latency-sensitive mailboxes in one tick.
const RUNTIME_WAKE_CANDIDATE_BATCH = 4;

export type SessionKernelStoreHostMetrics = {
  kernelStoreCacheMisses: number;
  kernelStoreCacheEvictions: number;
  transcriptStoreCacheMisses: number;
  transcriptStoreCacheEvictions: number;
  sqliteBusy: number;
};

const SPARSE_PROJECTION_MUTATIONS = new Set([
  "setAskRecord",
  "answerAskRecord",
  "deleteAskRecord",
  "setDeliverySlot",
  "deleteDeliverySlot",
  "prepareSteerDelivery",
  "acceptSteerDelivery",
  "rejectSteerDelivery",
  "requeueSteerDeliveries",
  "ackDeliveryDispatch",
  "failDeliveryDispatch",
  "prepareDeliveryInterrupt",
  "beginDeliveryInterruptEffect",
  "settleDeliveryInterrupt",
  "claimNextDeliveryDispatch",
  "claimDeliveryDispatch",
  "clearSession",
  "tombstoneSession",
]);

export function isSessionKernelCentralStoreFailure(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === CENTRAL_STORE_FAILURE
  );
}

export function isSessionKernelInfrastructureFailure(error: unknown): boolean {
  if (isSessionKernelCentralStoreFailure(error)) return true;
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (code.startsWith("SQLITE_") && !code.startsWith("SQLITE_CONSTRAINT"))
    return true;
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|disk i\/o|disk full|database.*(?:malformed|corrupt)|not a database|readonly database/i.test(
    message,
  );
}

function centralStoreFailure(error: unknown): Error & { code: string } {
  const wrapped = new Error(
    error instanceof Error ? error.message : String(error),
    { cause: error },
  ) as Error & { code: string };
  wrapped.code = CENTRAL_STORE_FAILURE;
  return wrapped;
}

/**
 * Routes one session to exactly one authoritative SQLite store.
 *
 * Existing central sessions move in bounded, verified maintenance batches. A
 * session with no central durable rows is claimed in the placement catalog
 * before its first mutation and writes only its own DB.
 * The durable dirty bit is committed before every isolated mutation, making
 * the global wake index conservative and repairable after a crash.
 */
export class SessionKernelStoreHost {
  readonly central: SessionKernelStore;
  private readonly isolated = new Map<string, SessionKernelStore>();
  private readonly transcripts = new Map<string, TranscriptStore>();
  private runtimeCursor = "";
  private runtimeDueCursor = "";
  private readonly laneMetrics: SessionKernelStoreHostMetrics = {
    kernelStoreCacheMisses: 0,
    kernelStoreCacheEvictions: 0,
    transcriptStoreCacheMisses: 0,
    transcriptStoreCacheEvictions: 0,
    sqliteBusy: 0,
  };
  constructor(
    private readonly centralPath = sessionKernelDbPath(),
    private readonly isolatedRoot = `${dirname(centralPath)}/session-kernel-sessions`,
    private readonly maxOpenSessionStores = Math.max(
      1,
      Number(process.env.OPENSESSION_SESSION_KERNEL_ACTIVE_STORES ?? 64),
    ),
  ) {
    if (!Number.isInteger(maxOpenSessionStores) || maxOpenSessionStores > 1_024)
      throw new Error("Invalid active session store bound");
    this.central = new SessionKernelStore(centralPath);
  }

  metrics(): SessionKernelStoreHostMetrics {
    return { ...this.laneMetrics };
  }

  recordSqliteBusy(error: unknown): void {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    const message = error instanceof Error ? error.message : String(error);
    if (
      code.startsWith("SQLITE_BUSY") ||
      /sqlite_busy|database is locked/i.test(message)
    )
      this.laneMetrics.sqliteBusy += 1;
  }

  close(): void {
    for (const store of this.transcripts.values()) store.close();
    this.transcripts.clear();
    for (const store of this.isolated.values()) store.close();
    this.isolated.clear();
    this.central.close();
  }

  private centralOperation<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      throw centralStoreFailure(error);
    }
  }

  isIsolated(sessionId: string): boolean {
    return this.centralOperation(
      () => this.central.sessionPlacement(sessionId)?.placement === "isolated",
    );
  }

  /** Prove that a settlement which timed out at the gateway did commit. The
   * central route is durable ownership evidence, while absence from that
   * session's isolated outbox proves the actor already removed the effect. */
  private committedOutboxSettlementEvidence(
    sessionId: string,
    quarantine: DurableSessionQuarantine,
  ): boolean {
    if (
      quarantine.commandKind !== "core:ack_outbox" &&
      quarantine.commandKind !== "core:fail_outbox"
    )
      return false;
    const match = /^Outbox (\d+) crossed session ownership$/.exec(
      quarantine.reason,
    );
    if (!match || !this.isIsolated(sessionId)) return false;
    const outboxId = Number(match[1]);
    if (!Number.isSafeInteger(outboxId)) return false;
    if (
      this.centralOperation(() =>
        this.central.isolatedOutboxSessionId(outboxId),
      ) !== sessionId
    )
      return false;
    const settled = this.containIsolated(
      sessionId,
      "storage:outbox-settlement-evidence",
      () => this.openIsolated(sessionId).outboxSessionId(outboxId),
    );
    return settled.ok && settled.value === undefined;
  }

  quarantinedSession(sessionId: string): DurableSessionQuarantine | undefined {
    const infrastructure = this.centralOperation(() =>
      this.central.quarantinedSession(sessionId),
    );
    if (infrastructure) {
      const committedOutboxSettlement = this.committedOutboxSettlementEvidence(
        sessionId,
        infrastructure,
      );
      if (
        (!infrastructure.repairable && !committedOutboxSettlement) ||
        !this.isIsolated(sessionId)
      )
        return infrastructure;
      const evidence = this.containIsolated(
        sessionId,
        "storage:quarantine-repair-evidence",
        () =>
          this.openIsolated(sessionId).quarantineRepairEvidence(
            sessionId,
            infrastructure.commandKind,
            infrastructure.reason,
            committedOutboxSettlement,
          ),
      );
      return {
        ...infrastructure,
        repairable: evidence.ok && evidence.value,
      };
    }
    if (!this.isIsolated(sessionId)) return undefined;
    const isolated = this.containIsolated(
      sessionId,
      "storage:quarantine-read",
      () => this.openIsolated(sessionId).quarantinedSession(sessionId),
    );
    if (!isolated.ok)
      return this.centralOperation(() =>
        this.central.quarantinedSession(sessionId),
      );
    if (!isolated.value || isolated.value.repairable) return isolated.value;
    const committedOutboxSettlement = this.committedOutboxSettlementEvidence(
      sessionId,
      isolated.value,
    );
    return committedOutboxSettlement
      ? {
          ...isolated.value,
          repairable: this.openIsolated(sessionId).quarantineRepairEvidence(
            sessionId,
            isolated.value.commandKind,
            isolated.value.reason,
            true,
          ),
        }
      : isolated.value;
  }

  quarantineSession(
    sessionId: string,
    reason: string,
    commandKind: string,
    infrastructure = false,
  ): DurableSessionQuarantine {
    const isolatedBefore = this.isIsolated(sessionId);
    if (isolatedBefore)
      this.centralOperation(() =>
        this.central.markIsolatedSessionProjectionDirty(sessionId),
      );
    const quarantine =
      infrastructure && isolatedBefore
        ? this.centralOperation(() =>
            this.central.quarantineSession(sessionId, reason, commandKind),
          )
        : this.storeForSession(sessionId, true, true).quarantineSession(
            sessionId,
            reason,
            commandKind,
          );
    const isolated = isolatedBefore || this.isIsolated(sessionId);
    if (isolated) {
      if (infrastructure)
        this.centralOperation(() =>
          this.central.settleIsolatedSessionProjection(
            sessionId,
            undefined,
            undefined,
            quarantine,
          ),
        );
      else this.refreshSessionProjections(sessionId);
    }
    return quarantine;
  }

  storeForSession(
    sessionId: string,
    mutation = false,
    projectionMutation = false,
  ): SessionKernelStore {
    const placement = this.centralOperation(() =>
      this.central.sessionPlacement(sessionId),
    );
    if (placement) {
      if (mutation)
        this.centralOperation(() =>
          this.central.markIsolatedSessionDirty(sessionId),
        );
      if (projectionMutation)
        this.centralOperation(() =>
          this.central.markIsolatedSessionProjectionDirty(sessionId),
        );
      return this.openIsolated(sessionId);
    }
    if (
      !mutation ||
      this.centralOperation(() =>
        this.central.hasSessionDurableState(sessionId),
      )
    )
      return this.central;
    this.centralOperation(() => this.central.claimIsolatedSession(sessionId));
    if (projectionMutation)
      this.centralOperation(() =>
        this.central.markIsolatedSessionProjectionDirty(sessionId),
      );
    return this.openIsolated(sessionId);
  }

  transcript<T extends TranscriptActorRequest>(
    request: T,
  ): TranscriptActorResult<T> {
    assertTranscriptActorRequest(request);
    const mutation = "requestId" in request || request.op === "ack_wake";
    const kernelStore = mutation
      ? this.storeForSession(request.sessionId, true)
      : undefined;
    const placement = this.centralOperation(() =>
      this.central.sessionPlacement(request.sessionId),
    );
    if (
      !placement ||
      placement.placement !== "isolated" ||
      placement.transcriptAuthority !== "actor"
    )
      throw new Error(
        `Session ${request.sessionId} has no isolated actor transcript placement`,
      );
    const transcriptStore = this.openTranscript(request.sessionId);
    if (request.op === "agent_append_destination") {
      return transcriptStore.commitAgentTranscriptDestinationAppend({
        sessionId: request.sessionId,
        appendId: request.appendId,
        runId: request.runId,
        turnId: request.turnId,
        generation: request.generation,
        transcriptAnchor: request.transcriptAnchor,
        entries: [...request.entries],
      }) as TranscriptActorResult<T>;
    }
    if (request.op === "agent_query_destination_receipt") {
      if (
        this.storeForSession(request.sessionId).isTombstoned(request.sessionId)
      )
        throw new Error(`Session ${request.sessionId} was deleted`);
      return transcriptStore.queryAgentTranscriptReceiptRef({
        sessionId: request.sessionId,
        appendId: request.appendId,
        runId: request.runId,
        turnId: request.turnId,
        generation: request.generation,
        transcriptAnchor: request.transcriptAnchor,
        requestDigest: request.requestDigest,
      }) as TranscriptActorResult<T>;
    }
    if (request.op === "agent_validate_destination_receipt") {
      if (
        this.storeForSession(request.sessionId).isTombstoned(request.sessionId)
      )
        throw new Error(`Session ${request.sessionId} was deleted`);
      return transcriptStore.validateAgentTranscriptReceiptRef({
        sessionId: request.sessionId,
        runId: request.runId,
        turnId: request.turnId,
        generation: request.generation,
        transcriptAnchor: request.transcriptAnchor,
        receipt: request.receipt,
      }) as TranscriptActorResult<T>;
    }
    if (request.op === "append_destination") {
      if (transcriptStore.replayActorRequest(request))
        return transcriptStore.applyActorRequest(
          request,
        ) as TranscriptActorResult<T>;
      kernelStore!.assertTranscriptDestinationFence(request);
    }
    return transcriptStore.applyActorRequest(
      request,
    ) as TranscriptActorResult<T>;
  }

  private outboxRoute(id: number): { central?: string; isolated?: string } {
    const central = this.centralOperation(() =>
      this.central.outboxSessionId(id),
    );
    const isolated = this.centralOperation(() =>
      this.central.isolatedOutboxSessionId(id),
    );
    if (central && isolated)
      throw centralStoreFailure(
        new Error(
          `Outbox ${id} has conflicting central and isolated route evidence`,
        ),
      );
    return { central, isolated };
  }

  storeForOutbox(id: number, mutation = false): SessionKernelStore {
    const route = this.outboxRoute(id);
    if (route.central) return this.central;
    if (!route.isolated) return this.central;
    return this.storeForSession(route.isolated, mutation);
  }

  outboxSessionId(id: number): string | undefined {
    const route = this.outboxRoute(id);
    return route.central ?? route.isolated;
  }

  call(method: string, args: unknown[]): unknown {
    if (method === "quarantinedSession")
      return this.quarantinedSession(String(args[0] ?? ""));
    if (method === "quarantineSession")
      return this.quarantineSession(
        String(args[0] ?? ""),
        String(args[1] ?? ""),
        String(args[2] ?? "unknown"),
      );
    if (method === "releaseQuarantine") {
      const sessionId = String(args[0] ?? "");
      const quarantine = this.quarantinedSession(sessionId);
      if (!quarantine?.repairable) return false;
      const committedOutboxSettlement = this.committedOutboxSettlementEvidence(
        sessionId,
        quarantine,
      );
      let isolatedReleased = false;
      if (this.isIsolated(sessionId)) {
        this.centralOperation(() =>
          this.central.markIsolatedSessionProjectionDirty(sessionId),
        );
        const isolated = this.containIsolated(
          sessionId,
          "storage:quarantine-release",
          () =>
            this.openIsolated(sessionId).releaseQuarantine(
              sessionId,
              committedOutboxSettlement,
            ),
        );
        if (isolated.ok) isolatedReleased = isolated.value;
      }
      const centralReleased = this.centralOperation(() =>
        this.central.releaseQuarantine(sessionId, committedOutboxSettlement),
      );
      if (centralReleased || isolatedReleased)
        this.refreshSessionProjections(sessionId);
      return centralReleased || isolatedReleased;
    }
    const route = sessionKernelStoreRoute(method, args);
    if (route.scope === "global") return this.callGlobal(method, args);
    if (route.scope === "outbox") {
      if (method === "outboxSessionId") return this.outboxSessionId(route.id);
      const store = this.storeForOutbox(route.id, route.mutation);
      const result = this.invoke(store, method, args);
      if (
        (method === "ackOutbox" ||
          (method === "discardDeadOutbox" && result === true)) &&
        this.centralOperation(() =>
          this.central.isolatedOutboxSessionId(route.id),
        )
      )
        this.centralOperation(() =>
          this.central.forgetIsolatedOutboxRoute(route.id),
        );
      return result;
    }
    const result = this.invoke(
      this.storeForSession(
        route.sessionId,
        route.mutation,
        route.mutation && SPARSE_PROJECTION_MUTATIONS.has(method),
      ),
      method,
      args,
    );
    if (route.mutation && SPARSE_PROJECTION_MUTATIONS.has(method))
      this.refreshSessionProjections(route.sessionId);
    return result;
  }

  refreshSessionProjections(sessionId: string): void {
    if (!this.isIsolated(sessionId)) return;
    const store = this.storeForSession(sessionId);
    const quarantined =
      this.centralOperation(() => this.central.quarantinedSession(sessionId)) ||
      store.quarantinedSession(sessionId);
    const ask = quarantined ? undefined : store.askSnapshot(sessionId);
    const delivery = quarantined
      ? undefined
      : store.deliverySnapshot(sessionId);
    const sparseDelivery =
      delivery &&
      (delivery.queued.length > 0 ||
        delivery.steered.length > 0 ||
        delivery.pendingSteers.length > 0 ||
        delivery.dispatch !== undefined ||
        delivery.interrupt !== undefined)
        ? delivery
        : undefined;
    this.centralOperation(() =>
      this.central.settleIsolatedSessionProjection(
        sessionId,
        ask,
        sparseDelivery,
        quarantined,
      ),
    );
  }

  allAskEntries(): Array<[string, unknown]> {
    const entries = [
      ...this.central.askEntries(),
      ...this.central.isolatedAskProjectionEntries(),
    ];
    return structuredClone(entries);
  }

  allDeliveryEntries(
    slot: Parameters<SessionKernelStoreApi["deliveryEntries"]>[0],
  ) {
    const entries = [
      ...this.central.deliveryEntries(slot),
      ...this.central.isolatedDeliveryProjectionEntries(slot),
    ];
    return structuredClone(entries);
  }

  allQuarantinedSessions(limit = 100, offset = 0): DurableSessionQuarantine[] {
    // This latency-sensitive read stays entirely on the catalog. Runtime
    // maintenance backfills old stores in bounded turns, and every new
    // quarantine mutation refreshes its durable projection eagerly.
    const unique = new Map<string, DurableSessionQuarantine>();
    for (const entry of [
      ...this.central.quarantinedSessions(Number.MAX_SAFE_INTEGER, 0),
      ...this.central.isolatedQuarantineProjectionEntries(),
    ])
      unique.set(entry.sessionId, entry);
    return structuredClone(
      [...unique.values()]
        .sort((a, b) => b.quarantinedAt - a.quarantinedAt)
        .slice(offset, offset + limit),
    );
  }

  runtimeCatalogWork(
    now: number,
    timerKinds: string[],
    effectKinds: string[],
    limit: number,
    additionalOutboxGroups: Array<{
      effectKinds: string[];
      limit: number;
    }> = [],
    activeOutbox: Array<{ id: number; sessionId: string }> = [],
  ): {
    sessionIds: string[];
    timers: DurableTimer[];
    outbox: DurableOutboxItem[];
  } {
    const outboxGroups = [
      { effectKinds, limit },
      ...additionalOutboxGroups,
    ].map((group) => ({ ...group, items: [] as DurableOutboxItem[] }));
    const largestLimit = Math.max(
      limit,
      ...outboxGroups.map((group) => group.limit),
    );
    const sessionIds = this.runtimeCandidates(now, largestLimit);
    const quota = (groupLimit: number) =>
      Math.max(1, Math.ceil(groupLimit / (sessionIds.length + 1)));
    const timers = this.central.dueTimers(
      now,
      Math.min(quota(limit), limit),
      timerKinds,
    );
    const activeIds = activeOutbox.map((item) => item.id);
    for (const group of outboxGroups) {
      group.items.push(
        ...this.central.pendingOutbox(
          now,
          Math.min(quota(group.limit), group.limit),
          group.effectKinds,
          activeIds,
        ),
      );
    }
    const outbox = new Map<number, DurableOutboxItem>();
    for (const group of outboxGroups)
      for (const item of group.items) outbox.set(item.id, item);
    return { sessionIds, timers, outbox: [...outbox.values()] };
  }

  runtimeSessionWork(
    sessionId: string,
    candidateCount: number,
    now: number,
    timerKinds: string[],
    effectKinds: string[],
    limit: number,
    additionalOutboxGroups: Array<{
      effectKinds: string[];
      limit: number;
    }> = [],
    activeOutbox: Array<{ id: number; sessionId: string }> = [],
    activeOutboxRecheckAt = now,
  ): { timers: DurableTimer[]; outbox: DurableOutboxItem[] } {
    const divisor = Math.max(1, Math.floor(candidateCount) + 1);
    const quota = (groupLimit: number) =>
      Math.max(1, Math.ceil(groupLimit / divisor));
    const activeIds = activeOutbox
      .filter((item) => item.sessionId === sessionId)
      .map((item) => item.id);
    const scanned = this.containIsolated(sessionId, "runtime:scan", () => {
      const store = this.openIsolated(sessionId);
      return {
        timers: store.dueTimers(now, Math.min(quota(limit), limit), timerKinds),
        outbox: [{ effectKinds, limit }, ...additionalOutboxGroups].flatMap(
          (group) =>
            store.pendingOutbox(
              now,
              Math.min(quota(group.limit), group.limit),
              group.effectKinds,
              activeIds,
            ),
        ),
        nextTimerWakeAt: store.nextTimerWakeAt(),
        nextOutboxWakeAt: store.nextOutboxWakeAt(
          activeIds,
          activeOutboxRecheckAt,
        ),
      };
    });
    if (!scanned.ok) return { timers: [], outbox: [] };
    this.centralOperation(() =>
      this.central.settleIsolatedSessionWake(
        sessionId,
        scanned.value.nextTimerWakeAt,
        scanned.value.nextOutboxWakeAt,
      ),
    );
    const outbox = new Map<number, DurableOutboxItem>();
    for (const item of scanned.value.outbox) outbox.set(item.id, item);
    return { timers: scanned.value.timers, outbox: [...outbox.values()] };
  }

  private runtimeCandidates(now: number, limit: number): string[] {
    const candidateLimit = Math.max(
      1,
      Math.min(RUNTIME_WAKE_CANDIDATE_BATCH, limit),
    );
    // Reserve half the batch for the most recently dirtied actors and the
    // oldest already-indexed due work. The remaining cursor slots repair a
    // conservative migration or crash-recovery backlog without fleet fanout.
    const priorityLimit = Math.min(4, candidateLimit);
    const recentLimit = Math.ceil(priorityLimit / 2);
    const dueLimit = priorityLimit - recentLimit;
    const candidates =
      this.central.isolatedRecentDirtyWakeCandidates(recentLimit);
    const seen = new Set(candidates);
    if (dueLimit > 0) {
      let due = this.central.isolatedDueWakeCandidates(
        now,
        dueLimit,
        this.runtimeDueCursor,
      );
      if (due.length < dueLimit && this.runtimeDueCursor) {
        const wrapped = this.central.isolatedDueWakeCandidates(
          now,
          dueLimit - due.length,
        );
        due = [...due, ...wrapped];
      }
      for (const sessionId of due) {
        if (seen.has(sessionId)) continue;
        seen.add(sessionId);
        candidates.push(sessionId);
        this.runtimeDueCursor = sessionId;
      }
    }
    const appendFairCandidates = (afterSessionId = "") => {
      const remaining = candidateLimit - candidates.length;
      if (remaining <= 0) return;
      const fair = this.central.isolatedWakeCandidates(
        now,
        remaining + seen.size,
        afterSessionId,
      );
      for (const sessionId of fair) {
        if (seen.has(sessionId)) continue;
        seen.add(sessionId);
        candidates.push(sessionId);
        this.runtimeCursor = sessionId;
        if (candidates.length >= candidateLimit) break;
      }
    };
    appendFairCandidates(this.runtimeCursor);
    if (candidates.length < candidateLimit && this.runtimeCursor)
      appendFairCandidates();
    return candidates;
  }

  stats(): ReturnType<SessionKernelStoreApi["stats"]> {
    // Global stats are deliberately catalog-only. Opening every per-session
    // SQLite actor here used to monopolize the catalog lane and made health
    // requests time out. Aggregate actor metrics require a catalog projection;
    // they must never be reconstructed through online shard fanout.
    return this.central.stats();
  }

  migrateLegacySessions(limit = 1): number {
    if (this.centralPath === ":memory:") return 0;
    let migrated = 0;
    for (const sessionId of this.central.legacySessionIds(limit)) {
      const targetPath = sessionKernelSessionDbPath(
        sessionId,
        this.isolatedRoot,
      );
      if (this.central.migrateLegacySession(sessionId, targetPath))
        migrated += 1;
    }
    return migrated;
  }

  maintain(): boolean {
    // Fleet-wide maintenance belongs in catalog projections. Walking actor
    // placements or outbox routes here eventually opens the entire fleet even
    // when each individual turn is bounded.
    return this.central.maintain();
  }

  private openTranscript(sessionId: string): TranscriptStore {
    let store = this.transcripts.get(sessionId);
    if (store) {
      this.transcripts.delete(sessionId);
      this.transcripts.set(sessionId, store);
      return store;
    }
    this.laneMetrics.transcriptStoreCacheMisses += 1;
    while (this.transcripts.size >= this.maxOpenSessionStores) {
      const oldest = this.transcripts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.transcripts.get(oldest)?.close();
      this.transcripts.delete(oldest);
      this.laneMetrics.transcriptStoreCacheEvictions += 1;
    }
    if (this.centralPath === ":memory:")
      throw new Error(
        "Actor transcript storage requires an isolated file database",
      );
    store = new TranscriptStore(
      sessionKernelSessionDbPath(sessionId, this.isolatedRoot),
      { actorOwned: false },
    );
    this.transcripts.set(sessionId, store);
    return store;
  }

  private openIsolated(sessionId: string): SessionKernelStore {
    let store = this.isolated.get(sessionId);
    if (store) {
      // Refresh insertion order so the bounded cache passivates the least
      // recently used logical actor connection.
      this.isolated.delete(sessionId);
      this.isolated.set(sessionId, store);
      return store;
    }
    this.laneMetrics.kernelStoreCacheMisses += 1;
    while (this.isolated.size >= this.maxOpenSessionStores) {
      const oldestSessionId = this.isolated.keys().next().value as
        | string
        | undefined;
      if (!oldestSessionId) break;
      const oldest = this.isolated.get(oldestSessionId);
      this.isolated.delete(oldestSessionId);
      oldest?.close();
      this.laneMetrics.kernelStoreCacheEvictions += 1;
    }
    store = new SessionKernelStore(
      this.centralPath === ":memory:"
        ? ":memory:"
        : sessionKernelSessionDbPath(sessionId, this.isolatedRoot),
      {
        allocateOutboxId: (owner) => {
          try {
            return this.central.allocateIsolatedOutboxId(owner);
          } catch (error) {
            throw centralStoreFailure(error);
          }
        },
        // Gateway compatibility calls still wait synchronously. Keep a locked
        // session turn short, then quarantine it, rather than blocking the
        // gateway bridge or an actor lane for SQLite's central-store timeout.
        busyTimeoutMs: 250,
      },
    );
    this.isolated.set(sessionId, store);
    return store;
  }

  private containIsolated<T>(
    sessionId: string,
    commandKind: string,
    operation: () => T,
  ): { ok: true; value: T } | { ok: false } {
    try {
      return { ok: true, value: operation() };
    } catch (error) {
      if (
        isSessionKernelCentralStoreFailure(error) ||
        !isSessionKernelInfrastructureFailure(error)
      )
        throw error;
      this.centralOperation(() =>
        this.central.quarantineSession(
          sessionId,
          error instanceof Error ? error.message : String(error),
          commandKind,
        ),
      );
      return { ok: false };
    }
  }

  private invoke(
    store: SessionKernelStore,
    method: string,
    args: unknown[],
  ): unknown {
    const fn = (
      store as unknown as Record<string, (...values: unknown[]) => unknown>
    )[method];
    if (typeof fn !== "function")
      throw new Error(`Unknown store method ${method}`);
    return fn.apply(store, args);
  }

  private callGlobal(method: string, args: unknown[]): unknown {
    if (method === "actorTranscriptSessionIds")
      return this.central.actorTranscriptSessionIds(
        Number(args[0] ?? 100),
        String(args[1] ?? ""),
      );
    if (method === "askMigrationComplete")
      return this.central.askMigrationComplete();
    if (method === "markAskMigrationComplete")
      return this.central.markAskMigrationComplete();
    if (method === "deliveryMigrationComplete")
      return this.central.deliveryMigrationComplete();
    if (method === "markDeliveryMigrationComplete")
      return this.central.markDeliveryMigrationComplete();
    if (method === "askEntries") return this.allAskEntries();
    if (method === "deliveryEntries")
      return this.allDeliveryEntries(
        args[0] as Parameters<SessionKernelStoreApi["deliveryEntries"]>[0],
      );
    if (method === "quarantinedSessions")
      return this.allQuarantinedSessions(
        Number(args[0] ?? 100),
        Number(args[1] ?? 0),
      );
    if (method === "stats") return this.stats();
    if (method === "maintain") return this.maintain();
    if (method === "compact") {
      // Isolated stores are compacted incrementally by maintain(). A global
      // compact is intentionally limited to the catalog database.
      this.central.compact(
        args[0] as number | undefined,
        args[1] as number | undefined,
        args[2] as number | undefined,
      );
      return;
    }
    if (method === "clearAskRecords") {
      const sessionIds = this.central
        .isolatedAskProjectionEntries()
        .map(([sessionId]) => sessionId);
      this.central.clearAskRecords();
      for (const sessionId of sessionIds) {
        this.centralOperation(() =>
          this.central.markIsolatedSessionProjectionDirty(sessionId),
        );
        this.storeForSession(sessionId, true, true).clearAskRecords();
        this.refreshSessionProjections(sessionId);
      }
      return;
    }
    if (method === "clearDeliverySlot") {
      const slot = args[0] as Parameters<
        SessionKernelStoreApi["clearDeliverySlot"]
      >[0];
      const sessionIds = this.central
        .isolatedDeliveryProjectionEntries(slot)
        .map(([sessionId]) => sessionId);
      this.central.clearDeliverySlot(slot);
      for (const sessionId of sessionIds) {
        this.centralOperation(() =>
          this.central.markIsolatedSessionProjectionDirty(sessionId),
        );
        this.storeForSession(sessionId, true, true).clearDeliverySlot(slot);
        this.refreshSessionProjections(sessionId);
      }
      return;
    }
    if (method === "settlePendingSteers") {
      let settled = this.central.settlePendingSteers();
      const candidates =
        this.central.isolatedPendingSteerProjectionSessionIds();
      for (const sessionId of candidates) {
        this.centralOperation(() =>
          this.central.markIsolatedSessionProjectionDirty(sessionId),
        );
        const result = this.containIsolated(
          sessionId,
          "global:settle-pending-steers",
          () =>
            this.storeForSession(sessionId, true, true).settlePendingSteers(),
        );
        if (result.ok) {
          settled += result.value;
          this.refreshSessionProjections(sessionId);
        }
      }
      return settled;
    }
    if (method === "deadLetters") {
      const limit = Number(args[0] ?? 100);
      const offset = Number(args[1] ?? 0);
      const central = this.central.deadLetters(limit, offset);
      const allQuarantines = this.allQuarantinedSessions(
        Number.MAX_SAFE_INTEGER,
        0,
      );
      return {
        ...central,
        quarantines: allQuarantines.slice(offset, offset + limit),
        totals: {
          ...central.totals,
          quarantines: allQuarantines.length,
        },
        // Quarantines have an eager catalog projection. Isolated timer/outbox
        // dead letters do not yet, so this endpoint reports catalog-owned
        // effects instead of opening every actor database to synthesize them.
        coverage: {
          quarantines: "catalog_projection",
          timers: "catalog_only",
          outbox: "catalog_only",
        },
        nextOffset:
          Math.max(
            allQuarantines.length,
            central.totals.timers,
            central.totals.outbox,
          ) >
          offset + limit
            ? offset + limit
            : undefined,
      };
    }
    throw new Error(`Unsupported global store method ${method}`);
  }
}
