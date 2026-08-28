/**
 * Transcript v2 store (docs/transcripts.md §1, §1a) — the owned
 * per-session sequence-numbered event log co-located with that session's
 * kernel tables in its actor-owned SQLite (WAL) database.
 *
 * Row unit is the parsed TranscriptEntry; `uuid` = `entry.id` (§1a — NOT the
 * mirror line uuid). seq is 1-based and dense per session, assigned ONLY to
 * genuinely-inserted rows inside a BEGIN IMMEDIATE transaction; a re-append
 * of a known (session_id, uuid) is an upsert that updates data/full_ref/ts
 * but keeps the ORIGINAL seq (streamed-rewrite "last wins" semantics — the
 * client already upserts by entry id). A (session_id, seq) PK conflict is a
 * bug and surfaces as a thrown SQLite error — never OR IGNORE.
 *
 * Write-time bounding: `data` is hard-bounded to <= 32 KB (bytes of the
 * serialized JSON). Oversized entries store their full JSON in
 * transcript_blobs (full_ref) and a stripped wire form in `data`:
 * byte-truncated content with the contentClamped/contentLength markers the
 * legacy clampEntriesForWire path uses, toolInput replaced by a
 * `{toolName, byteSize, keys}` summary, and each images[] data-URL replaced
 * by an `"os-blob:<uuid>/<i>"` marker the UI resolves via the /entry route
 * (getFullEntry).
 *
 * Import-first gate (§3): `appendTranscriptEvents` accepts an optional
 * `ensureImported(sessionId)` hook. When the session has never been imported
 * (`needsImport`), the hook runs SYNCHRONOUSLY before the first live seq is
 * assigned — the wiring layer implements it as
 * mergedSessionTranscript → importLegacyTranscript → (markImported happens
 * inside importLegacyTranscript). If the hook returns without importing (or
 * no hook is given), the session is marked 'live-only' so the gate is a
 * one-time cost. If the hook THROWS, the append is aborted and the error
 * propagates — the wiring layer catches, warns, and marks the session
 * store-degraded (live appends must never precede history import).
 *
 * Post-commit hooks (§4a): every committed append publishes the affected
 * entries (with seqs) on transcript-bus, and invokes the optional
 * steer-receipt append hook (setAppendHook — same contract as
 * file-watcher.ts's setTranscriptAppendListener). Both are wrapped so they
 * can never throw back into the append path. Imports publish one reconciliation
 * wake only after all chunks commit; authoritative replacements publish reset.
 *
 * Live-safety: nothing here opens a DB at import time. Production constructs
 * stores only inside the session actor worker. The legacy lazy singleton is a
 * test compatibility seam; the gateway never calls it in production.
 */

import {
  executeDestinationIdempotentSessionProjection,
  executeSessionProjection,
} from "./session-projection-executor";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { dirname } from "path";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import {
  publishTranscript,
  type SeqEntry,
  type TranscriptBusEvent,
} from "./transcript-bus";
import type { TranscriptEntry } from "./types";
import { sanitizeTranscriptMediaEntry } from "./transcript-media";
import { v2SnapshotEntryWeight } from "./transcript-wire";
import { classifyEntry, dropContextInjections } from "@tellahq/opensession-protocol/notices";
import {
  decodeAgentTranscriptReceiptRefV1,
  type AgentTranscriptAnchorV1,
  type AgentTranscriptReceiptRefV1,
} from "@tellahq/opensession-protocol/agent-operation";
import type {
  TranscriptIndexEntry,
  TranscriptIndexRole,
} from "@tellahq/opensession-protocol/session";
import {
  assertTranscriptActorRequest,
  assertTranscriptActorResponse,
  type TranscriptActorRequest,
  type TranscriptMutationResult,
  type TranscriptWake,
} from "./session-kernel/transcript-protocol";

export type { SeqEntry, TranscriptBusEvent };

/** Hard byte bound for the wire-ready `data` column. */
export const TRANSCRIPT_DATA_MAX_BYTES = 32 * 1024;

export type TranscriptImportSrc = "mirror" | "merged" | "live-only";

export interface TranscriptOutline {
  entries: TranscriptIndexEntry[];
  firstSeq: number;
  lastSeq: number;
  lastChangeSeq: number;
  epoch: number;
}

export interface TranscriptRangePage extends TranscriptPage {
  /** Last raw seq covered, including a corrupt or hidden row. */
  coveredThroughSeq: number;
  complete: boolean;
}

export interface TranscriptHydratedPage extends TranscriptPage {
  coveredThroughSeq: number;
  complete: boolean;
}

export interface TranscriptPage {
  /** Entries in ascending seq order, each annotated with its seq. */
  entries: SeqEntry[];
  /** seq of entries[0]; 0 when the page is empty. */
  firstSeq: number;
  /** seq of entries[entries.length-1]; 0 when the page is empty. */
  lastSeq: number;
}

export interface TranscriptTurnFence {
  sessionId: string;
  runId: string;
  turnId: string;
  generation: number;
}

export interface DestinationTranscriptAppendRequest extends TranscriptTurnFence {
  appendId: string;
  entries: TranscriptEntry[];
}

export interface DestinationTranscriptAppendResult extends AppendResult {
  changes: Array<{ entryId: string; seq: number; changeSeq: number }>;
}

export interface AgentDestinationTranscriptAppendRequest
  extends DestinationTranscriptAppendRequest {
  transcriptAnchor: Readonly<AgentTranscriptAnchorV1>;
}

export interface DestinationTranscriptReceiptQuery extends TranscriptTurnFence {
  appendId: string;
  requestDigest: `sha256:${string}`;
  transcriptAnchor?: Readonly<AgentTranscriptAnchorV1>;
}

export interface DestinationTranscriptAppendReceipt
  extends TranscriptTurnFence {
  readonly version: 1;
  readonly appendId: string;
  readonly requestDigest: `sha256:${string}`;
  readonly transcriptAnchor?: Readonly<AgentTranscriptAnchorV1>;
  readonly entryIds: readonly string[];
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly throughChangeSeq: number;
  readonly inserted: number;
  readonly updated: number;
  readonly changes: readonly Readonly<{
    entryId: string;
    seq: number;
    changeSeq: number;
  }>[];
}

export interface AgentTranscriptReceiptValidationRequest
  extends TranscriptTurnFence {
  readonly receipt: AgentTranscriptReceiptRefV1;
  readonly transcriptAnchor: Readonly<AgentTranscriptAnchorV1>;
}

export class TranscriptAppendConflictError extends Error {
  readonly code = "TRANSCRIPT_APPEND_CONFLICT";
  constructor(sessionId: string, appendId: string) {
    super(
      `Transcript append ${sessionId}/${appendId} was reused with another request`,
    );
    this.name = "TranscriptAppendConflictError";
  }
}

/** An exact primary-key receipt exists, but one or more expected proof fields
 * differ. The error deliberately contains no transcript or mismatched value. */
export class TranscriptAppendReceiptMismatchError extends Error {
  readonly code = "TRANSCRIPT_APPEND_RECEIPT_MISMATCH";
  constructor() {
    super("Transcript append receipt does not match the exact identity");
    this.name = "TranscriptAppendReceiptMismatchError";
  }
}

/** A durable receipt row is malformed or contradicts its denormalized fields. */
export class TranscriptAppendReceiptCorruptError extends Error {
  readonly code = "TRANSCRIPT_APPEND_RECEIPT_CORRUPT";
  constructor() {
    super("Transcript append receipt is corrupt");
    this.name = "TranscriptAppendReceiptCorruptError";
  }
}

/** The Agent proof path only permits a fresh, dense, request-ordered append. */
export class TranscriptAppendAgentReceiptInvariantError extends Error {
  readonly code = "TRANSCRIPT_APPEND_AGENT_RECEIPT_INVARIANT";
  constructor() {
    super("Transcript append cannot produce an Agent receipt");
    this.name = "TranscriptAppendAgentReceiptInvariantError";
  }
}

export interface AppendResult {
  /** Lowest affected seq (an upsert keeps its original seq, so this can be
   *  far below lastSeq). */
  firstSeq: number;
  /** Highest affected seq. */
  lastSeq: number;
  /** Rows genuinely inserted (got a fresh seq). */
  inserted: number;
  /** Rows that hit the (session_id, uuid) index and were updated in place —
   *  the caller's "republish happened" flag. */
  updated: number;
}

export interface AppendOpts {
  /**
   * Import-first gate hook (§3): called synchronously when the session has
   * never been imported, BEFORE any live seq is assigned. Implementations
   * should run the legacy import (importLegacyTranscript marks the session
   * imported); a fresh session with no legacy transcript may simply return —
   * the store then marks it 'live-only'. A throw aborts this append.
   */
  ensureImported?: (sessionId: string) => void;
}

export interface TranscriptImportInfo {
  importedAt: number;
  src: TranscriptImportSrc | string;
  watermark: number | null;
}

/**
 * What counts as CONVERSATION when sizing an opening window (readTailWindow).
 *
 * Deliberately not `system`: the biggest system rows are the per-turn context
 * injections (memory, standing instructions), which every client drops on the
 * way in (dropContextInjections), so counting them would satisfy the message
 * floor with rows nobody ever sees.
 */
const TAIL_WINDOW_MESSAGE_KINDS = new Set(["user", "assistant"]);

export function handoffTranscriptEntryWeight(kind: string, bytes: number): number {
  return kind === "user" || kind === "assistant" || kind === "system"
    ? Math.min(bytes, 8_000)
    : 0;
}

export interface TailWindowOpts {
  /** Never fewer than this many entries, whatever the byte ceiling says. */
  minEntries: number;
  /** Reach back until the window holds this many user/assistant entries. */
  minMessages: number;
  /** Require this many user boundaries when the window contains tool work. */
  minUserMessagesWithToolWork?: number;
  /** Hard ceiling on rows read, and on the probe query itself. */
  maxEntries: number;
  /** Estimated transfer ceiling for the extension past `minEntries`. */
  maxEstimatedBytes: number;
  /**
   * Estimate what one stored row costs after the caller's wire transforms.
   * Defaults to its stored UTF-8 size.
   */
  weigh?: (kind: string, storedBytes: number) => number;
}

/** Same contract as file-watcher.ts's AppendListener (setTranscriptAppendListener):
 *  best-effort post-commit notification with the affected entries. */
export type TranscriptAppendHook = (
  sessionId: string,
  entries: SeqEntry[]
) => void | Promise<void>;

const g = globalThis as unknown as {
  __osTranscriptStore?: TranscriptStore;
  __osTranscriptAppendHook?: TranscriptAppendHook | null;
};

/**
 * Steer-receipt (or any) post-commit append hook (§4a). Parked on globalThis
 * so hot reloads keep it; read at call time. Pass null to clear.
 */
export function setAppendHook(fn: TranscriptAppendHook | null): void {
  g.__osTranscriptAppendHook = fn;
}

/** Gateway-side delivery for actor-returned, post-commit transcript changes. */
export function notifyTranscriptAppendHook(
  sessionId: string,
  entries: SeqEntry[],
): void {
  try {
    g.__osTranscriptAppendHook?.(sessionId, entries);
  } catch (error) {
    console.warn("[transcript-store] append hook threw:", error);
  }
}

/** Default DB path, derived from the active sessions dir. */
export function transcriptDbPath(): string {
  return `${OPENSESSION_SESSIONS_DIR}/transcripts.db`;
}

/**
 * The process-wide singleton over the real transcripts.db. Lazy — importing
 * this module never opens the DB. Tests must NOT call this; they construct
 * `new TranscriptStore(tempPath)` instead (invariant 8: one writer).
 *
 * A test process that reaches this anyway gets a scratch database rather than
 * the live one. That is not politeness: a run writes to the store for reasons
 * a test never asked for (context-log records the standing context of every
 * dispatch), so "the test didn't redirect the store" quietly meant "the test
 * wrote rows into the operator's real transcripts.db" — 45 of them, under
 * fixture session ids, within a day (2026-08-16). Redirecting still works and
 * still wins; this only decides where an unredirected write lands.
 */
export function transcriptStore(): TranscriptStore {
  if (g.__osTranscriptStore) return g.__osTranscriptStore;
  const path =
    isTestRunner() && !sessionsDirRedirected()
      ? scratchTranscriptDbPath()
      : transcriptDbPath();
  return (g.__osTranscriptStore = new TranscriptStore(path, { actorOwned: true }));
}

function isTestRunner(): boolean {
  return (
    process.env.NODE_ENV === "test" || /\.test\.tsx?$/.test(Bun.main || "")
  );
}

/** A test that pointed the state or sessions dir at a fixture root of its own
 *  keeps it: that redirect IS the isolation, and the snapshot harness depends
 *  on this lazy singleton landing inside its root. Only a test that redirected
 *  NOTHING gets the scratch DB. */
function sessionsDirRedirected(): boolean {
  return !!(
    process.env.OPENSESSION_STATE_DIR || process.env.OPENSESSION_SESSIONS_DIR
  );
}

/** One scratch DB per test process in the OS temp dir, so parallel test
 *  processes never share a file. */
function scratchTranscriptDbPath(): string {
  return `${tmpdir()}/opensession-test-transcripts-${process.pid}.db`;
}

/**
 * Test seam (bun tests only): force-replace the singleton, unconditionally —
 * unlike transcriptStore()'s `??=`, this overwrites a singleton another test
 * file already warmed. Returns the previous value (possibly undefined) so
 * afterAll can restore it before the scratch dir backing the replacement is
 * deleted; restoring the store itself, not just path bindings, is what keeps
 * a still-live singleton from being left pointed at a removed database.
 */
export function __setTranscriptStoreForTest(
  store: TranscriptStore | undefined,
): TranscriptStore | undefined {
  const prev = g.__osTranscriptStore;
  g.__osTranscriptStore = store;
  return prev;
}


// ── Row shapes ───────────────────────────────────────────────────────────────

interface EventRow {
  seq: number;
  change_seq: number;
  data: string;
  full_ref: number | null;
}

interface SessionRow {
  next_seq: number;
  next_change_seq: number;
  reset_change_seq: number;
  imported_at: number | null;
  import_src: string | null;
  import_watermark: number | null;
}

interface WriteOutcome {
  affected: SeqEntry[];
  inserted: number;
  updated: number;
}

interface DestinationWriteOutcome {
  replay: boolean;
  result: DestinationTranscriptAppendResult;
  affected: SeqEntry[];
}

export interface TranscriptAppendReceiptRow {
  session_id: unknown;
  append_id: unknown;
  request_digest: unknown;
  fence_json: unknown;
  result_json: unknown;
  created_at: unknown;
}

interface ValidatedDestinationAppend extends DestinationTranscriptAppendRequest {
  transcriptAnchor?: Readonly<AgentTranscriptAnchorV1>;
  digest: string;
  fenceJson: string;
  requireAgentReceipt: boolean;
}

// ── Store ────────────────────────────────────────────────────────────────────

type LegacyTranscriptMutationRequest = Exclude<
  Extract<TranscriptActorRequest, { requestId: string }>,
  { op: "agent_append_destination" }
>;

export class TranscriptStore {
  private db: Database;
  /** Sessions known to have imported_at set — one-time PK lookup cache (§3). */
  private importedCache = new Set<string>();
  private outlineBackfills = new Map<string, Promise<void>>();
  /** BEGIN IMMEDIATE write transaction (bun:sqlite transaction wrapper). */
  private txWrite: ((sessionId: string, entries: TranscriptEntry[]) => WriteOutcome) & {
    immediate: (sessionId: string, entries: TranscriptEntry[]) => WriteOutcome;
  };
  private txDelete: ((sessionId: string) => void) & {
    immediate: (sessionId: string) => void;
  };
  private txReplace: ((sessionId: string, entries: TranscriptEntry[]) => WriteOutcome) & {
    immediate: (sessionId: string, entries: TranscriptEntry[]) => WriteOutcome;
  };
  private txDestinationAppend: ((
    request: ValidatedDestinationAppend,
  ) => DestinationWriteOutcome) & {
    immediate: (request: ValidatedDestinationAppend) => DestinationWriteOutcome;
  };
  private txAgentDestinationAppend: ((
    request: ValidatedDestinationAppend,
  ) => TranscriptMutationResult<AgentTranscriptReceiptRefV1>) & {
    immediate: (
      request: ValidatedDestinationAppend,
    ) => TranscriptMutationResult<AgentTranscriptReceiptRefV1>;
  };
  private txActorMutation: ((
    request: LegacyTranscriptMutationRequest,
  ) => TranscriptMutationResult<unknown>) & {
    immediate: (
      request: LegacyTranscriptMutationRequest,
    ) => TranscriptMutationResult<unknown>;
  };

  constructor(
    public readonly dbPath: string,
    private readonly options: { actorOwned?: boolean } = {},
  ) {
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_events (
        session_id TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        uuid       TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        kind       TEXT NOT NULL,
        data       TEXT NOT NULL,
        full_ref   INTEGER,
        change_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_te_uuid
        ON transcript_events(session_id, uuid);
      CREATE TABLE IF NOT EXISTS transcript_outline (
        session_id       TEXT NOT NULL,
        seq              INTEGER NOT NULL,
        uuid             TEXT NOT NULL,
        change_seq       INTEGER NOT NULL,
        ts               INTEGER NOT NULL,
        render_role      TEXT NOT NULL,
        content_length   INTEGER NOT NULL,
        review_pr_number INTEGER,
        PRIMARY KEY (session_id, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_to_uuid
        ON transcript_outline(session_id, uuid);
      CREATE TABLE IF NOT EXISTS transcript_blobs (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        uuid TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tb_uuid
        ON transcript_blobs(session_id, uuid);
      CREATE TABLE IF NOT EXISTS transcript_sessions (
        session_id  TEXT PRIMARY KEY,
        next_seq    INTEGER NOT NULL DEFAULT 1,
        next_change_seq INTEGER NOT NULL DEFAULT 1,
        reset_change_seq INTEGER NOT NULL DEFAULT 0,
        last_ts     INTEGER,
        imported_at INTEGER,
        import_src  TEXT,
        import_watermark INTEGER
      );
      CREATE TABLE IF NOT EXISTS transcript_append_receipts (
        session_id TEXT NOT NULL,
        append_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        fence_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, append_id)
      );
      CREATE TABLE IF NOT EXISTS session_kernel_transcript_wakes (
        session_id TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL DEFAULT 0,
        acked_cursor INTEGER NOT NULL DEFAULT 0,
        first_change_seq INTEGER NOT NULL DEFAULT 0,
        last_change_seq INTEGER NOT NULL DEFAULT 0,
        reset_epoch INTEGER NOT NULL DEFAULT 0,
        acked_reset_epoch INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    const wakeColumns = new Set(
      (this.db.query("PRAGMA table_info(session_kernel_transcript_wakes)").all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    if (!wakeColumns.has("acked_reset_epoch"))
      this.db.exec(
        "ALTER TABLE session_kernel_transcript_wakes ADD COLUMN acked_reset_epoch INTEGER NOT NULL DEFAULT 0",
      );
    this.migrateChangeSequence();
    type Tx = typeof this.txWrite;
    this.txWrite = this.db.transaction(
      (sessionId: string, entries: TranscriptEntry[]) =>
        this.writeEntriesInTx(sessionId, entries)
    ) as unknown as Tx;
    this.txDelete = this.db.transaction((sessionId: string) => {
      this.db.run("DELETE FROM transcript_events WHERE session_id = ?", [sessionId]);
      this.db.run("DELETE FROM transcript_outline WHERE session_id = ?", [sessionId]);
      this.db.run("DELETE FROM transcript_blobs WHERE session_id = ?", [sessionId]);
      this.db.run("DELETE FROM transcript_append_receipts WHERE session_id = ?", [sessionId]);
      this.db.run("DELETE FROM transcript_sessions WHERE session_id = ?", [sessionId]);
    }) as unknown as typeof this.txDelete;
    this.txReplace = this.db.transaction(
      (sessionId: string, entries: TranscriptEntry[]) => {
        this.db.run("DELETE FROM transcript_events WHERE session_id = ?", [sessionId]);
        this.db.run("DELETE FROM transcript_outline WHERE session_id = ?", [sessionId]);
        this.db.run("DELETE FROM transcript_blobs WHERE session_id = ?", [sessionId]);
        this.db.run(
          `INSERT INTO transcript_sessions (session_id, next_seq, next_change_seq)
           VALUES (?, 1, 1)
           ON CONFLICT(session_id) DO UPDATE SET
             next_seq = 1,
             reset_change_seq = transcript_sessions.next_change_seq,
             next_change_seq = transcript_sessions.next_change_seq + 1`,
          [sessionId]
        );
        return this.writeEntriesInTx(sessionId, entries);
      }
    ) as unknown as typeof this.txReplace;
    this.txActorMutation = this.db.transaction((request) =>
      this.applyActorMutationInTx(request)
    ) as unknown as typeof this.txActorMutation;
    this.txDestinationAppend = this.db.transaction(
      (request: ValidatedDestinationAppend) => {
        const receiptRow = this.db
          .query(
            `SELECT session_id, append_id, request_digest, fence_json, result_json, created_at
             FROM transcript_append_receipts
             WHERE session_id = ? AND append_id = ?`,
          )
          .get(
            request.sessionId,
            request.appendId,
          ) as TranscriptAppendReceiptRow | null;
        if (receiptRow) {
          const receipt = decodeDestinationReceiptRow(receiptRow);
          if (request.requireAgentReceipt) {
            if (
              !receipt.transcriptAnchor ||
              receipt.inserted !== receipt.changes.length ||
              receipt.updated !== 0
            )
              throw new TranscriptAppendAgentReceiptInvariantError();
            destinationAgentReceiptRef(receipt);
          }
          const receiptFenceJson = canonicalDestinationJson({
            sessionId: receipt.sessionId,
            runId: receipt.runId,
            turnId: receipt.turnId,
            generation: receipt.generation,
            ...(receipt.transcriptAnchor
              ? { transcriptAnchor: receipt.transcriptAnchor }
              : {}),
          });
          if (
            receipt.requestDigest !== `sha256:${request.digest}` ||
            receiptFenceJson !== request.fenceJson
          )
            throw new TranscriptAppendConflictError(
              request.sessionId,
              request.appendId,
            );
          return {
            replay: true,
            result: destinationAppendResult(receipt),
            affected: [],
          };
        }
        if (request.requireAgentReceipt) {
          this.assertTranscriptAnchorCurrent(
            request.sessionId,
            request.transcriptAnchor!,
          );
          const seen = new Set<string>();
          for (const entry of request.entries) {
            if (seen.has(entry.id))
              throw new TranscriptAppendAgentReceiptInvariantError();
            seen.add(entry.id);
            const existing = this.db
              .query(
                `SELECT 1 FROM transcript_events
                 WHERE session_id = ? AND uuid = ?`,
              )
              .get(request.sessionId, entry.id);
            if (existing)
              throw new TranscriptAppendAgentReceiptInvariantError();
          }
        }
        const outcome = this.writeEntriesInTx(
          request.sessionId,
          request.entries,
        );
        this.db.run(
          `UPDATE transcript_sessions SET
             imported_at = COALESCE(imported_at, ?),
             import_src = COALESCE(import_src, 'live-only')
           WHERE session_id = ?`,
          [Date.now(), request.sessionId],
        );
        const resultJson = canonicalDestinationJson(destinationResult(outcome));
        const result = JSON.parse(
          resultJson,
        ) as DestinationTranscriptAppendResult;
        this.db.run(
          `INSERT INTO transcript_append_receipts
             (session_id, append_id, request_digest, fence_json, result_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            request.sessionId,
            request.appendId,
            request.digest,
            request.fenceJson,
            resultJson,
            Date.now(),
          ],
        );
        return { replay: false, result, affected: outcome.affected };
      },
    ) as unknown as typeof this.txDestinationAppend;
    this.txAgentDestinationAppend = this.db.transaction(
      (request: ValidatedDestinationAppend) => {
        if (this.db.query(
          "SELECT 1 FROM session_kernel_tombstones WHERE session_id = ?",
        ).get(request.sessionId))
          throw new Error(`Session ${request.sessionId} was deleted`);
        const beforeChangeSeq = this.getLastChangeSeq(request.sessionId);
        const hasReceipt = !!this.db.query(
          `SELECT 1 FROM transcript_append_receipts
           WHERE session_id = ? AND append_id = ?`,
        ).get(request.sessionId, request.appendId);
        if (!hasReceipt) this.assertActorDestinationFenceCurrent(request);
        const outcome = this.txDestinationAppend(request);
        const receipt = this.queryTranscriptDestinationReceipt({
          sessionId: request.sessionId,
          runId: request.runId,
          turnId: request.turnId,
          generation: request.generation,
          appendId: request.appendId,
          requestDigest: `sha256:${request.digest}`,
          transcriptAnchor: request.transcriptAnchor!,
        });
        if (!receipt) throw new TranscriptAppendReceiptCorruptError();
        this.assertTranscriptAnchorHistorical(request.sessionId, request.transcriptAnchor!);
        this.assertAgentReceiptEntriesCurrent(receipt);
        const result = destinationAgentReceiptRef(receipt);
        if (outcome.replay) {
          return {
            result,
            wakeCursor: this.pendingActorWake(request.sessionId, true)?.cursor ?? 0,
            replay: true,
          };
        }
        const cursor = this.recordActorWakeInTx(
          request.sessionId,
          beforeChangeSeq,
          this.getLastResetChangeSeq(request.sessionId),
        );
        return { result, wakeCursor: cursor, replay: false };
      },
    ) as unknown as typeof this.txAgentDestinationAppend;
  }

  // ── Append (live path) ─────────────────────────────────────────────────────

  /**
   * Upsert a batch of parsed entries. Returns the affected seq span, or null
   * when the batch was empty / nothing was writable (entries without an id
   * are skipped with a warn — never a throw). Runs the import-first gate
   * (see module doc / AppendOpts) before assigning any seq. Post-commit:
   * publishes the affected entries on the bus and invokes the append hook —
   * neither can throw into this path.
   */
  appendTranscriptEvents(
    sessionId: string,
    entries: TranscriptEntry[],
    opts?: AppendOpts
  ): Promise<AppendResult | null> {
    if (!this.options.actorOwned) {
      try {
        return Promise.resolve(this.appendTranscriptEventsOwned(sessionId, entries, opts));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return executeSessionProjection(sessionId, "transcript_append", () =>
      this.appendTranscriptEventsOwned(sessionId, entries, opts)
    );
  }

  private appendTranscriptEventsOwned(
    sessionId: string,
    entries: TranscriptEntry[],
    opts?: AppendOpts
  ): AppendResult | null {
    if (!sessionId || !entries || entries.length === 0) return null;

    // Import-first gate (§3). The hook runs synchronously; the store is
    // single-writer and sync, so nothing can interleave a live seq before it
    // completes. A throw here propagates (wiring warns + marks degraded).
    if (this.needsImport(sessionId)) {
      opts?.ensureImported?.(sessionId);
      if (this.needsImport(sessionId)) {
        this.markImported(sessionId, "live-only", null);
      }
    }

    const outcome = this.txWrite.immediate(sessionId, entries);
    if (outcome.affected.length === 0) return null;

    const firstSeq = outcome.affected[0].seq;
    const lastSeq = outcome.affected[outcome.affected.length - 1].seq;
    const result: AppendResult = {
      firstSeq: Math.min(firstSeq, lastSeq),
      lastSeq: Math.max(firstSeq, lastSeq),
      inserted: outcome.inserted,
      updated: outcome.updated,
    };
    // Affected entries keep batch order; the span must cover upsert seqs too.
    for (const e of outcome.affected) {
      if (e.seq < result.firstSeq) result.firstSeq = e.seq;
      if (e.seq > result.lastSeq) result.lastSeq = e.seq;
    }

    // Post-commit hooks — best-effort, never back into the append path.
    try {
      publishTranscript(sessionId, {
        entries: outcome.affected,
        firstSeq: result.firstSeq,
        lastSeq: result.lastSeq,
      });
    } catch (e) {
      console.warn("[transcript-store] bus publish failed:", e);
    }
    const hook = g.__osTranscriptAppendHook;
    if (hook) {
      try {
        void Promise.resolve(hook(sessionId, outcome.affected)).catch((error) => {
          console.warn("[transcript-store] append hook threw:", error);
        });
      } catch (error) {
        console.warn("[transcript-store] append hook threw:", error);
      }
    }
    return result;
  }

  /**
   * Strict internal destination API for future detached Host recovery. The
   * actor command and SQLite receipt intentionally share the stable append id:
   * after a gateway crash the actor re-admits the operation and this store
   * returns the already-committed destination result without another write.
   */
  async appendTranscriptDestination(
    input: DestinationTranscriptAppendRequest,
  ): Promise<DestinationTranscriptAppendResult> {
    const request = validateDestinationAppend(input, false);
    try {
      return await executeDestinationIdempotentSessionProjection(
        request.sessionId,
        `transcript-destination:${request.appendId}`,
        "transcript_destination_append",
        { digest: request.digest, fence: JSON.parse(request.fenceJson) },
        () => this.appendTranscriptDestinationOwned(request),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("reused with another payload")
      )
        throw new TranscriptAppendConflictError(
          request.sessionId,
          request.appendId,
        );
      throw error;
    }
  }

  /** Destination-only half used by a future gateway proxy after its own short
   * actor admission. It is safe to retry independently with the same request. */
  commitTranscriptDestinationAppend(
    input: DestinationTranscriptAppendRequest,
  ): DestinationTranscriptAppendResult {
    return this.appendTranscriptDestinationOwned(
      validateDestinationAppend(input, false),
    );
  }

  /** Commit or replay one append and return the canonical durable proof needed
   * by an Agent-operation settlement. The proof is derived from validated
   * request identity plus the exact destination result, never caller values. */
  commitTranscriptDestinationAppendReceipt(
    input: AgentDestinationTranscriptAppendRequest,
  ): DestinationTranscriptAppendReceipt {
    const request = validateDestinationAppend(input, true);
    this.appendTranscriptDestinationOwned(request);
    const receipt = this.queryTranscriptDestinationReceipt({
      sessionId: request.sessionId,
      runId: request.runId,
      turnId: request.turnId,
      generation: request.generation,
      appendId: request.appendId,
      requestDigest: `sha256:${request.digest}`,
      transcriptAnchor: request.transcriptAnchor!,
    });
    if (!receipt) throw new TranscriptAppendReceiptCorruptError();
    destinationAgentReceiptRef(receipt);
    this.assertAgentReceiptEntriesCurrent(receipt);
    return receipt;
  }

  /** Actor-authoritative Agent append. Run/turn/generation fencing, anchor
   * verification, insert-only writes, immutable receipt creation, and wake
   * recording share one BEGIN IMMEDIATE transaction in the per-session DB. */
  commitAgentTranscriptDestinationAppend(
    input: AgentDestinationTranscriptAppendRequest,
  ): TranscriptMutationResult<AgentTranscriptReceiptRefV1> {
    return this.txAgentDestinationAppend.immediate(
      validateDestinationAppend(input, true),
    );
  }

  queryAgentTranscriptReceiptRef(
    input: DestinationTranscriptReceiptQuery & {
      transcriptAnchor: Readonly<AgentTranscriptAnchorV1>;
    },
  ): AgentTranscriptReceiptRefV1 | null {
    const receipt = this.queryTranscriptDestinationReceipt(input);
    if (!receipt) return null;
    this.assertTranscriptAnchorHistorical(receipt.sessionId, input.transcriptAnchor);
    this.assertAgentReceiptEntriesCurrent(receipt);
    return destinationAgentReceiptRef(receipt);
  }

  /** Read an immutable receipt only when the primary key, digest, complete turn
   * fence, and optional transcript anchor all match. A missing row returns
   * null; a present mismatch or malformed durable row throws a distinct error. */
  queryTranscriptDestinationReceipt(
    input: DestinationTranscriptReceiptQuery,
  ): DestinationTranscriptAppendReceipt | null {
    const query = validateDestinationReceiptQuery(input);
    const row = this.db
      .query(
        `SELECT session_id, append_id, request_digest, fence_json, result_json, created_at
         FROM transcript_append_receipts
         WHERE session_id = ? AND append_id = ?`,
      )
      .get(query.sessionId, query.appendId) as TranscriptAppendReceiptRow | null;
    if (!row) return null;
    const receipt = decodeDestinationReceiptRow(row);
    if (
      receipt.sessionId !== query.sessionId ||
      receipt.appendId !== query.appendId ||
      receipt.runId !== query.runId ||
      receipt.turnId !== query.turnId ||
      receipt.generation !== query.generation ||
      receipt.requestDigest !== query.requestDigest ||
      canonicalDestinationJson(receipt.transcriptAnchor) !==
        canonicalDestinationJson(query.transcriptAnchor)
    )
      throw new TranscriptAppendReceiptMismatchError();
    return receipt;
  }

  /** Resolve an Agent-provided reference to the canonical durable reference.
   * The caller's values are comparisons only and are never returned. */
  validateAgentTranscriptReceiptRef(
    input: AgentTranscriptReceiptValidationRequest,
  ): AgentTranscriptReceiptRefV1 | null {
    const validation = validateAgentTranscriptReceiptRequest(input);
    const durable = this.queryTranscriptDestinationReceipt({
      sessionId: validation.sessionId,
      runId: validation.runId,
      turnId: validation.turnId,
      generation: validation.generation,
      appendId: validation.receipt.appendId,
      requestDigest: validation.receipt.requestDigest,
      transcriptAnchor: validation.transcriptAnchor,
    });
    if (!durable) return null;
    const canonical = destinationAgentReceiptRef(durable);
    this.assertTranscriptAnchorHistorical(durable.sessionId, validation.transcriptAnchor);
    this.assertAgentReceiptEntriesCurrent(durable);
    if (canonicalDestinationJson(canonical) !== canonicalDestinationJson(validation.receipt))
      throw new TranscriptAppendReceiptMismatchError();
    return canonical;
  }

  /** Check the store-owned cursor and named-row portion of an already
   * authenticated anchor. Its digest is intentionally opaque here; the future
   * gateway defines and authenticates that canonical transcript identity. */
  private assertTranscriptAnchorCurrent(
    sessionId: string,
    anchor: AgentTranscriptAnchorV1,
  ): void {
    const session = this.db
      .query(
        `SELECT next_change_seq, reset_change_seq FROM transcript_sessions
         WHERE session_id = ?`,
      )
      .get(sessionId) as {
      next_change_seq: unknown;
      reset_change_seq: unknown;
    } | null;
    const lastChangeSeq = session
      ? typeof session.next_change_seq === "number"
        ? session.next_change_seq - 1
        : Number.NaN
      : 0;
    const resetChangeSeq = session
      ? typeof session.reset_change_seq === "number"
        ? session.reset_change_seq
        : Number.NaN
      : 0;
    if (
      !Number.isSafeInteger(lastChangeSeq) ||
      anchor.throughChangeSeq !== lastChangeSeq
    )
      throw new TranscriptAppendReceiptMismatchError();
    this.assertTranscriptAnchorHistorical(sessionId, anchor, resetChangeSeq);
  }

  private assertTranscriptAnchorHistorical(
    sessionId: string,
    anchor: AgentTranscriptAnchorV1,
    knownResetChangeSeq?: number,
  ): void {
    const resetChangeSeq = knownResetChangeSeq ?? this.getLastResetChangeSeq(sessionId);
    if (!Number.isSafeInteger(resetChangeSeq) || anchor.throughChangeSeq < resetChangeSeq)
      throw new TranscriptAppendReceiptMismatchError();
    for (const entryId of anchor.entryIds) {
      const row = this.db
        .query(
          `SELECT change_seq FROM transcript_events
           WHERE session_id = ? AND uuid = ?`,
        )
        .get(sessionId, entryId) as { change_seq: unknown } | null;
      if (
        !row ||
        typeof row.change_seq !== "number" ||
        !Number.isSafeInteger(row.change_seq) ||
        row.change_seq > anchor.throughChangeSeq
      )
        throw new TranscriptAppendReceiptMismatchError();
    }
  }

  private assertAgentReceiptEntriesCurrent(
    receipt: DestinationTranscriptAppendReceipt,
  ): void {
    const entries: TranscriptEntry[] = [];
    let totalBytes = 0;
    for (const [index, change] of receipt.changes.entries()) {
      const row = this.db
        .query(
          `SELECT e.seq, e.change_seq, e.data, e.full_ref,
                  b.data AS full_data
           FROM transcript_events e
           LEFT JOIN transcript_blobs b ON b.id = e.full_ref
           WHERE e.session_id = ? AND e.uuid = ?`,
        )
        .get(receipt.sessionId, change.entryId) as {
        seq: unknown;
        change_seq: unknown;
        data: unknown;
        full_ref: unknown;
        full_data: unknown;
      } | null;
      if (
        !row ||
        row.seq !== change.seq ||
        row.change_seq !== change.changeSeq ||
        (row.full_ref !== null && typeof row.full_ref !== "number") ||
        (row.full_ref === null && typeof row.data !== "string") ||
        (row.full_ref !== null && typeof row.full_data !== "string")
      )
        throw new TranscriptAppendReceiptMismatchError();
      const source = (row.full_ref === null ? row.data : row.full_data) as string;
      totalBytes += Buffer.byteLength(source);
      if (totalBytes > TRANSCRIPT_DESTINATION_MAX_BYTES)
        throw new TranscriptAppendReceiptMismatchError();
      try {
        entries.push(
          validateDestinationEntry(
            snapshotPlainJson(JSON.parse(source), "durableEntry"),
            index,
          ),
        );
      } catch {
        throw new TranscriptAppendReceiptMismatchError();
      }
    }
    const fence = {
      sessionId: receipt.sessionId,
      runId: receipt.runId,
      turnId: receipt.turnId,
      generation: receipt.generation,
      transcriptAnchor: receipt.transcriptAnchor!,
    };
    const payloadJson = canonicalDestinationJson({ fence, entries });
    const digest = new Bun.CryptoHasher("sha256")
      .update(DESTINATION_HASH_DOMAIN)
      .update(payloadJson)
      .digest("hex");
    if (receipt.requestDigest !== `sha256:${digest}`)
      throw new TranscriptAppendReceiptMismatchError();
  }

  private appendTranscriptDestinationOwned(
    request: ValidatedDestinationAppend,
  ): DestinationTranscriptAppendResult {
    const outcome = this.txDestinationAppend.immediate(request);
    if (outcome.replay) return outcome.result;
    this.importedCache.add(request.sessionId);
    try {
      publishTranscript(request.sessionId, {
        entries: outcome.affected,
        firstSeq: outcome.result.firstSeq,
        lastSeq: outcome.result.lastSeq,
      });
    } catch (error) {
      console.warn("[transcript-store] destination bus publish failed:", error);
    }
    const hook = g.__osTranscriptAppendHook;
    if (hook) {
      try {
        void Promise.resolve(hook(request.sessionId, outcome.affected)).catch(
          (error) => {
            console.warn(
              "[transcript-store] destination append hook threw:",
              error,
            );
          },
        );
      } catch (error) {
        console.warn(
          "[transcript-store] destination append hook threw:",
          error,
        );
      }
    }
    return outcome.result;
  }

  /** Actor-only request entrypoint. Mutations, immutable exact result receipts,
   * and replayable wake cursors settle in one SQLite transaction. */
  applyActorRequest(request: TranscriptActorRequest): unknown {
    assertTranscriptActorRequest(request);
    const result = this.applyActorRequestValidated(request);
    assertTranscriptActorResponse(result);
    return result;
  }

  private applyActorRequestValidated(request: TranscriptActorRequest): unknown {
    if (request.op === "agent_append_destination")
      return this.commitAgentTranscriptDestinationAppend({
        sessionId: request.sessionId,
        appendId: request.appendId,
        runId: request.runId,
        turnId: request.turnId,
        generation: request.generation,
        transcriptAnchor: request.transcriptAnchor,
        entries: [...request.entries],
      });
    if (request.op === "agent_query_destination_receipt")
      return this.queryAgentTranscriptReceiptRef(request);
    if (request.op === "agent_validate_destination_receipt")
      return this.validateAgentTranscriptReceiptRef(request);
    if ("requestId" in request) return this.txActorMutation.immediate(request);
    if (request.op === "needs_import") return this.needsImport(request.sessionId);
    if (request.op === "import_info") return this.getImportInfo(request.sessionId);
    if (request.op === "tail") return this.readTail(request.sessionId, request.limit ?? 50);
    if (request.op === "tail_window")
      return this.readTailWindow(request.sessionId, {
        ...request.options,
        ...(request.options.weightProfile === "v2_snapshot"
          ? { weigh: v2SnapshotEntryWeight }
          : request.options.weightProfile === "handoff"
            ? { weigh: handoffTranscriptEntryWeight }
            : {}),
      });
    if (request.op === "since")
      return this.readSince(request.sessionId, request.sinceSeq, request.limit ?? 200);
    if (request.op === "changes_since")
      return this.readChangesSince(request.sessionId, request.changeSeq, request.limit ?? 200);
    if (request.op === "hydrated_since")
      return this.readHydratedSince(
        request.sessionId,
        request.sinceSeq,
        request.limit ?? 100,
        request.maxBytes,
      );
    if (request.op === "before")
      return this.readBefore(request.sessionId, request.beforeSeq, request.limit ?? 40);
    if (request.op === "range")
      return this.readRange(
        request.sessionId,
        request.fromSeq,
        request.toSeq,
        request.afterSeq ?? request.fromSeq - 1,
        request.limit ?? 200,
      );
    if (request.op === "outline")
      return this.readTranscriptIndex(
        request.sessionId,
        request.afterSeq ?? 0,
        request.limit ?? 2_000,
      );
    if (request.op === "full_entry") return this.getFullEntry(request.sessionId, request.entryId);
    if (request.op === "last_seq") return this.getLastSeq(request.sessionId);
    if (request.op === "last_change_seq") return this.getLastChangeSeq(request.sessionId);
    if (request.op === "last_reset_change_seq")
      return this.getLastResetChangeSeq(request.sessionId);
    if (request.op === "count") return this.countEvents(request.sessionId);
    if (request.op === "summary") {
      const row = this.db.query(`
        SELECT last_ts, next_seq FROM transcript_sessions WHERE session_id = ?
      `).get(request.sessionId) as { last_ts: number | null; next_seq: number } | null;
      return row
        ? { lastTs: row.last_ts, seqHighWater: Math.max(0, row.next_seq - 1) }
        : null;
    }
    if (request.op === "pending_wake") return this.pendingActorWake(request.sessionId);
    return this.ackActorWake(request.sessionId, request.cursor);
  }

  private actorRequestDigest(
    request: LegacyTranscriptMutationRequest,
  ): string {
    return new Bun.CryptoHasher("sha256")
      .update("opensession.transcript-actor-command.v1\0")
      .update(canonicalDestinationJson(request))
      .digest("hex");
  }

  replayActorRequest(
    request: LegacyTranscriptMutationRequest,
  ): TranscriptMutationResult<unknown> | undefined {
    const digest = this.actorRequestDigest(request);
    const receipt = this.db.query(`
      SELECT session_id, append_id, request_digest, fence_json, result_json, created_at
      FROM transcript_append_receipts
      WHERE session_id = ? AND append_id = ?
    `).get(request.sessionId, request.requestId) as TranscriptAppendReceiptRow | null;
    if (!receipt) return undefined;
    validateTranscriptAppendReceiptRow(receipt);
    if (receipt.request_digest !== digest)
      throw new TranscriptAppendConflictError(request.sessionId, request.requestId);
    const result = {
      ...(JSON.parse(receipt.result_json as string) as TranscriptMutationResult<unknown>),
      replay: true,
    };
    assertTranscriptActorResponse(result);
    return result;
  }

  private assertActorDestinationFenceCurrent(request: ValidatedDestinationAppend): void {
    const run = this.db.query(
      `SELECT run_state, generation, current_run_id
       FROM session_kernel_state WHERE session_id = ?`,
    ).get(request.sessionId) as {
      run_state: unknown;
      generation: unknown;
      current_run_id: unknown;
    } | null;
    if (
      !run || run.current_run_id !== request.runId ||
      run.generation !== request.generation ||
      typeof run.run_state !== "string" ||
      !["starting", "running", "ask_blocked", "interrupted", "reattaching"].includes(run.run_state)
    ) throw new Error(`Transcript destination run fence rejected ${request.sessionId}`);
    const plan = this.db.query(
      `SELECT run_id, run_generation, turn_id
       FROM session_kernel_agent_host_plan WHERE session_id = ?`,
    ).get(request.sessionId) as {
      run_id: unknown;
      run_generation: unknown;
      turn_id: unknown;
    } | null;
    if (
      !plan || plan.run_id !== request.runId ||
      plan.run_generation !== request.generation || plan.turn_id !== request.turnId
    ) throw new Error(`Transcript destination turn fence rejected ${request.sessionId}`);
  }

  private recordActorWakeInTx(
    sessionId: string,
    beforeChangeSeq: number,
    resetEpoch: number,
  ): number {
    const previousWake = this.pendingActorWake(sessionId, true);
    const cursor = (previousWake?.cursor ?? 0) + 1;
    const lastChangeSeq = this.getLastChangeSeq(sessionId);
    const firstChangeSeq = previousWake && previousWake.cursor > previousWake.ackedCursor
      ? previousWake.firstChangeSeq
      : Math.min(lastChangeSeq, beforeChangeSeq + 1);
    this.db.run(`
      INSERT INTO session_kernel_transcript_wakes
        (session_id, cursor, acked_cursor, first_change_seq, last_change_seq,
         reset_epoch, updated_at)
      VALUES (?, ?, 0, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        cursor = excluded.cursor,
        first_change_seq = CASE
          WHEN session_kernel_transcript_wakes.cursor > session_kernel_transcript_wakes.acked_cursor
          THEN session_kernel_transcript_wakes.first_change_seq
          ELSE excluded.first_change_seq
        END,
        last_change_seq = excluded.last_change_seq,
        reset_epoch = CASE
          WHEN session_kernel_transcript_wakes.cursor > session_kernel_transcript_wakes.acked_cursor
          THEN MAX(session_kernel_transcript_wakes.reset_epoch, excluded.reset_epoch)
          ELSE excluded.reset_epoch
        END,
        updated_at = excluded.updated_at
    `, [sessionId, cursor, firstChangeSeq, lastChangeSeq, resetEpoch, Date.now()]);
    return cursor;
  }

  private applyActorMutationInTx(
    request: LegacyTranscriptMutationRequest,
  ): TranscriptMutationResult<unknown> {
    const replay = this.replayActorRequest(request);
    if (replay) return replay;
    const digest = this.actorRequestDigest(request);

    const currentEpoch = this.getLastResetChangeSeq(request.sessionId);
    const beforeChangeSeq = this.getLastChangeSeq(request.sessionId);
    if (request.expectedEpoch !== undefined && request.expectedEpoch !== currentEpoch)
      throw new Error(
        `Transcript epoch fence rejected ${request.sessionId}: expected ${request.expectedEpoch}, current ${currentEpoch}`,
      );

    let result: unknown;
    if (request.op === "append" || request.op === "append_destination") {
      const outcome = this.writeEntriesInTx(request.sessionId, request.entries);
      this.db.run(`
        UPDATE transcript_sessions SET
          imported_at = COALESCE(imported_at, ?),
          import_src = COALESCE(import_src, 'live-only')
        WHERE session_id = ?
      `, [Date.now(), request.sessionId]);
      result = request.op === "append_destination"
        ? destinationResult(outcome)
        : appendResult(outcome);
    } else if (request.op === "import") {
      const outcome = this.writeEntriesInTx(request.sessionId, request.entries);
      if (request.final !== false)
        this.markImported(request.sessionId, request.src, request.watermark);
      result = { inserted: outcome.inserted, updated: outcome.updated };
    } else if (request.op === "replace") {
      this.db.run("DELETE FROM transcript_events WHERE session_id = ?", [request.sessionId]);
      this.db.run("DELETE FROM transcript_outline WHERE session_id = ?", [request.sessionId]);
      this.db.run("DELETE FROM transcript_blobs WHERE session_id = ?", [request.sessionId]);
      this.db.run(`
        INSERT INTO transcript_sessions (session_id, next_seq, next_change_seq)
        VALUES (?, 1, 1)
        ON CONFLICT(session_id) DO UPDATE SET
          next_seq = 1,
          reset_change_seq = transcript_sessions.next_change_seq,
          next_change_seq = transcript_sessions.next_change_seq + 1
      `, [request.sessionId]);
      const outcome = this.writeEntriesInTx(request.sessionId, request.entries);
      result = { inserted: outcome.inserted, updated: outcome.updated };
    } else {
      this.db.run("DELETE FROM transcript_events WHERE session_id = ?", [request.sessionId]);
      this.db.run("DELETE FROM transcript_outline WHERE session_id = ?", [request.sessionId]);
      this.db.run("DELETE FROM transcript_blobs WHERE session_id = ?", [request.sessionId]);
      this.db.run("DELETE FROM transcript_sessions WHERE session_id = ?", [request.sessionId]);
      result = null;
    }

    const cursor = this.recordActorWakeInTx(
      request.sessionId,
      beforeChangeSeq,
      request.op === "delete"
        ? currentEpoch + 1
        : this.getLastResetChangeSeq(request.sessionId),
    );
    const commandResult: TranscriptMutationResult<unknown> = {
      result,
      wakeCursor: cursor,
      replay: false,
    };
    const resultJson = canonicalDestinationJson(commandResult);
    this.db.run(`
      INSERT INTO transcript_append_receipts
        (session_id, append_id, request_digest, fence_json, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      request.sessionId,
      request.requestId,
      digest,
      canonicalDestinationJson({
        expectedEpoch: request.expectedEpoch ?? null,
        generation: request.generation ?? null,
        runId: request.runId ?? null,
        turnId: request.turnId ?? null,
      }),
      resultJson,
      Date.now(),
    ]);
    return commandResult;
  }

  pendingActorWake(sessionId: string, includeAcked = false): TranscriptWake | null {
    const row = this.db.query(`
      SELECT cursor, acked_cursor, first_change_seq, last_change_seq, reset_epoch,
        acked_reset_epoch
      FROM session_kernel_transcript_wakes WHERE session_id = ?
    `).get(sessionId) as {
      cursor: number;
      acked_cursor: number;
      first_change_seq: number;
      last_change_seq: number;
      reset_epoch: number;
      acked_reset_epoch: number;
    } | null;
    if (!row || (!includeAcked && row.cursor <= row.acked_cursor)) return null;
    return {
      cursor: Number(row.cursor),
      ackedCursor: Number(row.acked_cursor),
      firstChangeSeq: Number(row.first_change_seq),
      lastChangeSeq: Number(row.last_change_seq),
      resetEpoch: Number(row.reset_epoch),
      ackedResetEpoch: Number(row.acked_reset_epoch),
    };
  }

  ackActorWake(sessionId: string, cursor: number): boolean {
    if (!Number.isSafeInteger(cursor) || cursor < 0) return false;
    const result = this.db.run(`
      UPDATE session_kernel_transcript_wakes
      SET acked_cursor = ?, acked_reset_epoch = reset_epoch, updated_at = ?
      WHERE session_id = ? AND cursor = ? AND acked_cursor < ?
    `, [cursor, Date.now(), sessionId, cursor, cursor]);
    return result.changes === 1;
  }

  // ── Import (legacy history) ────────────────────────────────────────────────

  /**
   * Bulk-load a legacy transcript in chunked BEGIN IMMEDIATE transactions
   * (≤ 500 rows each — never one giant lock hold), then mark the session
   * imported with `src` + `watermark` (mirror file size at import time, §8
   * drift detection). Idempotent: re-import upserts by uuid and keeps seqs.
   * Publishes one post-import wake so an already-active watcher reconciles.
   */
  importLegacyTranscript(
    sessionId: string,
    entries: TranscriptEntry[],
    src: TranscriptImportSrc | string,
    watermark: number | null
  ): Promise<{ inserted: number; updated: number }> {
    if (!this.options.actorOwned) {
      try {
        return Promise.resolve(
          this.importLegacyTranscriptOwned(sessionId, entries, src, watermark),
        );
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return executeSessionProjection(sessionId, "transcript_import", () =>
      this.importLegacyTranscriptOwned(sessionId, entries, src, watermark)
    );
  }

  private importLegacyTranscriptOwned(
    sessionId: string,
    entries: TranscriptEntry[],
    src: TranscriptImportSrc | string,
    watermark: number | null
  ): { inserted: number; updated: number } {
    let inserted = 0;
    let updated = 0;
    for (let i = 0; i < entries.length; i += 500) {
      const chunk = entries.slice(i, i + 500);
      const outcome = this.txWrite.immediate(sessionId, chunk);
      inserted += outcome.inserted;
      updated += outcome.updated;
    }
    this.markImported(sessionId, src, watermark);
    // Initial imports have no subscribers; drift re-imports can. Publishing a
    // single wake after all chunks lets active watches reconcile corrections
    // without exposing partially imported state.
    if (inserted || updated) {
      publishTranscript(sessionId, {
        entries: [],
        firstSeq: 0,
        lastSeq: this.getLastSeq(sessionId),
      });
    }
    return { inserted, updated };
  }

  /** Replace a file-backed transcript authoritatively while preserving the
   * monotonic change cursor. Used for truncation/atomic replacement only. */
  replaceTranscriptEvents(
    sessionId: string,
    entries: TranscriptEntry[]
  ): Promise<{ inserted: number; updated: number }> {
    if (!this.options.actorOwned) {
      try {
        return Promise.resolve(this.replaceTranscriptEventsOwned(sessionId, entries));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return executeSessionProjection(sessionId, "transcript_replace", () =>
      this.replaceTranscriptEventsOwned(sessionId, entries)
    );
  }

  private replaceTranscriptEventsOwned(
    sessionId: string,
    entries: TranscriptEntry[]
  ): { inserted: number; updated: number } {
    const outcome = this.txReplace.immediate(sessionId, entries);
    publishTranscript(sessionId, {
      entries: outcome.affected,
      firstSeq: outcome.affected[0]?.seq ?? 0,
      lastSeq: outcome.affected[outcome.affected.length - 1]?.seq ?? 0,
      reset: true,
    });
    return { inserted: outcome.inserted, updated: outcome.updated };
  }

  /** True when the session has never been imported (one-time gate; cached). */
  needsImport(sessionId: string): boolean {
    return !this.hasImported(sessionId);
  }

  hasImported(sessionId: string): boolean {
    if (this.importedCache.has(sessionId)) return true;
    const row = this.db
      .query("SELECT imported_at FROM transcript_sessions WHERE session_id = ?")
      .get(sessionId) as { imported_at: number | null } | null;
    if (row?.imported_at != null) {
      this.importedCache.add(sessionId);
      return true;
    }
    return false;
  }

  markImported(
    sessionId: string,
    src: TranscriptImportSrc | string,
    watermark: number | null = null
  ): void {
    this.db.run(
      `INSERT INTO transcript_sessions (session_id, next_seq, imported_at, import_src, import_watermark)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         imported_at = excluded.imported_at,
         import_src = excluded.import_src,
         import_watermark = excluded.import_watermark`,
      [sessionId, Date.now(), src, watermark]
    );
    this.importedCache.add(sessionId);
  }

  /** imported_at/src/watermark for §8 drift detection; null if never imported. */
  getImportInfo(sessionId: string): TranscriptImportInfo | null {
    const row = this.db
      .query(
        "SELECT imported_at, import_src, import_watermark FROM transcript_sessions WHERE session_id = ?"
      )
      .get(sessionId) as SessionRow | null;
    if (!row || row.imported_at == null) return null;
    return {
      importedAt: row.imported_at,
      src: row.import_src ?? "",
      watermark: row.import_watermark ?? null,
    };
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * The tail a reader should OPEN on: at least `minEntries` rows, extended
   * back until the window holds enough conversation and user-message
   * boundaries, and stopped by whichever ceiling comes first.
   *
   * Why this exists at all: a flat entry count is a bad proxy for how much
   * conversation a snapshot contains. One turn can be a thousand tool rows,
   * and the UI folds a run of consecutive tool/assistant entries into ONE
   * collapsed "Worked · N steps" block, so a 132-entry tail of such a turn
   * renders as a single fold and reads as an empty session (measured on a
   * real session: 2,256 entries, of which the last 132 held one assistant
   * message and no user message; 17 of the 60 largest sessions in the store
   * had fewer than 8 messages in that window).
   *
   * Two queries, and the first decodes no JSON: a probe over (seq, kind,
   * length(data)) walks the tail newest-first to pick the row count, then the
   * ordinary tail read materializes exactly that many. The probe is bounded by
   * `maxEntries` and rides the (session_id, seq) primary key, so it stays an
   * index scan of at most that many rows rather than a table scan.
   */
  readTailWindow(sessionId: string, opts: TailWindowOpts): TranscriptPage {
    const maxEntries = Math.max(1, Math.floor(opts.maxEntries));
    const minEntries = Math.max(
      1,
      Math.min(Math.floor(opts.minEntries), maxEntries)
    );
    const minMessages = Math.max(0, Math.floor(opts.minMessages));
    const minUserMessagesWithToolWork = Math.max(
      0,
      Math.floor(opts.minUserMessagesWithToolWork ?? 0)
    );
    const maxEstimatedBytes = Math.max(0, opts.maxEstimatedBytes);
    const weigh = opts.weigh ?? ((_kind: string, bytes: number) => bytes);
    const probe = this.db
      .query(
        `SELECT seq, kind, length(CAST(data AS BLOB)) AS bytes
         FROM transcript_events
         WHERE session_id = ? ORDER BY seq DESC LIMIT ?`
      )
      .all(sessionId, maxEntries) as Array<{
      seq: number;
      kind: string;
      bytes: number;
    }>;

    let count = 0;
    let estimatedBytes = 0;
    let messages = 0;
    let userMessages = 0;
    let toolRows = 0;
    for (const row of probe) {
      // Tool-free assistant messages all render in place. A user boundary is
      // needed only once tool work makes the renderer fold those messages.
      const userBoundaryMet =
        toolRows === 0 || userMessages >= minUserMessagesWithToolWork;
      if (count >= minEntries && messages >= minMessages && userBoundaryMet) {
        break;
      }
      const cost = weigh(row.kind, row.bytes ?? 0);
      // The entry floor is unconditional. The byte ceiling only governs the
      // message-seeking extension past it, so a session of enormous rows still
      // opens on the same window it always did.
      if (
        count >= minEntries &&
        estimatedBytes + cost > maxEstimatedBytes
      ) {
        break;
      }
      count++;
      estimatedBytes += cost;
      if (TAIL_WINDOW_MESSAGE_KINDS.has(row.kind)) messages++;
      if (row.kind === "user") userMessages++;
      if (row.kind === "tool_use" || row.kind === "tool_result") toolRows++;
    }

    if (count === 0) return { entries: [], firstSeq: 0, lastSeq: 0 };
    return this.readTail(sessionId, count);
  }

  /** Bounded recent history for an engine handoff. The renderer clips each
   * conversational row to 8 KB and the whole note to 180 KB, so resolving a
   * session's full_ref blobs or reading beyond this window cannot improve the
   * result. Tool-heavy tails may extend to the row ceiling to recover recent
   * user boundaries, but returned rows always remain in their bounded form. */
  readHandoffTail(sessionId: string): TranscriptPage {
    return this.readTailWindow(sessionId, {
      minEntries: 32,
      minMessages: 24,
      minUserMessagesWithToolWork: 4,
      maxEntries: 512,
      maxEstimatedBytes: 180_000,
      weigh: handoffTranscriptEntryWeight,
    });
  }

  /** Last `limit` entries in ascending seq order. */
  readTail(sessionId: string, limit: number = 50): TranscriptPage {
    const rows = this.db
      .query(
        `SELECT seq, change_seq, data, full_ref FROM transcript_events
         WHERE session_id = ? ORDER BY seq DESC LIMIT ?`
      )
      .all(sessionId, Math.max(1, limit)) as EventRow[];
    rows.reverse();
    return page(rows);
  }

  /** Entries with seq > sinceSeq, ascending, up to `limit` (resume path). */
  readSince(sessionId: string, sinceSeq: number, limit: number = 500): TranscriptPage {
    const rows = this.db
      .query(
        `SELECT seq, change_seq, data, full_ref FROM transcript_events
         WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`
      )
      .all(sessionId, sinceSeq, Math.max(1, limit)) as EventRow[];
    return page(rows);
  }

  /** Row mutations after a synchronization cursor. Unlike readSince(seq),
   * this includes rewrites of old display-order rows. */
  readChangesSince(
    sessionId: string,
    sinceChangeSeq: number,
    limit: number = 500
  ): TranscriptPage {
    const rows = this.db
      .query(
        `SELECT seq, change_seq, data, full_ref FROM transcript_events
         WHERE session_id = ? AND change_seq > ?
         ORDER BY change_seq ASC LIMIT ?`
      )
      .all(sessionId, sinceChangeSeq, Math.max(1, limit)) as EventRow[];
    return page(rows);
  }

  /** Entries with seq < beforeSeq — the LAST `limit` of them, ascending
   *  (history paging: walk backwards a page at a time). */
  readBefore(sessionId: string, beforeSeq: number, limit: number = 40): TranscriptPage {
    const rows = this.db
      .query(
        `SELECT seq, change_seq, data, full_ref FROM transcript_events
         WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`
      )
      .all(sessionId, beforeSeq, Math.max(1, limit)) as EventRow[];
    rows.reverse();
    return page(rows);
  }

  /** Full-content page for bounded server-side consumers. Blob hydration and
   * byte accounting happen inside one actor read instead of one RPC per row. */
  readHydratedSince(
    sessionId: string,
    sinceSeq: number,
    limit = 100,
    maxBytes = 12 * 1024 * 1024,
  ): TranscriptHydratedPage {
    const rows = this.db.query(`
      SELECT event.seq, event.change_seq,
        COALESCE(blob.data, event.data) AS data
      FROM transcript_events event
      LEFT JOIN transcript_blobs blob
        ON blob.id = event.full_ref
       AND blob.session_id = event.session_id
       AND blob.uuid = event.uuid
      WHERE event.session_id = ? AND event.seq > ?
      ORDER BY event.seq LIMIT ?
    `).all(sessionId, sinceSeq, limit + 1) as Array<{
      seq: number;
      change_seq: number;
      data: string;
    }>;
    const entries: SeqEntry[] = [];
    let bytes = 0;
    let coveredThroughSeq = sinceSeq;
    let complete = rows.length <= limit;
    for (const row of rows.slice(0, limit)) {
      let entry: TranscriptEntry;
      try {
        entry = sanitizeTranscriptMediaEntry(JSON.parse(row.data) as TranscriptEntry);
      } catch {
        coveredThroughSeq = row.seq;
        continue;
      }
      const hydrated = { ...entry, seq: row.seq, changeSeq: row.change_seq };
      const cost = Buffer.byteLength(JSON.stringify(hydrated));
      if (entries.length > 0 && bytes + cost > maxBytes) {
        complete = false;
        break;
      }
      entries.push(hydrated);
      bytes += cost;
      coveredThroughSeq = row.seq;
    }
    return {
      entries,
      firstSeq: entries[0]?.seq ?? 0,
      lastSeq: entries[entries.length - 1]?.seq ?? 0,
      coveredThroughSeq,
      complete,
    };
  }

  /** Complete content-free outline for virtual scrolling. Existing stores
   * backfill only the session being opened, then every write maintains the
   * projection in the same transaction as its canonical row. */
  readTranscriptIndex(
    sessionId: string,
    afterSeq = 0,
    limit = 1_000_000_000,
  ): TranscriptOutline {
    const rows = this.db
      .query(
        `SELECT uuid, seq, change_seq, ts, render_role, content_length, review_pr_number
         FROM transcript_outline WHERE session_id = ? AND seq > ?
         ORDER BY seq LIMIT ?`
      )
      .all(sessionId, afterSeq, limit) as Array<{
      uuid: string;
      seq: number;
      change_seq: number;
      ts: number;
      render_role: TranscriptIndexRole;
      content_length: number;
      review_pr_number: number | null;
    }>;
    const entries = rows.map((row) => ({
      id: row.uuid,
      seq: row.seq,
      changeSeq: row.change_seq,
      timestampMs: row.ts,
      role: row.render_role,
      contentLength: row.content_length,
      ...(row.review_pr_number != null
        ? { reviewPrNumber: row.review_pr_number }
        : {}),
    }));
    return {
      entries,
      firstSeq: entries[0]?.seq ?? 0,
      lastSeq: entries[entries.length - 1]?.seq ?? 0,
      lastChangeSeq: this.getLastChangeSeq(sessionId),
      epoch: this.getLastResetChangeSeq(sessionId),
    };
  }

  /** One bounded chunk inside an inclusive indexed span. */
  readRange(
    sessionId: string,
    firstSeq: number,
    lastSeq: number,
    afterSeq: number = firstSeq - 1,
    limit: number = 500
  ): TranscriptRangePage {
    const boundedLimit = Math.max(1, limit);
    const rows = this.db
      .query(
        `SELECT seq, change_seq, data, full_ref FROM transcript_events
         WHERE session_id = ? AND seq >= ? AND seq <= ? AND seq > ?
         ORDER BY seq ASC LIMIT ?`
      )
      .all(sessionId, firstSeq, lastSeq, afterSeq, boundedLimit + 1) as EventRow[];
    const complete = rows.length <= boundedLimit;
    const shipped = complete ? rows : rows.slice(0, boundedLimit);
    const hydrated = page(shipped);
    return {
      ...hydrated,
      coveredThroughSeq: shipped[shipped.length - 1]?.seq ?? Math.max(afterSeq, firstSeq - 1),
      complete,
    };
  }

  /**
   * The full (unstripped) entry for the /entry route: blob when the stored
   * row was bounded, else the row's own data. Null when unknown.
   */
  getFullEntry(sessionId: string, uuid: string): TranscriptEntry | null {
    const blob = this.db
      .query("SELECT data FROM transcript_blobs WHERE session_id = ? AND uuid = ?")
      .get(sessionId, uuid) as { data: string } | null;
    const raw =
      blob?.data ??
      (
        this.db
          .query(
            "SELECT data FROM transcript_events WHERE session_id = ? AND uuid = ?"
          )
          .get(sessionId, uuid) as { data: string } | null
      )?.data;
    if (!raw) return null;
    try {
      return sanitizeTranscriptMediaEntry(JSON.parse(raw) as TranscriptEntry);
    } catch {
      return null;
    }
  }

  /** Highest assigned seq for the session (0 when none). */
  getLastSeq(sessionId: string): number {
    const row = this.db
      .query("SELECT next_seq FROM transcript_sessions WHERE session_id = ?")
      .get(sessionId) as { next_seq: number } | null;
    return row ? row.next_seq - 1 : 0;
  }

  /** Highest committed mutation cursor for the session (0 when empty). */
  getLastChangeSeq(sessionId: string): number {
    const row = this.db
      .query("SELECT next_change_seq FROM transcript_sessions WHERE session_id = ?")
      .get(sessionId) as { next_change_seq: number } | null;
    return row ? row.next_change_seq - 1 : 0;
  }

  /** Mutation boundary of the latest authoritative replacement. A reconnect
   * cursor older than this cannot safely merge and must receive a snapshot. */
  getLastResetChangeSeq(sessionId: string): number {
    const row = this.db
      .query("SELECT reset_change_seq FROM transcript_sessions WHERE session_id = ?")
      .get(sessionId) as { reset_change_seq: number } | null;
    return row?.reset_change_seq ?? 0;
  }

  // ── Delete / maintenance ──────────────────────────────────────────────────

  /** Remove every trace of a session (events + blobs + session row). */
  deleteSessionTranscript(sessionId: string): Promise<void> {
    const remove = () => {
      this.txDelete.immediate(sessionId);
      this.importedCache.delete(sessionId);
    };
    if (!this.options.actorOwned) {
      try {
        remove();
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return executeSessionProjection(sessionId, "transcript_delete", remove);
  }

  /**
   * Every session the store holds a row for, with its last write and the seq
   * high-water mark. Reads only transcript_sessions, so it stays a small-table
   * scan on a multi-GB database; the high-water is an UPPER bound on the entry
   * count (an upsert never advances it), which is enough to skip a session
   * without counting its rows.
   */
  listStoredSessions(): Array<{
    sessionId: string;
    lastTs: number | null;
    seqHighWater: number;
  }> {
    const rows = this.db
      .query("SELECT session_id, last_ts, next_seq FROM transcript_sessions")
      .all() as Array<{
      session_id: string;
      last_ts: number | null;
      next_seq: number;
    }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      lastTs: r.last_ts ?? null,
      seqHighWater: Math.max(0, (r.next_seq ?? 1) - 1),
    }));
  }

  /** Exact event count for one session (the primary key leads on session_id). */
  countEvents(sessionId: string): number {
    return (
      this.db
        .query("SELECT COUNT(*) AS n FROM transcript_events WHERE session_id = ?")
        .get(sessionId) as { n: number }
    ).n;
  }

  /** Cheap counters for the daily growth-metric audit line / backfill summary. */
  stats(): { sessions: number; events: number; blobs: number } {
    const count = (sql: string) =>
      (this.db.query(sql).get() as { n: number }).n;
    return {
      sessions: count("SELECT COUNT(*) AS n FROM transcript_sessions"),
      events: count("SELECT COUNT(*) AS n FROM transcript_events"),
      blobs: count("SELECT COUNT(*) AS n FROM transcript_blobs"),
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * The single write routine, always called inside a BEGIN IMMEDIATE
   * transaction: pre-checks the (session_id, uuid) index, updates in place
   * keeping the original seq, and assigns next_seq only to genuine inserts.
   * A (session_id, seq) PK conflict here is a bug and throws.
   */
  private writeEntriesInTx(
    sessionId: string,
    entries: TranscriptEntry[]
  ): WriteOutcome {
    const sessRow = this.db
      .query(
        "SELECT next_seq, next_change_seq FROM transcript_sessions WHERE session_id = ?"
      )
      .get(sessionId) as { next_seq: number; next_change_seq: number } | null;
    let nextSeq = sessRow?.next_seq ?? 1;
    let nextChangeSeq = sessRow?.next_change_seq ?? 1;
    if (!sessRow) {
      this.db.run(
        "INSERT INTO transcript_sessions (session_id, next_seq, next_change_seq) VALUES (?, 1, 1)",
        [sessionId]
      );
    }

    const affected: SeqEntry[] = [];
    let inserted = 0;
    let updated = 0;
    let lastTs: number | null = null;

    for (const entry of entries) {
      const uuid = entry?.id;
      if (!uuid || typeof uuid !== "string") {
        console.warn(
          `[transcript-store] skipping entry without id in ${sessionId} (type=${entry?.type})`
        );
        continue;
      }
      const ts = entryTs(entry);
      const changeSeq = nextChangeSeq++;
      lastTs = ts;
      const bounded = boundEntryForStore(entry);

      // Blob first (need its id for full_ref).
      let fullRef: number | null = null;
      if (bounded.full !== null) {
        const blobRow = this.db
          .query(
            `INSERT INTO transcript_blobs (session_id, uuid, data) VALUES (?, ?, ?)
             ON CONFLICT(session_id, uuid) DO UPDATE SET data = excluded.data
             RETURNING id`
          )
          .get(sessionId, uuid, bounded.full) as { id: number };
        fullRef = blobRow.id;
      }

      const existing = this.db
        .query(
          "SELECT seq, full_ref FROM transcript_events WHERE session_id = ? AND uuid = ?"
        )
        .get(sessionId, uuid) as { seq: number; full_ref: number | null } | null;

      if (existing) {
        // Upsert: keep ORIGINAL seq, update data/full_ref/ts (§1 semantics).
        if (existing.full_ref != null && fullRef == null) {
          // Entry shrank below the bound — drop the now-stale blob.
          this.db.run(
            "DELETE FROM transcript_blobs WHERE session_id = ? AND uuid = ?",
            [sessionId, uuid]
          );
        }
        this.db.run(
          `UPDATE transcript_events
           SET kind = ?, data = ?, full_ref = ?, ts = ?, change_seq = ?
           WHERE session_id = ? AND seq = ?`,
          [entry.type ?? "unknown", bounded.data, fullRef, ts, changeSeq, sessionId, existing.seq]
        );
        updated++;
        affected.push({ ...bounded.entry, seq: existing.seq, changeSeq });
      } else {
        const seq = nextSeq++;
        this.db.run(
          `INSERT INTO transcript_events
             (session_id, seq, uuid, ts, kind, data, full_ref, change_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sessionId,
            seq,
            uuid,
            ts,
            entry.type ?? "unknown",
            bounded.data,
            fullRef,
            changeSeq,
          ]
        );
        inserted++;
        affected.push({ ...bounded.entry, seq, changeSeq });
      }

      const seq = existing?.seq ?? nextSeq - 1;
      this.writeOutlineRow(sessionId, seq, changeSeq, ts, entry);
    }

    this.db.run(
      `UPDATE transcript_sessions
       SET next_seq = ?, next_change_seq = ?, last_ts = COALESCE(?, last_ts)
       WHERE session_id = ?`,
      [nextSeq, nextChangeSeq, lastTs, sessionId]
    );

    return { affected, inserted, updated };
  }

  private writeOutlineRow(
    sessionId: string,
    seq: number,
    changeSeq: number,
    ts: number,
    entry: TranscriptEntry
  ): void {
    const projection = transcriptOutlineProjection(entry);
    this.db.run(
      `INSERT INTO transcript_outline
         (session_id, seq, uuid, change_seq, ts, render_role, content_length, review_pr_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, seq) DO UPDATE SET
         uuid = excluded.uuid,
         change_seq = excluded.change_seq,
         ts = excluded.ts,
         render_role = excluded.render_role,
         content_length = excluded.content_length,
         review_pr_number = excluded.review_pr_number`,
      [
        sessionId,
        seq,
        entry.id,
        changeSeq,
        ts,
        projection.role,
        projection.contentLength,
        projection.reviewPrNumber ?? null,
      ]
    );
  }

  /** Backfill one session without monopolizing Bun's event loop or the sole
   * writer transaction. Concurrent viewers share the same resumable walk. */
  ensureTranscriptOutline(sessionId: string): Promise<void> {
    const existing = this.outlineBackfills.get(sessionId);
    if (existing) return existing;
    const work = this.backfillTranscriptOutline(sessionId).finally(() => {
      this.outlineBackfills.delete(sessionId);
    });
    this.outlineBackfills.set(sessionId, work);
    return work;
  }

  private async backfillTranscriptOutline(sessionId: string): Promise<void> {
    let afterSeq = 0;
    let epoch = this.getLastResetChangeSeq(sessionId);
    for (;;) {
      // The canonical event row is write-bounded to 32 KB and retains the
      // original contentLength marker plus notice/context metadata. Reading it
      // caps one slice at 3.2 MB; fetching 100 unbounded blobs would not.
      const rows = this.db
        .query(
          `SELECT e.seq, e.change_seq, e.ts, e.data, o.seq AS outline_seq
           FROM transcript_events e
           LEFT JOIN transcript_outline o
             ON o.session_id = e.session_id AND o.seq = e.seq
           WHERE e.session_id = ? AND e.seq > ?
           ORDER BY e.seq LIMIT 100`
        )
        .all(sessionId, afterSeq) as Array<{
        seq: number;
        change_seq: number;
        ts: number;
        data: string;
        outline_seq: number | null;
      }>;
      if (!rows.length) {
        const currentEpoch = this.getLastResetChangeSeq(sessionId);
        if (currentEpoch === epoch) return;
        epoch = currentEpoch;
        afterSeq = 0;
        continue;
      }
      afterSeq = rows[rows.length - 1]!.seq;
      const missing = rows.filter((row) => row.outline_seq == null);
      const parsed = missing.map((row) => {
        try {
          return {
            row,
            entry: sanitizeTranscriptMediaEntry(
              JSON.parse(row.data) as TranscriptEntry
            ),
          };
        } catch {
          return { row, entry: null };
        }
      });
      this.db.transaction(() => {
        for (const { row, entry } of parsed) {
          if (entry) {
            this.writeOutlineRow(
              sessionId,
              row.seq,
              row.change_seq,
              row.ts,
              entry
            );
          } else {
            this.db.run(
              `INSERT OR REPLACE INTO transcript_outline
                 (session_id, seq, uuid, change_seq, ts, render_role, content_length)
               SELECT session_id, seq, uuid, change_seq, ts, 'hidden', 0
               FROM transcript_events WHERE session_id = ? AND seq = ?`,
              [sessionId, row.seq]
            );
          }
        }
      }).immediate();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const currentEpoch = this.getLastResetChangeSeq(sessionId);
      if (currentEpoch !== epoch) {
        epoch = currentEpoch;
        afterSeq = 0;
      }
    }
  }

  /** Additive migration from the original seq-only store. Existing rows form
   * the baseline state, so their immutable seq is the only honest initial
   * change cursor; future mutations advance independently. */
  private migrateChangeSequence(): void {
    const eventColumns = this.db
      .query("PRAGMA table_info(transcript_events)")
      .all() as Array<{ name: string }>;
    const sessionColumns = this.db
      .query("PRAGMA table_info(transcript_sessions)")
      .all() as Array<{ name: string }>;
    const hasEventChange = eventColumns.some((c) => c.name === "change_seq");
    const hasNextChange = sessionColumns.some(
      (c) => c.name === "next_change_seq"
    );
    const hasResetChange = sessionColumns.some(
      (c) => c.name === "reset_change_seq"
    );
    this.db.transaction(() => {
      if (!hasEventChange) {
        this.db.exec(
          "ALTER TABLE transcript_events ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0"
        );
      }
      if (!hasNextChange) {
        this.db.exec(
          "ALTER TABLE transcript_sessions ADD COLUMN next_change_seq INTEGER NOT NULL DEFAULT 1"
        );
      }
      if (!hasResetChange) {
        this.db.exec(
          "ALTER TABLE transcript_sessions ADD COLUMN reset_change_seq INTEGER NOT NULL DEFAULT 0"
        );
      }
      this.db.exec("UPDATE transcript_events SET change_seq = seq WHERE change_seq = 0");
      this.db.exec(`
        UPDATE transcript_sessions
        SET next_change_seq = MAX(
          next_change_seq,
          reset_change_seq + 1,
          COALESCE(
            (SELECT MAX(change_seq) + 1 FROM transcript_events
             WHERE transcript_events.session_id = transcript_sessions.session_id),
            1
          )
        )
      `);
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_te_change
        ON transcript_events(session_id, change_seq)`);
    }).immediate();
  }
}

// ── Destination validation + identity ─────────────────────────────────────

export const TRANSCRIPT_DESTINATION_MAX_ENTRIES = 500;
export const TRANSCRIPT_DESTINATION_MAX_BYTES = 4 * 1024 * 1024;
const DESTINATION_HASH_DOMAIN =
  "opensession.transcript-destination-append.v1\0";
const TRANSCRIPT_DESTINATION_MAX_JSON_DEPTH = 64;
const DESTINATION_RECEIPT_FENCE_MAX_BYTES = 64 * 1024;
const DESTINATION_REQUEST_KEYS = [
  "appendId",
  "entries",
  "generation",
  "runId",
  "sessionId",
  "turnId",
] as const;
const DESTINATION_REQUEST_KEYS_WITH_ANCHOR = [
  "appendId",
  "entries",
  "generation",
  "runId",
  "sessionId",
  "transcriptAnchor",
  "turnId",
] as const;
const DESTINATION_QUERY_KEYS = [
  "appendId",
  "generation",
  "requestDigest",
  "runId",
  "sessionId",
  "turnId",
] as const;
const DESTINATION_QUERY_KEYS_WITH_ANCHOR = [
  "appendId",
  "generation",
  "requestDigest",
  "runId",
  "sessionId",
  "transcriptAnchor",
  "turnId",
] as const;
const DESTINATION_VALIDATION_KEYS_WITH_ANCHOR = [
  "generation",
  "receipt",
  "runId",
  "sessionId",
  "transcriptAnchor",
  "turnId",
] as const;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const RAW_SHA256_DIGEST = /^[a-f0-9]{64}$/;
const TRANSCRIPT_ENTRY_KEYS = new Set([
  "agentId",
  "content",
  "contextInjection",
  "featuredMedia",
  "files",
  "id",
  "images",
  "isError",
  "model",
  "noticeKind",
  "requestId",
  "sender",
  "senderVia",
  "timestamp",
  "toolInput",
  "toolName",
  "toolUseId",
  "type",
  "videos",
]);
const TRANSCRIPT_TYPES = new Set([
  "user",
  "assistant",
  "tool_use",
  "tool_result",
  "system",
]);

function exactSortedKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function validateDestinationAppend(
  input: unknown,
  requireAgentReceipt: boolean,
): ValidatedDestinationAppend {
  const record = snapshotPlainJson(input, "request") as Record<string, unknown>;
  const hasAnchor = Object.hasOwn(record, "transcriptAnchor");
  if (
    hasAnchor !== requireAgentReceipt ||
    !exactSortedKeys(
      record,
      requireAgentReceipt
        ? DESTINATION_REQUEST_KEYS_WITH_ANCHOR
        : DESTINATION_REQUEST_KEYS,
    )
  )
    throw new TypeError("Invalid transcript destination request keys");
  const sessionId = boundedId(record.sessionId, "sessionId", 128);
  const runId = boundedId(record.runId, "runId", 256);
  const turnId = boundedId(record.turnId, "turnId", 256);
  const appendId = boundedId(record.appendId, "appendId", 128);
  const generation = record.generation;
  if (!Number.isSafeInteger(generation) || (generation as number) < 1)
    throw new TypeError("Invalid transcript destination generation");
  if (!Array.isArray(record.entries) || record.entries.length === 0)
    throw new TypeError("Transcript destination entries must be non-empty");
  if (record.entries.length > TRANSCRIPT_DESTINATION_MAX_ENTRIES)
    throw new RangeError("Too many transcript destination entries");

  const entries = record.entries.map((value, index) =>
    validateDestinationEntry(value, index),
  );
  const transcriptAnchor = hasAnchor
    ? validateTranscriptAnchor(record.transcriptAnchor)
    : undefined;
  if (requireAgentReceipt) {
    if (!transcriptAnchor)
      throw new TranscriptAppendAgentReceiptInvariantError();
    const entryIds = entries.map((entry) => entry.id);
    if (new Set(entryIds).size !== entryIds.length)
      throw new TranscriptAppendAgentReceiptInvariantError();
  }
  const fence = {
    sessionId,
    runId,
    turnId,
    generation: generation as number,
    ...(transcriptAnchor ? { transcriptAnchor } : {}),
  };
  const fenceJson = canonicalDestinationJson(fence);
  if (Buffer.byteLength(fenceJson) > DESTINATION_RECEIPT_FENCE_MAX_BYTES)
    throw new RangeError("Transcript destination fence exceeds byte limit");
  const payloadJson = canonicalDestinationJson({
    fence,
    entries: requireAgentReceipt ? entries : record.entries,
  });
  if (Buffer.byteLength(payloadJson) > TRANSCRIPT_DESTINATION_MAX_BYTES)
    throw new RangeError("Transcript destination payload is too large");
  const digest = new Bun.CryptoHasher("sha256")
    .update(DESTINATION_HASH_DOMAIN)
    .update(payloadJson)
    .digest("hex");
  return {
    ...fence,
    appendId,
    entries,
    digest,
    fenceJson,
    requireAgentReceipt,
  };
}

function validateTranscriptAnchor(value: unknown): AgentTranscriptAnchorV1 {
  if (
    !isPlainRecord(value) ||
    !exactSortedKeys(value, ["digest", "entryIds", "throughChangeSeq"])
  )
    throw new TypeError("Invalid transcript destination anchor");
  if (!SHA256_DIGEST.test(String(value.digest)))
    throw new TypeError("Invalid transcript destination anchor digest");
  if (
    !Number.isSafeInteger(value.throughChangeSeq) ||
    (value.throughChangeSeq as number) < 0 ||
    !Array.isArray(value.entryIds) ||
    value.entryIds.length > 512
  )
    throw new TypeError("Invalid transcript destination anchor range");
  const entryIds = value.entryIds.map((entryId) =>
    boundedId(entryId, "transcriptAnchor.entryId", 256),
  );
  if (new Set(entryIds).size !== entryIds.length)
    throw new TypeError("Duplicate transcript destination anchor entry");
  return Object.freeze({
    throughChangeSeq: value.throughChangeSeq as number,
    entryIds: Object.freeze(entryIds),
    digest: value.digest as `sha256:${string}`,
  });
}

function validateTurnFenceRecord(
  record: Record<string, unknown>,
): TranscriptTurnFence & { transcriptAnchor?: AgentTranscriptAnchorV1 } {
  const sessionId = boundedId(record.sessionId, "sessionId", 128);
  const runId = boundedId(record.runId, "runId", 256);
  const turnId = boundedId(record.turnId, "turnId", 256);
  if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 1)
    throw new TypeError("Invalid transcript destination generation");
  const fence = {
    sessionId,
    runId,
    turnId,
    generation: record.generation as number,
    ...(Object.hasOwn(record, "transcriptAnchor")
      ? { transcriptAnchor: validateTranscriptAnchor(record.transcriptAnchor) }
      : {}),
  };
  if (
    Buffer.byteLength(canonicalDestinationJson(fence)) >
    DESTINATION_RECEIPT_FENCE_MAX_BYTES
  )
    throw new RangeError("Transcript destination fence exceeds byte limit");
  return fence;
}

function validateDestinationReceiptQuery(
  input: unknown,
): DestinationTranscriptReceiptQuery {
  const record = snapshotPlainJson(input, "receiptQuery") as Record<
    string,
    unknown
  >;
  const hasAnchor = Object.hasOwn(record, "transcriptAnchor");
  if (
    !exactSortedKeys(
      record,
      hasAnchor ? DESTINATION_QUERY_KEYS_WITH_ANCHOR : DESTINATION_QUERY_KEYS,
    )
  )
    throw new TypeError("Invalid transcript destination receipt query keys");
  const fence = validateTurnFenceRecord(record);
  const appendId = boundedId(record.appendId, "appendId", 128);
  if (!SHA256_DIGEST.test(String(record.requestDigest)))
    throw new TypeError("Invalid transcript destination receipt digest");
  return Object.freeze({
    ...fence,
    appendId,
    requestDigest: record.requestDigest as `sha256:${string}`,
  });
}

function validateAgentTranscriptReceiptRequest(
  input: unknown,
): AgentTranscriptReceiptValidationRequest {
  const record = snapshotPlainJson(input, "receiptValidation") as Record<
    string,
    unknown
  >;
  if (!exactSortedKeys(record, DESTINATION_VALIDATION_KEYS_WITH_ANCHOR))
    throw new TypeError("Invalid Agent transcript receipt validation keys");
  const fence = validateTurnFenceRecord(record);
  if (!fence.transcriptAnchor)
    throw new TypeError("Agent transcript receipt requires an anchor");
  const receipt = decodeAgentTranscriptReceiptRefV1(record.receipt);
  if (!receipt)
    throw new TypeError("Invalid Agent transcript receipt reference");
  return Object.freeze({
    ...fence,
    transcriptAnchor: fence.transcriptAnchor,
    receipt,
  });
}

function parseDestinationReceiptJson(
  value: unknown,
  path: string,
  maxBytes: number,
): unknown {
  if (typeof value !== "string" || Buffer.byteLength(value) > maxBytes)
    throw new TranscriptAppendReceiptCorruptError();
  try {
    return snapshotPlainJson(JSON.parse(value), path);
  } catch {
    throw new TranscriptAppendReceiptCorruptError();
  }
}

function validStoredMutationResult(value: unknown): boolean {
  if (value === null) return true;
  if (!isPlainRecord(value)) return false;
  const nonnegative = (candidate: unknown) =>
    Number.isSafeInteger(candidate) && (candidate as number) >= 0;
  if (exactSortedKeys(value, ["inserted", "updated"]))
    return nonnegative(value.inserted) && nonnegative(value.updated);
  if (exactSortedKeys(value, ["firstSeq", "inserted", "lastSeq", "updated"]))
    return nonnegative(value.inserted) && nonnegative(value.updated) &&
      Number.isSafeInteger(value.firstSeq) && (value.firstSeq as number) >= 1 &&
      Number.isSafeInteger(value.lastSeq) &&
      (value.lastSeq as number) >= (value.firstSeq as number);
  if (!exactSortedKeys(value, ["changes", "firstSeq", "inserted", "lastSeq", "updated"]) ||
      !Array.isArray(value.changes) || value.changes.length === 0 ||
      value.changes.length > TRANSCRIPT_DESTINATION_MAX_ENTRIES ||
      !nonnegative(value.inserted) || !nonnegative(value.updated)) return false;
  return value.changes.every((change, index) =>
    isPlainRecord(change) &&
    exactSortedKeys(change, ["changeSeq", "entryId", "seq"]) &&
    typeof change.entryId === "string" && change.entryId.length > 0 &&
    Buffer.byteLength(change.entryId, "utf8") <= 256 &&
    Number.isSafeInteger(change.seq) && (change.seq as number) >= 1 &&
    Number.isSafeInteger(change.changeSeq) && (change.changeSeq as number) >= 1 &&
    (index === 0 ||
      (change.changeSeq as number) ===
        ((value.changes as Array<Record<string, unknown>>)[index - 1]!.changeSeq as number) + 1)
  );
}

export function validateTranscriptAppendReceiptRow(
  row: TranscriptAppendReceiptRow,
): void {
  try {
    const sessionId = boundedId(row.session_id, "sessionId", 128);
    boundedId(row.append_id, "appendId", 128);
    if (
      typeof row.request_digest !== "string" ||
      !RAW_SHA256_DIGEST.test(row.request_digest) ||
      !Number.isSafeInteger(row.created_at) ||
      (row.created_at as number) < 0
    ) throw new TypeError("Invalid durable transcript receipt metadata");
    const fence = parseDestinationReceiptJson(
      row.fence_json,
      "durableFence",
      DESTINATION_RECEIPT_FENCE_MAX_BYTES,
    );
    const result = parseDestinationReceiptJson(
      row.result_json,
      "durableResult",
      TRANSCRIPT_DESTINATION_MAX_BYTES,
    );
    if (
      canonicalDestinationJson(fence) !== row.fence_json ||
      canonicalDestinationJson(result) !== row.result_json
    ) throw new TypeError("Non-canonical durable transcript receipt");
    if (isPlainRecord(fence) && Object.hasOwn(fence, "sessionId")) {
      decodeDestinationReceiptRow(row);
      return;
    }
    if (
      !isPlainRecord(fence) ||
      !exactSortedKeys(fence, ["expectedEpoch", "generation", "runId", "turnId"]) ||
      (fence.expectedEpoch !== null &&
        (!Number.isSafeInteger(fence.expectedEpoch) || (fence.expectedEpoch as number) < 0)) ||
      (fence.generation !== null &&
        (!Number.isSafeInteger(fence.generation) || (fence.generation as number) < 0)) ||
      (fence.runId !== null && boundedId(fence.runId, "runId", 128) !== fence.runId) ||
      (fence.turnId !== null && boundedId(fence.turnId, "turnId", 128) !== fence.turnId) ||
      !isPlainRecord(result) ||
      !exactSortedKeys(result, ["replay", "result", "wakeCursor"]) ||
      result.replay !== false ||
      !Number.isSafeInteger(result.wakeCursor) ||
      (result.wakeCursor as number) < 1 ||
      !validStoredMutationResult(result.result)
    ) throw new TypeError(`Invalid actor transcript receipt for ${sessionId}`);
    assertTranscriptActorResponse(result);
  } catch (error) {
    if (error instanceof TranscriptAppendReceiptCorruptError) throw error;
    throw new TranscriptAppendReceiptCorruptError();
  }
}

function decodeDestinationReceiptRow(
  row: TranscriptAppendReceiptRow,
): DestinationTranscriptAppendReceipt {
  try {
    const sessionId = boundedId(row.session_id, "sessionId", 128);
    const appendId = boundedId(row.append_id, "appendId", 128);
    if (
      typeof row.request_digest !== "string" ||
      !RAW_SHA256_DIGEST.test(row.request_digest) ||
      !Number.isSafeInteger(row.created_at) ||
      (row.created_at as number) < 0
    )
      throw new TypeError("Invalid durable transcript receipt metadata");
    const fenceValue = parseDestinationReceiptJson(
      row.fence_json,
      "durableFence",
      DESTINATION_RECEIPT_FENCE_MAX_BYTES,
    );
    if (!isPlainRecord(fenceValue))
      throw new TypeError("Invalid durable transcript receipt fence");
    const hasAnchor = Object.hasOwn(fenceValue, "transcriptAnchor");
    if (
      !exactSortedKeys(
        fenceValue,
        hasAnchor
          ? ["generation", "runId", "sessionId", "transcriptAnchor", "turnId"]
          : ["generation", "runId", "sessionId", "turnId"],
      )
    )
      throw new TypeError("Invalid durable transcript receipt fence keys");
    const fence = validateTurnFenceRecord(fenceValue);
    if (fence.sessionId !== sessionId)
      throw new TypeError("Contradictory durable transcript receipt session");

    const resultValue = parseDestinationReceiptJson(
      row.result_json,
      "durableResult",
      TRANSCRIPT_DESTINATION_MAX_BYTES,
    );
    if (
      !isPlainRecord(resultValue) ||
      !exactSortedKeys(resultValue, [
        "changes",
        "firstSeq",
        "inserted",
        "lastSeq",
        "updated",
      ]) ||
      !Array.isArray(resultValue.changes) ||
      resultValue.changes.length === 0 ||
      resultValue.changes.length > TRANSCRIPT_DESTINATION_MAX_ENTRIES ||
      !Number.isSafeInteger(resultValue.inserted) ||
      (resultValue.inserted as number) < 0 ||
      !Number.isSafeInteger(resultValue.updated) ||
      (resultValue.updated as number) < 0
    )
      throw new TypeError("Invalid durable transcript receipt result");
    const changes = resultValue.changes.map((candidate) => {
      if (
        !isPlainRecord(candidate) ||
        !exactSortedKeys(candidate, ["changeSeq", "entryId", "seq"]) ||
        !Number.isSafeInteger(candidate.seq) ||
        (candidate.seq as number) < 1 ||
        !Number.isSafeInteger(candidate.changeSeq) ||
        (candidate.changeSeq as number) < 1
      )
        throw new TypeError("Invalid durable transcript receipt change");
      return Object.freeze({
        entryId: boundedId(candidate.entryId, "entryId", 256),
        seq: candidate.seq as number,
        changeSeq: candidate.changeSeq as number,
      });
    });
    const entryIds = changes.map((change) => change.entryId);
    if (
      (resultValue.inserted as number) + (resultValue.updated as number) !==
        changes.length ||
      changes.some(
        (change, index) =>
          index > 0 &&
          change.changeSeq !== changes[index - 1]!.changeSeq + 1,
      )
    )
      throw new TypeError("Contradictory durable transcript receipt changes");
    const firstSeq = Math.min(...changes.map((change) => change.seq));
    const lastSeq = Math.max(...changes.map((change) => change.seq));
    const throughChangeSeq = Math.max(
      ...changes.map((change) => change.changeSeq),
    );
    if (
      resultValue.firstSeq !== firstSeq ||
      resultValue.lastSeq !== lastSeq
    )
      throw new TypeError("Contradictory durable transcript receipt range");
    return Object.freeze({
      version: 1,
      ...fence,
      appendId,
      requestDigest: `sha256:${row.request_digest}`,
      entryIds: Object.freeze(entryIds),
      firstSeq,
      lastSeq,
      throughChangeSeq,
      inserted: resultValue.inserted as number,
      updated: resultValue.updated as number,
      changes: Object.freeze(changes),
    });
  } catch (error) {
    if (error instanceof TranscriptAppendReceiptCorruptError) throw error;
    throw new TranscriptAppendReceiptCorruptError();
  }
}

function destinationAppendResult(
  receipt: DestinationTranscriptAppendReceipt,
): DestinationTranscriptAppendResult {
  return {
    changes: receipt.changes.map((change) => ({
      changeSeq: change.changeSeq,
      entryId: change.entryId,
      seq: change.seq,
    })),
    firstSeq: receipt.firstSeq,
    inserted: receipt.inserted,
    lastSeq: receipt.lastSeq,
    updated: receipt.updated,
  };
}

function destinationAgentReceiptRef(
  receipt: DestinationTranscriptAppendReceipt,
): AgentTranscriptReceiptRefV1 {
  if (
    receipt.changes.some(
      (change, index) => change.seq !== receipt.firstSeq + index,
    )
  )
    throw new TranscriptAppendReceiptMismatchError();
  const decoded = decodeAgentTranscriptReceiptRefV1({
    appendId: receipt.appendId,
    entryIds: receipt.entryIds,
    firstSeq: receipt.firstSeq,
    lastSeq: receipt.lastSeq,
    throughChangeSeq: receipt.throughChangeSeq,
    requestDigest: receipt.requestDigest,
  });
  if (!decoded) throw new TranscriptAppendReceiptMismatchError();
  return decoded;
}

function validateDestinationEntry(
  value: unknown,
  index: number,
): TranscriptEntry {
  assertPlainJson(value, `entries[${index}]`);
  const entry = value as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!TRANSCRIPT_ENTRY_KEYS.has(key))
      throw new TypeError(`Unknown transcript entry key: ${key}`);
  }
  boundedId(entry.id, `entries[${index}].id`, 256);
  if (typeof entry.type !== "string" || !TRANSCRIPT_TYPES.has(entry.type))
    throw new TypeError(`Invalid transcript entry type at ${index}`);
  if (typeof entry.content !== "string")
    throw new TypeError(`Invalid transcript entry content at ${index}`);
  if (
    typeof entry.timestamp !== "string" ||
    !Number.isFinite(Date.parse(entry.timestamp))
  )
    throw new TypeError(`Invalid transcript entry timestamp at ${index}`);
  for (const key of [
    "toolName",
    "toolUseId",
    "requestId",
    "model",
    "agentId",
    "sender",
  ]) {
    if (entry[key] !== undefined && typeof entry[key] !== "string")
      throw new TypeError(`Invalid transcript entry ${key} at ${index}`);
  }
  for (const key of ["isError"]) {
    if (entry[key] !== undefined && typeof entry[key] !== "boolean")
      throw new TypeError(`Invalid transcript entry ${key} at ${index}`);
  }
  for (const key of ["images", "videos", "featuredMedia"]) {
    if (
      entry[key] !== undefined &&
      (!Array.isArray(entry[key]) ||
        !(entry[key] as unknown[]).every((item) => typeof item === "string"))
    )
      throw new TypeError(`Invalid transcript entry ${key} at ${index}`);
  }
  if (
    entry.noticeKind !== undefined &&
    (typeof entry.noticeKind !== "string" ||
      Buffer.byteLength(entry.noticeKind) > 64)
  )
    throw new TypeError(`Invalid transcript entry noticeKind at ${index}`);
  if (entry.senderVia !== undefined && entry.senderVia !== "slack")
    throw new TypeError(`Invalid transcript entry senderVia at ${index}`);
  if (entry.contextInjection !== undefined) {
    const context = entry.contextInjection;
    if (!isPlainRecord(context))
      throw new TypeError(
        `Invalid transcript entry contextInjection at ${index}`,
      );
    const contextKeys = Object.keys(context);
    if (
      contextKeys.some(
        (key) => !["bytes", "hash", "source", "turnId"].includes(key),
      )
    )
      throw new TypeError(
        `Invalid transcript entry contextInjection at ${index}`,
      );
    if (typeof context.source !== "string" || !context.source)
      throw new TypeError(
        `Invalid transcript entry contextInjection source at ${index}`,
      );
    for (const key of ["hash", "turnId"]) {
      if (context[key] !== undefined && typeof context[key] !== "string")
        throw new TypeError(
          `Invalid transcript entry contextInjection ${key} at ${index}`,
        );
    }
    if (
      context.bytes !== undefined &&
      (!Number.isSafeInteger(context.bytes) || (context.bytes as number) < 0)
    )
      throw new TypeError(
        `Invalid transcript entry contextInjection bytes at ${index}`,
      );
  }
  if (entry.files !== undefined) {
    if (!Array.isArray(entry.files))
      throw new TypeError(`Invalid transcript entry files at ${index}`);
    for (const file of entry.files) {
      if (
        !isPlainRecord(file) ||
        Object.keys(file).sort().join(",") !== "name,path" ||
        typeof file.name !== "string" ||
        typeof file.path !== "string"
      )
        throw new TypeError(`Invalid transcript entry file at ${index}`);
    }
  }
  return sanitizeTranscriptMediaEntry(value as TranscriptEntry);
}

function boundedId(value: unknown, name: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > maxBytes ||
    value.includes("\0")
  )
    throw new TypeError(`Invalid transcript destination ${name}`);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainJson(
  value: unknown,
  path: string,
  seen = new Set<object>(),
  depth = 0,
): void {
  if (depth > TRANSCRIPT_DESTINATION_MAX_JSON_DEPTH)
    throw new RangeError(
      `Transcript destination JSON is too deeply nested at ${path}`,
    );
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError(`Non-finite JSON number at ${path}`);
    return;
  }
  if (typeof value !== "object")
    throw new TypeError(`Unsupported JSON value at ${path}`);
  if (seen.has(value)) throw new TypeError(`Cyclic JSON value at ${path}`);
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const descriptorKeys = Reflect.ownKeys(descriptors);
  if (descriptorKeys.some((key) => typeof key !== "string"))
    throw new TypeError(`Symbol JSON key at ${path}`);
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      descriptorKeys.length !== value.length + 1
    )
      throw new TypeError(`Invalid JSON array at ${path}`);
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        descriptor.value === undefined
      )
        throw new TypeError(`Sparse or accessor JSON array at ${path}`);
      assertPlainJson(
        descriptor.value,
        `${path}[${index}]`,
        seen,
        depth + 1,
      );
    }
  } else {
    if (!isPlainRecord(value))
      throw new TypeError(`Non-plain JSON object at ${path}`);
    for (const key of descriptorKeys as string[]) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        descriptor.value === undefined
      )
        throw new TypeError(`Accessor or undefined JSON value at ${path}.${key}`);
      assertPlainJson(descriptor.value, `${path}.${key}`, seen, depth + 1);
    }
  }
  seen.delete(value);
}

function snapshotPlainJson(value: unknown, path: string): unknown {
  assertPlainJson(value, path);
  try {
    const snapshot = structuredClone(value);
    assertPlainJson(snapshot, path);
    return snapshot;
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) throw error;
    throw new TypeError(`Invalid transcript destination JSON at ${path}`);
  }
}

function canonicalDestinationJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value)!;
  if (Array.isArray(value))
    return `[${value.map(canonicalDestinationJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalDestinationJson(record[key])}`,
    )
    .join(",")}}`;
}

function appendResult(outcome: WriteOutcome): AppendResult | null {
  if (outcome.affected.length === 0) return null;
  let firstSeq = outcome.affected[0].seq;
  let lastSeq = firstSeq;
  for (const entry of outcome.affected) {
    firstSeq = Math.min(firstSeq, entry.seq);
    lastSeq = Math.max(lastSeq, entry.seq);
  }
  return {
    firstSeq,
    lastSeq,
    inserted: outcome.inserted,
    updated: outcome.updated,
  };
}

function destinationResult(
  outcome: WriteOutcome,
): DestinationTranscriptAppendResult {
  let firstSeq = 0;
  let lastSeq = 0;
  const changes = outcome.affected.map((entry) => {
    if (!firstSeq || entry.seq < firstSeq) firstSeq = entry.seq;
    if (entry.seq > lastSeq) lastSeq = entry.seq;
    return { entryId: entry.id, seq: entry.seq, changeSeq: entry.changeSeq };
  });
  return {
    firstSeq,
    lastSeq,
    inserted: outcome.inserted,
    updated: outcome.updated,
    changes,
  };
}

// ── Outline projection ─────────────────────────────────────────────────────

function transcriptOutlineProjection(entry: TranscriptEntry): {
  role: TranscriptIndexRole;
  contentLength: number;
  reviewPrNumber?: number;
} {
  if (dropContextInjections([entry]).length === 0) {
    return { role: "hidden", contentLength: 0 };
  }
  const classified = classifyEntry(entry);
  let role: TranscriptIndexRole;
  let reviewPrNumber: number | undefined;
  if (classified.notice?.kind === "review-handoff") {
    role = "review_handoff";
    const match = classified.notice.title.match(/PR #(\d+)/);
    if (match) reviewPrNumber = Number(match[1]);
  } else if (classified.notice) {
    role = "notice";
  } else if (classified.type === "user") {
    role = "user";
  } else if (classified.type === "assistant") {
    role = "assistant";
  } else if (classified.type === "tool_use") {
    role = "tool_use";
  } else if (classified.type === "tool_result") {
    role = "tool_result";
  } else {
    role = "system";
  }
  return {
    role,
    contentLength: entry.contentLength ?? entry.content?.length ?? 0,
    ...(reviewPrNumber !== undefined ? { reviewPrNumber } : {}),
  };
}

// ── Bounding ───────────────────────────────────────────────────────────────

function entryTs(entry: TranscriptEntry): number {
  const t = Date.parse(entry.timestamp ?? "");
  return Number.isFinite(t) ? t : Date.now();
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/**
 * Byte-based write-time bounding (§1). Returns the wire-ready `data` JSON
 * (guaranteed <= TRANSCRIPT_DATA_MAX_BYTES), the full original JSON when the
 * entry had to be stripped (else null), and the parsed stripped entry (what
 * goes on the bus/wire — identical to the original when nothing changed).
 */
function boundEntryForStore(entry: TranscriptEntry): {
  data: string;
  full: string | null;
  entry: TranscriptEntry;
} {
  const raw = safeStringify(entry);
  if (!raw) {
    // Unserializable entry (should be impossible for parsed entries) — store
    // a minimal skeleton so the append never throws.
    const skeleton: TranscriptEntry = {
      id: entry.id,
      type: entry.type,
      content: "",
      timestamp: entry.timestamp,
    };
    return { data: safeStringify(skeleton), full: null, entry: skeleton };
  }
  if (Buffer.byteLength(raw) <= TRANSCRIPT_DATA_MAX_BYTES) {
    return { data: raw, full: null, entry };
  }

  const stripped = { ...entry } as TranscriptEntry & {
    toolInput?: unknown;
    contentClamped?: boolean;
    contentLength?: number;
  };

  // toolInput → small summary (full input stays readable via getFullEntry).
  if (stripped.toolInput !== undefined) {
    const tiJson = safeStringify(stripped.toolInput);
    const keys =
      stripped.toolInput &&
      typeof stripped.toolInput === "object" &&
      !Array.isArray(stripped.toolInput)
        ? Object.keys(stripped.toolInput as Record<string, unknown>).slice(0, 50)
        : [];
    stripped.toolInput = {
      toolName: entry.toolName ?? "",
      byteSize: Buffer.byteLength(tiJson),
      keys,
    };
  }

  // images[] data-URLs → os-blob markers the UI resolves via /entry.
  if (Array.isArray(stripped.images)) {
    stripped.images = stripped.images.map((src, i) =>
      typeof src === "string" && src.startsWith("data:")
        ? `os-blob:${entry.id}/${i}`
        : src
    );
  }

  // Byte-truncate content until the serialized form fits, with the same
  // markers clampEntriesForWire uses (contentLength = original char length).
  let json = safeStringify(stripped);
  let bytes = Buffer.byteLength(json);
  if (bytes > TRANSCRIPT_DATA_MAX_BYTES && typeof stripped.content === "string" && stripped.content) {
    const orig = stripped.content;
    stripped.contentClamped = true;
    stripped.contentLength = orig.length;
    let content = orig;
    // Removing N chars removes >= N bytes from the JSON, so this converges
    // in a couple of iterations; the loop cap is a belt-and-braces guard.
    for (let i = 0; i < 24; i++) {
      json = safeStringify(stripped);
      bytes = Buffer.byteLength(json);
      if (bytes <= TRANSCRIPT_DATA_MAX_BYTES) break;
      const over = bytes - TRANSCRIPT_DATA_MAX_BYTES;
      content = content.slice(0, Math.max(0, content.length - Math.max(over, 64)));
      stripped.content = content;
      if (!content) {
        json = safeStringify(stripped);
        bytes = Buffer.byteLength(json);
        break;
      }
    }
  }

  // Pathological residue (huge videos/files arrays etc.): shed them too.
  if (bytes > TRANSCRIPT_DATA_MAX_BYTES) {
    delete stripped.videos;
    delete stripped.files;
    delete stripped.images;
    delete stripped.featuredMedia;
    json = safeStringify(stripped);
    bytes = Buffer.byteLength(json);
  }
  if (bytes > TRANSCRIPT_DATA_MAX_BYTES) {
    // Last resort: minimal skeleton — still upserts/renders, full via blob.
    const skeleton: TranscriptEntry = {
      id: entry.id,
      type: entry.type,
      content: "",
      timestamp: entry.timestamp,
      ...(entry.toolName ? { toolName: entry.toolName } : {}),
      contentClamped: true,
      contentLength: entry.content?.length ?? 0,
    };
    return { data: safeStringify(skeleton), full: raw, entry: skeleton };
  }

  return { data: json, full: raw, entry: stripped };
}

// ── Page hydration ───────────────────────────────────────────────────────────

function page(rows: { seq: number; change_seq: number; data: string }[]): TranscriptPage {
  const entries: SeqEntry[] = [];
  for (const r of rows) {
    try {
      entries.push({
        ...sanitizeTranscriptMediaEntry(JSON.parse(r.data) as TranscriptEntry),
        seq: r.seq,
        changeSeq: r.change_seq,
      });
    } catch {
      // A corrupt row must never take the whole page down.
      console.warn(`[transcript-store] corrupt row at seq ${r.seq} skipped`);
    }
  }
  return {
    entries,
    firstSeq: entries.length ? entries[0].seq : 0,
    lastSeq: entries.length ? entries[entries.length - 1].seq : 0,
  };
}
