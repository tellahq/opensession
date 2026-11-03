/**
 * Databases values both threads need: limits, metadata and result shapes,
 * the errors callers branch on, and the id guard. Kept apart from the store
 * (databases-sqlite.ts), whose synchronous SQLite and file work runs only on
 * the Databases worker, so the gateway facade (databases.ts) never loads it.
 */

/** Databases an instance may keep. */
export const MAX_DATABASES = 200;
/** One file's ceiling, enforced by SQLite itself through max_page_count. */
export const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
/** Rows one query result may carry back to a caller. */
export const MAX_QUERY_ROWS = 1000;
/** Bytes of JSON one query result may carry back to a caller. */
export const MAX_RESULT_BYTES = 256 * 1024;
/** Rows one insert_rows call may carry. */
export const MAX_INSERT_ROWS = 5000;
/** Rows one CSV export streams. */
export const MAX_EXPORT_ROWS = 100_000;

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
