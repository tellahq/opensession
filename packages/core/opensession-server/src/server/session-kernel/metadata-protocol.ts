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
  /** JSON text of the session document. Opaque to the kernel. */
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

export type MetadataActorRequest =
  | { op: "get"; sessionId: string }
  | {
      op: "put";
      sessionId: string;
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
  | { op: "catalog_page"; afterSessionId: string; limit: number }
  | { op: "pending_exports"; limit: number }
  | { op: "catalog_complete" }
  | { op: "mark_catalog_complete" };

export type SessionMetadataPutResult =
  | { status: "committed"; rev: number }
  | { status: "duplicate"; rev: number }
  | { status: "conflict"; current: SessionMetadataRecord | null };

export type MetadataActorResult<T extends MetadataActorRequest> = T extends {
  op: "get";
}
  ? SessionMetadataRecord | null
  : T extends { op: "put" }
    ? SessionMetadataPutResult
    : T extends { op: "catalog_page" }
      ? SessionMetadataCatalogRow[]
      : T extends { op: "pending_exports" }
        ? Array<{ sessionId: string; rev: number; exportedRev: number }>
        : T extends { op: "catalog_complete" }
          ? boolean
          : void;

export const SESSION_METADATA_MAX_DOC_BYTES = 4 * 1024 * 1024;
export const SESSION_METADATA_CATALOG_PAGE_LIMIT = 1_000;

export function isMetadataRead(request: MetadataActorRequest): boolean {
  return (
    request.op === "get" ||
    request.op === "catalog_page" ||
    request.op === "pending_exports" ||
    request.op === "catalog_complete"
  );
}

/** Catalog-scoped requests never name a session; they read or mark the
 * central projection only. */
export function isMetadataCatalogRequest(
  request: MetadataActorRequest,
): boolean {
  return !("sessionId" in request);
}

export function assertMetadataActorRequest(
  request: MetadataActorRequest,
): void {
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
  if (request.op === "catalog_page" || request.op === "pending_exports") {
    if (
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > SESSION_METADATA_CATALOG_PAGE_LIMIT
    )
      throw new Error("Invalid session metadata catalog page size");
  }
}
