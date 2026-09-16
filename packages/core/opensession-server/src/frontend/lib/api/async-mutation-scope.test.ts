import { afterEach, expect, test } from "bun:test";
import {
  captureClientDataScope,
  publishClientDataIdentity,
} from "../client-data-scope";
import { uploadRepoIconApi } from "./repos";
import { saveOrganizationSettings, uploadOrganizationIcon } from "./settings";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  publishClientDataIdentity(null);
});
const identify = (githubAccountId: number) =>
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId,
  });

for (const operation of [
  {
    name: "repo image preprocessing",
    write: (scope: ReturnType<typeof captureClientDataScope>) =>
      uploadRepoIconApi("repo", new Blob(), scope),
  },
  {
    name: "organization image preprocessing",
    write: (scope: ReturnType<typeof captureClientDataScope>) =>
      uploadOrganizationIcon(new Blob(), scope),
  },
  {
    name: "organization profile lookup",
    write: (scope: ReturnType<typeof captureClientDataScope>) =>
      saveOrganizationSettings({ organizationName: "A organization" }, scope),
  },
]) {
  test(`delayed A ${operation.name} cannot dispatch a B mutation`, async () => {
    let calls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        calls++;
        return Response.json({});
      },
      { preconnect: originalFetch.preconnect },
    );
    identify(11);
    const scope = captureClientDataScope();
    const preprocessing = Promise.withResolvers<void>();
    const pending = (async () => {
      await preprocessing.promise;
      return operation.write(scope);
    })();
    identify(22);
    preprocessing.resolve();
    await expect(pending).rejects.toThrow("account changed");
    expect(calls).toBe(0);
  });
}

test("image upload carries the original verified precondition", async () => {
  const headers: Headers[] = [];
  globalThis.fetch = Object.assign(
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      return Response.json({
        organizationName: "A",
        organizationIconUrl: null,
        organizationIconRevision: null,
        configPath: "fixture",
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  identify(11);
  const scope = captureClientDataScope();
  await uploadRepoIconApi("repo", new Blob(), scope);
  await uploadOrganizationIcon(new Blob(), scope);
  expect(
    headers.map((h) => h.get("X-OpenSession-Expected-GitHub-Account-Id")),
  ).toEqual(["11", "11"]);
});
