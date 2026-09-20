/**
 * Offline readers of the legacy session source directories.
 *
 * `<sessions dir>/*.json` (native documents and the sidecars stored under
 * Slack/Linear ids), `~/.slack-sessions/*.json` and `~/.linear-sessions/*.json`
 * are listed here for offline list-source migration. The live gateway never imports this
 * module: its session list comes from the list index and, for a cold rebuild,
 * the catalogs (session-cache.ts). Whole-directory reads of thousands of
 * files on the gateway thread are what turned routine list refreshes into
 * multi-second stalls, so every function here refuses to run unless the
 * process is one of:
 *
 * - a test (`NODE_ENV=test`), where legacy fixtures construct the list from
 *   files;
 * - the isolated demo instance (`OPENSESSION_DEMO=1` with its own
 *   `OPENSESSION_STATE_DIR`), which generates its dataset as files at boot;
 * - an operator script that sets `OPENSESSION_OFFLINE_SESSION_SCAN=1`
 *   (`scripts/seed-session-metadata-catalog.ts`).
 *
 * `seedSessionCatalogsFromFiles` is the one migration: it projects every file
 * into the catalogs the gateway reads and marks them complete, after which a
 * cold rebuild never needs these directories again.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import {
  AGENT_SESSION_STORE_SKIP_FILES,
  agentSessionSourceDirectory,
  agentSessionSourceKey,
} from "./agent-session-source";
import type {
  AgentSessionKind,
  AgentSessionSource,
  LinearSessionSource,
  SlackSessionSource,
} from "./agent-session-catalog";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import type { SessionMetadataSeedRow } from "./session-kernel";
import type { SessionSourceDocuments } from "./sessions";
import type { NativeSessionFile } from "./types";

export function offlineSessionSourceScanAllowed(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    (process.env.OPENSESSION_DEMO === "1" &&
      !!process.env.OPENSESSION_STATE_DIR) ||
    process.env.OPENSESSION_OFFLINE_SESSION_SCAN === "1"
  );
}

/** Refuse a directory scan in a live gateway. `what` names the caller. */
export function assertOfflineSessionSourceScan(what: string): void {
  if (offlineSessionSourceScanAllowed()) return;
  throw new Error(
    `${what} lists the session source directories, which only tests, the demo instance and offline scripts may do; the gateway builds its list from the catalogs`,
  );
}

/** Native documents and sidecars under the sessions directory as seed rows,
 * with everything the seed cannot address reported beside them. */
export type NativeSessionFileScan = {
  /** Native documents (`id` equals the file name) and agent sidecars (a
   * `slack-`/`linear-` file with no `id`, the natively owned extras). */
  rows: SessionMetadataSeedRow[];
  sidecars: number;
  /** Files whose document names a different id. The facade cannot address
   * these, so they are reported rather than seeded. */
  mismatched: string[];
  unreadable: string[];
  /** Files that carry no revision yet; they seed at rev 1. */
  unversioned: number;
};

function isAgentSidecarFile(file: string): boolean {
  return /^(slack|linear)-.+\.json$/.test(file);
}

function seedRevision(data: object): { rev: number; versioned: boolean } {
  const fileRev = (data as { rev?: unknown }).rev;
  const versioned =
    typeof fileRev === "number" && Number.isInteger(fileRev) && fileRev >= 1;
  return { rev: versioned ? (fileRev as number) : 1, versioned };
}

function activityMs(data: Partial<NativeSessionFile>): number {
  const value = Date.parse(data.lastActivity || data.createdAt || "");
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function scanNativeSessionFiles(): NativeSessionFileScan {
  assertOfflineSessionSourceScan("scanNativeSessionFiles");
  const scan: NativeSessionFileScan = {
    rows: [],
    sidecars: 0,
    mismatched: [],
    unreadable: [],
    unversioned: 0,
  };
  const dir = OPENSESSION_SESSIONS_DIR;
  if (!existsSync(dir)) return scan;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json") || AGENT_SESSION_STORE_SKIP_FILES.has(file))
      continue;
    let doc: string;
    let data: NativeSessionFile | null;
    try {
      doc = readFileSync(`${dir}/${file}`, "utf-8");
      data = JSON.parse(doc);
    } catch {
      scan.unreadable.push(file);
      continue;
    }
    if (!data || typeof data !== "object") continue;
    const sessionId = file.slice(0, -".json".length);
    const isSidecar =
      (data.id === undefined || data.id === null) && isAgentSidecarFile(file);
    if (!isSidecar) {
      // Bookkeeping files in this directory (markers, registries) have no
      // id; the list scan skips them the same way.
      if (typeof data.id !== "string" || !data.id) continue;
      if (data.id !== sessionId) {
        scan.mismatched.push(file);
        continue;
      }
    } else scan.sidecars++;
    const { rev, versioned } = seedRevision(data);
    if (!versioned) scan.unversioned++;
    scan.rows.push({
      sessionId,
      doc,
      rev,
      archived: !!data.archived,
      lastActivityMs: activityMs(data),
    });
  }
  return scan;
}

export type AgentSessionFileScan<
  K extends AgentSessionKind = AgentSessionKind,
> = {
  kind: K;
  sources: AgentSessionSource<K>[];
  unreadable: string[];
};

export function scanAgentSessionFiles<K extends AgentSessionKind>(
  kind: K,
): AgentSessionFileScan<K> {
  assertOfflineSessionSourceScan("scanAgentSessionFiles");
  const scan: AgentSessionFileScan<K> = { kind, sources: [], unreadable: [] };
  const dir = agentSessionSourceDirectory(kind);
  if (!existsSync(dir)) return scan;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json") || AGENT_SESSION_STORE_SKIP_FILES.has(file))
      continue;
    const path = `${dir}/${file}`;
    let data: AgentSessionSource<K>["data"] | null;
    let mtime: string;
    try {
      data = JSON.parse(readFileSync(path, "utf-8"));
      mtime = statSync(path).mtime.toISOString();
    } catch {
      scan.unreadable.push(file);
      continue;
    }
    if (!data || typeof data !== "object") continue;
    scan.sources.push({ file, data, mtime });
  }
  return scan;
}

/** Everything the synchronous test assembly needs, read from files. */
export function scanSessionSourceDocuments(
  what = "scanSessionSourceDocuments",
): SessionSourceDocuments {
  assertOfflineSessionSourceScan(what);
  const native: NativeSessionFile[] = [];
  const sidecars = new Map<string, NativeSessionFile>();
  for (const row of scanNativeSessionFiles().rows) {
    const data = JSON.parse(row.doc) as NativeSessionFile;
    if (data.id) native.push(data);
    else sidecars.set(row.sessionId, data);
  }
  return {
    native,
    sidecars,
    slack: scanAgentSessionFiles("slack").sources as SlackSessionSource[],
    linear: scanAgentSessionFiles("linear").sources as LinearSessionSource[],
  };
}

export type SessionCatalogSeedSummary = {
  native: NativeSessionFileScan & {
    known: number;
    inserted: number;
    uncovered: string[];
    alreadyComplete: boolean;
    markedComplete: boolean;
  };
  agents: Record<
    AgentSessionKind,
    {
      files: number;
      unreadable: string[];
      alreadyComplete: boolean;
      markedComplete: boolean;
    }
  >;
  ms: number;
  /** True when `unlessComplete` found every catalog already marked complete
   *  and the seed exited before scanning any source file. */
  skipped: boolean;
};

export type SessionCatalogSeedOptions = {
  /** Report only; write nothing. */
  dryRun?: boolean;
  /** Exit before scanning when the metadata catalog and both agent imports
   *  are already marked complete. Completed catalogs no longer require source
   *  discovery, so the boot-time seed (every install and foreground start)
   *  sets this and pays three RPC calls instead of a walk over every session
   *  file; the operator rescan leaves it unset. */
  unlessComplete?: boolean;
  /** Mark the catalogs complete once every file has a row (default true). */
  markComplete?: boolean;
  batchSize?: number;
  log?: (line: string) => void;
};

/**
 * The three completion markers a cold list rebuild needs, read through the
 * kernel RPC without touching a source file. All true means the catalogs are
 * the authority and a seed run has nothing left to migrate.
 */
export async function sessionCatalogsComplete(): Promise<{
  metadata: boolean;
  slack: boolean;
  linear: boolean;
}> {
  const { sessionMetadata } = await import("./session-kernel");
  const { agentSessionCatalogImportComplete } =
    await import("./agent-session-catalog");
  return {
    metadata: await sessionMetadata({ op: "catalog_complete" }),
    slack: await agentSessionCatalogImportComplete("slack"),
    linear: await agentSessionCatalogImportComplete("linear"),
  };
}

async function catalogSessionIds(): Promise<Set<string>> {
  const { sessionMetadata, SESSION_METADATA_CATALOG_PAGE_LIMIT } =
    await import("./session-kernel");
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

/**
 * Project every session source file into the catalogs the gateway reads:
 * native documents and agent sidecars into the metadata catalog, Slack and
 * Linear source files into their catalog-document namespaces. Rows that
 * already exist (an earlier run, a live commit, a mirror) are left alone, so
 * re-running is safe. Marks each catalog complete only once every file it
 * covers has a row and none was unreadable. Runs against whichever kernel
 * `sessionMetadata` reaches: the live service from an operator script, or
 * the in-process store in a test.
 */
export async function seedSessionCatalogsFromFiles(
  opts: SessionCatalogSeedOptions = {},
): Promise<SessionCatalogSeedSummary> {
  assertOfflineSessionSourceScan("seedSessionCatalogsFromFiles");
  // Only the async operator migration loads runtime catalogs. The synchronous
  // test scanner remains a leaf, including in compiled runtime dependency graphs.
  const { sessionMetadata, SESSION_METADATA_CATALOG_PAGE_LIMIT } =
    await import("./session-kernel");
  const {
    agentSessionCatalogImportComplete,
    markAgentSessionCatalogImportComplete,
    seedAgentSessionCatalog,
  } = await import("./agent-session-catalog");
  const startedAt = performance.now();
  const log = opts.log ?? (() => {});
  const markComplete = opts.markComplete !== false;
  const batchSize = Math.min(
    SESSION_METADATA_CATALOG_PAGE_LIMIT,
    Math.max(1, opts.batchSize ?? 200),
  );

  if (opts.unlessComplete) {
    const complete = await sessionCatalogsComplete();
    if (complete.metadata && complete.slack && complete.linear) {
      log(
        "[seed-session-catalogs] metadata catalog and slack/linear imports already marked complete; nothing to scan",
      );
      const agent = {
        files: 0,
        unreadable: [],
        alreadyComplete: true,
        markedComplete: false,
      };
      return {
        native: {
          rows: [],
          sidecars: 0,
          mismatched: [],
          unreadable: [],
          unversioned: 0,
          known: 0,
          inserted: 0,
          uncovered: [],
          alreadyComplete: true,
          markedComplete: false,
        },
        agents: { slack: { ...agent }, linear: { ...agent } },
        ms: Math.round(performance.now() - startedAt),
        skipped: true,
      };
    }
  }

  const nativeScan = scanNativeSessionFiles();
  const alreadyComplete = await sessionMetadata({ op: "catalog_complete" });
  const known = await catalogSessionIds();
  const missing = nativeScan.rows.filter((row) => !known.has(row.sessionId));
  log(
    `[seed-session-catalogs] ${nativeScan.rows.length} session file(s) ` +
      `(${nativeScan.sidecars} sidecar(s)), ${known.size} catalog row(s), ${missing.length} to seed` +
      (nativeScan.unversioned
        ? `, ${nativeScan.unversioned} without a rev`
        : "") +
      (nativeScan.mismatched.length
        ? `, ${nativeScan.mismatched.length} skipped (id differs from file name)`
        : "") +
      (nativeScan.unreadable.length
        ? `, ${nativeScan.unreadable.length} unreadable`
        : "") +
      (alreadyComplete ? "; metadata catalog already marked complete" : ""),
  );
  for (const file of nativeScan.mismatched)
    log(`[seed-session-catalogs] skipped ${file}: id mismatch`);
  for (const file of nativeScan.unreadable)
    log(`[seed-session-catalogs] skipped ${file}: unreadable`);

  const summary: SessionCatalogSeedSummary = {
    native: {
      ...nativeScan,
      known: known.size,
      inserted: 0,
      uncovered: [],
      alreadyComplete,
      markedComplete: false,
    },
    agents: {
      slack: {
        files: 0,
        unreadable: [],
        alreadyComplete: false,
        markedComplete: false,
      },
      linear: {
        files: 0,
        unreadable: [],
        alreadyComplete: false,
        markedComplete: false,
      },
    },
    ms: 0,
    skipped: false,
  };

  const agentScans = {
    slack: scanAgentSessionFiles("slack"),
    linear: scanAgentSessionFiles("linear"),
  };
  for (const kind of ["slack", "linear"] as const) {
    const scan = agentScans[kind];
    const entry = summary.agents[kind];
    entry.files = scan.sources.length;
    entry.unreadable = scan.unreadable;
    entry.alreadyComplete = await agentSessionCatalogImportComplete(kind);
    log(
      `[seed-session-catalogs] ${scan.sources.length} ${kind} source file(s)` +
        (scan.unreadable.length
          ? `, ${scan.unreadable.length} unreadable`
          : "") +
        (entry.alreadyComplete ? `; ${kind} import already complete` : ""),
    );
    for (const file of scan.unreadable)
      log(`[seed-session-catalogs] skipped ${kind} ${file}: unreadable`);
  }

  if (opts.dryRun) {
    log("[seed-session-catalogs] dry run; nothing written");
    summary.ms = Math.round(performance.now() - startedAt);
    return summary;
  }

  for (let index = 0; index < missing.length; index += batchSize) {
    const rows = missing.slice(index, index + batchSize);
    summary.native.inserted += await sessionMetadata({
      op: "seed_catalog",
      rows,
    });
    if ((index / batchSize) % 10 === 9)
      log(
        `[seed-session-catalogs] seeded ${Math.min(index + batchSize, missing.length)}/${missing.length}`,
      );
  }
  // Verify coverage against the catalog as it is now, not as we expected it
  // to be: a live commit may have raced a seed, which is fine either way.
  const after = await catalogSessionIds();
  summary.native.uncovered = nativeScan.rows
    .filter((row) => !after.has(row.sessionId))
    .map((row) => row.sessionId);
  log(
    `[seed-session-catalogs] inserted ${summary.native.inserted} metadata row(s); ` +
      `${after.size} catalog row(s); ${summary.native.uncovered.length} file(s) uncovered`,
  );
  if (summary.native.uncovered.length > 0)
    throw new Error(
      `Catalog is missing ${summary.native.uncovered.length} session(s), first ${summary.native.uncovered[0]}`,
    );
  if (nativeScan.unreadable.length > 0)
    throw new Error(
      "Unreadable session files must be repaired or removed before the catalog is marked complete",
    );

  for (const kind of ["slack", "linear"] as const) {
    const scan = agentScans[kind];
    await seedAgentSessionCatalog(kind, scan.sources);
    if (scan.unreadable.length > 0)
      throw new Error(
        `Unreadable ${kind} session files must be repaired or removed before the ${kind} import is marked complete`,
      );
  }

  if (!markComplete) {
    log("[seed-session-catalogs] catalogs left unmarked (--no-mark-complete)");
  } else {
    if (!alreadyComplete) {
      await sessionMetadata({ op: "mark_catalog_complete" });
      summary.native.markedComplete = true;
      log(
        "[seed-session-catalogs] metadata catalog marked complete; cold list rebuilds now page the catalog",
      );
    }
    for (const kind of ["slack", "linear"] as const) {
      if (summary.agents[kind].alreadyComplete) continue;
      await markAgentSessionCatalogImportComplete(kind);
      summary.agents[kind].markedComplete = true;
      log(`[seed-session-catalogs] ${kind} session import marked complete`);
    }
  }
  summary.ms = Math.round(performance.now() - startedAt);
  return summary;
}

/** The unified id a scanned agent file projects to. */
export function agentSessionIdForFile(
  kind: AgentSessionKind,
  file: string,
): string {
  return `${kind}-${agentSessionSourceKey(file)}`;
}
