import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRunnerExecutorClaims } from "./sqlite-claims";

const roots: string[] = [];
function path(): string {
  const root = mkdtempSync(join(tmpdir(), "executor-claims-"));
  roots.push(root);
  return join(root, "claims.sqlite");
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const claim = (generation: number, instanceId: string) => ({
  executorId: "runner-1",
  generation,
  instanceId,
});

describe("SqliteRunnerExecutorClaims", () => {
  test("creates fresh v2 state transactionally and atomically keeps one instance", () => {
    const dbPath = path();
    const claims = new SqliteRunnerExecutorClaims(dbPath);
    // macOS SQLite may need to initialize private WAL companions even for an
    // inspection handle. Open normally, then enforce read-only SQL semantics.
    const inspection = new Database(dbPath);
    inspection.exec("PRAGMA query_only = ON");
    expect(
      inspection
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get()!.user_version,
    ).toBe(2);
    expect(
      inspection
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map(({ name }) => name),
    ).toEqual(["runner_executor_authority", "runner_executor_instance_claims"]);
    inspection.close();
    expect(claims.claim(claim(4, "instance-1"))).toBe(true);
    expect(claims.claim(claim(4, "instance-1"))).toBe(true);
    expect(claims.claim(claim(4, "instance-2"))).toBe(false);
    expect(claims.claim(claim(6, "instance-2"))).toBe(true);
    expect(claims.claim(claim(5, "instance-3"))).toBe(false);
    claims.close();
  });

  test("persists fail-closed generation revocations", () => {
    const dbPath = path();
    let claims = new SqliteRunnerExecutorClaims(dbPath);
    expect(claims.claim(claim(2, "instance-1"))).toBe(true);
    claims.revokeThrough("runner-1", 3);
    claims.close();

    claims = new SqliteRunnerExecutorClaims(dbPath);
    expect(claims.claim(claim(2, "instance-1"))).toBe(false);
    expect(claims.claim(claim(3, "instance-2"))).toBe(false);
    expect(claims.claim(claim(4, "instance-2"))).toBe(true);
    claims.close();
  });

  test("rejects symlink database and sidecar paths before SQLite opens them", () => {
    const dbPath = path();
    const target = `${dbPath}.target`;
    writeFileSync(target, "target");
    symlinkSync(target, dbPath);
    expect(() => new SqliteRunnerExecutorClaims(dbPath)).toThrow();

    const sidecarPath = path();
    const sidecarTarget = `${sidecarPath}.wal-target`;
    writeFileSync(sidecarTarget, "target");
    symlinkSync(sidecarTarget, `${sidecarPath}-wal`);
    expect(() => new SqliteRunnerExecutorClaims(sidecarPath)).toThrow(
      "unsafe Runner Executor claims SQLite file",
    );
  });

  test("rejects disposable v1 state instead of misreading its replaced structure", () => {
    const oldPath = path();
    const old = new Database(oldPath);
    old.exec(`
      CREATE TABLE executor_instance_claims (
        source TEXT NOT NULL,
        executor_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        instance_id TEXT NOT NULL,
        PRIMARY KEY(source, executor_id, generation)
      ) STRICT;
      CREATE TABLE executor_generation_revocations (
        source TEXT NOT NULL,
        executor_id TEXT NOT NULL,
        through_generation INTEGER NOT NULL,
        PRIMARY KEY(source, executor_id)
      ) STRICT;
      PRAGMA user_version = 1;
    `);
    old.close();
    expect(() => new SqliteRunnerExecutorClaims(oldPath)).toThrow(
      "schema version 1 is disposable pre-production state; delete the claims database and restart",
    );
  });

  test("fails closed on unknown, unversioned, and mismatched schemas", () => {
    const newerPath = path();
    const newer = new Database(newerPath);
    newer.exec("PRAGMA user_version = 3");
    newer.close();
    expect(() => new SqliteRunnerExecutorClaims(newerPath)).toThrow(
      "unsupported Runner Executor claims schema",
    );

    const unversionedPath = path();
    const unversioned = new Database(unversionedPath);
    unversioned.exec("CREATE TABLE unexpected (id TEXT)");
    unversioned.close();
    expect(() => new SqliteRunnerExecutorClaims(unversionedPath)).toThrow(
      "unversioned Runner Executor claims schema",
    );

    const mismatchPath = path();
    new SqliteRunnerExecutorClaims(mismatchPath).close();
    const mismatch = new Database(mismatchPath);
    mismatch.exec("DROP TABLE runner_executor_instance_claims");
    mismatch.close();
    expect(() => new SqliteRunnerExecutorClaims(mismatchPath)).toThrow(
      "schema tables do not match",
    );

    const columnsPath = path();
    new SqliteRunnerExecutorClaims(columnsPath).close();
    const columns = new Database(columnsPath);
    columns.exec(`
      DROP TABLE runner_executor_instance_claims;
      CREATE TABLE runner_executor_instance_claims (
        executor_id TEXT,
        generation INTEGER,
        wrong_column TEXT
      );
    `);
    columns.close();
    expect(() => new SqliteRunnerExecutorClaims(columnsPath)).toThrow(
      "schema columns do not match",
    );
  });
});
