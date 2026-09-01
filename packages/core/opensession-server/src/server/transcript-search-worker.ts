/**
 * Read-only transcript search worker.
 *
 * Every authoritative transcript lives in its session actor database. SQLite
 * is synchronous, so global search opens those files read-only in this child
 * process rather than occupying actor mailboxes or the gateway event loop.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { transcriptEntryMatchSnippet } from "./transcript-search";
import { sessionKernelSessionDbPath } from "./session-kernel/store";
import type { TranscriptEntry } from "./types";

const SEARCH_PAGE_ROWS = 200;
export const TRANSCRIPT_SEARCH_MAX_SESSIONS = 250;
export const TRANSCRIPT_SEARCH_MAX_ROWS = 6_000;
export const TRANSCRIPT_SEARCH_MAX_MS = 5_000;

export interface StoredTranscriptSearchInput {
  query: string;
  /** Most-recent first. This order is also the result order. */
  sessionIds: string[];
  isolatedRoot?: string;
  maxMatches?: number;
  maxSessions?: number;
  maxRows?: number;
  maxMs?: number;
}

export interface StoredTranscriptMatch {
  id: string;
  snippet: string;
}

export interface StoredTranscriptSearchResult {
  matches: StoredTranscriptMatch[];
  searchedSessions: number;
  candidateRows: number;
  exhausted: "sessions" | "rows" | "time" | "matches" | null;
}

interface CandidateRow {
  seq: number;
  data: string;
}

function bounded(
  value: number | undefined,
  fallback: number,
  ceiling: number,
): number {
  return Math.min(Math.max(1, Math.floor(value ?? fallback)), ceiling);
}

/** Search bounded rows across bounded read-only actor database handles. */
export function searchStoredTranscripts(
  input: StoredTranscriptSearchInput,
  now: () => number = () => performance.now(),
): StoredTranscriptSearchResult {
  const query = input.query.trim();
  const maxMatches = bounded(input.maxMatches, 50, 100);
  const maxSessions = bounded(
    input.maxSessions,
    TRANSCRIPT_SEARCH_MAX_SESSIONS,
    TRANSCRIPT_SEARCH_MAX_SESSIONS,
  );
  const maxRows = bounded(
    input.maxRows,
    TRANSCRIPT_SEARCH_MAX_ROWS,
    TRANSCRIPT_SEARCH_MAX_ROWS,
  );
  const maxMs = bounded(
    input.maxMs,
    TRANSCRIPT_SEARCH_MAX_MS,
    TRANSCRIPT_SEARCH_MAX_MS,
  );
  const matches: StoredTranscriptMatch[] = [];
  let searchedSessions = 0;
  let candidateRows = 0;
  let exhausted: StoredTranscriptSearchResult["exhausted"] = null;
  if (query.length < 2 || query.length > 1_000 || input.sessionIds.length === 0)
    return { matches, searchedSessions, candidateRows, exhausted };

  const startedAt = now();
  const ids = input.sessionIds.slice(0, maxSessions);
  sessionLoop: for (const id of ids) {
    if (now() - startedAt >= maxMs) {
      exhausted = "time";
      break;
    }
    if (candidateRows >= maxRows) {
      exhausted = "rows";
      break;
    }
    if (matches.length >= maxMatches) {
      exhausted = "matches";
      break;
    }
    searchedSessions++;
    const path = sessionKernelSessionDbPath(id, input.isolatedRoot);
    if (!existsSync(path)) continue;
    const db = new Database(path, { readonly: true, strict: true });
    try {
      const hasTranscriptEvents = db
        .query(`
        SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name = 'transcript_events'
      `)
        .get();
      if (!hasTranscriptEvents) continue;
      let beforeSeq = Number.MAX_SAFE_INTEGER;
      while (true) {
        if (now() - startedAt >= maxMs) {
          exhausted = "time";
          break sessionLoop;
        }
        const remainingRows = maxRows - candidateRows;
        if (remainingRows <= 0) {
          exhausted = "rows";
          break sessionLoop;
        }
        const limit = Math.min(SEARCH_PAGE_ROWS, remainingRows);
        const rows = db
          .query(`
          SELECT seq, data FROM transcript_events
          WHERE session_id = ? AND seq < ?
          ORDER BY seq DESC LIMIT ?
        `)
          .all(id, beforeSeq, limit) as CandidateRow[];
        candidateRows += rows.length;
        let matched = false;
        for (const row of rows) {
          try {
            const snippet = transcriptEntryMatchSnippet(
              JSON.parse(row.data) as TranscriptEntry,
              query,
            );
            if (snippet) {
              matches.push({ id, snippet });
              matched = true;
              break;
            }
          } catch {}
        }
        if (matched || rows.length < limit) break;
        beforeSeq = rows.at(-1)!.seq;
      }
    } finally {
      db.close();
    }
  }
  if (!exhausted && candidateRows >= maxRows) exhausted = "rows";
  if (!exhausted && matches.length >= maxMatches) exhausted = "matches";
  if (!exhausted && input.sessionIds.length > ids.length)
    exhausted = "sessions";
  return { matches, searchedSessions, candidateRows, exhausted };
}

export async function runTranscriptSearchWorker(): Promise<void> {
  const input = JSON.parse(
    await Bun.stdin.text(),
  ) as StoredTranscriptSearchInput;
  process.stdout.write(JSON.stringify(searchStoredTranscripts(input)));
}

if (import.meta.main) {
  runTranscriptSearchWorker().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
