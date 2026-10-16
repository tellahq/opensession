import { beforeEach, afterEach, expect, test } from "bun:test";
import { SessionKernelStore } from "./store";
import { sessionActorReducerRoute } from "./actor-routing";
import type { CreationAccessReservation } from "./creation-access-protocol";
let store: SessionKernelStore;
beforeEach(() => {
  store = new SessionKernelStore(":memory:");
});
afterEach(() => store.close());
function request(owner = 101, id = "private"): CreationAccessReservation {
  const descriptor = {
    kind: "personal" as const,
    ownerGithubAccountId: owner,
    appRecordId: `app-${owner}`,
    githubAppId: 1,
    installationId: 2,
    repositoryId: 3,
    repositoryOwnerGithubAccountId: owner,
    accessRevision: 1,
    fullName: "fixture/repo",
  };
  const registryId = `repo-${owner}`;
  store.repositoryCatalogPut({
    op: "repository_put",
    repositoryId: registryId,
    principal: { githubAccountId: owner },
    expectedRev: null,
    doc: JSON.stringify({
      id: registryId,
      accessScope: { kind: "personal", ownerGithubAccountId: owner },
      personalGithub: descriptor,
      blocked: false,
    }),
  });
  return {
    op: "reserve_creation",
    sessionId: id,
    createIdentity: "intent",
    accessScope: { kind: "personal", ownerGithubAccountId: owner },
    principal: { githubAccountId: owner },
    binding: { registryId, descriptor },
    defaults: { title: "private title" },
  };
}
test("central reservation claims id/intent/binding atomically without actor state", () => {
  const input = request();
  expect(
    sessionActorReducerRoute({
      kind: "metadata",
      commandId: "reserve",
      request: input,
    }),
  ).toEqual({ scope: "global" });
  const result = store.reserveCreationAccess(input);
  expect(result.created).toBe(true);
  expect(JSON.parse(result.document!).personalRepo).toEqual(input.binding);
  expect(store.sessionMetadata("private")).toBeNull();
  expect(store.sessionMetadataCatalogGet("private")).toBeNull();
  expect(store.reserveCreationAccess(input).created).toBe(false);
  expect(() =>
    store.reserveCreationAccess({ ...input, createIdentity: "changed" }),
  ).toThrow("intent changed");
});
test("owner and shared/private collisions deny before an actor can be opened", () => {
  const a = request(101),
    b = request(202);
  store.reserveCreationAccess(a);
  const fence = store.sessionScopeFence();
  expect(() => store.reserveCreationAccess(b)).toThrow("unavailable");
  expect(() =>
    store.reserveCreationAccess({
      op: "reserve_creation",
      sessionId: a.sessionId,
      createIdentity: "intent",
      accessScope: { kind: "shared" },
    }),
  ).toThrow("unavailable");
  expect(store.sessionScopeFence()).toEqual(fence);
  store.reserveCreationAccess({
    op: "reserve_creation",
    sessionId: "shared-first",
    createIdentity: "shared",
    accessScope: { kind: "shared" },
  });
  expect(store.sessionMetadataCatalogGet("shared-first")).toBeNull();
  expect(() =>
    store.reserveCreationAccess({ ...a, sessionId: "shared-first" }),
  ).toThrow();
});
test("aliases and tombstones cannot be adopted by creation replay", () => {
  const input = request();
  store.reserveCreationAccess(input);
  store.registerSessionScopeAliases([{ id: "private", aliases: ["old"] }]);
  expect(() =>
    store.reserveCreationAccess({ ...input, sessionId: "old" }),
  ).toThrow("unavailable");
  store.tombstoneSessionScope("private");
  expect(() => store.reserveCreationAccess(input)).toThrow("unavailable");
  expect(() =>
    store.reserveCreationAccess({ ...input, sessionId: "old" }),
  ).toThrow("unavailable");
});
test("blocked/stale binding and injected defaults cannot change reserved ownership", () => {
  const input = request();
  expect(() =>
    store.reserveCreationAccess({
      ...input,
      binding: {
        ...input.binding!,
        descriptor: { ...input.binding!.descriptor, accessRevision: 2 },
      },
    }),
  ).toThrow("binding changed");
  const result = store.reserveCreationAccess({
    ...input,
    defaults: {
      title: "visible",
      ...{ id: "wrong", accessScope: { kind: "shared" } },
    },
  });
  expect(JSON.parse(result.document!).id).toBe("private");
  expect(JSON.parse(result.document!).accessScope).toEqual(input.accessScope);
  const repo = store.repositoryCatalogGet(
    input.binding!.registryId,
    input.principal,
  )!;
  store.repositoryCatalogPut({
    op: "repository_put",
    repositoryId: repo.repositoryId,
    principal: input.principal,
    expectedRev: repo.rev,
    doc: JSON.stringify({ ...JSON.parse(repo.doc), blocked: true }),
  });
  expect(() => store.reserveCreationAccess(input)).toThrow("binding changed");
});
