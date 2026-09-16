import {
  samePersonalRepoBinding,
  type PersonalRepoBinding,
} from "./personal-repo-runtime";
import {
  personalRunConsumerKey,
  snapshotPersonalRunConsumer,
  type PersonalRunConsumer,
} from "./personal-run-consumers";
import {
  personalRepositoryId,
  validatePersonalRepositoryDescriptor,
} from "./personal-repository-coordinator";
import {
  ensurePersonalRunJournalReady,
  hasPersonalRunFor,
  mutatePersonalRunRecord,
  personalRunJournalApplicable,
  personalRunJournalConsumer,
  personalRunKeyHeld,
  personalRunRecord,
  personalRunRecordSuppressed,
  personalRunRecords,
  quarantinePersonalRunRecords,
  retirePersonalRunConsumer,
  sameJournalLineage,
} from "./personal-run-journal";
/**
 * Crash/restart run journal — every in-flight run is recorded on disk;
 * entries that survive a process restart are interrupted runs, which
 * agent-runner.resumeInterruptedRuns resumes on boot. All engines journal
 * through these functions.
 *
 * Two stores sit behind one API. Shared runs (and every run on a detached
 * host with its own OPENSESSION_RUN_JOURNAL) use the legacy JSON file under
 * its synchronous sole writer. Runs bound to a personal repository on the
 * gateway are worker-owned catalog documents (personal-run-journal.ts): they
 * never enter the shared file, and the synchronous legacy helpers refuse them
 * so a private owner can only change through an awaited compare-and-set.
 */
import type { McpScope } from "./runner-shared";
import { existsSync, readFileSync } from "fs";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { transitionRunState } from "./run-state";
import {
  sessionDelivery,
  sessionTurn,
  sessionTurnSnapshot,
} from "./session-kernel/kernel";
import { writeJsonAtomic } from "./shared/atomic-write";

export {
  ensurePersonalRunJournalReady,
  personalRunJournalReady,
} from "./personal-run-journal";

// Overridable so a detached run host (src/runner-host/host.ts) journals to its
// own per-host file instead of read-modify-writing the shared journal from
// multiple processes concurrently.
let ACTIVE_RUNS_PATH =
  process.env.OPENSESSION_RUN_JOURNAL ||
  `${OPENSESSION_SESSIONS_DIR}/active-runs.json`;
let activeRunAliases = new Set<string>();
let activeRunAliasesInitialized = false;
let activeRunAliasesVersion = -1;

// Shared by hot-reloaded copies of the sole legacy journal writer. Async boot
// claims merge against this latest snapshot, never a pre-await copy.
interface JournalProjection {
  latest: Record<string, ActiveRunRecord>;
  hydrated: boolean;
  version: number;
}
const journalGlobal = globalThis as typeof globalThis & {
  __personalRunJournalProjections?: Map<string, JournalProjection>;
  __sharedJournalPrivateRowsReported?: boolean;
};
function journalProjection(): JournalProjection {
  const projections = (journalGlobal.__personalRunJournalProjections ??=
    new Map());
  let current = projections.get(ACTIVE_RUNS_PATH);
  if (!current) {
    current = { latest: {}, hydrated: false, version: 0 };
    projections.set(ACTIVE_RUNS_PATH, current);
  }
  return current;
}

/** A private run journaled by the gateway itself. A detached host's own
 * per-host file keeps private records as ordinary legacy rows. */
function isPrivateGatewayRecord(record: ActiveRunRecord): boolean {
  return !!record.personalRepo && personalRunJournalApplicable();
}

/** Whether a private row, readable or not, holds this run key on the gateway.
 * An unreadable row is unknown busy evidence: it blocks the shared helpers
 * exactly like a live owner would. */
function privateOwnerHolds(runKey: string): boolean {
  return personalRunJournalApplicable() && personalRunKeyHeld(runKey);
}

function requireAsyncPrivateJournal(operation: string): never {
  throw new Error(
    `Personal journal ${operation} requires the asynchronous private journal`,
  );
}

function snapshotJournalBinding(
  binding: PersonalRepoBinding,
): PersonalRepoBinding {
  const descriptor = validatePersonalRepositoryDescriptor(binding.descriptor);
  if (binding.registryId !== personalRepositoryId(descriptor))
    throw new Error("Personal journal binding changed");
  return Object.freeze({ registryId: binding.registryId, descriptor });
}

/** Suppress only positively completed, durably retired exact ownership. The
 * confirmed consumer's own row is tombstoned; a successor host or a changed
 * binding under the same run alias is untouched. Intent alone blocks
 * relaunch but must retain busy/cleanup evidence. */
export async function suppressRetiredPersonalRun(
  consumer: PersonalRunConsumer,
): Promise<void> {
  if (!personalRunJournalApplicable())
    throw new Error("Private run journal is unavailable on a detached host");
  const original = snapshotPersonalRunConsumer(consumer);
  const key = personalRunConsumerKey(original);
  const { personalRunRetirementConfirmed } =
    await import("./personal-run-consumers");
  if (!(await personalRunRetirementConfirmed(original)))
    throw new Error("Personal run retirement completion unconfirmed");
  await retirePersonalRunConsumer(key);
}

/** Unknown authority rejects. A durable no-relaunch intent is sufficient to
 * deny execution, but only completed retirement removes cached busy evidence. */
export async function journalPersonalRunRetired(
  record: ActiveRunRecord,
): Promise<boolean> {
  if (!record.personalRepo) return false;
  const consumer = personalRunJournalConsumer(record);
  const authority = await import("./personal-run-consumers");
  if (!(await authority.personalRunRetired(consumer))) return false;
  if (
    personalRunJournalApplicable() &&
    (await authority.personalRunRetirementConfirmed(consumer))
  )
    await retirePersonalRunConsumer(personalRunConsumerKey(consumer));
  return true;
}

/** Call again at the execution boundary, not just while discovering candidates.
 * Shared records go through the legacy sole writer; private gateway records
 * are re-checked against the committed catalog row inside the compare-and-set. */
export async function journalStartRecoveryIfCurrent(
  record: ActiveRunRecord,
): Promise<ActiveRunRecord | undefined> {
  const original = structuredClone(record);
  if (await journalPersonalRunRetired(original)) return undefined;
  if (!isPrivateGatewayRecord(original)) return startRecovery(original);
  const prepared = await mutatePersonalRunRecord(
    original.runKey,
    (existing) => {
      if (
        !existing ||
        personalRunRecordSuppressed(existing) ||
        !sameJournalLineage(existing, original)
      )
        throw new Error("Personal recovery journal ownership changed");
      return prepareRecovery(existing, original);
    },
  );
  if (!prepared) throw new Error("Personal recovery journal ownership changed");
  return stripClaim(prepared);
}
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

function syncActiveRunAliases(
  journal: Record<string, ActiveRunRecord>,
  observed = true,
): void {
  const current = journalProjection();
  if (observed) current.hydrated = true;
  current.latest = structuredClone(journal);
  current.version++;
  refreshActiveRunAliases(current);
}

function refreshActiveRunAliases(current: JournalProjection): void {
  activeRunAliasesVersion = current.version;
  activeRunAliases = new Set(
    Object.values(current.latest).flatMap((run) =>
      [run.runKey, run.osSessionId, run.claudeSessionId].filter(
        (id): id is string => !!id,
      ),
    ),
  );
  activeRunAliasesInitialized = current.hydrated;
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
  personalRepo?: PersonalRepoBinding;
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
  /** Person whose personal provider subscription may serve the run when it
   *  differs from `user` (a human turn in an automation-owned session).
   *  Preserved across resume so recovery does not fall back to pool-only;
   *  read by provider account selection only, never by MCP or GitHub policy. */
  accountUser?: string;
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
  pstackMode?: boolean; // pstack skill family visible to the model, preserved across resume
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
   *  are void). Only ever set on the stored copy. */
  claimedAt?: string;
}

/** The shared file never carries a private gateway record. One that appears
 * there (a foreign process, a hand edit) is not evidence this journal can
 * act on: it is dropped from every read and pruned by the next write. */
function withoutPrivateGatewayRecords(
  journal: Record<string, ActiveRunRecord>,
): Record<string, ActiveRunRecord> {
  if (!personalRunJournalApplicable()) return journal;
  let dropped = 0;
  const kept: Record<string, ActiveRunRecord> = {};
  for (const [runKey, record] of Object.entries(journal)) {
    if (record?.personalRepo) dropped++;
    else kept[runKey] = record;
  }
  if (dropped && !journalGlobal.__sharedJournalPrivateRowsReported) {
    journalGlobal.__sharedJournalPrivateRowsReported = true;
    console.error(
      `[runner] Ignoring ${dropped} private run record(s) in the shared run journal; private runs are journaled in the session kernel catalog`,
    );
  }
  return kept;
}

function readRunJournal(): Record<string, ActiveRunRecord> {
  try {
    const journal = withoutPrivateGatewayRecords(
      existsSync(ACTIVE_RUNS_PATH)
        ? JSON.parse(readFileSync(ACTIVE_RUNS_PATH, "utf-8"))
        : {},
    );
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
    personalRepo?: PersonalRepoBinding;
    deniedTools?: Record<string, string>;
    publicationPolicy?: { repo: string; branch: string; headBranch: string };
    aws?: boolean;
    claudeCliEnv?: boolean;
    codexCliEnv?: boolean;
    selectedModel?: string;
    transientFallback?: boolean;
    fallbackModel?: string;
    accountUser?: string;
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
  if (
    opts.personalRepo &&
    site.personalRepo &&
    !samePersonalRepoBinding(opts.personalRepo, site.personalRepo)
  )
    throw new Error("Personal journal binding changed");
  const startedAt = new Date().toISOString();
  return {
    ...site,
    personalRepo: opts.personalRepo
      ? snapshotJournalBinding(opts.personalRepo)
      : site.personalRepo
        ? snapshotJournalBinding(site.personalRepo)
        : undefined,
    accountUser: site.accountUser ?? opts.accountUser,
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

/** Merge a (re)registration onto the record it replaces. An existing record
 * is the live source of recovery health: a fallback may re-journal stale opts
 * captured before model output reset the consecutive-failure fuse, and must
 * not resurrect the old attempt count. */
function mergeRegistration(
  prior: ActiveRunRecord | undefined,
  record: ActiveRunRecord,
): ActiveRunRecord {
  return {
    ...record,
    firstJournaledAt:
      prior?.firstJournaledAt ||
      record.firstJournaledAt ||
      prior?.startedAt ||
      record.startedAt,
    resumeAttempts: prior ? prior.resumeAttempts : record.resumeAttempts,
    lastResumeAt: prior ? prior.lastResumeAt : record.lastResumeAt,
  };
}

function setSharedRecord(record: ActiveRunRecord): {
  committed: ActiveRunRecord;
  rejournal: boolean;
} {
  const journal = readRunJournal();
  // A private owner under this key cannot be downgraded by a shared record.
  if (privateOwnerHolds(record.runKey))
    throw new Error("Personal journal binding changed");
  const prior = journal[record.runKey];
  if (
    prior?.personalRepo &&
    (!record.personalRepo ||
      !samePersonalRepoBinding(prior.personalRepo, record.personalRepo))
  )
    throw new Error("Personal journal binding changed");
  const committed = mergeRegistration(prior, record);
  journal[record.runKey] = committed;
  writeRunJournal(journal);
  return { committed, rejournal: !!prior };
}

export interface JournalSetOptions {
  /** The exact physical consumer (host, session, binding) this registration
   * replaces: a predecessor under the same run alias, typically the source
   * host a successor checkpoints away from. Without it a private registration
   * may only create the row or update its own consumer's row; a row held by
   * any other physical consumer rejects, so a predecessor's late registration
   * can never roll a committed successor back, however late it arrives. */
  replaces?: PersonalRunConsumer;
}

function consumerKeyOrUndefined(record: ActiveRunRecord): string | undefined {
  try {
    return personalRunConsumerKey(personalRunJournalConsumer(record));
  } catch {
    return undefined;
  }
}

async function setPrivateRecord(
  record: ActiveRunRecord,
  replaces: PersonalRunConsumer | undefined,
): Promise<{
  committed: ActiveRunRecord;
  rejournal: boolean;
}> {
  await ensurePersonalRunJournalReady();
  const admitted: ActiveRunRecord = {
    ...structuredClone(record),
    personalRepo: snapshotJournalBinding(record.personalRepo!),
  };
  const own = personalRunConsumerKey(personalRunJournalConsumer(admitted));
  const replacesKey = replaces
    ? personalRunConsumerKey(snapshotPersonalRunConsumer(replaces))
    : undefined;
  if (replacesKey === own)
    throw new Error(
      "Personal journal replacement names the registering consumer",
    );
  // The ownership snapshot is taken before the authority await; the
  // compare-and-set below re-reads the committed row, so a successor that
  // registered meanwhile rejects this admission instead of being clobbered.
  const previous = JSON.stringify(personalRunRecord(admitted.runKey));
  if (await journalPersonalRunRetired(admitted))
    throw new Error("Personal run is retired");
  const legacy = journalProjection();
  if (legacy.hydrated && legacy.latest[admitted.runKey])
    throw new Error("Personal journal key is held by a shared run");
  let rejournal = false;
  const committed = await mutatePersonalRunRecord(admitted.runKey, (stored) => {
    const prior =
      stored && personalRunRecordSuppressed(stored) ? undefined : stored;
    if (JSON.stringify(prior) !== previous)
      throw new Error("Personal journal ownership changed during admission");
    if (
      prior?.personalRepo &&
      !samePersonalRepoBinding(prior.personalRepo, admitted.personalRepo!)
    )
      throw new Error("Personal journal binding changed");
    // Evaluated on the committed row: a row held by another physical consumer
    // is replaced only when the caller named exactly that predecessor. A row
    // that lost its identity is evidence, never an owner, and may be replaced.
    if (prior) {
      const priorKey = consumerKeyOrUndefined(prior);
      if (priorKey !== own && priorKey !== replacesKey)
        throw new Error(
          "Personal journal ownership changed: row held by another physical consumer",
        );
    }
    rejournal = !!prior;
    return mergeRegistration(prior, admitted);
  });
  if (!committed)
    throw new Error("Personal journal ownership changed during admission");
  return { committed, rejournal };
}

export async function journalSet(
  record: ActiveRunRecord,
  transition: JournalRunStateTransition = transitionRunState,
  options: JournalSetOptions = {},
): Promise<void> {
  const { committed, rejournal } = isPrivateGatewayRecord(record)
    ? await setPrivateRecord(record, options.replaces)
    : setSharedRecord(record);
  try {
    await onJournalSet?.(committed);
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
 * session visibly when no newer duplicate will continue it. Shared records
 * only: private gateway records go through journalQuarantineAsync. */
export function journalQuarantine(entries: QuarantinedRun[]): void {
  if (!entries.length) return;
  if (entries.some((entry) => isPrivateGatewayRecord(entry.run)))
    requireAsyncPrivateJournal("quarantine");
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

/** Quarantine shared and private records alike. Private rows move to the
 * catalog quarantine namespace and are tombstoned only while their lineage
 * still matches. */
export async function journalQuarantineAsync(
  entries: QuarantinedRun[],
): Promise<void> {
  const shared = entries.filter((entry) => !isPrivateGatewayRecord(entry.run));
  const personal = entries.filter((entry) => isPrivateGatewayRecord(entry.run));
  if (shared.length) journalQuarantine(shared);
  if (personal.length) await quarantinePersonalRunRecords(personal);
}

function prepareRecovery(
  current: ActiveRunRecord,
  record: ActiveRunRecord,
): ActiveRunRecord {
  return {
    ...current,
    ...record,
    firstJournaledAt:
      record.firstJournaledAt ||
      current.firstJournaledAt ||
      current.startedAt ||
      record.startedAt,
    resumeAttempts:
      Math.max(record.resumeAttempts ?? 0, current.resumeAttempts ?? 0) + 1,
    lastResumeAt: new Date().toISOString(),
    claimedAt: current.claimedAt,
  };
}

function stripClaim(record: ActiveRunRecord): ActiveRunRecord {
  const { claimedAt: _claimed, ...returned } = record;
  return returned;
}

/** Persist the recovery lineage immediately before a queued recovery task
 * actually starts. A process death after this point consumes one attempt; a
 * death while the task was merely waiting in the concurrency queue does not. */
export function journalStartRecovery(record: ActiveRunRecord): ActiveRunRecord {
  if (record.personalRepo)
    throw new Error(
      "Personal recovery requires an asynchronous retirement check",
    );
  return startRecovery(record);
}

function startRecovery(record: ActiveRunRecord): ActiveRunRecord {
  if (privateOwnerHolds(record.runKey))
    throw new Error("Personal recovery journal ownership changed");
  const journal = readRunJournal();
  const existing = journal[record.runKey];
  if (
    (record.personalRepo || existing?.personalRepo) &&
    (!existing || !sameJournalLineage(existing, record))
  )
    throw new Error("Personal recovery journal ownership changed");
  const prepared = prepareRecovery(existing || record, record);
  journal[record.runKey] = prepared;
  writeRunJournal(journal);
  return stripClaim(prepared);
}

/** A recovered turn was successfully reattached or produced new model work.
 * Reboots while the turn keeps running should not exhaust the recovery-attempt
 * fuse: that fuse is for consecutive failed recoveries, not healthy resumptions
 * of the same turn. Shared records only; see journalMarkRecoveryAttachedAsync. */
export function journalMarkRecoveryAttached(
  record: ActiveRunRecord,
): ActiveRunRecord | undefined {
  if (isPrivateGatewayRecord(record))
    requireAsyncPrivateJournal("recovery attachment");
  // A stale shared closure can never match a private owner's lineage.
  if (privateOwnerHolds(record.runKey)) return undefined;
  const journal = readRunJournal();
  const current = journal[record.runKey];
  if (!current) return undefined;
  if (!sameJournalLineage(current, record)) return undefined;
  const attached = markAttached(current);
  journal[record.runKey] = attached;
  writeRunJournal(journal);
  return stripClaim(attached);
}

function markAttached(current: ActiveRunRecord): ActiveRunRecord {
  return { ...current, resumeAttempts: 0, lastResumeAt: undefined };
}

export async function journalMarkRecoveryAttachedAsync(
  record: ActiveRunRecord,
): Promise<ActiveRunRecord | undefined> {
  if (!isPrivateGatewayRecord(record))
    return journalMarkRecoveryAttached(record);
  const attached = await mutatePersonalRunRecord(record.runKey, (current) =>
    current &&
    !personalRunRecordSuppressed(current) &&
    sameJournalLineage(current, record)
      ? markAttached(current)
      : undefined,
  );
  return attached ? stripClaim(attached) : undefined;
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
  await journalRetireSettledCancelAbnormal(
    failed.osSessionId,
    failed.runKey,
    failed,
  );
  return failed;
}

/** Retire an exact abnormal-completion owner only after its actor cancel has
 * settled. Called from both sides of the race: source completion and actor
 * settlement. Private detached-host journals never consult gateway actor state. */
function retireSharedCancelAbnormalEvidence(
  sessionId: string,
  runKey: string,
  owner: ActiveRunRecord | undefined,
): boolean {
  const current = readRunJournal()[runKey];
  if (!current?.terminalFailure || current.osSessionId !== sessionId)
    return false;
  if (owner && !sameJournalLineage(current, owner)) return false;
  return journalClearIfLineage(current);
}

/** `owner` is the exact record whose abnormal completion is being retired.
 * The source side always has it and a private row is then tombstoned only
 * when it still belongs to that physical consumer: a successor host's own
 * terminal row under the same alias and session is never the predecessor's
 * evidence. Without an owner a private row is never retired: the current
 * alias holder is not inferred to be the caller's run, so actor settlement,
 * which knows only the session and run alias, retains private evidence. */
async function retireCancelAbnormalEvidenceAsync(
  sessionId: string | undefined,
  runKey: string,
  owner: ActiveRunRecord | undefined,
): Promise<boolean> {
  if (process.env.OPENSESSION_RUN_JOURNAL || !sessionId) return false;
  if (!privateOwnerHolds(runKey))
    return retireSharedCancelAbnormalEvidence(sessionId, runKey, owner);
  if (!owner) return false;
  const retired = await mutatePersonalRunRecord(runKey, (current) =>
    current &&
    !personalRunRecordSuppressed(current) &&
    current.terminalFailure &&
    current.osSessionId === sessionId &&
    sameJournalLineage(current, owner)
      ? null
      : undefined,
  );
  return retired === null;
}

/** Source-side race participant: actor uncertainty retains evidence because
 * the durable effect will perform the authoritative settlement-side check.
 * Pass the exact failed record as `owner` whenever the caller holds it. */
export async function journalRetireSettledCancelAbnormal(
  sessionId: string | undefined,
  runKey: string,
  owner?: ActiveRunRecord,
): Promise<boolean> {
  if (process.env.OPENSESSION_RUN_JOURNAL || !sessionId) return false;
  try {
    const cancel = (await sessionTurnSnapshot(sessionId)).cancel;
    if (cancel?.runId === runKey && cancel.phase === "settled")
      return retireCancelAbnormalEvidenceAsync(sessionId, runKey, owner);
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
      return retireCancelAbnormalEvidenceAsync(sessionId, runKey, owner);
  } catch {
    // Neither independent actor domain proved settlement; retain evidence.
  }
  return false;
}

/** Settlement-side race participant. The caller has just committed settlement
 * or read an authoritative `settled` decision, so no second actor snapshot may
 * turn a successful durable effect into an acknowledged cleanup gap. Shared
 * records only; a private owner requires the async variant. */
export function journalRetireCancelledAbnormalAfterSettlement(
  sessionId: string,
  runKey: string,
): boolean {
  if (process.env.OPENSESSION_RUN_JOURNAL || !sessionId) return false;
  if (privateOwnerHolds(runKey))
    requireAsyncPrivateJournal("abnormal-completion retirement");
  return retireSharedCancelAbnormalEvidence(sessionId, runKey, undefined);
}

/** Settlement-side variant usable for a private owner. Without `owner` it
 * retires shared evidence by session and alias only; private evidence is
 * retained, never retired by alias, so an old dispatch id cannot tombstone a
 * successor's terminal row. */
export function journalRetireCancelledAbnormalAfterSettlementAsync(
  sessionId: string,
  runKey: string,
  owner?: ActiveRunRecord,
): Promise<boolean> {
  return retireCancelAbnormalEvidenceAsync(sessionId, runKey, owner);
}

/** Clear a shared record by key. A private owner is only ever cleared by its
 * exact lineage (journalClearIfLineageAsync): a bare alias is not proof. */
export function journalClear(runKey: string): void {
  if (privateOwnerHolds(runKey)) requireAsyncPrivateJournal("clear");
  const journal = readRunJournal();
  if (runKey in journal) {
    delete journal[runKey];
    writeRunJournal(journal);
  }
}

/** Clear only the journal entry that still belongs to this recovery lineage.
 * A replacement human turn may reuse the engine session id as its runKey; an
 * old queued recovery must never delete that newer record when it wakes.
 * Shared records only; a private record requires journalClearIfLineageAsync. */
export function journalClearIfLineage(record: ActiveRunRecord): boolean {
  if (isPrivateGatewayRecord(record)) requireAsyncPrivateJournal("clear");
  // A stale shared closure can never match a private owner's lineage.
  if (privateOwnerHolds(record.runKey)) return false;
  const journal = readRunJournal();
  const current = journal[record.runKey];
  if (!current) return false;
  if (!sameJournalLineage(current, record)) return false;
  delete journal[record.runKey];
  writeRunJournal(journal);
  return true;
}

export async function journalClearIfLineageAsync(
  record: ActiveRunRecord,
): Promise<boolean> {
  if (!isPrivateGatewayRecord(record)) return journalClearIfLineage(record);
  const cleared = await mutatePersonalRunRecord(record.runKey, (current) =>
    current &&
    !personalRunRecordSuppressed(current) &&
    sameJournalLineage(current, record)
      ? null
      : undefined,
  );
  return cleared === null;
}

/** Snapshot of the runs currently journaled as in-flight (does not clear). */
export function activeRunRecords(): ActiveRunRecord[] {
  const shared = Object.values(readRunJournal());
  return personalRunJournalApplicable()
    ? [...shared, ...personalRunRecords()]
    : shared;
}

/** Hot-path journal ownership check. Writes and normal journal snapshots keep
 * this alias set current; the first call after process start hydrates it once. */
export function hasActiveRunFor(
  ...ids: Array<string | null | undefined>
): boolean {
  if (!activeRunAliasesInitialized) readRunJournal();
  else if (activeRunAliasesVersion !== journalProjection().version)
    refreshActiveRunAliases(journalProjection());
  if (ids.some((id) => !!id && activeRunAliases.has(id))) return true;
  return personalRunJournalApplicable() && hasPersonalRunFor(...ids);
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
  const admissible = async (record: ActiveRunRecord) =>
    !isRunActiveInProcess(record.runKey) &&
    !takenRunKeys.has(record.runKey) &&
    !(await journalPersonalRunRetired(record)) &&
    (await shouldTake(record));
  // The shared snapshot is taken before any await: a run registered while
  // the sweep is examining candidates is live, not interrupted.
  const journal = readRunJournal();
  const initialVersion = journalProjection().version;
  const seeded = new Set<string>();
  // A graceful-shutdown snapshot can retain a detached local host after its
  // shared record disappeared during process teardown. Fold those records
  // into the same atomic boot claim without journalSet(): journalSet denotes a
  // NEW live registration and would incorrectly move recovery state to
  // `running` before boot_journal_found has a chance to claim it.
  for (const record of seedRecords) {
    if (isPrivateGatewayRecord(record) || journal[record.runKey]) continue;
    seeded.add(record.runKey);
    journal[record.runKey] = {
      ...record,
      firstJournaledAt: record.firstJournaledAt || record.startedAt,
    };
  }

  // Private gateway records: the projection is hydrated before any candidate
  // is examined, and every claim is a compare-and-set against the committed
  // row, so a successor journaled during an await is never re-claimed.
  const privateEntries: ActiveRunRecord[] = [];
  if (personalRunJournalApplicable()) {
    await ensurePersonalRunJournalReady();
    for (const record of seedRecords) {
      if (!isPrivateGatewayRecord(record)) continue;
      await mutatePersonalRunRecord(record.runKey, (current) =>
        current
          ? undefined
          : {
              ...record,
              firstJournaledAt: record.firstJournaledAt || record.startedAt,
            },
      );
    }
    const candidates = personalRunRecords();
    const now = new Date().toISOString();
    for (const candidate of candidates) {
      if (!(await admissible(candidate))) continue;
      const claimed = await mutatePersonalRunRecord(
        candidate.runKey,
        (current) =>
          current &&
          !takenRunKeys.has(candidate.runKey) &&
          !isRunActiveInProcess(candidate.runKey) &&
          JSON.stringify(current) === JSON.stringify(candidate)
            ? { ...current, claimedAt: now }
            : undefined,
      );
      if (!claimed) continue;
      takenRunKeys.add(candidate.runKey);
      privateEntries.push(claimed);
    }
  }

  const admitted: ActiveRunRecord[] = [];
  for (const candidate of Object.values(journal)) {
    const record = structuredClone(candidate);
    if (await admissible(record)) admitted.push(record);
  }
  // Every journal write updates this projection synchronously. Authority and
  // shouldTake may have awaited while a successor was journaled. Merge only
  // unchanged ownership into the latest snapshot, not the pre-await file copy.
  // No second synchronous read and no competing asynchronous file writer.
  const current = { ...journalProjection().latest };
  const sharedEntries = admitted.filter((record) => {
    if (takenRunKeys.has(record.runKey) || isRunActiveInProcess(record.runKey))
      return false;
    const latest = current[record.runKey];
    return latest
      ? JSON.stringify(latest) === JSON.stringify(journal[record.runKey])
      : seeded.has(record.runKey) &&
          journalProjection().version === initialVersion;
  });
  if (sharedEntries.length > 0) {
    const now = new Date().toISOString();
    for (const r of sharedEntries) {
      takenRunKeys.add(r.runKey);
      current[r.runKey] = { ...r, claimedAt: now };
    }
    writeRunJournal(current);
  }
  const entries = [...sharedEntries, ...privateEntries];
  for (const r of entries) {
    if (r.osSessionId)
      await transition(r.osSessionId, "boot_journal_found", {
        run_key: r.runKey,
        kind: r.kind,
      });
  }
  return entries.map(stripClaim);
}
