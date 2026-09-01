/**
 * Crash/restart run journal — every in-flight run is recorded on disk;
 * entries that survive a process restart are interrupted runs, which
 * agent-runner.resumeInterruptedRuns resumes on boot. All engines journal
 * through these functions.
 */
import type { McpScope } from "./runner-shared";
import { existsSync, readFileSync } from "fs";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import {} from "./paths";
import { transitionRunState } from "./run-state";
import {
  sessionDelivery,
  sessionTurn,
  sessionTurnSnapshot,
} from "./session-kernel/kernel";
import { writeJsonAtomic } from "./shared/atomic-write";

// Overridable so a detached run host (src/runner-host/host.ts) journals to its
// own per-host file instead of read-modify-writing the shared journal from
// multiple processes concurrently.
let ACTIVE_RUNS_PATH =
  process.env.OPENSESSION_RUN_JOURNAL ||
  `${OPENSESSION_SESSIONS_DIR}/active-runs.json`;
let activeRunAliases = new Set<string>();
let activeRunAliasesInitialized = false;
let onJournalSet:
  | ((record: ActiveRunRecord) => void | Promise<void>)
  | undefined;

/** Register the in-process acknowledgement for a prompt intake record. Kept as
 * a callback so this low-level journal stays independent of queue state. */
export function setJournalSetListener(
  listener: ((record: ActiveRunRecord) => void | Promise<void>) | undefined,
): void {
  onJournalSet = listener;
}

function syncActiveRunAliases(journal: Record<string, ActiveRunRecord>): void {
  activeRunAliases = new Set(
    Object.values(journal).flatMap((run) =>
      [run.runKey, run.osSessionId, run.claudeSessionId].filter(
        (id): id is string => !!id,
      ),
    ),
  );
  activeRunAliasesInitialized = true;
}

/**
 * Test seam (bun tests only): repoint the journal file AFTER this module has
 * been evaluated — mirrors paths.ts's __setSessionsDirForTest. ES module
 * bindings are live, so callers that reach this module's functions through
 * ANOTHER already-cached module (e.g. agent-runner.ts's bare import of this
 * file) pick the new value up regardless of which file imported it first.
 * Returns the previous value so afterAll can restore it.
 */
export function __setActiveRunsPathForTest(path: string): string {
  const prev = ACTIVE_RUNS_PATH;
  ACTIVE_RUNS_PATH = path;
  activeRunAliases.clear();
  activeRunAliasesInitialized = false;
  return prev;
}

export interface ActiveRunRecord {
  runKey: string;
  osSessionId?: string;
  claudeSessionId?: string; // engine session id (name kept for on-disk compat)
  prompt?: string; // original prompt — lets a run interrupted before it got an engine session be re-run from scratch (safe: no session id ⇒ no model output ⇒ no side effects yet)
  promptEntryId?: string; // uuid of the prompt's user transcript line — a boot re-run reuses it so the store upserts instead of duplicating the bubble
  cwd: string;
  mode?: "ask" | "code" | "scratch";
  // Per-run MCP scope, preserved across resume. Optional for back-compat:
  // records journaled before McpScope omitted it to mean "all".
  mcpServers?: McpScope;
  user?: string; // per-run user, preserved across resume (gates per-user MCP servers)
  deniedTools?: Record<string, string>; // per-run tool denials, preserved across resume
  publicationPolicy?: { repo: string; branch: string; headBranch: string };
  confirmTools?: Record<string, string>; // per-run human-confirmed tools, preserved across resume
  aws?: boolean; // whether to inject AWS creds, preserved across resume
  claudeCliEnv?: boolean; // pool Claude-CLI credential in the run env (deepsec scans), preserved across resume
  codexCliEnv?: boolean; // codex-pool sibling (CODEX_HOME / OPENAI_API_KEY), preserved across resume
  model?: string; // effective model driving the journaled attempt
  selectedModel?: string; // user selection when model is a transient per-turn fallback
  transientFallback?: boolean; // model must not replace selectedModel in session state
  effort?: string; // reasoning effort, preserved across resume
  fastMode?: boolean; // OpenAI priority service tier, preserved across resume
  accountId?: string; // pinned provider account, preserved across resume
  accountStrict?: boolean; // hard pin: never rotate into the pool (automation cost cap)
  usageCredits?: boolean; // may run on accounts spending usage-credits past their limits
  fallbackModel?: string; // usage-limit fallback policy, preserved across resume
  /** PR reviewer to request (automation config), preserved across resume —
   *  unlike reposNote there is no rebuild callback for automation sessions, so
   *  an unjournaled value would be silently dropped by a restart. */
  prReviewer?: string;
  /** Legacy pool key retained while decoding old run records — lets resume-after-
   *  restart REATTACH to a detached server that survived (adoption via the
   *  pi-detach registry) instead of re-prompting a fresh one. */
  serverKey?: string;
  /** Eager sandbox launch checkpoint. Prepared means full spec durable but no launch admitted. */
  launchPhase?: "prepared" | "launching" | "started";
  /** Sandbox the run executes in (docs/self-hosting-sandboxes.md); absent = host process */
  sandboxId?: string;
  /** Persistent Runner that owns this run's remote workspace and run host. */
  runnerId?: string;
  /** Local detached run host driving this run (in-process engines: Pi).
   *  points at ~/.opensession-sessions/run-hosts/<hostId>, updated when a
   *  crashed host respawns under a fresh id. Lets resume-after-restart
   *  REATTACH to the live host (resumeLocalHostRun) instead of re-prompting.
   *  Never set together with sandboxId/runnerId. */
  hostId?: string;
  /** Provider owning sandboxId, so resume-after-restart can reattach via provider.get() */
  sandboxProvider?: string;
  /** Credential/network boundary for a sandbox run, preserved on relaunch. */
  trustProfile?: "interactive" | "automation";
  kind?: string;
  /** First time this logical run entered the journal. Unlike startedAt, this
   * survives fallback/recovery re-journals and makes real age enforceable. */
  firstJournaledAt?: string;
  /** Number of boot recovery attempts already started for this logical run. */
  resumeAttempts?: number;
  /** Time the most recent boot recovery attempt started. */
  lastResumeAt?: string;
  /** Durable abnormal completion observed before a backend produced a terminal
   * stream event. Opening recovery adopts this receipt instead of relaunching. */
  terminalFailure?: { type: "error"; content: string; at: string };
  startedAt: string;
  /** Stamped when a boot sweep hands the record to resumeInterruptedRuns. The
   *  record stays journaled until its resume outcome re-registers (journalSet)
   *  or clears it — a restart that kills the sweep mid-reattach leaves the
   *  claim behind, and the next boot re-takes it (claims from a dead process
   *  are void). Only ever set on the on-disk copy. */
  claimedAt?: string;
}

function readRunJournal(): Record<string, ActiveRunRecord> {
  try {
    const journal = existsSync(ACTIVE_RUNS_PATH)
      ? JSON.parse(readFileSync(ACTIVE_RUNS_PATH, "utf-8"))
      : {};
    syncActiveRunAliases(journal);
    return journal;
  } catch {
    syncActiveRunAliases({});
    return {};
  }
}

function writeRunJournal(journal: Record<string, ActiveRunRecord>): void {
  try {
    writeJsonAtomic(ACTIVE_RUNS_PATH, journal);
    syncActiveRunAliases(journal);
  } catch (e) {
    console.error("[runner] Failed to write run journal:", e);
  }
}

/**
 * The journal payload the engine runners write at their two journal points —
 * the pre-engine early write and the engine-id upgrade write. The fields every
 * site copies identically out of the runner's opts (RunAgentOpts) come from
 * `opts`; everything else — including the fields the sites deliberately
 * DIFFER on (fastMode and serverKey) stays a per-site decision in `site`.
 * Account ownership and reviewer policy are copied centrally because losing
 * any of them at the engine-id upgrade changes what a restarted run may do.
 * Stamps startedAt.
 */
export function buildRunJournalRecord(
  opts: {
    deniedTools?: Record<string, string>;
    publicationPolicy?: { repo: string; branch: string; headBranch: string };
    aws?: boolean;
    claudeCliEnv?: boolean;
    codexCliEnv?: boolean;
    selectedModel?: string;
    transientFallback?: boolean;
    fallbackModel?: string;
    accountId?: string;
    accountStrict?: boolean;
    usageCredits?: boolean;
    prReviewer?: string;
    journal?: {
      firstJournaledAt?: string;
      resumeAttempts?: number;
      lastResumeAt?: string;
    };
  },
  site: Omit<
    ActiveRunRecord,
    | "startedAt"
    | "claimedAt"
    | "firstJournaledAt"
    | "resumeAttempts"
    | "lastResumeAt"
    | "deniedTools"
    | "publicationPolicy"
    | "aws"
    | "claudeCliEnv"
    | "codexCliEnv"
    | "selectedModel"
    | "transientFallback"
    | "fallbackModel"
  >,
): ActiveRunRecord {
  const startedAt = new Date().toISOString();
  return {
    ...site,
    accountId: site.accountId ?? opts.accountId,
    accountStrict: site.accountStrict ?? opts.accountStrict,
    usageCredits: site.usageCredits ?? opts.usageCredits,
    prReviewer: site.prReviewer ?? opts.prReviewer,
    deniedTools: opts.deniedTools,
    publicationPolicy: opts.publicationPolicy,
    aws: !!opts.aws,
    claudeCliEnv: opts.claudeCliEnv || undefined,
    codexCliEnv: opts.codexCliEnv || undefined,
    selectedModel: opts.selectedModel,
    transientFallback: opts.transientFallback,
    fallbackModel: opts.fallbackModel,
    // Leave a fresh lineage unset here: journalSet fills it from an existing
    // record with the same runKey, or from startedAt for a genuinely new run.
    firstJournaledAt: opts.journal?.firstJournaledAt,
    resumeAttempts: opts.journal?.resumeAttempts,
    lastResumeAt: opts.journal?.lastResumeAt,
    startedAt,
  };
}

type JournalRunStateTransition = (
  sessionId: string,
  event: Parameters<typeof transitionRunState>[1],
  meta?: Parameters<typeof transitionRunState>[2],
) => Promise<unknown>;

export async function journalSet(
  record: ActiveRunRecord,
  transition: JournalRunStateTransition = transitionRunState,
): Promise<void> {
  const journal = readRunJournal();
  const prior = journal[record.runKey];
  const rejournal = !!prior;
  journal[record.runKey] = {
    ...record,
    firstJournaledAt:
      prior?.firstJournaledAt ||
      record.firstJournaledAt ||
      prior?.startedAt ||
      record.startedAt,
    // An existing record is the live source of recovery health. A fallback
    // may re-journal stale opts captured before model output reset the
    // consecutive-failure fuse; it must not resurrect the old attempt count.
    resumeAttempts: prior ? prior.resumeAttempts : record.resumeAttempts,
    lastResumeAt: prior ? prior.lastResumeAt : record.lastResumeAt,
  };
  writeRunJournal(journal);
  try {
    await onJournalSet?.(journal[record.runKey] || record);
  } catch (e) {
    console.error("[runner] Failed to acknowledge prompt dispatch:", e);
  }
  // A fallback hop re-journals the same runKey mid-run — that's the running
  // self-edge, not a new registration, so keep the event but tag it.
  if (record.osSessionId)
    await transition(record.osSessionId, "run_registered", {
      run_key: record.runKey,
      kind: record.kind,
      rejournal: rejournal || undefined,
    });
}

export type RunQuarantineReason =
  | "duplicate_session"
  | "recursive_recovery_kind"
  | "resume_attempts_exhausted"
  | "recovery_expired"
  | "ambiguous_runner_launch";

export interface QuarantinedRun {
  run: ActiveRunRecord;
  reason: RunQuarantineReason;
  notify: boolean;
}

/** Move rejected recovery records out of the live journal in one atomic pair
 * of writes. They remain inspectable beside active-runs.json instead of being
 * silently deleted; `notify` is consumed by agent-runner to settle the owning
 * session visibly when no newer duplicate will continue it. */
export function journalQuarantine(entries: QuarantinedRun[]): void {
  if (!entries.length) return;
  const journal = readRunJournal();
  const quarantinePath =
    ACTIVE_RUNS_PATH.replace(/\.json$/, "") + ".quarantine.json";
  let quarantine: Record<
    string,
    ActiveRunRecord & {
      quarantinedAt: string;
      quarantineReason: RunQuarantineReason;
    }
  > = {};
  try {
    if (existsSync(quarantinePath)) {
      quarantine = JSON.parse(readFileSync(quarantinePath, "utf-8"));
    }
  } catch {}
  const quarantinedAt = new Date().toISOString();
  let changed = false;
  for (const [index, entry] of entries.entries()) {
    if (journal[entry.run.runKey]) {
      delete journal[entry.run.runKey];
      changed = true;
    }
    quarantine[`${quarantinedAt}:${index}:${entry.run.runKey}`] = {
      ...entry.run,
      quarantinedAt,
      quarantineReason: entry.reason,
    };
  }
  if (!changed) return;
  writeJsonAtomic(quarantinePath, quarantine);
  writeRunJournal(journal);
}

/** Persist the recovery lineage immediately before a queued recovery task
 * actually starts. A process death after this point consumes one attempt; a
 * death while the task was merely waiting in the concurrency queue does not. */
export function journalStartRecovery(record: ActiveRunRecord): ActiveRunRecord {
  const journal = readRunJournal();
  const current = journal[record.runKey] || record;
  const now = new Date().toISOString();
  const prepared: ActiveRunRecord = {
    ...current,
    ...record,
    firstJournaledAt:
      record.firstJournaledAt ||
      current.firstJournaledAt ||
      current.startedAt ||
      record.startedAt,
    resumeAttempts:
      Math.max(record.resumeAttempts ?? 0, current.resumeAttempts ?? 0) + 1,
    lastResumeAt: now,
    claimedAt: current.claimedAt,
  };
  journal[record.runKey] = prepared;
  writeRunJournal(journal);
  const { claimedAt: _claimed, ...returned } = prepared;
  return returned;
}

/** A recovered turn was successfully reattached or produced new model work.
 * Reboots while the turn keeps running should not exhaust the recovery-attempt
 * fuse: that fuse is for consecutive failed recoveries, not healthy resumptions
 * of the same turn. */
export function journalMarkRecoveryAttached(
  record: ActiveRunRecord,
): ActiveRunRecord | undefined {
  const journal = readRunJournal();
  const current = journal[record.runKey];
  if (!current) return undefined;
  const expectedLineage = record.firstJournaledAt || record.startedAt;
  const currentLineage = current.firstJournaledAt || current.startedAt;
  if (
    expectedLineage !== currentLineage ||
    current.osSessionId !== record.osSessionId
  ) {
    return undefined;
  }
  const attached: ActiveRunRecord = {
    ...current,
    resumeAttempts: 0,
    lastResumeAt: undefined,
  };
  journal[record.runKey] = attached;
  writeRunJournal(journal);
  const { claimedAt: _claimed, ...returned } = attached;
  return returned;
}

export async function journalRecordAbnormalCompletion(
  record: ActiveRunRecord,
  content = "Physical run ended without a terminal event",
): Promise<ActiveRunRecord> {
  const failed: ActiveRunRecord = {
    ...record,
    terminalFailure: {
      type: "error",
      content,
      at: new Date().toISOString(),
    },
  };
  await journalSet(failed);
  await journalRetireSettledCancelAbnormal(failed.osSessionId, failed.runKey);
  return failed;
}

/** Retire an exact abnormal-completion owner only after its actor cancel has
 * settled. Called from both sides of the race: source completion and actor
 * settlement. Private detached-host journals never consult gateway actor state. */
function retireCancelAbnormalEvidence(
  sessionId: string | undefined,
  runKey: string,
): boolean {
  if (process.env.OPENSESSION_RUN_JOURNAL || !sessionId) return false;
  const current = readRunJournal()[runKey];
  if (!current?.terminalFailure || current.osSessionId !== sessionId)
    return false;
  return journalClearIfLineage(current);
}

/** Source-side race participant: actor uncertainty retains evidence because
 * the durable effect will perform the authoritative settlement-side check. */
export async function journalRetireSettledCancelAbnormal(
  sessionId: string | undefined,
  runKey: string,
): Promise<boolean> {
  if (process.env.OPENSESSION_RUN_JOURNAL || !sessionId) return false;
  try {
    const cancel = (await sessionTurnSnapshot(sessionId)).cancel;
    if (cancel?.runId === runKey && cancel.phase === "settled")
      return retireCancelAbnormalEvidence(sessionId, runKey);
  } catch {
    // The independent interrupt owner may still positively prove settlement.
  }
  try {
    const delivery = await sessionDelivery({ op: "snapshot", sessionId });
    const dispatchedInterrupt = (
      delivery.dispatch as { interrupt?: typeof delivery.interrupt } | undefined
    )?.interrupt;
    const interrupt = delivery.interrupt || dispatchedInterrupt;
    if (interrupt?.dispatchId === runKey && interrupt.phase === "confirmed")
      return retireCancelAbnormalEvidence(sessionId, runKey);
  } catch {
    // Neither independent actor domain proved settlement; retain evidence.
  }
  return false;
}

/** Settlement-side race participant. The caller has just committed settlement
 * or read an authoritative `settled` decision, so no second actor snapshot may
 * turn a successful durable effect into an acknowledged cleanup gap. */
export function journalRetireCancelledAbnormalAfterSettlement(
  sessionId: string,
  runKey: string,
): boolean {
  return retireCancelAbnormalEvidence(sessionId, runKey);
}

export function journalClear(runKey: string): void {
  const journal = readRunJournal();
  if (runKey in journal) {
    delete journal[runKey];
    writeRunJournal(journal);
  }
}

/** Clear only the journal entry that still belongs to this recovery lineage.
 * A replacement human turn may reuse the engine session id as its runKey; an
 * old queued recovery must never delete that newer record when it wakes. */
export function journalClearIfLineage(record: ActiveRunRecord): boolean {
  const journal = readRunJournal();
  const current = journal[record.runKey];
  if (!current) return false;
  const expectedLineage = record.firstJournaledAt || record.startedAt;
  const currentLineage = current.firstJournaledAt || current.startedAt;
  if (
    expectedLineage !== currentLineage ||
    current.osSessionId !== record.osSessionId
  ) {
    return false;
  }
  delete journal[record.runKey];
  writeRunJournal(journal);
  return true;
}

/** Snapshot of the runs currently journaled as in-flight (does not clear). */
export function activeRunRecords(): ActiveRunRecord[] {
  return Object.values(readRunJournal());
}

/** Hot-path journal ownership check. Writes and normal journal snapshots keep
 * this alias set current; the first call after process start hydrates it once. */
export function hasActiveRunFor(
  ...ids: Array<string | null | undefined>
): boolean {
  if (!activeRunAliasesInitialized) readRunJournal();
  return ids.some((id) => !!id && activeRunAliases.has(id));
}

// Engines register a probe so takeInterruptedRuns can tell "journaled but
// still actively driven by THIS process" (a hot reload re-runs boot-ish code
// while old runs keep executing off their old closures) apart from genuinely
// interrupted runs. Parked on globalThis so a reload keeps live probes.
const activeRunProbes: Set<(runKey: string) => boolean> = ((
  globalThis as any
).__runJournalActiveProbes ??= new Set());

export function registerActiveRunProbe(
  probe: (runKey: string) => boolean,
): void {
  activeRunProbes.add(probe);
}

function isRunActiveInProcess(runKey: string): boolean {
  for (const probe of activeRunProbes) {
    try {
      if (probe(runKey)) return true;
    } catch {}
  }
  return false;
}

// runKeys this process's sweep already handed out, so a second call can't
// double-resume them. On-disk claims deliberately do NOT block a take — they
// exist so a DIFFERENT (next) process re-finds runs whose sweep died
// mid-reattach; only the process that took them must not take them twice.
const takenRunKeys: Set<string> = ((globalThis as any).__runJournalTakenKeys ??=
  new Set());

/**
 * Hand interrupted runs left by a previous process to the boot sweep. Records
 * are CLAIMED (stamped claimedAt), not cleared: until the resume outcome
 * re-registers the run (journalSet, same runKey) or clears it (journalClear),
 * the record survives on disk, so a restart that kills the sweep mid-reattach
 * (2026-07-27 13:47:45: SIGTERM 18s after boot, 7 taken runs evaporated with
 * the old wipe-on-take) hands the same runs to the next boot instead of
 * losing them. Returned records have claimedAt stripped so a reattach's
 * re-record doesn't persist a stale claim.
 */
export async function takeInterruptedRuns(
  seedRecords: ActiveRunRecord[] = [],
  shouldTake: (record: ActiveRunRecord) => boolean | Promise<boolean> = () =>
    true,
  transition: JournalRunStateTransition = transitionRunState,
): Promise<ActiveRunRecord[]> {
  const journal = readRunJournal();
  // A graceful-shutdown snapshot can retain a detached local host after its
  // shared record disappeared during process teardown. Fold those records
  // into the same atomic boot claim without journalSet(): journalSet denotes a
  // NEW live registration and would incorrectly move recovery state to
  // `running` before boot_journal_found has a chance to claim it.
  for (const record of seedRecords) {
    if (journal[record.runKey]) continue;
    journal[record.runKey] = {
      ...record,
      firstJournaledAt: record.firstJournaledAt || record.startedAt,
    };
  }
  const entries: ActiveRunRecord[] = [];
  for (const record of Object.values(journal)) {
    if (
      !isRunActiveInProcess(record.runKey) &&
      !takenRunKeys.has(record.runKey) &&
      (await shouldTake(record))
    )
      entries.push(record);
  }
  if (entries.length > 0) {
    const now = new Date().toISOString();
    for (const r of entries) {
      takenRunKeys.add(r.runKey);
      journal[r.runKey] = { ...r, claimedAt: now };
    }
    writeRunJournal(journal);
  }
  for (const r of entries) {
    if (r.osSessionId)
      await transition(r.osSessionId, "boot_journal_found", {
        run_key: r.runKey,
        kind: r.kind,
      });
  }
  return entries.map(({ claimedAt: _claimed, ...r }) => r);
}
