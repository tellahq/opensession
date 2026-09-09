/**
 * SQL for central catalog documents; see catalog-document-protocol.ts for the
 * contract. `session_kernel_catalog_documents` exists in every kernel database
 * because they share one schema, but only the central database is ever
 * populated: the actor worker serves every request from `host.central`.
 */
import type { Database } from "bun:sqlite";
import {
  assertCatalogDocumentRequest,
  CATALOG_DOCUMENT_MAX_GET_MANY_RESPONSE_BYTES,
  CATALOG_DOCUMENT_MAX_PAGE_BYTES,
  CATALOG_DOCUMENT_SEED_REQUEST_ID,
  type CatalogDocumentPutResult,
  type CatalogDocumentRecord,
  type CatalogDocumentRequest,
  type CatalogDocumentSeedRow,
} from "./catalog-document-protocol";

/** UTF-8 bytes a row contributes to a response. */
const ROW_BYTES =
  "length(CAST(key AS BLOB)) + COALESCE(length(CAST(value AS BLOB)), 0)";

type DocumentRow = {
  key: string;
  value: string | null;
  rev: number;
  request_id?: string;
};

function record(row: DocumentRow): CatalogDocumentRecord {
  return { key: row.key, value: row.value, rev: Number(row.rev) };
}

function importFlag(namespace: string): string {
  return `catalog_documents_import:${namespace}`;
}

export function migrateCatalogDocumentSchema34(
  db: Database,
  schemaVersion: number,
): void {
  if (schemaVersion >= 34) return;
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_kernel_catalog_documents (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        rev INTEGER NOT NULL CHECK(rev >= 1),
        request_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
        PRIMARY KEY (namespace, key)
      ) STRICT, WITHOUT ROWID;
      PRAGMA user_version = 34;
    `);
  });
  tx.immediate();
}

export function catalogDocumentGet(
  db: Database,
  namespace: string,
  key: string,
): CatalogDocumentRecord | null {
  const row = db
    .query(
      `SELECT key, value, rev FROM session_kernel_catalog_documents
       WHERE namespace = ? AND key = ?`,
    )
    .get(namespace, key) as DocumentRow | null;
  return row ? record(row) : null;
}

/** One indexed `IN` lookup; the request validator bounds the key count so
 * the placeholder list stays far below SQLite's variable limit. */
export function catalogDocumentGetMany(
  db: Database,
  namespace: string,
  keys: string[],
): CatalogDocumentRecord[] {
  assertCatalogDocumentRequest({ op: "get_many", namespace, keys });
  const unique = [...new Set(keys)];
  const placeholders = unique.map(() => "?").join(", ");
  // Size the answer before materializing it: a truncated answer would read
  // as "missing", so an oversize set is refused outright.
  const sized = db
    .query(
      `SELECT COALESCE(SUM(${ROW_BYTES}), 0) AS bytes
       FROM session_kernel_catalog_documents
       WHERE namespace = ? AND key IN (${placeholders})`,
    )
    .get(namespace, ...unique) as { bytes: number };
  if (Number(sized.bytes) > CATALOG_DOCUMENT_MAX_GET_MANY_RESPONSE_BYTES)
    throw new Error(
      `Catalog document key batch selects ${sized.bytes} bytes, over the ${CATALOG_DOCUMENT_MAX_GET_MANY_RESPONSE_BYTES} byte response bound`,
    );
  return (
    db
      .query(
        `SELECT key, value, rev FROM session_kernel_catalog_documents
         WHERE namespace = ? AND key IN (${placeholders})
         ORDER BY key`,
      )
      .all(namespace, ...unique) as DocumentRow[]
  ).map(record);
}

export function catalogDocumentPage(
  db: Database,
  namespace: string,
  afterKey: string,
  limit: number,
): CatalogDocumentRecord[] {
  // Bounded by rows and by bytes: keep rows while the running total stays
  // within the page budget, but always return the first row so a page is
  // never empty while rows remain. The innermost query applies the row limit
  // before the window sum, so the page costs O(limit) rows however many
  // remain in the namespace, and the rows past the budget are never sent.
  return (
    db
      .query(
        `SELECT key, value, rev FROM (
           SELECT key, value, rev,
             ROW_NUMBER() OVER (ORDER BY key) AS position,
             SUM(own) OVER (
               ORDER BY key ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS cumulative
           FROM (
             SELECT key, value, rev, ${ROW_BYTES} AS own
             FROM session_kernel_catalog_documents
             WHERE namespace = ? AND key > ?
             ORDER BY key
             LIMIT ?
           )
         )
         WHERE cumulative <= ? OR position = 1
         ORDER BY key`,
      )
      .all(
        namespace,
        afterKey,
        limit,
        CATALOG_DOCUMENT_MAX_PAGE_BYTES,
      ) as DocumentRow[]
  ).map(record);
}

/** Compare-and-set one document. A replay of the request id that committed
 * the current revision returns its receipt; any other revision mismatch
 * returns the stored truth so the caller can re-apply its mutation on top of
 * it. The revision is assigned here, never by the caller. */
export function putCatalogDocument(
  db: Database,
  input: Extract<CatalogDocumentRequest, { op: "put" }>,
): CatalogDocumentPutResult {
  assertCatalogDocumentRequest(input);
  const tx = db.transaction((): CatalogDocumentPutResult => {
    const current = db
      .query(
        `SELECT key, value, rev, request_id FROM session_kernel_catalog_documents
         WHERE namespace = ? AND key = ?`,
      )
      .get(input.namespace, input.key) as DocumentRow | null;
    if (current && current.request_id === input.requestId)
      return { status: "duplicate", rev: Number(current.rev) };
    const currentRev = current ? Number(current.rev) : null;
    if (currentRev !== input.expectedRev)
      return { status: "conflict", current: current ? record(current) : null };
    const rev = (currentRev ?? 0) + 1;
    db.run(
      `INSERT INTO session_kernel_catalog_documents
         (namespace, key, value, rev, request_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET
         value = excluded.value,
         rev = excluded.rev,
         request_id = excluded.request_id,
         updated_at = excluded.updated_at`,
      [
        input.namespace,
        input.key,
        input.value,
        rev,
        input.requestId,
        Date.now(),
      ],
    );
    return { status: "committed", rev };
  });
  return tx.immediate();
}

/** One-time import. Existing rows, live or tombstoned, are left untouched. */
export function seedCatalogDocuments(
  db: Database,
  namespace: string,
  rows: CatalogDocumentSeedRow[],
): void {
  assertCatalogDocumentRequest({ op: "seed", namespace, rows });
  const insert = db.query(
    `INSERT OR IGNORE INTO session_kernel_catalog_documents
       (namespace, key, value, rev, request_id, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  );
  const tx = db.transaction(() => {
    const now = Date.now();
    for (const row of rows)
      insert.run(
        namespace,
        row.key,
        row.value,
        CATALOG_DOCUMENT_SEED_REQUEST_ID,
        now,
      );
  });
  tx.immediate();
}

/** True once the importer confirmed every file-backed row for the namespace
 * reached the catalog, so readers may stop consulting the files. */
export function catalogDocumentImportComplete(
  db: Database,
  namespace: string,
): boolean {
  return !!db
    .query("SELECT 1 FROM session_kernel_migrations WHERE name = ?")
    .get(importFlag(namespace));
}

export function markCatalogDocumentImportComplete(
  db: Database,
  namespace: string,
): void {
  db.run(
    "INSERT OR IGNORE INTO session_kernel_migrations (name, completed_at) VALUES (?, ?)",
    [importFlag(namespace), Date.now()],
  );
}
