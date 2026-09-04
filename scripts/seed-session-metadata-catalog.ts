#!/usr/bin/env bun
/**
 * Seed the session metadata catalog from historical session files.
 *
 * Sessions written before the actor owned their metadata exist only as
 * `<sessions dir>/<id>.json`. This projects each such file into the central
 * catalog as-is (rev = the file's rev, or 1; exported_rev = rev, since the
 * file already carries it). A session that already has a catalog row, from an
 * earlier run or a live commit, is left alone, and the per-session actor
 * document still materializes from the file on that session's first real
 * write. No per-session actor database is opened.
 *
 * Runs online against the live session kernel service through the transport
 * the gateway uses, so the kernel URL and credential resolve the same way
 * (OPENSESSION_SESSION_KERNEL_URL or _HOST/_PORT, and
 * OPENSESSION_SESSION_KERNEL_TOKEN or OPENSESSION_SESSION_KERNEL_TOKEN_FILE).
 * Re-running is safe. Once every file has a row the catalog is marked
 * complete and cold list rebuilds page the catalog instead of scanning the
 * directory.
 *
 *   bun scripts/seed-session-metadata-catalog.ts [--dry-run] [--no-mark-complete] [--batch 200]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { OPENSESSION_SESSIONS_DIR } from "../packages/core/opensession-server/src/server/paths";
import {
  startSessionKernelActor,
  stopSessionKernelActor,
} from "../packages/core/opensession-server/src/server/session-kernel/actor-runtime";
import { sessionMetadata } from "../packages/core/opensession-server/src/server/session-kernel/kernel";
import {
  SESSION_METADATA_CATALOG_PAGE_LIMIT,
  type SessionMetadataSeedRow,
} from "../packages/core/opensession-server/src/server/session-kernel/metadata-protocol";
import type { NativeSessionFile } from "../packages/core/opensession-server/src/server/types";

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dryRun = flag("--dry-run");
const markComplete = !flag("--no-mark-complete");
const batchSize = Math.min(
  SESSION_METADATA_CATALOG_PAGE_LIMIT,
  Math.max(1, Number(value("--batch") ?? 200) || 200),
);

async function catalogSessionIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  let afterSessionId = "";
  for (;;) {
    const page = await sessionMetadata({
      op: "catalog_page",
      afterSessionId,
      limit: SESSION_METADATA_CATALOG_PAGE_LIMIT,
    });
    for (const row of page) ids.add(row.sessionId);
    if (page.length < SESSION_METADATA_CATALOG_PAGE_LIMIT) break;
    afterSessionId = page[page.length - 1]!.sessionId;
  }
  return ids;
}

type FileScan = {
  rows: SessionMetadataSeedRow[];
  /** Files whose basename is not the document id. The facade cannot address
   * these, so they are reported rather than seeded. */
  mismatched: string[];
  unreadable: string[];
  /** Files that carry no revision yet; they seed at rev 1. */
  unversioned: number;
};

function scanSessionFiles(): FileScan {
  const scan: FileScan = {
    rows: [],
    mismatched: [],
    unreadable: [],
    unversioned: 0,
  };
  if (!existsSync(OPENSESSION_SESSIONS_DIR)) return scan;
  for (const file of readdirSync(OPENSESSION_SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const path = `${OPENSESSION_SESSIONS_DIR}/${file}`;
    let doc: string;
    let data: NativeSessionFile | null;
    try {
      doc = readFileSync(path, "utf-8");
      data = JSON.parse(doc);
    } catch {
      scan.unreadable.push(file);
      continue;
    }
    // Bookkeeping files in this directory (active-runs.json, registries)
    // have no id; the list scan skips them the same way.
    if (!data || typeof data.id !== "string" || !data.id) continue;
    if (data.id !== file.slice(0, -".json".length)) {
      scan.mismatched.push(file);
      continue;
    }
    const fileRev = (data as { rev?: unknown }).rev;
    const rev =
      typeof fileRev === "number" && Number.isInteger(fileRev) && fileRev >= 1
        ? fileRev
        : 1;
    if (rev !== fileRev) scan.unversioned++;
    const activity = Date.parse(data.lastActivity || data.createdAt || "");
    scan.rows.push({
      sessionId: data.id,
      doc,
      rev,
      archived: !!data.archived,
      lastActivityMs: Number.isFinite(activity) ? Math.max(0, activity) : 0,
    });
  }
  return scan;
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  await startSessionKernelActor();
  try {
    const alreadyComplete = await sessionMetadata({ op: "catalog_complete" });
    const known = await catalogSessionIds();
    const scan = scanSessionFiles();
    const missing = scan.rows.filter((row) => !known.has(row.sessionId));
    console.log(
      `[seed-metadata-catalog] ${scan.rows.length} session file(s), ` +
        `${known.size} catalog row(s), ${missing.length} to seed` +
        (scan.unversioned ? `, ${scan.unversioned} without a rev` : "") +
        (scan.mismatched.length
          ? `, ${scan.mismatched.length} skipped (id differs from file name)`
          : "") +
        (scan.unreadable.length
          ? `, ${scan.unreadable.length} unreadable`
          : "") +
        (alreadyComplete ? "; catalog already marked complete" : ""),
    );
    for (const file of scan.mismatched)
      console.log(`[seed-metadata-catalog] skipped ${file}: id mismatch`);
    for (const file of scan.unreadable)
      console.log(`[seed-metadata-catalog] skipped ${file}: unreadable`);
    if (dryRun) {
      console.log("[seed-metadata-catalog] dry run; nothing written");
      return;
    }

    let inserted = 0;
    for (let index = 0; index < missing.length; index += batchSize) {
      const rows = missing.slice(index, index + batchSize);
      inserted += await sessionMetadata({ op: "seed_catalog", rows });
      if ((index / batchSize) % 10 === 9)
        console.log(
          `[seed-metadata-catalog] seeded ${Math.min(index + batchSize, missing.length)}/${missing.length}`,
        );
    }

    // Verify coverage against the catalog as it is now, not as we expected
    // it to be: a live commit may have raced a seed, which is fine either way.
    const after = await catalogSessionIds();
    const uncovered = scan.rows.filter((row) => !after.has(row.sessionId));
    console.log(
      `[seed-metadata-catalog] inserted ${inserted} row(s); ` +
        `${after.size} catalog row(s); ${uncovered.length} file(s) uncovered ` +
        `in ${Math.round(performance.now() - startedAt)}ms`,
    );
    if (uncovered.length > 0)
      throw new Error(
        `Catalog is missing ${uncovered.length} session(s), first ${uncovered[0]!.sessionId}`,
      );
    if (scan.unreadable.length > 0)
      throw new Error(
        "Unreadable session files must be repaired or removed before the catalog is marked complete",
      );
    if (!markComplete) {
      console.log(
        "[seed-metadata-catalog] catalog left unmarked (--no-mark-complete)",
      );
      return;
    }
    if (!alreadyComplete) {
      await sessionMetadata({ op: "mark_catalog_complete" });
      console.log(
        "[seed-metadata-catalog] catalog marked complete; cold list rebuilds now page the catalog",
      );
    }
  } finally {
    stopSessionKernelActor();
  }
}

await main();
