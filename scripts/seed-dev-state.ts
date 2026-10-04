#!/usr/bin/env bun
/**
 * Seed an isolated dev state directory with recent real sessions.
 *
 *   bun scripts/seed-dev-state.ts [--from <state root>] [--to <dev state dir>]
 *                                 [--sessions 30] [--force]
 *
 * `--from` defaults to the live state root ($HOME) and `--to` to this
 * checkout's `.dev-state`, the directory `.agents/start.sh` boots from. The
 * source may be a home-style root (`~/.opensession/sessions` or the legacy
 * `~/.opensession-sessions`) or a sessions directory itself.
 *
 * What it does:
 *   1. Refuses unsafe targets: the source or live sessions directory, an
 *      ancestor of either, the live home, `~/.opensession`, the live deploy
 *      state, and anything inside a sessions directory. Refuses a non-empty
 *      target without `--force`, and a target that does not look like dev
 *      state even with it. Refuses while a dev server is using the target
 *      (pid file from start.sh, held gateway lease, or open database).
 *   2. Reads the source read-only. The central kernel database is queried on a
 *      read-only, query-only connection; every selected per-session actor
 *      database is serialized from a read-only connection into the staging
 *      directory. Nothing under the source is ever opened for
 *      writing.
 *   3. Picks the most recently active non-archived sessions that have an actor
 *      transcript, and builds a fresh kernel store with this checkout's
 *      schema. Only an allowlist is copied: the session document (stripped to
 *      display fields), and the transcript tables. Run state, turns, asks,
 *      deliveries, timers, outbox effects, commands, agent operations, wake
 *      cursors, append receipts, engine resume ids, worktree paths, MCP
 *      servers, report-back wiring, and every other table or field not on the
 *      allowlist are never written. Common credential shapes in transcript
 *      text are replaced with `[REDACTED]` (best effort).
 *   4. Marks the metadata and agent-session catalogs complete, so the gateway
 *      primes its list from the seeded catalog, and writes the
 *      `real-data-seed.json` marker last. start.sh skips demo generation when
 *      the marker exists.
 *
 * The result is assembled in a sibling staging directory and swapped into
 * place, so an interrupted run never leaves a half-seeded target behind.
 */
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  homeDir,
  statePathIn,
} from "../packages/core/opensession-server/src/server/paths";
import {
  SessionKernelStore,
  sessionKernelSessionDbPath,
} from "../packages/core/opensession-server/src/server/session-kernel/store";
import {
  markSessionMetadataCatalogComplete,
  seedSessionMetadataCatalog,
} from "../packages/core/opensession-server/src/server/session-kernel/metadata-store";
import { SESSION_METADATA_CATALOG_PAGE_LIMIT } from "../packages/core/opensession-server/src/server/session-kernel/metadata-protocol";
import { markCatalogDocumentImportComplete } from "../packages/core/opensession-server/src/server/session-kernel/catalog-document-store";
import { AGENT_SESSION_CATALOG_NAMESPACES } from "../packages/core/opensession-server/src/server/agent-session-catalog";
import { TranscriptStore } from "../packages/core/opensession-server/src/server/transcript-store";

export const REAL_SEED_MARKER = "real-data-seed.json";
/** Written by .agents/start.sh while a dev server runs from the directory. */
export const DEV_SERVER_PID_FILE = "dev-server.pid";
const SEED_REQUEST_ID = "dev-seed";

/** Session document fields that only describe a session. Anything else
 * (engine resume ids, worktree paths, MCP servers, sandbox and runner records,
 * report-back wiring, automation triggers, goals, loops, Slack/Plain links,
 * pinned accounts) is dropped. */
const KEPT_DOC_FIELDS = [
  "title",
  "mode",
  "repo",
  "repoLess",
  "parentSessionId",
  "spawnDepth",
  "createdByLogin",
  "lastPromptedBy",
  "model",
  "effort",
  "fastMode",
  "speed",
  "pstackMode",
  "lastEngineModel",
  "lastEngineProvider",
  "modelHistory",
  "usage",
  "duplicatedFromSessionId",
  "presetNote",
  "lastRunError",
] as const;

/** Tables copied from a source actor database. Every other table, including
 * ones added after this script was written, stays empty. */
const COPIED_TRANSCRIPT_TABLES = [
  "transcript_sessions",
  "transcript_events",
  "transcript_outline",
  "transcript_blobs",
] as const;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED]",
  ],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "[REDACTED]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{35}/g, "[REDACTED]"],
  [/(\bBearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, "$1[REDACTED]"],
  [
    /((?:api[_-]?key|secret|token|password|passwd|authorization)\\?["']?\s*[:=]\s*\\?["']?)[A-Za-z0-9._~+/-]{12,}/gi,
    "$1[REDACTED]",
  ],
];

/** Replace common credential shapes. The replacement never contains quotes
 * or backslashes, so it is safe inside serialized JSON. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS)
    out = out.replace(pattern, replacement);
  return out;
}

type SessionDoc = Record<string, unknown> & { id: string };

export function sanitizeSessionDoc(doc: SessionDoc): SessionDoc {
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  const out: SessionDoc = {
    id: doc.id,
    claudeSessionId: "",
    branch: str(doc.branch),
    worktreeDir: "",
    createdBy: str(doc.createdBy),
    createdAt: str(doc.createdAt),
    lastActivity: str(doc.lastActivity) || str(doc.createdAt),
  };
  for (const key of KEPT_DOC_FIELDS)
    if (doc[key] !== undefined) out[key] = doc[key];
  return JSON.parse(redactSecrets(JSON.stringify(out))) as SessionDoc;
}

/** Absolute path with symlinks resolved through the deepest existing
 * ancestor, so a target that does not exist yet still compares correctly. */
function canonical(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...rest);
}

/** True when `child` is `parent` or inside it. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const hasCentral = (dir: string) =>
  existsSync(join(dir, "session-kernel.sqlite"));

/** The sessions directory of a state root, or the root itself when it is a
 * sessions directory. Same preference order as statePath(). */
export function resolveSourceSessionsDir(from: string): string {
  const root = resolve(from);
  if (hasCentral(root)) return canonical(root);
  for (const dir of [
    join(root, ".opensession", "sessions"),
    join(root, ".opensession-sessions"),
  ])
    if (hasCentral(dir)) return canonical(dir);
  throw new Error(
    `No session store under ${root}: expected session-kernel.sqlite in it, in .opensession/sessions, or in .opensession-sessions`,
  );
}

/** Where a gateway booted with OPENSESSION_STATE_DIR=<to> keeps sessions. */
export function targetSessionsDir(to: string): string {
  return statePathIn(".opensession-sessions", {
    stateRoot: to,
    home: homeDir(),
  });
}

export type SeedTargetGuardInput = {
  sourceSessionsDir: string;
  target: string;
  /** The operator's home; defaults to $HOME. */
  liveHome?: string;
  env?: Record<string, string | undefined>;
};

/** Refuse any target whose replacement could touch the source or live state. */
export function assertSeedTargetSafe(input: SeedTargetGuardInput): void {
  const env = input.env ?? process.env;
  const target = canonical(input.target);
  const home = canonical(input.liveHome ?? homeDir());
  const source = canonical(input.sourceSessionsDir);
  const sessionDirs = [
    source,
    canonical(join(home, ".opensession", "sessions")),
    canonical(join(home, ".opensession-sessions")),
    ...(env.OPENSESSION_SESSIONS_DIR
      ? [canonical(env.OPENSESSION_SESSIONS_DIR)]
      : []),
  ];
  const liveRoot = canonical(join(home, ".opensession"));
  const deployRoot = canonical(
    env.OPENSESSION_DEPLOY_STATE || join(home, ".opensession", "deploy"),
  );
  const protectedPaths = [...sessionDirs, home, liveRoot, deployRoot];
  for (const path of protectedPaths)
    if (within(target, path))
      throw new Error(
        `Refusing to seed ${target}: replacing it would touch ${path}, which is live or source state`,
      );
  for (const dir of sessionDirs)
    if (within(dir, target))
      throw new Error(
        `Refusing to seed ${target}: it is inside the session store ${dir}`,
      );
  // Worktree previews are the only dev namespaces inside the live state root.
  // Never permit replacing a live store merely because it has a dev-like file.
  if (
    within(deployRoot, target) ||
    (within(liveRoot, target) &&
      !within(canonical(join(home, ".opensession", "worktrees")), target))
  )
    throw new Error(`Refusing to seed ${target}: it is inside live state`);
  if (canonical(targetSessionsDir(target)) === source)
    throw new Error(
      `Refusing to seed ${target}: its sessions directory is the source`,
    );
}

/** A non-empty target is replaced only with --force, and only when it already
 * looks like dev state, so a typo cannot wipe an unrelated directory. */
export function assertTargetReplaceable(target: string, force: boolean): void {
  if (!existsSync(target)) return;
  const entries = readdirSync(target);
  if (entries.length === 0) return;
  if (!force)
    throw new Error(
      `${target} is not empty. Pass --force to replace it with the seeded state.`,
    );
  const devMarkers = [
    REAL_SEED_MARKER,
    ".opensession-sessions",
    "session-kernel.log",
    "gateway-active.lock",
    DEV_SERVER_PID_FILE,
  ];
  if (!entries.some((entry) => devMarkers.includes(entry)))
    throw new Error(
      `Refusing to replace ${target}: it does not look like a dev state directory (none of ${devMarkers.join(", ")})`,
    );
}

export type DevServerProbe = {
  pidAlive(pid: number): boolean;
  /** True when another process holds the gateway lease file. */
  leaseHeld(lockPath: string): boolean;
  /** PIDs with the file open, or null when that cannot be determined. */
  openBy(path: string): number[] | null;
};

const defaultProbe: DevServerProbe = {
  pidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  leaseHeld(lockPath) {
    const command =
      process.platform === "darwin"
        ? ["/usr/bin/lockf", "-s", "-t", "0", lockPath, "/usr/bin/true"]
        : ["flock", "-n", lockPath, "true"];
    try {
      return (
        Bun.spawnSync(command, { stdout: "ignore", stderr: "ignore" })
          .exitCode !== 0
      );
    } catch {
      // No lock tool: fail closed rather than guess.
      return true;
    }
  },
  openBy(path) {
    try {
      const result = Bun.spawnSync(["lsof", "-t", "--", path], {
        stdout: "pipe",
        stderr: "ignore",
      });
      // lsof exits 1 with no output when nothing has the file open.
      if (result.exitCode !== 0 && result.exitCode !== 1) return null;
      return result.stdout
        .toString()
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    } catch {
      return null;
    }
  },
};

/** Refuse while a dev server could be reading or writing the target. */
export function assertDevServerStopped(
  target: string,
  probe: DevServerProbe = defaultProbe,
): void {
  if (!existsSync(target)) return;
  const pidFile = join(target, DEV_SERVER_PID_FILE);
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && probe.pidAlive(pid))
      throw new Error(
        `A dev server (pid ${pid}) is running from ${target}. Stop it first; if that pid is not a dev server, delete ${pidFile}.`,
      );
  }
  const lease = join(target, "gateway-active.lock");
  if (existsSync(lease) && probe.leaseHeld(lease))
    throw new Error(
      `The gateway lease ${lease} is held, so a dev gateway is running from ${target}. Stop it first; if none is running, delete the lock file.`,
    );
  const central = join(targetSessionsDir(target), "session-kernel.sqlite");
  if (existsSync(central)) {
    const opened = probe.openBy(central);
    if (opened === null)
      throw new Error(
        `Cannot determine whether ${central} is open. Install lsof and stop the dev server before seeding.`,
      );
    const pids = opened.filter((pid) => pid !== process.pid);
    if (pids.length)
      throw new Error(
        `${central} is open by pid ${pids.join(", ")}. Stop the dev server first.`,
      );
  }
}

/** Open a source database without any write capability. */
function openSourceReadonly(path: string): Database {
  const db = new Database(path, { readonly: true });
  db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;");
  return db;
}

function tableExists(db: Database, table: string, schema = "main"): boolean {
  return !!db
    .query(
      `SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`,
    )
    .get(table);
}

function columns(db: Database, table: string, schema = "main"): string[] {
  return (
    db.query(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

type Candidate = {
  sessionId: string;
  doc: SessionDoc;
  rev: number;
  lastActivityMs: number;
  archived: boolean;
  transcriptAuthority?: string;
  transcriptMigrationReceipt: string | null;
  transcriptPublishedAt: number | null;
};

function parseDoc(text: string, sessionId: string): SessionDoc | null {
  try {
    const doc = JSON.parse(text) as unknown;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
    return (doc as SessionDoc).id === sessionId ? (doc as SessionDoc) : null;
  } catch {
    return null;
  }
}

function docActivityMs(doc: SessionDoc): number {
  const value = Date.parse(String(doc.lastActivity || doc.createdAt || ""));
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function docRev(doc: SessionDoc): number {
  return typeof doc.rev === "number" &&
    Number.isInteger(doc.rev) &&
    doc.rev >= 1
    ? doc.rev
    : 1;
}

function archivedIds(sessionsDir: string): Set<string> {
  const path = join(sessionsDir, "archive-registry.json");
  if (!existsSync(path)) return new Set();
  try {
    const registry = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return new Set(
      registry && typeof registry === "object" ? Object.keys(registry) : [],
    );
  } catch {
    // An unreadable registry cannot prove any session is unarchived, so stop
    // rather than copy archived work.
    throw new Error(`Cannot read ${path}; refusing to guess archive state`);
  }
}

/** Every session the source knows about, newest document wins. Read-only. */
function readCandidates(sourceSessionsDir: string): Candidate[] {
  const byId = new Map<string, Candidate>();
  const consider = (candidate: Candidate) => {
    const existing = byId.get(candidate.sessionId);
    if (!existing || candidate.rev > existing.rev)
      byId.set(candidate.sessionId, {
        ...candidate,
        archived: candidate.archived || !!existing?.archived,
        transcriptAuthority:
          existing?.transcriptAuthority ?? candidate.transcriptAuthority,
      });
    else if (candidate.archived) existing.archived = true;
  };

  for (const file of readdirSync(sourceSessionsDir)) {
    if (!file.endsWith(".json")) continue;
    const sessionId = file.slice(0, -".json".length);
    let text: string;
    try {
      text = readFileSync(join(sourceSessionsDir, file), "utf8");
    } catch {
      continue;
    }
    const doc = parseDoc(text, sessionId);
    if (!doc) continue;
    consider({
      sessionId,
      doc,
      rev: docRev(doc),
      lastActivityMs: docActivityMs(doc),
      archived: !!doc.archived,
      transcriptMigrationReceipt: null,
      transcriptPublishedAt: null,
    });
  }

  const central = openSourceReadonly(
    join(sourceSessionsDir, "session-kernel.sqlite"),
  );
  try {
    central.exec("BEGIN");
    if (tableExists(central, "session_kernel_metadata_catalog")) {
      const rows = central
        .query(
          `SELECT session_id, doc, rev, archived, last_activity_ms
           FROM session_kernel_metadata_catalog`,
        )
        .all() as Array<{
        session_id: string;
        doc: string;
        rev: number;
        archived: number;
        last_activity_ms: number;
      }>;
      for (const row of rows) {
        const doc = parseDoc(row.doc, row.session_id);
        if (!doc) continue;
        consider({
          sessionId: row.session_id,
          doc,
          rev: Number(row.rev),
          lastActivityMs: Math.max(
            Number(row.last_activity_ms) || 0,
            docActivityMs(doc),
          ),
          archived: row.archived === 1 || !!doc.archived,
          transcriptMigrationReceipt: null,
          transcriptPublishedAt: null,
        });
      }
    }
    if (tableExists(central, "session_kernel_placements")) {
      const cols = new Set(columns(central, "session_kernel_placements"));
      if (cols.has("transcript_authority")) {
        const rows = central
          .query(
            `SELECT session_id, placement, transcript_authority,
                    ${cols.has("transcript_migration_receipt") ? "transcript_migration_receipt" : "NULL"} AS receipt,
                    ${cols.has("transcript_published_at") ? "transcript_published_at" : "NULL"} AS published_at
             FROM session_kernel_placements`,
          )
          .all() as Array<{
          session_id: string;
          placement: string;
          transcript_authority: string;
          receipt: string | null;
          published_at: number | null;
        }>;
        for (const row of rows) {
          const candidate = byId.get(row.session_id);
          if (!candidate || row.placement !== "isolated") continue;
          candidate.transcriptAuthority = row.transcript_authority;
          candidate.transcriptMigrationReceipt = row.receipt;
          candidate.transcriptPublishedAt = row.published_at;
        }
      }
    }
    central.exec("COMMIT");
  } finally {
    central.close();
  }

  const archived = archivedIds(sourceSessionsDir);
  for (const candidate of byId.values())
    if (archived.has(candidate.sessionId)) candidate.archived = true;
  return [...byId.values()];
}

/** Consistent copy of one source actor database, committed WAL frames
 * included, taken on a read-only connection. (`VACUUM INTO` cannot be used:
 * its output inherits the read-only open flags.) */
function snapshotActor(sourcePath: string, snapshotPath: string): void {
  mkdirSync(dirname(snapshotPath), { recursive: true });
  const db = openSourceReadonly(sourcePath);
  try {
    const image = db.serialize();
    // Header bytes 18/19 select WAL mode. The private copy has no -shm, and a
    // WAL database without one cannot be opened read-only, so store it as a
    // rollback-journal database.
    image[18] = 1;
    image[19] = 1;
    writeFileSync(snapshotPath, image);
  } finally {
    db.close();
  }
}

function redactColumn(
  db: Database,
  table: "transcript_events" | "transcript_blobs",
): number {
  const rows = db
    .query(`SELECT rowid AS rid, data FROM ${table}`)
    .all() as Array<{ rid: number; data: string }>;
  const update = db.query(`UPDATE ${table} SET data = ? WHERE rowid = ?`);
  let changed = 0;
  db.transaction(() => {
    for (const row of rows) {
      const next = redactSecrets(row.data);
      if (next !== row.data) {
        update.run(next, row.rid);
        changed++;
      }
    }
  })();
  return changed;
}

/** Create a kernel database with this checkout's schema. Opening a store
 * claims writer ownership for this process; drop that claim so the dev kernel
 * never sees a foreign owner (or a reused pid) on its first open. */
function createKernelSchema(path: string): void {
  new SessionKernelStore(path).close();
  const db = new Database(path);
  try {
    db.run("DELETE FROM session_kernel_owner");
  } finally {
    db.close();
  }
}

/** Build one target actor database: this checkout's schema, the sanitized
 * document, and the allowlisted transcript rows. Returns the event count. */
function buildActor(
  targetPath: string,
  snapshotPath: string,
  sessionId: string,
  doc: SessionDoc,
  rev: number,
  lastActivityMs: number,
): { events: number; redacted: number } {
  createKernelSchema(targetPath);
  new TranscriptStore(targetPath, { actorOwned: false }).close();
  const db = new Database(targetPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    db.run("ATTACH DATABASE ? AS src", [snapshotPath]);
    db.transaction(() => {
      for (const table of COPIED_TRANSCRIPT_TABLES) {
        if (!tableExists(db, table, "src")) continue;
        const source = new Set(columns(db, table, "src"));
        const shared = columns(db, table).filter((name) => source.has(name));
        if (!shared.includes("session_id")) continue;
        const list = shared.map((name) => `"${name}"`).join(", ");
        db.run(
          `INSERT INTO main.${table} (${list}) SELECT ${list} FROM src.${table} WHERE session_id = ?`,
          [sessionId],
        );
      }
      db.run(
        `INSERT INTO session_kernel_metadata
           (session_id, doc, rev, request_id, archived, last_activity_ms, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
        [
          sessionId,
          JSON.stringify(doc),
          rev,
          SEED_REQUEST_ID,
          lastActivityMs,
          Date.now(),
        ],
      );
    })();
    db.exec("DETACH DATABASE src");
    const redacted =
      redactColumn(db, "transcript_events") +
      redactColumn(db, "transcript_blobs");
    const events = Number(
      (
        db
          .query(
            "SELECT COUNT(*) AS n FROM transcript_events WHERE session_id = ?",
          )
          .get(sessionId) as { n: number }
      ).n,
    );
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    return { events, redacted };
  } finally {
    db.close();
  }
}

export type SeedDevStateOptions = {
  from: string;
  to: string;
  sessions: number;
  force: boolean;
  liveHome?: string;
  env?: Record<string, string | undefined>;
  probe?: DevServerProbe;
  log?: (line: string) => void;
};

export type SeedDevStateSummary = {
  target: string;
  sourceSessionsDir: string;
  sessionIds: string[];
  events: number;
  redacted: number;
  skipped: { archived: number; noTranscript: number; failed: string[] };
};

export async function seedDevState(
  options: SeedDevStateOptions,
): Promise<SeedDevStateSummary> {
  const log = options.log ?? (() => {});
  if (!Number.isInteger(options.sessions) || options.sessions < 1)
    throw new Error("--sessions must be a positive integer");
  const sourceSessionsDir = resolveSourceSessionsDir(options.from);
  const target = canonical(options.to);
  assertSeedTargetSafe({
    sourceSessionsDir,
    target,
    liveHome: options.liveHome,
    env: options.env,
  });
  assertTargetReplaceable(target, options.force);
  assertDevServerStopped(target, options.probe);

  const staging = join(
    dirname(target),
    `.${basename(target)}.seeding-${process.pid}-${Date.now()}`,
  );
  assertSeedTargetSafe({
    sourceSessionsDir,
    target: staging,
    liveHome: options.liveHome,
    env: options.env,
  });
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  try {
    const all = readCandidates(sourceSessionsDir);
    const archived = all.filter((c) => c.archived).length;
    const live = all.filter((c) => !c.archived);
    const sourceActorRoot = join(sourceSessionsDir, "session-kernel-sessions");
    const withTranscript = live.filter(
      (c) =>
        c.transcriptAuthority === "actor" &&
        existsSync(sessionKernelSessionDbPath(c.sessionId, sourceActorRoot)),
    );
    withTranscript.sort(
      (a, b) =>
        b.lastActivityMs - a.lastActivityMs ||
        a.sessionId.localeCompare(b.sessionId),
    );
    log(
      `[seed-dev-state] ${all.length} session(s) in source: ${archived} archived, ${live.length - withTranscript.length} without an actor transcript`,
    );

    const sessionsDir = targetSessionsDir(staging);
    const actorRoot = join(sessionsDir, "session-kernel-sessions");
    const snapshots = join(staging, ".snapshots");
    mkdirSync(sessionsDir, { recursive: true });

    const seeded: Array<{
      candidate: Candidate;
      doc: SessionDoc;
      rev: number;
      lastActivityMs: number;
    }> = [];
    const failed: string[] = [];
    let events = 0;
    let redacted = 0;
    for (const candidate of withTranscript) {
      if (seeded.length >= options.sessions) break;
      const sourcePath = sessionKernelSessionDbPath(
        candidate.sessionId,
        sourceActorRoot,
      );
      const snapshotPath = sessionKernelSessionDbPath(
        candidate.sessionId,
        snapshots,
      );
      try {
        snapshotActor(sourcePath, snapshotPath);
        // The actor's own document is authoritative; the catalog and files
        // are projections that may lag it.
        let { doc, rev, lastActivityMs } = candidate;
        const snap = openSourceReadonly(snapshotPath);
        try {
          if (tableExists(snap, "session_kernel_metadata")) {
            const row = snap
              .query(
                "SELECT doc, rev, archived FROM session_kernel_metadata WHERE session_id = ?",
              )
              .get(candidate.sessionId) as {
              doc: string;
              rev: number;
              archived: number;
            } | null;
            const actorDoc = row && parseDoc(row.doc, candidate.sessionId);
            if (row && actorDoc && Number(row.rev) >= rev) {
              if (row.archived === 1 || actorDoc.archived) continue;
              doc = actorDoc;
              rev = Number(row.rev);
              lastActivityMs = Math.max(
                lastActivityMs,
                docActivityMs(actorDoc),
              );
            }
          }
        } finally {
          snap.close();
        }
        const clean = sanitizeSessionDoc({ ...doc, rev });
        const result = buildActor(
          sessionKernelSessionDbPath(candidate.sessionId, actorRoot),
          snapshotPath,
          candidate.sessionId,
          clean,
          rev,
          lastActivityMs,
        );
        writeFileSync(
          join(sessionsDir, `${candidate.sessionId}.json`),
          `${JSON.stringify(clean, null, 2)}\n`,
        );
        events += result.events;
        redacted += result.redacted;
        seeded.push({ candidate, doc: clean, rev, lastActivityMs });
      } catch (error) {
        failed.push(candidate.sessionId);
        log(
          `[seed-dev-state] skipped ${candidate.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        for (const suffix of ["", "-wal", "-shm"])
          rmSync(`${snapshotPath}${suffix}`, { force: true });
      }
    }
    rmSync(snapshots, { recursive: true, force: true });

    const centralPath = join(sessionsDir, "session-kernel.sqlite");
    createKernelSchema(centralPath);
    const central = new Database(centralPath);
    try {
      const now = Date.now();
      const insertPlacement = central.query(
        `INSERT INTO session_kernel_placements
           (session_id, placement, needs_scan, next_timer_at, next_outbox_at, updated_at,
            transcript_authority, transcript_migration_receipt, transcript_published_at)
         VALUES (?, 'isolated', 0, NULL, NULL, ?, 'actor', ?, ?)`,
      );
      central.transaction(() => {
        for (const { candidate } of seeded)
          insertPlacement.run(
            candidate.sessionId,
            now,
            candidate.transcriptMigrationReceipt,
            candidate.transcriptPublishedAt,
          );
      })();
      const rows = seeded.map(({ candidate, doc, rev, lastActivityMs }) => ({
        sessionId: candidate.sessionId,
        doc: JSON.stringify(doc),
        rev,
        archived: false,
        lastActivityMs,
      }));
      for (let i = 0; i < rows.length; i += SESSION_METADATA_CATALOG_PAGE_LIMIT)
        seedSessionMetadataCatalog(
          central,
          rows.slice(i, i + SESSION_METADATA_CATALOG_PAGE_LIMIT),
        );
      markSessionMetadataCatalogComplete(central);
      for (const namespace of Object.values(AGENT_SESSION_CATALOG_NAMESPACES))
        markCatalogDocumentImportComplete(central, namespace);
      central.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      central.close();
    }

    const sessionIds = seeded.map(({ candidate }) => candidate.sessionId);
    writeFileSync(
      join(staging, REAL_SEED_MARKER),
      `${JSON.stringify(
        {
          version: 1,
          seededAt: new Date().toISOString(),
          source: sourceSessionsDir,
          sessions: sessionIds.length,
          transcriptEvents: events,
        },
        null,
        2,
      )}\n`,
    );

    // Swap: the target only ever holds a complete seed or its old contents.
    assertDevServerStopped(target, options.probe);
    const previous = `${staging}.previous`;
    const hadTarget = existsSync(target);
    if (hadTarget) renameSync(target, previous);
    try {
      renameSync(staging, target);
    } catch (error) {
      if (hadTarget) renameSync(previous, target);
      throw error;
    }
    rmSync(previous, { recursive: true, force: true });

    log(
      `[seed-dev-state] seeded ${sessionIds.length} session(s), ${events} transcript event(s), ${redacted} redacted row(s) into ${target}`,
    );
    return {
      target,
      sourceSessionsDir,
      sessionIds,
      events,
      redacted,
      skipped: {
        archived,
        noTranscript: live.length - withTranscript.length,
        failed,
      },
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function parseArgs(argv: string[]): SeedDevStateOptions | null {
  const options: SeedDevStateOptions = {
    from: homeDir(),
    to: join(import.meta.dir, "..", ".dev-state"),
    sessions: 30,
    force: false,
    log: (line) => console.log(line),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--from") options.from = next();
    else if (arg === "--to") options.to = next();
    else if (arg === "--sessions") options.sessions = Number(next());
    else if (arg === "--force") options.force = true;
    else if (arg === "--help" || arg === "-h") return null;
    else throw new Error(`Unknown argument ${arg}`);
  }
  return options;
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options) {
      console.log(
        "Usage: bun scripts/seed-dev-state.ts [--from <state root>] [--to <dev state dir>] [--sessions 30] [--force]",
      );
      process.exit(0);
    }
    await seedDevState(options);
  } catch (error) {
    console.error(
      `[seed-dev-state] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
