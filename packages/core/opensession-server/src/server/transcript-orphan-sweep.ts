/**
 * Orphan transcript sweep — rows in transcripts.db that no session owns.
 *
 * The store is written by anything that dispatches a run, a test harness
 * driving `runAgent` included: a run records its standing context whether or
 * not the caller ever made a session. Before the per-pid scratch database
 * landed (transcript-store.ts) that meant 45 fixture sessions — `probe-*`,
 * `starved-*`, `bks-2`, `busy-loser-*` — had each written a row into the
 * operator's live database. They are inert, nothing references them, but they
 * are junk in a production store; and invariant 8 says transcripts.db has
 * exactly one writer, so no standalone script may delete them. This is that
 * deletion, in-process.
 *
 * ## What it deletes
 *
 * A stored session with ALL of:
 *
 * - **No session behind it.** Not in the durable session-list projection (the
 *   native, linear and slack scanners, plus every alias id a dedupe folded
 *   away) and no session file of its own in the sessions dir. Both, because
 *   either source alone has a way of missing a real session.
 * - **A transcript made entirely of context-log records** (`isContextInjection`).
 *   This is the provable part: a session whose whole stored history is the
 *   harness's own bookkeeping never held a conversation, so there is nothing
 *   to lose. An orphan holding a user line is the last copy of something a
 *   person said — a pruned Slack thread, a session file someone deleted — and
 *   this sweep will not be the thing that destroys it.
 * - **A last write older than `MIN_AGE_MS`.** A session being created has its
 *   file written within seconds of its first transcript row, but the window
 *   exists, and an hour of slack costs nothing. Unknown age (no `last_ts`)
 *   counts as too new.
 *
 * Everything else is counted and logged, never touched. On this instance that
 * was 92 orphans holding ~9,500 entries at the time of writing, mostly Slack
 * threads whose session file is long gone; deleting those is a human's call
 * and wants a different tool.
 *
 * ## Guards
 *
 * The two ways this could go wrong are both silent and destructive, so both
 * refuse the whole sweep rather than handle it: a known-session set that came
 * back implausibly small (a scanner that threw, a state dir not mounted yet)
 * would make every stored session an orphan, and a candidate list past
 * `MAX_DELETE` means the rule matched something other than what it was built
 * for.
 *
 * Idempotent by construction, so it runs on every boot rather than once ever:
 * a second pass finds nothing, and anything that lands again is cleaned next
 * time. No marker file to reason about.
 */

import { readdirSync } from "fs";
import { isContextInjection } from "@tellahq/opensession-protocol/notices";
import { audit } from "./audit";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { transcript } from "./actor-transcript";
import type { TranscriptEntry } from "./types";

interface OrphanStore {
  listStoredSessions():
    | Array<{ sessionId: string; lastTs: number | null; seqHighWater: number }>
    | Promise<
        Array<{
          sessionId: string;
          lastTs: number | null;
          seqHighWater: number;
        }>
      >;
  countEvents(sessionId: string): number | Promise<number>;
  readTail(
    sessionId: string,
    limit: number,
  ): { entries: TranscriptEntry[] } | Promise<{ entries: TranscriptEntry[] }>;
  deleteSessionTranscript(sessionId: string): void | Promise<void>;
}

const actorOrphanStore: OrphanStore = {
  async listStoredSessions() {
    const rows: Array<{
      sessionId: string;
      lastTs: number | null;
      seqHighWater: number;
    }> = [];
    let after = "";
    for (;;) {
      const ids = await transcript.sessionIds(200, after);
      for (const sessionId of ids) {
        const summary = await transcript.summary(sessionId);
        if (summary) rows.push({ sessionId, ...summary });
      }
      if (ids.length < 200) return rows;
      after = ids.at(-1)!;
    }
  },
  countEvents: transcript.countEvents,
  readTail: transcript.readTail,
  deleteSessionTranscript: transcript.deleteSessionTranscript,
};

/** A stored session younger than this is never a candidate, whatever it holds. */
const MIN_AGE_MS = 60 * 60_000;
/** Past this many entries a session is left alone without reading it: no
 *  bookkeeping-only transcript is this long, and reading a huge one to prove
 *  the obvious is wasted I/O. */
const MAX_RECORD_ENTRIES = 50;
/** Below this many known sessions the enumeration is not believable. */
const MIN_KNOWN = 50;
/** More candidates than this means the rule matched something unintended. */
const MAX_DELETE = 1_000;
/** Removed ids are named in the log up to here, then counted. */
const MAX_LOGGED_IDS = 50;

export interface OrphanSweepSummary {
  /** Sessions the store holds rows for. */
  stored: number;
  /** Session ids with a session behind them. */
  known: number;
  /** Stored ids with no session behind them. */
  orphans: number;
  /** Orphans whose rows were deleted (counted, not deleted, on dryRun). */
  removed: number;
  removedEvents: number;
  /** Orphans deliberately left alone — they hold conversation, or are too new. */
  keptOrphans: number;
  keptEvents: number;
  dryRun: boolean;
  ms: number;
  /** Set when the sweep declined to delete anything at all, and why. */
  refused?: string;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Every session id that has something behind it. Two sources on purpose: the
 * sessions dir is the native store and a file there means a session exists
 * whatever a scanner made of it, while the session-list projection is where
 * the slack and linear families live — along with the alias ids of sessions
 * its dedupe folded into another, which are exactly the ids that still own
 * transcript rows.
 */
async function knownSessionIdsFromDisk(): Promise<Set<string>> {
  const known = new Set<string>();
  for (const name of readdirSync(OPENSESSION_SESSIONS_DIR)) {
    if (name.endsWith(".json")) known.add(name.slice(0, -5));
  }
  // Dynamic import: session-cache.ts reaches run-rpc.ts, and this module must stay
  // importable from a test (or any script) without binding the live socket.
  // In the live process it resolves to the already-loaded module.
  const { getSessionListSnapshotAsync } = await import("./session-cache");
  for (const session of await getSessionListSnapshotAsync()) {
    known.add(session.id);
    for (const alias of session.aliasIds || []) known.add(alias);
  }
  return known;
}

/** True when every stored entry is a context-log record — and only when all of
 *  them were read, so a short read keeps the session rather than condemning it
 *  on a partial view. */
async function onlyContextRecords(
  store: OrphanStore,
  sessionId: string,
  events: number,
): Promise<boolean> {
  if (events === 0) return true;
  const entries = (await store.readTail(sessionId, events)).entries;
  return entries.length === events && entries.every(isContextInjection);
}

/**
 * Delete the junk, count everything else. Safe to run repeatedly; never
 * throws for a single session's sake.
 */
export async function sweepOrphanTranscripts(
  opts: {
    dryRun?: boolean;
    /** Test seams: which store to sweep, who counts as known, what time it is. */
    store?: OrphanStore;
    knownSessionIds?: () => Set<string> | Promise<Set<string>>;
    now?: number;
  } = {},
): Promise<OrphanSweepSummary> {
  const started = Date.now();
  const now = opts.now ?? started;
  const store = opts.store ?? actorOrphanStore;
  const summary: OrphanSweepSummary = {
    stored: 0,
    known: 0,
    orphans: 0,
    removed: 0,
    removedEvents: 0,
    keptOrphans: 0,
    keptEvents: 0,
    dryRun: !!opts.dryRun,
    ms: 0,
  };
  const removedIds: string[] = [];

  const finish = (): OrphanSweepSummary => {
    summary.ms = Date.now() - started;
    const named =
      removedIds.length <= MAX_LOGGED_IDS ? removedIds.join(", ") : "";
    console.log(
      `[transcript-orphan-sweep]${summary.dryRun ? " (dry run)" : ""} ` +
        `removed ${summary.removed} orphan session(s) / ${summary.removedEvents} row(s); ` +
        `kept ${summary.keptOrphans} orphan(s) holding ${summary.keptEvents} row(s); ` +
        `${summary.stored} stored, ${summary.known} known` +
        (summary.refused ? ` — refused: ${summary.refused}` : "") +
        ` in ${summary.ms}ms` +
        (named ? ` [${named}]` : ""),
    );
    audit({ kind: "transcript_orphan_sweep", ...summary });
    return summary;
  };

  let known: Set<string>;
  try {
    known = await (opts.knownSessionIds
      ? opts.knownSessionIds()
      : knownSessionIdsFromDisk());
  } catch (e) {
    summary.refused = `could not enumerate sessions: ${message(e)}`;
    return finish();
  }
  summary.known = known.size;

  let stored: Awaited<ReturnType<OrphanStore["listStoredSessions"]>>;
  try {
    stored = await store.listStoredSessions();
  } catch (e) {
    summary.refused = `could not read the store: ${message(e)}`;
    return finish();
  }
  summary.stored = stored.length;

  if (known.size < MIN_KNOWN) {
    // Every stored session would look orphaned. Never act on that.
    summary.refused = `only ${known.size} known session(s) — enumeration looks broken`;
    return finish();
  }

  const candidates: Array<{ sessionId: string; events: number }> = [];
  for (const row of stored) {
    if (known.has(row.sessionId)) continue;
    summary.orphans++;
    let events = row.seqHighWater;
    try {
      if (events <= MAX_RECORD_ENTRIES)
        events = await store.countEvents(row.sessionId);
    } catch (e) {
      console.warn(
        `[transcript-orphan-sweep] ${row.sessionId}: count failed: ${message(e)}`,
      );
    }
    const tooNew = row.lastTs == null || now - row.lastTs < MIN_AGE_MS;
    const keep =
      tooNew ||
      events > MAX_RECORD_ENTRIES ||
      !(await onlyContextRecords(store, row.sessionId, events));
    if (keep) {
      summary.keptOrphans++;
      summary.keptEvents += events;
      continue;
    }
    candidates.push({ sessionId: row.sessionId, events });
  }

  if (candidates.length > MAX_DELETE) {
    summary.refused = `${candidates.length} candidates exceeds the ${MAX_DELETE} cap`;
    summary.keptOrphans += candidates.length;
    for (const c of candidates) summary.keptEvents += c.events;
    return finish();
  }

  for (const candidate of candidates) {
    try {
      if (!summary.dryRun)
        await store.deleteSessionTranscript(candidate.sessionId);
      summary.removed++;
      summary.removedEvents += candidate.events;
      removedIds.push(candidate.sessionId);
    } catch (e) {
      summary.keptOrphans++;
      summary.keptEvents += candidate.events;
      console.warn(
        `[transcript-orphan-sweep] ${candidate.sessionId}: delete failed: ${message(e)}`,
      );
    }
  }

  return finish();
}

/**
 * Boot kick: run the sweep in the background, once per process at a time. The
 * latch lives on globalThis so a `bun --hot` reload can't stack a second pass
 * on the first, and clears when the run ends so a later boot retries.
 */
export function kickOrphanTranscriptSweep(): void {
  const g = globalThis as typeof globalThis & {
    __osOrphanSweepRunning?: boolean;
  };
  if (g.__osOrphanSweepRunning) return;
  g.__osOrphanSweepRunning = true;
  void sweepOrphanTranscripts()
    .catch((e) => console.error("[transcript-orphan-sweep] failed:", e))
    .finally(() => {
      g.__osOrphanSweepRunning = false;
    });
}
