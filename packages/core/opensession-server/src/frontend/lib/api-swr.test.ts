import { describe, expect, test } from "bun:test";
import { apiSWRKey, sessionApiKeyFilter } from "./api-swr";

describe("sessionApiKeyFilter", () => {
  const matches = sessionApiKeyFilter("os-new");

  test("selects every resource keyed by that session", () => {
    expect(matches(apiSWRKey.session("os-new"))).toBe(true);
    expect(matches(apiSWRKey.sessionPr("os-new", "opensession", "main"))).toBe(
      true,
    );
    expect(matches(apiSWRKey.sessionGit("os-new"))).toBe(true);
    expect(matches(apiSWRKey.sessionDiff("os-new"))).toBe(true);
    expect(matches(apiSWRKey.sessionAssets("os-new"))).toBe(true);
    expect(matches(apiSWRKey.workspaceOverview("sessions:os-new"))).toBe(true);
  });

  test("leaves other sessions, workspaces, and previews alone", () => {
    expect(matches(apiSWRKey.session("os-other"))).toBe(false);
    expect(matches(apiSWRKey.sessionPr("os-other", "opensession"))).toBe(false);
    expect(matches(apiSWRKey.workspaceOverview("ws-1"))).toBe(false);
    expect(matches(apiSWRKey.previewPr("opensession", "os-new"))).toBe(false);
    expect(matches("api/session/os-new")).toBe(false);
    expect(matches(null)).toBe(false);
  });
});

test("SWR resource identity cannot reuse another principal or an earlier lifetime", async () => {
  const { publishClientDataIdentity } = await import("./client-data-scope");
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId: 11,
  });
  const a = apiSWRKey.session("same-session");
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId: 22,
  });
  expect(apiSWRKey.session("same-session")).not.toEqual(a);
  publishClientDataIdentity(null);
  expect(apiSWRKey.session("same-session")).not.toEqual(a);
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId: 11,
  });
  expect(apiSWRKey.session("same-session")).not.toEqual(a);
  publishClientDataIdentity(null);
});

test("provider-bound creation refresh revalidates an early 404 without polling", async () => {
  const { initCache, SWRGlobalState } = await import("swr/_internal");
  const { unstable_serialize, mutate: globalMutate } = await import("swr");
  const cache = new Map();
  const [, mutate] = initCache(cache)!;
  const resource = apiSWRKey.session("early-404");
  const key = unstable_serialize(resource);
  cache.set(key, { _k: resource, error: new Error("404") });
  let reads = 1;
  const revalidators = SWRGlobalState.get(cache)![0];
  revalidators[key] = [
    // SAFETY: this fixture receives only MUTATE_EVENT, whose SWR callback returns Promise<boolean>.
    (async () => {
      reads++;
      cache.set(key, { _k: resource, data: { id: "early-404" } });
      return true;
    }) as (typeof revalidators)[string][number],
  ];
  await globalMutate(sessionApiKeyFilter("early-404"));
  expect(reads).toBe(1);
  await mutate(sessionApiKeyFilter("early-404"));
  expect(reads).toBe(2);
  expect(cache.get(key).data).toEqual({ id: "early-404" });
  const source = await Bun.file(
    new URL("../hooks/useSessionTabs.tsx", import.meta.url),
  ).text();
  expect(source).toContain(
    "const { mutate: revalidateApiResources } = useSWRConfig()",
  );
  expect(source).not.toContain("mutate as revalidateApiResources");
  SWRGlobalState.delete(cache);
});
