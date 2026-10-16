import { afterEach, beforeEach, expect, test } from "bun:test";
import { SessionKernelStore } from "./store";
import { sessionActorReducerRoute } from "./actor-routing";

let store: SessionKernelStore;
beforeEach(() => {
  store = new SessionKernelStore(":memory:");
});
afterEach(() => store.close());
const a = { githubAccountId: 101 };
const b = { githubAccountId: 202 };
const scopeA = { kind: "personal", ownerGithubAccountId: 101 };
function put(
  repositoryId: string,
  accessScope?: unknown,
  principal?: typeof a,
  expectedRev: number | null = null,
) {
  return store.repositoryCatalogPut({
    op: "repository_put",
    repositoryId,
    doc: JSON.stringify({ accessScope, ghRepo: "synthetic/example" }),
    principal,
    expectedRev,
  });
}

test("repository catalog is owner-scoped before exact reads, pagination and counts", () => {
  put("00-private", scopeA, a);
  put("01-shared");
  put("02-b", { kind: "personal", ownerGithubAccountId: 202 }, b);
  expect(store.repositoryCatalogCount()).toBe(1);
  expect(store.repositoryCatalogCount(a)).toBe(2);
  expect(store.repositoryCatalogGet("00-private")).toBeNull();
  expect(store.repositoryCatalogGet("00-private", b)).toBeNull();
  expect(store.repositoryCatalogGet("00-private", a)?.repositoryId).toBe(
    "00-private",
  );
  expect(store.repositoryCatalogPage("", 1)[0]?.repositoryId).toBe("01-shared");
  expect(
    store.repositoryCatalogPage("", 10, a).map((row) => row.repositoryId),
  ).toEqual(["00-private", "01-shared"]);
});

test("spoofed owner, malformed scope, reassignment, downgrade and conflict leaks are denied", () => {
  expect(() => put("private", scopeA)).toThrow("Repository not found");
  expect(() => put("private", scopeA, b)).toThrow("Repository not found");
  expect(() =>
    put("invalid", { kind: "personal", ownerGithubAccountId: "101" }, a),
  ).toThrow("Invalid repository access scope");
  expect(put("private", scopeA, a)).toEqual({ status: "committed", rev: 1 });
  expect(() => put("private", undefined, b, null)).toThrow(
    "Repository not found",
  );
  expect(() => put("private", undefined, a, 1)).toThrow("immutable");
  expect(put("private", scopeA, a, null)).toMatchObject({
    status: "conflict",
    current: { repositoryId: "private", rev: 1 },
  });
  expect(put("private", scopeA, a, 1)).toEqual({ status: "committed", rev: 2 });
  expect(() => store.repositoryCatalogCount({ githubAccountId: -1 })).toThrow(
    "Invalid access principal",
  );
});

test("repository catalog requests never select an actor lane", () => {
  for (const request of [
    { op: "repository_get", repositoryId: "private", principal: a },
    { op: "repository_page", afterRepositoryId: "", limit: 10, principal: a },
    { op: "repository_count", principal: a },
  ] as const)
    expect(
      sessionActorReducerRoute({
        kind: "metadata",
        commandId: "test",
        request,
      }),
    ).toEqual({ scope: "catalog_read" });
  expect(
    sessionActorReducerRoute({
      kind: "metadata",
      commandId: "test",
      request: {
        op: "repository_put",
        repositoryId: "private",
        doc: "{}",
        expectedRev: null,
      },
    }),
  ).toEqual({ scope: "global" });
});
