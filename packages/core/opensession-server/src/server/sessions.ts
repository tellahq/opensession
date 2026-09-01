import { executeSessionProjection } from "./session-projection-executor";
import {
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { opendir } from "fs/promises";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { statePath } from "./paths";
import { existsSync } from "fs";
import { slackIdToFirstName } from "./shared/user-mappings";
import { isArchivedId, getArchiveReason } from "./archive";
import { purgeDraftsForSessions } from "./drafts";
import { removeSessionScratch } from "./session-scratch";
import { releasePreviewPathLease } from "./preview-path-leases";
import { getTitleOverride } from "./title-overrides";
import { getStatusOverride } from "./status-overrides";
import { getReviewRequest } from "./review-requests";
import { getGeneratedTitle } from "./generated-titles";
import { ensureSessionWorkspaces } from "./session-workspace";
import { warmWorkspaceNamesAsync } from "./workspaces";
import { findCodexRollout } from "./codex-accounts";
import { providerFor } from "./models";
import { parseTranscript, parseTranscriptAsync } from "./jsonl-parser";
import type { SeqEntry } from "./transcript-store";
import { importLegacyTranscript, transcript } from "./actor-transcript";
import {
  isTranscriptStoreDegraded,
  clearTranscriptStoreDegraded,
  sessionForEngineId,
} from "./transcript-persistence";
import { activeRunRecords } from "./run-journal";
import { configuredRepos, defaultRepo } from "./config";
import {
  prWorkspaceReader,
  sessionPrBranch,
  shareWorkspacePrRefs,
} from "./session-pr-target";
import { readPrState } from "../agents/github/state";
import {
  getPrsByRepo,
  prsBySessionRef,
  footerPrsFor,
  lastReviewSummary,
  type PrInfo,
} from "./pr-cache";
import type {
  UnifiedSession,
  SlackSessionFile,
  LinearSessionFile,
  CLISessionFile,
  NativeSessionFile,
  SessionPrRef,
  TranscriptEntry,
} from "./types";
import { removeIndexedSession } from "./session-list-store";

// The GitHub PR bulk cache lives in pr-cache.ts (extracted from this module);
// re-export its public surface so existing consumers keep importing from here.
export {
  sessionRefFromPrBody,
  loadPrCacheSnapshot,
  markCachedPrClosed,
  markCachedPrMerged,
  markCachedPrReviewed,
  markCachedPrReviewRequestsCleared,
  cachedPrBranchByNumber,
  applyPrWebhookToBulkCache,
  refreshPrCache,
  getRecentPrs,
  getRecentPrsForPerson,
  getPrReviewStatus,
  getOpenPrs,
  type OpenPrEntry,
  type RecentPrEntry,
} from "./pr-cache";

// Agent-owned session stores. Resolved through statePath so they follow the
// SAME isolation knob as every other store: unset OPENSESSION_STATE_DIR ⇒
// $HOME (production, unchanged), set ⇒ under that root. Without this a
// dev/demo instance listed the operator's real Slack/Linear history next to
// its own — 159 live threads showed up in a demo instance meant to hold 9
// synthetic sessions (2026-08-05).
const SLACK_SESSIONS_DIR = statePath(".slack-sessions");
const LINEAR_SESSIONS_DIR = statePath(".linear-sessions");
const CLI_SESSIONS_DIR = statePath(".claude/sessions");
const SESSIONS_DIR = OPENSESSION_SESSIONS_DIR;
const CLAUDE_PROJECTS_DIR = statePath(".claude/projects");

const SKIP_FILES = new Set([
  "worktree-channels.json",
  "message-queue.json",
  "active-worktrees.json",
  "prompt-queues.json",
  "active-at-shutdown.json",
  "active-runs.json",
  "processed-events.json",
]);

/** Which archive half a scan should return. `include` is the legacy/internal
 * whole-list contract; request paths use the narrower halves. */
export type SessionArchiveSlice = "include" | "exclude" | "only";

function inArchiveSlice(
  archived: boolean,
  slice: SessionArchiveSlice,
): boolean {
  if (slice === "include") return true;
  return slice === "only" ? archived : !archived;
}

function resolveSlackUser(userId: string): string {
  // Could be a Slack user ID (e.g. UT41L6GCC) or already a display name
  const mapped = slackIdToFirstName(userId);
  if (mapped) return mapped;
  // Extract first name from "Firstname Lastname" format
  if (userId.includes(" ")) return userId.split(" ")[0];
  return userId;
}

export function getTranscriptPath(
  worktreeDir: string,
  sessionId: string,
): string {
  const hash = worktreeDir.replaceAll("/", "-").replace(/^-/, "");
  return `${CLAUDE_PROJECTS_DIR}/-${hash}/${sessionId}.jsonl`;
}

export function getEngineTranscriptPath(
  worktreeDir: string,
  engineSessionId: string,
  provider: "claude" | "codex" | "pi",
): string | null {
  if (provider === "codex") {
    return findCodexRollout(engineSessionId)?.path || null;
  }
  // Pi has no per-session file at all: the pi runner persists every turn
  // straight into the owned transcript store (viewers stream over the store
  // bus, readers go through readEngineTranscript's pi branch below).
  if (provider === "pi") return null;
  return getTranscriptPath(worktreeDir, engineSessionId);
}

/**
 * A session's engine transcript as entries, whatever the engine: claude jsonl
 * and codex rollouts parse from their transcript file; pi reads straight
 * out of Pi's SQLite store. This is the source for cross-engine handoff
 * notes (buildEngineSwitchHandoffNote) in BOTH directions — including the
 * previously-stubbed pi→claude/codex direction.
 */
export function readEngineTranscript(
  worktreeDir: string,
  engineSessionId: string,
  provider: "claude" | "codex" | "pi",
): TranscriptEntry[] {
  if (provider === "pi") return engineStoreTranscript(engineSessionId);
  const path = getEngineTranscriptPath(worktreeDir, engineSessionId, provider);
  if (!path || !existsSync(path)) return engineStoreTranscript(engineSessionId);
  return parseTranscript(path);
}

/** readEngineTranscript with the file parse yielding to the event loop —
 *  identical output. The pi SQLite read stays sync (bounded pages),
 *  and so does the pi store read (same bounded store pages). */
export async function readEngineTranscriptAsync(
  worktreeDir: string,
  engineSessionId: string,
  provider: "claude" | "codex" | "pi",
): Promise<TranscriptEntry[]> {
  if (provider === "pi") return engineStoreTranscriptAsync(engineSessionId);
  const path = getEngineTranscriptPath(worktreeDir, engineSessionId, provider);
  if (!path || !existsSync(path))
    return engineStoreTranscriptAsync(engineSessionId);
  return parseTranscriptAsync(path);
}

/** Recent engine history for a bounded context handoff. Store-only engines
 * must not hydrate their complete transcript here: the note consumes at most
 * 180 KB, while a long-running session can hold tens of thousands of rows and
 * gigabytes of full tool-result blobs. Engine-native files still parse
 * cooperatively; their parser does not block the gateway thread. */
export async function readEngineHandoffTranscriptAsync(
  worktreeDir: string,
  engineSessionId: string,
  provider: "claude" | "codex" | "pi",
): Promise<TranscriptEntry[]> {
  if (provider === "pi")
    return engineStoreHandoffTranscriptAsync(engineSessionId);
  const path = getEngineTranscriptPath(worktreeDir, engineSessionId, provider);
  if (!path || !existsSync(path))
    return engineStoreHandoffTranscriptAsync(engineSessionId);
  return parseTranscriptAsync(path);
}

/**
 * A STORE-ONLY engine session's transcript as entries — pi, and the removed
 * direct-SDK engines' historical sessions (claude-direct, codex-direct),
 * which must stay readable. None of them has an
 * engine-owned store to read: no jsonl, no codex rollout, no SQLite. They
 * persist every turn into the owned transcript store under the UNIFIED session
 * id, so this resolves the owning session from the ENGINE id and serves its
 * merged transcript (store-first, legacy merge fallback) — the same read
 * engine-handoff-transcript.ts uses for fresh-engine recovery. Feeds the
 * cross-engine handoff notes in the store-only→anything direction;
 * unresolvable ids return [] and the handoff degrades to the "partial work may
 * exist" note.
 *
 * The main consumer is the mid-turn fallback hop (agent-runner), which can
 * read while the 2s session cache still predates the init patch — or, once
 * the dead run unwound, after the runner's finally already journal-cleared its
 * record. So the owner resolves through sources in durability-at-read-time
 * order:
 *  1. the run journal — live for the whole turn (these engines journal their
 *     engine id in the claudeSessionId slot, legacy name, with the owning
 *     osSessionId);
 *  2. the persisted engine→unified map (sessionForEngineId — recorded before the
 *     runner ever yields init, and never cleared on run end);
 *  3. the session scan — every engine slot, including a claude-slot match for
 *     slack/linear files whose pi id predates the pi slot there (equality on
 *     the uuid can only mean this engine session; ses_/claude ids of other
 *     sessions never collide with one of these uuids).
 */
function engineStoreOwner(engineSessionId: string): UnifiedSession | undefined {
  if (!engineSessionId) return undefined;
  try {
    // Call-time require, not a static import: session-cache imports this
    // module (getAllSessions), so the static edge must stay one-directional.
    // By the time a transcript is read the cache module is long-loaded —
    // this is a module-cache hit (the importLegacyIntoStore pattern in
    // pi-transcript.ts).
    const cacheMod =
      require("./session-cache") as typeof import("./session-cache");
    const sessions = cacheMod.getCachedSessions();
    const byUnifiedId = (unifiedId: string | undefined) =>
      unifiedId
        ? sessions.find(
            (s) => s.id === unifiedId || s.aliasIds?.includes(unifiedId),
          )
        : undefined;
    const journaled = activeRunRecords().find(
      (r) => r.claudeSessionId === engineSessionId && r.osSessionId,
    );
    return (
      byUnifiedId(journaled?.osSessionId) ??
      byUnifiedId(sessionForEngineId(engineSessionId)) ??
      sessions.find(
        (s) =>
          s.piSessionId === engineSessionId ||
          s.codexThreadId === engineSessionId ||
          s.claudeSessionId === engineSessionId,
      )
    );
  } catch (e) {
    console.warn(
      `[sessions] engine store owner resolution failed for ${engineSessionId}:`,
      e instanceof Error ? e.message : e,
    );
    return undefined;
  }
}

function engineStoreTranscript(engineSessionId: string): TranscriptEntry[] {
  const owner = engineStoreOwner(engineSessionId);
  return owner ? mergedSessionTranscript(owner) : [];
}

async function engineStoreTranscriptAsync(
  engineSessionId: string,
): Promise<TranscriptEntry[]> {
  const owner = engineStoreOwner(engineSessionId);
  return owner ? mergedSessionTranscriptAsync(owner) : [];
}

/** The handoff renderer clips each conversational row to 8 KB and the whole
 * note to 180 KB. Read a bounded actor page and never resolve full_ref blobs
 * for history the renderer will discard. */
async function engineStoreHandoffTranscriptAsync(
  engineSessionId: string,
): Promise<TranscriptEntry[]> {
  const owner = engineStoreOwner(engineSessionId);
  if (!owner || owner.id.startsWith("plain-")) return [];
  try {
    return (await transcript.readHandoffTail(owner.id)).entries;
  } catch (e) {
    console.warn(
      `[sessions] engine handoff transcript read failed for ${engineSessionId}:`,
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}

type TranscriptSessionRef = Pick<UnifiedSession, "transcriptPath"> & {
  id?: string;
};

/** Full UI transcript, preferring the owned store and falling back to an
 * external engine transcript file while legacy imports finish. */
export function mergedSessionTranscript(
  session: TranscriptSessionRef,
): TranscriptEntry[] {
  return session.transcriptPath ? parseTranscript(session.transcriptPath) : [];
}

export async function mergedSessionTranscriptAsync(
  session: TranscriptSessionRef,
): Promise<TranscriptEntry[]> {
  if (session.id && !session.id.startsWith("plain-")) {
    try {
      const served = await v2StoreTranscript(session.id, session);
      if (served) return served;
    } catch (error) {
      console.warn(
        `[sessions] transcript store read failed for ${session.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return session.transcriptPath
    ? await parseTranscriptAsync(session.transcriptPath)
    : [];
}

/** External transcript files whose growth can require a store re-import. */
export function v2MirrorFiles(
  session: TranscriptSessionRef,
): { path: string; size: number }[] {
  if (!session.transcriptPath) return [];
  try {
    return [
      {
        path: session.transcriptPath,
        size: statSync(session.transcriptPath).size,
      },
    ];
  } catch {
    return [];
  }
}

// ── Transcript store read path ───────────────────────────────────────────────

/**
 * Every stored entry for the session, ascending seq (paged readSince),
 * hydrated to FULL forms in bounded actor pages. Blob joins and byte accounting
 * happen inside the read-only actor operation, avoiding one RPC per entry.
 * This feeds FTS distill / get_session / the HTTP transcript route — not the WS
 * hot path — and legacy served those consumers unstripped content; wire-level
 * clamping stays the serializers' job (clampEntriesForWire at send sites).
 */
async function v2ReadAll(sessionId: string): Promise<TranscriptEntry[]> {
  const out: SeqEntry[] = [];
  let since = 0;
  for (;;) {
    const page = await transcript.readHydratedSince(sessionId, since);
    out.push(...page.entries);
    if (page.complete) break;
    if (page.coveredThroughSeq <= since)
      throw new Error(
        `Hydrated transcript page made no progress for ${sessionId}`,
      );
    since = page.coveredThroughSeq;
  }
  return out;
}

/**
 * §8 staleness decision, shared by the store read path below and ws-handlers'
 * serveTranscriptV2. True = the store can't be trusted for this session:
 * either the failure-side store-degraded flag is set (a store append failed
 * or was skipped — with mirror writes retired that flag is the ONLY signal
 * for owned-session gaps), or a legacy candidate file grew beyond the import
 * watermark — which, with oc mirrors frozen since the 2026-07-23 retirement,
 * means an EXTERNAL writer (claude/codex CLI transcriptPath) appended, or a
 * pre-retirement watermark gap that one idempotent re-import settles. The
 * dual-write tail probe that used to classify growth as "explained" was
 * deleted with the mirror writes; every unexplained-growth case now re-imports
 * (idempotent upserts keep original seqs), which also refreshes the watermark
 * so growth costs once per burst, not per read. Callers react to drift with a
 * full re-import + clearTranscriptStoreDegraded.
 */
export async function v2TranscriptHasDrift(
  store: Pick<typeof transcript, "getImportInfo">,
  sessionId: string,
  session: TranscriptSessionRef,
): Promise<boolean> {
  if (isTranscriptStoreDegraded(sessionId)) return true;
  const files = v2MirrorFiles(session);
  // No legacy files at all (every post-retirement session) → nothing to
  // drift against; the store is the only source.
  if (!files.length) return false;
  const info = await store.getImportInfo(sessionId);
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  return !(info?.watermark != null && totalSize <= info.watermark);
}

/**
 * §8 store-serve decision: entries from the store when imported and
 * drift-free; null → caller falls back to legacy; on drift this re-imports
 * (idempotent upserts) and returns the legacy merge for this call directly.
 */
async function v2StoreTranscript(
  sessionId: string,
  session: TranscriptSessionRef,
): Promise<TranscriptEntry[] | null> {
  if (await transcript.needsImport(sessionId)) return null;
  if (!(await v2TranscriptHasDrift(transcript, sessionId, session)))
    return v2ReadAll(sessionId);
  // Drift (§8): re-import (upserts keep original seqs, making this safe to
  // repeat) and serve legacy for THIS call. Watermark = candidate-set size
  // measured BEFORE the legacy parse — lines appended during the parse then
  // read as growth next time instead of being silently covered.
  const totalSize = v2MirrorFiles(session).reduce((sum, f) => sum + f.size, 0);
  const legacy = session.transcriptPath
    ? parseTranscript(session.transcriptPath)
    : [];
  const importInfo = await transcript.getImportInfo(sessionId);
  void importLegacyTranscript(
    sessionId,
    legacy,
    importInfo?.src || "merged",
    totalSize,
  )
    .then(() => {
      // The full re-import restored every entry the store had missed. Release
      // the failure marker only after actor completion.
      clearTranscriptStoreDegraded(sessionId);
    })
    .catch((error) => {
      console.warn(
        `[sessions] transcript v2 drift re-import failed for ${sessionId}:`,
        error instanceof Error ? error.message : error,
      );
    });
  return legacy;
}

/**
 * User texts already in a session's engine history, for
 * requeueSteerReceipts: a steer that shows up here landed durably (noReply
 * history append), so putting it back into the prompt queue on cancel would
 * deliver it twice.
 *
 * Store-first (mirror retirement prep): every caller holds a full
 * UnifiedSession, so `id` rides along and mergedSessionTranscript serves the
 * v2 store when the session is imported and drift-free — user entries come
 * back as FULL forms there (v2ReadAll hydrates clamped rows via getFullEntry,
 * so the exact-text dedup match still holds). Not imported / drifted /
 * flag-off / any error all land on the legacy merge exactly as before; `id`
 * stays optional so old callers (and runner closures pre-restart) keep
 * working unchanged.
 */
export async function engineUserTexts(session: {
  id?: string;
  transcriptPath?: string | null;
  claudeSessionId?: string | null;
}): Promise<string[]> {
  try {
    return (
      await mergedSessionTranscriptAsync({
        id: session.id,
        transcriptPath: session.transcriptPath ?? null,
      })
    )
      .filter((e) => e.type === "user")
      .map((e) => e.content.trim());
  } catch {
    return [];
  }
}

/**
 * User texts stranded at the TAIL of a session's engine history: user entries
 * after the last assistant/tool entry, i.e. messages no turn has responded to.
 * After an errored/aborted turn these are messages the model never read — a
 * busy-send steer lands as a noReply history append that only the turn's next
 * LLM step would have picked up (see ORPHANED_STEER_PROMPT). System chips
 * don't count as a response: the run-failure notice lands after the stranded
 * message and would otherwise mask it.
 */
export async function trailingUserTexts(session: {
  id?: string;
  transcriptPath?: string | null;
  claudeSessionId?: string | null;
}): Promise<string[]> {
  try {
    const entries = await mergedSessionTranscriptAsync({
      id: session.id,
      transcriptPath: session.transcriptPath ?? null,
    });
    let lastResponse = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const t = entries[i].type;
      if (t === "assistant" || t === "tool_use" || t === "tool_result") {
        lastResponse = i;
        break;
      }
    }
    return entries
      .slice(lastResponse + 1)
      .filter((e) => e.type === "user")
      .map((e) => e.content.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function engineSessionPatch(
  provider: "claude" | "codex" | "pi",
  engineSessionId: string,
): Partial<NativeSessionFile> {
  if (provider === "codex")
    return { codexThreadId: engineSessionId || undefined };
  if (provider === "pi") return { piSessionId: engineSessionId || undefined };
  return { claudeSessionId: engineSessionId || undefined };
}

export function engineSessionIdFor(
  session: {
    claudeSessionId?: string | null;
    codexThreadId?: string | null;
    piSessionId?: string | null;
  },
  provider: "claude" | "codex" | "pi",
): string | undefined {
  if (provider === "codex") return session.codexThreadId || undefined;
  if (provider === "pi")
    return session.piSessionId || session.claudeSessionId || undefined;
  return session.claudeSessionId || undefined;
}

function sessionEngineKeys(session: UnifiedSession): string[] {
  return [
    session.claudeSessionId ? `claude:${session.claudeSessionId}` : null,
    session.codexThreadId ? `codex:${session.codexThreadId}` : null,
    session.piSessionId ? `pi:${session.piSessionId}` : null,
  ].filter((key): key is string => !!key);
}

function findTranscriptPath(
  worktreeDir: string | null,
  sessionId: string | null,
): string | null {
  if (!sessionId) return null;
  if (worktreeDir) {
    const path = getTranscriptPath(worktreeDir, sessionId);
    if (existsSync(path)) return path;
  }
  // Fallback for old runs started directly from the user's home directory.
  const fallbacks = [
    `${CLAUDE_PROJECTS_DIR}/${(process.env.HOME || "").replaceAll("/", "-")}/${sessionId}.jsonl`,
  ];
  for (const path of fallbacks) {
    if (existsSync(path)) return path;
  }
  // Last resort: the recorded worktreeDir can drift from the cwd the run
  // actually used (e.g. a session migrated between repos), so the hashed
  // path above misses even though Claude did write a transcript. The session
  // id is globally unique, so scan every project folder for <id>.jsonl and
  // take the match. Only reached when the direct lookups all fail.
  return findTranscriptBySessionId(sessionId);
}

// Reverse index of every Claude transcript: session id → its .jsonl path.
// This is only the last resort after the current worktree and home-directory
// paths miss, so an absent or stale snapshot is safe. Production has enough
// historical project directories that rebuilding it synchronously can hold the
// gateway for seconds. Serve the last completed snapshot immediately and
// refresh cooperatively in the background instead. Current transcripts still
// resolve through their direct path without waiting for this index.
let transcriptIndexCache: { map: Map<string, string>; ts: number } | null =
  null;
let transcriptIndexRefresh: Promise<void> | null = null;
const EMPTY_TRANSCRIPT_INDEX = new Map<string, string>();
const TRANSCRIPT_INDEX_TTL = 5 * 60_000;
function transcriptIndex(): Map<string, string> {
  if (
    !transcriptIndexCache ||
    Date.now() - transcriptIndexCache.ts >= TRANSCRIPT_INDEX_TTL
  ) {
    void warmTranscriptIndexAsync().catch((error) => {
      console.warn(
        "[sessions] transcript index refresh failed:",
        error instanceof Error ? error.message : error,
      );
    });
  }
  return transcriptIndexCache?.map ?? EMPTY_TRANSCRIPT_INDEX;
}

async function warmTranscriptIndexAsync(): Promise<void> {
  if (
    transcriptIndexCache &&
    Date.now() - transcriptIndexCache.ts < TRANSCRIPT_INDEX_TTL
  ) {
    return;
  }
  if (!transcriptIndexRefresh) {
    transcriptIndexRefresh = (async () => {
      const map = new Map<string, string>();
      let projects;
      try {
        projects = await opendir(CLAUDE_PROJECTS_DIR);
      } catch {
        projects = null;
      }
      try {
        if (projects)
          for await (const project of projects) {
            if (!project.isDirectory()) continue;
            let entries;
            try {
              entries = await opendir(`${CLAUDE_PROJECTS_DIR}/${project.name}`);
            } catch {
              continue;
            }
            let indexed = 0;
            for await (const entry of entries) {
              if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
              const id = entry.name.slice(0, -".jsonl".length);
              if (!map.has(id))
                map.set(
                  id,
                  `${CLAUDE_PROJECTS_DIR}/${project.name}/${entry.name}`,
                );
              if (++indexed % 256 === 0) await Bun.sleep(0);
            }
            // One project directory can hold thousands of transcripts. Yield
            // after each directory so a cold reverse-index build never delays a
            // WebSocket handshake behind a batch of large readdir calls.
            await Bun.sleep(0);
          }
      } catch {
        // The state root can change under tests and dev tooling. A partial
        // reverse index is safe; direct transcript paths still resolve.
      }
      transcriptIndexCache = { map, ts: Date.now() };
    })().finally(() => {
      transcriptIndexRefresh = null;
    });
  }
  await transcriptIndexRefresh;
}

function findTranscriptBySessionId(sessionId: string): string | null {
  return transcriptIndex().get(sessionId) ?? null;
}

/** External transcript path for legacy Claude/Codex sessions. Pi writes to
 * the owned transcript store and therefore has no transcript file. */
function resolveTranscriptPath(
  claudePath: string | null,
  codexThreadId: string | null | undefined,
  model: string | null | undefined,
): string | null {
  const codexPath = codexThreadId
    ? findCodexRollout(codexThreadId)?.path || null
    : null;
  return codexThreadId && providerFor(model) === "codex"
    ? codexPath || claudePath
    : claudePath || codexPath;
}

function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    // A missing file is normal; a corrupt one makes the session silently
    // vanish from the UI, so leave a trace.
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT")
      console.warn(`[sessions] Failed to parse ${path}:`, e);
    return null;
  }
}

function getFileMtime(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/** The sidecar fields overlaySidecarExtras must NOT overlay, because the
 *  scanned slack/linear source owns them. Each group says why. */
const SIDECAR_SOURCE_OWNED = new Set<string>([
  // The row's own identity. The unified id is minted by the scan
  // ("slack-<file>" / "linear-<branch>"), and source/isRunning/transcriptPath
  // are computed there — no stored file gets a say in them.
  "id",
  "source",
  "isRunning",
  "transcriptPath",
  // Engine linkage and the model driving it. A run on a slack/linear session
  // persists these back into the OWNING agent's session file
  // (syncAgentSessionEngine, agent-session-sync.ts), which is exactly what the
  // scans above read — so the scan already holds the current values and a
  // sidecar copy can only be an older one, pointing resume and transcript
  // resolution at a dead engine session.
  "claudeSessionId",
  "codexThreadId",
  "piSessionId",
  "model",
  // Where the session runs. The owning store decides that; a stale sidecar
  // copy would send the next run to a worktree the session left behind.
  "branch",
  "worktreeDir",
  // Who, what it's called, and when. The scan derives these from the owning
  // file (the Slack user, the Linear participants and issue title), and
  // touchNativeSession restamps lastActivity on EVERY sidecar write — so
  // overlaying it would let bookkeeping writes rewrite the session's activity
  // clock and reshuffle the sidebar. createdByLogin travels with createdBy so
  // a row never mixes one source's name with another's verified login.
  "createdBy",
  "createdByLogin",
  "title",
  "createdAt",
  "lastActivity",
]);

/**
 * Overlay natively-owned extras onto a slack/linear-scanned session.
 * touchNativeSession writes fields like walkthrough/linkedPrs keyed by the
 * UNIFIED id into ~/.opensession-sessions/<id>.json — for non-opensession sessions
 * that sidecar has no `id` field, so scanNativeSessions skips it and the
 * fields silently vanished from the unified view (publish_walkthrough on a
 * Slack session kept answering "no walkthrough on session" right after
 * persisting one).
 *
 * Carry-by-default: everything in the sidecar lands on the row except the
 * fields the scanned source owns (SIDECAR_SOURCE_OWNED, justified above). The
 * other direction — a hand-kept allowlist — reintroduced the very bug this
 * function exists to fix for each field nobody remembered to add: `slackThreads`
 * was written on every captured Slack post and dropped on every read, so the
 * dedup guard in run-session.ts always saw an empty list and rebuildIndex never
 * restored a Slack session's thread links after a restart.
 *
 * One field worth naming, since it reads as native-only: `workspaceId`.
 * Slack/Linear session files are read-only, so for those sources the workspace
 * link lives here in the sidecar (written by session-workspace.ts) rather than
 * in the session file itself.
 */
function overlaySidecarExtras(session: UnifiedSession): UnifiedSession {
  const path = `${SESSIONS_DIR}/${session.id}.json`;
  if (!existsSync(path)) return session;
  const data = readJsonSafe<NativeSessionFile>(path);
  if (!data) return session;
  const row = session as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || SIDECAR_SOURCE_OWNED.has(key)) continue;
    row[key] = value;
  }
  return session;
}

function slackSessionRow(file: string): UnifiedSession | null {
  if (!file.endsWith(".json") || SKIP_FILES.has(file)) return null;
  const path = `${SLACK_SESSIONS_DIR}/${file}`;
  const data = readJsonSafe<SlackSessionFile>(path);
  if (!data) return null;

  const branch = data.branch || file.replace(".json", "");
  const startedBy = data.userId ? resolveSlackUser(data.userId) : null;

  // Use a stable ID based on filename
  const id = `slack-${file.replace(".json", "")}`;
  const archived = isArchivedId(id);

  return overlaySidecarExtras({
    id,
    claudeSessionId: data.claudeSessionId || null,
    source: "slack",
    branch,
    worktreeDir: data.worktreeDir || null,
    createdBy: startedBy,
    startedBy,
    // The message that started the thread, when the loop recorded one.
    // `branch` is the last resort: for a thread/DM session it is the raw
    // `<channel>-<threadTs>` key, which is not a name anyone can read.
    title: data.title?.trim() || branch,
    lastActivity: data.lastActivity || data.createdAt || getFileMtime(path),
    createdAt: data.createdAt || getFileMtime(path),
    isRunning: false,
    transcriptPath: null,
    slackThread: data.channel
      ? { channel: data.channel, threadTs: data.threadTs || "" }
      : undefined,
    model: data.model,
    codexThreadId: data.codexThreadId || undefined,
    // Written by agent-session-sync when a web-UI run on a pi/* model minted
    // an engine session; without it every pi read falls to the claude-slot
    // ride and the run-start arm can't resume the pi session.
    piSessionId: data.piSessionId || undefined,
    archived: archived || undefined,
    archivedReason: archived ? getArchiveReason(id) || "manual" : undefined,
  });
}

/** Resolve one exact Slack-owned session without waiting for the materialized
 * list index to discover it. Slack posts its deep link immediately after writing
 * this file, so a targeted read is the authority for that link during the gap. */
export function readSlackSession(sessionId: string): UnifiedSession | null {
  if (!sessionId.startsWith("slack-")) return null;
  const key = sessionId.slice("slack-".length);
  if (!key || key.includes("/") || key.includes("\\")) return null;
  const session = slackSessionRow(`${key}.json`);
  if (!session) return null;
  session.transcriptPath = resolveTranscriptPath(
    findTranscriptPath(session.worktreeDir, session.claudeSessionId),
    session.codexThreadId,
    session.model,
  );
  return session;
}

function* slackSessionRows(): Generator<UnifiedSession> {
  if (!existsSync(SLACK_SESSIONS_DIR)) return [];

  for (const file of readdirSync(SLACK_SESSIONS_DIR)) {
    const session = slackSessionRow(file);
    if (session) yield session;
  }
}

function scanSlackSessions(): UnifiedSession[] {
  return [...slackSessionRows()];
}

function* linearSessionRows(): Generator<UnifiedSession> {
  if (!existsSync(LINEAR_SESSIONS_DIR)) return [];

  for (const file of readdirSync(LINEAR_SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const data = readJsonSafe<LinearSessionFile>(
      `${LINEAR_SESSIONS_DIR}/${file}`,
    );
    if (!data) continue;

    const rawName =
      data.participants?.[0]?.name || data.lastActiveUser?.name || null;
    // Clean up email-style names (e.g. "john@example.com" → "John")
    const startedBy = rawName?.includes("@")
      ? rawName.split("@")[0].charAt(0).toUpperCase() +
        rawName.split("@")[0].slice(1)
      : rawName;

    const title = data.issueIdentifier
      ? `${data.issueIdentifier}: ${data.issueTitle || data.branch}`
      : data.branch;

    const id = `linear-${data.branch}`;
    const archived = isArchivedId(id);

    yield overlaySidecarExtras({
      id,
      claudeSessionId: data.claudeSessionId,
      source: "linear",
      branch: data.branch,
      worktreeDir: data.worktreeDir || null,
      createdBy: startedBy,
      startedBy,
      title,
      lastActivity:
        data.updatedAt || getFileMtime(`${LINEAR_SESSIONS_DIR}/${file}`),
      createdAt: getFileMtime(`${LINEAR_SESSIONS_DIR}/${file}`),
      isRunning: false,
      transcriptPath: null,
      linearIssue: data.issueIdentifier
        ? {
            identifier: data.issueIdentifier,
            title: data.issueTitle || data.branch,
            url: data.issueUrl,
          }
        : undefined,
      model: data.model,
      // Same pi-slot mapping as the slack scan (agent-session-sync writes it).
      piSessionId: data.piSessionId || undefined,
      archived: archived || undefined,
      archivedReason: archived ? getArchiveReason(id) || "manual" : undefined,
    });
  }
}

function scanLinearSessions(): UnifiedSession[] {
  return [...linearSessionRows()];
}

function nativeSessionRow(data: NativeSessionFile): UnifiedSession {
  const archived = !!data.archived || isArchivedId(data.id);
  return {
    id: data.id,
    duplicatedFromSessionId: data.duplicatedFromSessionId,
    claudeSessionId: data.claudeSessionId,
    source: "opensession",
    branch: data.branch || null,
    worktreeDir: data.worktreeDir || null,
    createdBy: data.createdBy || null,
    createdByLogin: data.createdByLogin,
    startedBy: data.createdBy,
    title: data.title || data.branch || "Ask session",
    mode: data.mode,
    // Back-compat: older session files stored the repo under `project`.
    repo: data.repo ?? (data as { project?: string }).project,
    // Scratch has always been repo-less; newer repo-less Ask sessions say
    // so outright. Both are surfaced as one flag so clients never have to
    // read a missing `repo` as a decision (it usually isn't).
    repoLess: data.repoLess || data.mode === "scratch" || undefined,
    workspaceId: data.workspaceId ?? null,
    parentSessionId: data.parentSessionId,
    agentStarted: data.agentStarted,
    spawnedBy: data.spawnedBy,
    desk: data.desk,
    spawnDepth: data.spawnDepth,
    attachedRepos: data.attachedRepos,
    stackedOn: data.stackedOn,
    linkedPrs: data.linkedPrs,
    previewPath: data.previewPath,
    walkthrough: data.walkthrough,
    slackShares: data.slackShares,
    automation:
      data.automation ||
      (data.createdBy?.endsWith(" (automation)")
        ? data.createdBy.slice(0, -" (automation)".length)
        : undefined),
    automationId: data.automationId,
    archived: archived || undefined,
    archivedReason:
      data.archivedReason ||
      (archived ? getArchiveReason(data.id) || "manual" : undefined),
    plainThreadId: data.plainThreadId,
    externalRefs: data.externalRefs,
    // The MCP allowlist the session was created with. Dropping it here left
    // `sessionMcpScopeSource`'s "session" branch unreachable, so a session
    // created with a picked set of servers ran its first turn scoped (the
    // create path passes the picked list straight to the run) and every turn
    // after it against all of them.
    mcpServers: data.mcpServers,
    model: data.model,
    effort: data.effort,
    fastMode: data.fastMode,
    accountId: data.accountId,
    codexThreadId: data.codexThreadId,
    piSessionId: data.piSessionId,
    lastEngineProvider: data.lastEngineProvider,
    lastEngineModel: data.lastEngineModel,
    modelHistory: data.modelHistory,
    usage: data.usage,
    goal: data.goal,
    goalId: data.goalId,
    lastRunError: data.lastRunError,
    loop: data.loop,
    slackThreads: data.slackThreads,
    sandbox: data.sandbox,
    lastActivity: data.lastActivity,
    createdAt: data.createdAt,
    isRunning: false,
    transcriptPath: null,
  };
}

/**
 * Read the list projection source for one native session without resolving a
 * transcript. Native writes use this to update the SQLite list index in O(1):
 * opening a session still performs the richer direct read below, while a list
 * update never warms or scans transcript directories.
 */
export function readNativeSessionListRow(
  sessionId: string,
): UnifiedSession | undefined {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) return undefined;
  const data = readJsonSafe<NativeSessionFile>(
    `${SESSIONS_DIR}/${sessionId}.json`,
  );
  if (!data?.id || data.id !== sessionId) return undefined;
  const session = nativeSessionRow(data);
  const generated = getGeneratedTitle(session.id);
  if (generated) session.title = generated;
  const title = getTitleOverride(session.id);
  if (title) {
    session.title = title;
    session.titleOverridden = true;
  }
  const status = getStatusOverride(session.id);
  if (status) session.manualStatus = status;
  const review = getReviewRequest(session.id);
  if (review) session.reviewRequest = review;
  return session;
}

/** Read one native session directly. Opening a known session must not wait for
 * the multi-thousand-file list scan that populates the sidebar. */
export function readNativeSession(
  sessionId: string,
): UnifiedSession | undefined {
  const session = readNativeSessionListRow(sessionId);
  if (!session) return undefined;
  session.transcriptPath = resolveTranscriptPath(
    findTranscriptPath(session.worktreeDir, session.claudeSessionId),
    session.codexThreadId,
    session.model,
  );
  return session;
}

function* nativeSessionRows(): Generator<UnifiedSession> {
  if (!existsSync(SESSIONS_DIR)) return [];

  for (const file of readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith(".json") || SKIP_FILES.has(file)) continue;
    const data = readJsonSafe<NativeSessionFile>(`${SESSIONS_DIR}/${file}`);
    // Skip non-session bookkeeping files in this dir (active-runs.json,
    // prompt-queues.json, active-at-shutdown.json, …) — a real session always
    // has an id, these don't, so they'd otherwise become bogus id:undefined rows.
    if (!data || !data.id) continue;
    yield nativeSessionRow(data);
  }
}

function scanNativeSessions(): UnifiedSession[] {
  return [...nativeSessionRows()];
}

/**
 * Read a synchronous row iterator without monopolising Bun's event loop.
 *
 * Session files still use the existing, battle-tested synchronous parser; the
 * async list path merely yields between small batches. This keeps workspace
 * filing, PR-cache overlays and every other process-local side effect on the
 * main thread while allowing WebSocket upgrades and transcript reads through
 * during an 8,000-file cold scan.
 */
async function collectSessionRows(
  rows: Generator<UnifiedSession>,
): Promise<UnifiedSession[]> {
  const sessions: UnifiedSession[] = [];
  for (const session of rows) {
    sessions.push(session);
    if (sessions.length % 8 === 0) await Bun.sleep(0);
  }
  return sessions;
}

function getRunningPids(): Map<string, number> {
  // Map of sessionId → pid for currently running CLI sessions
  const running = new Map<string, number>();
  if (!existsSync(CLI_SESSIONS_DIR)) return running;

  for (const file of readdirSync(CLI_SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const data = readJsonSafe<CLISessionFile>(`${CLI_SESSIONS_DIR}/${file}`);
    if (!data) continue;

    try {
      process.kill(data.pid, 0); // Check if PID is alive
      running.set(data.sessionId, data.pid);
    } catch {
      // PID is dead
    }
  }
  return running;
}

function* assembleSessionSteps(
  slackSessions: UnifiedSession[],
  linearSessions: UnifiedSession[],
  nativeSessions: UnifiedSession[],
  slice: SessionArchiveSlice = "include",
): Generator<void, UnifiedSession[]> {
  const runningPids = getRunningPids();

  // Merge all sessions, deduplicating by engine id (Claude session or Codex
  // thread). Keep the one with richer data (opensession > linear > slack), and
  // preserve dropped ids as aliases for deep links.
  const byEngineId = new Map<string, UnifiedSession>();
  const allSessions: UnifiedSession[] = [];

  for (const session of [
    ...nativeSessions,
    ...linearSessions,
    ...slackSessions,
  ]) {
    yield;
    const engineKeys = sessionEngineKeys(session);
    let existing: UnifiedSession | undefined;
    for (const key of engineKeys) {
      existing = byEngineId.get(key);
      if (existing) break;
    }
    if (existing) {
      if (session.claudeSessionId && runningPids.has(session.claudeSessionId)) {
        existing.isRunning = true;
      }
      // Keep the dropped ID as an alias so deep links to it (e.g. the
      // Slack "Open in Open Session" button, which uses slack-<channel>-<ts>)
      // still resolve to the surviving session.
      existing.aliasIds = [...(existing.aliasIds || []), session.id];
      if (session.archived && !existing.archived) {
        existing.archived = true;
        existing.archivedReason = session.archivedReason;
      }
      for (const aliasKey of engineKeys) byEngineId.set(aliasKey, existing);
      continue;
    }

    // Mark running status
    if (session.claudeSessionId && runningPids.has(session.claudeSessionId)) {
      session.isRunning = true;
    }

    allSessions.push(session);
    for (const key of engineKeys) byEngineId.set(key, session);
  }

  // Archive is a property of the deduplicated conversation, not whichever
  // source happened to win. An archive registry entry under a historical
  // Slack/Linear alias must therefore move the canonical row too.
  for (const session of allSessions) {
    yield;
    const archivedId = [session.id, ...(session.aliasIds || [])].find(
      isArchivedId,
    );
    if (!session.archived && archivedId) {
      session.archived = true;
      session.archivedReason = getArchiveReason(archivedId) || "manual";
    }
  }
  const selectedSessions =
    slice === "include"
      ? allSessions
      : allSessions.filter((session) =>
          inArchiveSlice(!!session.archived, slice),
        );

  // Enrich with PR URLs and state, matched within the session's own repo so a
  // branch name reused across repos never picks up the wrong PR. Beyond the
  // singular pr* fields (still the primary branch's PR, for the list/Reviews
  // consumers), collect EVERY PR the session spans — attached repos and
  // manually linked PRs — into session.prs for the multi-PR surfaces.
  const prsByRepo = getPrsByRepo();
  const prsBySession = prsBySessionRef(prsByRepo);
  // One conversation can hold two session records — a Slack thread writes both
  // a thread-keyed and a branch-named file, each with its own engine id, so the
  // alias merge never fuses them — and only one of them is named in the PR
  // footers. They share a worktree and already show the same primary PR, so a
  // PR discovered for either is shown on every session working that repo+branch.
  // Only for non-default branches: on `master` that pair is every Ask session in
  // the shared checkout.
  const discoveredByBranch = new Map<
    string,
    Array<{ repo: string; branch: string; pr: PrInfo }>
  >();
  // Sessions with no branch of their own inherit their workspace's, so every session
  // in a workspace resolves to the same PR. Read each workspace once.
  const workspaceOf = prWorkspaceReader();
  if (prsBySession.size > 0) {
    for (const session of allSessions) {
      yield;
      const branch = sessionPrBranch(session, workspaceOf(session));
      if (!branch) continue;
      const repoId = session.repo || defaultRepo().id;
      if (branch === configuredRepos()[repoId]?.defaultBranch) continue;
      const found = footerPrsFor(prsBySession, session);
      if (!found.length) continue;
      const key = `${repoId}\x00${branch}`;
      const list = discoveredByBranch.get(key);
      if (list) list.push(...found);
      else discoveredByBranch.set(key, [...found]);
    }
  }
  // Transcript discovery traverses engine stores and is the dominant per-row
  // cost. Resolve it only after archive slicing so the live poll never enriches
  // the archived half (and vice versa).
  for (const session of selectedSessions) {
    yield;
    session.transcriptPath = resolveTranscriptPath(
      findTranscriptPath(session.worktreeDir, session.claudeSessionId),
      session.codexThreadId,
      session.model,
    );
  }
  for (const session of selectedSessions) {
    yield;
    const primaryBranch = sessionPrBranch(session, workspaceOf(session));
    if (primaryBranch) {
      const sessionRepoId = session.repo || defaultRepo().id;
      const pr = prsByRepo.get(sessionRepoId)?.get(primaryBranch);
      if (pr) {
        session.prUrl = pr.url;
        session.prState = pr.state;
        session.prMergeable = pr.mergeable;
        session.prNumber = pr.number;
        session.prTitle = pr.title;
        session.prIsDraft = pr.isDraft;
        session.prAdditions = pr.additions;
        session.prDeletions = pr.deletions;
        session.prChangedFiles = pr.changedFiles;
        session.prReviewDecision = pr.reviewDecision;
        session.prReviewRequested = pr.reviewRequested;
        session.prReviewedBy = pr.reviewedBy;
        session.prAuthor = pr.author;
        session.prUpdatedAt = pr.updatedAt;
        session.prChecks = pr.checks;
        session.prOsReview = lastReviewSummary(
          readPrState(pr.number, configuredRepos()[sessionRepoId]?.ghRepo)
            ?.lastReview,
          pr.headRefOid,
        );
      }
    }

    const targets: Array<{
      repo: string;
      branch: string;
      source: SessionPrRef["source"];
      stored?: { url?: string; number?: number; title?: string };
    }> = [];
    if (primaryBranch)
      targets.push({
        repo: session.repo || defaultRepo().id,
        branch: primaryBranch,
        source: "primary",
      });
    for (const att of session.attachedRepos || [])
      targets.push({ repo: att.repo, branch: att.branch, source: "attached" });
    for (const lp of session.linkedPrs || [])
      targets.push({
        repo: lp.repo,
        branch: lp.branch,
        source: "linked",
        stored: lp,
      });
    // PRs that name this session in their attribution footer but sit on a
    // branch it doesn't own — the "one feature, four PRs" shape, where the
    // agent opened PRs in repos it never attached (or on a second branch of
    // its own repo). Matched on alias ids too: the footer of a Slack session's
    // PR carries the slack-<channel>-<ts> id it was created under.
    for (const found of [
      ...footerPrsFor(prsBySession, session),
      ...(primaryBranch
        ? discoveredByBranch.get(
            `${session.repo || defaultRepo().id}\x00${primaryBranch}`,
          ) || []
        : []),
    ])
      targets.push({
        repo: found.repo,
        branch: found.branch,
        source: "discovered",
      });

    const seen = new Set<string>();
    const refs: SessionPrRef[] = [];
    for (const t of targets) {
      const key = `${t.repo}\x00${t.branch}`;
      if (seen.has(key)) continue; // a link duplicating the primary/attached pair
      seen.add(key);
      const pr = prsByRepo.get(t.repo)?.get(t.branch);
      if (pr) {
        refs.push({
          repo: t.repo,
          branch: t.branch,
          source: t.source,
          url: pr.url,
          state: pr.state,
          number: pr.number,
          title: pr.title,
          isDraft: pr.isDraft,
          reviewDecision: pr.reviewDecision,
          mergeable: pr.mergeable,
          additions: pr.additions,
          deletions: pr.deletions,
          checks: pr.checks,
        });
      } else if (
        t.source !== "primary" &&
        (t.stored || !prsByRepo.has(t.repo))
      ) {
        // No cache hit but the target is still real: a linked PR keeps its
        // stored url/number/title as a label, and an attached repo outside the
        // bulk cache's coverage (it only polls the active dev repos) keeps a
        // bare ref — the PR routes resolve it live. A covered repo with no
        // cache entry genuinely has no PR, and a primary branch with no PR
        // stays absent, as before.
        refs.push({
          repo: t.repo,
          branch: t.branch,
          source: t.source,
          ...t.stored,
        });
      }
    }
    if (refs.length > 0) session.prs = refs;
  }

  // PR lookup starts from each session's branches and attribution footers, but
  // Review and the summary belong to the workspace. Project the resulting set
  // back onto every live tab so switching chats cannot hide a sibling's PR.
  shareWorkspacePrRefs(selectedSessions);

  // Apply auto-generated summary titles (the short Conductor-style name),
  // keyed by unified id or merged alias id. Sits UNDER a manual rename (applied
  // next) but OVER the derived first-line title.
  for (const session of selectedSessions) {
    yield;
    const generated =
      getGeneratedTitle(session.id) ??
      session.aliasIds?.map((a) => getGeneratedTitle(a)).find(Boolean);
    if (generated) session.title = generated;
  }

  // Apply cross-source manual title overrides (rename). Keyed by the unified id
  // or any merged alias id, so a rename sticks across the dedup in this scan.
  for (const session of selectedSessions) {
    yield;
    const override =
      getTitleOverride(session.id) ??
      session.aliasIds?.map((a) => getTitleOverride(a)).find(Boolean);
    if (override) {
      session.title = override;
      session.titleOverridden = true;
    }
  }

  // Apply manual status-lane overrides. Keyed by unified id or any merged alias
  // id (same as the rename registry) so a pinned lane survives the dedup scan.
  for (const session of selectedSessions) {
    yield;
    const status =
      getStatusOverride(session.id) ??
      session.aliasIds?.map((a) => getStatusOverride(a)).find(Boolean);
    if (status) session.manualStatus = status;
  }

  // Apply pending review requests (the info panel's Reviewer picker), keyed by
  // unified id or any merged alias id like the registries above.
  for (const session of selectedSessions) {
    yield;
    const review =
      getReviewRequest(session.id) ??
      session.aliasIds?.map((a) => getReviewRequest(a)).find(Boolean);
    if (review) session.reviewRequest = review;
  }

  // Every session belongs to exactly one workspace (session-workspace.ts). File any
  // that surfaced without one — in memory now, on disk right after — so the
  // sidebar only ever has workspace rows to render. Runs after the title
  // registries above so a minted workspace takes the session's final name.
  ensureSessionWorkspaces(selectedSessions);

  // Sort by lastActivity descending
  selectedSessions.sort(
    (a, b) =>
      new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime(),
  );

  return selectedSessions;
}

function assembleSessions(
  slackSessions: UnifiedSession[],
  linearSessions: UnifiedSession[],
  nativeSessions: UnifiedSession[],
  slice: SessionArchiveSlice = "include",
): UnifiedSession[] {
  const steps = assembleSessionSteps(
    slackSessions,
    linearSessions,
    nativeSessions,
    slice,
  );
  while (true) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

async function assembleSessionsAsync(
  slackSessions: UnifiedSession[],
  linearSessions: UnifiedSession[],
  nativeSessions: UnifiedSession[],
  slice: SessionArchiveSlice = "include",
): Promise<UnifiedSession[]> {
  const steps = assembleSessionSteps(
    slackSessions,
    linearSessions,
    nativeSessions,
    slice,
  );
  let batch = 0;
  while (true) {
    const step = steps.next();
    if (step.done) return step.value;
    if (++batch % 8 === 0) await Bun.sleep(0);
  }
}

export function getAllSessions(
  slice: SessionArchiveSlice = "include",
): UnifiedSession[] {
  return assembleSessions(
    scanSlackSessions(),
    scanLinearSessions(),
    scanNativeSessions(),
    slice,
  );
}

/** Cooperative counterpart for request paths that can await a cold scan. */
export async function getAllSessionsAsync(
  slice: SessionArchiveSlice = "include",
): Promise<UnifiedSession[]> {
  // Warm the indexes before row parsing starts. Running these in the same
  // Promise.all as the scans lets the first transcript miss fall back to the
  // synchronous builders while the cooperative warm-up is still in flight.
  await Promise.all([warmWorkspaceNamesAsync(), warmTranscriptIndexAsync()]);
  const [slackSessions, linearSessions, nativeSessions] = await Promise.all([
    collectSessionRows(slackSessionRows()),
    collectSessionRows(linearSessionRows()),
    collectSessionRows(nativeSessionRows()),
  ]);
  // These overlays read and mutate process-local state, so they deliberately
  // remain on the server thread rather than crossing a Worker boundary.
  return await assembleSessionsAsync(
    slackSessions,
    linearSessions,
    nativeSessions,
    slice,
  );
}

function removeSessionArtifacts(session: UnifiedSession): void {
  // Delete the session JSON file based on source.
  switch (session.source) {
    case "slack": {
      // ID format: slack-{filename}
      const filename = session.id.replace(/^slack-/, "") + ".json";
      const path = `${SLACK_SESSIONS_DIR}/${filename}`;
      if (existsSync(path)) unlinkSync(path);
      break;
    }
    case "linear": {
      // ID format: linear-{branch}
      const branch = session.id.replace(/^linear-/, "");
      const path = `${LINEAR_SESSIONS_DIR}/${branch}.json`;
      if (existsSync(path)) unlinkSync(path);
      break;
    }
    case "opensession": {
      const path = `${SESSIONS_DIR}/${session.id}.json`;
      if (existsSync(path)) unlinkSync(path);
      break;
    }
  }
  removeIndexedSession(session.id);
  try {
    releasePreviewPathLease(session.id);
  } catch (error) {
    console.error(
      `Failed to release preview reservation for ${session.id}:`,
      error,
    );
  }
  // Nobody's unsent draft should outlive the session it was typed into.
  purgeDraftsForSessions([session.id, ...(session.aliasIds || [])]);
  // Neither should its scratch dir (session-scratch.ts). Best-effort and
  // async: a scratch hiccup must never block deletion.
  for (const id of [session.id, ...(session.aliasIds || [])])
    void removeSessionScratch(id);
}

export async function deleteSession(session: UnifiedSession): Promise<void> {
  await executeSessionProjection(session.id, "session_delete", () => {
    removeSessionArtifacts(session);
  });
}

/**
 * Finish a deletion whose permanent tombstone was written before its session
 * file was removed. The tombstone already fences every writer, so re-entering
 * the mailbox is both impossible and unnecessary. Callers must verify the
 * tombstone before using this recovery path.
 */
export function removeTombstonedSessionArtifacts(
  session: UnifiedSession,
): void {
  removeSessionArtifacts(session);
}
