import {
  assertCreationAccessReservation,
  type CreationAccessReservation,
  type CreationAccessReservationResult,
} from "./creation-access-protocol";
import type { Database } from "bun:sqlite";
import { claimScope, scopeRecord } from "./access-ledger";
import {
  catalogDocumentGet,
  putCatalogDocument,
} from "./catalog-document-store";
import { repositoryCatalogGet } from "./repository-access-store";
import { sameAccessScope } from "../../shared/access-scope";
import type { PersonalRepoBinding } from "../personal-repo-runtime";

const NAMESPACE = "session_creation_access_v1";
const BINDING_KEYS = [
  "ownerGithubAccountId",
  "appRecordId",
  "githubAppId",
  "installationId",
  "repositoryId",
  "repositoryOwnerGithubAccountId",
  "accessRevision",
] as const;
function sameBinding(
  a: PersonalRepoBinding | undefined,
  b: PersonalRepoBinding | undefined,
): boolean {
  return (
    !!a &&
    !!b &&
    a.registryId === b.registryId &&
    BINDING_KEYS.every((key) => a.descriptor?.[key] === b.descriptor?.[key])
  );
}
/** Central worker transaction only: no actor opens, file export or caller-owned
 * cache participates in reserving an id. A losing caller learns no other intent. */
export function reserveCreationAccess(
  db: Database,
  input: CreationAccessReservation,
): CreationAccessReservationResult {
  assertCreationAccessReservation(input);
  return db
    .transaction(() => {
      const ledger = scopeRecord(db, input.sessionId);
      if (ledger?.deleted || (ledger && ledger.canonicalId !== input.sessionId))
        throw new Error("Session creation unavailable");
      const row = db
        .query(
          "SELECT doc FROM session_kernel_metadata_catalog WHERE session_id=?",
        )
        .get(input.sessionId) as { doc: string } | null;
      if (
        row &&
        (!sameAccessScope(JSON.parse(row.doc).accessScope, input.accessScope) ||
          (input.binding &&
            !sameBinding(JSON.parse(row.doc).personalRepo, input.binding)))
      )
        throw new Error("Session creation unavailable");
      if (input.binding) {
        const repo = repositoryCatalogGet(
          db,
          input.binding.registryId,
          input.principal,
        );
        const doc = repo ? JSON.parse(repo.doc) : undefined;
        if (
          !doc ||
          doc.blocked !== false ||
          !sameAccessScope(doc.accessScope, input.accessScope) ||
          !sameBinding(
            { registryId: repo!.repositoryId, descriptor: doc.personalGithub },
            input.binding,
          )
        )
          throw new Error("Private creation binding changed");
      }
      const previous = catalogDocumentGet(db, NAMESPACE, input.sessionId);
      if (previous) {
        if (!previous.value) throw new Error("Session creation unavailable");
        const intent = JSON.parse(previous.value);
        if (
          intent.createIdentity !== input.createIdentity ||
          !sameAccessScope(intent.accessScope, input.accessScope) ||
          (input.binding && !sameBinding(intent.binding, input.binding))
        )
          throw new Error("Session create intent changed");
        return {
          sessionId: input.sessionId,
          created: false,
          document: row?.doc ?? null,
        };
      }
      claimScope(
        db,
        input.sessionId,
        JSON.stringify({ accessScope: input.accessScope }),
      );
      const saved = putCatalogDocument(db, {
        op: "put",
        namespace: NAMESPACE,
        key: input.sessionId,
        expectedRev: null,
        requestId: `reserve:${input.createIdentity.slice(0, 160)}`,
        value: JSON.stringify({
          createIdentity: input.createIdentity,
          accessScope: input.accessScope,
          binding: input.binding,
        }),
      });
      if (saved.status === "conflict")
        throw new Error("Session create intent changed");
      let document = row?.doc ?? null;
      if (input.accessScope.kind === "personal" && !row) {
        const now = Date.now();
        document = JSON.stringify({
          id: input.sessionId,
          accessScope: input.accessScope,
          personalRepo: input.binding,
          personalCreateIdentity: input.createIdentity,
          repo: input.binding!.registryId,
          claudeSessionId: "",
          branch: "",
          worktreeDir: "",
          createdAt: new Date(now).toISOString(),
          title: input.defaults?.title?.slice(0, 2000),
          createdBy: input.defaults?.createdBy?.slice(0, 200),
          createdByLogin: input.defaults?.createdByLogin?.slice(0, 200),
          model: input.defaults?.model?.slice(0, 200),
        });
        db.run(
          "INSERT INTO session_kernel_metadata_catalog(session_id,doc,rev,exported_rev,archived,last_activity_ms,updated_at) VALUES (?,?,1,0,0,?,?)",
          [input.sessionId, document, now, now],
        );
      }
      return { sessionId: input.sessionId, created: true, document };
    })
    .immediate();
}
