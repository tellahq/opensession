/** Bounded operator diagnostic for orphan transcripts.
 * No online placement enumeration or actor fanout. Production calls must name
 * at most 100 candidates and are dry-run only: missing metadata is not proof
 * that a transcript is disposable. Deletion requires a separate, fenced
 * offline repair after provenance review. Tests exercise the legacy classifier
 * against an explicitly supplied in-memory store, never the live actor store.
 */
import { catalogSessionDocuments } from "./session-catalog-read";
import { isContextInjection } from "@tellahq/opensession-protocol/notices";
import { audit } from "./audit";
import { sessionTranscript } from "./session-kernel";
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

function actorOrphanStore(candidateSessionIds: string[]): OrphanStore {
  return {
    async listStoredSessions() {
      const rows: Array<{
        sessionId: string;
        lastTs: number | null;
        seqHighWater: number;
      }> = [];
      for (const sessionId of candidateSessionIds) {
        const summary = await sessionTranscript({ op: "summary", sessionId });
        if (summary) rows.push({ sessionId, ...summary });
      }
      return rows;
    },
    countEvents: (sessionId) => sessionTranscript({ op: "count", sessionId }),
    readTail: (sessionId, limit) =>
      sessionTranscript({ op: "tail", sessionId, limit }),
    deleteSessionTranscript: async () => {
      throw new Error("Live orphan transcript deletion is forbidden");
    },
  };
}

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

/** Complete metadata plus the all-sessions projection, including deduped aliases.
 * Missing catalog coverage aborts diagnosis; it never means nobody owns data. */
async function knownSessionIdsFromCatalog(): Promise<Set<string>> {
  const known = new Set<string>();
  for await (const { sessionId } of catalogSessionDocuments())
    known.add(sessionId);
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
    /** Explicit operator-selected ids, never a cursor over actor placements. */
    candidateSessionIds?: string[];
    /** Test seams: which store to sweep, who counts as known, what time it is. */
    store?: OrphanStore;
    knownSessionIds?: () => Set<string> | Promise<Set<string>>;
    now?: number;
  } = {},
): Promise<OrphanSweepSummary> {
  const started = Date.now();
  const now = opts.now ?? started;
  const ids = [...new Set(opts.candidateSessionIds ?? [])];
  const store = opts.store ?? actorOrphanStore(ids);
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

  if (!opts.store && (!opts.dryRun || ids.length === 0 || ids.length > 100)) {
    summary.refused =
      "Live diagnosis requires dryRun and 1..100 explicit candidate session ids; fleet sweeps and live deletion are forbidden";
    return finish();
  }
  if (opts.store && process.env.NODE_ENV !== "test") {
    summary.refused = "Custom orphan stores are test-only";
    return finish();
  }

  let known: Set<string>;
  try {
    known = await (opts.knownSessionIds
      ? opts.knownSessionIds()
      : knownSessionIdsFromCatalog());
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
