import { createBrokerPersonalGithubEngine } from "./engine";

/** Trusted-host broker factory. Without a coordinator only connections are
 * exposed. A real gateway coordinator enables catalog registration and internal
 * runtime credential resolution; consent alone never enables either. */
export async function openTrustedHostConnections(input: {
  directory: string;
  transport: import("./github-api").PersonalGithubTransport;
  now?: () => number;
  coordinator?: import("./repository-coordinator").PersonalRepositoryCoordinator;
}) {
  const { openTrustedHostStore } = await import("./trusted-host-store");
  const { createPersonalGithubApi } = await import("./github-api");
  const { createPersonalGithubBrokerCore } = await import("./broker-core");
  const store = await openTrustedHostStore(input.directory, input.coordinator);
  const api = createPersonalGithubApi({ transport: input.transport });
  const authority = Object.freeze({
    kind: "shared_trusted_host" as const,
    description: "Operators and root-capable agents are trusted",
  });
  const broker = createPersonalGithubBrokerCore({
    store,
    api,
    authority,
    now: input.now,
    // Versioned durable zero-binding provenance, NOT blanket revocation success.
    // An admitted/future schema cannot open or acknowledge this connection store.
    revocations: input.coordinator ?? {
      revoke: () => store.assertNoConsumers(),
      reconcile: () => store.assertNoConsumers(),
    },
  });
  const engine = createBrokerPersonalGithubEngine({
    broker,
    api,
    now: input.now,
    admission: { admit: (a, b) => a === authority && b === broker },
    repositoryCoordinator: input.coordinator
      ? {
          ...input.coordinator,
          register: async (descriptor) => {
            // Durable, irreversible provenance switch BEFORE catalog callback.
            // Callback timeout/commit ambiguity must never restore zero consumers.
            await store.requireCatalogRevocation();
            return input.coordinator!.register(descriptor);
          },
          assertCurrent: async (owner, descriptor) => {
            await store.requireCatalogRevocation();
            return input.coordinator!.assertCurrent(owner, descriptor);
          },
          revoke: (ref) => input.coordinator!.revoke(ref),
          reconcile: (ref, install, repos, rev) =>
            input.coordinator!.reconcile(ref, install, repos, rev),
        }
      : undefined,
  });
  const { register, resolveCredential, ...connections } = engine;
  return {
    connections,
    repositories: input.coordinator ? { register, resolveCredential } : null,
    close: () => store.close(),
  };
}
