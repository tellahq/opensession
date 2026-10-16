import {
  assertPrivateActorFence,
  type PrivateActorFence,
} from "./private-access";
import {
  personalRunConsumerKey,
  personalRunLineageKey,
} from "../personal-run-identity";
/** Authoritative repository registry in the central catalog. These functions
 * run only on catalog workers; never import this module into the gateway. */
import type { Database } from "bun:sqlite";
import {
  canonicalAccessDocument,
  canonicalizeAccessTable,
} from "../canonical-access-document";
import {
  canAccessScope,
  parseAccessScope,
  sameAccessScope,
  type AccessPrincipal,
} from "../../shared/access-scope";
import { accessOwnerSql, accessPredicateSql } from "../access-scope-sql";

export type RepositoryCatalogRecord = {
  repositoryId: string;
  doc: string;
  rev: number;
};
export type RepositoryCatalogPut = {
  op: "repository_put";
  repositoryId: string;
  doc: string;
  expectedRev: number | null;
  principal?: AccessPrincipal;
  enrollmentSource?: PrivateActorFence;
};
export type RepositoryCatalogPutResult =
  | { status: "committed"; rev: number }
  | { status: "conflict"; current: RepositoryCatalogRecord | null };

export function migrateRepositoryCatalogSchema35(
  db: Database,
  schemaVersion: number,
): void {
  if (schemaVersion >= 35) return;
  db.transaction(() => {
    canonicalizeAccessTable(db, "session_kernel_metadata", "doc");
    canonicalizeAccessTable(db, "session_kernel_metadata_catalog", "doc");
    db.exec(`CREATE TABLE IF NOT EXISTS session_kernel_repository_catalog (
      repository_id TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      rev INTEGER NOT NULL CHECK(rev >= 1)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_repository_catalog_owner
      ON session_kernel_repository_catalog(${accessOwnerSql("doc")}, repository_id);
    CREATE INDEX IF NOT EXISTS idx_metadata_catalog_owner
      ON session_kernel_metadata_catalog(${accessOwnerSql("doc")}, session_id);
    PRAGMA user_version = 35;`);
  }).immediate();
}

function record(
  row: { repository_id: string; doc: string; rev: number } | null,
): RepositoryCatalogRecord | null {
  return row
    ? { repositoryId: row.repository_id, doc: row.doc, rev: row.rev }
    : null;
}

export function repositoryCatalogGet(
  db: Database,
  repositoryId: string,
  principal?: AccessPrincipal,
): RepositoryCatalogRecord | null {
  return record(
    db
      .query(`SELECT repository_id, doc, rev FROM session_kernel_repository_catalog
    WHERE repository_id = ? AND ${accessPredicateSql("doc", principal)}`)
      .get(repositoryId) as Parameters<typeof record>[0],
  );
}

export function repositoryCatalogPage(
  db: Database,
  afterRepositoryId: string,
  limit: number,
  principal?: AccessPrincipal,
): RepositoryCatalogRecord[] {
  const rows = db
    .query(`SELECT repository_id, doc, rev FROM session_kernel_repository_catalog
    WHERE repository_id > ? AND ${accessPredicateSql("doc", principal)} ORDER BY repository_id LIMIT ?`)
    .all(afterRepositoryId, limit) as Array<
    NonNullable<Parameters<typeof record>[0]>
  >;
  return rows.map((row) => record(row)!);
}

export function repositoryCatalogCount(
  db: Database,
  principal?: AccessPrincipal,
): number {
  return (
    db
      .query(`SELECT count(*) AS n FROM session_kernel_repository_catalog
    WHERE ${accessPredicateSql("doc", principal)}`)
      .get() as { n: number }
  ).n;
}

/** No conflict response may reveal another owner's exact-id record. Scope
 * cannot be removed or transferred by an old client, callback or recovery. */
export function repositoryCatalogPut(
  db: Database,
  input: RepositoryCatalogPut,
): RepositoryCatalogPutResult {
  const next = JSON.parse(canonicalAccessDocument(db, input.doc));
  if (
    !next ||
    typeof next !== "object" ||
    Array.isArray(next) ||
    !parseAccessScope(next.accessScope)
  )
    throw new Error("Invalid repository access scope");
  if (!canAccessScope(next.accessScope, input.principal))
    throw new Error("Repository not found");
  return db
    .transaction((): RepositoryCatalogPutResult => {
      const current = record(
        db
          .query(
            "SELECT repository_id, doc, rev FROM session_kernel_repository_catalog WHERE repository_id = ?",
          )
          .get(input.repositoryId) as Parameters<typeof record>[0],
      );
      if (current) {
        const previous = JSON.parse(current.doc);
        if (!canAccessScope(previous.accessScope, input.principal))
          throw new Error("Repository not found");
        if (!sameAccessScope(previous.accessScope, next.accessScope))
          throw new Error("Repository access scope is immutable");
      }
      if ((current?.rev ?? null) !== input.expectedRev)
        return { status: "conflict", current };
      const previousConsumers = current
        ? (JSON.parse(current.doc).activeConsumers ?? [])
        : [];
      const exact = new Map<
        string,
        import("../personal-run-identity").PersonalRunConsumer
      >();
      const lineages = new Map<
        string,
        import("../personal-run-identity").PersonalRunConsumer
      >();
      for (const previous of previousConsumers) {
        exact.set(personalRunConsumerKey(previous), previous);
        lineages.set(personalRunLineageKey(previous), previous);
      }
      for (const consumer of next.activeConsumers ?? []) {
        const previous = exact.get(personalRunConsumerKey(consumer));
        const lineage = lineages.get(personalRunLineageKey(consumer));
        const prior = previous ?? lineage;
        if (prior) {
          if (
            JSON.stringify(prior.sourceAuthority) !==
            JSON.stringify(consumer.sourceAuthority)
          )
            throw new Error("Private enrollment authority immutable");
        }
        if (!previous && consumer.sourceAuthority) {
          const source = input.enrollmentSource;
          if (
            !source ||
            source.sourceSessionId !== consumer.sessionId ||
            source.owner !== consumer.binding.descriptor.ownerGithubAccountId ||
            !source.binding ||
            personalRunConsumerKey({ ...consumer, binding: source.binding }) !==
              personalRunConsumerKey(consumer) ||
            source.incarnation !== consumer.sourceAuthority.incarnation ||
            source.generation !== consumer.sourceAuthority.generation
          )
            throw new Error("Private enrollment source missing");
          assertPrivateActorFence(db, consumer.sessionId, source);
        }
      }
      const rev = (current?.rev ?? 0) + 1;
      db.run(
        `INSERT INTO session_kernel_repository_catalog(repository_id, doc, rev) VALUES (?, ?, ?)
      ON CONFLICT(repository_id) DO UPDATE SET doc = excluded.doc, rev = excluded.rev`,
        [input.repositoryId, JSON.stringify(next), rev],
      );
      return { status: "committed", rev };
    })
    .immediate();
}

export type RepositoryAppPage = {
  op: "repository_app_page";
  ownerGithubAccountId: number;
  appRecordId: string | null;
  afterRepositoryId: string;
  limit: number;
};

export function migrateRepositoryBindingsSchema37(
  db: Database,
  version: number,
): void {
  if (version >= 37) return;
  db.transaction(() => {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_repository_catalog_app
      ON session_kernel_repository_catalog(${accessOwnerSql("doc")}, json_extract(doc, '$.personalGithub.appRecordId'), repository_id);
      PRAGMA user_version = 37;`);
  }).immediate();
}

/** Exact owner + App index, never an instance-wide or per-actor scan. */
export function repositoryCatalogAppPage(
  db: Database,
  input: RepositoryAppPage,
): RepositoryCatalogRecord[] {
  return (
    db
      .query(`SELECT repository_id, doc, rev FROM session_kernel_repository_catalog
    WHERE ${accessOwnerSql("doc")} = ? ${input.appRecordId === null ? "" : "AND json_extract(doc, '$.personalGithub.appRecordId') = ?"}
      AND repository_id > ? ORDER BY repository_id LIMIT ?`)
      .all(
        input.ownerGithubAccountId,
        ...(input.appRecordId === null ? [] : [input.appRecordId]),
        input.afterRepositoryId,
        input.limit,
      ) as Array<NonNullable<Parameters<typeof record>[0]>>
  ).map((row) => record(row)!);
}
