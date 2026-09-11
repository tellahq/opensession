/**
 * The Databases store runs on a dedicated worker. These tests pin the
 * gateway-facing guarantees: the event loop stays free while the worker is
 * busy, a read posted after a write observes it, a dead worker rejects what
 * it owed and the next call recovers on the same durable files, a store
 * error keeps its class across the thread boundary, and a repointed
 * OPENSESSION_STATE_DIR gets its own store.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __databasesDebugForTest,
  __databasesPendingForTest,
  __resetDatabasesWorkerForTest,
  DatabaseNotFoundError,
  DatabaseSqlError,
  DatabasesWorkerError,
  createDatabase,
  databasesRoot,
  describeDatabase,
  executeDatabase,
  getDatabase,
  insertDatabaseRows,
  listDatabases,
  queryDatabase,
} from "./databases";

const root = mkdtempSync(join(tmpdir(), "databases-worker-"));

/**
 * The error a promise settles with. Written out rather than as
 * `expect(promise).rejects`: under Bun 1.4 that matcher, awaited on a promise
 * the worker rejects, leaves every later message from that worker
 * undelivered on this thread, and the test times out with the worker idle.
 */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject");
}
const stateA = join(root, "a");
const stateB = join(root, "b");
const priorStateDir = process.env.OPENSESSION_STATE_DIR;

beforeAll(() => {
  process.env.OPENSESSION_STATE_DIR = stateA;
});

afterAll(() => {
  __resetDatabasesWorkerForTest();
  if (priorStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = priorStateDir;
  rmSync(root, { recursive: true, force: true });
});

describe("databases worker", () => {
  test("writes then reads through the worker, on disk under the state dir", async () => {
    const meta = await createDatabase({
      name: "Worker test",
      schema: "CREATE TABLE t (a INTEGER)",
      sessionId: "s1",
    });
    await insertDatabaseRows(meta.id, "t", [{ a: 1 }, { a: 2 }]);
    await executeDatabase(meta.id, "INSERT INTO t (a) VALUES (?)", [3]);
    const result = await queryDatabase(
      meta.id,
      "SELECT sum(a) AS total FROM t",
    );
    expect(result.rows).toEqual([[6]]);
    expect(databasesRoot().startsWith(stateA)).toBe(true);
    expect(existsSync(join(databasesRoot(), `${meta.id}.sqlite`))).toBe(true);
    expect((await describeDatabase(meta.id)).tables[0].rowCount).toBe(3);
  });

  test("store errors keep their class across the thread boundary", async () => {
    expect(await rejection(describeDatabase("missing-0000"))).toBeInstanceOf(
      DatabaseNotFoundError,
    );
    const [meta] = await listDatabases();
    expect(
      await rejection(queryDatabase(meta.id, "ATTACH '/tmp/x' AS o")),
    ).toBeInstanceOf(DatabaseSqlError);
    expect(
      await rejection(queryDatabase(meta.id, "SELECT * FROM nope")),
    ).toBeInstanceOf(DatabaseSqlError);
  });

  test("the event loop stays free while the worker is busy", async () => {
    const stalled = __databasesDebugForTest({ action: "stall", ms: 150 });
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 10);
    await stalled;
    clearInterval(ticker);
    expect(ticks).toBeGreaterThan(3);
  });

  test("a crashed worker rejects what it owed and the next call recovers", async () => {
    const [meta] = await listDatabases();
    const crash = __databasesDebugForTest({ action: "crash" });
    const owed = listDatabases();
    expect(await rejection(crash)).toBeInstanceOf(DatabasesWorkerError);
    expect(await rejection(owed)).toBeInstanceOf(DatabasesWorkerError);
    expect(__databasesPendingForTest()).toBe(0);
    expect((await getDatabase(meta.id))?.name).toBe("Worker test");
    expect(
      (await queryDatabase(meta.id, "SELECT count(*) AS n FROM t")).rows,
    ).toEqual([[3]]);
  });

  test("a repointed state dir gets its own store", async () => {
    process.env.OPENSESSION_STATE_DIR = stateB;
    expect(await listDatabases()).toEqual([]);
    process.env.OPENSESSION_STATE_DIR = stateA;
    expect(await listDatabases()).toHaveLength(1);
  });
});
