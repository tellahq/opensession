import { beforeEach, afterEach, expect, test } from "bun:test";
import { SessionKernelStore } from "./session-kernel/store";
import { __setSessionKernelStoreForTest } from "./session-kernel/kernel";
import {
  createPersonalRepositoryCoordinator,
  personalRepositoryId,
  readPersonalRepository,
  type PersonalRepositoryConsumers,
} from "./personal-repository-coordinator";
import type { PersonalRepositoryDescriptor } from "./personal-github/types";

let store: SessionKernelStore;
let old: SessionKernelStore | undefined;
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
  appRecordId: "app-a",
  githubAppId: 501,
  installationId: 601,
  repositoryId: 701,
  repositoryOwnerGithubAccountId: 101,
  accessRevision: 1,
  fullName: "a/repo",
};
const ref = { ownerGithubAccountId: 101, recordId: "app-a" };
function fixture(overrides: Partial<PersonalRepositoryConsumers> = {}) {
  const calls: string[] = [];
  const coordinator = createPersonalRepositoryCoordinator({
    assertReady: async () => {
      calls.push("ready");
    },
    revoke: async (_ref, ids) => {
      calls.push(`revoke:${ids.length}`);
    },
    reconcile: async (_ref, keep, removed) => {
      calls.push(`reconcile:${keep.length}:${removed.length}`);
    },
    ...overrides,
  });
  return { coordinator, calls };
}

test("real central catalog registration and exact owner/revision lookup", async () => {
  const { coordinator } = fixture();
  const { registryId } = await coordinator.register(descriptor);
  expect(registryId).toBe(personalRepositoryId(descriptor));
  expect(await readPersonalRepository(101, registryId)).toEqual({
    registryId,
    descriptor,
  });
  expect(store.repositoryCatalogGet(registryId)).toBeNull();
  await expect(readPersonalRepository(202, registryId)).rejects.toThrow(
    "unavailable",
  );
  await expect(coordinator.assertCurrent(202, descriptor)).rejects.toThrow(
    "unavailable",
  );
  await expect(
    coordinator.assertCurrent(101, { ...descriptor, accessRevision: 2 }),
  ).rejects.toThrow("unavailable");
  await coordinator.assertCurrent(101, descriptor);
});

test("numeric tuple is immutable and names never choose an App or identity", async () => {
  const { coordinator } = fixture();
  await coordinator.register(descriptor);
  await expect(
    coordinator.register({ ...descriptor, githubAppId: 999 }),
  ).rejects.toThrow("unavailable");
  const renamed = { ...descriptor, fullName: "renamed/repo" };
  expect(personalRepositoryId(renamed)).toBe(personalRepositoryId(descriptor));
  await coordinator.register(renamed);
  expect(
    (await readPersonalRepository(101, personalRepositoryId(descriptor)))
      .descriptor.fullName,
  ).toBe("renamed/repo");
  expect(() =>
    personalRepositoryId({
      ...descriptor,
      repositoryOwnerGithubAccountId: 202,
    }),
  ).toThrow();
});

test("readiness failure cannot create a registry entry", async () => {
  const { coordinator } = fixture({
    assertReady: async () => {
      throw new Error("Runtime not installed");
    },
  });
  await expect(coordinator.register(descriptor)).rejects.toThrow(
    "Runtime not installed",
  );
  expect(store.repositoryCatalogCount({ githubAccountId: 101 })).toBe(0);
});

test("failed consumer revocation leaves the catalog blocked, including zero-binding checks", async () => {
  const { coordinator } = fixture({
    revoke: async () => {
      throw new Error("Unknown consumer");
    },
  });
  const { registryId } = await coordinator.register(descriptor);
  await expect(coordinator.revoke(ref)).rejects.toThrow("Unknown consumer");
  await expect(readPersonalRepository(101, registryId)).rejects.toThrow(
    "unavailable",
  );
  await expect(
    coordinator.revoke({ ...ref, recordId: "empty-app" }),
  ).rejects.toThrow("Unknown consumer");
});

test("reconciliation blocks before acknowledgment and never restores removed repositories", async () => {
  let fail = true;
  const { coordinator } = fixture({
    reconcile: async () => {
      await expect(
        readPersonalRepository(101, personalRepositoryId(descriptor)),
      ).rejects.toThrow();
      if (fail) throw new Error("Consumer still running");
    },
  });
  const removed = { ...descriptor, repositoryId: 702, fullName: "a/removed" };
  await coordinator.register(descriptor);
  await coordinator.register(removed);
  await expect(coordinator.reconcile(ref, 601, [701], 2)).rejects.toThrow(
    "Consumer still running",
  );
  await expect(
    readPersonalRepository(101, personalRepositoryId(descriptor)),
  ).rejects.toThrow();
  fail = false;
  await coordinator.reconcile(ref, 601, [701], 2);
  expect(
    (await readPersonalRepository(101, personalRepositoryId(descriptor)))
      .descriptor.accessRevision,
  ).toBe(2);
  await expect(
    readPersonalRepository(101, personalRepositoryId(removed)),
  ).rejects.toThrow();
  await expect(coordinator.reconcile(ref, 601, [701], 1)).rejects.toThrow();
});

test("late registration completion cannot land after a following revoke", async () => {
  const ready = Promise.withResolvers<void>();
  let revoked = false;
  const { coordinator } = fixture({
    assertReady: () => ready.promise,
    revoke: async () => {
      revoked = true;
    },
  });
  const registration = coordinator.register(descriptor);
  // Simulate the caller timing out without cancelling the actual gateway task.
  const revocation = coordinator.revoke(ref);
  await Promise.resolve();
  expect(revoked).toBe(false);
  ready.resolve();
  const { registryId } = await registration;
  await revocation;
  expect(revoked).toBe(true);
  await expect(readPersonalRepository(101, registryId)).rejects.toThrow();
});

test("App-indexed revocation cannot mutate another owner's identical App label", async () => {
  const { coordinator } = fixture();
  const other = {
    ...descriptor,
    ownerGithubAccountId: 202,
    repositoryOwnerGithubAccountId: 202,
    fullName: "b/repo",
  };
  await coordinator.register(descriptor);
  await coordinator.register(other);
  await coordinator.revoke(ref);
  await expect(
    readPersonalRepository(101, personalRepositoryId(descriptor)),
  ).rejects.toThrow();
  expect(
    (await readPersonalRepository(202, personalRepositoryId(other))).descriptor,
  ).toEqual(other);
});
