import type { RunHostSpec } from "../runner-host/protocol";
import { samePersonalRepoBinding } from "./personal-repo-runtime";
import {
  snapshotPersonalRunConsumer,
  personalRunConsumerKey,
  personalRunLineageKey,
  type PersonalRunConsumer,
} from "./personal-run-consumers";

export interface PersonalHostTransitionDependencies {
  retired(consumer: PersonalRunConsumer): Promise<boolean>;
  enrolled(consumer: PersonalRunConsumer): Promise<void>;
  requestRetirement(consumer: PersonalRunConsumer): Promise<void>;
  spec(
    consumer: PersonalRunConsumer,
  ): Promise<{ spec: RunHostSpec; hash: string }>;
  stopPhysical(
    consumer: PersonalRunConsumer,
    hash: string,
    dispatch: "never" | "direct" | "executor" | "unknown",
  ): Promise<void>;
}
function snapshot(input: PersonalRunConsumer) {
  const c = snapshotPersonalRunConsumer(input);
  if (
    !/^rh-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      c.hostId,
    ) ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(c.runKey)
  )
    throw new Error("Invalid personal physical identity");
  return c;
}
function check(consumer: PersonalRunConsumer, spec: RunHostSpec) {
  if (
    !/^rh-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      consumer.hostId,
    ) ||
    spec.hostId !== consumer.hostId ||
    spec.logicalRunId !== consumer.runKey ||
    spec.osSessionId !== consumer.sessionId ||
    !spec.personalRepo ||
    !samePersonalRepoBinding(spec.personalRepo, consumer.binding)
  )
    throw new Error("Personal physical host identity mismatch");
}

/** Only short metadata/physical transitions hold these locks. Credential and
 * workspace preparation must remain outside: revocation may own the broker. */
export function createPersonalHostTransitions(
  deps: PersonalHostTransitionDependencies,
  limit = 1024,
) {
  const local = new Map<
    string,
    {
      consumer: PersonalRunConsumer;
      dispatch: "never" | "direct" | "executor" | "unknown";
      stopped: () => void;
      invalidate?: () => void;
      beforeDispatch?: () => void;
    }
  >();
  const tails = new Map<string, Promise<void>>();
  let pending = 0;
  async function lock<T>(keys: string[], work: () => Promise<T>): Promise<T> {
    if (pending >= limit)
      throw new Error("Personal host transition capacity exceeded");
    pending++;
    const predecessors = keys.map((key) => tails.get(key)).filter(Boolean);
    const release = Promise.withResolvers<void>();
    for (const key of keys) tails.set(key, release.promise);
    try {
      await Promise.all(predecessors);
      return await work();
    } finally {
      release.resolve();
      for (const key of keys)
        if (tails.get(key) === release.promise) tails.delete(key);
      pending--;
    }
  }
  const keys = (c: PersonalRunConsumer) => [
    `lineage:${personalRunLineageKey(c)}`,
    `host:${c.hostId}`,
  ];
  async function verified(c: PersonalRunConsumer) {
    await deps.enrolled(c);
    const record = await deps.spec(c);
    check(c, record.spec);
    return record;
  }
  async function allowed(c: PersonalRunConsumer) {
    if (await deps.retired(c)) throw new Error("Personal logical run retired");
  }
  return {
    remember(
      input: PersonalRunConsumer,
      stopped: () => void,
      previouslyDispatched = false,
      invalidate?: () => void,
      beforeDispatch?: () => void,
    ) {
      const consumer = snapshot(input);
      const existing = local.get(consumer.hostId);
      if (
        existing &&
        personalRunConsumerKey(existing.consumer) !==
          personalRunConsumerKey(consumer)
      )
        throw new Error("Personal host already belongs to another run");
      if (!existing && local.size >= limit)
        throw new Error("Personal host tracking capacity exceeded");
      local.set(consumer.hostId, {
        consumer,
        stopped,
        invalidate,
        beforeDispatch,
        dispatch:
          existing?.dispatch ?? (previouslyDispatched ? "unknown" : "never"),
      });
    },
    forget(input: PersonalRunConsumer) {
      const existing = local.get(input.hostId);
      if (
        existing &&
        personalRunConsumerKey(existing.consumer) ===
          personalRunConsumerKey(input)
      )
        local.delete(input.hostId);
    },
    async publishSpec(input: PersonalRunConsumer, write: () => Promise<void>) {
      const c = snapshot(input);
      await lock(keys(c), async () => {
        await allowed(c);
        await write();
      });
    },
    async cleanupEvidence(
      input: PersonalRunConsumer,
      remove: () => Promise<void>,
    ) {
      const c = snapshot(input);
      await lock(keys(c), async () => {
        let record;
        try {
          record = await deps.spec(c);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        // This old consumer is already physically confirmed. A later spec is
        // not its evidence and must never be removed by its cleanup callback.
        try {
          check(c, record.spec);
        } catch {
          return;
        }
        await remove();
      });
    },
    assertMayExecute: async (input: PersonalRunConsumer) => {
      const c = snapshot(input);
      await allowed(c);
      await verified(c);
    },
    async dispatch(
      input: PersonalRunConsumer,
      prepare: () => Promise<void>,
      launch: (hash: string) => Promise<void>,
      direct = false,
    ) {
      const c = snapshot(input);
      await allowed(c);
      await prepare(); // NEVER under the transition locks
      await lock(keys(c), async () => {
        const { hash } = await verified(c);
        await allowed(c); // after all async prep, immediately before dispatch
        const existing = local.get(c.hostId);
        if (
          !existing ||
          personalRunConsumerKey(existing.consumer) !==
            personalRunConsumerKey(c)
        )
          throw new Error("Personal dispatch owner unavailable");
        existing.beforeDispatch?.();
        existing.dispatch = direct ? "direct" : "executor";
        await launch(hash);
      });
    },
    async stop(input: PersonalRunConsumer) {
      const c = snapshot(input);
      await verified(c);
      await deps.requestRetirement(c); // durable intent precedes waiting/stopping
      for (const entry of local.values())
        if (personalRunLineageKey(entry.consumer) === personalRunLineageKey(c))
          entry.invalidate?.();
      await lock(keys(c), async () => {
        const { hash } = await verified(c);
        const existing = local.get(c.hostId);
        if (
          existing &&
          personalRunConsumerKey(existing.consumer) !==
            personalRunConsumerKey(c)
        )
          throw new Error("Personal stop owner changed");
        await deps.stopPhysical(c, hash, existing?.dispatch ?? "unknown");
        existing?.stopped(); // data-free, exact-control retirement only
        local.delete(c.hostId);
      });
      return { state: "absent" as const, consumer: c };
    },
    /** Old physical completion before an authorized successor; no logical intent. */
    async finishPhysical(input: PersonalRunConsumer, allowRetired = false) {
      const c = snapshot(input);
      await lock(keys(c), async () => {
        if (!allowRetired) await allowed(c);
        const { hash } = await verified(c);
        const existing = local.get(c.hostId);
        if (
          existing &&
          personalRunConsumerKey(existing.consumer) !==
            personalRunConsumerKey(c)
        )
          throw new Error("Personal physical owner changed");
        await deps.stopPhysical(c, hash, existing?.dispatch ?? "unknown");
      });
    },
  };
}

/** Share live entries and lock tails through module refresh, never across a
 * different state namespace or physical host directory. */
export function sharedPersonalHostTransitions(
  identity: { stateRoot?: string; home: string; hostsDir: string },
  create: () => ReturnType<typeof createPersonalHostTransitions>,
): ReturnType<typeof createPersonalHostTransitions> {
  const shared = globalThis as typeof globalThis & {
    __personalHostTransitionsV1?: Map<
      string,
      ReturnType<typeof createPersonalHostTransitions>
    >;
  };
  const registries = (shared.__personalHostTransitionsV1 ??= new Map<
    string,
    ReturnType<typeof createPersonalHostTransitions>
  >());
  const key = JSON.stringify([
    identity.stateRoot ?? null,
    identity.home,
    identity.hostsDir,
  ]);
  let registry = registries.get(key);
  if (!registry) {
    registry = create();
    registries.set(key, registry);
  }
  return registry;
}
