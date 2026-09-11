/**
 * The Databases routes over an in-process store, so no worker is involved:
 * status codes for missing databases and bad SQL, the read-only query
 * endpoint, paged rows, and the two downloads.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setDatabasesStoreForTest, DatabasesStore } from "../databases";
import { handleDatabasesRoutes } from "./databases";

const root = mkdtempSync(join(tmpdir(), "databases-routes-"));
let store: DatabasesStore;

beforeAll(() => {
  store = new DatabasesStore(join(root, "store"));
  __setDatabasesStoreForTest(store);
});

afterAll(() => {
  __setDatabasesStoreForTest(undefined);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  const req = new Request(url, {
    method,
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }
      : {}),
  });
  const response = await handleDatabasesRoutes({
    req,
    url,
    path: url.pathname,
    publicPrefix: "/backstage",
  });
  if (!response) throw new Error(`No route for ${method} ${path}`);
  return response;
}

describe("databases routes", () => {
  let id = "";

  test("creates from the view and lists", async () => {
    const created = await call("POST", "/api/databases", {
      name: "Route test",
      description: "made by a test",
    });
    expect(created.status).toBe(200);
    const { database } = (await created.json()) as {
      database: { id: string; name: string };
    };
    id = database.id;
    expect(database.name).toBe("Route test");
    const listed = await call("GET", "/api/databases");
    const { databases } = (await listed.json()) as {
      databases: Array<{ id: string }>;
    };
    expect(databases.map((entry) => entry.id)).toEqual([id]);
    const missingName = await call("POST", "/api/databases", { name: " " });
    expect(missingName.status).toBe(400);
  });

  test("meta with schema, and 404 for a missing or malformed id", async () => {
    store.execute(id, "CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)");
    store.insertRows(id, "t", [{ b: "x" }, { b: "y" }, { b: "z" }]);
    const response = await call("GET", `/api/databases/${id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      database: { tableCount: number };
      schema: { tables: Array<{ name: string; rowCount: number }> };
    };
    expect(body.database.tableCount).toBe(1);
    expect(body.schema.tables[0]).toMatchObject({ name: "t", rowCount: 3 });
    expect((await call("GET", "/api/databases/nope-0000")).status).toBe(404);
    expect((await call("GET", "/api/databases/Upper")).status).toBe(404);
  });

  test("rows are paged and sorted server-side", async () => {
    const response = await call(
      "GET",
      `/api/databases/${id}/tables/t/rows?sort=b&dir=desc&limit=2&offset=1`,
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      columns: string[];
      rows: unknown[][];
      total: number;
      offset: number;
    };
    expect(page.columns).toEqual(["a", "b"]);
    expect(page.rows.map((row) => row[1])).toEqual(["y", "x"]);
    expect(page.total).toBe(3);
    expect(page.offset).toBe(1);
    expect(
      (await call("GET", `/api/databases/${id}/tables/missing/rows`)).status,
    ).toBe(400);
  });

  test("query is read-only and reports SQL errors as 400", async () => {
    const ok = await call("POST", `/api/databases/${id}/query`, {
      sql: "SELECT count(*) AS n FROM t WHERE b <> $skip",
      params: { skip: "z" },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { rows: unknown[][] }).rows).toEqual([[2]]);
    const write = await call("POST", `/api/databases/${id}/query`, {
      sql: "DELETE FROM t",
    });
    expect(write.status).toBe(400);
    expect(store.describe(id).tables[0].rowCount).toBe(3);
    const attach = await call("POST", `/api/databases/${id}/query`, {
      sql: "ATTACH '/tmp/x' AS o",
    });
    expect(attach.status).toBe(400);
    const badParams = await call("POST", `/api/databases/${id}/query`, {
      sql: "SELECT 1",
      params: [{ nested: true }],
    });
    expect(badParams.status).toBe(400);
    const noSql = await call("POST", `/api/databases/${id}/query`, {});
    expect(noSql.status).toBe(400);
  });

  test("exports CSV per table and the database file", async () => {
    const csv = await call("GET", `/api/databases/${id}/tables/t/export.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(csv.headers.get("content-disposition")).toContain(
      'filename="Route-test-t.csv"',
    );
    expect(await csv.text()).toBe("a,b\r\n1,x\r\n2,y\r\n3,z\r\n");

    const file = await call("GET", `/api/databases/${id}/export`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/vnd.sqlite3");
    expect(file.headers.get("content-disposition")).toContain(
      'filename="Route-test.sqlite"',
    );
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(Number(file.headers.get("content-length"))).toBe(bytes.length);
    const copy = join(root, "downloaded.sqlite");
    writeFileSync(copy, bytes);
    const db = new Database(copy, { readonly: true });
    expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 3 });
    db.close();
  });

  test("renames, and deletes for good", async () => {
    const renamed = await call("PATCH", `/api/databases/${id}`, {
      name: "Renamed",
      description: "",
    });
    expect(renamed.status).toBe(200);
    const { database } = (await renamed.json()) as {
      database: { name: string; description?: string };
    };
    expect(database.name).toBe("Renamed");
    expect(database.description).toBeUndefined();
    expect((await call("PATCH", `/api/databases/${id}`, {})).status).toBe(400);
    expect((await call("DELETE", `/api/databases/${id}`)).status).toBe(200);
    expect((await call("DELETE", `/api/databases/${id}`)).status).toBe(404);
    expect((await call("GET", `/api/databases/${id}`)).status).toBe(404);
  });
});
