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
const personalA = { kind: "personal", ownerGithubAccountId: 101 };

function seed(id: string, accessScope?: unknown) {
  store.seedSessionMetadataCatalog([
    {
      sessionId: id,
      doc: JSON.stringify({ id, accessScope }),
      rev: 1,
      archived: false,
      lastActivityMs: 1,
    },
  ]);
}
function put(id: string, rev: number, accessScope?: unknown) {
  return store.putSessionMetadata({
    op: "put",
    principal: a,
    sessionId: id,
    requestId: `${id}-${rev}`,
    expectedRev: rev === 1 ? null : rev - 1,
    rev,
    doc: JSON.stringify({ id, accessScope }),
    archived: false,
    lastActivityMs: 1,
  });
}

test("catalog exact ids, pages and counts deny other owners and unattributed callers", () => {
  seed("00-hidden", personalA);
  seed("01-shared");
  seed("02-b", { kind: "personal", ownerGithubAccountId: 202 });
  seed("03-shared-explicit", { kind: "shared" });
  for (const [principal, ids] of [
    [undefined, ["01-shared", "03-shared-explicit"]],
    [a, ["00-hidden", "01-shared", "03-shared-explicit"]],
    [b, ["01-shared", "02-b", "03-shared-explicit"]],
  ] as const) {
    expect(
      store
        .sessionMetadataCatalogPage("", 100, principal)
        .map((row) => row.sessionId),
    ).toEqual([...ids]);
    expect(store.sessionMetadataCatalogCount(principal)).toBe(ids.length);
  }
  expect(store.sessionMetadataCatalogGet("00-hidden")).toBeNull();
  expect(store.sessionMetadataCatalogGet("00-hidden", b)).toBeNull();
  expect(store.sessionMetadataCatalogGet("00-hidden", a)?.sessionId).toBe(
    "00-hidden",
  );
  expect(store.sessionMetadataCatalogPage("", 1)[0]?.sessionId).toBe(
    "01-shared",
  );
});

test("malformed claimed scopes stay invisible even on legacy catalog seed", () => {
  for (const [i, scope] of [
    null,
    {},
    "personal",
    { kind: "future" },
    { kind: "personal" },
    { kind: "personal", ownerGithubAccountId: "101" },
    { kind: "personal", ownerGithubAccountId: 0 },
    { kind: "shared", ownerGithubAccountId: 101 },
  ].entries())
    seed(`bad-${i}`, scope);
  expect(store.sessionMetadataCatalogCount()).toBe(0);
  expect(store.sessionMetadataCatalogCount(a)).toBe(0);
  expect(store.sessionMetadataCatalogPage("", 100, a)).toEqual([]);
  expect(() =>
    store.sessionMetadataCatalogCount({ githubAccountId: NaN }),
  ).toThrow("Invalid access principal");
});

test("metadata ownership cannot change, disappear on old-client writes or transfer on recovery", () => {
  expect(put("private", 1, personalA).status).toBe("committed");
  expect(() => put("private", 2)).toThrow("immutable");
  expect(() => put("private", 2, { kind: "shared" })).toThrow("immutable");
  expect(() =>
    put("private", 2, { kind: "personal", ownerGithubAccountId: 202 }),
  ).toThrow("Session not found");
  expect(put("private", 2, personalA).status).toBe("committed");
  expect(put("shared", 1).status).toBe("committed");
  expect(() => put("shared", 2, personalA)).toThrow("immutable");
  expect(() => put("invalid", 1, null)).toThrow("Invalid session access scope");
});

test("scoped queries route only to the central catalog, never a session actor", () => {
  for (const request of [
    { op: "catalog_get", sessionId: "private", principal: a },
    { op: "catalog_page", afterSessionId: "", limit: 10, principal: a },
    { op: "catalog_count", principal: a },
  ] as const) {
    expect(
      sessionActorReducerRoute({
        kind: "metadata",
        commandId: "test",
        request,
      }),
    ).toEqual({ scope: "catalog_read" });
  }
});

test("catalog denial is distinguishable from missing without returning hidden content", () => {
  seed("private", personalA);
  expect(store.sessionMetadataCatalogRead("private")).toEqual({
    status: "denied",
  });
  expect(store.sessionMetadataCatalogRead("unknown")).toEqual({
    status: "missing",
  });
  expect(store.sessionMetadataCatalogRead("private", a)).toMatchObject({
    status: "found",
    record: { sessionId: "private" },
  });
});

test("lazy actor materialization cannot downgrade a seeded catalog owner", () => {
  seed("seeded", personalA);
  expect(() => put("seeded", 1)).toThrow("immutable");
  expect(store.sessionMetadataCatalogRead("seeded")).toEqual({
    status: "denied",
  });
  expect(store.sessionMetadata("seeded")).toBeNull();
});

test("unattributed actor metadata reads and mutation conflicts do not reveal private documents", () => {
  put("private", 1, personalA);
  expect(store.accessibleSessionMetadata("private")).toBeNull();
  expect(store.accessibleSessionMetadata("private", b)).toBeNull();
  expect(store.accessibleSessionMetadata("private", a)?.sessionId).toBe(
    "private",
  );
  expect(() =>
    store.putSessionMetadata({
      op: "put",
      sessionId: "private",
      requestId: "spoof",
      expectedRev: null,
      rev: 1,
      doc: "{}",
      archived: false,
      lastActivityMs: 1,
    }),
  ).toThrow("Session not found");
});
