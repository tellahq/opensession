/**
 * The Databases store: named SQLite files Open Session keeps for sessions
 * and automations, outside every repo.
 *
 *   <root>/<id>.sqlite    the database itself
 *   <root>/<id>.json      sidecar: name, description, provenance, size
 *
 * This class does synchronous SQLite and filesystem work, so it runs on a
 * dedicated Bun Worker (databases-worker.ts) behind the async facade in
 * databases.ts. The gateway thread never constructs it outside tests.
 *
 * Every database gets one writer connection and, on demand, one read-only
 * connection; both are cached and evicted least-recently-used so a few
 * hundred databases do not mean a few hundred open files. Writes run inside
 * a transaction and refresh the sidecar afterwards, so the list a person
 * sees carries the size and table count as of the last write.
 *
 * Journal mode is left at DELETE on purpose: a database is then always one
 * complete file after a commit, which is what makes export a plain copy and
 * delete a plain unlink.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./shared/atomic-write";
import {
  DatabaseSqlError,
  guardSql,
  quoteIdentifier,
} from "./database-sql-guard";

/** Databases an instance may keep. */
export const MAX_DATABASES = 200;
/** One file's ceiling, enforced by SQLite itself through max_page_count. */
export const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const PAGE_SIZE = 4096;
/** Rows one query result may carry back to a caller. */
export const MAX_QUERY_ROWS = 1000;
/** Bytes of JSON one query result may carry back to a caller. */
export const MAX_RESULT_BYTES = 256 * 1024;
/** Rows one insert_rows call may carry. */
export const MAX_INSERT_ROWS = 5000;
/** Rows one CSV export streams. */
export const MAX_EXPORT_ROWS = 100_000;
/** Sessions a sidecar remembers as having touched the database. */
const MAX_SESSION_REFS = 50;
const MAX_OPEN_CONNECTIONS = 16;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 2000;

export interface DatabaseMeta {
  /** Slug of the name plus a short random suffix; the filename stem. */
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  /** Who asked for it: a person's display name or an automation label. */
  createdBy?: string;
  createdBySessionId?: string;
  /** The automation this database belongs to, when one does. An automation
   *  run may only see and touch databases carrying its own id. */
  automationId?: string;
  automationName?: string;
  /** Sessions that created or wrote to it, oldest first, bounded. */
  sessionIds: string[];
  lastSessionId?: string;
  sizeBytes: number;
  tableCount: number;
}

export interface DatabaseColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
}

export interface DatabaseTable {
  name: string;
  /** "table" or "view". */
  kind: "table" | "view";
  rowCount: number;
  columns: DatabaseColumn[];
}

export interface DatabaseSchema {
  tables: DatabaseTable[];
}

/** A cell as it travels to callers. BLOBs are described, not shipped. */
export type DatabaseCell = string | number | null;

export interface QueryResult {
  columns: string[];
  rows: DatabaseCell[][];
  /** True when the result was cut at MAX_QUERY_ROWS or MAX_RESULT_BYTES. */
  truncated: boolean;
}

export interface ExecuteResult {
  changes: number;
  lastInsertRowid: number;
}

export interface RowsPage {
  columns: string[];
  rows: DatabaseCell[][];
  total: number;
  offset: number;
}

export type DatabaseParams =
  | Array<string | number | boolean | null>
  | Record<string, string | number | boolean | null>;

export class DatabaseNotFoundError extends Error {
  constructor(id: string) {
    super(`Database not found: ${id}`);
    this.name = "DatabaseNotFoundError";
  }
}

export class DatabaseLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseLimitError";
  }
}

/** Path-segment guard for ids that travel through URLs and become files. */
export function isDatabaseId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
}

/** Table and column names reach SQL quoted, but a name with a NUL or a
 *  control character is never a real table. */
function isPlainName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

function slug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return base || "database";
}

function cleanName(name: unknown): string {
  const value = String(name ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_NAME);
  if (!value) throw new Error("A database needs a name");
  return value;
}

function cleanDescription(value: unknown): string | undefined {
  const text = String(value ?? "")
    .trim()
    .slice(0, MAX_DESCRIPTION);
  return text || undefined;
}

function toCell(value: unknown): DatabaseCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return `[blob ${value.byteLength} bytes]`;
  return String(value);
}

/**
 * SQLite's own errors (a bad table, a syntax error, a write on the read-only
 * connection) surface as DatabaseSqlError, so callers and the worker facade
 * see one class whether the store is in-process or across a thread.
 */
function sqlErrors<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof Error && error.name === "SQLiteError")
      throw new DatabaseSqlError(error.message);
    throw error;
  }
}

/** Positional params spread as arguments; named params travel as one object. */
function bindings(params: DatabaseParams | undefined): SQLQueryBindings[] {
  if (!params) return [];
  if (Array.isArray(params)) return params as SQLQueryBindings[];
  return [params as unknown as SQLQueryBindings];
}

function hasParams(params: DatabaseParams | undefined): boolean {
  if (!params) return false;
  return Array.isArray(params)
    ? params.length > 0
    : Object.keys(params).length > 0;
}

/** A bound statement's rows, with the caps applied while reading. */
function readRows(
  statement: ReturnType<Database["prepare"]>,
  params: DatabaseParams | undefined,
  limit: number,
): QueryResult {
  const columns = statement.columnNames;
  const rows: DatabaseCell[][] = [];
  let truncated = false;
  let bytes = 0;
  for (const raw of statement.iterate(...(bindings(params) as [])) as Iterable<
    Record<string, unknown>
  >) {
    if (rows.length >= limit) {
      truncated = true;
      break;
    }
    const row = columns.map((column) => toCell(raw[column]));
    bytes += JSON.stringify(row).length + 1;
    if (bytes > MAX_RESULT_BYTES) {
      truncated = true;
      break;
    }
    rows.push(row);
  }
  return { columns, rows, truncated };
}

interface Open {
  writer: Database;
  reader?: Database;
  lastUsed: number;
}

export class DatabasesStore {
  private readonly open = new Map<string, Open>();
  private metas: Map<string, DatabaseMeta> | null = null;
  private tick = 0;

  constructor(readonly root: string) {}

  // ---- files -------------------------------------------------------------

  private dbPath(id: string): string {
    return join(this.root, `${id}.sqlite`);
  }

  private sidecarPath(id: string): string {
    return join(this.root, `${id}.json`);
  }

  private index(): Map<string, DatabaseMeta> {
    if (this.metas) return this.metas;
    const metas = new Map<string, DatabaseMeta>();
    if (existsSync(this.root)) {
      for (const entry of readdirSync(this.root)) {
        if (!entry.endsWith(".json")) continue;
        const id = entry.slice(0, -".json".length);
        if (!isDatabaseId(id) || !existsSync(this.dbPath(id))) continue;
        try {
          const meta = JSON.parse(
            readFileSync(join(this.root, entry), "utf8"),
          ) as DatabaseMeta;
          if (meta && meta.id === id) {
            meta.sessionIds ||= [];
            metas.set(id, meta);
          }
        } catch {}
      }
    }
    this.metas = metas;
    return metas;
  }

  private requireMeta(id: string): DatabaseMeta {
    if (!isDatabaseId(id)) throw new DatabaseNotFoundError(String(id));
    const meta = this.index().get(id);
    if (!meta) throw new DatabaseNotFoundError(id);
    return meta;
  }

  private saveMeta(meta: DatabaseMeta): void {
    this.index().set(meta.id, meta);
    writeJsonAtomic(this.sidecarPath(meta.id), meta);
  }

  // ---- connections -------------------------------------------------------

  private connection(id: string): Open {
    const cached = this.open.get(id);
    if (cached) {
      cached.lastUsed = ++this.tick;
      return cached;
    }
    if (this.open.size >= MAX_OPEN_CONNECTIONS) {
      let oldest: [string, Open] | undefined;
      for (const entry of this.open)
        if (!oldest || entry[1].lastUsed < oldest[1].lastUsed) oldest = entry;
      if (oldest) this.closeConnection(oldest[0]);
    }
    const writer = new Database(this.dbPath(id), { strict: true });
    writer.exec(`PRAGMA page_size = ${PAGE_SIZE}`);
    writer.exec(`PRAGMA max_page_count = ${MAX_DATABASE_BYTES / PAGE_SIZE}`);
    writer.exec("PRAGMA busy_timeout = 5000");
    writer.exec("PRAGMA trusted_schema = OFF");
    writer.exec("PRAGMA foreign_keys = ON");
    const open: Open = { writer, lastUsed: ++this.tick };
    this.open.set(id, open);
    return open;
  }

  private reader(id: string): Database {
    const open = this.connection(id);
    if (!open.reader) {
      open.reader = new Database(this.dbPath(id), {
        readonly: true,
        strict: true,
      });
      open.reader.exec("PRAGMA query_only = ON");
      open.reader.exec("PRAGMA trusted_schema = OFF");
      open.reader.exec("PRAGMA busy_timeout = 5000");
    }
    return open.reader;
  }

  private closeConnection(id: string): void {
    const open = this.open.get(id);
    if (!open) return;
    this.open.delete(id);
    try {
      open.reader?.close();
    } catch {}
    try {
      open.writer.close();
    } catch {}
  }

  close(): void {
    for (const id of [...this.open.keys()]) this.closeConnection(id);
  }

  /** Refresh the sidecar's derived fields after a write. */
  private touch(meta: DatabaseMeta, sessionId?: string): DatabaseMeta {
    const { writer } = this.connection(meta.id);
    const count = writer
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'",
      )
      .get() as { n: number };
    meta.tableCount = count.n;
    try {
      meta.sizeBytes = statSync(this.dbPath(meta.id)).size;
    } catch {}
    meta.updatedAt = new Date().toISOString();
    if (sessionId) {
      meta.lastSessionId = sessionId;
      if (!meta.sessionIds.includes(sessionId)) {
        meta.sessionIds.push(sessionId);
        if (meta.sessionIds.length > MAX_SESSION_REFS)
          meta.sessionIds.splice(0, meta.sessionIds.length - MAX_SESSION_REFS);
      }
    }
    this.saveMeta(meta);
    return meta;
  }

  // ---- lifecycle ---------------------------------------------------------

  create(input: {
    name: string;
    description?: string;
    createdBy?: string;
    sessionId?: string;
    automationId?: string;
    automationName?: string;
    /** Initial DDL, run in one transaction; the database is removed again
     *  when it fails so a typo never leaves an empty file behind. */
    schema?: string;
  }): DatabaseMeta {
    const name = cleanName(input.name);
    const index = this.index();
    if (index.size >= MAX_DATABASES)
      throw new DatabaseLimitError(
        `This instance already keeps ${MAX_DATABASES} databases; delete one first`,
      );
    mkdirSync(this.root, { recursive: true });
    let id = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = `${slug(name)}-${Math.random().toString(16).slice(2, 6)}`;
      if (!index.has(candidate) && !existsSync(this.dbPath(candidate))) {
        id = candidate;
        break;
      }
    }
    if (!id) throw new Error("Could not allocate a database id");
    const now = new Date().toISOString();
    const meta: DatabaseMeta = {
      id,
      name,
      ...(cleanDescription(input.description)
        ? { description: cleanDescription(input.description) }
        : {}),
      createdAt: now,
      updatedAt: now,
      ...(input.createdBy ? { createdBy: input.createdBy.slice(0, 120) } : {}),
      ...(input.sessionId ? { createdBySessionId: input.sessionId } : {}),
      ...(input.automationId
        ? {
            automationId: input.automationId,
            automationName: (input.automationName || "?").slice(0, 120),
          }
        : {}),
      sessionIds: input.sessionId ? [input.sessionId] : [],
      ...(input.sessionId ? { lastSessionId: input.sessionId } : {}),
      sizeBytes: 0,
      tableCount: 0,
    };
    try {
      const { writer } = this.connection(id);
      if (input.schema?.trim()) {
        const sql = guardSql(input.schema);
        writer.exec("BEGIN");
        try {
          sqlErrors(() => writer.exec(sql));
          writer.exec("COMMIT");
        } catch (error) {
          writer.exec("ROLLBACK");
          throw error;
        }
      }
      // The sidecar is written last: its presence makes the database
      // discoverable.
      this.touch(meta, input.sessionId);
    } catch (error) {
      this.closeConnection(id);
      index.delete(id);
      rmSync(this.dbPath(id), { force: true });
      rmSync(this.sidecarPath(id), { force: true });
      throw error;
    }
    return meta;
  }

  list(): DatabaseMeta[] {
    return [...this.index().values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  get(id: string): DatabaseMeta | null {
    if (!isDatabaseId(id)) return null;
    return this.index().get(id) ?? null;
  }

  /** A database by exact name (case-insensitive), or null. */
  findByName(name: string): DatabaseMeta | null {
    const wanted = cleanName(name).toLowerCase();
    for (const meta of this.index().values())
      if (meta.name.toLowerCase() === wanted) return meta;
    return null;
  }

  listForSession(sessionId: string): DatabaseMeta[] {
    return this.list().filter((meta) => meta.sessionIds.includes(sessionId));
  }

  update(
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      automationId?: string | null;
      automationName?: string;
    },
  ): DatabaseMeta {
    const meta = this.requireMeta(id);
    if (patch.name !== undefined) meta.name = cleanName(patch.name);
    if (patch.description !== undefined) {
      const description = cleanDescription(patch.description);
      if (description) meta.description = description;
      else delete meta.description;
    }
    if (patch.automationId !== undefined) {
      if (patch.automationId) {
        meta.automationId = patch.automationId;
        meta.automationName = (patch.automationName || "?").slice(0, 120);
      } else {
        delete meta.automationId;
        delete meta.automationName;
      }
    }
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
    return meta;
  }

  remove(id: string): boolean {
    if (!isDatabaseId(id)) return false;
    const meta = this.index().get(id);
    if (!meta) return false;
    this.closeConnection(id);
    this.index().delete(id);
    rmSync(this.sidecarPath(id), { force: true });
    rmSync(this.dbPath(id), { force: true });
    rmSync(`${this.dbPath(id)}-journal`, { force: true });
    return true;
  }

  // ---- schema ------------------------------------------------------------

  describe(id: string): DatabaseSchema {
    this.requireMeta(id);
    const db = this.reader(id);
    const entries = db
      .prepare(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string; type: "table" | "view" }>;
    const tables: DatabaseTable[] = entries.map((entry) => {
      const columns = (
        db
          .prepare(`PRAGMA table_info(${quoteIdentifier(entry.name)})`)
          .all() as Array<{
          name: string;
          type: string;
          notnull: number;
          pk: number;
          dflt_value: string | null;
        }>
      ).map((column) => ({
        name: column.name,
        type: column.type || "",
        notNull: column.notnull === 1,
        primaryKey: column.pk > 0,
        defaultValue: column.dflt_value,
      }));
      let rowCount = 0;
      try {
        rowCount = (
          db
            .prepare(`SELECT count(*) AS n FROM ${quoteIdentifier(entry.name)}`)
            .get() as { n: number }
        ).n;
      } catch {}
      return { name: entry.name, kind: entry.type, rowCount, columns };
    });
    return { tables };
  }

  private requireTable(id: string, table: string): DatabaseTable {
    if (!isPlainName(table)) throw new DatabaseSqlError("Invalid table name");
    const found = this.describe(id).tables.find(
      (entry) => entry.name === table,
    );
    if (!found) throw new DatabaseSqlError(`No table named ${table}`);
    return found;
  }

  // ---- reads -------------------------------------------------------------

  query(
    id: string,
    sql: string,
    params?: DatabaseParams,
    limit = MAX_QUERY_ROWS,
  ): QueryResult {
    this.requireMeta(id);
    const text = guardSql(sql, { readOnly: true });
    const db = this.reader(id);
    return sqlErrors(() =>
      readRows(
        db.prepare(text),
        params,
        Math.max(1, Math.min(limit, MAX_QUERY_ROWS)),
      ),
    );
  }

  /** One page of a table, ordered server-side. */
  rows(
    id: string,
    table: string,
    options: {
      offset?: number;
      limit?: number;
      sort?: string;
      dir?: "asc" | "desc";
    } = {},
  ): RowsPage {
    const found = this.requireTable(id, table);
    const db = this.reader(id);
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 100), 500));
    const sortColumn = found.columns.find(
      (column) => column.name === options.sort,
    );
    const order = sortColumn
      ? ` ORDER BY ${quoteIdentifier(sortColumn.name)} ${options.dir === "desc" ? "DESC" : "ASC"}`
      : "";
    const page = sqlErrors(() =>
      readRows(
        db.prepare(
          `SELECT * FROM ${quoteIdentifier(table)}${order} LIMIT ${limit} OFFSET ${offset}`,
        ),
        undefined,
        limit,
      ),
    );
    return {
      columns: page.columns,
      rows: page.rows,
      total: found.rowCount,
      offset,
    };
  }

  /** A whole table as CSV text, bounded by MAX_EXPORT_ROWS. */
  exportCsv(id: string, table: string): string {
    this.requireTable(id, table);
    const db = this.reader(id);
    const statement = db.prepare(
      `SELECT * FROM ${quoteIdentifier(table)} LIMIT ${MAX_EXPORT_ROWS}`,
    );
    const columns = statement.columnNames;
    const escape = (cell: DatabaseCell): string => {
      if (cell === null) return "";
      const text = String(cell);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [columns.map(escape).join(",")];
    for (const raw of statement.iterate() as Iterable<Record<string, unknown>>)
      lines.push(
        columns.map((column) => escape(toCell(raw[column]))).join(","),
      );
    return `${lines.join("\r\n")}\r\n`;
  }

  /** Copy the database file for download and return the copy's path. The
   *  caller removes it. A copy, rather than the live file, so a write that
   *  lands mid-download cannot hand out a torn file. */
  exportCopy(id: string, destination: string): string {
    this.requireMeta(id);
    // Close the connections so any journal is folded into the file first.
    this.closeConnection(id);
    copyFileSync(this.dbPath(id), destination);
    return destination;
  }

  // ---- writes ------------------------------------------------------------

  execute(
    id: string,
    sql: string,
    params?: DatabaseParams,
    sessionId?: string,
  ): ExecuteResult {
    const meta = this.requireMeta(id);
    const text = guardSql(sql);
    const { writer } = this.connection(id);
    let result: ExecuteResult = { changes: 0, lastInsertRowid: 0 };
    writer.exec("BEGIN");
    try {
      sqlErrors(() => {
        if (hasParams(params)) {
          const run = writer.prepare(text).run(...(bindings(params) as []));
          result = {
            changes: run.changes,
            lastInsertRowid: Number(run.lastInsertRowid),
          };
        } else {
          // A script: several statements, no parameters. The counters
          // describe its last statement.
          writer.exec(text);
          const counters = writer
            .prepare(
              "SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid",
            )
            .get() as ExecuteResult;
          result = {
            changes: Number(counters.changes),
            lastInsertRowid: Number(counters.lastInsertRowid),
          };
        }
      });
      writer.exec("COMMIT");
    } catch (error) {
      try {
        writer.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    this.touch(meta, sessionId);
    return result;
  }

  /** Bulk insert JSON rows into one table in a single transaction. Keys
   *  that are not columns are refused rather than silently dropped. */
  insertRows(
    id: string,
    table: string,
    rows: Array<Record<string, string | number | boolean | null>>,
    options: { sessionId?: string; replace?: boolean } = {},
  ): { inserted: number } {
    const meta = this.requireMeta(id);
    if (!Array.isArray(rows) || !rows.length)
      throw new DatabaseSqlError("rows must be a non-empty array of objects");
    if (rows.length > MAX_INSERT_ROWS)
      throw new DatabaseLimitError(
        `insert_rows takes at most ${MAX_INSERT_ROWS} rows per call`,
      );
    const found = this.requireTable(id, table);
    const known = new Set(found.columns.map((column) => column.name));
    const columns: string[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new DatabaseSqlError("Every row must be an object");
      for (const key of Object.keys(row)) {
        if (!known.has(key))
          throw new DatabaseSqlError(
            `Unknown column ${key} on ${table}; known columns: ${[...known].join(", ")}`,
          );
        if (!columns.includes(key)) columns.push(key);
      }
    }
    if (!columns.length) throw new DatabaseSqlError("Rows carry no columns");
    const { writer } = this.connection(id);
    const statement = writer.prepare(
      `INSERT ${options.replace ? "OR REPLACE " : ""}INTO ${quoteIdentifier(table)} (${columns
        .map(quoteIdentifier)
        .join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    );
    let inserted = 0;
    writer.exec("BEGIN");
    try {
      for (const row of rows)
        sqlErrors(() => {
          const values = columns.map((column) => {
            const value = row[column];
            if (value === undefined || value === null) return null;
            if (typeof value === "boolean") return value ? 1 : 0;
            return value;
          });
          statement.run(...(values as SQLQueryBindings[]));
          inserted++;
        });
      writer.exec("COMMIT");
    } catch (error) {
      try {
        writer.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    this.touch(meta, options.sessionId);
    return { inserted };
  }
}
