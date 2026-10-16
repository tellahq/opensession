import {
  personalRunConsumerKey,
  personalRunLineageKey,
  snapshotPersonalRunConsumer,
  type PersonalRunConsumer,
} from "./personal-run-consumers";

export interface HostedRunLifetime {
  finalize(): Promise<void>;
}
interface Dependencies {
  stop(
    consumer: PersonalRunConsumer,
  ): Promise<{ state: "absent"; consumer: PersonalRunConsumer }>;
  confirmed(consumer: PersonalRunConsumer): Promise<boolean>;
  retire(consumer: PersonalRunConsumer): Promise<void>;
}
const sharedLifetimes = globalThis as typeof globalThis & {
  __hostRunLifetimesV1?: WeakMap<object, HostedRunLifetime>;
};
const lifetimes = (sharedLifetimes.__hostRunLifetimesV1 ??= new WeakMap<
  object,
  HostedRunLifetime
>());
export function attachHostedRunLifetime<T extends object>(
  source: T,
  lifetime: HostedRunLifetime,
): T {
  if (lifetimes.has(source))
    throw new Error("Hosted lifetime cannot be rebound");
  lifetimes.set(source, lifetime);
  return source;
}
/** Call in the owning consumer's finally, after all model-derived writes.
 * The source is captured before first await/yield, never inferred from events. */
export async function finalizeHostedRun(source: object): Promise<void> {
  const lifetime = lifetimes.get(source);
  if (!lifetime) throw new Error("Hosted run lifetime unavailable");
  await lifetime.finalize();
}
export function createHostedRunLifetime(
  original: Omit<PersonalRunConsumer, "hostId"> | undefined,
  deps: Dependencies,
) {
  const source = original && structuredClone(original);
  const members = new Map<string, PersonalRunConsumer>();
  let closed = false;
  let finishing: Promise<void> | undefined;
  const api: HostedRunLifetime = Object.freeze({
    finalize() {
      closed = true;
      if (finishing) return finishing;
      finishing = (async () => {
        let failure: unknown;
        for (const [key, c] of members) {
          try {
            if (!(await deps.confirmed(c))) {
              const receipt = await deps.stop(c);
              if (
                receipt.state !== "absent" ||
                personalRunConsumerKey(receipt.consumer) !== key
              )
                throw new Error("Hosted completion unconfirmed");
            }
            await deps.retire(c);
            members.delete(key);
          } catch (error) {
            failure ??= error;
          }
        }
        if (failure) throw failure;
      })().finally(() => {
        finishing = undefined;
      });
      return finishing;
    },
  });
  return {
    api,
    get closed() {
      return closed;
    },
    assertOpen() {
      if (closed) throw new Error("Hosted run lifetime closed");
    },
    track(input: PersonalRunConsumer) {
      if (closed) throw new Error("Hosted run lifetime closed");
      const c = snapshotPersonalRunConsumer(input);
      if (
        !source ||
        personalRunLineageKey(c) !==
          personalRunLineageKey({ ...source, hostId: c.hostId })
      )
        throw new Error("Hosted physical successor changed logical identity");
      if (!members.has(personalRunConsumerKey(c)) && members.size >= 16)
        throw new Error("Hosted physical attempt limit exceeded");
      members.set(personalRunConsumerKey(c), c);
    },
  };
}
export type HostedLifetimeControl = ReturnType<typeof createHostedRunLifetime>;
