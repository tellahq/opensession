import { BASE, request } from "./request";
import type {
  DatabaseCell,
  DatabaseMeta,
  DatabaseQueryResult,
  DatabaseRowsPage,
  DatabaseSchema,
} from "../types";

export async function fetchDatabases(): Promise<DatabaseMeta[]> {
  const result = await request<{ databases: DatabaseMeta[] }>("/databases", {
    label: "Failed to load databases",
  });
  return result.databases;
}

export async function fetchSessionDatabases(
  sessionId: string,
): Promise<DatabaseMeta[]> {
  const result = await request<{ databases: DatabaseMeta[] }>(
    `/databases/session/${encodeURIComponent(sessionId)}`,
    { label: "Failed to load session databases" },
  );
  return result.databases;
}

export async function fetchDatabase(
  id: string,
): Promise<{ database: DatabaseMeta; schema: DatabaseSchema }> {
  return request(`/databases/${encodeURIComponent(id)}`, {
    label: "Failed to load database",
  });
}

export async function createDatabaseApi(input: {
  name: string;
  description?: string;
}): Promise<DatabaseMeta> {
  const result = await request<{ database: DatabaseMeta }>("/databases", {
    method: "POST",
    body: input,
    label: "Failed to create database",
  });
  return result.database;
}

export async function updateDatabaseApi(
  id: string,
  patch: { name?: string; description?: string },
): Promise<DatabaseMeta> {
  const result = await request<{ database: DatabaseMeta }>(
    `/databases/${encodeURIComponent(id)}`,
    { method: "PATCH", body: patch, label: "Failed to update database" },
  );
  return result.database;
}

export async function deleteDatabaseApi(id: string): Promise<void> {
  await request(`/databases/${encodeURIComponent(id)}`, {
    method: "DELETE",
    label: "Failed to delete database",
  });
}

export async function fetchDatabaseRows(
  id: string,
  table: string,
  options: {
    offset?: number;
    limit?: number;
    sort?: string;
    dir?: "asc" | "desc";
  } = {},
): Promise<DatabaseRowsPage> {
  const query = new URLSearchParams();
  if (options.offset) query.set("offset", String(options.offset));
  if (options.limit) query.set("limit", String(options.limit));
  if (options.sort) {
    query.set("sort", options.sort);
    query.set("dir", options.dir === "desc" ? "desc" : "asc");
  }
  const suffix = query.size ? `?${query}` : "";
  return request(
    `/databases/${encodeURIComponent(id)}/tables/${encodeURIComponent(table)}/rows${suffix}`,
    { label: "Failed to load rows" },
  );
}

/** Read-only SQL from the Query tab. A store error comes back as a 400 whose
 *  message is SQLite's own, which is what the person wants to read. */
export async function queryDatabaseApi(
  id: string,
  sql: string,
  params?: DatabaseCell[] | Record<string, DatabaseCell>,
): Promise<DatabaseQueryResult> {
  // The server treats absent and null params alike, so null travels rather
  // than an omitted key.
  return request(`/databases/${encodeURIComponent(id)}/query`, {
    method: "POST",
    body: { sql, params: params ?? null },
    label: "Query failed",
  });
}

/** The whole database as a download. */
export function databaseExportUrl(id: string): string {
  return `${BASE}/databases/${encodeURIComponent(id)}/export`;
}

/** One table as CSV. */
export function databaseTableCsvUrl(id: string, table: string): string {
  return `${BASE}/databases/${encodeURIComponent(id)}/tables/${encodeURIComponent(table)}/export.csv`;
}
