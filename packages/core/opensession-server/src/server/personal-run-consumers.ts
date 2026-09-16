import {
  personalRunConsumerKey,
  personalRunLineageKey,
  snapshotPersonalRunConsumer,
  type PersonalRunConsumer,
} from "./personal-run-identity";
export {
  personalRunConsumerKey,
  personalRunLineageKey,
  snapshotPersonalRunConsumer,
  type PersonalRunConsumer,
} from "./personal-run-identity";
import { sessionMetadata, sessionCatalogDocument } from "./session-kernel";
import {
  samePersonalRepoBinding,
  type PersonalRepoBinding,
} from "./personal-repo-runtime";
import type { PersonalAppRef } from "./personal-github/broker";
import {
  personalRepositoryId,
  validatePersonalRepositoryDescriptor,
  type PersonalRepositoryConsumers,
} from "./personal-repository-coordinator";
import {
  revokeSessionPublications,
  currentPrivateActorFence,
  sessionAudiencesReady,
} from "./session-audience";
const RETIREMENTS = "personal_run_retirements_v1";
const STOP_INTENTS = "personal_run_stop_intents_v1";
const MAX_CONSUMERS = 128;
function same(a: PersonalRunConsumer, b: PersonalRunConsumer) {
  return personalRunConsumerKey(a) === personalRunConsumerKey(b);
}

async function marked(
  namespace: string,
  input: PersonalRunConsumer,
): Promise<boolean> {
  const row = await sessionCatalogDocument({
    op: "get",
    namespace,
    key:
      namespace === STOP_INTENTS
        ? personalRunLineageKey(input)
        : personalRunConsumerKey(input),
  });
  if (!row?.value) return false;
  if (
    namespace === STOP_INTENTS
      ? personalRunLineageKey(JSON.parse(row.value)) !==
        personalRunLineageKey(input)
      : !same(JSON.parse(row.value), input)
  )
    throw new Error("Private retirement identity mismatch");
  return true;
}
async function mark(
  namespace: string,
  input: PersonalRunConsumer,
): Promise<void> {
  const snapshot = snapshotPersonalRunConsumer(input),
    key =
      namespace === STOP_INTENTS
        ? personalRunLineageKey(snapshot)
        : personalRunConsumerKey(snapshot);
  const result = await sessionCatalogDocument({
    op: "put",
    namespace,
    key,
    expectedRev: null,
    value: JSON.stringify(snapshot),
    requestId: `${namespace}:${key}`,
  });
  if (result.status === "conflict" && !(await marked(namespace, snapshot)))
    throw new Error("Private retirement conflict");
}
/** Durable no-relaunch intent is NOT proof of physical completion. */
export async function personalRunRetired(
  input: PersonalRunConsumer,
): Promise<boolean> {
  return (
    (await marked(STOP_INTENTS, input)) || (await marked(RETIREMENTS, input))
  );
}
export function personalRunRetirementConfirmed(
  input: PersonalRunConsumer,
): Promise<boolean> {
  return marked(RETIREMENTS, input);
}
export function requestPersonalRunRetirement(
  input: PersonalRunConsumer,
): Promise<void> {
  return mark(STOP_INTENTS, input);
}

async function repository(binding: PersonalRepoBinding) {
  const d = validatePersonalRepositoryDescriptor(binding.descriptor);
  const row = await sessionMetadata({
    op: "repository_get",
    repositoryId: binding.registryId,
    principal: { githubAccountId: d.ownerGithubAccountId },
  });
  if (!row) throw new Error("Private consumer repository unavailable");
  const doc = JSON.parse(row.doc);
  const actual = validatePersonalRepositoryDescriptor(doc.personalGithub);
  if (
    doc.id !== binding.registryId ||
    doc.accessScope?.kind !== "personal" ||
    doc.accessScope.ownerGithubAccountId !== d.ownerGithubAccountId ||
    typeof doc.blocked !== "boolean" ||
    actual.ownerGithubAccountId !== d.ownerGithubAccountId ||
    actual.appRecordId !== d.appRecordId ||
    actual.githubAppId !== d.githubAppId ||
    actual.repositoryId !== d.repositoryId
  )
    throw new Error("Private consumer repository ownership mismatch");
  if (
    doc.consumerSchema !== 1 ||
    !Array.isArray(doc.activeConsumers) ||
    doc.activeConsumers.length > MAX_CONSUMERS
  )
    throw new Error("Unknown private consumer schema");
  for (const item of doc.activeConsumers)
    if (
      snapshotPersonalRunConsumer(item).binding.registryId !==
      binding.registryId
    )
      throw new Error("Private consumer crossed registry ownership");
  return {
    row,
    doc: doc as {
      [key: string]: unknown;
      personalGithub: PersonalRepoBinding["descriptor"];
      blocked: boolean;
      activeConsumers: PersonalRunConsumer[];
    },
  };
}
/** Enrollment and App deny compete on the SAME repository revision. */
export async function registerPersonalRunConsumer(
  input: PersonalRunConsumer,
): Promise<void> {
  const original = currentPrivateActorFence();
  if (
    !original ||
    original.sourceSessionId !== input.sessionId ||
    original.owner !== input.binding.descriptor.ownerGithubAccountId
  )
    throw new Error("Private enrollment source authority unavailable");
  const consumer = snapshotPersonalRunConsumer({
    ...input,
    sourceAuthority: {
      incarnation: original.incarnation,
      generation: original.generation,
    },
  });
  const source = await sessionMetadata({
    op: "catalog_read",
    sessionId: consumer.sessionId,
    principal: {
      githubAccountId: consumer.binding.descriptor.ownerGithubAccountId,
    },
  });
  const doc =
    source.status === "found" ? JSON.parse(source.record.doc) : undefined;
  if (
    !doc ||
    source.status !== "found" ||
    source.record.sessionId !== consumer.sessionId ||
    doc.accessScope?.kind !== "personal" ||
    doc.accessScope.ownerGithubAccountId !==
      consumer.binding.descriptor.ownerGithubAccountId ||
    doc.repo !== consumer.binding.registryId ||
    !doc.personalRepo ||
    personalRunConsumerKey({ ...consumer, binding: doc.personalRepo }) !==
      personalRunConsumerKey(consumer)
  )
    throw new Error("Private consumer session ownership mismatch");
  if (await personalRunRetired(consumer))
    throw new Error("Private run cannot relaunch");
  for (let attempt = 0; attempt < 8; attempt++) {
    const { row, doc } = await repository(consumer.binding);
    if (
      doc.blocked ||
      doc.personalGithub.accessRevision !==
        consumer.binding.descriptor.accessRevision
    )
      throw new Error("Private repository revoked or changed");
    const existing = doc.activeConsumers.find(
      (item) =>
        item.runKey === consumer.runKey && item.hostId === consumer.hostId,
    );
    if (existing) {
      if (
        !same(existing, consumer) ||
        JSON.stringify(existing.sourceAuthority) !==
          JSON.stringify(consumer.sourceAuthority)
      )
        throw new Error("Private run identity changed");
      if (await personalRunRetired(consumer))
        throw new Error("Private run cannot relaunch");
      return;
    }
    if (
      doc.activeConsumers.some(
        (item) =>
          item.runKey === consumer.runKey &&
          personalRunLineageKey(item) !== personalRunLineageKey(consumer),
      )
    )
      throw new Error("Private logical lineage changed");
    const predecessor = doc.activeConsumers.find(
      (item) => personalRunLineageKey(item) === personalRunLineageKey(consumer),
    );
    if (
      predecessor &&
      JSON.stringify(predecessor.sourceAuthority) !==
        JSON.stringify(consumer.sourceAuthority)
    )
      throw new Error("Private successor cannot renew source authority");
    if (doc.activeConsumers.length >= MAX_CONSUMERS)
      throw new Error("Private consumer limit exceeded");
    const result = await sessionMetadata({
      op: "repository_put",
      repositoryId: row.repositoryId,
      principal: {
        githubAccountId: consumer.binding.descriptor.ownerGithubAccountId,
      },
      expectedRev: row.rev,
      doc: JSON.stringify({
        ...doc,
        activeConsumers: [...doc.activeConsumers, consumer],
      }),
      enrollmentSource: original,
    });
    if (result.status === "committed") {
      if (await personalRunRetired(consumer))
        throw new Error("Private run cannot relaunch");
      return;
    }
  }
  throw new Error("Private enrollment changed concurrently");
}

/** Only call after positive physical completion/absence. Confirmation commits
 * before active enrollment removal; failed cleanup never authorizes relaunch.
 * No competing async rewrite of the legacy journal file is introduced. */
export async function confirmPersonalRunPhysicalCompletion(
  input: PersonalRunConsumer,
): Promise<void> {
  const consumer = snapshotPersonalRunConsumer(input);
  if (!(await personalRunRetirementConfirmed(consumer))) {
    const { doc } = await repository(consumer.binding);
    if (!doc.activeConsumers.some((item) => same(item, consumer)))
      throw new Error("Unknown private run consumer");
    await mark(RETIREMENTS, consumer);
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const { row, doc } = await repository(consumer.binding);
    const remaining = doc.activeConsumers.filter(
      (item) => !same(item, consumer),
    );
    if (remaining.length === doc.activeConsumers.length) return;
    const result = await sessionMetadata({
      op: "repository_put",
      repositoryId: row.repositoryId,
      principal: {
        githubAccountId: consumer.binding.descriptor.ownerGithubAccountId,
      },
      expectedRev: row.rev,
      doc: JSON.stringify({ ...doc, activeConsumers: remaining }),
    });
    if (result.status === "committed") return;
  }
  throw new Error("Private retirement cleanup changed concurrently");
}
export interface PersonalConsumerControl {
  assertRuntimeReady(): Promise<void>;
  /** Must prove THIS host/token completed or is physically absent, not merely
   * a cancel dispatch/latch, missing socket or an empty busy cache. */
  cancelAndConfirm(consumer: PersonalRunConsumer): Promise<void>;
}
/** Real control is required. No no-op readiness or revocation defaults. */
export function createPersonalRepositoryConsumers(
  control: PersonalConsumerControl,
): PersonalRepositoryConsumers {
  async function collect(ref: PersonalAppRef, ids: readonly string[]) {
    const consumers: PersonalRunConsumer[] = [];
    for (const registryId of ids) {
      const row = await sessionMetadata({
        op: "repository_get",
        repositoryId: registryId,
        principal: { githubAccountId: ref.ownerGithubAccountId },
      });
      if (!row) throw new Error("Missing private consumer registry");
      const descriptor = validatePersonalRepositoryDescriptor(
        JSON.parse(row.doc).personalGithub,
      );
      if (
        descriptor.ownerGithubAccountId !== ref.ownerGithubAccountId ||
        descriptor.appRecordId !== ref.recordId
      )
        throw new Error("Private consumer App mismatch");
      const { doc } = await repository({ registryId, descriptor });
      if (!doc.blocked) throw new Error("Private deny barrier missing");
      consumers.push(...doc.activeConsumers);
    }
    return consumers;
  }
  async function drainRepository(ref: PersonalAppRef, id: string) {
    const consumers = await collect(ref, [id]);
    for (const consumer of consumers)
      await requestPersonalRunRetirement(consumer);
    revokeSessionPublications(consumers.map((consumer) => consumer.sessionId));
    let failure: unknown;
    for (let offset = 0; offset < consumers.length; offset += 4) {
      const results = await Promise.allSettled(
        consumers.slice(offset, offset + 4).map(async (consumer) => {
          if (!(await personalRunRetirementConfirmed(consumer)))
            await control.cancelAndConfirm(consumer);
          await retirePersonalRunConsumer(consumer);
        }),
      );
      for (const result of results)
        if (result.status === "rejected") failure ??= result.reason;
    }
    if (failure) throw failure;
    if ((await collect(ref, [id])).length)
      throw new Error("Private cleanup enrollment remains");
  }
  async function drain(ref: PersonalAppRef, ids: readonly string[]) {
    let failure: unknown;
    for (const id of ids) {
      try {
        await drainRepository(ref, id);
      } catch (error) {
        failure ??= error;
      }
    }
    // Make progress across known repositories even if one unknown consumer
    // cannot yet be proved stopped. No admitted aggregate can exceed a drain cap.
    if (failure) throw failure;
  }
  return {
    async assertReady() {
      if (!sessionAudiencesReady())
        throw new Error("Private audiences not initialized");
      await control.assertRuntimeReady();
    },
    revoke: drain,
    async reconcile(ref, retained, revoked) {
      await drain(ref, [
        ...retained.map((binding) => binding.registryId),
        ...revoked,
      ]);
    },
  };
}

export async function assertPersonalRunConsumerEnrolled(
  input: PersonalRunConsumer,
): Promise<void> {
  const consumer = snapshotPersonalRunConsumer(input);
  const { doc } = await repository(consumer.binding);
  if (!doc.activeConsumers.some((item) => same(item, consumer)))
    throw new Error("Unknown private run consumer");
}

/** Terminal logical completion/Stop. Retiring one absent host before an
 * authorized respawn uses confirmPersonalRunPhysicalCompletion instead. */
export async function retirePersonalRunConsumer(
  input: PersonalRunConsumer,
): Promise<void> {
  const consumer = snapshotPersonalRunConsumer(input);
  if (!(await personalRunRetirementConfirmed(consumer)))
    await assertPersonalRunConsumerEnrolled(consumer);
  await requestPersonalRunRetirement(consumer);
  await confirmPersonalRunPhysicalCompletion(consumer);
}

export async function personalRunRecoverySource(input: PersonalRunConsumer) {
  const consumer = snapshotPersonalRunConsumer(input);
  await assertPersonalRunConsumerEnrolled(consumer);
  if (await personalRunRetired(consumer))
    throw new Error("Private recovery source retired");
  const { doc } = await repository(consumer.binding);
  if (
    doc.blocked ||
    !samePersonalRepoBinding(consumer.binding, {
      registryId: consumer.binding.registryId,
      descriptor: doc.personalGithub,
    })
  )
    throw new Error("Private recovery repository authority changed");
  const enrolled = doc.activeConsumers.find((item) => same(item, consumer));
  if (!enrolled?.sourceAuthority)
    throw new Error("Private recovery source authority unavailable");
  const authority = enrolled.sourceAuthority;
  const scope = await sessionMetadata({
    op: "scope_lookup",
    sessionId: consumer.sessionId,
  });
  const clock = await sessionMetadata({ op: "scope_fence" });
  if (
    !scope ||
    scope.deleted ||
    scope.canonicalId !== consumer.sessionId ||
    scope.owner !== consumer.binding.descriptor.ownerGithubAccountId ||
    scope.generation !== authority.generation ||
    clock.incarnation !== authority.incarnation
  )
    throw new Error("Private recovery source authority changed");
  return Object.freeze({
    sourceSessionId: consumer.sessionId,
    owner: consumer.binding.descriptor.ownerGithubAccountId,
    incarnation: authority.incarnation,
    generation: authority.generation,
    binding: consumer.binding,
    consumer: snapshotPersonalRunConsumer(enrolled),
  });
}

/** Original enrollment is authority; current catalog can only invalidate it. */
export async function bindPersonalRunRecovery<A extends unknown[], R>(
  input: PersonalRunConsumer,
  work: (...args: A) => R,
  signal?: AbortSignal,
): Promise<(...args: A) => R> {
  const source = await personalRunRecoverySource(input);
  const { bindSessionPublication } = await import("./session-audience");
  const { bindSessionExecutionAccess } = await import("./application-access");
  const run = bindSessionExecutionAccess(
    {
      id: source.sourceSessionId,
      accessScope: { kind: "personal", ownerGithubAccountId: source.owner },
      personalRepo: source.binding,
    },
    work,
  );
  return bindSessionPublication(
    source.sourceSessionId,
    source.owner,
    (...args: A) => {
      const current = currentPrivateActorFence();
      if (
        !current ||
        current.incarnation !== source.incarnation ||
        current.generation !== source.generation
      )
        throw new Error("Private recovery source authority changed");
      return run(...args);
    },
    { binding: source.binding, consumer: source.consumer, signal },
  );
}
