import {
  assertCreationAccessReservation,
  type CreationAccessReservation,
  type CreationAccessReservationResult,
} from "./creation-access-protocol";
import type { ScopeFence, ScopeDelta, ScopeLedgerRow } from "./access-ledger";
import type {
  RepositoryAppPage,
  RepositoryCatalogPut,
  RepositoryCatalogPutResult,
  RepositoryCatalogRecord,
} from "./repository-access-store";
import {
  assertAccessPrincipal,
  isGithubAccountId,
  type AccessPrincipal,
} from "../../shared/access-scope";
/**
 * Session metadata ownership.
 *
 * The session document (title, model, workspace, activity, PR refs, ...) is a
 * per-session actor record: one writer, compare-and-set on `rev`, request-id
 * replay. Every committed document is also projected into the central kernel
 * catalog so list-shaped reads (sidebar, workspace groups, boot rebuilds) never
 * open a per-session actor database.
 *
 * The gateway keeps `<sessions dir>/<id>.json` as a derived export for out of
 * process readers (agents, scripts, run hosts). The catalog tracks which
 * revision reached that file so a crash between commit and export is repaired
 * from a bounded catalog work index instead of a directory scan.
 */

export type SessionMetadataRecord = {
  sessionId: string;
  /** JSON session document. The kernel interprets accessScope for authorization;
   * other metadata remains application-owned. */
  doc: string;
  rev: number;
  /** Index hints the writer supplies beside the opaque document. */
  archived: boolean;
  lastActivityMs: number;
  updatedAt: number;
};

export type SessionMetadataCatalogRow = SessionMetadataRecord & {
  /** Last revision the gateway confirmed it wrote to the export file. */
  exportedRev: number;
};

/** A historical session file projected into the catalog as-is. The file
 * already carries this revision, so the row starts fully exported. */
export type SessionMetadataSeedRow = {
  sessionId: string;
  doc: string;
  rev: number;
  archived: boolean;
  lastActivityMs: number;
};

export type MetadataActorRequest =
  | CreationAccessReservation
  | { op: "scope_fence" }
  | { op: "scope_lookup"; sessionId: string }
  | { op: "scope_changes"; after: number; limit: number }
  | { op: "scope_aliases"; rows: Array<{ id: string; aliases: string[] }> }
  | RepositoryAppPage
  | RepositoryCatalogPut
  | { op: "repository_get"; repositoryId: string; principal?: AccessPrincipal }
  | {
      op: "repository_page";
      afterRepositoryId: string;
      limit: number;
      principal?: AccessPrincipal;
    }
  | { op: "repository_count"; principal?: AccessPrincipal }
  | { op: "get"; sessionId: string; principal?: AccessPrincipal }
  | {
      op: "put";
      sessionId: string;
      principal?: AccessPrincipal;
      /** Immutable per attempt; a replay with the same id returns the receipt. */
      requestId: string;
      /** Stored revision the caller mutated from; null when the caller
       * believes no document exists yet (first write or lazy seed). */
      expectedRev: number | null;
      /** Revision this document carries. Must be `expectedRev + 1`, or any
       * positive integer when seeding. */
      rev: number;
      doc: string;
      /** Index hints the catalog keeps beside the opaque document. */
      archived: boolean;
      lastActivityMs: number;
    }
  | { op: "exported"; sessionId: string; rev: number }
  /** The committed document as the central catalog projects it. Serves a
   * detail read for one session without opening that session's actor
   * database; the catalog is written in the same lane pass as the commit, so
   * it is never behind the derived file. */
  | { op: "catalog_get"; sessionId: string; principal?: AccessPrincipal }
  | { op: "catalog_count"; principal?: AccessPrincipal }
  | { op: "catalog_read"; sessionId: string; principal?: AccessPrincipal }
  /** Operator seeding of sessions written before the actor owned metadata.
   * Central only; a session that already has a row is left alone, and the
   * actor document still materializes from the file on its first write. */
  | { op: "seed_catalog"; rows: SessionMetadataSeedRow[] }
  | {
      op: "catalog_page" | "catalog_private_page";
      afterSessionId: string;
      limit: number;
      principal?: AccessPrincipal;
    }
  | { op: "pending_exports"; limit: number }
  | { op: "catalog_complete" }
  | { op: "mark_catalog_complete" };

export type SessionMetadataReadResult =
  | { status: "found"; record: SessionMetadataCatalogRow; aliases: string[] }
  | { status: "missing" | "denied" | "deleted" };

export type SessionMetadataPutResult =
  | { status: "committed"; rev: number }
  | { status: "duplicate"; rev: number }
  | { status: "conflict"; current: SessionMetadataRecord | null };

export type MetadataActorResult<T extends MetadataActorRequest> = T extends {
  op: "reserve_creation";
}
  ? CreationAccessReservationResult
  : T extends { op: "scope_lookup" }
    ? ScopeLedgerRow | null
    : T extends {
          op: "scope_fence";
        }
      ? ScopeFence
      : T extends { op: "scope_changes" }
        ? ScopeDelta
        : T extends {
              op: "catalog_read";
            }
          ? SessionMetadataReadResult
          : T extends {
                op: "repository_get";
              }
            ? RepositoryCatalogRecord | null
            : T extends { op: "repository_page" | "repository_app_page" }
              ? RepositoryCatalogRecord[]
              : T extends { op: "repository_count" }
                ? number
                : T extends { op: "repository_put" }
                  ? RepositoryCatalogPutResult
                  : T extends {
                        op: "get";
                      }
                    ? SessionMetadataRecord | null
                    : T extends { op: "put" }
                      ? SessionMetadataPutResult
                      : T extends { op: "catalog_get" }
                        ? SessionMetadataCatalogRow | null
                        : T extends { op: "catalog_count" }
                          ? number
                          : T extends { op: "seed_catalog" }
                            ? number
                            : T extends {
                                  op: "catalog_page" | "catalog_private_page";
                                }
                              ? SessionMetadataCatalogRow[]
                              : T extends { op: "pending_exports" }
                                ? Array<{
                                    sessionId: string;
                                    rev: number;
                                    exportedRev: number;
                                  }>
                                : T extends { op: "catalog_complete" }
                                  ? boolean
                                  : void;

export const SESSION_METADATA_MAX_DOC_BYTES = 4 * 1024 * 1024;
export const SESSION_METADATA_CATALOG_PAGE_LIMIT = 1_000;

export function isMetadataRead(request: MetadataActorRequest): boolean {
  return (
    request.op === "scope_fence" ||
    request.op === "scope_lookup" ||
    request.op === "scope_changes" ||
    request.op === "repository_get" ||
    request.op === "repository_app_page" ||
    request.op === "repository_page" ||
    request.op === "repository_count" ||
    request.op === "get" ||
    request.op === "catalog_get" ||
    request.op === "catalog_read" ||
    request.op === "catalog_count" ||
    request.op === "catalog_page" ||
    request.op === "catalog_private_page" ||
    request.op === "pending_exports" ||
    request.op === "catalog_complete"
  );
}

/** Catalog-scoped requests read or mark the central projection only and
 * never touch a session actor, whether or not they name a session. */
export function isMetadataCatalogRequest(
  request: MetadataActorRequest,
): boolean {
  return (
    request.op === "reserve_creation" ||
    request.op === "scope_lookup" ||
    request.op === "catalog_get" ||
    request.op === "catalog_read" ||
    !("sessionId" in request)
  );
}

export function assertMetadataActorRequest(
  request: MetadataActorRequest,
): void {
  if (request.op === "reserve_creation")
    assertCreationAccessReservation(request);
  if (
    request.op === "scope_changes" &&
    (!Number.isSafeInteger(request.after) ||
      request.after < 0 ||
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 1000)
  )
    throw new Error("Invalid scope delta request");
  if (
    request.op === "repository_app_page" &&
    (!isGithubAccountId(request.ownerGithubAccountId) ||
      (request.appRecordId !== null &&
        (typeof request.appRecordId !== "string" ||
          !request.appRecordId ||
          request.appRecordId.length > 256)) ||
      typeof request.afterRepositoryId !== "string")
  )
    throw new Error("Invalid repository App query");
  if (request.op === "scope_aliases") {
    if (!Array.isArray(request.rows) || request.rows.length > 1000)
      throw new Error("Invalid scope alias batch");
    for (const row of request.rows) {
      if (
        typeof row.id !== "string" ||
        !row.id ||
        row.id.length > 256 ||
        !Array.isArray(row.aliases) ||
        row.aliases.length > 64 ||
        row.aliases.some(
          (id) => typeof id !== "string" || !id || id.length > 256,
        )
      )
        throw new Error("Invalid session alias");
    }
  }

  if ("principal" in request) assertAccessPrincipal(request.principal);
  if (request.op === "catalog_private_page" && !request.principal)
    throw new Error("Private catalog principal required");
  if (
    "repositoryId" in request &&
    (typeof request.repositoryId !== "string" ||
      !request.repositoryId ||
      request.repositoryId.length > 256)
  )
    throw new Error("Invalid repository id");
  if (request.op === "repository_put") {
    if (
      typeof request.doc !== "string" ||
      !request.doc ||
      Buffer.byteLength(request.doc) > SESSION_METADATA_MAX_DOC_BYTES
    )
      throw new Error("Invalid repository document");
    if (
      request.expectedRev !== null &&
      (!Number.isSafeInteger(request.expectedRev) || request.expectedRev < 1)
    )
      throw new Error("Invalid repository revision");
  }
  if (
    request.op === "repository_page" &&
    typeof request.afterRepositoryId !== "string"
  )
    throw new Error("Invalid repository cursor");
  if (
    request.op === "catalog_get" ||
    request.op === "catalog_page" ||
    request.op === "catalog_private_page" ||
    request.op === "catalog_count"
  )
    assertAccessPrincipal(request.principal);
  if ("sessionId" in request) {
    if (typeof request.sessionId !== "string" || !request.sessionId)
      throw new Error("Session metadata request requires a session id");
  }
  if (request.op === "put") {
    if (
      typeof request.requestId !== "string" ||
      !request.requestId ||
      request.requestId.length > 256
    )
      throw new Error("Invalid session metadata request id");
    if (
      request.expectedRev !== null &&
      (!Number.isInteger(request.expectedRev) || request.expectedRev < 0)
    )
      throw new Error("Invalid session metadata expected revision");
    if (!Number.isInteger(request.rev) || request.rev < 1)
      throw new Error("Invalid session metadata revision");
    if (request.expectedRev !== null && request.rev !== request.expectedRev + 1)
      throw new Error("Session metadata revision must advance by one");
    if (typeof request.doc !== "string" || !request.doc)
      throw new Error("Session metadata document is required");
    if (Buffer.byteLength(request.doc) > SESSION_METADATA_MAX_DOC_BYTES)
      throw new Error("Session metadata document is too large");
    if (!Number.isInteger(request.lastActivityMs) || request.lastActivityMs < 0)
      throw new Error("Invalid session metadata activity timestamp");
  }
  if (request.op === "exported") {
    if (!Number.isInteger(request.rev) || request.rev < 1)
      throw new Error("Invalid session metadata export revision");
  }
  if (request.op === "seed_catalog") {
    if (
      !Array.isArray(request.rows) ||
      request.rows.length < 1 ||
      request.rows.length > SESSION_METADATA_CATALOG_PAGE_LIMIT
    )
      throw new Error("Invalid session metadata seed batch");
    for (const row of request.rows) {
      if (typeof row.sessionId !== "string" || !row.sessionId)
        throw new Error("Session metadata seed row requires a session id");
      if (!Number.isInteger(row.rev) || row.rev < 1)
        throw new Error(`Invalid seed revision for ${row.sessionId}`);
      if (typeof row.doc !== "string" || !row.doc)
        throw new Error(`Seed document is required for ${row.sessionId}`);
      if (Buffer.byteLength(row.doc) > SESSION_METADATA_MAX_DOC_BYTES)
        throw new Error(`Seed document is too large for ${row.sessionId}`);
      if (!Number.isInteger(row.lastActivityMs) || row.lastActivityMs < 0)
        throw new Error(`Invalid seed activity timestamp for ${row.sessionId}`);
    }
  }
  if (
    request.op === "catalog_page" ||
    request.op === "catalog_private_page" ||
    request.op === "pending_exports" ||
    request.op === "repository_page" ||
    request.op === "repository_app_page"
  ) {
    if (
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > SESSION_METADATA_CATALOG_PAGE_LIMIT
    )
      throw new Error("Invalid session metadata catalog page size");
  }
}
