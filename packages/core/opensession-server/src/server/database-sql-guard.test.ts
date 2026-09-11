import { describe, expect, test } from "bun:test";
import {
  DatabaseSqlError,
  guardSql,
  quoteIdentifier,
  tokenizeSql,
} from "./database-sql-guard";

describe("guardSql", () => {
  test("passes ordinary DDL, DML and reads", () => {
    expect(guardSql("CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)")).toBe(
      "CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)",
    );
    expect(guardSql("  select * from t where b = ?  ")).toBe(
      "select * from t where b = ?",
    );
    expect(
      guardSql("INSERT INTO t (b) VALUES ('x'); UPDATE t SET b = 'y'"),
    ).toBe("INSERT INTO t (b) VALUES ('x'); UPDATE t SET b = 'y'");
  });

  test("refuses ATTACH, DETACH and VACUUM INTO in any casing", () => {
    expect(() => guardSql("attach database '/tmp/x.db' as o")).toThrow(
      DatabaseSqlError,
    );
    expect(() => guardSql("DETACH o")).toThrow(/DETACH/);
    expect(() => guardSql("Vacuum Into '/tmp/copy.db'")).toThrow(/VACUUM INTO/);
    expect(guardSql("VACUUM")).toBe("VACUUM");
  });

  test("refuses load_extension even inside a select", () => {
    expect(() => guardSql("select load_extension('/tmp/x.so')")).toThrow(
      /LOAD_EXTENSION/,
    );
  });

  test("allows schema pragmas and refuses the rest", () => {
    expect(guardSql("PRAGMA table_info(t)")).toBe("PRAGMA table_info(t)");
    expect(guardSql("pragma foreign_keys = ON")).toBe(
      "pragma foreign_keys = ON",
    );
    expect(() => guardSql("PRAGMA max_page_count = 1")).toThrow(
      /PRAGMA max_page_count/,
    );
    expect(() => guardSql("PRAGMA journal_mode = OFF")).toThrow(
      DatabaseSqlError,
    );
    expect(() => guardSql("PRAGMA")).toThrow(/needs a name/);
  });

  test("forbidden words inside literals, identifiers and comments are fine", () => {
    expect(
      guardSql(`SELECT 'attach', "attach", [attach], \`attach\` FROM t -- attach
      /* detach */`),
    ).toContain("SELECT");
    expect(guardSql("INSERT INTO t (b) VALUES ('it''s an attach')")).toContain(
      "INSERT",
    );
  });

  test("a read is one statement", () => {
    expect(() =>
      guardSql("SELECT 1; DROP TABLE t", { readOnly: true }),
    ).toThrow(/one statement/);
    expect(guardSql("SELECT 1;", { readOnly: true })).toBe("SELECT 1;");
    expect(guardSql("SELECT ';' FROM t; ", { readOnly: true })).toBe(
      "SELECT ';' FROM t;",
    );
  });

  test("a trigger body's semicolons count as one statement", () => {
    const trigger = `CREATE TRIGGER trg AFTER INSERT ON t BEGIN
      UPDATE t SET b = 'x'; DELETE FROM u;
    END`;
    expect(() => guardSql(trigger, { readOnly: true })).not.toThrow();
  });

  test("empty and oversized SQL are refused", () => {
    expect(() => guardSql("   ")).toThrow(/empty/);
    expect(() => guardSql("SELECT " + "1,".repeat(200_000) + "1")).toThrow(
      /too long/,
    );
  });
});

describe("tokenizeSql", () => {
  test("lower-cases bare words and blanks literals", () => {
    const words = tokenizeSql("SELECT A, 'lit', \"Q\" FROM T").map(
      (t) => t.word,
    );
    expect(words).toEqual(["select", "a", ",", "", ",", "", "from", "t"]);
  });
});

describe("quoteIdentifier", () => {
  test("doubles embedded quotes", () => {
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  });
});
