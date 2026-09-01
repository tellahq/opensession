/**
 * The short-TTL unified-session cache and the small helpers that read/write a
 * session's file through it. Everything that used to flip `sessionsCache = null`
 * in opensession.ts now calls invalidateSessionsCache().
 */

import { existsSync, readFileSync } from "fs";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import {
  engineSessionIdFor,
  getAllSessions,
  getAllSessionsAsync,
  readNativeSession,
  readNativeSessionListRow,
  readSlackSession,
  type SessionArchiveSlice,
} from "./sessions";
import {
  indexedSessions,
  upsertIndexedSession,
  upsertIndexedSessions,
} from "./session-list-store";
import { activeRunRecords } from "./run-journal";
import {
  getRunState,
  isRunStateUnsettled,
  transitionRunState,
  type RunState,
} from "./run-state";
import {
  isAgentEngineBusy,
  isAgentLiveEngineBusy,
  isAgentSessionBusy,
} from "./agent-runner";
import { audit } from "./audit";
import { getDefaultModel, SESSION_EFFORTS as MODEL_EFFORTS } from "./models";
import { writeJsonAtomic } from "./shared/atomic-write";
import type { UnifiedSession, NativeSessionFile } from "./types";
import {
  publicSessionSafety,
  reconcileAutomaticallyRecoverableSessionSafety,
} from "./session-safety";
import {
  sessionDeliveryProjection,
  sessionDeliveryProjectionCached,
  quarantineSessionForSafety,
  releaseSessionQuarantine,
  sessionGatewayCommand,
  sessionKernel,
  sessionKernelActorActive,
  sessionQuarantines,
  sessionRunStateProjections,
  sessionTurn,
} from "./session-kernel";
import { withSessionMutationLock } from "./session-mutation-lock";
import { broadcastToAll } from "./ws-hub";
import { hasSessionRunningHold } from "./session-state-events";

export const SESSIONS_DIR = OPENSESSION_SESSIONS_DIR;

const g = globalThis as any;

type SessionsCache = {
  data: UnifiedSession[];
  ts: number;
  /** A process-local write landed after this snapshot. Synchronous readers
   * still rebuild immediately; async request paths may serve it briefly while
   * one cooperative refresh catches up. */
  invalidated: boolean;
} | null;
const CACHE_SLICES = ["include", "exclude", "only"] as const;
const sessionsCaches: Record<SessionArchiveSlice, SessionsCache> = {
  include: null,
  exclude: null,
  only: null,
};
const sessionsRefreshes: Record<
  SessionArchiveSlice,
  Promise<UnifiedSession[]> | null
> = {
  include: null,
  exclude: null,
  only: null,
};
const sessionsCacheGenerations: Record<SessionArchiveSlice, number> = {
  include: 0,
  exclude: 0,
  only: 0,
};
// The UI refreshes on WebSocket invalidations, with a slow fallback poll. Keep
// the expensive multi-thousand-file fallback scan out of every refresh wave;
// in-process mutations invalidate this cache immediately.
const CACHE_TTL = 10_000;

/** Mark cached lists stale. Synchronous readers still re-read from disk on
 * their next access. Async request paths retain the last complete snapshot so
 * a routine session write cannot make unrelated HTTP requests wait for a scan
 * of every historical session. */
export function invalidateSessionsCache(): void {
  for (const slice of CACHE_SLICES) {
    sessionsCacheGenerations[slice]++;
    if (sessionsCaches[slice]) sessionsCaches[slice]!.invalidated = true;
  }
  // The list route caches its serialized response on top of this cache. Mark
  // those snapshots stale so ordinary slices rebuild on their next request;
  // the bounded live slice deliberately serves the stale body while it does
  // that scan, instead of blocking every sidebar poll on thousands of files.
  // Reached through globalThis because routes/sessions.ts imports this module.
  const responses = g.__osSessionsResponseSnapshots as
    | Map<string, { expiresAt: number }>
    | undefined;
  for (const snapshot of responses?.values() || []) snapshot.expiresAt = 0;
  // Publish only after every cache layer is stale, so a client reacting
  // immediately cannot race ahead of the invalidation it was told about.
  // Older and native clients safely ignore unknown server frames.
  broadcastToAll({ type: "sessions_invalidated" });
}

export interface SessionRuntimeSnapshot {
  runStarts: Map<string, string>;
  journalBusy: Set<string>;
  claimedJournalSessions: Set<string>;
}

/** Capture shared run-journal state once for a whole list projection. */
export function sessionRuntimeSnapshot(): SessionRuntimeSnapshot {
  // Earliest run-start per session id, from the run journal — feeds the "in
  // progress" elapsed ticker and survives a page refresh (a session can carry
  // its bks id and its engine session id across records; key on both).
  const runStarts = new Map<string, string>();
  const journalBusy = new Set<string>();
  const claimedJournalSessions = new Set<string>();
  for (const r of activeRunRecords()) {
    if (r.claimedAt && r.osSessionId) claimedJournalSessions.add(r.osSessionId);
    if (!r.startedAt) continue;
    for (const key of [r.osSessionId, r.claudeSessionId]) {
      if (!key) continue;
      journalBusy.add(key);
      const prev = runStarts.get(key);
      if (!prev || r.startedAt < prev) runStarts.set(key, r.startedAt);
    }
  }
  return { runStarts, journalBusy, claimedJournalSessions };
}

export function enrichSessionRuntime(
  data: UnifiedSession[],
  snapshot = sessionRuntimeSnapshot(),
): UnifiedSession[] {
  const { runStarts, journalBusy } = snapshot;
  // Full session lists must not make one compatibility RPC per historical
  // session. Take the actor client's mirrored projection once; missing rows are
  // idle. Small detail updates keep the targeted accessor to avoid copying the
  // whole projection for a single session.
  const runStateBySession =
    data.length > 32
      ? new Map(
          sessionRunStateProjections().map((state) => [state.sessionId, state]),
        )
      : undefined;
  // Sessions driven from the web UI run in-process; surface those too
  for (const s of data) {
    const rs = runStateBySession
      ? ((runStateBySession.get(s.id)?.state as RunState | undefined) ?? "idle")
      : getRunState(s.id);
    const engineBusy = isAgentEngineBusy(
      s.claudeSessionId,
      s.codexThreadId,
      s.id,
    );
    const liveEngineBusy = isAgentLiveEngineBusy(
      s.claudeSessionId,
      s.codexThreadId,
      s.id,
    );
    const recoveryBusy =
      journalBusy.has(s.id) ||
      (!!s.claudeSessionId && journalBusy.has(s.claudeSessionId)) ||
      (!!s.codexThreadId && journalBusy.has(s.codexThreadId));
    // Indexed rows are snapshots and may still carry `isRunning: true` from
    // an earlier write. Runtime state is authoritative in both directions:
    // promote a newly active run and demote a finished one so the sidebar can
    // leave In progress on its next poll.
    s.isRunning =
      engineBusy ||
      recoveryBusy ||
      isRunStateUnsettled(rs) ||
      hasSessionRunningHold(s.id);
    if (s.isRunning) {
      s.runStartedAt =
        runStarts.get(s.id) ||
        (s.claudeSessionId ? runStarts.get(s.claudeSessionId) : undefined) ||
        (s.codexThreadId ? runStarts.get(s.codexThreadId) : undefined);
    } else {
      delete s.runStartedAt;
    }
    if (rs !== "idle") s.runState = rs;
    checkRunStateWedge(s.id, rs, liveEngineBusy || recoveryBusy);
  }
  return data;
}

function enrichCachedSessions(
  slice: SessionArchiveSlice,
  data: UnifiedSession[],
): UnifiedSession[] {
  enrichSessionRuntime(data);
  const ts = Date.now();
  sessionsCaches[slice] = { data, ts, invalidated: false };
  // An internal/legacy whole-list scan already paid for both halves. Seed the
  // narrower caches when they are idle so the next UI poll does not rescan the
  // same files immediately after a background index refresh.
  if (slice === "include") {
    if (!sessionsRefreshes.exclude && !sessionsCaches.exclude)
      sessionsCaches.exclude = {
        data: data.filter((session) => !session.archived),
        ts,
        invalidated: false,
      };
    if (!sessionsRefreshes.only && !sessionsCaches.only)
      sessionsCaches.only = {
        data: data.filter((session) => !!session.archived),
        ts,
        invalidated: false,
      };
  }
  return data;
}

export function getCachedSessions(): UnifiedSession[] {
  const cached = sessionsCaches.include;
  // Targeted writes update the authoritative session file and SQLite list row
  // immediately. Rebuilding the entire materialized list after each one only
  // turns active-run bookkeeping into continuous 10,000-row deserialization.
  // Whole-list synchronous consumers may use the last complete snapshot for
  // this short TTL, matching the async path below; direct session reads remain
  // current.
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }
  const indexed = indexedSessions("include");
  if (indexed) return enrichCachedSessions("include", indexed);
  // Supersede any cooperative scan already in flight. Its generation check
  // prevents the older snapshot from replacing this synchronous result.
  sessionsCacheGenerations.include++;
  return enrichCachedSessions("include", getAllSessions());
}

/**
 * Return the same cache shape as getCachedSessions(), but let request traffic
 * through while thousands of session files are read.
 *
 * Once a complete snapshot exists, async request paths use stale-while-refresh:
 * expiry or process-local invalidation starts one cooperative scan, while the
 * caller immediately receives the last complete snapshot. This matters because
 * active runs update session files often, and making every unrelated route join
 * that refresh turned a background 10,000-file scan into multi-second TTFB.
 *
 * One call performs at most one cooperative scan. If a write lands mid-scan,
 * publish the completed snapshot when no synchronous reader already installed
 * a newer one. The direct native-session lookup keeps the open conversation
 * fresh, and the next poll repairs list-level staleness without monopolising
 * Bun's event loop.
 */
export async function getCachedSessionsAsync(
  slice: SessionArchiveSlice = "include",
): Promise<UnifiedSession[]> {
  const cached = sessionsCaches[slice];
  // Async callers may serve a complete snapshot through the short TTL even
  // after a targeted write. The SQLite row and detail endpoint are already
  // current; invalidation must not turn a burst of writes into a burst of
  // whole-list deserializations.
  const needsRefresh = !cached || Date.now() - cached.ts >= CACHE_TTL;
  if (cached && !needsRefresh) return cached.data;
  const indexed = indexedSessions(slice);
  if (indexed) return enrichCachedSessions(slice, indexed);

  if (!sessionsRefreshes[slice]) {
    const generation = ++sessionsCacheGenerations[slice];
    const startingCache = sessionsCaches[slice];
    sessionsRefreshes[slice] = getAllSessionsAsync(slice)
      .then((data) => {
        upsertIndexedSessions(data, slice);
        const current = sessionsCaches[slice];
        if (
          sessionsCacheGenerations[slice] === generation ||
          current === startingCache ||
          !current
        )
          return enrichCachedSessions(slice, data);
        return current.data;
      })
      .finally(() => {
        sessionsRefreshes[slice] = null;
      });
  }

  if (cached) {
    // Observe failures even though this request deliberately does not wait.
    void sessionsRefreshes[slice]!.catch((error) =>
      console.warn(
        `[session-cache] ${slice} background refresh failed:`,
        error instanceof Error ? error.message : error,
      ),
    );
    return cached.data;
  }
  return await sessionsRefreshes[slice];
}

/**
 * Read the durable list projection without attaching live runtime state.
 * Background maintenance that only needs session metadata must use this path:
 * enriching every historical row can otherwise monopolize the synchronous
 * actor compatibility bridge even though the maintenance task itself is async.
 */
export async function getSessionListSnapshotAsync(
  slice: SessionArchiveSlice = "include",
): Promise<UnifiedSession[]> {
  // Share the cache's cooperative fallback instead of starting an independent
  // full scan. This also persists coverage in the list projection, so boot
  // maintenance cannot rescan every historical session again 90 seconds later.
  return indexedSessions(slice) ?? getCachedSessionsAsync(slice);
}

/**
 * Return the last session snapshot without triggering a synchronous disk scan.
 * Hot-path autocomplete can safely omit optional session suggestions until the
 * normal sessions refresh repopulates this cache.
 */
export function peekCachedSessions(): UnifiedSession[] {
  if (sessionsCaches.include) return sessionsCaches.include.data;
  if (sessionsCaches.exclude && sessionsCaches.only)
    return [...sessionsCaches.exclude.data, ...sessionsCaches.only.data];
  return sessionsCaches.exclude?.data ?? sessionsCaches.only?.data ?? [];
}

// ── Run-state readers ─────────────────────────────────────────────────────────

/**
 * A run is SETTLED only when nothing more will happen without new input: the
 * state machine is at rest (idle/stopped/failed), the engine layer isn't busy
 * (covers rotation/fallback/auto-continue windows the FSM sees as a plain
 * turn_end→prompt gap), and no queued prompt is waiting to drain. This is the
 * "don't trust turn_end alone" rule: retries, reattaches, and queued
 * continuations all follow an apparent turn end.
 */
export function isRunSettled(sessionId: string): boolean {
  const session = findSession(sessionId);
  const id = session?.id || sessionId;
  if (isRunStateUnsettled(getRunState(id))) return false;
  if (
    isAgentSessionBusy(session?.claudeSessionId, session?.codexThreadId, id)
  ) {
    return false;
  }
  // Queue authority lives in the actor. Read its per-session delivery snapshot
  // directly rather than reaching through queue-state's former global map.
  if (sessionDeliveryProjectionCached(id).queued.length > 0) return false;
  return true;
}

// FSM-vs-engine wedge detector: the state machine says a run is in flight but
// the engine layer has been idle (or the inverse) for a sustained window.
// That divergence is exactly the zombie/orphan class — surface it as an audit
// event (grep run_state_wedge) instead of letting it hide until a human asks
// why a session is stuck. Piggybacks on the 2s session-cache refresh; one
// event per session per wedge episode.
const WEDGE_AFTER_MS = 3 * 60 * 1000;
const wedgeSince: Map<string, number> = (g.__runStateWedgeSince ??= new Map());
const wedgeReported: Set<string> = (g.__runStateWedgeReported ??= new Set());

export function runStateRequiresLiveOwner(state: RunState): boolean {
  return (
    state === "preparing" ||
    state === "starting" ||
    state === "running" ||
    state === "interrupted" ||
    state === "reattaching"
  );
}

function checkRunStateWedge(
  sessionId: string,
  state: RunState,
  ownerBusy: boolean,
): void {
  // ask_blocked is visibly waiting on a person. Other unsettled states must
  // have either a live engine or a claimed recovery journal; without one they
  // are not allowed to remain a green "running" projection indefinitely.
  const missingOwner = runStateRequiresLiveOwner(state) && !ownerBusy;
  // Keep auditing the inverse mismatch too. A live engine during a nominally
  // settled state can be a short fallback gap, so it is never auto-quarantined.
  const diverged = missingOwner || (!isRunStateUnsettled(state) && ownerBusy);
  if (!diverged) {
    wedgeSince.delete(sessionId);
    wedgeReported.delete(sessionId);
    return;
  }
  const since = wedgeSince.get(sessionId);
  if (!since) {
    wedgeSince.set(sessionId, Date.now());
    return;
  }
  if (Date.now() - since < WEDGE_AFTER_MS || wedgeReported.has(sessionId))
    return;
  wedgeReported.add(sessionId);
  console.warn(
    `[run-state] wedge: session ${sessionId} FSM=${state} ownerBusy=${ownerBusy} for ${Math.round((Date.now() - since) / 1000)}s`,
  );
  audit({
    msg: "run_state_wedge",
    session_id: sessionId,
    run_state: state,
    owner_busy: ownerBusy,
    diverged_for_ms: Date.now() - since,
  });
  if (!missingOwner) return;
  void quarantineSessionForSafety(
    sessionId,
    "The active run no longer has a live execution owner or recovery claim",
    `run_state:${state}`,
  )
    .then((quarantine) => {
      invalidateSessionsCache();
      broadcastToAll({
        type: "session_status",
        sessionId,
        isRunning: false,
        safety: publicSessionSafety(quarantine),
      });
    })
    .catch((error) => {
      // Let the next cache refresh retry rather than leaving the invisible wedge
      // permanently marked as handled after a transient actor outage.
      wedgeReported.delete(sessionId);
      console.error(
        `[run-state] could not pause orphaned session ${sessionId}:`,
        error,
      );
    });
}

type OwnershipWatchdogState = {
  timer?: ReturnType<typeof setTimeout>;
  safetyReconciliation?: Promise<string[]>;
};
const ownershipWatchdog: OwnershipWatchdogState =
  (g.__sessionOwnershipWatchdog ??= {});

export async function reconcileRecoverableSafetyFences(): Promise<string[]> {
  if (ownershipWatchdog.safetyReconciliation)
    return ownershipWatchdog.safetyReconciliation;
  const reconciliation = (async () => {
    const released = await reconcileAutomaticallyRecoverableSessionSafety(
      await sessionQuarantines(),
      releaseSessionQuarantine,
    );
    if (!released.length) return released;
    invalidateSessionsCache();
    for (const sessionId of released) {
      audit({
        msg: "session_safety_automatically_reconciled",
        session_id: sessionId,
      });
      broadcastToAll({
        type: "session_status",
        sessionId,
        isRunning: isAgentSessionBusy(sessionId),
      });
    }
    return released;
  })()
    .catch((error) => {
      console.error("[session-safety] automatic reconciliation failed:", error);
      return [];
    })
    .finally(() => {
      if (ownershipWatchdog.safetyReconciliation === reconciliation)
        ownershipWatchdog.safetyReconciliation = undefined;
    });
  ownershipWatchdog.safetyReconciliation = reconciliation;
  return reconciliation;
}

/** Independently enforce the visible-ownership invariant even when nobody has
 * the session list open. The scan reads the actor client's local projection
 * and process-local owner registries only; it never fans out to session files. */
export function startSessionOwnershipWatchdog(): void {
  if (ownershipWatchdog.timer) return;
  const tick = () => {
    void reconcileRecoverableSafetyFences();
    try {
      const recovery = sessionRuntimeSnapshot();
      for (const run of sessionRunStateProjections()) {
        const state = run.state as RunState;
        const ownerBusy =
          isAgentLiveEngineBusy(undefined, undefined, run.sessionId) ||
          recovery.journalBusy.has(run.sessionId);
        checkRunStateWedge(run.sessionId, state, ownerBusy);
      }
    } catch (error) {
      console.error("[run-state] ownership watchdog scan failed:", error);
    } finally {
      ownershipWatchdog.timer = setTimeout(tick, 30_000);
      ownershipWatchdog.timer.unref?.();
    }
  };
  // Reconcile proven actor-restart fences as soon as boot recovery establishes
  // ownership. The regular tick catches evidence that becomes sufficient later.
  reconcileRecoverableSafetyFences();
  ownershipWatchdog.timer = setTimeout(tick, 30_000);
  ownershipWatchdog.timer.unref?.();
}

export function stopSessionOwnershipWatchdog(): void {
  if (ownershipWatchdog.timer) clearTimeout(ownershipWatchdog.timer);
  ownershipWatchdog.timer = undefined;
}

export function findSession(sessionId: string): UnifiedSession | undefined {
  // Native ids map directly to the one session file we own. Detail and run
  // paths should not depend on a materialized list snapshot having observed a
  // newly created session, and they should never scan the list to open one.
  const direct = readNativeSession(sessionId) ?? readSlackSession(sessionId);
  if (direct) return enrichSessionRuntime([direct])[0];
  return getCachedSessions().find(
    (s) => s.id === sessionId || s.aliasIds?.includes(sessionId),
  );
}

export async function findSessionAsync(
  sessionId: string,
): Promise<UnifiedSession | undefined> {
  // Native ids and exact Slack deep links map one-to-one to files. Reading that
  // file lets a newly announced conversation open before the materialized list
  // projection has observed it. Historical aliases still need the merged list.
  const direct = readNativeSession(sessionId) ?? readSlackSession(sessionId);
  if (direct) return enrichSessionRuntime([direct])[0];
  return (await getCachedSessionsAsync()).find(
    (s) => s.id === sessionId || s.aliasIds?.includes(sessionId),
  );
}

/** Canonical id followed by every historical alias for this session. Asset
 * stores and other id-keyed sidecars use this to survive session deduping. */
export function sessionIdsFor(
  sessionId: string,
  sessions: UnifiedSession[] = getCachedSessions(),
): string[] {
  const session = sessions.find(
    (s) => s.id === sessionId || s.aliasIds?.includes(sessionId),
  );
  return session
    ? [...new Set([session.id, ...(session.aliasIds || [])])]
    : [sessionId];
}

/** Request-safe counterpart to sessionIdsFor. A canonical native id reads its
 * one owned file; aliases and external sessions use the cooperative cache scan.
 * Never make an HTTP or WebSocket handler rebuild every session synchronously
 * just to resolve one asset namespace. */
export async function sessionIdsForAsync(sessionId: string): Promise<string[]> {
  const session = await findSessionAsync(sessionId);
  return session
    ? [...new Set([session.id, ...(session.aliasIds || [])])]
    : [sessionId];
}

// ── Serialized session-file writes ────────────────────────────────────────────
// Every session-file writer goes through updateSessionFile: fresh read →
// field-scoped mutator → atomic write, serialized per session id by a
// promise-chain mutex (parked on globalThis so hot reloads keep in-flight
// chains). This replaces the blind full-object rebuilds that let concurrent
// writers clobber each other's fields (docs/transcripts.md §6).
// Each write bumps a `rev` counter on the file — readers ignore it; it exists
// so lost updates are observable.

/** Receives the fresh on-disk session file ({} as the type when the file
 *  doesn't exist yet — create-if-absent) and returns the object to write.
 *  Sites overlay ONLY the fields they own; unknown/foreign fields survive. */
export type SessionFileMutator = (data: NativeSessionFile) => NativeSessionFile;

export function updateSessionFile(
  sessionId: string,
  mutator: SessionFileMutator,
): Promise<void> {
  return withSessionMutationLock(sessionId, async () => {
    const requestId = `session-file:${crypto.randomUUID()}`;
    const plan = await sessionGatewayCommand({
      op: "request",
      sessionId,
      requestId,
      operation: "session_file_updated",
    });
    if (plan.status !== "execute")
      throw new Error("Unexpected duplicate session-file command");
    let physicalFinished = false;
    try {
      const path = `${SESSIONS_DIR}/${sessionId}.json`;
      const current: NativeSessionFile = existsSync(path)
        ? JSON.parse(readFileSync(path, "utf-8"))
        : ({} as NativeSessionFile);
      const next = mutator(current) ?? current;
      const rev = (current as { rev?: unknown }).rev;
      (next as { rev?: number }).rev = (typeof rev === "number" ? rev : 0) + 1;
      writeJsonAtomic(path, next);
      const indexed = readNativeSessionListRow(sessionId);
      if (indexed) {
        enrichSessionRuntime([indexed]);
        upsertIndexedSession(indexed);
      }
      invalidateSessionsCache();
      physicalFinished = true;
      await sessionGatewayCommand({
        op: "complete",
        sessionId,
        requestId,
        operation: "session_file_updated",
        result: null,
      });
    } catch (error) {
      if (!physicalFinished)
        await sessionGatewayCommand({
          op: "fail",
          sessionId,
          requestId,
          operation: "session_file_updated",
          error: error instanceof Error ? error.message : String(error),
          retryable: false,
        });
      throw error;
    }
  });
}

export function touchNativeSessionStrict(
  bksId: string,
  patch: Partial<NativeSessionFile>,
): Promise<void> {
  return updateSessionFile(bksId, (data) => ({
    ...data,
    ...patch,
    lastActivity: new Date().toISOString(),
  }));
}

function projectNativeRunErrorStrict(
  bksId: string,
  lastRunError: NativeSessionFile["lastRunError"],
): Promise<void> {
  return updateSessionFile(bksId, (data) => ({ ...data, lastRunError }));
}

export function touchNativeSession(
  bksId: string,
  patch: Partial<NativeSessionFile>,
): Promise<void> {
  return touchNativeSessionStrict(bksId, patch).catch((e) => {
    console.error(`Failed to update opensession session ${bksId}:`, e);
  });
}

/**
 * Persist an AUTOMATIC model switch (a usage-limit fallback hopping off an
 * exhausted model) without overwriting a human's explicit choice.
 *
 * A run that hops models writes the fallback into the session file when the
 * turn ends. Someone may have sent /model while that turn was in flight —
 * which used to be refused outright, blocking the moment people most want it
 * (a run that has just died on a usage limit, where the session still reads
 * busy because the interrupted run counts as active). That refusal was never
 * the real protection either: every surface sends /model as a prompt, so a
 * switch made a moment before the turn ended raced this write regardless.
 *
 * The write is conditional instead: it lands only while the stored model is
 * still the one the run last saw, so an explicit choice wins by construction
 * rather than by timing. The history entry is appended to the FRESH list for
 * the same reason — a run holds a copy taken at its start, and writing that
 * back silently dropped any entry recorded in between.
 *
 * Resolves to whether the write landed, so a fallback walk that hops twice in
 * one turn can keep its expectation in step.
 */
export function persistAutoModelSwitch(input: {
  sessionId: string;
  /** The stored model this run last saw; undefined when the session carries
   *  no explicit model (it is running the instance default). */
  expectedModel?: string;
  model: string;
  entry: NonNullable<NativeSessionFile["modelHistory"]>[number];
}): Promise<boolean> {
  let applied = false;
  return updateSessionFile(input.sessionId, (data) => {
    if ((data.model || undefined) !== (input.expectedModel || undefined)) {
      console.log(
        `[model] keeping "${data.model}" on ${input.sessionId}: chosen during the run, ` +
          `not reverting to the "${input.model}" fallback`,
      );
      return data;
    }
    applied = true;
    return {
      ...data,
      model: input.model,
      // Preserve the FIRST displaced selection across a multi-hop walk. A
      // null marker keeps an inherited default implicit rather than pinning
      // whichever concrete model happened to be the default today.
      autoFallbackModel:
        data.autoFallbackModel !== undefined
          ? data.autoFallbackModel
          : (data.model ?? null),
      modelHistory: [...(data.modelHistory || []), input.entry],
      lastActivity: new Date().toISOString(),
    };
  }).then(
    () => applied,
    (e) => {
      console.error(`Failed to persist model switch on ${input.sessionId}:`, e);
      return false;
    },
  );
}

export interface AutoFallbackRetry {
  fromModel?: string;
  model: string;
  by: string;
}

/**
 * Retry the selection displaced by the previous turn's automatic usage
 * fallback. The compare-and-swap includes both fields observed before the
 * serialized write, so a concurrent explicit /model always wins.
 */
export async function retryAutoFallbackModel(
  sessionId: string,
): Promise<AutoFallbackRetry | undefined> {
  const path = `${SESSIONS_DIR}/${sessionId}.json`;
  let observed: NativeSessionFile;
  try {
    if (!existsSync(path)) return undefined;
    observed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
  if (observed.autoFallbackModel === undefined) return undefined;

  let retry: AutoFallbackRetry | undefined;
  await updateSessionFile(sessionId, (data) => {
    if (
      data.model !== observed.model ||
      data.autoFallbackModel !== observed.autoFallbackModel
    )
      return data;

    const model = data.autoFallbackModel ?? getDefaultModel();
    const by = "auto-retry — checking the original selection again";
    retry = { fromModel: data.model, model, by };
    return {
      ...data,
      model: data.autoFallbackModel ?? undefined,
      autoFallbackModel: undefined,
      modelHistory: [
        ...(data.modelHistory || []),
        { model, from: data.model, at: new Date().toISOString(), by },
      ],
      lastActivity: new Date().toISOString(),
    };
  });
  return retry;
}

// Reasoning-effort values the composer/new-session pill can send. Model-specific
// support is exposed by /api/models and normalized by the runner before dispatch.
export const SESSION_EFFORTS = new Set<string>(MODEL_EFFORTS);

/** Persist a composer-sent effort change on a opensession session (no-op otherwise). */
export function maybePersistEffort(
  session: UnifiedSession | undefined,
  effort?: string,
): void {
  if (!session || session.source !== "opensession" || !effort) return;
  const e = effort.trim().toLowerCase();
  if (!SESSION_EFFORTS.has(e) || session.effort === e) return;
  touchNativeSession(session.id, { effort: e });
  session.effort = e; // keep the in-hand snapshot current for this turn
}

/** Persist a composer-sent OpenAI priority-tier change on a opensession session. */
export function maybePersistFastMode(
  session: UnifiedSession | undefined,
  fastMode?: boolean,
): void {
  if (
    !session ||
    session.source !== "opensession" ||
    typeof fastMode !== "boolean" ||
    session.fastMode === fastMode
  )
    return;
  touchNativeSession(session.id, { fastMode });
  session.fastMode = fastMode;
}

// Sessions whose LAST run died on a terminal failure (usage limits exhausted on
// every account, credit/API errors). Those need a human to act — the sidebar
// surfaces them as "Needs input" instead of letting them sink into the Backlog.
// Keyed by canonical session id; parked on globalThis for hot reloads.
// Open Session-owned sessions also persist the error on their session file (via
// recordRunOutcome) so the flag survives a real restart.
export const runErrors: Map<string, { message: string; at: string }> =
  (g.__runErrors ??= new Map());

/**
 * Write the terminal failure into the transcript as a system chip, so a
 * reloaded conversation explains itself instead of just stopping mid-turn.
 * Lives here because recordRunOutcome is the one choke point every failure
 * path already funnels through — the resumed-run (opensession.ts), opening-run
 * (ws-handlers/session-control-wiring) and setup-failure paths all recorded
 * `lastRunError` but wrote no transcript line, so for those the banner was the
 * only trace the run had died (bks-019fb757, 2026-07-31).
 *
 * `require` rather than a static import: pi-transcript lazily requires
 * this module back (its own cycle-breaker), and the transcript write must be
 * ordered so it lands before the client re-reads the transcript.
 * Never throws unless strict projection ownership requires fail-closed behavior.
 */
async function persistRunFailureNotice(
  sessionId: string,
  engineSessionId: string | null | undefined,
  message: string,
  label: string,
  projectionId?: string,
  projectedAt?: string,
  strict = false,
): Promise<void> {
  try {
    const m =
      require("./transcript-persistence") as typeof import("./transcript-persistence");
    const line = m.transcriptLineRunnerNotice(
      `${label}: ${message}`,
      projectionId,
      projectedAt,
    );
    if (strict)
      await m.applyForwardedTranscriptStrict(
        sessionId,
        engineSessionId || sessionId,
        [line],
      );
    else
      await m.applyForwardedTranscript(
        sessionId,
        engineSessionId || sessionId,
        [line],
      );
  } catch (error) {
    if (strict) throw error;
  }
}

/**
 * Record how a session's run ended: an error message when it died on a terminal
 * failure, or null for a clean finish (which clears any earlier failure). The
 * enriched /api/sessions list exposes this as `lastRunError`, and a failure also
 * lands in the transcript as a system chip.
 *
 * `opts.noticePersisted` skips that chip for callers whose runner already wrote
 * a friendlier line (timeouts); `opts.engineSessionId` overrides the session
 * file's id for a run that rotated to a fresh engine session mid-turn;
 * `opts.noticeLabel` re-words it for stops that were not errors.
 */
export type RunOutcomeProjectionOptions = {
  noticePersisted?: boolean;
  engineSessionId?: string;
  noticeLabel?: string;
  /** Immutable physical owner for a durable terminal projection. */
  runId?: string;
  runGeneration?: number;
  projectionId?: string;
  projectedAt?: string;
};

let runOutcomeProjectorForTest: typeof applyRunOutcomeProjection | undefined;

export function __setRunOutcomeProjectorForTest(
  projector: typeof applyRunOutcomeProjection | undefined,
): typeof applyRunOutcomeProjection | undefined {
  const previous = runOutcomeProjectorForTest;
  runOutcomeProjectorForTest = projector;
  return previous;
}

export async function recordRunOutcome(
  sessionId: string,
  errorMessage: string | null,
  opts?: RunOutcomeProjectionOptions,
): Promise<void> {
  const session = findSession(sessionId);
  const id = session?.id || sessionId;
  // runAgent settles every journal-owned run on its terminal event. Keep this
  // persistence choke point compatible with non-runner callers without
  // emitting a false double-teardown rejection for the normal path.
  if (isRunStateUnsettled(getRunState(id)))
    await transitionRunState(id, errorMessage ? "run_failed" : "turn_end", {
      ...(opts?.runId ? { run_key: opts.runId } : {}),
    });
  if (opts?.projectionId && opts.runId && sessionKernelActorActive()) {
    const runGeneration =
      opts.runGeneration ?? sessionKernel(id).runStateProjection().generation;
    await sessionTurn({
      op: "prepare_outcome_projection",
      sessionId: id,
      projectionId: opts.projectionId,
      runId: opts.runId,
      runGeneration,
      errorMessage: errorMessage?.slice(0, 500) ?? null,
      ...(opts.engineSessionId
        ? { engineSessionId: opts.engineSessionId }
        : {}),
      noticePersisted: opts.noticePersisted === true,
      ...(opts.noticeLabel ? { noticeLabel: opts.noticeLabel } : {}),
      projectedAt: opts.projectedAt || new Date().toISOString(),
    });
    return;
  }
  if (
    opts?.projectionId &&
    opts.runId &&
    process.env.NODE_ENV !== "test" &&
    !process.env.OPENSESSION_RUN_JOURNAL
  )
    throw new Error("Turn outcome projection requires the authoritative actor");
  await (runOutcomeProjectorForTest ?? applyRunOutcomeProjection)(
    id,
    errorMessage,
    opts,
  );
  // Setup and compatibility outcomes without a fenced run do not pass through
  // the durable turn-outcome executor. Push those specific sessions into the
  // same history timer without making indexing part of terminal persistence.
  if (process.env.NODE_ENV !== "test") {
    try {
      const { scheduleSessionHistoryIndex } = await import("./session-index");
      await scheduleSessionHistoryIndex(
        id,
        opts?.projectionId || `direct:${crypto.randomUUID()}`,
      );
    } catch (error) {
      console.warn(
        `[session-index] could not schedule ${id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/** Idempotent destination-side implementation for actor-issued projections. */
export async function applyRunOutcomeProjection(
  sessionId: string,
  errorMessage: string | null,
  opts?: RunOutcomeProjectionOptions,
  strict = false,
): Promise<void> {
  const session = findSession(sessionId);
  const id = session?.id || sessionId;
  const projectedAt = opts?.projectedAt || new Date().toISOString();
  if (errorMessage) {
    const entry = {
      message: errorMessage.slice(0, 500),
      at: projectedAt,
    };
    runErrors.set(id, entry);
    if (!opts?.noticePersisted) {
      const provider =
        session?.lastEngineProvider ||
        (session?.piSessionId
          ? "pi"
          : session?.codexThreadId
            ? "codex"
            : "claude");
      await persistRunFailureNotice(
        id,
        opts?.engineSessionId ||
          (session ? engineSessionIdFor(session, provider) : undefined),
        errorMessage,
        opts?.noticeLabel || "Run failed",
        opts?.projectionId,
        projectedAt,
        strict,
      );
    }
    if (session?.source === "opensession") {
      if (strict) await projectNativeRunErrorStrict(id, entry);
      else await touchNativeSession(id, { lastRunError: entry });
    }
    try {
      const handoff = await import("./handoff-evidence");
      const outcome = await handoff.notifyParentOfFailedRun(
        id,
        entry.message,
        undefined,
        opts?.projectionId,
      );
      if (strict && outcome === "failed")
        throw new Error("Worker failure notification projection failed");
    } catch (error) {
      if (strict) throw error;
    }
  } else {
    const had = runErrors.delete(id) || !!session?.lastRunError;
    if (had && session?.source === "opensession") {
      if (strict) await projectNativeRunErrorStrict(id, undefined);
      else await touchNativeSession(id, { lastRunError: undefined });
    }
  }
}
