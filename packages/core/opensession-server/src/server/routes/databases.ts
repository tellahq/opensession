/**
 * Databases routes: the Databases view's list/schema/rows/query surface over
 * the databases store (src/server/databases.ts), plus the few writes a person
 * makes from the view: create an empty one, rename, delete. Filling a
 * database happens through the opensession-databases MCP tools inside runs;
 * the one SQL endpoint here is read-only.
 *
 * Every handler awaits the worker-backed facade, so nothing here opens a
 * SQLite file on the gateway thread.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteContext } from "./context";
import { requestUser } from "./context";
import {
  createDatabase,
  DatabaseLimitError,
  DatabaseNotFoundError,
  DatabaseSqlError,
  databaseRows,
  deleteDatabase,
  describeDatabase,
  exportDatabaseCopy,
  exportDatabaseCsv,
  getDatabase,
  isDatabaseId,
  listDatabases,
  listDatabasesForSession,
  MAX_QUERY_ROWS,
  queryDatabase,
  updateDatabase,
  type DatabaseParams,
} from "../databases";

function statusFor(error: unknown): number | null {
  if (error instanceof DatabaseNotFoundError) return 404;
  if (error instanceof DatabaseSqlError || error instanceof DatabaseLimitError)
    return 400;
  return null;
}

/** Run a handler and turn store errors into JSON error responses. */
async function respond(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    const status = statusFor(error);
    if (status === null) throw error;
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status },
    );
  }
}

function isCell(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** Bound parameters as the store takes them, or undefined when malformed. */
function parseParams(value: unknown): DatabaseParams | undefined | false {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value))
    return value.every(isCell) ? (value as DatabaseParams) : false;
  if (typeof value === "object")
    return Object.values(value as object).every(isCell)
      ? (value as DatabaseParams)
      : false;
  return false;
}

/** A filename for a download, safe for a Content-Disposition header. */
function downloadName(name: string, extension: string): string {
  const stem =
    name
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "database";
  return `${stem}.${extension}`;
}

function attachment(name: string): string {
  return `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** The database file, copied first so a write landing mid-download cannot
 *  hand out a torn file. The copy is removed once the body is done. */
async function exportResponse(id: string, name: string): Promise<Response> {
  const dir = await mkdtemp(join(tmpdir(), "opensession-database-export-"));
  const copy = join(dir, `${id}.sqlite`);
  const cleanup = () =>
    rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    await exportDatabaseCopy(id, copy);
  } catch (error) {
    await cleanup();
    throw error;
  }
  const file = Bun.file(copy);
  const size = file.size;
  const reader = file.stream().getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        void cleanup();
        return;
      }
      controller.enqueue(value);
    },
    cancel() {
      reader.cancel().catch(() => {});
      void cleanup();
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "application/vnd.sqlite3",
      "Content-Length": String(size),
      "Content-Disposition": attachment(downloadName(name, "sqlite")),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function handleDatabasesRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (!path.startsWith("/api/databases")) return undefined;

  if (path === "/api/databases") {
    if (req.method === "GET")
      return Response.json({ databases: await listDatabases() });
    // An empty database from the view, for a person to point a session at.
    if (req.method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        name?: unknown;
        description?: unknown;
        user?: unknown;
      } | null;
      if (typeof body?.name !== "string" || !body.name.trim())
        return Response.json({ error: "A name is required" }, { status: 400 });
      return respond(async () => {
        const database = await createDatabase({
          name: body.name as string,
          description:
            typeof body.description === "string" ? body.description : undefined,
          createdBy: requestUser(ctx, body.user) || undefined,
        });
        return Response.json({ database });
      });
    }
    return undefined;
  }

  // The databases one session created or wrote to, for its Databases tab.
  const sessionMatch = path.match(/^\/api\/databases\/session\/([^/]+)$/);
  if (sessionMatch && req.method === "GET")
    return Response.json({
      databases: await listDatabasesForSession(
        decodeURIComponent(sessionMatch[1]),
      ),
    });

  const idMatch = path.match(/^\/api\/databases\/([^/]+)(\/.*)?$/);
  if (!idMatch) return undefined;
  const id = decodeURIComponent(idMatch[1]);
  const rest = idMatch[2] || "";
  if (!isDatabaseId(id))
    return Response.json({ error: "Database not found" }, { status: 404 });

  if (rest === "") {
    if (req.method === "GET")
      return respond(async () => {
        const database = await getDatabase(id);
        if (!database) throw new DatabaseNotFoundError(id);
        const schema = await describeDatabase(id);
        return Response.json({ database, schema });
      });
    if (req.method === "PATCH") {
      const body = (await req.json().catch(() => null)) as {
        name?: unknown;
        description?: unknown;
      } | null;
      const patch: { name?: string; description?: string | null } = {};
      if (typeof body?.name === "string") patch.name = body.name;
      if (typeof body?.description === "string")
        patch.description = body.description || null;
      if (!Object.keys(patch).length)
        return Response.json({ error: "Nothing to change" }, { status: 400 });
      return respond(async () => {
        return Response.json({ database: await updateDatabase(id, patch) });
      });
    }
    if (req.method === "DELETE")
      return respond(async () => {
        if (!(await deleteDatabase(id))) throw new DatabaseNotFoundError(id);
        return Response.json({ ok: true });
      });
    return undefined;
  }

  if (rest === "/export" && req.method === "GET")
    return respond(async () => {
      const database = await getDatabase(id);
      if (!database) throw new DatabaseNotFoundError(id);
      return exportResponse(id, database.name);
    });

  // Read-only SQL from the view's Query tab. Same screen and read-only
  // connection as the MCP tool, so a write here fails in SQLite itself.
  if (rest === "/query" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as {
      sql?: unknown;
      params?: unknown;
      limit?: unknown;
    } | null;
    if (typeof body?.sql !== "string")
      return Response.json({ error: "sql is required" }, { status: 400 });
    const params = parseParams(body.params);
    if (params === false)
      return Response.json(
        { error: "params must be an array or object of primitive values" },
        { status: 400 },
      );
    const limit =
      typeof body.limit === "number" && Number.isFinite(body.limit)
        ? Math.max(1, Math.min(Math.floor(body.limit), MAX_QUERY_ROWS))
        : undefined;
    return respond(async () =>
      Response.json(await queryDatabase(id, body.sql as string, params, limit)),
    );
  }

  const tableMatch = rest.match(/^\/tables\/([^/]+)\/(rows|export\.csv)$/);
  if (tableMatch && req.method === "GET") {
    const table = decodeURIComponent(tableMatch[1]);
    if (tableMatch[2] === "export.csv")
      return respond(async () => {
        const database = await getDatabase(id);
        if (!database) throw new DatabaseNotFoundError(id);
        const csv = await exportDatabaseCsv(id, table);
        return new Response(csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": attachment(
              downloadName(`${database.name}-${table}`, "csv"),
            ),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      });
    const query = ctx.url.searchParams;
    const offset = Number(query.get("offset") ?? 0);
    const limit = Number(query.get("limit") ?? 100);
    const sort = query.get("sort") || undefined;
    const dir = query.get("dir") === "desc" ? "desc" : "asc";
    return respond(async () =>
      Response.json(
        await databaseRows(id, table, {
          offset: Number.isFinite(offset) ? offset : 0,
          limit: Number.isFinite(limit) ? limit : 100,
          sort,
          dir,
        }),
      ),
    );
  }

  return undefined;
}
