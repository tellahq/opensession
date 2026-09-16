import type { Database } from "bun:sqlite";
import { scopeFence, scopeRecord } from "./access-ledger";
import { catalogDocumentGet } from "./catalog-document-store";
import { repositoryCatalogGet } from "./repository-access-store";
import {
  personalRunConsumerKey,
  personalRunLineageKey,
  snapshotPersonalRunConsumer,
  type PersonalRunConsumer,
} from "../personal-run-identity";
import { validatePersonalRepositoryDescriptor } from "../personal-repository-identity";
import type { PersonalRepoBinding } from "../personal-repo-runtime";

export interface PrivateActorFence {
  sourceSessionId: string;
  owner: number;
  incarnation: string;
  generation: number;
  binding?: PersonalRepoBinding;
  consumer?: PersonalRunConsumer;
}
export interface ActorAccess {
  principal?: number;
  fence?: PrivateActorFence;
}

/** Run while the CENTRAL writer lock is held through the target actor commit.
 * A separately committed App deny/owner replacement cannot slip between this
 * check and a private write. No gateway callback/network work runs in this lock. */
export function assertPrivateActorFence(
  db: Database,
  targetId: string,
  fence: PrivateActorFence,
): void {
  const source = scopeRecord(db, fence.sourceSessionId),
    target = scopeRecord(db, targetId);
  if (
    !source ||
    source.deleted ||
    source.canonicalId !== fence.sourceSessionId ||
    source.owner !== fence.owner ||
    source.generation !== fence.generation ||
    !target ||
    target.deleted ||
    target.canonicalId !== targetId ||
    target.owner !== fence.owner ||
    scopeFence(db).incarnation !== fence.incarnation
  )
    throw new Error("Private actor source fence changed");
  const current = db
    .query("SELECT doc FROM session_kernel_metadata_catalog WHERE session_id=?")
    .get(target.canonicalId) as { doc: string } | null;
  const binding = current
    ? (JSON.parse(current.doc).personalRepo as PersonalRepoBinding | undefined)
    : undefined;
  if (binding) {
    if (!fence.binding || binding.registryId !== fence.binding.registryId)
      throw new Error("Private actor binding missing");
    const d = validatePersonalRepositoryDescriptor(fence.binding.descriptor);
    const repo = repositoryCatalogGet(db, fence.binding.registryId, {
      githubAccountId: fence.owner,
    });
    const doc = repo ? JSON.parse(repo.doc) : undefined;
    if (
      !doc ||
      doc.blocked !== false ||
      d.ownerGithubAccountId !== fence.owner ||
      [
        "ownerGithubAccountId",
        "appRecordId",
        "githubAppId",
        "installationId",
        "repositoryId",
        "repositoryOwnerGithubAccountId",
        "accessRevision",
      ].some(
        (key) =>
          doc.personalGithub?.[key] !==
          (d as unknown as Record<string, unknown>)[key],
      )
    )
      throw new Error("Private actor repository revoked or changed");
  }
  if (fence.consumer) {
    const consumer = snapshotPersonalRunConsumer(fence.consumer);
    if (
      consumer.sessionId !== fence.sourceSessionId ||
      consumer.binding.descriptor.ownerGithubAccountId !== fence.owner ||
      consumer.binding.registryId !== fence.binding?.registryId ||
      consumer.binding.descriptor.accessRevision !==
        fence.binding?.descriptor.accessRevision
    )
      throw new Error("Private actor consumer source mismatch");
    if (
      catalogDocumentGet(
        db,
        "personal_run_stop_intents_v1",
        personalRunLineageKey(consumer),
      )?.value ||
      catalogDocumentGet(
        db,
        "personal_run_retirements_v1",
        personalRunConsumerKey(consumer),
      )?.value
    )
      throw new Error("Private actor run stopped or retired");
    const enrolledRepository = repositoryCatalogGet(
      db,
      consumer.binding.registryId,
      { githubAccountId: fence.owner },
    );
    const enrolled = enrolledRepository
      ? JSON.parse(enrolledRepository.doc)
      : undefined;
    const key = personalRunConsumerKey(consumer);
    if (
      enrolled?.consumerSchema !== 1 ||
      !Array.isArray(enrolled.activeConsumers) ||
      !enrolled.activeConsumers.some(
        (entry: PersonalRunConsumer) => personalRunConsumerKey(entry) === key,
      )
    )
      throw new Error("Private actor consumer not enrolled");
  }
}
