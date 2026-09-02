/**
 * Session listing, transcripts, transcript search/images, archive/title/status/review overrides, delete.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import {
  executeArchiveOverrideProjection,
  executeSessionProjection,
} from "../session-projection-executor";
import { transcriptSearchWorkerArgv } from "../../runner-host/exe";
import { requestUser, type RouteContext } from "./context";
import {
  cancelAgentRunAndWait,
  currentAgentRunToken,
  isAgentSessionBusy,
} from "../agent-runner";
import {
  archiveOlderThan,
  isArchivedId,
  setArchived,
  unpinArchivedSessions,
} from "../archive";
import { audit } from "../audit";
import {
  pendingAskAwaitingAnswerSync,
  pendingAskIdsAwaitingAnswer,
} from "../asks";
import { prepareEntriesForWire, transcriptMatchSnippet } from "../jsonl-parser";
import { classifyEntry } from "@tellahq/opensession-protocol/notices";
import {
  inWorkspaceGroup,
  type WorkspaceGroup,
} from "@tellahq/opensession-protocol/workspace-group";
import { deleteSessionTranscript, transcript } from "../actor-transcript";
import { clearSessionFileArchive } from "../plain-archive";
import {
  editPrReviewers,
  isNoPrError,
  prMetaForBranch,
  prReviewerSpecs,
} from "../pr-info";

import {
  clientVisibleQueuedCount,
  clientVisibleQueuedCounts,
} from "../queue-state";

import { markPrReviewNotified } from "../pr-review-notifications";
import { footerPrsFor, getPrsByRepo, prsBySessionRef } from "../pr-cache";
import {
  getReviewRequest,
  setReviewAccepted,
  setReviewRequest,
} from "../review-requests";
import { getSessionControl, type SandboxRequest } from "../session-control";
import {
  requestTurnCancel,
  sessionQueueOwnerActive,
  watchExternalRunAndDrain,
} from "../run-session";
import {
  enrichSessionRuntime,
  findSessionAsync,
  getCachedSessionsAsync,
  getSessionListSnapshotAsync,
  invalidateSessionsCache,
  maybePersistEffort,
  maybePersistFastMode,
  runErrors,
  sessionRuntimeSnapshot,
  type SessionRuntimeSnapshot,
} from "../session-cache";
import { asDataUrlList, countImageRefs, parseImageDataUrls } from "../uploads";
import { notifyMentions } from "../mentions";
import { reviewTeamFor } from "../people";
import { sendPushToUser } from "../push";
import { unarchiveForHumanTurn } from "../session-unarchive";
import {
  sessionChangesSince,
  sessionGatewayCommand,
  sessionKernel,
  sessionQuarantines,
  sessionRunStateProjection,
  sessionTombstoneState,
  sessionProjectionOr,
  tombstoneSessionKernel,
} from "../session-kernel";
import { withSessionMutationLock } from "../session-mutation-lock";
import { sessionIdForRequest } from "../session-request-id";
import { suggestBranchName } from "../suggest-branch";
import { searchIndex } from "../session-index";
import { resolvePrTarget } from "../session-repos";
import { destroySessionSandbox } from "../session-sandbox";
import { stopAllPortalServices } from "../portal-supervisor";
import { dropRunnerPortalRoutes } from "../runner-portals";
import { cleanupRunnerWorkspace } from "../runner-ws";
import {
  deleteSession,
  markCachedPrReviewRequestsCleared,
  mergedSessionTranscriptAsync,
  removeTombstonedSessionArtifacts,
} from "../sessions";
import { githubLoginFor } from "../shared/user-mappings";
import { publicSessionSafety } from "../session-safety";
import type { DurableSessionQuarantine } from "../session-kernel/store";
import {
  getStatusOverride,
  isManualStatus,
  setStatusOverride,
} from "../status-overrides";
import { getSubagentTranscript, listSubagents } from "../subagents";
import { getTitleOverride, setTitleOverride } from "../title-overrides";
import { getGeneratedTitle } from "../generated-titles";
import {
  buildWorkspaceOverview,
  resolveTranscriptImage,
} from "../workspace-overview";
import {
  type Workspace,
  deleteWorkspace,
  getWorkspace,
  workspaceNameSnapshot,
} from "../workspaces";
import { prHostFor } from "../pr-host";
import { getRepo, NO_REPO, removeWorktree, repoForPath } from "../worktree";
import { preparingWorkspaces } from "../ws-hub";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { statePath } from "../paths";
import { writeFileAtomic } from "../shared/atomic-write";
import {
  githubCredentialRequiredResponse,
  githubMutationCredential,
} from "./github-credential";
import { defaultRepo } from "../config";
import type { UnifiedSession } from "../types";
import {
  enrichSessionPrRefs,
  projectWorkspacePrRefs,
  shareWorkspacePrRefs,
} from "../session-pr-target";
import {
  indexedSessions,
  indexedSidebarSessions,
  indexedWorkspaceMemberSessions,
  indexedWorkspaceSessions,
} from "../session-list-store";
import {
  loadSidebarSessionScopeContext,
  parseSidebarSessionScope,
  scopeSessionsForSidebar,
  sessionIsRecentTeamActivity,
  sidebarSessionScopeKey,
  type SidebarSessionScope,
} from "../sidebar-session-scope";

const SESSIONS_RESPONSE_TTL_MS = 5_000;
interface SessionsResponseSnapshot {
  text: string;
  hash: string;
  expiresAt: number;
  gzip?: Promise<Blob>;
}
/**
 * Which slice of the session list a request asked for.
 *
 * Archived sessions are ~46% of this instance's payload (2,772 of 6,223 rows,
 * 3.9 MB of 8.5 MB raw), and a client that never opens one shouldn't carry
 * them through every poll. Each variant caches its own body, hash and ETag, so
 * the archived slice settles into a near-permanent 304 while the live slice
 * keeps churning on `isRunning` / `lastActivity`.
 */
export type SessionsVariant = "include" | "exclude" | "only" | "only-slim";
type SessionListSignals = {
  waitingForInput?: boolean;
  queuedCount?: number;
  workspacePreparing?: boolean;
  /** See sessionRan — the list's stand-in for the engine session ids. */
  ran?: boolean;
  rev?: number;
};

/**
 * A session as list clients consume it: everything a session has, minus the
 * two required fields the list no longer carries.
 *
 * The pair is stated as a type so a consumer that reaches for an engine id or
 * a transcript path off a list row fails to compile rather than reading
 * undefined. GET /api/sessions/:id still answers with the whole session.
 */
export type SessionListRow = Omit<
  UnifiedSession,
  "claudeSessionId" | "transcriptPath"
> &
  SessionListSignals;

/**
 * This session has an engine conversation behind it — it ran at least one turn.
 *
 * Every list surface that reads an engine session id reads it only for this:
 * an untouched "New session" shell should not displace the conversation that
 * started a workspace (web `sessionNeverRan`, Swift `Session.neverRan`), and
 * closing one deletes rather than archives it. The ids themselves are 9% of
 * the list payload and are 26-char strings nobody compares, so the list
 * carries the answer and the detail route carries the ids.
 */
export function sessionRan(
  s: Pick<UnifiedSession, "claudeSessionId" | "codexThreadId" | "piSessionId">,
): boolean {
  return !!(s.claudeSessionId || s.codexThreadId || s.piSessionId);
}

/** Translate the web create sentinel into the control path's explicit flag. */
export function nativeCreateRepoOptions(mode: string, repo: unknown) {
  if (mode === "ask" && repo === NO_REPO) return { repoLess: true as const };
  return typeof repo === "string" && repo ? { repo } : {};
}

/** Read the requested slice off the query. Anything unrecognised means the
 *  whole list, so a typo degrades to today's behaviour rather than to an
 *  empty screen. */
export function sessionsVariant(params: URLSearchParams): SessionsVariant {
  const archived = params.get("archived");
  if (archived === "exclude") return "exclude";
  if (archived !== "only") return "include";
  return params.get("slim") === "1" ? "only-slim" : "only";
}

/**
 * The workspace an archived slice is scoped to, or null for the whole index.
 *
 * Only an archived slice takes a scope: the live list is what the sidebar and
 * the strip poll whole, and narrowing it would be a different feature. An
 * unknown workspace id still scopes (by id alone, matching nothing), so a
 * stale link degrades to an empty history rather than to the whole instance's.
 */
export function archivedScope(
  params: URLSearchParams,
  variant: SessionsVariant,
): WorkspaceGroup | null {
  if (variant !== "only" && variant !== "only-slim") return null;
  const workspaceId = params.get("workspace");
  if (!workspaceId) return null;
  return { workspaceId, worktreeDir: getWorkspace(workspaceId)?.worktreeDir };
}

// Parked on globalThis so invalidateSessionsCache() can clear it without this
// module and session-cache importing each other (the same cycle-breaker
// session-cache uses to reach promptQueues). Without that, archiving a session
// stayed visible for up to SESSIONS_RESPONSE_TTL_MS after the underlying cache
// had already been invalidated — the response snapshot outlived its source.
const sessionsResponseSnapshots: Map<string, SessionsResponseSnapshot> = ((
  globalThis as any
).__osSessionsResponseSnapshots ??= new Map());
const sessionsResponseRefreshes: Map<
  string,
  Promise<SessionsResponseSnapshot>
> = ((globalThis as any).__osSessionsResponseRefreshes ??= new Map());

// The live list is expensive to rebuild from thousands of source files after a
// process restart. Keep its last complete response as the one cold-start
// fallback, then refresh in the background. The version in the filename is the
// schema boundary: bump it whenever sessionListRow stops being backward
// compatible with the current web client.
const LIVE_LIST_DISK_VERSION = 3;
const LIVE_LIST_DISK_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const LIVE_LIST_DISK_SERVE_MS = 2 * 60_000;
const LIVE_LIST_DISK_PATH = statePath(
  `.opensession-session-list-v${LIVE_LIST_DISK_VERSION}.json`,
);
const LIVE_LIST_DISK_GZIP_PATH = `${LIVE_LIST_DISK_PATH}.gz`;
let triedDiskLiveList = false;

function readDiskLiveList(): SessionsResponseSnapshot | null {
  if (triedDiskLiveList) return null;
  triedDiskLiveList = true;
  try {
    if (!existsSync(LIVE_LIST_DISK_PATH)) return null;
    const sourceMtime = statSync(LIVE_LIST_DISK_PATH).mtimeMs;
    if (Date.now() - sourceMtime > LIVE_LIST_DISK_MAX_AGE_MS) return null;
    let text = readFileSync(LIVE_LIST_DISK_PATH, "utf8");
    if (!text.startsWith("[")) return null;
    // The snapshot can predate an archive whose refresh never ran — e.g. the
    // archive landed in the previous process's shutdown window, or between
    // its last persist and SIGKILL. Installing it as-is would put
    // just-archived sessions back in the live sidebar until the cold scan
    // finishes (up to LIVE_LIST_DISK_SERVE_MS plus refresh delay), which
    // reads to the person as "I archived this and it came back". The
    // registry is the durable truth, so drop archived rows before serving.
    let rewrote = false;
    try {
      const rows = JSON.parse(text) as Array<{ id?: string }>;
      const live = rows.filter((row) => !row.id || !isArchivedId(row.id));
      if (live.length !== rows.length) {
        text = JSON.stringify(live);
        rewrote = true;
      }
    } catch {}
    const haveMatchingGzip =
      !rewrote &&
      existsSync(LIVE_LIST_DISK_GZIP_PATH) &&
      statSync(LIVE_LIST_DISK_GZIP_PATH).mtimeMs >= sourceMtime;
    return {
      text,
      hash: Bun.hash(text).toString(16),
      expiresAt: Date.now() + LIVE_LIST_DISK_SERVE_MS,
      ...(haveMatchingGzip
        ? { gzip: Promise.resolve(Bun.file(LIVE_LIST_DISK_GZIP_PATH)) }
        : {}),
    };
  } catch {
    return null;
  }
}

function persistDiskLiveList(text: string): void {
  try {
    writeFileAtomic(LIVE_LIST_DISK_PATH, text, 0o600);
    // CompressionStream competes with the cold scan on the server thread. Do
    // this once when the fresh snapshot lands, not on the next process's first
    // response, so a warm boot can send ready bytes straight from disk.
    const tmp = `${LIVE_LIST_DISK_GZIP_PATH}.tmp.${process.pid}`;
    try {
      writeFileSync(tmp, Bun.gzipSync(Buffer.from(text)), { mode: 0o600 });
      renameSync(tmp, LIVE_LIST_DISK_GZIP_PATH);
    } catch (error) {
      try {
        rmSync(tmp);
      } catch {}
      try {
        rmSync(LIVE_LIST_DISK_GZIP_PATH);
      } catch {}
      throw error;
    }
  } catch (error) {
    console.warn(
      "[sessions] failed to persist the live-list startup cache:",
      error,
    );
  }
}

async function sessionsListResponse(
  req: Request,
  snapshot: SessionsResponseSnapshot,
): Promise<Response> {
  const gzip = (req.headers.get("Accept-Encoding") || "").includes("gzip");
  const etag = `"${snapshot.hash}${gzip ? "-gzip" : ""}"`;
  const headers = new Headers({
    "Cache-Control": "private, no-cache",
    "Content-Type": "application/json; charset=utf-8",
    ETag: etag,
    Vary: "Accept-Encoding",
  });
  if (gzip) headers.set("Content-Encoding", "gzip");
  if (req.headers.get("If-None-Match") === etag)
    return new Response(null, { status: 304, headers });
  if (!gzip) return new Response(snapshot.text, { headers });
  if (!snapshot.gzip)
    snapshot.gzip = new Response(
      new Blob([snapshot.text])
        .stream()
        .pipeThrough(new CompressionStream("gzip")),
    ).blob();
  return new Response(await snapshot.gzip, { headers });
}

/**
 * Overlay the live, in-process signals that aren't on the cached session
 * objects: whether a run is blocked on a human question (pendingAsks) and how
 * many prompts are queued behind it. Drives the sidebar/tab "needs input"
 * highlight without a second round-trip.
 *
 * Shared by the list and by the single-session route, so a session hydrated on
 * open carries exactly what the list would have handed the client.
 */
type SessionListRuntimeSignals = {
  waitingForInput: Set<string>;
  queuedCounts: Map<string, number>;
  quarantines: Map<string, DurableSessionQuarantine>;
  runtime: SessionRuntimeSnapshot;
};

const RUNTIME_SIGNALS_TTL_MS = 250;
let runtimeSignalsCache:
  | { value: SessionListRuntimeSignals; expiresAt: number }
  | undefined;
let runtimeSignalsRefresh: Promise<SessionListRuntimeSignals> | undefined;

async function sessionListRuntimeSignals(): Promise<SessionListRuntimeSignals> {
  if (runtimeSignalsCache && runtimeSignalsCache.expiresAt > Date.now())
    return runtimeSignalsCache.value;
  if (runtimeSignalsRefresh) return runtimeSignalsRefresh;
  runtimeSignalsRefresh = (async () => {
    const [waitingForInput, queuedCounts, quarantines] = await Promise.all([
      pendingAskIdsAwaitingAnswer(),
      clientVisibleQueuedCounts(),
      sessionQuarantines(),
    ]);
    const quarantineBySession = new Map(
      quarantines.map((entry) => [entry.sessionId, entry]),
    );
    // Every visible queued prompt has a process owner. Boot restoration and
    // enqueue normally arm it; list reconciliation closes the last crash window.
    for (const [sessionId, count] of queuedCounts) {
      if (count > 0 && !quarantineBySession.has(sessionId))
        watchExternalRunAndDrain(sessionId);
    }
    const value = {
      waitingForInput,
      queuedCounts,
      quarantines: quarantineBySession,
      runtime: sessionRuntimeSnapshot(),
    };
    runtimeSignalsCache = {
      value,
      expiresAt: Date.now() + RUNTIME_SIGNALS_TTL_MS,
    };
    return value;
  })().finally(() => {
    runtimeSignalsRefresh = undefined;
  });
  return runtimeSignalsRefresh;
}

type SessionEnrichmentContext = {
  defaultRepoId: string;
  prsByRepo: ReturnType<typeof getPrsByRepo>;
  prsBySession: ReturnType<typeof prsBySessionRef>;
  workspaceNames: ReadonlyMap<string, string>;
};

function sessionEnrichmentContext(): SessionEnrichmentContext {
  const prsByRepo = getPrsByRepo();
  return {
    defaultRepoId: defaultRepo().id,
    prsByRepo,
    prsBySession: prsBySessionRef(prsByRepo),
    workspaceNames: workspaceNameSnapshot(),
  };
}

function enrichSession(
  s: UnifiedSession,
  signals?: SessionListRuntimeSignals,
  context = sessionEnrichmentContext(),
) {
  // The materialized row may still say a completed run is active. Reconcile
  // both edges from live runtime state before serializing any list or detail.
  enrichSessionRuntime([s], signals?.runtime);
  const generatedTitle =
    getGeneratedTitle(s.id) ??
    s.aliasIds?.map((id) => getGeneratedTitle(id)).find(Boolean);
  const titleOverride =
    getTitleOverride(s.id) ??
    s.aliasIds?.map((id) => getTitleOverride(id)).find(Boolean);
  const manualStatus =
    getStatusOverride(s.id) ??
    s.aliasIds?.map((id) => getStatusOverride(id)).find(Boolean);
  const reviewRequest =
    getReviewRequest(s.id) ??
    s.aliasIds?.map((id) => getReviewRequest(id)).find(Boolean);
  const prSession = enrichSessionPrRefs(s, {
    defaultRepoId: context.defaultRepoId,
    prsByRepo: context.prsByRepo,
    footerMatches: footerPrsFor(context.prsBySession, s),
  });
  const quarantine = signals?.quarantines.get(s.id);
  const safety = quarantine
    ? publicSessionSafety(quarantine, signals?.runtime.claimedJournalSessions)
    : undefined;
  return {
    ...prSession,
    ...(safety
      ? {
          isRunning: false,
          runStartedAt: undefined,
          runState: "paused_for_safety",
          safety,
        }
      : {}),
    ...(generatedTitle ? { title: generatedTitle } : {}),
    ...(titleOverride ? { title: titleOverride, titleOverridden: true } : {}),
    ...(manualStatus ? { manualStatus } : {}),
    ...(reviewRequest ? { reviewRequest } : {}),
    repo: s.repo || context.defaultRepoId,
    // The name of the workspace this session is filed under. A sidebar row
    // names a workspace, never one of its tabs, and the workspace list is
    // a separate (much larger) fetch that lands seconds later on a cold
    // load — so a row that had only session titles to work with showed a
    // tab name until it arrived, then changed under the reader.
    ...(s.workspaceId
      ? { workspaceName: context.workspaceNames.get(s.workspaceId) }
      : {}),
    waitingForInput: signals
      ? signals.waitingForInput.has(s.id)
      : !!sessionProjectionOr(
          () => pendingAskAwaitingAnswerSync(s.id),
          undefined,
        ),
    queuedCount: signals
      ? signals.queuedCounts.get(s.id) || 0
      : sessionProjectionOr(() => clientVisibleQueuedCount(s.id), 0),
    ...(signals && (signals.queuedCounts.get(s.id) || 0) > 0
      ? { queueOwnerActive: sessionQueueOwnerActive(s.id) }
      : {}),
    // Present on the list AND on the detail response, so one rule reads the
    // same either side of a hydrate. `undefined` rather than `false`: it is
    // dropped by JSON.stringify, and a session object a client builds
    // optimistically for a just-created tab is correct by omission.
    ran: sessionRan(s) || undefined,
    // Worktree still being created by this session's create run — the
    // viewer shows "Waiting for workspace" and queues sends meanwhile.
    ...(preparingWorkspaces.has(s.id) ? { workspacePreparing: true } : {}),
    // Terminal failure of the last run (credits/limits/API) — persisted
    // on opensession session files, in-memory for slack/linear sessions.
    lastRunError: runErrors.get(s.id) || s.lastRunError,
  };
}

/**
 * A session as list clients consume it.
 *
 * The detail route keeps the full UnifiedSession. The list drops fields used
 * only to resume or persist a run, drops the ones only the session you have
 * OPEN reads (which it hydrates), then omits values for which every client
 * already treats absence as the same default. Keeping this projection here
 * prevents another stored per-session field from silently becoming list
 * payload weight.
 *
 * `worktreeDir` deliberately stays. It reads like detail, but both sidebars
 * group legacy rows on it and both persist `wt:<dir>` as a row key in the
 * shared hides/pins overlays, so a list without it loses the grouping for
 * every session filed before workspace ids existed.
 */
export function sessionListRow(
  s: UnifiedSession & SessionListSignals,
): SessionListRow {
  const {
    // Resume/persist internals: no client reads them at all.
    lastEngineModel: _lastEngineModel,
    lastEngineProvider: _lastEngineProvider,
    mcpServers: _mcpServers,
    presetNote: _presetNote,
    slackThread: _slackThread,
    slackThreads: _slackThreads,
    // Detail only. The engine ids and the transcript path answer "has this
    // session run?" on a list, which `ran` above now answers in 11 bytes
    // instead of ~105; the model-switch history is drawn as dividers in
    // the open conversation and nowhere else. All four are on
    // GET /api/sessions/:id, which the open session hydrates from.
    claudeSessionId: _claudeSessionId,
    codexThreadId: _codexThreadId,
    piSessionId: _piSessionId,
    modelHistory: _modelHistory,
    transcriptPath: _transcriptPath,
    ...listed
  } = s;
  const row: Partial<SessionListRow> = listed;

  // These values are all represented by a missing optional in the web,
  // Swift, TUI and extension clients. In particular, Swift's hand-written
  // Codable model already makes each one optional.
  if (!row.isRunning) delete row.isRunning;
  if (!row.waitingForInput) delete row.waitingForInput;
  if (!row.queuedCount) delete row.queuedCount;
  if (row.branch == null) delete row.branch;
  if (row.createdBy == null) delete row.createdBy;
  if (row.startedBy == null) delete row.startedBy;
  if (row.workspaceId == null) delete row.workspaceId;
  if (!row.fastMode) delete row.fastMode;
  if (!row.prIsDraft) delete row.prIsDraft;
  if (!row.prReviewDecision) delete row.prReviewDecision;
  if (!row.prReviewRequested?.length) delete row.prReviewRequested;
  if (!row.prReviewedBy?.length) delete row.prReviewedBy;
  if (!row.aliasIds?.length) delete row.aliasIds;
  if (!row.attachedRepos?.length) delete row.attachedRepos;
  if (!row.linkedPrs?.length) delete row.linkedPrs;
  if (!row.desk) delete row.desk;
  if (!row.repoLess) delete row.repoLess;
  if (!row.titleOverridden) delete row.titleOverridden;
  if (!row.workspacePreparing) delete row.workspacePreparing;
  // Older hand-written/test session files can violate the current wire type.
  // Do not let one malformed automation id crash clients sorting the list.
  if (typeof row.automation !== "string" || !row.automation.trim())
    delete row.automation;
  else row.automation = row.automation.trim();
  delete row.rev;

  return row as SessionListRow;
}

/**
 * An archived session as the Archived surfaces actually render it: the row's
 * own text, who closed it, when, and enough identity to group and open it.
 *
 * Everything else on a session object is weight nobody reads there — a full
 * row averages ~1,400 bytes on this instance, of which `walkthrough` alone is
 * ~300 and `prs`/`usage` another ~190. Opening one of these rows hydrates the
 * real session (GET /api/sessions/:id), so nothing downstream has to make do
 * with the subset.
 */
const SIDEBAR_AUTOMATION_RUNS = 5;

/**
 * Bound automation history in the live list the web app polls.
 *
 * Automation runs are 4,304 of this instance's 4,707 live sessions, but a
 * collapsed automation heading renders none of them. Keep enough recent runs
 * to make an expanded heading useful, plus any older run that is still live or
 * waiting on a person. Direct links hydrate their session independently.
 * Every retained run carries the complete count so the heading still says how
 * much history exists rather than pretending this bounded window is all of it.
 */
export function sidebarLiveSessions<
  T extends UnifiedSession & SessionListSignals,
>(sessions: T[]): Array<T & { automationRunCount?: number }> {
  const byAutomation = new Map<string, T[]>();
  for (const session of sessions) {
    if (!session.automation) continue;
    const rows = byAutomation.get(session.automation) || [];
    rows.push(session);
    byAutomation.set(session.automation, rows);
  }

  const keep = new Set<T>();
  const now = Date.now();
  for (const rows of byAutomation.values()) {
    const recent = [...rows]
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
      .slice(0, SIDEBAR_AUTOMATION_RUNS);
    for (const row of recent) keep.add(row);
    for (const row of rows) {
      if (
        sessionIsRecentTeamActivity(row, now) ||
        row.waitingForInput ||
        row.manualStatus
      )
        keep.add(row);
    }
  }

  return sessions.flatMap((session) => {
    if (!session.automation) return [session];
    if (!keep.has(session)) return [];
    return [
      {
        ...session,
        automationRunCount: byAutomation.get(session.automation)!.length,
      },
    ];
  });
}

export function archivedIndexRow(
  s: UnifiedSession & SessionListSignals,
): SessionListRow {
  return {
    // Every field a LIST row requires, carried verbatim. An index row is a
    // real list row, just a poorer one — a client can merge it into its
    // list and read it like any other row instead of threading a second
    // type through every consumer. What it drops is only ever optional.
    id: s.id,
    source: s.source,
    branch: s.branch,
    worktreeDir: s.worktreeDir,
    startedBy: s.startedBy,
    title: s.title,
    lastActivity: s.lastActivity,
    createdAt: s.createdAt,
    isRunning: s.isRunning,
    // The same summary the live list carries in place of the engine ids, so
    // `sessionNeverRan` reads one rule across both slices. An archived
    // session that ran is what the workspace landing pick falls back to
    // when every live row is an abandoned shell.
    ...(s.ran ? { ran: true } : {}),
    archived: true,
    // Says out loud that this is a summary, so a client that merges it into
    // its list knows to hydrate before reading anything the index doesn't
    // carry. Without it, opening an archived session renders a session
    // that is quietly missing its PRs and its walkthrough.
    slim: true,
    // The optionals the Archived surfaces actually read: the row's own
    // text, the lens the sidebar badge filters by, and enough identity to
    // group it (the tab strip's history menu keys on workspace, falling
    // back to a shared worktree for sessions predating workspaces).
    ...(s.aliasIds?.length ? { aliasIds: s.aliasIds } : {}),
    ...(s.archivedReason ? { archivedReason: s.archivedReason } : {}),
    ...(s.mode ? { mode: s.mode } : {}),
    ...(s.automation ? { automation: s.automation } : {}),
    // Says the row came from an agent action rather than a person's composer.
    // History and sidebar rows keep that origin visible after archival too.
    ...(s.agentStarted ? { agentStarted: true } : {}),
    // Says the row is a worker rather than someone's own conversation.
    // The history menu marks those, so a workspace whose archive is mostly
    // review and worker runs still reads as a list of what PEOPLE closed.
    ...(s.parentSessionId ? { parentSessionId: s.parentSessionId } : {}),
    ...(s.repo ? { repo: s.repo } : {}),
    ...(s.repoLess ? { repoLess: true } : {}),
    ...(s.workspaceId ? { workspaceId: s.workspaceId } : {}),
    // sessionRepo() falls back to the first external ref's kind, so a
    // repo-less feed session files under its feed rather than the default
    // repo. Identity is cheap; the ref's `url` and `title` are not, and
    // nothing on these surfaces reads them.
    ...(s.externalRefs?.length
      ? {
          externalRefs: [
            { kind: s.externalRefs[0].kind, id: s.externalRefs[0].id },
          ],
        }
      : {}),
    // Desk sessions are hidden from every list; clients filter on it.
    ...(s.desk ? { desk: true } : {}),
  };
}

/**
 * List which of `files` contain `query` (case-insensitive, literal) via
 * ripgrep — the cheap first stage of transcript full-text search. rg exits 1
 * when nothing matches, which we treat as "no hits", not an error. Chunked so a
 * very long file list can't overflow the argv limit.
 */
type StoredTranscriptSearchExhaustion =
  | "sessions"
  | "rows"
  | "time"
  | "matches"
  | "error"
  | null;

interface StoredTranscriptSearchResult {
  matches: Array<{ id: string; snippet: string }>;
  searchedSessions: number;
  candidateRows: number;
  exhausted: StoredTranscriptSearchExhaustion;
}

/** Global search uses bounded read-only handles in a child process. It never
 * queues synchronous SQLite scans through authoritative actor mailboxes. */
async function searchStoredTranscripts(
  query: string,
  sessionIds: string[],
  signal?: AbortSignal,
): Promise<StoredTranscriptSearchResult> {
  if (sessionIds.length === 0)
    return {
      matches: [],
      searchedSessions: 0,
      candidateRows: 0,
      exhausted: null,
    };
  const proc = Bun.spawn(
    transcriptSearchWorkerArgv(
      process.execPath,
      `${import.meta.dir}/../transcript-search-worker.ts`,
    ),
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 6_000 },
  );
  const abort = () => proc.kill();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  proc.stdin.write(
    JSON.stringify({
      query,
      sessionIds,
      maxMatches: 50,
      maxSessions: 250,
      maxRows: 6_000,
      maxMs: 5_000,
    }),
  );
  proc.stdin.end();
  try {
    const [output, error, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0 || signal?.aborted) {
      if (!signal?.aborted)
        console.warn(
          `[transcript-search] worker failed: ${error.trim().slice(0, 300)}`,
        );
      return {
        matches: [],
        searchedSessions: 0,
        candidateRows: 0,
        exhausted: "error",
      };
    }
    const parsed = JSON.parse(output) as StoredTranscriptSearchResult;
    const exhausted = ["sessions", "rows", "time", "matches"].includes(
      String(parsed.exhausted),
    )
      ? parsed.exhausted
      : null;
    return {
      matches: Array.isArray(parsed.matches) ? parsed.matches.slice(0, 50) : [],
      searchedSessions: Number(parsed.searchedSessions) || 0,
      candidateRows: Number(parsed.candidateRows) || 0,
      exhausted,
    };
  } catch {
    return {
      matches: [],
      searchedSessions: 0,
      candidateRows: 0,
      exhausted: "error",
    };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function ripgrepFiles(query: string, files: string[]): Promise<string[]> {
  const hits = new Set<string>();
  const CHUNK = 1000;
  for (let i = 0; i < files.length; i += CHUNK) {
    const chunk = files.slice(i, i + CHUNK);
    const proc = Bun.spawn(
      ["rg", "-l", "-i", "-F", "--no-messages", "--", query, ...chunk],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of out.split("\n")) {
      const p = line.trim();
      if (p) hits.add(p);
    }
  }
  return [...hits];
}

function refreshSidebarSessionsResponse(
  scope: SidebarSessionScope,
): Promise<SessionsResponseSnapshot> {
  const key = sidebarSessionScopeKey(scope);
  const current = sessionsResponseRefreshes.get(key);
  if (current) return current;
  const refresh = (async () => {
    const signals = await sessionListRuntimeSignals();
    const context = sessionEnrichmentContext();
    const indexed = indexedSidebarSessions(scope.selectedSessionId);
    const sliced = (indexed ?? (await getCachedSessionsAsync("exclude"))).map(
      (session) => enrichSession(session, signals, context),
    );
    shareWorkspacePrRefs(sliced);
    const bounded = indexed ? sliced : sidebarLiveSessions(sliced);
    const scoped = scopeSessionsForSidebar(
      bounded,
      scope,
      loadSidebarSessionScopeContext(scope, bounded),
    );
    const text = JSON.stringify(scoped.map(sessionListRow));
    const snapshot: SessionsResponseSnapshot = {
      text,
      hash: Bun.hash(text).toString(16),
      expiresAt: Date.now() + SESSIONS_RESPONSE_TTL_MS,
    };
    sessionsResponseSnapshots.set(key, snapshot);
    return snapshot;
  })().finally(() => {
    sessionsResponseRefreshes.delete(key);
  });
  sessionsResponseRefreshes.set(key, refresh);
  return refresh;
}

function refreshSessionsResponse(
  variant: SessionsVariant,
): Promise<SessionsResponseSnapshot> {
  const current = sessionsResponseRefreshes.get(variant);
  if (current) return current;
  const refresh = (async () => {
    const signals = await sessionListRuntimeSignals();
    const context = sessionEnrichmentContext();
    const slice =
      variant === "exclude"
        ? "exclude"
        : variant === "include"
          ? "include"
          : "only";
    const indexed =
      variant === "exclude" ? indexedSidebarSessions() : indexedSessions(slice);
    const sliced = (indexed ?? (await getCachedSessionsAsync(slice))).map(
      (session) => enrichSession(session, signals, context),
    );
    shareWorkspacePrRefs(sliced);
    const listed =
      variant === "exclude" && !indexed ? sidebarLiveSessions(sliced) : sliced;
    const text = JSON.stringify(
      variant === "only-slim"
        ? listed.map(archivedIndexRow)
        : listed.map(sessionListRow),
    );
    const snapshot: SessionsResponseSnapshot = {
      text,
      hash: Bun.hash(text).toString(16),
      expiresAt: Date.now() + SESSIONS_RESPONSE_TTL_MS,
    };
    sessionsResponseSnapshots.set(variant, snapshot);
    if (variant === "exclude") persistDiskLiveList(text);
    return snapshot;
  })().finally(() => {
    sessionsResponseRefreshes.delete(variant);
  });
  sessionsResponseRefreshes.set(variant, refresh);
  return refresh;
}

export async function handleSessionsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path, publicPrefix } = ctx;

  // Create a session. REST shape for the native iOS/macOS apps (prompting is
  // WS-only, but creation routes through the same SessionControl path the
  // opensession-sessions MCP tools use — worktree, branch, opening run and
  // all). The web UI keeps its richer create_session WS message.
  if (path === "/api/sessions" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as {
      prompt?: unknown;
      repo?: unknown;
      mode?: unknown;
      model?: unknown;
      effort?: unknown;
      fastMode?: unknown;
      images?: unknown;
      files?: unknown;
      branch?: unknown;
      user?: unknown;
      workspaceId?: unknown;
      sandbox?: unknown;
      forkFrom?: unknown;
      requestId?: unknown;
      clientId?: unknown;
    } | null;
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    const files = Array.isArray(body?.files) ? body.files : undefined;
    const imageUrls = Array.isArray(body?.images)
      ? body.images.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    if (!prompt && !files?.length && !imageUrls.length) {
      return Response.json(
        { error: "prompt or attachment required" },
        { status: 400 },
      );
    }
    // Join an existing workspace as a sibling session — the native apps' "new
    // session in this workspace", equivalent to the web tab strip's "+".
    const workspaceId =
      typeof body?.workspaceId === "string" && body.workspaceId
        ? body.workspaceId
        : "";
    const mode =
      body?.mode === "code"
        ? ("code" as const)
        : body?.mode === "scratch"
          ? ("scratch" as const)
          : ("ask" as const);
    let forkFrom: { sourceId: string; messageId?: string } | undefined;
    if (body?.forkFrom !== undefined) {
      const candidate = body.forkFrom;
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate) ||
        !("sourceId" in candidate) ||
        typeof candidate.sourceId !== "string" ||
        !candidate.sourceId.trim()
      ) {
        return Response.json({ error: "invalid forkFrom" }, { status: 400 });
      }
      const messageId =
        "messageId" in candidate ? candidate.messageId : undefined;
      if (
        messageId !== undefined &&
        (typeof messageId !== "string" || !messageId.trim())
      ) {
        return Response.json({ error: "invalid forkFrom" }, { status: 400 });
      }
      forkFrom = {
        sourceId: candidate.sourceId.trim(),
        ...(typeof messageId === "string"
          ? { messageId: messageId.trim() }
          : {}),
      };
    }
    let branch = typeof body?.branch === "string" ? body.branch.trim() : "";
    const joinsWorktree = !!(
      workspaceId && getWorkspace(workspaceId)?.worktreeDir
    );
    if (!forkFrom && mode === "code" && !branch && !joinsWorktree) {
      const attachmentName =
        typeof (files?.[0] as { name?: unknown } | undefined)?.name === "string"
          ? String((files?.[0] as { name: string }).name)
          : imageUrls.length
            ? "image"
            : "session";
      branch =
        (await suggestBranchName(prompt || `Review ${attachmentName}`).catch(
          () => null,
        )) || `session-${Date.now().toString(36)}`;
    }

    try {
      const actor = requestUser(ctx, body?.user);
      const suppliedRequestId =
        typeof body?.requestId === "string" && body.requestId.trim()
          ? body.requestId.trim().slice(0, 200)
          : typeof body?.clientId === "string" && body.clientId.trim()
            ? body.clientId.trim().slice(0, 200)
            : undefined;
      const requestId = suppliedRequestId || crypto.randomUUID();
      const actorScope = ctx.authUser?.login || actor || "anonymous";
      const targetId = sessionIdForRequest(actorScope, requestId);
      const duplicate = !!(await sessionKernel(targetId).creationState());
      const created = await getSessionControl().createSession({
        id: targetId,
        requestId,
        requestScope: actorScope,
        createdByLogin: ctx.authUser?.login,
        prompt,
        mode,
        ...(mode === "code" && branch ? { branch } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(forkFrom ? { forkFrom } : {}),
        ...nativeCreateRepoOptions(mode, body?.repo),
        ...(typeof body?.model === "string" && body.model
          ? { model: body.model }
          : {}),
        ...(typeof body?.effort === "string" && body.effort
          ? { effort: body.effort }
          : {}),
        ...(body?.fastMode === true ? { fastMode: true } : {}),
        // Where the session runs, as the native composer's sandbox chip
        // names it ("local" is the host, chosen explicitly). Omitted, the
        // instance's own default still decides — which is what every
        // caller that doesn't offer the choice wants. Validation stays
        // where the web create's does (resolveRequestedSandbox), so an
        // unavailable provider fails the create with its own message
        // rather than silently running somewhere else.
        ...(typeof body?.sandbox === "string" && body.sandbox
          ? { sandbox: body.sandbox as SandboxRequest }
          : {}),
        // Image and file attachments from the native create path.
        ...(imageUrls.length ? { images: imageUrls } : {}),
        ...(files?.length ? { files } : {}),
        user: actor,
      });
      return Response.json({
        id: created.id,
        ...(duplicate ? { duplicate: true } : {}),
      });
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  }

  // List sessions.
  //
  // `?archived=` slices the payload — `exclude` for the cold-start list,
  // `only` (with `slim=1` for the narrow index) for the Archived surfaces.
  // The default stays the whole list on purpose: os1-ios reads archived rows
  // straight off it (SessionsListViewModel splits the one response into
  // active + archived), so moving the default would empty the Archived
  // screen of every TestFlight build already in the wild. Clients opt in as
  // they learn to fetch the index and hydrate what they open.
  if (path === "/api/sessions" && req.method === "GET") {
    const variant = sessionsVariant(url.searchParams);
    const sidebarScope = parseSidebarSessionScope(
      url.searchParams,
      requestUser(ctx, url.searchParams.get("user")),
    );
    if (variant === "exclude" && sidebarScope) {
      const key = sidebarSessionScopeKey(sidebarScope);
      const cached = sessionsResponseSnapshots.get(key);
      return await sessionsListResponse(
        req,
        cached && cached.expiresAt > Date.now()
          ? cached
          : await refreshSidebarSessionsResponse(sidebarScope),
      );
    }
    // `?workspace=<id>` narrows an archived slice to one workspace's group,
    // which is what the tab strip's history menu needs: a few rows instead
    // of the whole index (1,984 KB and growing on this instance), fetched
    // per workspace someone opens. Answered before the shared snapshot
    // cache and never stored in it: that cache exists to amortize a
    // MB-scale stringify across every poller, while a scoped body is a
    // cheap filter over the already-cached session list, and keying it per
    // workspace would grow an entry per workspace forever.
    const scope = archivedScope(url.searchParams, variant);
    if (scope) {
      const indexed = scope.workspaceId
        ? indexedWorkspaceSessions(scope.workspaceId, scope.worktreeDir)
        : null;
      const selected =
        indexed ??
        (await getCachedSessionsAsync("only")).filter((session) =>
          inWorkspaceGroup(session, scope),
        );
      const signals = await sessionListRuntimeSignals();
      const context = sessionEnrichmentContext();
      const rows = selected.map((session) =>
        enrichSession(session, signals, context),
      );
      shareWorkspacePrRefs(rows);
      const text = JSON.stringify(
        variant === "only-slim"
          ? rows.map(archivedIndexRow)
          : rows.map(sessionListRow),
      );
      // Still ETagged, so a client polling its workspace settles into 304s.
      return await sessionsListResponse(req, {
        text,
        hash: Bun.hash(text).toString(16),
        expiresAt: 0,
      });
    }
    const cached = sessionsResponseSnapshots.get(variant);
    if (cached && cached.expiresAt > Date.now())
      return await sessionsListResponse(req, cached);
    if (cached && variant === "exclude") {
      // Polling should never make the sidebar wait for a fresh scan of every
      // source file. Keep handing out the last complete, bounded list while
      // one shared refresh catches up. Cache invalidation marks this snapshot
      // stale rather than deleting it for the same reason.
      cached.expiresAt = Date.now() + SESSIONS_RESPONSE_TTL_MS;
      if (!sessionsResponseRefreshes.has(variant)) {
        setTimeout(() => {
          void refreshSessionsResponse(variant).catch((error) =>
            console.warn(
              "[sessions] live-list background refresh failed:",
              error,
            ),
          );
        }, 250).unref?.();
      }
      return await sessionsListResponse(req, cached);
    }

    // A process restart loses the in-memory list but not the last complete
    // response. Serve that once so the sidebar can paint, while the ordinary
    // cache refresh catches up in the background. In-process invalidations do
    // not reuse disk because readDiskLiveList is intentionally one-shot.
    if (variant === "exclude" && !cached) {
      const disk = readDiskLiveList();
      if (disk) {
        sessionsResponseSnapshots.set(variant, disk);
        // Starting the cooperative scan still does some synchronous index
        // setup before its first yield. Keep boot quiet long enough for the
        // session, sidebar and workspace shell to finish their own requests;
        // the persisted response keeps the list useful in the meantime.
        setTimeout(() => {
          void refreshSessionsResponse(variant).catch((error) =>
            console.warn(
              "[sessions] live-list background refresh failed:",
              error,
            ),
          );
        }, 30_000).unref?.();
        return await sessionsListResponse(req, disk);
      }
    }

    return await sessionsListResponse(
      req,
      await refreshSessionsResponse(variant),
    );
  }

  // Deliver a follow-up prompt to an existing session. REST shape for the
  // native/extension clients (os1-ios, os1-chrome) and the web durable outbox.
  // It accepts the same attachments and sibling-session context as WS.
  // Same semantics as the opensession-sessions MCP send_to_session: steers a
  // busy run by default, `busy: "queue"` waits behind it, idle starts a fresh
  // turn.
  //
  // Unlike the WS frame this one ACKNOWLEDGES: the reply names where the
  // message landed (started/steered/queued/handled), which is what lets the
  // native outbox hold a send until the server has really taken it. Composer
  // parity with the WS path — images, the effort/fast pills, @-mention
  // pushes — lives here so a client can use this as its only send path.
  {
    const m = path.match(/^\/api\/sessions\/([^/]+)\/prompt$/);
    if (m && req.method === "POST") {
      const sessionId = decodeURIComponent(m[1]);
      const body = (await req.json().catch(() => null)) as {
        content?: unknown;
        prompt?: unknown;
        user?: unknown;
        busy?: unknown;
        images?: unknown;
        effort?: unknown;
        fastMode?: unknown;
        busyMode?: unknown;
        files?: unknown;
        contextSessions?: unknown;
        clientId?: unknown;
      } | null;
      const raw =
        typeof body?.content === "string" && body.content.trim()
          ? body.content
          : typeof body?.prompt === "string"
            ? body.prompt
            : "";
      const content = raw.trim();
      const images = parseImageDataUrls(body?.images);
      const imageUrls = asDataUrlList(body?.images);
      // An image-only send is a real message, so only reject an empty one.
      const files = Array.isArray(body?.files) ? body.files : undefined;
      if (!content && !images?.length && !files?.length) {
        return Response.json({ error: "content required" }, { status: 400 });
      }
      // The web composer stages images to disk and sends refs, so a retry can
      // outlive the staged file. Deliver the whole message or none of it: half
      // a message reads as an answered request, and the sender meant to attach
      // the picture. 400 is terminal for the outbox, which parks the item as
      // failed with Edit and Retry rather than looping.
      if ((images?.length ?? 0) < countImageRefs(body?.images)) {
        return Response.json(
          {
            error: "An attached image is no longer available. Attach it again.",
          },
          { status: 400 },
        );
      }
      const clientId =
        typeof body?.clientId === "string" && body.clientId.trim()
          ? body.clientId.trim().slice(0, 200)
          : undefined;
      // No synchronous cache gate: a just-created session may not be visible
      // in the projection yet. Delivery resolves the authoritative target.
      const session = await findSessionAsync(sessionId);
      const user = requestUser(ctx, body?.user);
      const busyMode =
        body?.busyMode === "queue" || body?.busy === "queue"
          ? "queue"
          : body?.busyMode === "steer"
            ? "steer"
            : undefined;
      const contextSessions = Array.isArray(body?.contextSessions)
        ? body.contextSessions.filter(
            (id): id is string => typeof id === "string",
          )
        : undefined;
      if (session) {
        maybePersistEffort(
          session,
          typeof body?.effort === "string" ? body.effort : undefined,
        );
        maybePersistFastMode(
          session,
          typeof body?.fastMode === "boolean" ? body.fastMode : undefined,
        );
      }
      const result = await getSessionControl().deliverToSession(
        sessionId,
        content,
        user,
        {
          busy: busyMode,
          hold: busyMode === "queue",
          images,
          imageUrls,
          files,
          contextSessions,
          ...(clientId ? { deliveryId: clientId } : {}),
        },
      );
      if (result.status === "error") {
        return Response.json(
          { ...result, error: result.message },
          { status: /no session/i.test(result.message) ? 404 : 400 },
        );
      }
      if (session && result.status !== "handled") {
        await unarchiveForHumanTurn(session);
      }
      if (session && !result.duplicate) {
        await notifyMentions(
          content,
          String(user || ""),
          sessionId,
          "prompt",
          session.title || "a session",
        );
      }
      const payload = {
        ...result,
        ...(clientId ? { clientId } : {}),
      };
      return Response.json(payload);
    }
  }

  // Durable lifecycle and metadata changes for a thin gateway or diagnostic
  // client. Transcript bodies keep using the transcript changeSeq endpoint;
  // this stream names ownership decisions, queue changes, asks and metadata.
  {
    const m = path.match(/^\/api\/sessions\/([^/]+)\/state-changes$/);
    if (m && req.method === "GET") {
      const sessionId = decodeURIComponent(m[1]);
      if (!(await findSessionAsync(sessionId)))
        return Response.json({ error: "Session not found" }, { status: 404 });
      const after = Math.max(
        0,
        Number(url.searchParams.get("after") || 0) || 0,
      );
      const limit = Math.min(
        500,
        Math.max(1, Number(url.searchParams.get("limit") || 200) || 200),
      );
      const runState = sessionRunStateProjection(sessionId);
      return Response.json({
        sessionId,
        changeSeq: runState.changeSeq,
        changes: await sessionChangesSince(sessionId, after, limit),
      });
    }
  }

  // Get transcript for a session
  if (
    path.match(/^\/api\/sessions\/(.+)\/transcript$/) &&
    req.method === "GET"
  ) {
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/transcript$/)![1],
    );
    const session = await findSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    // Engine-spanning read: the transcript file plus, for sessions with
    // pi history, the pi store (covers legacy pi
    // sessions from before transcript persistence, and migrated
    // sessions whose history spans engines). Classified on the way out,
    // like every other send site — this is what the native clients read.
    return Response.json(
      prepareEntriesForWire(await mergedSessionTranscriptAsync(session)),
    );
  }

  // One transcript entry, unclamped. The WS wire clamps giant entry contents
  // (clampEntriesForWire) — the bubble's "Show full message" fetches the real
  // thing here.
  {
    const m = path.match(/^\/api\/sessions\/(.+)\/entry\/([^/]+)$/);
    if (m && req.method === "GET") {
      const session = await findSessionAsync(decodeURIComponent(m[1]));
      if (!session)
        return Response.json({ error: "Session not found" }, { status: 404 });
      const entryId = decodeURIComponent(m[2]);
      // Transcript v2 (docs/transcripts.md §8): the store keeps the
      // full unstripped entry (blob when the stored row was bounded) —
      // consult it first; unknown ids and store failures fall through to
      // the legacy merged-transcript scan unchanged.
      try {
        const full = await transcript.getFullEntry(session.id, entryId);
        // content keeps its exact legacy shape; toolInput/images are
        // additive (existing clients ignore them) — they carry the
        // unstripped fields the bounded store row summarized away.
        if (full)
          return Response.json({
            // Same stripping the wire path applies, so expanding a
            // clamped notice doesn't suddenly reveal the sentinel and
            // "[Name] " prefix its folded form hid. The store row
            // carries no type; a user turn is the only kind that
            // arrives with delivery plumbing, and the detectors are
            // conservative enough to leave anything else alone.
            content: classifyEntry({
              id: entryId,
              type: "user",
              content: full.content,
              timestamp: "",
            }).content,
            toolInput: full.toolInput,
            images: full.images,
            featuredMedia: full.featuredMedia,
          });
      } catch {
        // store read failed — the legacy scan below still serves the entry
      }
      const found = (await mergedSessionTranscriptAsync(session)).find(
        (e) => e.id === entryId,
      );
      if (!found)
        return Response.json({ error: "Entry not found" }, { status: 404 });
      const entry = classifyEntry(found);
      return Response.json({
        content: entry.content,
        toolInput: entry.toolInput,
        images: entry.images,
        featuredMedia: entry.featuredMedia,
      });
    }
  }

  // Workspace overview: the opening prompt + all media (screenshots,
  // videos) across the workspace's member sessions — feeds the floating
  // preview panel in the session viewer. Images come back as
  // transcript-image refs (below), not inline base64.
  {
    const m = path.match(/^\/api\/workspaces\/([^/]+)\/overview$/);
    if (m && req.method === "GET") {
      const wsId = decodeURIComponent(m[1]);
      const members = (await getCachedSessionsAsync()).filter(
        (s) => s.workspaceId === wsId,
      );
      return Response.json(await buildWorkspaceOverview(members));
    }
  }

  // The same overview for ONE session, which is what a session's hover card
  // shows: its latest message and its own media. Scoping matters here. A
  // workspace overview answers with whichever member session spoke last, and
  // on a card headed by one session's title that is the wrong session's story.
  {
    const m = path.match(/^\/api\/sessions\/(.+)\/overview$/);
    if (m && req.method === "GET") {
      const session = await findSessionAsync(decodeURIComponent(m[1]));
      if (!session)
        return Response.json({ error: "session not found" }, { status: 404 });
      return Response.json(await buildWorkspaceOverview([session]));
    }
  }

  // One image out of a transcript entry, served as real bytes (decoded
  // from the base64 block) so the overview panel can lazy-load and the
  // browser can cache thumbnails instead of shipping data URLs in JSON.
  {
    const m = path.match(
      /^\/api\/sessions\/(.+)\/transcript-image\/([^/]+)\/(\d+)$/,
    );
    if (m && req.method === "GET") {
      const session = await findSessionAsync(decodeURIComponent(m[1]));
      if (!session)
        return Response.json({ error: "Session not found" }, { status: 404 });
      const entryId = decodeURIComponent(m[2]);
      const idx = parseInt(m[3], 10);
      let img = session.transcriptPath
        ? await resolveTranscriptImage(session.transcriptPath, entryId, idx)
        : null;
      // Transcript v2 fallback (docs/transcripts.md §1): entries
      // >32KB are stored with images[] replaced by "os-blob:<uuid>/<i>"
      // markers; the real data-URLs live in the store's full entry. When the
      // mirror can't resolve the image, decode it from there. Guarded on the
      // DB file existing — not the flag — so images keep serving through
      // kill-switch windows.
      if (!img) {
        try {
          const src = (await transcript.getFullEntry(session.id, entryId))
            ?.images?.[idx];
          if (typeof src === "string") {
            if (!src.startsWith("data:")) {
              img = { redirect: src };
            } else {
              const dm = src.match(/^data:([^;,]+);base64,(.*)$/s);
              if (dm) {
                const buf = Buffer.from(dm[2], "base64");
                img = {
                  bytes: buf.buffer.slice(
                    buf.byteOffset,
                    buf.byteOffset + buf.byteLength,
                  ) as ArrayBuffer,
                  contentType: dm[1],
                };
              }
            }
          }
        } catch {
          // store read failed — fall through to the 404 below
        }
      }
      if (!img)
        return Response.json({ error: "Image not found" }, { status: 404 });
      if ("redirect" in img) return Response.redirect(img.redirect, 302);
      return new Response(img.bytes, {
        headers: {
          "Content-Type": img.contentType,
          "Content-Length": String(img.bytes.byteLength),
          // A transcript entry never changes once written — cache hard.
          "Cache-Control": "private, max-age=86400, immutable",
        },
      });
    }
  }

  // Full-text search across session transcripts (the ⌘K palette's
  // "search in conversations"). Owned sessions live in transcript v2 and no
  // longer have mirror files, so their bounded rows are searched in a
  // read-only child process. The most recent 1,000 sessions cover interactive
  // recall without turning each keystroke into a scan of the 6+ GB database;
  // `truncated` keeps that ceiling explicit for a future FTS cutover. Legacy
  // transcripts retain the ripgrep pre-pass and clean-snippet validation.
  if (path === "/api/sessions/search" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (q.length < 2) return Response.json({ matches: [] });
    const sessions = await getCachedSessionsAsync();
    const recentIds = sessions
      .slice()
      .sort(
        (a, b) =>
          (Date.parse(b.lastActivity || "") || 0) -
          (Date.parse(a.lastActivity || "") || 0),
      )
      .slice(0, 1_000)
      .map((session) => session.id);
    const stored = await searchStoredTranscripts(q, recentIds, req.signal);
    const matches = stored.matches.slice(0, 50);
    const matchedIds = new Set(matches.map((match) => match.id));

    const byPath = new Map<string, string>(); // transcriptPath → sessionId
    for (const session of sessions) {
      if (
        session.transcriptPath &&
        !byPath.has(session.transcriptPath) &&
        existsSync(session.transcriptPath)
      )
        byPath.set(session.transcriptPath, session.id);
    }
    if (matches.length < 50) {
      for (const file of await ripgrepFiles(q, [...byPath.keys()])) {
        const id = byPath.get(file);
        if (!id || matchedIds.has(id)) continue;
        const snippet = transcriptMatchSnippet(file, q);
        if (snippet) {
          matches.push({ id, snippet });
          matchedIds.add(id);
        }
        if (matches.length >= 50) break;
      }
    }
    return Response.json({
      matches,
      truncated:
        stored.exhausted !== null ||
        stored.searchedSessions < recentIds.length ||
        (sessions.length > recentIds.length && matches.length < 50),
    });
  }

  // Every sub-agent this session spawned (pi task-tool children +
  // Claude-SDK subagent layout) — feeds the Agents tab's sub-agents card.
  {
    const m = path.match(/^\/api\/sessions\/(.+)\/subagents$/);
    if (m && req.method === "GET") {
      const session = await findSessionAsync(decodeURIComponent(m[1]));
      if (!session)
        return Response.json({ error: "Session not found" }, { status: 404 });
      return Response.json({
        subagents: session.transcriptPath
          ? listSubagents(session.transcriptPath)
          : [],
        sessionRunning: session.isRunning,
      });
    }
  }

  // Sub-agent (Task/Agent) conversation for a session. The agentId is either
  // a Task tool_result's `agentId` (Claude SDK layout) or an pi child
  // session id (ses_…) from the task tool / the subagents list above.
  {
    const m = path.match(/^\/api\/sessions\/(.+)\/subagent\/([^/]+)$/);
    if (m && req.method === "GET") {
      const session = await findSessionAsync(decodeURIComponent(m[1]));
      if (!session)
        return Response.json({ error: "Session not found" }, { status: 404 });
      const agentId = decodeURIComponent(m[2]);
      const sub = session.transcriptPath
        ? await getSubagentTranscript(session.transcriptPath, agentId)
        : null;
      if (!sub)
        return Response.json({ error: "Sub-agent not found" }, { status: 404 });
      return Response.json({ ...sub, sessionRunning: session.isRunning });
    }
  }

  // Bulk-archive idle sessions
  if (path === "/api/sessions/archive-old" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const days = Math.max(1, parseInt(body.days) || 7);
    const count = archiveOlderThan(await getSessionListSnapshotAsync(), days);
    invalidateSessionsCache();
    return Response.json({ archived: count });
  }

  // Archive / unarchive a single session
  const archiveMatch = path.match(/^\/api\/sessions\/(.+)\/archive$/);
  if (archiveMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(archiveMatch[1]);
    const session = await findSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const archived = body.archived !== false;
    // Archiving means "I'm done with this" — so stop an owned in-flight
    // run rather than leaving an orphaned turn burning tokens after the
    // session already reads as archived. Only runs owned by this process
    // (busyHere) are stoppable; external/CLI runs can't be reached from
    // here. Graceful Esc-style stop (fall back to hard cancel for runs
    // with no interrupt support) keeps the transcript clean and resumable
    // on unarchive.
    let stoppedRun = false;
    if (
      archived &&
      isAgentSessionBusy(
        session.claudeSessionId,
        session.codexThreadId,
        session.id,
      )
    ) {
      const target = sessionKernel(session.id).runStateProjection();
      const targetRunId =
        target.currentRunId ||
        (target.state === "starting" || target.state === "preparing"
          ? currentAgentRunToken(session.id)
          : undefined);
      if (targetRunId) {
        try {
          await requestTurnCancel(session.id, session, {
            cancelId: `archive-stop:${session.id}:${targetRunId}:${target.generation}`,
            expectedRunId: targetRunId,
            expectedGeneration: target.generation,
            source: "archive",
          });
          audit({
            msg: "run_cancelled",
            session_id: session.id,
            source: "archive",
          });
          stoppedRun = true;
        } catch {
          // The actor fences cancels by run id + generation; losing the race
          // (the run settled between our busy check and prepare) throws out
          // of requestTurnCancel. That must not fail the archive — the usual
          // case is the run having finished anyway.
        }
      }
    }
    await executeArchiveOverrideProjection(sessionId, () =>
      setArchived(sessionId, archived),
    );
    // Plain done-tickets are archived via a file-level flag, not the
    // registry; clearing only the registry would leave them archived. On
    // unarchive, also clear the file flag so the session returns to "My
    // sessions".
    if (!archived) clearSessionFileArchive(sessionId);
    invalidateSessionsCache();
    if (archived) {
      // setArchived drops the plain id pin; also drop legacy alias-id pins,
      // and the workspace pin once its last live session is archived (else the
      // row resurfaces in Pinned when a new session joins the workspace).
      unpinArchivedSessions([session], await getSessionListSnapshotAsync());
    }
    return Response.json({ ok: true, stoppedRun });
  }

  // Rename a session (manual display title; empty/blank clears it back to
  // the derived title). Works for any source via the override registry.
  const titleMatch = path.match(/^\/api\/sessions\/(.+)\/title$/);
  if (titleMatch && req.method === "PUT") {
    const sessionId = decodeURIComponent(titleMatch[1]);
    const session = await findSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const title =
      typeof body?.title === "string" ? body.title.trim().slice(0, 80) : "";
    await executeSessionProjection(sessionId, "title_override", () =>
      setTitleOverride(sessionId, title || null),
    );
    invalidateSessionsCache();
    return Response.json({ ok: true });
  }

  // Set (or clear) a session's manual sidebar-lane. `status` is one of the
  // lane keys (needsinput/inprogress/review/merged/pending); null/invalid
  // clears the override back to the derived lane.
  const statusMatch = path.match(/^\/api\/sessions\/(.+)\/status$/);
  if (statusMatch && req.method === "PUT") {
    const sessionId = decodeURIComponent(statusMatch[1]);
    const session = await findSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const status = isManualStatus(body?.status) ? body.status : null;
    await executeSessionProjection(sessionId, "status_override", () =>
      setStatusOverride(sessionId, status),
    );
    invalidateSessionsCache();
    return Response.json({ ok: true });
  }

  // Set (or clear) a session's review request — the info panel's Reviewer
  // picker. `reviewer` is a teammate display name or configured review-team
  // GitHub spec; null/empty clears the
  // request. Setting one pushes a "needs your review" notification to the
  // reviewer's registered devices (mirrors the needs-input ask push).
  const reviewMatch = path.match(/^\/api\/sessions\/(.+)\/review$/);
  if (reviewMatch && req.method === "PUT") {
    const sessionId = decodeURIComponent(reviewMatch[1]);
    const session = await findSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const by = requestUser(ctx, body?.by).slice(0, 40);
    // A unified session can inherit a request stored before deduplication under
    // one of its historical ids. Every mutation must resolve and remove those
    // keys too, or clearing the canonical id leaves the sidebar request alive.
    const reviewAliases = [
      ...(session.aliasIds || []),
      ...(session.id === sessionId ? [] : [sessionId]),
    ];

    // Accept / reopen the current request (the reviewer signing off). Keeps
    // the reviewer assignment intact but flips it to a "Reviewed" state that
    // the asker sees in their sidebar. Distinct from setting/clearing a
    // reviewer below, so it never touches GitHub's Reviewers list.
    if (typeof body?.accept === "boolean") {
      const existing = getReviewRequest(session.id, reviewAliases);
      if (!existing)
        return Response.json(
          { error: "No review request to accept" },
          { status: 400 },
        );
      setReviewAccepted(
        session.id,
        body.accept
          ? { by: by || "someone", at: new Date().toISOString() }
          : null,
        reviewAliases,
      );
      invalidateSessionsCache();
      // Buzz whoever asked for the review that it landed (not on self-review).
      if (
        body.accept &&
        existing.by &&
        existing.by.toLowerCase() !== (by || "").toLowerCase()
      ) {
        void (async () => {
          try {
            const { sendPushToUser } = await import("../../server/push");
            await sendPushToUser(existing.by, {
              title: "Review complete",
              body: `${by || "Someone"} reviewed ${session.title || sessionId}`.slice(
                0,
                180,
              ),
              url: `/session/${encodeURIComponent(sessionId)}`,
              tag: `review-${sessionId}`,
            });
          } catch {}
        })();
      }
      return Response.json({ ok: true });
    }

    const reviewer =
      typeof body?.reviewer === "string"
        ? body.reviewer.trim().slice(0, 120)
        : "";
    const prevReviewer = getReviewRequest(session.id, reviewAliases)?.to;
    const reviewTeam = reviewTeamFor(reviewer);
    const previousReviewTeam = reviewTeamFor(prevReviewer);
    // Mirror the request onto GitHub's own Reviewers list before committing the
    // local assignment, so an auth/API failure cannot leave the two disagreeing.
    // setting a reviewer adds them, re-assigning swaps, clearing removes.
    // Only for sessions with a branch/PR whose reviewer maps to a GitHub
    // login — a phone buzz always fires below regardless.
    const addLogin = reviewer
      ? reviewTeam?.github || githubLoginFor(reviewer)
      : null;
    const removeLogin =
      prevReviewer && prevReviewer !== reviewer
        ? previousReviewTeam?.github ||
          (/^[\w.-]+\/[\w.-]+$/.test(prevReviewer)
            ? prevReviewer
            : githubLoginFor(prevReviewer))
        : null;
    const target = resolvePrTarget(session, body?.repo);
    // Hosts without a reviewer concept (code.storage) have nothing to mirror
    // onto — the internal review request stands on its own there instead of
    // dying on the host round-trip. GitHub repos are unaffected (always true).
    const hostReviewers = target
      ? prHostFor(getRepo(target.repoId)).capabilities.reviewers
      : false;
    // Whether the reviewer actually reached GitHub's list — false when there
    // was no PR to mirror onto, which the push marker below depends on.
    let mirroredToGithub = false;
    // What has to change on GitHub's Reviewers list. Clearing a session with
    // no request of its own withdraws GitHub's own pending requests instead:
    // the chip reports those as the same "somebody is waiting on you" state
    // (WorkspaceInfo's ReviewerChip falls back to them), and this is the only
    // way to take one down from here. Read as the service identity, so a clear
    // with nothing on GitHub to remove never demands a personal credential.
    const removeSpecs = new Set(removeLogin ? [removeLogin] : []);
    if (!reviewer && !prevReviewer && target && hostReviewers) {
      const specs = await prReviewerSpecs(target.branch, target.ghRepo).catch(
        () => null,
      );
      for (const spec of specs || []) removeSpecs.add(spec);
    }
    if (target && hostReviewers && (addLogin || removeSpecs.size)) {
      const credential = githubMutationCredential(ctx);
      // No personal credential only actually blocks this when there is a PR
      // to mirror onto: `target` comes from branch metadata alone, so most
      // sessions reaching here have nothing on GitHub to change. Ask (as the
      // service identity — a read) before refusing, so an expired GitHub
      // connection can't take the internal review request down with it.
      // Fails closed: if we can't establish there's no PR, we still refuse.
      if (!credential) {
        const existing = await prMetaForBranch(
          target.branch,
          target.ghRepo,
        ).catch(() => "unknown" as const);
        if (existing !== null) return githubCredentialRequiredResponse();
      } else {
        const mirrored = await editPrReviewers(
          target.branch,
          { add: addLogin, remove: [...removeSpecs] },
          target.ghRepo,
          credential,
        ).catch((e: any) => ({ error: e?.message || String(e) }));
        // Same reasoning the other way round: `gh pr edit` answering "no
        // pull requests found" is an answer, not a failure — nothing to
        // mirror, so the local request stands on its own. Every other
        // error still blocks, so a PR that DOES exist can never silently
        // disagree with the request stored here.
        if ("error" in mirrored) {
          if (!isNoPrError(mirrored.error))
            return Response.json(mirrored, { status: 502 });
        } else mirroredToGithub = true;
      }
    }
    await executeSessionProjection(sessionId, "review_request", () =>
      setReviewRequest(
        session.id,
        reviewer
          ? {
              to: reviewTeam?.github || reviewer,
              ...(reviewTeam ? { recipients: reviewTeam.members } : {}),
              by: by || "someone",
              at: new Date().toISOString(),
            }
          : null,
        reviewAliases,
      ),
    );
    // The chip's GitHub fallback reads the bulk PR cache, which the throttled
    // sweep only refills every 10-30 minutes. Without a write-through, a clear
    // that did reach GitHub still leaves the reviewers on screen.
    if (!reviewer && mirroredToGithub && target)
      markCachedPrReviewRequestsCleared(target.ghRepo, target.branch);
    invalidateSessionsCache();
    if (reviewer) {
      // Only suppress the watcher's own push when the request really landed on
      // GitHub; marking a skipped mirror would swallow a later genuine one.
      if (mirroredToGithub && target && addLogin) {
        for (const recipient of reviewTeam?.members || [reviewer])
          markPrReviewNotified(target.ghRepo, target.branch, recipient);
      }
      // Best-effort phone buzz — never let a push hiccup fail the request.
      void (async () => {
        try {
          const { sendPushToUser } = await import("../../server/push");
          await Promise.all(
            (reviewTeam?.members || [reviewer]).map((recipient) =>
              sendPushToUser(recipient, {
                title: "Needs your review",
                body: `${by || "Someone"} asked you to review ${session.title || sessionId}`.slice(
                  0,
                  180,
                ),
                url: `/session/${encodeURIComponent(sessionId)}`,
                tag: `review-${sessionId}`,
              }),
            ),
          );
        } catch {}
      })();
    }
    return Response.json({ ok: true });
  }

  // One session, in the shape the list would have given it.
  //
  // Until now the list WAS the only source of a session object, which is why
  // dropping rows from it (the ?archived= slices above) needs somewhere else
  // to go: a client that no longer carries every archived session can still
  // open one and get the whole thing. Alias-aware, because a session keeps
  // its historical ids and a link may name one of those.
  //
  // Last in the family on purpose — every more specific /api/sessions/…
  // route, here and in the modules ahead of this one, has already had its
  // refusal.
  {
    const m = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (m && req.method === "GET") {
      const sessionId = decodeURIComponent(m[1]);
      const session = await findSessionAsync(sessionId);
      if (!session)
        return Response.json({ error: "Session not found" }, { status: 404 });
      const signals = await sessionListRuntimeSignals();
      const context = sessionEnrichmentContext();
      const enriched = enrichSession(session, signals, context);
      const detail = enriched.workspaceId
        ? projectWorkspacePrRefs(
            enriched,
            indexedWorkspaceMemberSessions(enriched.workspaceId).map((member) =>
              enrichSessionPrRefs(member, {
                defaultRepoId: context.defaultRepoId,
                prsByRepo: context.prsByRepo,
                footerMatches: footerPrsFor(context.prsBySession, member),
              }),
            ),
          )
        : enriched;
      return Response.json(detail, {
        headers: { "Cache-Control": "private, no-cache" },
      });
    }
  }

  // Delete a session (+ optional worktree cleanup)
  if (path.match(/^\/api\/sessions\/(.+)$/) && req.method === "DELETE") {
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)$/)![1],
    );
    const session = await findSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });

    const cleanWorktree = url.searchParams.get("worktree") === "true";
    // Purge any transcript-v2 store rows for a deleted session. Guarded on
    // the DB file existing — NOT the flag — so a kill-switch window can't
    // leave resurrectable rows behind for deterministic session ids
    // (bks-ghpr-*). Best-effort: a store hiccup must never block deletion.
    const purgeTranscriptRows = async (id: string) => {
      try {
        await deleteSessionTranscript(id);
      } catch {}
      try {
        searchIndex().remove(`session:${id}`);
      } catch {}
    };
    const finishDeletion = async () => {
      // Runner workspace deletion is opt-in on the Runner. It remains
      // best-effort so an offline machine never blocks deleting a session.
      if (session.runner && session.repo && session.worktreeDir) {
        void cleanupRunnerWorkspace({
          runnerId: session.runner.id,
          sessionId: session.id,
          repo: session.repo,
          workspacePath: session.worktreeDir,
          user: session.createdBy || undefined,
        }).catch((error) =>
          console.warn(
            `[runners] Workspace retained after deleting ${session.id}:`,
            error,
          ),
        );
      }
      await purgeTranscriptRows(session.id);
      invalidateSessionsCache();
      // Tear down the session's sandbox (container + engine-state volumes,
      // and in volume-workspace mode the workspace volume itself; that data
      // loss is the mode's documented contract). Best-effort and detached:
      // a docker hiccup must never block the delete.
      destroySessionSandbox(session, "delete");
      // If that was the workspace's last session, delete the workspace too.
      // Otherwise auto-wrapped 1:1 workspaces linger as undeletable empty
      // sidebar rows. PR-backed workspaces (`key`) stay because they regroup new
      // sessions for the same PR.
      if (session.workspaceId) {
        const ws = getWorkspace(session.workspaceId);
        const members = (await getSessionListSnapshotAsync()).filter(
          (s) => s.id !== session.id && s.workspaceId === session.workspaceId,
        );
        if (ws && !ws.key && members.length === 0) deleteWorkspace(ws.id);
      }
      if (cleanWorktree && session.worktreeDir && session.branch) {
        await removeWorktree(
          session.branch,
          repoForPath(session.worktreeDir).id,
        );
        // A session can span repos, and each one it spans has a checkout
        // of its own. Cleaning up only the first would leave the rest on
        // disk for the reaper to find days later.
        for (const attached of session.attachedRepos || [])
          if (attached.branch)
            await removeWorktree(attached.branch, attached.repo);
      }
    };

    // An older delete path could write the permanent tombstone before removing
    // the session file. That leaves a visible ghost which the mailbox correctly
    // refuses to mutate. Finish that already-authorized deletion without trying
    // to re-enter its permanently closed mailbox.
    const recoverTombstonedDeletion = async () => {
      try {
        removeTombstonedSessionArtifacts(session);
        await finishDeletion();
        return Response.json({ ok: true });
      } catch (e: any) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    };
    if (await sessionTombstoneState(session.id))
      return recoverTombstonedDeletion();

    const deleteRequestId = `delete:${session.id}`;
    let deleteExecuting = false;
    let deletePhysicalFinished = false;
    try {
      const plan = await sessionGatewayCommand({
        op: "request",
        sessionId: session.id,
        requestId: deleteRequestId,
        operation: "delete_session",
        identity: { cleanWorktree },
      });
      if (plan.status === "in_progress")
        throw Object.assign(
          new Error("Session deletion is already in progress"),
          {
            retryable: true,
          },
        );
      if (plan.status === "completed") {
        const replay = plan.result as { status: number; body: unknown };
        return Response.json(replay.body, { status: replay.status });
      }
      deleteExecuting = true;
      const result = await withSessionMutationLock(session.id, async () => {
        try {
          const runIds = [
            session.claudeSessionId,
            session.codexThreadId,
            session.id,
          ];
          if (
            runIds.some((id) => !!id && isAgentSessionBusy(id!)) &&
            !(await cancelAgentRunAndWait(runIds))
          ) {
            return {
              status: 409,
              body: {
                error: "The session is still stopping. Retry deletion shortly.",
              },
            };
          }
          // Local Portals are their own detached process groups. Stop them before
          // deleting session metadata or optionally removing the worktree.
          if (session.runner)
            await dropRunnerPortalRoutes(
              session.id,
              session.runner.id,
              session.startedBy || undefined,
            );
          else if (session.worktreeDir && !session.sandbox?.sandboxId)
            await stopAllPortalServices({
              sessionId: session.id,
              worktreeDir: session.worktreeDir,
            });
          // The serialized delete must remove the file before its permanent tombstone.
          // Tombstoning first drops this active kernel from the map, so deleteSession's
          // nested compatibility write re-enters through a fresh kernel and is fenced
          // as a late writer, leaving a visible but immutable ghost session behind.
          await deleteSession(session);
          await tombstoneSessionKernel(session.id);
          await finishDeletion();
          return { status: 200, body: { ok: true } };
        } catch (e: any) {
          return { status: 500, body: { error: e.message } };
        }
      });
      deletePhysicalFinished = true;
      await sessionGatewayCommand({
        op: "complete",
        sessionId: session.id,
        requestId: deleteRequestId,
        operation: "delete_session",
        result,
      });
      return Response.json(result.body, { status: result.status });
    } catch (error) {
      if (deleteExecuting && !deletePhysicalFinished)
        await sessionGatewayCommand({
          op: "fail",
          sessionId: session.id,
          requestId: deleteRequestId,
          operation: "delete_session",
          error: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
      // A concurrent delete can write the tombstone after the check above but
      // before this request reaches the mailbox. Treat that race as the same
      // idempotent recovery instead of surfacing a false failure.
      if (await sessionTombstoneState(session.id))
        return recoverTombstonedDeletion();
      throw error;
    }
  }

  return undefined;
}
