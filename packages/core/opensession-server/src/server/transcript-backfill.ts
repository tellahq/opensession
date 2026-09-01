/**
 * Transcript v2 backfill — WP-C (docs/transcripts.md §8).
 *
 * In-process full migration of existing sessions into the v2 transcript store
 * (transcripts.db). Runs ONLY inside the live server process — invariant 8:
 * transcripts.db has exactly one writer, and no standalone script may import
 * this to write it out-of-process.
 *
 * Flow per session (newest-first by lastActivity):
 *   mergedSessionTranscript(session) → store.importLegacyTranscript (which
 *   marks the session imported with src + mirror-size watermark)
 * skipping sessions that are already imported (hasImported), v2-ineligible
 * (`plain-` id prefix, design §3/§4), or have no resolvable
 * transcript. Paced: one session per chunk with an awaited setTimeout between
 * sessions (the store's chunked import bounds per-transaction size) so the
 * event loop keeps serving while ~3,100 sessions migrate.
 *
 * Import-graph rule (invariant 6): nothing imported at module scope here may
 * reach run-rpc.ts. sessions.ts DOES reach it (sessions.ts → generated-titles
 * → one-shot → pi-runner → run-rpc), so it is dynamic-imported
 * at call time — by then the live process has long since loaded it, and tests
 * importing this module never bind the live rpc socket.
 *
 * Legacy maintenance only: production boot must not schedule this after the
 * offline authority cutover because the shared source is rollback evidence.
 */

import { existsSync, statSync, writeFileSync } from "fs";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { audit } from "./audit";
import type { UnifiedSession } from "./types";
// The async actor facade checks import state and confirms the final bounded
// import chunk before the session is marked imported.
import { importLegacyTranscript, transcript } from "./actor-transcript";

/** One-shot boot marker — presence means the full backfill already completed. */
const MARKER_PATH = `${OPENSESSION_SESSIONS_DIR}/.transcript-v2-backfill-done.json`;

/** Pause between sessions so the event loop keeps serving (design: 25-50ms). */
const PACE_MS = 35;
/** Extra pause after big imports (a chunked import still runs sync per call). */
const BIG_IMPORT_ENTRIES = 1000;
const BIG_IMPORT_EXTRA_MS = 150;

/** v2-ineligible session families stay on the legacy path (design §3).
 *  Only plain- now: linear runs thread transcriptSessionId to the runner, so
 *  linear- sessions import like everything else. */
function v2EligibleId(sessionId: string): boolean {
  return !sessionId.startsWith("plain-");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mirror jsonl size for the import watermark (drift detection, design §8).
 * Null when no mirror file is resolvable — the store records a null watermark
 * and the read path treats any mirror growth as drift.
 */
function mirrorFileSize(
  session: Pick<UnifiedSession, "transcriptPath">,
): number | null {
  if (!session.transcriptPath) return null;
  try {
    return statSync(session.transcriptPath).size;
  } catch {
    return null;
  }
}

export interface TranscriptBackfillSummary {
  /** Sessions whose transcript was imported (counted, not written, on dryRun). */
  imported: number;
  /** Already-imported, v2-ineligible, or no resolvable transcript. */
  skipped: number;
  /** Sessions whose import threw (logged, backfill continues). */
  failed: number;
  /** Total transcript entries across imported sessions. */
  entries: number;
  /** Wall-clock duration. */
  ms: number;
}

/**
 * Migrate all existing sessions into the transcript store. Idempotent — safe
 * to re-run; already-imported sessions are skipped via the store's
 * transcript_sessions table. `limit` bounds how many sessions are *examined*
 * (newest-first), for smoke-testing the route; `dryRun` counts what would be
 * imported without writing.
 */
export async function runTranscriptBackfill(
  opts: { limit?: number; dryRun?: boolean } = {},
): Promise<TranscriptBackfillSummary> {
  const started = Date.now();
  // Dynamic imports: keep run-rpc.ts out of this module's static graph (see
  // module doc). In the live process these resolve to the already-loaded
  // modules instantly.
  const { getAllSessions, mergedSessionTranscriptAsync } =
    await import("./sessions");

  let sessions = getAllSessions()
    .slice()
    .sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""));
  if (opts.limit && opts.limit > 0) sessions = sessions.slice(0, opts.limit);

  const summary: TranscriptBackfillSummary = {
    imported: 0,
    skipped: 0,
    failed: 0,
    entries: 0,
    ms: 0,
  };

  let examined = 0;
  for (const session of sessions) {
    examined++;
    if (examined % 50 === 0) {
      console.log(
        `[transcript-backfill] ${examined}/${sessions.length} sessions — ` +
          `imported=${summary.imported} skipped=${summary.skipped} ` +
          `failed=${summary.failed} entries=${summary.entries}`,
      );
    }
    try {
      if (
        !v2EligibleId(session.id) ||
        !(await transcript.needsImport(session.id))
      ) {
        summary.skipped++;
        continue;
      }
      const entries = await mergedSessionTranscriptAsync(session);
      if (!entries.length) {
        summary.skipped++;
        continue;
      }
      if (!opts.dryRun) {
        const watermark = mirrorFileSize(session);
        // WP-A touchpoint: chunked import (≤500 rows/tx, design §1);
        // importLegacyTranscript marks the session imported with the
        // src + mirror watermark internally.
        await importLegacyTranscript(session.id, entries, "merged", watermark);
      }
      summary.imported++;
      summary.entries += entries.length;
      if (entries.length >= BIG_IMPORT_ENTRIES)
        await sleep(BIG_IMPORT_EXTRA_MS);
    } catch (err) {
      summary.failed++;
      console.warn(
        `[transcript-backfill] import failed for ${session.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
    // Pace between sessions so the event loop keeps serving.
    await sleep(PACE_MS);
  }

  summary.ms = Date.now() - started;
  console.log(
    `[transcript-backfill] done${opts.dryRun ? " (dry run)" : ""}: ` +
      `imported=${summary.imported} skipped=${summary.skipped} ` +
      `failed=${summary.failed} entries=${summary.entries} in ${summary.ms}ms`,
  );
  audit({
    kind: "transcript_backfill",
    dryRun: !!opts.dryRun,
    limit: opts.limit ?? null,
    ...summary,
  });
  return summary;
}

/**
 * One-shot boot kick (design §8): run the full backfill in the background,
 * once ever, when the v2 flag is on. Guarded by the marker file (across
 * restarts) and a globalThis in-flight latch (across bun --hot reloads —
 * module-locals reset on reload). W5 wires this into boot; nothing calls it
 * yet.
 */
export function kickTranscriptBackfillOnce(): void {
  if (existsSync(MARKER_PATH)) return;
  const g = globalThis as typeof globalThis & {
    __osTranscriptBackfillKick?: boolean;
  };
  if (g.__osTranscriptBackfillKick) return;
  g.__osTranscriptBackfillKick = true;
  void runTranscriptBackfill()
    .then((summary) => {
      try {
        writeFileSync(
          MARKER_PATH,
          JSON.stringify(
            { finishedAt: new Date().toISOString(), ...summary },
            null,
            2,
          ),
        );
      } catch (err) {
        console.warn("[transcript-backfill] marker write failed:", err);
      }
    })
    .catch((err) => {
      // Leave the latch unset so a later boot/hot-reload can retry.
      g.__osTranscriptBackfillKick = false;
      console.error("[transcript-backfill] boot backfill failed:", err);
    });
}
