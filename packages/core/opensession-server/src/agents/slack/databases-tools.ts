/**
 * opensession-databases: named SQLite databases Open Session keeps outside
 * every repo (src/server/databases.ts). A session creates one, fills it,
 * queries it in a later turn or a later session, and people browse it in the
 * Databases view. Reports is the sibling: a report is a document a run
 * publishes once, a database is a thing a run keeps coming back to.
 *
 * Wired into interactive runs (interactive-mcp.ts) with every database in
 * reach, and into EVERY automation run (automations.ts) scoped the way
 * opensession-report is: a run only ever sees databases carrying its own
 * automation id, and the ones it creates are tagged with it. That is what
 * keeps this at the automation bar. Untrusted ticket text can fill or drop
 * the automation's own tables and nothing else: no other automation's data,
 * no session control, no configuration.
 *
 * Every statement is screened (database-sql-guard.ts) and runs on the
 * databases worker, never on the gateway thread.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import {
  createDatabase,
  deleteDatabase,
  describeDatabase,
  executeDatabase,
  findDatabaseByName,
  getDatabase,
  insertDatabaseRows,
  isDatabaseId,
  listDatabases,
  MAX_INSERT_ROWS,
  MAX_QUERY_ROWS,
  queryDatabase,
  updateDatabase,
  type DatabaseMeta,
} from "../../server/databases";

export interface DatabasesToolContext {
  sessionId?: string;
  /** Who is driving; stamped on databases this run creates. */
  user?: string;
  /** Automation scope. Set for automation runs: only databases carrying
   *  this id are visible, and new ones are tagged with it. */
  automation?: { id: string; name: string };
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Where a person sees it. Root-relative, like the links the app itself uses. */
function viewPath(meta: DatabaseMeta): string {
  return `/databases/${encodeURIComponent(meta.id)}`;
}

function describeMeta(meta: DatabaseMeta): string {
  const tables = `${meta.tableCount} table${meta.tableCount === 1 ? "" : "s"}`;
  return `${meta.name} (id ${meta.id}): ${tables}, ${fmtSize(meta.sizeBytes)}, updated ${meta.updatedAt}${
    meta.description ? `. ${meta.description}` : ""
  }`;
}

const CELL = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const PARAMS = z
  .union([z.array(CELL), z.record(z.string(), CELL)])
  .optional()
  .describe(
    "Bound values: an array for ? placeholders, or an object for $name placeholders. Bind values instead of interpolating them into the SQL.",
  );
const DATABASE = z
  .string()
  .describe("The database's id or exact name, as list_databases reports it.");

export function createDatabasesMcpServer(ctx: DatabasesToolContext) {
  const inScope = (meta: DatabaseMeta | null): meta is DatabaseMeta =>
    !!meta && (!ctx.automation || meta.automationId === ctx.automation.id);

  const visible = async (): Promise<DatabaseMeta[]> =>
    (await listDatabases()).filter(inScope);

  /** A database by id or name, within this run's scope, or an error that
   *  says what exists. */
  const resolve = async (ref: string): Promise<DatabaseMeta> => {
    const key = (ref || "").trim();
    let meta = isDatabaseId(key) ? await getDatabase(key) : null;
    if (!inScope(meta)) meta = await findDatabaseByName(key);
    if (inScope(meta)) return meta;
    const names = (await visible()).map(
      (entry) => `${entry.name} (${entry.id})`,
    );
    throw new Error(
      names.length
        ? `No database "${key}". Available: ${names.join(", ")}`
        : `No database "${key}", and none exist yet. Create one with create_database.`,
    );
  };

  const scopeNote = ctx.automation
    ? ` Databases belong to the automation "${ctx.automation.name}"; other automations' databases are not visible here.`
    : "";

  const tools = [
    tool(
      "create_database",
      `Create a named SQLite database that Open Session keeps outside every repo, for data this or a later session will query again: collected metrics, scraped rows, triage state, anything tabular that should outlive the session. It appears in the Databases view. Pass schema to create the tables in the same call.${scopeNote}`,
      {
        name: z
          .string()
          .describe(
            'Human name, unique is best, e.g. "Support tickets" or "Nightly latency".',
          ),
        description: z
          .string()
          .optional()
          .describe(
            "One or two sentences on what the data is and where it comes from.",
          ),
        schema: z
          .string()
          .optional()
          .describe(
            "Initial DDL, one or more CREATE statements, run in one transaction. A failure creates nothing.",
          ),
      },
      async (args: { name: string; description?: string; schema?: string }) => {
        try {
          const existing = await findDatabaseByName(args.name);
          if (inScope(existing))
            return text(
              `A database named "${existing.name}" already exists (id ${existing.id}). Use it, or pick another name.`,
            );
          const meta = await createDatabase({
            name: args.name,
            description: args.description,
            schema: args.schema,
            createdBy: ctx.automation
              ? `${ctx.automation.name} (automation)`
              : ctx.user,
            sessionId: ctx.sessionId,
            ...(ctx.automation
              ? {
                  automationId: ctx.automation.id,
                  automationName: ctx.automation.name,
                }
              : {}),
          });
          return text(
            `Created database "${meta.name}" (id ${meta.id}) with ${meta.tableCount} table${meta.tableCount === 1 ? "" : "s"}. People can browse it at ${viewPath(meta)}. Refer to it by name or id in the other tools.`,
          );
        } catch (error) {
          return text(`Failed to create database: ${errorMessage(error)}`);
        }
      },
    ),
    tool(
      "list_databases",
      `List the databases in reach, newest write first, with table counts and sizes.${scopeNote}`,
      {},
      async () => {
        try {
          const metas = await visible();
          if (!metas.length)
            return text(
              "No databases yet. create_database makes one; it appears in the Databases view.",
            );
          return text(
            metas.map((meta) => `- ${describeMeta(meta)}`).join("\n"),
          );
        } catch (error) {
          return text(`Failed to list databases: ${errorMessage(error)}`);
        }
      },
    ),
    tool(
      "describe_database",
      "The schema of one database: every table and view with its columns, types, constraints and row count. Call this before writing SQL against a database you did not just create.",
      { database: DATABASE },
      async (args: { database: string }) => {
        try {
          const meta = await resolve(args.database);
          const schema = await describeDatabase(meta.id);
          if (!schema.tables.length)
            return text(
              `${describeMeta(meta)}\nNo tables yet. Add some with execute_sql.`,
            );
          const lines = schema.tables.map((table) => {
            const columns = table.columns
              .map(
                (column) =>
                  `${column.name} ${column.type || "ANY"}${column.primaryKey ? " PRIMARY KEY" : ""}${column.notNull ? " NOT NULL" : ""}${column.defaultValue !== null ? ` DEFAULT ${column.defaultValue}` : ""}`,
              )
              .join(", ");
            return `${table.kind} ${table.name} (${table.rowCount} row${table.rowCount === 1 ? "" : "s"}): ${columns}`;
          });
          return text(`${describeMeta(meta)}\n${lines.join("\n")}`);
        } catch (error) {
          return text(`Failed to describe database: ${errorMessage(error)}`);
        }
      },
    ),
    tool(
      "query_database",
      `Run one read-only SQL statement and get the rows back as JSON. Results are capped at ${MAX_QUERY_ROWS} rows (lower with limit) and flagged truncated when cut, so aggregate in SQL rather than pulling a whole table to count it.`,
      {
        database: DATABASE,
        sql: z.string().describe("One SELECT (or other read-only) statement."),
        params: PARAMS,
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_QUERY_ROWS)
          .optional()
          .describe(`Row cap for this call, default ${MAX_QUERY_ROWS}.`),
      },
      async (args: {
        database: string;
        sql: string;
        params?: z.infer<typeof PARAMS>;
        limit?: number;
      }) => {
        try {
          const meta = await resolve(args.database);
          const result = await queryDatabase(
            meta.id,
            args.sql,
            args.params,
            args.limit,
          );
          const head = `${result.rows.length} row${result.rows.length === 1 ? "" : "s"}${
            result.truncated
              ? " (truncated: narrow the query or aggregate in SQL)"
              : ""
          }`;
          return text(
            `${head}\n${JSON.stringify({ columns: result.columns, rows: result.rows })}`,
          );
        } catch (error) {
          return text(`Query failed: ${errorMessage(error)}`);
        }
      },
    ),
    tool(
      "execute_sql",
      "Run DDL or DML against a database: CREATE, ALTER, INSERT, UPDATE, DELETE, or a script of several statements. Everything runs in one transaction, so a failure changes nothing. For many rows of data use insert_rows instead of a script of INSERTs.",
      {
        database: DATABASE,
        sql: z
          .string()
          .describe(
            "The statement or script. With params, exactly one statement.",
          ),
        params: PARAMS,
      },
      async (args: {
        database: string;
        sql: string;
        params?: z.infer<typeof PARAMS>;
      }) => {
        try {
          const meta = await resolve(args.database);
          const result = await executeDatabase(
            meta.id,
            args.sql,
            args.params,
            ctx.sessionId,
          );
          return text(
            `Done: ${result.changes} row${result.changes === 1 ? "" : "s"} changed${
              result.lastInsertRowid
                ? `, last rowid ${result.lastInsertRowid}`
                : ""
            }. View: ${viewPath(meta)}`,
          );
        } catch (error) {
          return text(`Execute failed: ${errorMessage(error)}`);
        }
      },
    ),
    tool(
      "insert_rows",
      `Insert JSON rows into one table in a single transaction, up to ${MAX_INSERT_ROWS} per call. Keys must be columns of the table; a missing key inserts NULL (or the column default). Set replace to upsert on the primary key.`,
      {
        database: DATABASE,
        table: z.string().describe("Table name."),
        rows: z
          .array(z.record(z.string(), CELL))
          .min(1)
          .max(MAX_INSERT_ROWS)
          .describe("Objects keyed by column name."),
        replace: z
          .boolean()
          .optional()
          .describe(
            "INSERT OR REPLACE, so a row with an existing key is overwritten.",
          ),
      },
      async (args: {
        database: string;
        table: string;
        rows: Array<Record<string, string | number | boolean | null>>;
        replace?: boolean;
      }) => {
        try {
          const meta = await resolve(args.database);
          const result = await insertDatabaseRows(
            meta.id,
            args.table,
            args.rows,
            { sessionId: ctx.sessionId, replace: args.replace },
          );
          return text(
            `Inserted ${result.inserted} row${result.inserted === 1 ? "" : "s"} into ${args.table}. View: ${viewPath(meta)}`,
          );
        } catch (error) {
          return text(`Insert failed: ${errorMessage(error)}`);
        }
      },
    ),
    tool(
      "update_database",
      "Rename a database or change its description. The id and the data stay as they are.",
      {
        database: DATABASE,
        name: z.string().optional().describe("New name."),
        description: z
          .string()
          .optional()
          .describe("New description; an empty string clears it."),
      },
      async (args: {
        database: string;
        name?: string;
        description?: string;
      }) => {
        try {
          const meta = await resolve(args.database);
          if (args.name === undefined && args.description === undefined)
            return text("Nothing to change: pass a name or a description.");
          const updated = await updateDatabase(
            meta.id,
            {
              ...(args.name !== undefined ? { name: args.name } : {}),
              ...(args.description !== undefined
                ? { description: args.description || null }
                : {}),
            },
            ctx.sessionId,
          );
          return text(`Updated: ${describeMeta(updated)}`);
        } catch (error) {
          return text(`Update failed: ${errorMessage(error)}`);
        }
      },
    ),
    tool(
      "delete_database",
      "Delete a database and everything in it. Irreversible; confirmName must repeat the database's exact name.",
      {
        database: DATABASE,
        confirmName: z
          .string()
          .describe("The database's exact current name, typed again."),
      },
      async (args: { database: string; confirmName: string }) => {
        try {
          const meta = await resolve(args.database);
          if (args.confirmName.trim() !== meta.name)
            return text(
              `Not deleted: confirmName must be exactly "${meta.name}".`,
            );
          await deleteDatabase(meta.id);
          return text(`Deleted database "${meta.name}" (id ${meta.id}).`);
        } catch (error) {
          return text(`Delete failed: ${errorMessage(error)}`);
        }
      },
    ),
  ];
  return createSdkMcpServer({ name: "opensession-databases", tools });
}
