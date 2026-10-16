import {
  startSessionAudiences,
  bindSessionPublication,
} from "./session-audience";
import { beforeEach, afterEach, expect, test } from "bun:test";
import { SessionKernelStore } from "./session-kernel/store";
import { __setSessionKernelStoreForTest } from "./session-kernel/kernel";
import {
  createPersonalRepositoryCoordinator,
  personalRepositoryId,
} from "./personal-repository-coordinator";
import {
  registerPersonalRunConsumer as registerConsumer,
  personalRunRetired,
  personalRunRetirementConfirmed,
  requestPersonalRunRetirement,
  confirmPersonalRunPhysicalCompletion,
  retirePersonalRunConsumer,
  createPersonalRepositoryConsumers,
  personalRunConsumerKey,
  personalRunLineageKey,
  type PersonalRunConsumer,
} from "./personal-run-consumers";
import type { PersonalRepositoryDescriptor } from "./personal-github/types";
let store: SessionKernelStore, old: SessionKernelStore | undefined;
beforeEach(() => {
  store = new SessionKernelStore(":memory:");
  old = __setSessionKernelStoreForTest(store);
});
afterEach(() => {
  __setSessionKernelStoreForTest(old);
  store.close();
});
const descriptor: PersonalRepositoryDescriptor = {
  kind: "personal",
  ownerGithubAccountId: 101,
  appRecordId: "app",
  githubAppId: 501,
  installationId: 601,
  repositoryId: 701,
  repositoryOwnerGithubAccountId: 101,
  accessRevision: 1,
  fullName: "owner/repo",
};
async function setup(d = descriptor) {
  const coordinator = createPersonalRepositoryCoordinator({
    assertReady: async () => {},
    revoke: async () => {},
    reconcile: async () => {},
  });
  const { registryId } = await coordinator.register(d);
  const binding = { registryId, descriptor: d };
  store.seedSessionMetadataCatalog([
    {
      sessionId: registryId,
      doc: JSON.stringify({
        id: registryId,
        repo: registryId,
        personalRepo: binding,
        accessScope: { kind: "personal", ownerGithubAccountId: 101 },
      }),
      rev: 1,
      archived: false,
      lastActivityMs: 0,
    },
  ]);
  const consumer: PersonalRunConsumer = {
    runKey: "logical",
    hostId: "physical-1",
    sessionId: registryId,
    binding,
  };
  return { coordinator, consumer };
}
function doc(id: string) {
  return store.repositoryCatalogGet(id, { githubAccountId: 101 })!;
}
function replace(id: string, value: unknown) {
  const row = doc(id);
  store.repositoryCatalogPut({
    op: "repository_put",
    repositoryId: id,
    principal: { githubAccountId: 101 },
    expectedRev: row.rev,
    doc: JSON.stringify(value),
  });
}

test("physical respawn retains logical identity; intent fences every host without claiming completion", async () => {
  const { consumer } = await setup();
  const next = { ...consumer, hostId: "physical-2" };
  await registerPersonalRunConsumer(consumer);
  await registerPersonalRunConsumer(next);
  expect(personalRunConsumerKey(consumer)).not.toBe(
    personalRunConsumerKey(next),
  );
  expect(personalRunLineageKey(consumer)).toBe(personalRunLineageKey(next));
  await confirmPersonalRunPhysicalCompletion(consumer);
  expect(await personalRunRetirementConfirmed(consumer)).toBe(true);
  expect(await personalRunRetired(next)).toBe(false);
  await requestPersonalRunRetirement(next);
  expect(await personalRunRetired({ ...next, hostId: "physical-3" })).toBe(
    true,
  );
  expect(await personalRunRetirementConfirmed(next)).toBe(false);
  expect(
    JSON.parse(doc(consumer.binding.registryId).doc).activeConsumers,
  ).toHaveLength(1);
  await expect(
    registerPersonalRunConsumer({ ...next, hostId: "physical-3" }),
  ).rejects.toThrow("cannot relaunch");
  await retirePersonalRunConsumer(next);
  expect(await personalRunRetirementConfirmed(next)).toBe(true);
  expect(
    JSON.parse(doc(consumer.binding.registryId).doc).activeConsumers,
  ).toEqual([]);
});

test("shared or other session ownership cannot enroll a private credential consumer", async () => {
  const { consumer } = await setup();
  store.seedSessionMetadataCatalog([
    {
      sessionId: "shared",
      doc: JSON.stringify({
        id: "shared",
        repo: consumer.binding.registryId,
        personalRepo: consumer.binding,
      }),
      rev: 1,
      archived: false,
      lastActivityMs: 0,
    },
  ]);
  await expect(
    registerPersonalRunConsumer({ ...consumer, sessionId: "shared" }),
  ).rejects.toThrow("publication unavailable");
  await expect(retirePersonalRunConsumer(consumer)).rejects.toThrow(
    "Unknown private run consumer",
  );
});

test("failed physical stop retains indexed cleanup work and confirmed retirement stays false", async () => {
  const { consumer, coordinator } = await setup();
  await registerPersonalRunConsumer(consumer);
  const row = JSON.parse(doc(consumer.binding.registryId).doc);
  replace(consumer.binding.registryId, { ...row, blocked: true });
  const adapter = createPersonalRepositoryConsumers({
    assertRuntimeReady: async () => {},
    cancelAndConfirm: async (current) => {
      expect(await personalRunRetired(current)).toBe(true);
      expect(await personalRunRetirementConfirmed(current)).toBe(false);
      throw new Error("physical state unknown");
    },
  });
  await expect(
    adapter.revoke({ ownerGithubAccountId: 101, recordId: "app" }, [
      consumer.binding.registryId,
    ]),
  ).rejects.toThrow("physical state unknown");
  expect(
    JSON.parse(doc(consumer.binding.registryId).doc).activeConsumers,
  ).toHaveLength(1);
  expect(await personalRunRetirementConfirmed(consumer)).toBe(false);
  await expect(coordinator.assertCurrent(101, descriptor)).rejects.toThrow();
});

test("per-repository bound fails closed but more than 1024 admitted consumers remain drainable", async () => {
  const ids: string[] = [];
  let stopped = 0;
  for (let repo = 0; repo < 9; repo++) {
    const { consumer } = await setup({
      ...descriptor,
      repositoryId: 701 + repo,
      fullName: `owner/repo-${repo}`,
    });
    const id = consumer.binding.registryId;
    ids.push(id);
    const activeConsumers = Array.from({ length: 128 }, (_, i) => ({
      ...consumer,
      runKey: `run-${repo}-${i}`,
      hostId: `host-${repo}-${i}`,
    }));
    replace(id, { ...JSON.parse(doc(id).doc), activeConsumers });
    if (repo === 0)
      await expect(
        registerPersonalRunConsumer({
          ...consumer,
          runKey: "overflow",
          hostId: "overflow",
        }),
      ).rejects.toThrow("limit exceeded");
    replace(id, { ...JSON.parse(doc(id).doc), blocked: true });
  }
  const adapter = createPersonalRepositoryConsumers({
    assertRuntimeReady: async () => {},
    cancelAndConfirm: async () => {
      stopped++;
    },
  });
  await adapter.revoke({ ownerGithubAccountId: 101, recordId: "app" }, ids);
  expect(stopped).toBe(1152);
  for (const id of ids)
    expect(JSON.parse(doc(id).doc).activeConsumers).toEqual([]);
}, 15_000); // 1,152 consumers retire through real catalog CAS operations.

async function registerPersonalRunConsumer(consumer: PersonalRunConsumer) {
  await startSessionAudiences();
  const register = await bindSessionPublication(
    consumer.sessionId,
    consumer.binding.descriptor.ownerGithubAccountId,
    () => registerConsumer(consumer),
    { binding: consumer.binding },
  );
  return register();
}

test("recovery uses persisted original authority and physical successors retain it", async () => {
  const { personalRunRecoverySource, bindPersonalRunRecovery } =
    await import("./personal-run-consumers");
  const { consumer } = await setup();
  await registerPersonalRunConsumer(consumer);
  const original = await personalRunRecoverySource(consumer);
  expect(original.incarnation).toBe(store.sessionScopeFence().incarnation);
  expect(original.generation).toBe(
    store.sessionScopeLookup(consumer.sessionId)!.generation,
  );
  let calls = 0;
  const recovered = await bindPersonalRunRecovery(consumer, () => ++calls);
  expect(recovered()).toBe(1);
  const successor = { ...consumer, hostId: "physical-successor" };
  await registerPersonalRunConsumer(successor);
  const next = await personalRunRecoverySource(successor);
  expect(next.consumer.sourceAuthority).toEqual(
    original.consumer.sourceAuthority,
  );
  await confirmPersonalRunPhysicalCompletion(consumer);
  await expect(personalRunRecoverySource(consumer)).rejects.toThrow(
    "Unknown private run consumer",
  );
  expect((await bindPersonalRunRecovery(successor, () => ++calls))()).toBe(2);
  await requestPersonalRunRetirement(successor);
  await expect(personalRunRecoverySource(successor)).rejects.toThrow("retired");
});

test("recovery refuses unstamped rows and replacement scope/repository authority", async () => {
  const { personalRunRecoverySource } =
    await import("./personal-run-consumers");
  const { consumer } = await setup();
  replace(consumer.binding.registryId, {
    ...JSON.parse(doc(consumer.binding.registryId).doc),
    activeConsumers: [consumer],
  });
  await expect(personalRunRecoverySource(consumer)).rejects.toThrow(
    "authority unavailable",
  );
  replace(consumer.binding.registryId, {
    ...JSON.parse(doc(consumer.binding.registryId).doc),
    activeConsumers: [],
  });
  await registerPersonalRunConsumer(consumer);
  const row = JSON.parse(doc(consumer.binding.registryId).doc);
  const forged = structuredClone(row);
  forged.activeConsumers[0].sourceAuthority.generation++;
  expect(() => replace(consumer.binding.registryId, forged)).toThrow(
    "immutable",
  );
  store.tombstoneSessionScope(consumer.sessionId);
  await expect(personalRunRecoverySource(consumer)).rejects.toThrow(
    "authority changed",
  );
});

test.each(["owner", "incarnation", "generation", "revision"] as const)(
  "persisted recovery refuses %s replacement",
  async (change) => {
    const { personalRunRecoverySource } =
      await import("./personal-run-consumers");
    const { consumer } = await setup();
    await registerPersonalRunConsumer(consumer);
    const db = (store as unknown as { db: import("bun:sqlite").Database }).db;
    if (change === "owner")
      db.run("UPDATE session_kernel_access_scope SET owner=202 WHERE id=?", [
        consumer.sessionId,
      ]);
    if (change === "incarnation")
      db.run(
        "UPDATE session_kernel_access_clock SET incarnation='replacement-authority'",
      );
    if (change === "generation")
      db.run(
        "UPDATE session_kernel_access_scope SET generation=generation+1 WHERE id=?",
        [consumer.sessionId],
      );
    if (change === "revision") {
      const row = JSON.parse(doc(consumer.binding.registryId).doc);
      replace(consumer.binding.registryId, {
        ...row,
        personalGithub: { ...row.personalGithub, accessRevision: 2 },
      });
    }
    await expect(personalRunRecoverySource(consumer)).rejects.toThrow();
  },
);
