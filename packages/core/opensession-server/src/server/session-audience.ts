import {
  samePersonalRepoIdentity,
  snapshotPersonalRepoBinding,
} from "./personal-repository-identity";
import { currentExecutionAccess } from "./application-access";
import type { PrivateActorFence } from "./session-kernel/private-access";
import type { PersonalRepoBinding } from "./personal-repo-runtime";
import {
  personalRunConsumerKey,
  personalRunLineageKey,
  snapshotPersonalRunConsumer,
  type PersonalRunConsumer,
} from "./personal-run-identity";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ScopeLedgerRow,
  ScopeFence,
} from "./session-kernel/access-ledger";
import type { AccessPrincipal } from "../shared/access-scope";
import { stateContext } from "./paths";

interface AudienceState {
  enforcing: boolean;
  ready: boolean;
  fence: ScopeFence | undefined;
  rows: Map<string, ScopeLedgerRow>;
  refresh?: Promise<void>;
  revoked: Map<string, number>;
}
interface Publication {
  state: AudienceState;
  id: string;
  incarnation: string;
  generation: number;
  owner: number;
  revocation: number;
  binding?: PersonalRepoBinding;
  consumer?: PersonalRunConsumer;
  signal?: AbortSignal;
}
const global = globalThis as typeof globalThis & {
  __sessionAudiences?: Map<string, AudienceState>;
  __sessionPublication?: AsyncLocalStorage<Publication>;
};
const publication = (global.__sessionPublication ??=
  new AsyncLocalStorage<Publication>());
function state(): AudienceState {
  const states = (global.__sessionAudiences ??= new Map());
  const key = JSON.stringify(stateContext());
  let value = states.get(key);
  if (!value) {
    value = {
      enforcing: false,
      ready: false,
      fence: undefined,
      rows: new Map(),
      revoked: new Map(),
    };
    states.set(key, value);
  }
  return value;
}

/** Boot must call this BEFORE accepting clients or adopting any run. Once
 * enabled, failed/incomplete authority never falls back to legacy delivery. */
export async function startSessionAudiences(): Promise<void> {
  state().enforcing = true;
  await refreshSessionAudiences(true);
}
export function sessionAudiencesReady(): boolean {
  return state().enforcing && state().ready;
}
export async function refreshSessionAudiences(full = false): Promise<void> {
  const current = state();
  if (!current.enforcing) return;
  if (current.refresh) return current.refresh;
  current.refresh = (async () => {
    const { sessionMetadata } = await import("./session-kernel");
    const target = await sessionMetadata({ op: "scope_fence" });
    if (current.fence?.incarnation !== target.incarnation) {
      current.ready = false;
      current.rows.clear();
      current.revoked.clear();
      current.fence = { incarnation: target.incarnation, generation: 0 };
      // Feed bytes and cursors from an old authority may belong to a different
      // owner even when ids/counters match. Never reinterpret them.
      (await import("./session-feed")).resetSessionFeeds();
    }
    if (current.fence.generation > target.generation)
      throw new Error("Audience authority moved backwards");
    for (
      let page = 0;
      current.fence.generation < target.generation &&
      page < (full ? Number.MAX_SAFE_INTEGER : 8);
      page++
    ) {
      const delta = await sessionMetadata({
        op: "scope_changes",
        after: current.fence.generation,
        limit: 1000,
      });
      if (delta.fence.incarnation !== target.incarnation || !delta.rows.length)
        throw new Error("Audience authority changed during replay");
      for (const row of delta.rows) {
        if (row.generation <= current.fence.generation)
          throw new Error("Audience delta moved backwards");
        current.rows.set(row.id, { ...row });
        current.fence.generation = row.generation;
      }
    }
    const after = await sessionMetadata({ op: "scope_fence" });
    current.ready =
      current.fence.incarnation === after.incarnation &&
      current.fence.generation === after.generation;
    if (!current.ready) throw new Error("Audience projection incomplete");
  })()
    .catch((error) => {
      current.ready = false;
      throw error;
    })
    .finally(() => {
      current.refresh = undefined;
    });
  return current.refresh;
}

export function sessionAudienceAllows(
  id: string,
  principal?: AccessPrincipal,
  incarnation?: string,
): boolean {
  const current = state();
  if (!current.enforcing) return true; // legacy composition cannot admit personal repositories
  if (
    !current.ready ||
    (incarnation !== undefined && incarnation !== current.fence?.incarnation)
  )
    return false;
  const row = current.rows.get(id);
  return (
    !!row &&
    !row.deleted &&
    (row.owner === 0 ||
      (row.owner > 0 && row.owner === principal?.githubAccountId))
  );
}
export function sessionAudienceIncarnation(): string | undefined {
  return state().fence?.incarnation;
}

/** Publication provenance, NOT authorization to read or mutate a resource.
 * Call only around already-admitted session work. Descendant callbacks retain
 * this immutable lease; a reset/revoke cannot silently relabel their bytes. */
export async function withSessionPublication<T>(
  id: string,
  expectedOwner: number,
  work: () => Promise<T>,
  source: {
    binding?: PersonalRepoBinding;
    consumer?: PersonalRunConsumer;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const inherited = publication.getStore();
  if (inherited && !publicationLeaseCurrent(inherited))
    throw new Error("Session publication lease expired");
  await refreshSessionAudiences();
  const current = state();
  if (
    inherited &&
    (!publicationLeaseCurrent(inherited) || inherited.owner !== expectedOwner)
  )
    throw new Error("Session publication lease cannot be upgraded");
  if (!current.enforcing) {
    if (expectedOwner > 0) throw new Error("Private audience not initialized");
    return work();
  }
  const row = current.rows.get(id);
  if (
    !current.ready ||
    !row ||
    row.deleted ||
    row.owner < 0 ||
    row.canonicalId !== id ||
    row.owner !== expectedOwner
  )
    throw new Error("Session publication unavailable");
  const lease: Publication = {
    state: current,
    id: row.id,
    incarnation: current.fence!.incarnation,
    generation: row.generation,
    owner: row.owner,
    revocation: current.revoked.get(id) ?? 0,
    binding: source.binding
      ? snapshotPersonalRepoBinding(source.binding)
      : source.consumer
        ? snapshotPersonalRepoBinding(source.consumer.binding)
        : currentExecutionAccess()?.binding,
    consumer: source.consumer
      ? snapshotPersonalRunConsumer(source.consumer)
      : undefined,
    signal: source.signal,
  };
  if (
    lease.binding &&
    lease.binding.descriptor.ownerGithubAccountId !== expectedOwner
  )
    throw new Error("Publication binding owner mismatch");
  if (
    lease.consumer &&
    (lease.consumer.sessionId !== id ||
      lease.consumer.binding.descriptor.ownerGithubAccountId !== expectedOwner)
  )
    throw new Error("Publication consumer owner mismatch");
  if (
    inherited?.binding &&
    lease.binding &&
    !samePersonalRepoIdentity(inherited.binding, lease.binding)
  )
    throw new Error("Publication binding cannot be upgraded");
  let selected = inherited ?? lease;
  if (inherited && lease.consumer) {
    if (
      inherited.consumer &&
      personalRunConsumerKey(inherited.consumer) !==
        personalRunConsumerKey(lease.consumer)
    )
      throw new Error("Physical successor requires explicit handoff");
    if (!inherited.consumer) {
      if (
        lease.consumer.sessionId !== inherited.id ||
        lease.consumer.binding.descriptor.ownerGithubAccountId !==
          inherited.owner ||
        (inherited.binding &&
          personalRunLineageKey({
            ...lease.consumer,
            binding: inherited.binding,
          }) !== personalRunLineageKey(lease.consumer))
      )
        throw new Error("Publication consumer crossed source ownership");
      selected = {
        ...inherited,
        consumer: lease.consumer,
        signal: lease.signal,
        binding: inherited.binding ?? lease.binding,
      };
    }
  }
  return publication.run(selected, work);
}

function publicationAudienceCurrent(lease: Publication): boolean {
  const current = state();
  const source = current.rows.get(lease.id);
  return (
    current.ready &&
    lease.state === current &&
    lease.incarnation === current.fence?.incarnation &&
    !!source &&
    !source.deleted &&
    source.generation === lease.generation &&
    (current.revoked.get(lease.id) ?? 0) === lease.revocation
  );
}

function publicationLeaseCurrent(lease: Publication): boolean {
  return !lease.signal?.aborted && publicationAudienceCurrent(lease);
}

/** Entirely synchronous: no token-rate RPC, promises, queues or deferred frames. */
export function sessionPublicationAllowed(id: string): boolean {
  const current = state();
  if (!current.enforcing) return true;
  if (!current.ready) return false;
  const row = current.rows.get(id);
  if (!row || row.deleted || row.owner < 0) return false;
  const lease = publication.getStore();
  if (lease) {
    if (!publicationLeaseCurrent(lease)) return false;
    const source = current.rows.get(lease.id);
    if (
      lease.state !== current ||
      lease.incarnation !== current.fence?.incarnation ||
      !source ||
      source.deleted ||
      source.generation !== lease.generation ||
      (current.revoked.get(lease.id) ?? 0) !== lease.revocation
    )
      return false;
    if (lease.owner > 0 && row.owner !== lease.owner) return false;
  }
  // All private producers must carry source provenance. Untyped legacy/global
  // callbacks cannot emit private data merely by supplying an id.
  return row.owner === 0 || lease?.owner === row.owner;
}

export function revokeSessionPublications(ids: readonly string[]): void {
  const current = state();
  for (const id of ids)
    current.revoked.set(id, (current.revoked.get(id) ?? 0) + 1);
}

export function unscopedPublicationAllowed(): boolean {
  const lease = publication.getStore();
  return !lease || lease.owner === 0;
}

/** Capture once at an authenticated host/producer boundary; invoke without any
 * authority RPC on each event. The caller supplies its ORIGINAL owner, not a
 * fresh owner inferred from an id that may have been rebound after recovery. */
export async function bindSessionPublication<A extends unknown[], R>(
  id: string,
  expectedOwner: number,
  callback: (...args: A) => R,
  source: {
    binding?: PersonalRepoBinding;
    consumer?: PersonalRunConsumer;
    signal?: AbortSignal;
  } = {},
): Promise<(...args: A) => R> {
  return withSessionPublication(
    id,
    expectedOwner,
    async () => {
      const lease = publication.getStore();
      return (...args: A) =>
        lease
          ? publication.run(lease, () => callback(...args))
          : callback(...args);
    },
    source,
  );
}

/** Capture the original producer, not the ALS context of the transport callback. */
export function capturePrivateActorResultGuard(): () => void {
  const lease = publication.getStore();
  return () => {
    if (lease && lease.owner > 0 && !publicationLeaseCurrent(lease))
      throw new Error("Private actor result source lease expired");
  };
}

export function currentPrivateActorFence(): PrivateActorFence | undefined {
  const lease = publication.getStore();
  if (!lease || lease.owner <= 0) return undefined;
  if (!publicationLeaseCurrent(lease))
    throw new Error("Private actor source lease expired");
  return {
    sourceSessionId: lease.id,
    owner: lease.owner,
    incarnation: lease.incarnation,
    generation: lease.generation,
    binding: lease.binding,
    consumer: lease.consumer,
  };
}

/** Explicit physical handoff. Never refreshes audience authority. */
export async function bindSessionPublicationSuccessor<A extends unknown[], R>(
  input: PersonalRunConsumer,
  callback: (...args: A) => R,
  signal?: AbortSignal,
): Promise<(...args: A) => R> {
  const original = publication.getStore();
  const next = snapshotPersonalRunConsumer(input);
  if (
    !original?.consumer ||
    original.consumer.hostId === next.hostId ||
    !publicationAudienceCurrent(original) ||
    personalRunLineageKey(original.consumer) !== personalRunLineageKey(next)
  )
    throw new Error("Invalid private publication successor");
  const { assertPersonalRunConsumerEnrolled, personalRunRetired } =
    await import("./personal-run-consumers");
  const { readPersonalRepository } =
    await import("./personal-repository-coordinator");
  await assertPersonalRunConsumerEnrolled(next);
  if (await personalRunRetired(next))
    throw new Error("Private successor cannot relaunch");
  const current = await readPersonalRepository(
    next.binding.descriptor.ownerGithubAccountId,
    next.binding.registryId,
  );
  if (
    personalRunLineageKey({ ...next, binding: current }) !==
      personalRunLineageKey(next) ||
    !publicationAudienceCurrent(original) ||
    signal?.aborted
  )
    throw new Error("Private successor authority changed");
  const successor: Publication = { ...original, consumer: next, signal };
  return (...args: A) => publication.run(successor, () => callback(...args));
}
