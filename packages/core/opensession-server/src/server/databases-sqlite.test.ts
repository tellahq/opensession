import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DatabaseLimitError,
  DatabaseNotFoundError,
  DatabasesStore,
  MAX_INSERT_ROWS,
  MAX_QUERY_ROWS,
  isDatabaseId,
} from "./databases-sqlite";
import { DatabaseSqlError } from "./database-sql-guard";

const root = mkdtempSync(join(tmpdir(), "databases-store-"));
let store: DatabasesStore;
let n = 0;

beforeEach(() => {
  store?.close();
  store = new DatabasesStore(join(root, `run-${n++}`));
});

afterAll(() => {
  store?.close();
  rmSync(root, { recursive: true, force: true });
});

const SCHEMA =
  "CREATE TABLE tickets (id INTEGER PRIMARY KEY, title TEXT NOT NULL, score REAL)";

describe("DatabasesStore", () => {
  test("create writes the file and a sidecar, and the id is URL-safe", () => {
    const meta = store.create({
      name: "Support Tickets!",
      description: "  weekly triage  ",
      createdBy: "Ada",
      sessionId: "s1",
      schema: SCHEMA,
    });
    expect(meta.id.startsWith("support-tickets-")).toBe(true);
    expect(isDatabaseId(meta.id)).toBe(true);
    expect(meta.name).toBe("Support Tickets!");
    expect(meta.description).toBe("weekly triage");
    expect(meta.tableCount).toBe(1);
    expect(meta.sizeBytes).toBeGreaterThan(0);
    expect(meta.sessionIds).toEqual(["s1"]);
    expect(meta.createdBySessionId).toBe("s1");
    expect(existsSync(join(store.root, `${meta.id}.sqlite`))).toBe(true);
    const sidecar = JSON.parse(
      readFileSync(join(store.root, `${meta.id}.json`), "utf8"),
    );
    expect(sidecar.id).toBe(meta.id);
  });

  test("a bad initial schema leaves nothing behind", () => {
    expect(() =>
      store.create({ name: "Broken", schema: "CREATE TABL nope" }),
    ).toThrow();
    expect(store.list()).toEqual([]);
    expect(existsSync(store.root) ? readdirSync(store.root) : []).toEqual([]);
  });

  test("execute, insert_rows, query and describe round-trip", () => {
    const { id } = store.create({ name: "T", schema: SCHEMA, sessionId: "s1" });
    const executed = store.execute(
      id,
      "INSERT INTO tickets (title, score) VALUES (?, ?)",
      ["first", 1.5],
      "s2",
    );
    expect(executed).toEqual({ changes: 1, lastInsertRowid: 1 });
    const bulk = store.insertRows(
      id,
      "tickets",
      [
        { title: "second", score: null },
        { title: "third", score: 3 },
      ],
      { sessionId: "s3" },
    );
    expect(bulk).toEqual({ inserted: 2 });
    const result = store.query(
      id,
      "SELECT id, title, score FROM tickets WHERE score IS NOT NULL ORDER BY id",
    );
    expect(result.columns).toEqual(["id", "title", "score"]);
    expect(result.rows).toEqual([
      [1, "first", 1.5],
      [3, "third", 3],
    ]);
    expect(result.truncated).toBe(false);
    const named = store.query(id, "SELECT title FROM tickets WHERE id = $id", {
      id: 2,
    });
    expect(named.rows).toEqual([["second"]]);
    const schema = store.describe(id);
    expect(schema.tables).toHaveLength(1);
    expect(schema.tables[0].name).toBe("tickets");
    expect(schema.tables[0].rowCount).toBe(3);
    expect(schema.tables[0].columns.map((column) => column.name)).toEqual([
      "id",
      "title",
      "score",
    ]);
    expect(schema.tables[0].columns[0].primaryKey).toBe(true);
    expect(schema.tables[0].columns[1].notNull).toBe(true);
    const meta = store.get(id)!;
    expect(meta.sessionIds).toEqual(["s1", "s2", "s3"]);
    expect(meta.lastSessionId).toBe("s3");
    expect(store.listForSession("s2").map((entry) => entry.id)).toEqual([id]);
    expect(store.listForSession("nobody")).toEqual([]);
  });

  test("a script in execute runs as one transaction", () => {
    const { id } = store.create({ name: "T", schema: SCHEMA });
    expect(() =>
      store.execute(
        id,
        "INSERT INTO tickets (title) VALUES ('kept?'); INSERT INTO tickets (nope) VALUES (1)",
      ),
    ).toThrow();
    expect(store.describe(id).tables[0].rowCount).toBe(0);
    const ok = store.execute(
      id,
      "INSERT INTO tickets (title) VALUES ('a'); INSERT INTO tickets (title) VALUES ('b')",
    );
    expect(ok.changes).toBe(1);
    expect(ok.lastInsertRowid).toBe(2);
  });

  test("query is read-only and refuses writes and multi-statement text", () => {
    const { id } = store.create({ name: "T", schema: SCHEMA });
    expect(() =>
      store.query(id, "INSERT INTO tickets (title) VALUES ('x')"),
    ).toThrow(/readonly/);
    expect(() => store.query(id, "SELECT 1; DROP TABLE tickets")).toThrow(
      DatabaseSqlError,
    );
    expect(() => store.query(id, "ATTACH '/tmp/x' AS o")).toThrow(
      DatabaseSqlError,
    );
    expect(store.describe(id).tables).toHaveLength(1);
  });

  test("query results are capped and flagged", () => {
    const { id } = store.create({
      name: "Big",
      schema: "CREATE TABLE n (v INTEGER)",
    });
    store.insertRows(
      id,
      "n",
      Array.from({ length: MAX_QUERY_ROWS + 5 }, (_, index) => ({ v: index })),
    );
    const all = store.query(id, "SELECT v FROM n");
    expect(all.rows).toHaveLength(MAX_QUERY_ROWS);
    expect(all.truncated).toBe(true);
    const some = store.query(id, "SELECT v FROM n", undefined, 10);
    expect(some.rows).toHaveLength(10);
    expect(some.truncated).toBe(true);
    const wide = store.create({
      name: "Wide",
      schema: "CREATE TABLE w (t TEXT)",
    });
    store.insertRows(
      wide.id,
      "w",
      Array.from({ length: 20 }, () => ({ t: "x".repeat(20_000) })),
    );
    const heavy = store.query(wide.id, "SELECT t FROM w");
    expect(heavy.truncated).toBe(true);
    expect(heavy.rows.length).toBeLessThan(20);
  });

  test("insert_rows validates columns and the row cap", () => {
    const { id } = store.create({ name: "T", schema: SCHEMA });
    expect(() =>
      store.insertRows(id, "tickets", [{ title: "x", nope: 1 }]),
    ).toThrow(/Unknown column nope/);
    expect(() => store.insertRows(id, "missing", [{ a: 1 }])).toThrow(
      /No table named missing/,
    );
    expect(() =>
      store.insertRows(
        id,
        "tickets",
        Array.from({ length: MAX_INSERT_ROWS + 1 }, () => ({ title: "x" })),
      ),
    ).toThrow(DatabaseLimitError);
    // A failing row rolls the whole batch back.
    expect(() =>
      store.insertRows(id, "tickets", [{ title: "ok" }, { title: null }]),
    ).toThrow();
    expect(store.describe(id).tables[0].rowCount).toBe(0);
  });

  test("rows pages a table with server-side ordering", () => {
    const { id } = store.create({ name: "T", schema: SCHEMA });
    store.insertRows(id, "tickets", [
      { title: "c", score: 3 },
      { title: "a", score: 1 },
      { title: "b", score: 2 },
    ]);
    const page = store.rows(id, "tickets", {
      sort: "title",
      dir: "desc",
      limit: 2,
    });
    expect(page.total).toBe(3);
    expect(page.rows.map((row) => row[1])).toEqual(["c", "b"]);
    const next = store.rows(id, "tickets", {
      sort: "title",
      dir: "desc",
      limit: 2,
      offset: 2,
    });
    expect(next.rows.map((row) => row[1])).toEqual(["a"]);
    // An unknown sort column falls back to rowid order instead of erroring.
    const plain = store.rows(id, "tickets", { sort: "nope" });
    expect(plain.rows.map((row) => row[1])).toEqual(["c", "a", "b"]);
    expect(() => store.rows(id, 'tickets"; DROP', {})).toThrow(
      DatabaseSqlError,
    );
  });

  test("exportCsv quotes what needs quoting", () => {
    const { id } = store.create({ name: "T", schema: SCHEMA });
    store.insertRows(id, "tickets", [
      { title: 'say "hi", please', score: null },
      { title: "line\nbreak", score: 2 },
    ]);
    expect(store.exportCsv(id, "tickets")).toBe(
      'id,title,score\r\n1,"say ""hi"", please",\r\n2,"line\nbreak",2\r\n',
    );
  });

  test("exportCopy yields a complete standalone file", () => {
    const { id } = store.create({ name: "T", schema: SCHEMA });
    store.insertRows(id, "tickets", [{ title: "x" }]);
    const copy = join(root, `copy-${n}.sqlite`);
    store.exportCopy(id, copy);
    const db = new Database(copy, { readonly: true });
    expect(db.prepare("SELECT count(*) AS n FROM tickets").get()).toEqual({
      n: 1,
    });
    db.close();
    // The live database still works after its connections were closed.
    store.insertRows(id, "tickets", [{ title: "y" }]);
    expect(store.describe(id).tables[0].rowCount).toBe(2);
  });

  test("update renames and reassigns ownership; remove deletes both files", () => {
    const { id } = store.create({ name: "Old", schema: SCHEMA });
    const renamed = store.update(id, {
      name: "New",
      description: "d",
      automationId: "auto-1",
      automationName: "Nightly",
    });
    expect(renamed.name).toBe("New");
    expect(renamed.automationId).toBe("auto-1");
    expect(store.findByName("new")?.id).toBe(id);
    const cleared = store.update(id, { description: null, automationId: null });
    expect(cleared.description).toBeUndefined();
    expect(cleared.automationId).toBeUndefined();
    expect(store.remove(id)).toBe(true);
    expect(store.remove(id)).toBe(false);
    expect(store.get(id)).toBeNull();
    expect(existsSync(join(store.root, `${id}.sqlite`))).toBe(false);
    expect(existsSync(join(store.root, `${id}.json`))).toBe(false);
    expect(() => store.describe(id)).toThrow(DatabaseNotFoundError);
  });

  test("a fresh store instance recovers the index from sidecars", () => {
    const a = store.create({ name: "A", schema: SCHEMA });
    const b = store.create({ name: "B" });
    store.close();
    const reopened = new DatabasesStore(store.root);
    expect(
      reopened
        .list()
        .map((meta) => meta.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(reopened.describe(a.id).tables).toHaveLength(1);
    reopened.close();
  });

  test("ids that are not ids never touch the filesystem", () => {
    expect(store.get("../etc")).toBeNull();
    expect(store.get("A")).toBeNull();
    expect(() => store.describe("../etc")).toThrow(DatabaseNotFoundError);
  });
});
