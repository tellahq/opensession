import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { parseAccessScope } from "../../shared/access-scope";
import { accessOwnerSql } from "../access-scope-sql";

export type ScopeFence = { incarnation: string; generation: number };
export type ScopeLedgerRow = {
  id: string;
  canonicalId: string;
  owner: number;
  deleted: boolean;
  generation: number;
};
export type ScopeDelta = { fence: ScopeFence; rows: ScopeLedgerRow[] };
export const SCOPE_DELTA_LIMIT = 1000;

export function migrateAccessLedgerSchema36(
  db: Database,
  version: number,
): void {
  if (version >= 36) return;
  db.transaction(() => {
    db.exec(`CREATE TABLE session_kernel_access_clock (id INTEGER PRIMARY KEY CHECK(id=1), incarnation TEXT NOT NULL, generation INTEGER NOT NULL) STRICT;
      CREATE TABLE session_kernel_access_scope (id TEXT PRIMARY KEY, canonical_id TEXT NOT NULL, owner INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL) STRICT;
      CREATE INDEX idx_access_scope_generation ON session_kernel_access_scope(generation);
      CREATE INDEX idx_access_scope_canonical ON session_kernel_access_scope(canonical_id, id);`);
    db.run("INSERT INTO session_kernel_access_clock VALUES (1, ?, 0)", [
      randomUUID(),
    ]);
    db.exec(`INSERT INTO session_kernel_access_scope(id, canonical_id, owner, deleted, generation)
      SELECT session_id, session_id, ${accessOwnerSql("doc")}, 0, row_number() OVER (ORDER BY session_id)
      FROM session_kernel_metadata_catalog;
      UPDATE session_kernel_access_clock SET generation = (SELECT coalesce(max(generation),0) FROM session_kernel_access_scope);
      PRAGMA user_version = 36;`);
    if (
      db
        .query(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_kernel_tombstones'",
        )
        .get()
    ) {
      const base = scopeFence(db).generation;
      db.run(
        `INSERT INTO session_kernel_access_scope(id, canonical_id, owner, deleted, generation)
        SELECT session_id, session_id, -1, 1, ? + row_number() OVER (ORDER BY session_id) FROM session_kernel_tombstones WHERE true
        ON CONFLICT(id) DO UPDATE SET deleted=1, generation=excluded.generation`,
        [base],
      );
      db.exec(
        "UPDATE session_kernel_access_clock SET generation=(SELECT coalesce(max(generation),0) FROM session_kernel_access_scope)",
      );
    }
  }).immediate();
}

export function scopeFence(db: Database): ScopeFence {
  return db
    .query(
      "SELECT incarnation, generation FROM session_kernel_access_clock WHERE id=1",
    )
    .get() as ScopeFence;
}
export function scopeRecord(db: Database, id: string): ScopeLedgerRow | null {
  const row = db
    .query(
      "SELECT id, canonical_id AS canonicalId, owner, deleted, generation FROM session_kernel_access_scope WHERE id=?",
    )
    .get(id) as (Omit<ScopeLedgerRow, "deleted"> & { deleted: number }) | null;
  return row ? { ...row, deleted: !!row.deleted } : null;
}
function storeScope(
  db: Database,
  row: Omit<ScopeLedgerRow, "generation">,
): void {
  db.run(
    "UPDATE session_kernel_access_clock SET generation=generation+1 WHERE id=1",
  );
  db.run(
    `INSERT INTO session_kernel_access_scope VALUES (?, ?, ?, ?, (SELECT generation FROM session_kernel_access_clock WHERE id=1))
    ON CONFLICT(id) DO UPDATE SET canonical_id=excluded.canonical_id, owner=excluded.owner, deleted=excluded.deleted, generation=excluded.generation`,
    [row.id, row.canonicalId, row.owner, row.deleted ? 1 : 0],
  );
}
export function scopeChanges(
  db: Database,
  after: number,
  limit: number,
): ScopeDelta {
  return db.transaction(() => {
    const rows = db
      .query(
        "SELECT id, canonical_id AS canonicalId, owner, deleted, generation FROM session_kernel_access_scope WHERE generation>? ORDER BY generation LIMIT ?",
      )
      .all(after, limit) as Array<
      Omit<ScopeLedgerRow, "deleted"> & { deleted: number }
    >;
    return {
      fence: scopeFence(db),
      rows: rows.map((row) => ({ ...row, deleted: !!row.deleted })),
    };
  })();
}
export function documentOwner(doc: string): number {
  try {
    const data = JSON.parse(doc);
    if (!data || typeof data !== "object" || Array.isArray(data)) return -1;
    const scope = parseAccessScope(data.accessScope);
    return scope?.kind === "shared"
      ? 0
      : scope?.kind === "personal"
        ? scope.ownerGithubAccountId
        : -1;
  } catch {
    return -1;
  }
}
/** Ownership survives document removal, including legacy export recovery. */
export function assertLedgerScope(db: Database, id: string, doc: string): void {
  const current = scopeRecord(db, id);
  if (current?.deleted) throw new Error("Session not found");
  if (current && current.owner !== documentOwner(doc))
    throw new Error("Session access scope is immutable");
}
export function claimScope(db: Database, id: string, doc: string): void {
  assertLedgerScope(db, id, doc);
  if (!scopeRecord(db, id))
    storeScope(db, {
      id,
      canonicalId: id,
      owner: documentOwner(doc),
      deleted: false,
    });
}
export function tombstoneScope(db: Database, id: string): void {
  const current = scopeRecord(db, id);
  if (current?.deleted) return;
  if (current && current.canonicalId !== id) {
    storeScope(db, { ...current, deleted: true });
    return;
  }
  const canonicalId = current?.canonicalId ?? id;
  const aliases = db
    .query(
      "SELECT id FROM session_kernel_access_scope WHERE canonical_id=? AND deleted=0",
    )
    .all(canonicalId) as Array<{ id: string }>;
  for (const alias of aliases) {
    const row = scopeRecord(db, alias.id)!;
    storeScope(db, { ...row, deleted: true });
  }
  if (!current)
    storeScope(db, { id, canonicalId: id, owner: 0, deleted: true });
}
export function registerScopeAliases(
  db: Database,
  rows: Array<{ id: string; aliases: string[] }>,
): void {
  db.transaction(() => {
    for (const { id, aliases } of rows) {
      let canonical = scopeRecord(db, id);
      if (canonical?.deleted || (canonical && canonical.canonicalId !== id))
        throw new Error("Session not found");
      if (!canonical) {
        claimScope(db, id, "{}");
        canonical = scopeRecord(db, id)!;
      }
      for (const alias of aliases) {
        if (alias === id) continue;
        const previous = scopeRecord(db, alias);
        if (
          previous &&
          (previous.deleted ||
            previous.owner !== canonical.owner ||
            (previous.canonicalId !== id && previous.canonicalId !== alias))
        )
          throw new Error("Session alias ownership conflict");
        if (previous?.canonicalId === id) continue;
        if (previous) {
          // Rehoming a former canonical id moves its complete flattened group,
          // including historical tombstones. Never orphan an engine alias.
          const group = db
            .query(
              "SELECT id FROM session_kernel_access_scope WHERE canonical_id=? ORDER BY id",
            )
            .all(alias) as Array<{ id: string }>;
          for (const member of group) {
            const owned = scopeRecord(db, member.id)!;
            if (owned.id === id || owned.owner !== canonical.owner)
              throw new Error("Session alias ownership conflict");
            storeScope(db, { ...owned, canonicalId: id });
          }
        } else {
          storeScope(db, {
            id: alias,
            canonicalId: id,
            owner: canonical.owner,
            deleted: false,
          });
        }
      }
    }
  }).immediate();
}
