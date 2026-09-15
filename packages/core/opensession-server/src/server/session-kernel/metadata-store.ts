/**
 * SQL for actor-owned session metadata and its central catalog projection.
 *
 * `session_kernel_metadata` lives in the owning actor database (or the central
 * database for legacy central placements) and is the only place a document is
 * mutated. `session_kernel_metadata_catalog` lives in the central database and
 * is a projection of committed documents: list-shaped reads and boot rebuilds
 * page it instead of opening every actor. Both tables exist in every kernel
 * database because they share one schema; the catalog is only populated
 * centrally.
 */
import type { Database } from "bun:sqlite";
import { canonicalAccessDocument } from "../canonical-access-document";
import {
  canAccessScope,
  parseAccessScope,
  sameAccessScope,
  type AccessPrincipal,
} from "../../shared/access-scope";
import { accessPredicateSql } from "../access-scope-sql";
import {
  assertMetadataActorRequest,
  type MetadataActorRequest,
  type SessionMetadataCatalogRow,
  type SessionMetadataPutResult,
  type SessionMetadataRecord,
  type SessionMetadataReadResult,
  type SessionMetadataSeedRow,
} from "./metadata-protocol";

const CATALOG_COMPLETE_MIGRATION = "session_metadata_catalog_v1";

type MetadataRow = {
  session_id: string;
  doc: string;
  rev: number;
  request_id?: string;
  exported_rev?: number;
  archived: number;
  last_activity_ms: number;
  updated_at: number;
};

function record(row: MetadataRow): SessionMetadataRecord {
  return {
    sessionId: row.session_id,
    doc: row.doc,
    rev: Number(row.rev),
    archived: row.archived === 1,
    lastActivityMs: Number(row.last_activity_ms),
    updatedAt: Number(row.updated_at),
  };
}

export function migrateSessionMetadataSchema33(
  db: Database,
  schemaVersion: number,
): void {
  if (schemaVersion >= 33) return;
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_kernel_metadata (
        session_id TEXT PRIMARY KEY,
        doc TEXT NOT NULL,
        rev INTEGER NOT NULL CHECK(rev >= 1),
        request_id TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
        last_activity_ms INTEGER NOT NULL DEFAULT 0 CHECK(last_activity_ms >= 0),
        updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS session_kernel_metadata_catalog (
        session_id TEXT PRIMARY KEY,
        doc TEXT NOT NULL,
        rev INTEGER NOT NULL CHECK(rev >= 1),
        exported_rev INTEGER NOT NULL DEFAULT 0 CHECK(exported_rev >= 0),
        archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
        last_activity_ms INTEGER NOT NULL DEFAULT 0 CHECK(last_activity_ms >= 0),
        updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_skmc_export_pending
        ON session_kernel_metadata_catalog(session_id)
        WHERE exported_rev < rev;
      CREATE INDEX IF NOT EXISTS idx_skmc_activity
        ON session_kernel_metadata_catalog(archived, last_activity_ms DESC);
      PRAGMA user_version = 33;
    `);
  });
  tx.immediate();
}

export function readSessionMetadata(
  db: Database,
  sessionId: string,
): SessionMetadataRecord | null {
  const row = db
    .query(
      `SELECT session_id, doc, rev, archived, last_activity_ms, updated_at
       FROM session_kernel_metadata WHERE session_id = ?`,
    )
    .get(sessionId) as MetadataRow | null;
  return row ? record(row) : null;
}

/** Compare-and-set the document. A replay of an already committed request id
 * returns its receipt; any other revision mismatch returns the stored truth so
 * the caller can re-apply its mutation on top of it. */
export function putSessionMetadata(
  db: Database,
  input: Extract<MetadataActorRequest, { op: "put" }>,
): SessionMetadataPutResult {
  assertMetadataActorRequest(input);
  input = { ...input, doc: canonicalAccessDocument(db, input.doc) };
  const tx = db.transaction((): SessionMetadataPutResult => {
    const current = db
      .query(
        `SELECT session_id, doc, rev, request_id, archived, last_activity_ms, updated_at
         FROM session_kernel_metadata WHERE session_id = ?`,
      )
      .get(input.sessionId) as MetadataRow | null;
    const next = JSON.parse(input.doc);
    if (
      !next ||
      typeof next !== "object" ||
      Array.isArray(next) ||
      !parseAccessScope(next.accessScope)
    )
      throw new Error("Invalid session access scope");
    if (
      !canAccessScope(next.accessScope, input.principal) ||
      (current &&
        !canAccessScope(JSON.parse(current.doc).accessScope, input.principal))
    )
      throw new Error("Session not found");
    if (
      current &&
      !sameAccessScope(JSON.parse(current.doc).accessScope, next.accessScope)
    )
      throw new Error("Session access scope is immutable");
    if (current && current.request_id === input.requestId)
      return { status: "duplicate", rev: Number(current.rev) };
    const currentRev = current ? Number(current.rev) : null;
    if (currentRev !== input.expectedRev)
      return { status: "conflict", current: current ? record(current) : null };
    db.run(
      `INSERT INTO session_kernel_metadata
         (session_id, doc, rev, request_id, archived, last_activity_ms, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         doc = excluded.doc,
         rev = excluded.rev,
         request_id = excluded.request_id,
         archived = excluded.archived,
         last_activity_ms = excluded.last_activity_ms,
         updated_at = excluded.updated_at`,
      [
        input.sessionId,
        JSON.stringify(next),
        input.rev,
        input.requestId,
        input.archived ? 1 : 0,
        input.lastActivityMs,
        Date.now(),
      ],
    );
    return { status: "committed", rev: input.rev };
  });
  return tx.immediate();
}

export function deleteSessionMetadata(db: Database, sessionId: string): void {
  db.run("DELETE FROM session_kernel_metadata WHERE session_id = ?", [
    sessionId,
  ]);
  db.run("DELETE FROM session_kernel_metadata_catalog WHERE session_id = ?", [
    sessionId,
  ]);
}

/** Consult the central authority before a lazy actor seed or recovery write.
 * The actor may not have a document yet even when the catalog already does. */
export function assertSessionMetadataCatalogScope(
  db: Database,
  sessionId: string,
  doc: string,
): void {
  const current = db
    .query(
      "SELECT doc FROM session_kernel_metadata_catalog WHERE session_id = ?",
    )
    .get(sessionId) as { doc: string } | null;
  if (
    current &&
    !sameAccessScope(
      JSON.parse(current.doc).accessScope,
      JSON.parse(canonicalAccessDocument(db, doc)).accessScope,
    )
  )
    throw new Error("Session access scope is immutable");
}

export function assertSessionMetadataCatalogWrite(
  db: Database,
  input: Extract<MetadataActorRequest, { op: "put" }>,
): void {
  const current = db
    .query(
      "SELECT doc FROM session_kernel_metadata_catalog WHERE session_id = ?",
    )
    .get(input.sessionId) as { doc: string } | null;
  if (
    current &&
    !canAccessScope(JSON.parse(current.doc).accessScope, input.principal)
  )
    throw new Error("Session not found");
  assertSessionMetadataCatalogScope(db, input.sessionId, input.doc);
}

/** Central only. Never moves the catalog backwards: a stale settle after a
 * newer commit is a no-op, and the export marker survives re-settles. */
export function settleSessionMetadataCatalog(
  db: Database,
  sessionId: string,
  current: SessionMetadataRecord | undefined,
): void {
  if (!current) {
    db.run("DELETE FROM session_kernel_metadata_catalog WHERE session_id = ?", [
      sessionId,
    ]);
    return;
  }
  current = { ...current, doc: canonicalAccessDocument(db, current.doc) };
  assertSessionMetadataCatalogScope(db, sessionId, current.doc);
  db.run(
    `INSERT INTO session_kernel_metadata_catalog
       (session_id, doc, rev, exported_rev, archived, last_activity_ms, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       doc = excluded.doc,
       rev = excluded.rev,
       archived = excluded.archived,
       last_activity_ms = excluded.last_activity_ms,
       updated_at = excluded.updated_at
     WHERE excluded.rev >= session_kernel_metadata_catalog.rev`,
    [
      sessionId,
      current.doc,
      current.rev,
      current.archived ? 1 : 0,
      current.lastActivityMs,
      Date.now(),
    ],
  );
}

/** Central only. Project historical session files that predate actor-owned
 * metadata. A row that already exists, whether from an earlier seed or a live
 * commit, is left untouched; the file already carries the seeded revision, so
 * the row starts exported. Returns the number of rows inserted. */
export function seedSessionMetadataCatalog(
  db: Database,
  rows: SessionMetadataSeedRow[],
): number {
  assertMetadataActorRequest({ op: "seed_catalog", rows });
  const insert = db.query(
    `INSERT OR IGNORE INTO session_kernel_metadata_catalog
       (session_id, doc, rev, exported_rev, archived, last_activity_ms, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((): number => {
    const now = Date.now();
    let inserted = 0;
    for (const row of rows) {
      inserted += insert.run(
        row.sessionId,
        canonicalAccessDocument(db, row.doc),
        row.rev,
        row.rev,
        row.archived ? 1 : 0,
        row.lastActivityMs,
        now,
      ).changes;
    }
    return inserted;
  });
  return tx.immediate();
}

export function markSessionMetadataExported(
  db: Database,
  sessionId: string,
  rev: number,
): void {
  db.run(
    `UPDATE session_kernel_metadata_catalog
     SET exported_rev = ? WHERE session_id = ? AND exported_rev < ?`,
    [rev, sessionId, rev],
  );
}

/** One session's committed document from the central projection. */
export function sessionMetadataCatalogGet(
  db: Database,
  sessionId: string,
  principal?: AccessPrincipal,
): SessionMetadataCatalogRow | null {
  const row = db
    .query(
      `SELECT session_id, doc, rev, exported_rev, archived, last_activity_ms, updated_at
       FROM session_kernel_metadata_catalog WHERE session_id = ? AND ${accessPredicateSql("doc", principal)}`,
    )
    .get(sessionId) as MetadataRow | null;
  return row ? { ...record(row), exportedRev: Number(row.exported_rev) } : null;
}

/** Internal read seam distinguishes denied from absent so a legacy export
 * fallback cannot resurrect an existing but hidden catalog document. */
export function sessionMetadataCatalogRead(
  db: Database,
  sessionId: string,
  principal?: AccessPrincipal,
): SessionMetadataReadResult {
  const visible = sessionMetadataCatalogGet(db, sessionId, principal);
  if (visible) return { status: "found", record: visible };
  const exists = db
    .query("SELECT 1 FROM session_kernel_metadata_catalog WHERE session_id = ?")
    .get(sessionId);
  return { status: exists ? "denied" : "missing" };
}

export function sessionMetadataCatalogPage(
  db: Database,
  afterSessionId: string,
  limit: number,
  principal?: AccessPrincipal,
): SessionMetadataCatalogRow[] {
  return (
    db
      .query(
        `SELECT session_id, doc, rev, exported_rev, archived, last_activity_ms, updated_at
         FROM session_kernel_metadata_catalog
         WHERE session_id > ? AND ${accessPredicateSql("doc", principal)}
         ORDER BY session_id
         LIMIT ?`,
      )
      .all(afterSessionId, limit) as MetadataRow[]
  ).map((row) => ({ ...record(row), exportedRev: Number(row.exported_rev) }));
}

/** The bounded work index for export repair: rows whose committed revision
 * never reached the derived session file. */
export function sessionMetadataPendingExports(
  db: Database,
  limit: number,
): Array<{ sessionId: string; rev: number; exportedRev: number }> {
  return (
    db
      .query(
        `SELECT session_id, rev, exported_rev
         FROM session_kernel_metadata_catalog
         WHERE exported_rev < rev AND ${accessPredicateSql("doc")}
         ORDER BY session_id
         LIMIT ?`,
      )
      .all(limit) as Array<{
      session_id: string;
      rev: number;
      exported_rev: number;
    }>
  ).map((row) => ({
    sessionId: row.session_id,
    rev: Number(row.rev),
    exportedRev: Number(row.exported_rev),
  }));
}

export function sessionMetadataCatalogCount(
  db: Database,
  principal?: AccessPrincipal,
): number {
  const row = db
    .query(
      `SELECT count(*) AS n FROM session_kernel_metadata_catalog WHERE ${accessPredicateSql("doc", principal)}`,
    )
    .get() as { n: number } | null;
  return Number(row?.n ?? 0);
}

/** True once an operator seeded every historical session file, so a list
 * rebuild may trust the catalog instead of scanning the sessions directory. */
export function sessionMetadataCatalogComplete(db: Database): boolean {
  return !!db
    .query("SELECT 1 FROM session_kernel_migrations WHERE name = ?")
    .get(CATALOG_COMPLETE_MIGRATION);
}

export function markSessionMetadataCatalogComplete(db: Database): void {
  db.run(
    "INSERT OR IGNORE INTO session_kernel_migrations (name, completed_at) VALUES (?, ?)",
    [CATALOG_COMPLETE_MIGRATION, Date.now()],
  );
}
