import { afterAll, afterEach, expect, test } from "bun:test";
import {
  captureClientDataScope,
  clientDataScopeHeaders,
  clientDataStorageKey,
  isCurrentClientDataScope,
  publishClientDataIdentity,
  subscribeClientDataScope,
} from "./client-data-scope";
import { cachedRepos, rememberRepos, cachedNewSessionRepo } from "./repo-cache";
import { repoCount, rememberRepoCount } from "./repo-count";
import {
  cacheTranscriptView,
  peekCachedTranscriptView,
} from "../components/session-viewer/transcript-cache";
const storage = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
});
afterEach(() => publishClientDataIdentity(null));
const identify = (githubAccountId: number) =>
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId,
  });
test("same display name cannot alias numeric identities; null invalidates A even when A returns", () => {
  identify(11);
  const a = captureClientDataScope();
  identify(11);
  expect(captureClientDataScope()).toBe(a);
  identify(22);
  expect(isCurrentClientDataScope(a)).toBe(false);
  expect(clientDataScopeHeaders(a)).toEqual({
    "X-OpenSession-Privacy": "personal-v1",
    "X-OpenSession-Expected-GitHub-Account-Id": "11",
  });
  identify(11);
  expect(isCurrentClientDataScope(a)).toBe(false);
  publishClientDataIdentity(null);
  expect(captureClientDataScope()).toBeNull();
  expect(clientDataStorageKey("repos")).toBeNull();
});
test("legacy shared read lifetime never proves a durable identity or personal capability", () => {
  publishClientDataIdentity({ required: true, authenticated: true });
  const legacy = captureClientDataScope();
  expect(clientDataStorageKey("repos")).toBeNull();
  expect(clientDataScopeHeaders(legacy)).toEqual({});
  publishClientDataIdentity({ required: true, authenticated: true });
  expect(isCurrentClientDataScope(legacy)).toBe(true);
  publishClientDataIdentity(null);
  expect(isCurrentClientDataScope(legacy)).toBe(false);
  publishClientDataIdentity({ required: false, authenticated: false });
  expect(clientDataStorageKey("repos")).toBe("repos");
});
test("warm A repos/default/count never hydrate B, unknown, or ambiguous old storage", () => {
  storage.set(
    "opensession-repos",
    JSON.stringify({
      repos: [
        { id: "ambiguous", defaultBranch: "main", sharedCheckout: false },
      ],
    }),
  );
  identify(11);
  expect(cachedRepos()).toEqual([]);
  rememberRepos(
    [{ id: "private-A", defaultBranch: "main", sharedCheckout: false }],
    "private-A",
  );
  rememberRepoCount(1);
  expect(cachedNewSessionRepo()).toBe("private-A");
  identify(22);
  expect(cachedRepos()).toEqual([]);
  expect(cachedNewSessionRepo()).toBe("");
  expect(repoCount()).toBeNull();
  publishClientDataIdentity(null);
  expect(cachedRepos()).toEqual([]);
  expect(repoCount()).toBeNull();
  identify(11);
  expect(cachedRepos()[0]?.id).toBe("private-A");
});
test("scope invalidation synchronously clears transcript reuse before another tree mounts", () => {
  identify(11);
  cacheTranscriptView("private-session", {
    entries: [],
    cursor: null,
    seq: null,
    historyTruncated: false,
    historyStart: null,
    index: null,
    indexEpoch: null,
    scrollTop: 0,
    following: true,
    anchorEid: null,
    anchorTop: null,
  });
  expect(peekCachedTranscriptView("private-session")).not.toBeNull();
  let notified = 0;
  const stop = subscribeClientDataScope(() => notified++);
  identify(22);
  expect(peekCachedTranscriptView("private-session")).toBeNull();
  expect(notified).toBe(1);
  stop();
});

afterAll(() => {
  if (originalStorage)
    Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("negotiated numeric account scopes never alias old numeric-looking GitHub logins", async () => {
  const { negotiatedClientCommandScope } = await import("./client-data-scope");
  identify(41);
  const scope = captureClientDataScope();
  expect(scope?.key).toBe("github-account:41");
  expect(negotiatedClientCommandScope(scope, "github:41")).toBeNull();
  expect(negotiatedClientCommandScope(scope, "github-account:41")).toBe(
    "github-account:41",
  );
  expect(negotiatedClientCommandScope(scope)).toBeNull();
  publishClientDataIdentity({ required: false, authenticated: false });
  expect(
    negotiatedClientCommandScope(captureClientDataScope(), "local:Alice"),
  ).toBe("shared:local");
  expect(negotiatedClientCommandScope(captureClientDataScope())).toBe(
    "shared:local",
  );
  expect(
    negotiatedClientCommandScope(captureClientDataScope(), "github:41"),
  ).toBeNull();
});

test("unchanged local, verified and legacy probes preserve their mounted lifetime", () => {
  for (const identity of [
    { required: false, authenticated: false },
    { required: true, authenticated: true, githubAccountId: 11 },
    { required: true, authenticated: true, login: "41" },
  ]) {
    publishClientDataIdentity(identity);
    const scope = captureClientDataScope();
    let invalidations = 0;
    const stop = subscribeClientDataScope(() => invalidations++);
    publishClientDataIdentity({ ...identity });
    expect(captureClientDataScope()).toBe(scope);
    expect(invalidations).toBe(0);
    stop();
  }
  const legacy = captureClientDataScope();
  expect(legacy?.key).toBe("shared:legacy");
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    login: "different",
  });
  expect(isCurrentClientDataScope(legacy)).toBe(false);
});
