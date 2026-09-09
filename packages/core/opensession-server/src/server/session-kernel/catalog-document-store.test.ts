import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATALOG_DOCUMENT_GET_MANY_LIMIT,
  CATALOG_DOCUMENT_MAX_GET_MANY_RESPONSE_BYTES,
  CATALOG_DOCUMENT_MAX_PAGE_BYTES,
  CATALOG_DOCUMENT_MAX_VALUE_BYTES,
  CATALOG_DOCUMENT_PAGE_LIMIT,
  CATALOG_DOCUMENT_SEED_LIMIT,
  type CatalogDocumentRequest,
} from "./catalog-document-protocol";
import { SESSION_KERNEL_SCHEMA_VERSION, SessionKernelStore } from "./store";

let store: SessionKernelStore;
beforeEach(() => {
  store = new SessionKernelStore(":memory:");
});
afterEach(() => {
  store.close();
});

function put(
  namespace: string,
  key: string,
  expectedRev: number | null,
  value: string | null,
  requestId = crypto.randomUUID(),
) {
  return store.putCatalogDocument({
    op: "put",
    namespace,
    key,
    expectedRev,
    value,
    requestId,
  });
}

describe("catalog document store", () => {
  test("creates the namespace table at schema 34", () => {
    const dir = mkdtempSync(join(tmpdir(), "catalog-documents-schema-"));
    const path = join(dir, "kernel.sqlite");
    try {
      const older = new SessionKernelStore(path);
      older.close();
      const db = new Database(path);
      expect(
        (db.query("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ).toBe(SESSION_KERNEL_SCHEMA_VERSION);
      expect(SESSION_KERNEL_SCHEMA_VERSION).toBeGreaterThanOrEqual(34);
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_kernel_catalog_documents'",
          )
          .get(),
      ).toEqual({ name: "session_kernel_catalog_documents" });
      db.close();
      // Reopening at the current version is a no-op migration.
      new SessionKernelStore(path).close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read-after-write with server-assigned revisions", () => {
    expect(store.catalogDocumentGet("workspace", "alpha")).toBeNull();
    expect(put("workspace", "alpha", null, '{"n":1}')).toEqual({
      status: "committed",
      rev: 1,
    });
    expect(store.catalogDocumentGet("workspace", "alpha")).toEqual({
      key: "alpha",
      value: '{"n":1}',
      rev: 1,
    });
    expect(put("workspace", "alpha", 1, '{"n":2}')).toEqual({
      status: "committed",
      rev: 2,
    });
    expect(store.catalogDocumentGet("workspace", "alpha")).toEqual({
      key: "alpha",
      value: '{"n":2}',
      rev: 2,
    });
  });

  test("compare-and-set rejects stale writers with the committed truth", () => {
    put("workspace", "alpha", null, "v1");
    // A writer that believes nothing exists yet.
    expect(put("workspace", "alpha", null, "v1-again")).toEqual({
      status: "conflict",
      current: { key: "alpha", value: "v1", rev: 1 },
    });
    // A writer ahead of the store.
    expect(put("workspace", "alpha", 2, "v3")).toEqual({
      status: "conflict",
      current: { key: "alpha", value: "v1", rev: 1 },
    });
    // A writer that expects a row where none exists.
    expect(put("workspace", "missing", 1, "v2")).toEqual({
      status: "conflict",
      current: null,
    });
    expect(store.catalogDocumentGet("workspace", "alpha")).toMatchObject({
      value: "v1",
      rev: 1,
    });
  });

  test("replaying a committed request id returns its receipt", () => {
    const requestId = crypto.randomUUID();
    expect(put("workspace", "alpha", null, "v1", requestId)).toEqual({
      status: "committed",
      rev: 1,
    });
    // The retry carries the same expected revision and is not a conflict.
    expect(put("workspace", "alpha", null, "v1", requestId)).toEqual({
      status: "duplicate",
      rev: 1,
    });
    // A retry after another writer advanced the row is a conflict, not a
    // silent duplicate: the receipt belongs to the current revision only.
    put("workspace", "alpha", 1, "v2");
    expect(put("workspace", "alpha", null, "v1", requestId)).toMatchObject({
      status: "conflict",
      current: { rev: 2 },
    });
  });

  test("a tombstone keeps its revision and still fences writers", () => {
    put("workspace", "alpha", null, "v1");
    expect(put("workspace", "alpha", 1, null)).toEqual({
      status: "committed",
      rev: 2,
    });
    expect(store.catalogDocumentGet("workspace", "alpha")).toEqual({
      key: "alpha",
      value: null,
      rev: 2,
    });
    // A writer that read the live row cannot resurrect it blindly.
    expect(put("workspace", "alpha", 1, "v1-edited")).toEqual({
      status: "conflict",
      current: { key: "alpha", value: null, rev: 2 },
    });
    // Neither can a writer that never saw the row.
    expect(put("workspace", "alpha", null, "fresh")).toMatchObject({
      status: "conflict",
      current: { value: null, rev: 2 },
    });
    // Writing on top of the tombstone recreates the key.
    expect(put("workspace", "alpha", 2, "v3")).toEqual({
      status: "committed",
      rev: 3,
    });
    expect(store.catalogDocumentGet("workspace", "alpha")).toMatchObject({
      value: "v3",
      rev: 3,
    });
    // Deleting a key that never existed records a tombstone so a concurrent
    // import cannot reintroduce it.
    expect(put("workspace", "never", null, null)).toEqual({
      status: "committed",
      rev: 1,
    });
    expect(store.catalogDocumentGet("workspace", "never")).toEqual({
      key: "never",
      value: null,
      rev: 1,
    });
  });

  test("pages keys in order, includes tombstones, and honors the cursor", () => {
    for (const key of ["c", "a", "b", "d"]) put("workspace", key, null, key);
    put("workspace", "b", 1, null);
    expect(store.catalogDocumentPage("workspace", "", 3)).toEqual([
      { key: "a", value: "a", rev: 1 },
      { key: "b", value: null, rev: 2 },
      { key: "c", value: "c", rev: 1 },
    ]);
    expect(store.catalogDocumentPage("workspace", "c", 3)).toEqual([
      { key: "d", value: "d", rev: 1 },
    ]);
    expect(store.catalogDocumentPage("workspace", "d", 3)).toEqual([]);
    expect(store.catalogDocumentPage("empty", "", 3)).toEqual([]);
  });

  test("a page stops at its byte budget but never comes back empty", () => {
    // Three documents of 3 MiB against an 8 MiB page budget: the third row
    // would push the page to 9 MiB, so it waits for the next page.
    const third = "x".repeat(3 * 1024 * 1024);
    for (const key of ["a", "b", "c", "d"]) put("big", key, null, third);
    put("big", "d", 1, null);
    const first = store.catalogDocumentPage(
      "big",
      "",
      CATALOG_DOCUMENT_PAGE_LIMIT,
    );
    expect(first.map((row) => row.key)).toEqual(["a", "b"]);
    expect(
      first.reduce(
        (sum, row) => sum + row.key.length + (row.value?.length ?? 0),
        0,
      ),
    ).toBeLessThanOrEqual(CATALOG_DOCUMENT_MAX_PAGE_BYTES);
    // Continuation resumes at the cut and picks up the tombstone behind it.
    const second = store.catalogDocumentPage(
      "big",
      "b",
      CATALOG_DOCUMENT_PAGE_LIMIT,
    );
    expect(second.map((row) => [row.key, row.value === null])).toEqual([
      ["c", false],
      ["d", true],
    ]);
    expect(
      store.catalogDocumentPage("big", "d", CATALOG_DOCUMENT_PAGE_LIMIT),
    ).toEqual([]);
    // Two maximum-size documents never share a page (their keys tip the
    // total over the budget), yet each still travels on its own page.
    put("huge", "only", null, "y".repeat(CATALOG_DOCUMENT_MAX_VALUE_BYTES));
    put("huge", "second", null, "z".repeat(CATALOG_DOCUMENT_MAX_VALUE_BYTES));
    put("huge", "third", null, "tiny");
    expect(
      store
        .catalogDocumentPage("huge", "", CATALOG_DOCUMENT_PAGE_LIMIT)
        .map((row) => row.key),
    ).toEqual(["only"]);
    expect(
      store
        .catalogDocumentPage("huge", "only", CATALOG_DOCUMENT_PAGE_LIMIT)
        .map((row) => row.key),
    ).toEqual(["second", "third"]);
    expect(
      store
        .catalogDocumentPage("huge", "second", CATALOG_DOCUMENT_PAGE_LIMIT)
        .map((row) => row.key),
    ).toEqual(["third"]);
    // The row limit still applies underneath the byte budget.
    expect(
      store.catalogDocumentPage("big", "", 1).map((row) => row.key),
    ).toEqual(["a"]);
  });

  test("get_many refuses a key set whose answer would exceed the response bound", () => {
    const value = "v".repeat(CATALOG_DOCUMENT_MAX_VALUE_BYTES);
    const keys = Array.from(
      {
        length:
          CATALOG_DOCUMENT_MAX_GET_MANY_RESPONSE_BYTES /
            CATALOG_DOCUMENT_MAX_VALUE_BYTES +
          1,
      },
      (_, i) => `k${i}`,
    );
    for (const key of keys) put("bulk", key, null, value);
    // Seven full documents fit; eight cross the bound because keys count
    // toward it too, and the whole request is rejected, never trimmed.
    expect(store.catalogDocumentGetMany("bulk", keys.slice(0, -2)).length).toBe(
      keys.length - 2,
    );
    expect(() =>
      store.catalogDocumentGetMany("bulk", keys.slice(0, -1)),
    ).toThrow(/response bound/);
    expect(() => store.catalogDocumentGetMany("bulk", keys)).toThrow(
      /response bound/,
    );
    // Missing keys cost nothing.
    expect(
      store.catalogDocumentGetMany("bulk", [...keys.slice(0, 2), "missing"])
        .length,
    ).toBe(2);
  });

  test("a put may not borrow the seed request id", () => {
    store.seedCatalogDocuments("workspace", [{ key: "a", value: "seeded" }]);
    // Otherwise this replay check would read the seeded row as its receipt
    // and answer duplicate instead of committing.
    expect(() =>
      store.putCatalogDocument({
        op: "put",
        namespace: "workspace",
        key: "a",
        expectedRev: 1,
        value: "mine",
        requestId: "seed",
      }),
    ).toThrow(/Reserved/);
    expect(store.catalogDocumentGet("workspace", "a")).toEqual({
      key: "a",
      value: "seeded",
      rev: 1,
    });
  });

  test("get_many answers a bounded key set in one lookup", () => {
    for (const key of ["c", "a", "b"]) put("workspace", key, null, key);
    put("workspace", "b", 1, null);
    put("other", "a", null, "other");
    // Missing keys are omitted, tombstones kept, duplicates collapsed, rows
    // ordered by key regardless of request order.
    expect(
      store.catalogDocumentGetMany("workspace", [
        "c",
        "missing",
        "a",
        "b",
        "a",
      ]),
    ).toEqual([
      { key: "a", value: "a", rev: 1 },
      { key: "b", value: null, rev: 2 },
      { key: "c", value: "c", rev: 1 },
    ]);
    expect(store.catalogDocumentGetMany("workspace", ["missing"])).toEqual([]);
    expect(store.catalogDocumentGetMany("other", ["a", "b"])).toEqual([
      { key: "a", value: "other", rev: 1 },
    ]);
    // The largest allowed batch still runs as one statement.
    const many = Array.from(
      { length: CATALOG_DOCUMENT_GET_MANY_LIMIT },
      (_, i) => `k${i}`,
    );
    expect(store.catalogDocumentGetMany("workspace", many)).toEqual([]);
    expect(() => store.catalogDocumentGetMany("workspace", [])).toThrow(
      /key batch/,
    );
    expect(() =>
      store.catalogDocumentGetMany("workspace", [...many, "one-more"]),
    ).toThrow(/key batch/);
    expect(() =>
      store.catalogDocumentGetMany(
        "workspace",
        Array.from({ length: 600 }, (_, i) => `${i}`.padStart(512, "x")),
      ),
    ).toThrow(/too large/);
    expect(() => store.catalogDocumentGetMany("workspace", [""])).toThrow(
      /key/,
    );
  });

  test("namespaces are isolated", () => {
    put("workspace", "shared", null, "workspace doc");
    put("automation", "shared", null, "automation doc");
    put("automation", "only-here", null, "x");
    expect(store.catalogDocumentGet("workspace", "shared")).toMatchObject({
      value: "workspace doc",
      rev: 1,
    });
    expect(store.catalogDocumentGet("automation", "shared")).toMatchObject({
      value: "automation doc",
      rev: 1,
    });
    expect(store.catalogDocumentGet("workspace", "only-here")).toBeNull();
    expect(
      store.catalogDocumentPage("workspace", "", 10).map((row) => row.key),
    ).toEqual(["shared"]);
    expect(
      store.catalogDocumentPage("automation", "", 10).map((row) => row.key),
    ).toEqual(["only-here", "shared"]);
    // Deleting in one namespace leaves the other alone.
    put("workspace", "shared", 1, null);
    expect(store.catalogDocumentGet("automation", "shared")).toMatchObject({
      value: "automation doc",
    });
    // Import flags are per namespace too.
    store.markCatalogDocumentImportComplete("workspace");
    expect(store.catalogDocumentImportComplete("workspace")).toBe(true);
    expect(store.catalogDocumentImportComplete("automation")).toBe(false);
    // Marking twice is a no-op.
    store.markCatalogDocumentImportComplete("workspace");
    expect(store.catalogDocumentImportComplete("workspace")).toBe(true);
  });

  test("seeding never overwrites a live row or a tombstone", () => {
    put("workspace", "live", null, "committed");
    put("workspace", "gone", null, "was here");
    put("workspace", "gone", 1, null);
    store.seedCatalogDocuments("workspace", [
      { key: "live", value: "from file" },
      { key: "gone", value: "from file" },
      { key: "legacy", value: "from file" },
      { key: "legacy", value: "from file again" },
    ]);
    expect(store.catalogDocumentGet("workspace", "live")).toMatchObject({
      value: "committed",
      rev: 1,
    });
    expect(store.catalogDocumentGet("workspace", "gone")).toEqual({
      key: "gone",
      value: null,
      rev: 2,
    });
    expect(store.catalogDocumentGet("workspace", "legacy")).toEqual({
      key: "legacy",
      value: "from file",
      rev: 1,
    });
    // Re-seeding is a no-op and a seeded row is an ordinary revision-1 row.
    store.seedCatalogDocuments("workspace", [{ key: "legacy", value: "x" }]);
    expect(put("workspace", "legacy", 1, "edited")).toEqual({
      status: "committed",
      rev: 2,
    });
    expect(put("workspace", "legacy", null, "edited")).toMatchObject({
      status: "conflict",
    });
  });

  test("rejects unbounded or malformed requests before touching storage", () => {
    const bad = (request: CatalogDocumentRequest, pattern: RegExp) => {
      expect(() => {
        if (request.op === "put") store.putCatalogDocument(request);
        else if (request.op === "seed")
          store.seedCatalogDocuments(request.namespace, request.rows);
        else throw new Error("unexpected op");
      }).toThrow(pattern);
    };
    const base = {
      op: "put" as const,
      namespace: "workspace",
      key: "k",
      expectedRev: null,
      value: "v",
      requestId: "r",
    };
    bad({ ...base, namespace: "" }, /namespace/);
    bad({ ...base, namespace: "has space" }, /namespace/);
    bad({ ...base, namespace: "x".repeat(129) }, /namespace/);
    bad({ ...base, key: "" }, /key/);
    bad({ ...base, key: "x".repeat(513) }, /key/);
    bad({ ...base, key: "a\0b" }, /key/);
    bad({ ...base, requestId: "" }, /request id/);
    bad({ ...base, expectedRev: 0 }, /expected revision/);
    bad({ ...base, expectedRev: -1 }, /expected revision/);
    bad({ ...base, expectedRev: 1.5 }, /expected revision/);
    bad(
      { ...base, value: "x".repeat(CATALOG_DOCUMENT_MAX_VALUE_BYTES + 1) },
      /too large/,
    );
    bad(
      { ...base, value: 7 as unknown as string },
      /Invalid catalog document value/,
    );
    bad({ op: "seed", namespace: "workspace", rows: [] }, /seed batch/);
    bad(
      {
        op: "seed",
        namespace: "workspace",
        rows: Array.from(
          { length: CATALOG_DOCUMENT_SEED_LIMIT + 1 },
          (_, i) => ({ key: `k${i}`, value: "v" }),
        ),
      },
      /seed batch/,
    );
    bad(
      {
        op: "seed",
        namespace: "workspace",
        rows: [{ key: "k", value: null as unknown as string }],
      },
      /Seed document is required/,
    );
    expect(store.catalogDocumentGet("workspace", "k")).toBeNull();
    expect(CATALOG_DOCUMENT_PAGE_LIMIT).toBe(1_000);
  });

  test("a session tombstone or clear never touches catalog documents", () => {
    put("workspace", "s-1", null, "doc");
    store.tombstoneSession("s-1");
    store.clearSession("s-1");
    expect(store.catalogDocumentGet("workspace", "s-1")).toMatchObject({
      value: "doc",
      rev: 1,
    });
  });
});
