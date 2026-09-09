/**
 * Central catalog documents.
 *
 * A namespace is a keyed set of opaque text documents that belongs to no
 * session: workspace and automation definitions, per-user overlays, and other
 * gateway state that used to live in files. Every row lives in the central
 * kernel database only. The kernel never opens a per-session actor database to
 * serve one of these requests, and the gateway never touches a file for them.
 *
 * Writes are compare-and-set on `rev` with request-id replay, exactly like
 * session metadata: a caller reads, mutates, and puts with the revision it
 * read. A conflict returns the committed truth so the caller re-applies on top
 * of it. Deletes are tombstones (`value: null`) that keep their revision, so a
 * concurrent writer that read the live row still conflicts instead of
 * resurrecting it.
 */

export type CatalogDocumentRecord = {
  key: string;
  /** Opaque document text. `null` is a tombstone: the key was deleted and the
   * row keeps its revision for compare-and-set. */
  value: string | null;
  rev: number;
};

export type CatalogDocumentSeedRow = { key: string; value: string };

export type CatalogDocumentRequest =
  | { op: "get"; namespace: string; key: string }
  /** One indexed lookup for a bounded key set. Missing keys are omitted,
   * tombstones are returned, rows come back ordered by key. */
  | { op: "get_many"; namespace: string; keys: string[] }
  /** Keys strictly after `afterKey` in byte order, tombstones included. Pass
   * `""` to start from the first key. */
  | { op: "page"; namespace: string; afterKey: string; limit: number }
  | {
      op: "put";
      namespace: string;
      key: string;
      /** Stored revision the caller mutated from; null when the caller
       * believes no row exists yet (a tombstone is a row). */
      expectedRev: number | null;
      /** `null` writes a tombstone. */
      value: string | null;
      /** Immutable per attempt; a replay with the same id returns the receipt. */
      requestId: string;
    }
  /** One-time import of file-backed rows. A key that already has a row,
   * whether live or tombstoned, is left alone: a live write always wins over
   * a historical import. */
  | { op: "seed"; namespace: string; rows: CatalogDocumentSeedRow[] }
  | { op: "import_complete"; namespace: string }
  | { op: "mark_import_complete"; namespace: string };

export type CatalogDocumentPutResult =
  | { status: "committed"; rev: number }
  | { status: "duplicate"; rev: number }
  | { status: "conflict"; current: CatalogDocumentRecord | null };

export type CatalogDocumentResult<T extends CatalogDocumentRequest> =
  T extends { op: "get" }
    ? CatalogDocumentRecord | null
    : T extends { op: "page" | "get_many" }
      ? CatalogDocumentRecord[]
      : T extends { op: "put" }
        ? CatalogDocumentPutResult
        : T extends { op: "import_complete" }
          ? boolean
          : void;

export const CATALOG_DOCUMENT_MAX_NAMESPACE_BYTES = 128;
export const CATALOG_DOCUMENT_MAX_KEY_BYTES = 512;
export const CATALOG_DOCUMENT_MAX_VALUE_BYTES = 4 * 1024 * 1024;
export const CATALOG_DOCUMENT_MAX_REQUEST_ID_BYTES = 256;
/** Request id stamped on seeded rows. Reserved: a put may not use it, or a
 * later replay check could mistake a seeded row for its own receipt. */
export const CATALOG_DOCUMENT_SEED_REQUEST_ID = "seed";
export const CATALOG_DOCUMENT_PAGE_LIMIT = 1_000;
/** A page stops early once the rows it carries reach this many key plus
 * value bytes; the first row is always returned so a page is never empty
 * while rows remain. Callers continue until they receive an empty page. */
export const CATALOG_DOCUMENT_MAX_PAGE_BYTES = 8 * 1024 * 1024;
export const CATALOG_DOCUMENT_GET_MANY_LIMIT = 1_000;
/** Total key bytes one get_many request may carry. */
export const CATALOG_DOCUMENT_MAX_GET_MANY_BYTES = 256 * 1024;
/** Total key plus value bytes one get_many response may carry. A partial
 * answer would be indistinguishable from missing keys, so an oversize set is
 * rejected instead; callers narrow the key batch. */
export const CATALOG_DOCUMENT_MAX_GET_MANY_RESPONSE_BYTES = 32 * 1024 * 1024;
export const CATALOG_DOCUMENT_SEED_LIMIT = 1_000;
/** Total document bytes one seed batch may carry. */
export const CATALOG_DOCUMENT_MAX_SEED_BATCH_BYTES = 32 * 1024 * 1024;

/** Printable ASCII without whitespace: namespaces are code-chosen identifiers
 * that also name the import flag row. */
const NAMESPACE_PATTERN = /^[\x21-\x7e]+$/;

export function isCatalogDocumentRead(
  request: CatalogDocumentRequest,
): boolean {
  return (
    request.op === "get" ||
    request.op === "get_many" ||
    request.op === "page" ||
    request.op === "import_complete"
  );
}

function assertNamespace(namespace: unknown): asserts namespace is string {
  if (
    typeof namespace !== "string" ||
    !namespace ||
    Buffer.byteLength(namespace) > CATALOG_DOCUMENT_MAX_NAMESPACE_BYTES ||
    !NAMESPACE_PATTERN.test(namespace)
  )
    throw new Error("Invalid catalog document namespace");
}

function assertKey(key: unknown, what = "key"): asserts key is string {
  if (
    typeof key !== "string" ||
    !key ||
    key.includes("\0") ||
    Buffer.byteLength(key) > CATALOG_DOCUMENT_MAX_KEY_BYTES
  )
    throw new Error(`Invalid catalog document ${what}`);
}

export function assertCatalogDocumentRequest(
  request: CatalogDocumentRequest,
): void {
  if (!request || typeof request !== "object")
    throw new Error("Invalid catalog document request");
  assertNamespace(request.namespace);
  switch (request.op) {
    case "get":
      assertKey(request.key);
      return;
    case "get_many": {
      if (
        !Array.isArray(request.keys) ||
        request.keys.length < 1 ||
        request.keys.length > CATALOG_DOCUMENT_GET_MANY_LIMIT
      )
        throw new Error("Invalid catalog document key batch");
      let bytes = 0;
      for (const key of request.keys) {
        assertKey(key);
        bytes += Buffer.byteLength(key);
        if (bytes > CATALOG_DOCUMENT_MAX_GET_MANY_BYTES)
          throw new Error("Catalog document key batch is too large");
      }
      return;
    }
    case "page":
      if (
        typeof request.afterKey !== "string" ||
        request.afterKey.includes("\0") ||
        Buffer.byteLength(request.afterKey) > CATALOG_DOCUMENT_MAX_KEY_BYTES
      )
        throw new Error("Invalid catalog document page cursor");
      if (
        !Number.isInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > CATALOG_DOCUMENT_PAGE_LIMIT
      )
        throw new Error("Invalid catalog document page size");
      return;
    case "put":
      assertKey(request.key);
      if (
        typeof request.requestId !== "string" ||
        !request.requestId ||
        Buffer.byteLength(request.requestId) >
          CATALOG_DOCUMENT_MAX_REQUEST_ID_BYTES
      )
        throw new Error("Invalid catalog document request id");
      if (request.requestId === CATALOG_DOCUMENT_SEED_REQUEST_ID)
        throw new Error("Reserved catalog document request id");
      if (
        request.expectedRev !== null &&
        (!Number.isInteger(request.expectedRev) || request.expectedRev < 1)
      )
        throw new Error("Invalid catalog document expected revision");
      if (request.value !== null) {
        if (typeof request.value !== "string")
          throw new Error("Invalid catalog document value");
        if (Buffer.byteLength(request.value) > CATALOG_DOCUMENT_MAX_VALUE_BYTES)
          throw new Error("Catalog document is too large");
      }
      return;
    case "seed": {
      if (
        !Array.isArray(request.rows) ||
        request.rows.length < 1 ||
        request.rows.length > CATALOG_DOCUMENT_SEED_LIMIT
      )
        throw new Error("Invalid catalog document seed batch");
      let bytes = 0;
      for (const row of request.rows) {
        if (!row || typeof row !== "object")
          throw new Error("Invalid catalog document seed row");
        assertKey(row.key, "seed key");
        if (typeof row.value !== "string")
          throw new Error(`Seed document is required for ${row.key}`);
        const size = Buffer.byteLength(row.value);
        if (size > CATALOG_DOCUMENT_MAX_VALUE_BYTES)
          throw new Error(`Seed document is too large for ${row.key}`);
        bytes += size;
        if (bytes > CATALOG_DOCUMENT_MAX_SEED_BATCH_BYTES)
          throw new Error("Catalog document seed batch is too large");
      }
      return;
    }
    case "import_complete":
    case "mark_import_complete":
      return;
    default:
      throw new Error(
        `Unknown catalog document op ${String((request as { op?: unknown }).op)}`,
      );
  }
}
