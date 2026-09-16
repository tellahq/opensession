import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  canAccessScope,
  parseAccessScope,
  sameAccessScope,
} from "./access-scope";
import { accessPredicateSql } from "../server/access-scope-sql";

test("scope parsing and SQL predicates agree for legacy, malformed and owner-bound inputs", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE test_scope(doc TEXT)");
  try {
    for (const scope of [
      undefined,
      null,
      "personal",
      {},
      [],
      { kind: "shared" },
      { kind: "shared", ownerGithubAccountId: 101 },
      { kind: "personal" },
      { kind: "future" },
      ...[101, 202, 0, -1, 1.5, "101", Number.MAX_SAFE_INTEGER + 1].map(
        (ownerGithubAccountId) => ({ kind: "personal", ownerGithubAccountId }),
      ),
    ]) {
      db.run("DELETE FROM test_scope");
      db.run("INSERT INTO test_scope VALUES (?)", [
        JSON.stringify({ accessScope: scope }),
      ]);
      for (const principal of [
        undefined,
        { githubAccountId: 101 },
        { githubAccountId: 202 },
      ]) {
        const visible = !!db
          .query(
            `SELECT 1 FROM test_scope WHERE ${accessPredicateSql("doc", principal)}`,
          )
          .get();
        expect(visible).toBe(canAccessScope(scope, principal));
      }
    }
  } finally {
    db.close();
  }
});

test("legacy shared equivalence does not allow owner reassignment or scope removal", () => {
  expect(parseAccessScope(undefined)).toEqual({ kind: "shared" });
  expect(sameAccessScope(undefined, { kind: "shared" })).toBe(true);
  expect(
    sameAccessScope({ kind: "personal", ownerGithubAccountId: 101 }, undefined),
  ).toBe(false);
  expect(
    sameAccessScope(
      { kind: "personal", ownerGithubAccountId: 101 },
      { kind: "personal", ownerGithubAccountId: 202 },
    ),
  ).toBe(false);
  expect(sameAccessScope(null, undefined)).toBe(false);
});
