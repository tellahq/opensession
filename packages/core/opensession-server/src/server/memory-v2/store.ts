import { createHash, randomUUID } from "crypto";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import {
  MEMORY_KINDS,
  MEMORY_SOURCE_TYPES,
  MEMORY_STATES,
  MEMORY_TIERS,
  type CreateMemoryInput,
  type MemoryFilters,
  type MemoryKind,
  type MemoryPage,
  type MemoryRecord,
  type MemorySearchOptions,
  type MemorySource,
  type MemoryStats,
  type MemoryState,
  type MemoryTier,
  type PageOptions,
  type RelatedCandidate,
  type UpdateMemoryInput,
} from "./types";

const SUMMARY_MAX_CHARS = 400;
const DETAILS_MAX_BYTES = 20_000;
const TAG_MAX_CHARS = 80;
const TAG_MAX_COUNT = 12;
const MAX_PAGE_SIZE = 100;

export class DuplicateMemoryError extends Error {
  constructor(
    public readonly scopeKey: string,
    public readonly existingId: string,
  ) {
    super(
      `An identical memory already exists in scope "${scopeKey}" (${existingId}).`,
    );
    this.name = "DuplicateMemoryError";
  }
}

export class MemoryNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`No memory record with id "${id}".`);
    this.name = "MemoryNotFoundError";
  }
}

interface RecordRow {
  id: string;
  scope_key: string;
  summary: string;
  details: string | null;
  kind: string;
  tier: string;
  state: string;
  source_json: string;
  created_at: string;
  updated_at: string;
  last_confirmed_at: string | null;
  expires_at: string | null;
  supersedes_json: string;
  superseded_by: string | null;
  fingerprint: string;
  tags_json: string;
  retrieval_count: number;
  last_retrieved_at: string | null;
}

/**
 * Transactional memory store. Construct it from a runtime-owned start/ensure
 * function; importing this module does not open a database or create files.
 */
export class MemoryStore {
  private readonly db: Database;

  constructor(public readonly dbPath: string) {
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 400),
        details TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('preference','constraint','decision','gotcha','reference','status')),
        tier TEXT NOT NULL CHECK(tier IN ('pinned','retrievable')),
        state TEXT NOT NULL CHECK(state IN ('active','expired','superseded','archived')),
        source_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_confirmed_at TEXT,
        expires_at TEXT,
        supersedes_json TEXT NOT NULL DEFAULT '[]',
        superseded_by TEXT,
        fingerprint TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        last_retrieved_at TEXT,
        UNIQUE(scope_key, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_scope_state_created
        ON memory_records(scope_key, state, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_expiry
        ON memory_records(state, expires_at) WHERE expires_at IS NOT NULL;
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED, summary, details, tags,
        tokenize = 'porter unicode61'
      );
      CREATE TABLE IF NOT EXISTS memory_legacy_imports (
        source_key TEXT NOT NULL,
        legacy_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        raw_json TEXT,
        source_present INTEGER NOT NULL DEFAULT 1,
        record_owned INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(source_key, legacy_id),
        FOREIGN KEY(memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    try {
      this.db.exec(
        "ALTER TABLE memory_legacy_imports ADD COLUMN raw_json TEXT;",
      );
    } catch {}
    try {
      this.db.exec(
        "ALTER TABLE memory_legacy_imports ADD COLUMN source_present INTEGER NOT NULL DEFAULT 1;",
      );
    } catch {}
    try {
      this.db.exec(
        "ALTER TABLE memory_legacy_imports ADD COLUMN record_owned INTEGER NOT NULL DEFAULT 0;",
      );
      this.db.exec(
        `UPDATE memory_legacy_imports SET record_owned = 1 WHERE memory_id IN
         (SELECT id FROM memory_records WHERE tags_json LIKE '%"legacy-import"%')`,
      );
    } catch {}
  }

  create(input: CreateMemoryInput, now = new Date()): MemoryRecord {
    const prepared = prepareCreate(input, now);
    return this.insertPrepared(prepared);
  }

  get(id: string): MemoryRecord | null {
    const direct = this.db
      .query("SELECT * FROM memory_records WHERE id = ?")
      .get(id) as RecordRow | null;
    if (direct) return fromRow(direct);
    const row = this.db
      .query(
        `SELECT r.* FROM memory_legacy_imports i
       JOIN memory_records r ON r.id = i.memory_id
       WHERE i.legacy_id = ? ORDER BY i.imported_at DESC LIMIT 1`,
      )
      .get(id) as RecordRow | null;
    return row ? fromRow(row) : null;
  }

  update(id: string, patch: UpdateMemoryInput, now = new Date()): MemoryRecord {
    const current = this.require(id);
    if (current.state !== "active")
      throw new Error("Only active memories can be updated.");
    const recordId = current.id;
    const summary =
      patch.summary === undefined
        ? current.summary
        : validateSummary(patch.summary);
    const details =
      patch.details === undefined
        ? current.details
        : cleanDetails(patch.details);
    const kind =
      patch.kind === undefined
        ? current.kind
        : validateEnum(patch.kind, MEMORY_KINDS, "kind");
    const tier =
      patch.tier === undefined
        ? current.tier
        : validateEnum(patch.tier, MEMORY_TIERS, "tier");
    const source =
      patch.source === undefined
        ? current.source
        : validateSource(patch.source);
    const tags =
      patch.tags === undefined ? current.tags : normalizeTags(patch.tags);
    const expiresAt =
      patch.expiresAt === undefined
        ? current.expiresAt
        : validateOptionalDate(patch.expiresAt);
    validateKindExpiry(kind, expiresAt);
    let state: MemoryState = current.state;
    if (state === "active" || state === "expired") {
      state =
        expiresAt && Date.parse(expiresAt) <= now.getTime()
          ? "expired"
          : "active";
    }
    const fingerprint = memoryFingerprint(summary, details);
    const updatedAt = now.toISOString();
    const tx = this.db.transaction(() => {
      this.throwIfDuplicate(current.scopeKey, fingerprint, recordId);
      this.db.run(
        `UPDATE memory_records SET summary = ?, details = ?, kind = ?, tier = ?, state = ?,
         source_json = ?, updated_at = ?, expires_at = ?, fingerprint = ?, tags_json = ? WHERE id = ?`,
        [
          summary,
          details ?? null,
          kind,
          tier,
          state,
          JSON.stringify(source),
          updatedAt,
          expiresAt ?? null,
          fingerprint,
          JSON.stringify(tags),
          recordId,
        ],
      );
      this.syncFts(recordId, summary, details, tags);
    });
    tx.immediate();
    return this.require(recordId);
  }

  delete(id: string): boolean {
    const record = this.get(id);
    if (!record) return false;
    const tx = this.db.transaction(() => {
      this.db.run("DELETE FROM memory_fts WHERE id = ?", [record.id]);
      return (
        this.db.run("DELETE FROM memory_records WHERE id = ?", [record.id])
          .changes > 0
      );
    });
    return tx.immediate();
  }

  archive(id: string, now = new Date()): MemoryRecord {
    return this.setLifecycleState(id, "archived", now);
  }

  restore(id: string, now = new Date()): MemoryRecord {
    const record = this.require(id);
    if (record.state !== "archived")
      throw new Error("Only archived memories can be restored.");
    const nextState: MemoryState =
      record.expiresAt && Date.parse(record.expiresAt) <= now.getTime()
        ? "expired"
        : "active";
    const tx = this.db.transaction(() => {
      this.db.run(
        "UPDATE memory_records SET state = ?, superseded_by = NULL, updated_at = ? WHERE id = ?",
        [nextState, now.toISOString(), record.id],
      );
    });
    tx.immediate();
    return this.require(record.id);
  }

  confirm(id: string, now = new Date()): MemoryRecord {
    const record = this.require(id);
    if (record.state !== "active")
      throw new Error("Only active memories can be confirmed.");
    const iso = now.toISOString();
    const tx = this.db.transaction(() => {
      this.db.run(
        "UPDATE memory_records SET last_confirmed_at = ?, updated_at = ? WHERE id = ?",
        [iso, iso, record.id],
      );
    });
    tx.immediate();
    return this.require(record.id);
  }

  /** Create the replacement and retire every replaced record atomically. */
  supersede(
    input: CreateMemoryInput & { supersedes: string[] },
    now = new Date(),
  ): MemoryRecord {
    const ids = uniqueStrings(input.supersedes).map(
      (id) => this.require(id).id,
    );
    if (!ids.length)
      throw new Error("supersede requires at least one record id.");
    const prepared = prepareCreate({ ...input, supersedes: ids }, now);
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        const old = this.require(id);
        if (old.scopeKey !== prepared.scopeKey) {
          throw new Error(`Cannot supersede memory "${id}" across scopes.`);
        }
        if (old.state !== "active") {
          throw new Error(`Only active memories can be superseded (${id}).`);
        }
      }
      const replacement = this.insertPreparedUnsafe(prepared);
      for (const id of ids) {
        this.db.run(
          "UPDATE memory_records SET state = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?",
          [replacement.id, prepared.updatedAt, id],
        );
      }
      return replacement;
    });
    try {
      return tx.immediate();
    } catch (error) {
      this.rethrowDuplicate(error, prepared.scopeKey, prepared.fingerprint);
    }
  }

  expireDue(now = new Date()): number {
    const tx = this.db.transaction(
      () =>
        this.db.run(
          `UPDATE memory_records SET state = 'expired', updated_at = ?
       WHERE state = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`,
          [now.toISOString(), now.toISOString()],
        ).changes,
    );
    return tx.immediate();
  }

  list(filters: MemoryFilters = {}, page: PageOptions = {}): MemoryPage {
    const limit = pageLimit(page.limit);
    const cursor = decodeListCursor(page.cursor);
    const where = buildFilterSql(filters);
    if (cursor) {
      where.clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
      where.params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const rows = this.db
      .query(
        `SELECT * FROM memory_records ${where.clauses.length ? `WHERE ${where.clauses.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...where.params, limit + 1) as RecordRow[];
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map(fromRow);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        more && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : undefined,
    };
  }

  search(query: string, options: MemorySearchOptions = {}): MemoryPage {
    const terms = ftsQuery(query, options.matchAny);
    if (!terms) return this.list(options, options);
    const limit = pageLimit(options.limit);
    const offset = decodeSearchCursor(options.cursor);
    const where = buildFilterSql(options, "r");
    const rows = this.db
      .query(
        `SELECT r.*, bm25(memory_fts, 0, 5.0, 1.0, 2.0) AS rank
       FROM memory_fts JOIN memory_records r ON r.id = memory_fts.id
       WHERE memory_fts MATCH ?${where.clauses.length ? ` AND ${where.clauses.join(" AND ")}` : ""}
       ORDER BY rank, r.updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(terms, ...where.params, limit + 1, offset) as Array<
      RecordRow & { rank: number }
    >;
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => {
      const record = fromRow(row);
      if (!options.includeDetails) delete record.details;
      return record;
    });
    return {
      items,
      nextCursor: more ? encodeCursor({ offset: offset + limit }) : undefined,
    };
  }

  /** Cheap lexical candidates for a write-time merge/no-op decision. */
  findRelatedCandidates(
    input: Pick<CreateMemoryInput, "scopeKey" | "summary" | "details" | "tags">,
    limit = 5,
  ): RelatedCandidate[] {
    const query = [input.summary, ...(input.tags ?? [])].join(" ");
    const terms = ftsQuery(query, true);
    if (!terms) return [];
    const fingerprint = memoryFingerprint(
      validateSummary(input.summary),
      cleanDetails(input.details),
    );
    const rows = this.db
      .query(
        `SELECT r.*, bm25(memory_fts, 0, 5.0, 1.0, 2.0) AS rank
       FROM memory_fts JOIN memory_records r ON r.id = memory_fts.id
       WHERE memory_fts MATCH ? AND r.scope_key = ? AND r.state = 'active' AND r.fingerprint != ?
       ORDER BY rank, r.updated_at DESC LIMIT ?`,
      )
      .all(
        terms,
        input.scopeKey,
        fingerprint,
        Math.min(Math.max(limit, 1), 20),
      ) as Array<RecordRow & { rank: number }>;
    return rows.map((row) => ({
      record: fromRow(row),
      score: Math.max(-Number(row.rank), 0),
    }));
  }

  markRetrieved(ids: string[], now = new Date()): number {
    const unique = uniqueStrings(ids);
    if (!unique.length) return 0;
    const placeholders = unique.map(() => "?").join(",");
    const tx = this.db.transaction(
      () =>
        this.db.run(
          `UPDATE memory_records SET retrieval_count = retrieval_count + 1, last_retrieved_at = ?
       WHERE id IN (${placeholders})`,
          [now.toISOString(), ...unique],
        ).changes,
    );
    return tx.immediate();
  }

  /** Small aggregate used by Settings and migration verification. */
  stats(): MemoryStats {
    const rows = this.db
      .query(
        `SELECT scope_key,
              count(*) AS total,
              sum(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active,
              sum(CASE WHEN state = 'active' AND tier = 'pinned' THEN 1 ELSE 0 END) AS pinned,
              sum(CASE WHEN state = 'active' AND last_confirmed_at IS NULL THEN 1 ELSE 0 END) AS review,
              sum(CASE WHEN state = 'active' AND tier = 'pinned' THEN length(summary) ELSE 0 END)
                AS ambient_summary_chars
       FROM memory_records GROUP BY scope_key ORDER BY scope_key`,
      )
      .all() as Array<{
      scope_key: string;
      total: number;
      active: number;
      pinned: number;
      review: number;
      ambient_summary_chars: number;
    }>;
    const scopes = rows.map((row) => ({
      scopeKey: row.scope_key,
      total: Number(row.total),
      active: Number(row.active),
      pinned: Number(row.pinned),
      review: Number(row.review),
      ambientSummaryChars: Number(row.ambient_summary_chars),
    }));
    return scopes.reduce<MemoryStats>(
      (all, scope) => ({
        total: all.total + scope.total,
        active: all.active + scope.active,
        pinned: all.pinned + scope.pinned,
        review: all.review + scope.review,
        ambientSummaryChars:
          all.ambientSummaryChars + scope.ambientSummaryChars,
        scopes: all.scopes,
      }),
      {
        total: 0,
        active: 0,
        pinned: 0,
        review: 0,
        ambientSummaryChars: 0,
        scopes,
      },
    );
  }

  metadata(key: string): string | null {
    const row = this.db
      .query("SELECT value FROM memory_meta WHERE key = ?")
      .get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setMetadata(key: string, value: string, now = new Date()): void {
    this.db.run(
      `INSERT INTO memory_meta(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, now.toISOString()],
    );
  }

  /** Internal migration seam: record old-id mapping in the same transaction. */
  importLegacy(
    sourceKey: string,
    legacyId: string,
    input: CreateMemoryInput,
    state: MemoryState,
    supersededBy?: string,
    rawJson?: string,
    now = new Date(),
  ): { record: MemoryRecord; imported: boolean } {
    const previous = this.db
      .query(
        `SELECT r.* FROM memory_legacy_imports i JOIN memory_records r ON r.id = i.memory_id
       WHERE i.source_key = ? AND i.legacy_id = ?`,
      )
      .get(sourceKey, legacyId) as RecordRow | null;
    if (previous) {
      const currentRaw = this.db
        .query(
          `SELECT raw_json, source_present, record_owned FROM memory_legacy_imports
         WHERE source_key = ? AND legacy_id = ?`,
        )
        .get(sourceKey, legacyId) as {
        raw_json: string | null;
        source_present: number;
        record_owned: number;
      } | null;
      if (
        (!rawJson || currentRaw?.raw_json === rawJson) &&
        currentRaw?.source_present === 1
      ) {
        return { record: fromRow(previous), imported: false };
      }
      if (currentRaw?.record_owned === 0) {
        if (!rawJson || currentRaw.raw_json === rawJson) {
          this.db.run(
            `UPDATE memory_legacy_imports SET source_present = 1
             WHERE source_key = ? AND legacy_id = ?`,
            [sourceKey, legacyId],
          );
          return { record: fromRow(previous), imported: false };
        }
        const prepared = prepareCreate(input, now);
        const tx = this.db.transaction(() => {
          const duplicate = this.findDuplicate(
            prepared.scopeKey,
            prepared.fingerprint,
          );
          const target =
            duplicate ??
            this.insertPreparedUnsafe({ ...prepared, state, supersededBy });
          const recordOwned = duplicate
            ? Number(duplicate.tags.includes("legacy-import"))
            : 1;
          this.db.run(
            `UPDATE memory_legacy_imports SET memory_id = ?, raw_json = ?, source_present = 1,
             record_owned = ? WHERE source_key = ? AND legacy_id = ?`,
            [target.id, rawJson, recordOwned, sourceKey, legacyId],
          );
          return target;
        });
        return { record: tx.immediate(), imported: false };
      }
      const prepared = prepareCreate(input, now);
      const tx = this.db.transaction(() => {
        this.throwIfDuplicate(
          prepared.scopeKey,
          prepared.fingerprint,
          previous.id,
        );
        this.db.run(
          `UPDATE memory_records SET scope_key = ?, summary = ?, details = ?, kind = ?, tier = ?,
           state = ?, source_json = ?, created_at = ?, updated_at = ?, last_confirmed_at = ?,
           expires_at = ?, supersedes_json = ?, superseded_by = ?, fingerprint = ?, tags_json = ?
           WHERE id = ?`,
          [
            prepared.scopeKey,
            prepared.summary,
            prepared.details ?? null,
            prepared.kind,
            prepared.tier,
            state,
            JSON.stringify(prepared.source),
            prepared.createdAt,
            prepared.updatedAt,
            prepared.lastConfirmedAt ?? null,
            prepared.expiresAt ?? null,
            JSON.stringify(prepared.supersedes),
            supersededBy ?? null,
            prepared.fingerprint,
            JSON.stringify(prepared.tags),
            previous.id,
          ],
        );
        this.syncFts(
          previous.id,
          prepared.summary,
          prepared.details,
          prepared.tags,
        );
        this.db.run(
          `UPDATE memory_legacy_imports SET raw_json = ?, source_present = 1
           WHERE source_key = ? AND legacy_id = ?`,
          [rawJson ?? null, sourceKey, legacyId],
        );
      });
      tx.immediate();
      return { record: this.require(previous.id), imported: false };
    }

    const prepared = prepareCreate(input, now);
    const tx = this.db.transaction(() => {
      const mapped = this.db
        .query(
          "SELECT memory_id FROM memory_legacy_imports WHERE source_key = ? AND legacy_id = ?",
        )
        .get(sourceKey, legacyId) as { memory_id: string } | null;
      if (mapped)
        return { record: this.require(mapped.memory_id), imported: false };

      let record: MemoryRecord;
      let recordOwned: number;
      const duplicate = this.findDuplicate(
        prepared.scopeKey,
        prepared.fingerprint,
      );
      if (duplicate) {
        record = duplicate;
        recordOwned = 0;
      } else {
        record = this.insertPreparedUnsafe({
          ...prepared,
          state,
          supersededBy,
        });
        recordOwned = 1;
      }
      this.db.run(
        `INSERT INTO memory_legacy_imports
         (source_key, legacy_id, memory_id, imported_at, raw_json, record_owned)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          sourceKey,
          legacyId,
          record.id,
          now.toISOString(),
          rawJson ?? null,
          recordOwned,
        ],
      );
      return { record, imported: true };
    });
    return tx.immediate();
  }

  legacyMapping(sourceKey: string, legacyId: string): string | null {
    const row = this.db
      .query(
        "SELECT memory_id FROM memory_legacy_imports WHERE source_key = ? AND legacy_id = ?",
      )
      .get(sourceKey, legacyId) as { memory_id: string } | null;
    return row?.memory_id ?? null;
  }

  /** Mark mappings removed from a successfully-read legacy source as absent.
   * The alias and raw payload remain available for rollback diagnostics. */
  reconcileLegacySource(
    sourceKey: string,
    presentLegacyIds: Set<string>,
    now = new Date(),
  ): number {
    const mappings = this.db
      .query(
        "SELECT legacy_id, memory_id FROM memory_legacy_imports WHERE source_key = ?",
      )
      .all(sourceKey) as Array<{ legacy_id: string; memory_id: string }>;
    const removed = mappings.filter(
      (mapping) => !presentLegacyIds.has(mapping.legacy_id),
    );
    if (removed.length === 0) return 0;
    const tx = this.db.transaction(() => {
      for (const mapping of removed) {
        this.db.run(
          "UPDATE memory_legacy_imports SET source_present = 0 WHERE source_key = ? AND legacy_id = ?",
          [sourceKey, mapping.legacy_id],
        );
        const stillPresent = this.db
          .query(
            "SELECT 1 FROM memory_legacy_imports WHERE memory_id = ? AND source_present = 1 LIMIT 1",
          )
          .get(mapping.memory_id);
        const importOwned = this.db
          .query(
            "SELECT 1 FROM memory_legacy_imports WHERE memory_id = ? AND record_owned = 1 LIMIT 1",
          )
          .get(mapping.memory_id);
        if (!stillPresent && importOwned) {
          this.db.run(
            "UPDATE memory_records SET state = 'archived', updated_at = ? WHERE id = ?",
            [now.toISOString(), mapping.memory_id],
          );
        }
      }
    });
    tx.immediate();
    return removed.length;
  }

  legacyRaw(legacyId: string): string | null {
    const row = this.db
      .query(
        `SELECT raw_json FROM memory_legacy_imports
       WHERE legacy_id = ? AND raw_json IS NOT NULL
       ORDER BY imported_at DESC LIMIT 1`,
      )
      .get(legacyId) as { raw_json: string } | null;
    return row?.raw_json ?? null;
  }

  /** Resolve legacy graph links after every row has an id mapping. */
  setLegacyRelations(
    id: string,
    supersedes: string[],
    supersededBy?: string,
  ): MemoryRecord {
    this.require(id);
    const tx = this.db.transaction(() => {
      this.db.run(
        `UPDATE memory_records SET supersedes_json = ?, superseded_by = ? WHERE id = ?`,
        [JSON.stringify(uniqueStrings(supersedes)), supersededBy ?? null, id],
      );
    });
    tx.immediate();
    return this.require(id);
  }

  close(): void {
    this.db.close();
  }

  private require(id: string): MemoryRecord {
    const record = this.get(id);
    if (!record) throw new MemoryNotFoundError(id);
    return record;
  }

  private setLifecycleState(
    id: string,
    state: MemoryState,
    now: Date,
  ): MemoryRecord {
    const record = this.require(id);
    if (
      state === "archived" &&
      record.state !== "active" &&
      record.state !== "expired"
    ) {
      throw new Error("Only active or expired memories can be archived.");
    }
    const tx = this.db.transaction(() => {
      this.db.run(
        "UPDATE memory_records SET state = ?, updated_at = ? WHERE id = ?",
        [state, now.toISOString(), record.id],
      );
    });
    tx.immediate();
    return this.require(record.id);
  }

  private insertPrepared(record: MemoryRecord): MemoryRecord {
    const tx = this.db.transaction(() => this.insertPreparedUnsafe(record));
    try {
      return tx.immediate();
    } catch (error) {
      this.rethrowDuplicate(error, record.scopeKey, record.fingerprint);
    }
  }

  private insertPreparedUnsafe(record: MemoryRecord): MemoryRecord {
    this.throwIfDuplicate(record.scopeKey, record.fingerprint);
    this.db.run(
      `INSERT INTO memory_records
       (id, scope_key, summary, details, kind, tier, state, source_json, created_at, updated_at,
        last_confirmed_at, expires_at, supersedes_json, superseded_by, fingerprint, tags_json,
        retrieval_count, last_retrieved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.scopeKey,
        record.summary,
        record.details ?? null,
        record.kind,
        record.tier,
        record.state,
        JSON.stringify(record.source),
        record.createdAt,
        record.updatedAt,
        record.lastConfirmedAt ?? null,
        record.expiresAt ?? null,
        JSON.stringify(record.supersedes),
        record.supersededBy ?? null,
        record.fingerprint,
        JSON.stringify(record.tags),
        record.retrievalCount,
        record.lastRetrievedAt ?? null,
      ],
    );
    this.syncFts(record.id, record.summary, record.details, record.tags);
    return record;
  }

  private syncFts(
    id: string,
    summary: string,
    details: string | undefined,
    tags: string[],
  ): void {
    this.db.run("DELETE FROM memory_fts WHERE id = ?", [id]);
    this.db.run(
      "INSERT INTO memory_fts(id, summary, details, tags) VALUES (?, ?, ?, ?)",
      [id, summary, details ?? "", tags.join(" ")],
    );
  }

  private findDuplicate(
    scopeKey: string,
    fingerprint: string,
    exceptId?: string,
  ): MemoryRecord | null {
    const row = this.db
      .query(
        `SELECT * FROM memory_records WHERE scope_key = ? AND fingerprint = ?${exceptId ? " AND id != ?" : ""}`,
      )
      .get(
        ...(exceptId
          ? [scopeKey, fingerprint, exceptId]
          : [scopeKey, fingerprint]),
      ) as RecordRow | null;
    return row ? fromRow(row) : null;
  }

  private throwIfDuplicate(
    scopeKey: string,
    fingerprint: string,
    exceptId?: string,
  ): void {
    const duplicate = this.findDuplicate(scopeKey, fingerprint, exceptId);
    if (duplicate) throw new DuplicateMemoryError(scopeKey, duplicate.id);
  }

  private rethrowDuplicate(
    error: unknown,
    scopeKey: string,
    fingerprint: string,
  ): never {
    if (error instanceof DuplicateMemoryError) throw error;
    const duplicate = this.findDuplicate(scopeKey, fingerprint);
    if (duplicate) throw new DuplicateMemoryError(scopeKey, duplicate.id);
    throw error;
  }
}

function prepareCreate(input: CreateMemoryInput, now: Date): MemoryRecord {
  const scopeKey = input.scopeKey.trim();
  if (!scopeKey) throw new Error("scopeKey is required.");
  const summary = validateSummary(input.summary);
  const details = cleanDetails(input.details);
  const createdAt = validateDate(
    input.createdAt ?? now.toISOString(),
    "createdAt",
  );
  const expiresAt = validateOptionalDate(input.expiresAt);
  const kind = validateEnum(input.kind, MEMORY_KINDS, "kind");
  validateKindExpiry(kind, expiresAt);
  const state: MemoryState =
    expiresAt && Date.parse(expiresAt) <= now.getTime() ? "expired" : "active";
  return {
    id: input.id?.trim() || randomUUID(),
    scopeKey,
    summary,
    details,
    kind,
    tier: validateEnum(input.tier, MEMORY_TIERS, "tier"),
    state,
    source: validateSource(input.source),
    createdAt,
    updatedAt: validateDate(
      input.updatedAt ?? input.createdAt ?? now.toISOString(),
      "updatedAt",
    ),
    lastConfirmedAt: validateOptionalDate(input.lastConfirmedAt),
    expiresAt,
    supersedes: uniqueStrings(input.supersedes ?? []),
    fingerprint: memoryFingerprint(summary, details),
    tags: normalizeTags(input.tags ?? []),
    retrievalCount: 0,
  };
}

export function memoryFingerprint(summary: string, details?: string): string {
  const normalized = `${normalizeForFingerprint(summary)}\0${normalizeForFingerprint(details ?? "")}`;
  return createHash("sha256").update(normalized).digest("hex");
}

function normalizeForFingerprint(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

function validateSummary(summary: string): string {
  const clean = summary.trim().replace(/\s+/g, " ");
  const length = Array.from(clean).length;
  if (!length) throw new Error("summary is required.");
  if (length > SUMMARY_MAX_CHARS)
    throw new Error(
      `summary must be ${SUMMARY_MAX_CHARS} characters or fewer.`,
    );
  const sentences = clean
    .split(/[.!?]+(?:\s+|$)/)
    .filter((part) => part.trim()).length;
  if (sentences > 2) throw new Error("summary must be one or two sentences.");
  return clean;
}

function cleanOptional(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  const clean = value.trim();
  return clean || undefined;
}

/** Details may be source evidence, so retain its bytes while rejecting blank-only values. */
function cleanDetails(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  if (!value.trim()) return undefined;
  if (Buffer.byteLength(value, "utf8") > DETAILS_MAX_BYTES) {
    throw new Error(`details must be ${DETAILS_MAX_BYTES} bytes or fewer.`);
  }
  return value;
}

function validateSource(source: MemorySource): MemorySource {
  const type = validateEnum(source.type, MEMORY_SOURCE_TYPES, "source.type");
  return {
    type,
    ...(cleanOptional(source.sessionId)
      ? { sessionId: cleanOptional(source.sessionId) }
      : {}),
    ...(cleanOptional(source.turnId)
      ? { turnId: cleanOptional(source.turnId) }
      : {}),
    ...(cleanOptional(source.repoPath)
      ? { repoPath: cleanOptional(source.repoPath) }
      : {}),
    ...(cleanOptional(source.actor)
      ? { actor: cleanOptional(source.actor)?.slice(0, 200) }
      : {}),
    ...(cleanOptional(source.channelId)
      ? { channelId: cleanOptional(source.channelId)?.slice(0, 200) }
      : {}),
  };
}

function validateEnum<T extends string>(
  value: T,
  values: readonly T[],
  label: string,
): T {
  if (!values.includes(value))
    throw new Error(`Invalid ${label}: ${String(value)}.`);
  return value;
}

function validateDate(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value)))
    throw new Error(`${label} must be a valid ISO date.`);
  return new Date(value).toISOString();
}

function validateOptionalDate(
  value: string | null | undefined,
): string | undefined {
  return value == null || value === ""
    ? undefined
    : validateDate(value, "date");
}

function validateKindExpiry(
  kind: MemoryKind,
  expiresAt: string | undefined,
): void {
  if (kind === "status" && !expiresAt)
    throw new Error("status memories require expiresAt.");
}

function normalizeTags(tags: string[]): string[] {
  if (tags.length > TAG_MAX_COUNT)
    throw new Error(`tags must contain ${TAG_MAX_COUNT} items or fewer.`);
  const normalized = uniqueStrings(
    tags.map((tag) => tag.trim().toLocaleLowerCase("en-US")).filter(Boolean),
  );
  if (normalized.some((tag) => Array.from(tag).length > TAG_MAX_CHARS)) {
    throw new Error(`tags must be ${TAG_MAX_CHARS} characters or fewer.`);
  }
  return normalized;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function fromRow(row: RecordRow): MemoryRecord {
  return {
    id: row.id,
    scopeKey: row.scope_key,
    summary: row.summary,
    details: row.details ?? undefined,
    kind: row.kind as MemoryKind,
    tier: row.tier as MemoryTier,
    state: row.state as MemoryState,
    source: JSON.parse(row.source_json) as MemorySource,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastConfirmedAt: row.last_confirmed_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    supersedes: JSON.parse(row.supersedes_json) as string[],
    supersededBy: row.superseded_by ?? undefined,
    fingerprint: row.fingerprint,
    tags: JSON.parse(row.tags_json) as string[],
    retrievalCount: Number(row.retrieval_count),
    lastRetrievedAt: row.last_retrieved_at ?? undefined,
  };
}

function buildFilterSql(
  filters: MemoryFilters,
  alias?: string,
): { clauses: string[]; params: Array<string | number> } {
  const prefix = alias ? `${alias}.` : "";
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  const addIn = (column: string, values: string[] | undefined) => {
    if (!values?.length) return;
    clauses.push(`${prefix}${column} IN (${values.map(() => "?").join(",")})`);
    params.push(...values);
  };
  addIn("scope_key", filters.scopeKeys);
  addIn("kind", filters.kinds);
  addIn("tier", filters.tiers);
  addIn("state", filters.states ?? ["active"]);
  if (filters.confirmed !== undefined) {
    clauses.push(
      `${prefix}last_confirmed_at IS ${filters.confirmed ? "NOT " : ""}NULL`,
    );
  }
  if (filters.tags?.length) {
    for (const tag of normalizeTags(filters.tags)) {
      clauses.push(
        `EXISTS (SELECT 1 FROM json_each(${prefix}tags_json) WHERE value = ?)`,
      );
      params.push(tag);
    }
  }
  return { clauses, params };
}

function pageLimit(limit?: number): number {
  return Math.min(Math.max(limit ?? 25, 1), MAX_PAGE_SIZE);
}

function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(value?: string): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid memory page cursor.");
  }
}

function decodeListCursor(
  value?: string,
): { createdAt: string; id: string } | undefined {
  const decoded = decodeCursor(value) as
    | { createdAt?: unknown; id?: unknown }
    | undefined;
  if (!decoded) return undefined;
  if (typeof decoded.createdAt !== "string" || typeof decoded.id !== "string") {
    throw new Error("Invalid memory list cursor.");
  }
  return { createdAt: decoded.createdAt, id: decoded.id };
}

function decodeSearchCursor(value?: string): number {
  const decoded = decodeCursor(value) as { offset?: unknown } | undefined;
  if (!decoded) return 0;
  if (!Number.isInteger(decoded.offset) || Number(decoded.offset) < 0) {
    throw new Error("Invalid memory search cursor.");
  }
  return Number(decoded.offset);
}

/** Quote plain user terms before sending them to FTS5. */
export function ftsQuery(query: string, anyTerm = false): string {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/"/g, "").trim())
    .filter(Boolean)
    .slice(0, 32)
    .map((term) => `"${term}"`);
  return terms.join(anyTerm ? " OR " : " ");
}
