import {
  personalRepositoryId,
  validatePersonalRepositoryDescriptor,
} from "./personal-repository-identity";
export {
  personalRepositoryId,
  validatePersonalRepositoryDescriptor,
} from "./personal-repository-identity";
import { isGithubAccountId, sameAccessScope } from "../shared/access-scope";
import type { PersonalRepositoryDescriptor } from "./personal-github/types";
import type { PersonalAppRef } from "./personal-github/broker";
import { sessionMetadata } from "./session-kernel";
import { stateContext } from "./paths";
import type { RepositoryCatalogRecord } from "./session-kernel/repository-access-store";

export interface PersonalRepositoryBinding {
  readonly registryId: string;
  readonly descriptor: PersonalRepositoryDescriptor;
}

/** Gateway-owned acknowledgments, not callbacks that re-enter the broker's
 * owner mutation lane. Unknown consumers or incomplete shutdown must reject. */
export interface PersonalRepositoryConsumers {
  assertReady(): Promise<void>;
  revoke(ref: PersonalAppRef, registryIds: readonly string[]): Promise<void>;
  reconcile(
    ref: PersonalAppRef,
    retained: readonly PersonalRepositoryBinding[],
    revokedRegistryIds: readonly string[],
  ): Promise<void>;
}

function unavailable(): never {
  throw new Error("Personal repository unavailable");
}

function scope(owner: number) {
  return { kind: "personal", ownerGithubAccountId: owner } as const;
}

function parseRecord(record: RepositoryCatalogRecord, owner: number) {
  const doc = JSON.parse(record.doc);
  const descriptor = validatePersonalRepositoryDescriptor(doc.personalGithub);
  if (
    descriptor.ownerGithubAccountId !== owner ||
    !sameAccessScope(doc.accessScope, scope(owner)) ||
    doc.id !== record.repositoryId ||
    personalRepositoryId(descriptor) !== record.repositoryId ||
    typeof doc.blocked !== "boolean"
  )
    unavailable();
  return { descriptor, blocked: doc.blocked as boolean };
}

function sameBinding(
  a: PersonalRepositoryDescriptor,
  b: PersonalRepositoryDescriptor,
): boolean {
  // Names can change; numeric identity, issuing App and revision cannot.
  return (
    a.ownerGithubAccountId === b.ownerGithubAccountId &&
    a.appRecordId === b.appRecordId &&
    a.githubAppId === b.githubAppId &&
    a.installationId === b.installationId &&
    a.repositoryId === b.repositoryId &&
    a.repositoryOwnerGithubAccountId === b.repositoryOwnerGithubAccountId &&
    a.accessRevision === b.accessRevision
  );
}

export async function readPersonalRepository(
  owner: number,
  registryId: string,
): Promise<PersonalRepositoryBinding> {
  if (!isGithubAccountId(owner) || !registryId.startsWith("personal-"))
    unavailable();
  const record = await sessionMetadata({
    op: "repository_get",
    repositoryId: registryId,
    principal: { githubAccountId: owner },
  });
  if (!record) unavailable();
  const parsed = parseRecord(record, owner);
  if (parsed.blocked) unavailable();
  return Object.freeze({ registryId, descriptor: parsed.descriptor });
}

async function put(
  descriptor: PersonalRepositoryDescriptor,
  blocked: boolean,
  current: RepositoryCatalogRecord | null,
) {
  const id = personalRepositoryId(descriptor);
  const consumerState = current
    ? JSON.parse(current.doc)
    : { consumerSchema: 1, activeConsumers: [] };
  const result = await sessionMetadata({
    op: "repository_put",
    repositoryId: id,
    principal: { githubAccountId: descriptor.ownerGithubAccountId },
    expectedRev: current?.rev ?? null,
    doc: JSON.stringify({
      id,
      accessScope: scope(descriptor.ownerGithubAccountId),
      personalGithub: descriptor,
      blocked,
      consumerSchema: consumerState.consumerSchema,
      activeConsumers: consumerState.activeConsumers,
    }),
  });
  if (result.status !== "committed")
    throw new Error("Personal repository changed concurrently");
}

async function appRecords(
  ref: PersonalAppRef,
): Promise<RepositoryCatalogRecord[]> {
  if (!isGithubAccountId(ref.ownerGithubAccountId) || !ref.recordId)
    unavailable();
  const result: RepositoryCatalogRecord[] = [];
  let afterRepositoryId = "";
  // Indexed owner/App pages, bounded even for a malformed/unexpected registry.
  // Exceeding coverage is an error, never a successful partial revocation.
  for (let page = 0; page < 64; page++) {
    const rows = await sessionMetadata({
      op: "repository_app_page",
      ownerGithubAccountId: ref.ownerGithubAccountId,
      appRecordId: ref.recordId,
      afterRepositoryId,
      limit: 128,
    });
    result.push(...rows);
    if (rows.length < 128) return result;
    afterRepositoryId = rows.at(-1)!.repositoryId;
  }
  throw new Error("Personal repository revocation coverage exceeded");
}

/** Install only with real gateway consumer adapters. The broker durably denies
 * access before calling revoke/reconcile, and holds its owner lane throughout.
 * This coordinator never calls the broker, including during acknowledgments. */
export function createPersonalRepositoryCoordinator(
  consumers: PersonalRepositoryConsumers,
) {
  // A broker callback timeout does not cancel a gateway catalog write. Keep
  // subsequent revoke/reconcile behind that write even after its caller left.
  type Lanes = Map<number, { tail: Promise<unknown>; pending: number }>;
  const global = globalThis as typeof globalThis & {
    __personalRepositoryLanes?: Map<string, Lanes>;
  };
  const states = (global.__personalRepositoryLanes ??= new Map<
    string,
    Lanes
  >());
  const key = JSON.stringify(stateContext());
  const lanes = states.get(key) ?? new Map();
  states.set(key, lanes);
  function serial<T>(owner: number, work: () => Promise<T>): Promise<T> {
    if (!isGithubAccountId(owner)) unavailable();
    let lane = lanes.get(owner);
    if (!lane) {
      if (lanes.size >= 256)
        throw new Error("Personal repository coordinator busy");
      lane = { tail: Promise.resolve(), pending: 0 };
      lanes.set(owner, lane);
    }
    if (lane.pending >= 64)
      throw new Error("Personal repository owner queue full");
    lane.pending++;
    const result = lane.tail.then(work);
    lane.tail = result.catch(() => {});
    const current = lane;
    return result.finally(() => {
      current.pending--;
      if (!current.pending && lanes.get(owner) === current) lanes.delete(owner);
    });
  }
  const implementation = {
    async register(
      input: PersonalRepositoryDescriptor,
    ): Promise<{ registryId: string }> {
      const descriptor = validatePersonalRepositoryDescriptor(input);
      await consumers.assertReady();
      const registryId = personalRepositoryId(descriptor);
      const current = await sessionMetadata({
        op: "repository_get",
        repositoryId: registryId,
        principal: { githubAccountId: descriptor.ownerGithubAccountId },
      });
      if (current) {
        if (JSON.parse(current.doc).consumerSchema !== 1)
          throw new Error("Unknown private consumer schema");
        const parsed = parseRecord(current, descriptor.ownerGithubAccountId);
        if (parsed.blocked || !sameBinding(parsed.descriptor, descriptor))
          unavailable();
      }
      await put(descriptor, false, current);
      return { registryId };
    },
    async assertCurrent(
      owner: number,
      input: PersonalRepositoryDescriptor,
    ): Promise<void> {
      const descriptor = validatePersonalRepositoryDescriptor(input);
      if (owner !== descriptor.ownerGithubAccountId) unavailable();
      const current = await readPersonalRepository(
        owner,
        personalRepositoryId(descriptor),
      );
      if (!sameBinding(current.descriptor, descriptor)) unavailable();
    },
    async revoke(ref: PersonalAppRef): Promise<void> {
      const records = await appRecords(ref);
      for (const record of records) {
        const parsed = parseRecord(record, ref.ownerGithubAccountId);
        await put(parsed.descriptor, true, record);
      }
      // Called even for zero repositories: a consumer registry must explicitly
      // prove zero, not infer it from an empty repository list.
      await consumers.revoke(
        ref,
        records.map((record) => record.repositoryId),
      );
    },
    async reconcile(
      ref: PersonalAppRef,
      installationId: number,
      repositoryIds: readonly number[],
      accessRevision: number,
    ): Promise<void> {
      if (
        !isGithubAccountId(installationId) ||
        !isGithubAccountId(accessRevision) ||
        repositoryIds.length > 8192 ||
        repositoryIds.some((id) => !isGithubAccountId(id))
      )
        unavailable();
      const allowed = new Set(repositoryIds);
      const records = await appRecords(ref);
      const retained: PersonalRepositoryBinding[] = [];
      const revoked: string[] = [];
      // All records stay blocked while consumer acknowledgments are pending.
      for (const record of records) {
        const parsed = parseRecord(record, ref.ownerGithubAccountId);
        if (accessRevision < parsed.descriptor.accessRevision) unavailable();
        const descriptor = validatePersonalRepositoryDescriptor({
          ...parsed.descriptor,
          installationId,
          accessRevision,
        });
        await put(descriptor, true, record);
        if (allowed.has(descriptor.repositoryId))
          retained.push({ registryId: record.repositoryId, descriptor });
        else revoked.push(record.repositoryId);
      }
      await consumers.reconcile(ref, retained, revoked);
      for (const binding of retained) {
        const current = await sessionMetadata({
          op: "repository_get",
          repositoryId: binding.registryId,
          principal: { githubAccountId: ref.ownerGithubAccountId },
        });
        if (
          !current ||
          !sameBinding(
            parseRecord(current, ref.ownerGithubAccountId).descriptor,
            binding.descriptor,
          )
        )
          unavailable();
        await put(binding.descriptor, false, current);
      }
    },
  };
  return {
    register(input: PersonalRepositoryDescriptor) {
      const descriptor = validatePersonalRepositoryDescriptor(input);
      return serial(descriptor.ownerGithubAccountId, () =>
        implementation.register(descriptor),
      );
    },
    assertCurrent(owner: number, input: PersonalRepositoryDescriptor) {
      const descriptor = validatePersonalRepositoryDescriptor(input);
      return serial(owner, () =>
        implementation.assertCurrent(owner, descriptor),
      );
    },
    revoke(input: PersonalAppRef) {
      const ref = { ...input };
      return serial(ref.ownerGithubAccountId, () => implementation.revoke(ref));
    },
    reconcile(
      input: PersonalAppRef,
      installationId: number,
      repositoryIds: readonly number[],
      accessRevision: number,
    ) {
      const ref = { ...input };
      const ids = [...repositoryIds];
      return serial(ref.ownerGithubAccountId, () =>
        implementation.reconcile(ref, installationId, ids, accessRevision),
      );
    },
  };
}

/** Owner-only registry inventory; blocked entries are not selectable. */
export async function listPersonalRepositories(
  owner: number,
): Promise<PersonalRepositoryBinding[]> {
  if (!isGithubAccountId(owner)) unavailable();
  const result: PersonalRepositoryBinding[] = [];
  let afterRepositoryId = "";
  for (let page = 0; page < 64; page++) {
    const rows = await sessionMetadata({
      op: "repository_app_page",
      ownerGithubAccountId: owner,
      appRecordId: null,
      afterRepositoryId,
      limit: 128,
    });
    for (const row of rows) {
      const parsed = parseRecord(row, owner);
      if (!parsed.blocked)
        result.push(
          Object.freeze({
            registryId: row.repositoryId,
            descriptor: parsed.descriptor,
          }),
        );
    }
    if (rows.length < 128) return result;
    afterRepositoryId = rows.at(-1)!.repositoryId;
  }
  throw new Error("Personal repository inventory coverage exceeded");
}

/** Reauthorize a fresh action without upgrading an existing producer lease. */
export async function personalSessionForAction(
  session: import("./types").UnifiedSession,
): Promise<import("./types").UnifiedSession> {
  if (
    session.accessScope?.kind !== "personal" ||
    !session.personalRepo ||
    session.repo !== session.personalRepo.registryId
  )
    throw new Error("Private session binding unavailable");
  const current = await readPersonalRepository(
    session.accessScope.ownerGithubAccountId,
    session.personalRepo.registryId,
  );
  if (
    personalRepositoryId(current.descriptor) !==
      personalRepositoryId(session.personalRepo.descriptor) ||
    current.descriptor.githubAppId !==
      session.personalRepo.descriptor.githubAppId
  )
    throw new Error("Private session repository identity changed");
  return { ...session, personalRepo: current };
}
