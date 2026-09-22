import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getConfigAsync } from "./config";
import {
  __setGithubAppKeyPathForTest,
  githubInstallationCredential,
} from "./github-app";
import {
  __waitForGhProbesForTest,
  ghBackoffUntil,
  ghRateLimited,
  noteGhRateLimited,
} from "./github-limit";
import { githubRequest, listReviewThreads } from "../agents/github/github-rest";
import { getPrAutomationDetails } from "./pr-info";
import { refreshIssueCache, getOpenIssues } from "./issue-cache";

const savedConfig = process.env.OPENSESSION_CONFIG;
const savedClient = process.env.OPENSESSION_GITHUB_CLIENT_ID;
const originalFetch = globalThis.fetch;
let dir: string;
const calls: Array<{ url: string; auth: string }> = [];
const reset = Math.floor(Date.now() / 1000) + 3600;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "os-gh-limit-integration-"));
  const key = join(dir, "key.pem");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(key, privateKey.export({ format: "pem", type: "pkcs8" }));
  __setGithubAppKeyPathForTest(key);
  process.env.OPENSESSION_CONFIG = join(dir, "config.json");
  delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
  await writeFile(
    process.env.OPENSESSION_CONFIG,
    JSON.stringify({
      integrations: {
        github: {
          oauthClientId: "Iv-acme-limits",
          appSlug: "acme-app",
          installationOwner: "acme",
        },
      },
      repos: {
        acme: { repo: join(dir, "acme"), ghRepo: "acme/app" },
        other: { repo: join(dir, "other"), ghRepo: "other/app" },
      },
    }),
  );
  await getConfigAsync();
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("Authorization") || "";
    calls.push({ url, auth });
    if (url.includes("/app/installations?"))
      return Response.json([
        { id: 9101, account: { login: "acme", type: "Organization" } },
        { id: 9202, account: { login: "other", type: "Organization" } },
      ]);
    if (url.endsWith("/app/installations/9202"))
      return Response.json({ account: { login: "other" } });
    const mint = url.match(/\/app\/installations\/(\d+)\/access_tokens$/);
    if (mint)
      return Response.json({
        token: `fake-${mint[1]}`,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    if (url.endsWith("/rate_limit"))
      return Response.json({
        resources: { graphql: { reset }, core: { reset } },
      });
    if (url.endsWith("/graphql"))
      return Response.json({
        data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
      });
    if (url.includes("/repos/acme/"))
      return Response.json(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(reset),
          },
        },
      );
    if (url.includes("/repos/other/app/issues?"))
      return Response.json([
        {
          number: 1,
          title: "Example issue",
          state: "open",
          html_url: "https://github.com/other/app/issues/1",
          user: { login: "alice" },
          updated_at: "2026-01-01T00:00:00Z",
          created_at: "2026-01-01T00:00:00Z",
        },
      ]);
    if (url.includes("/repos/other/")) return Response.json([]);
    throw new Error("Unexpected fixture request");
  }) as typeof fetch;
});

afterAll(async () => {
  await __waitForGhProbesForTest();
  globalThis.fetch = originalFetch;
  __setGithubAppKeyPathForTest(undefined);
  if (savedClient === undefined)
    delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
  else process.env.OPENSESSION_GITHUB_CLIENT_ID = savedClient;
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = savedConfig;
  await getConfigAsync();
  await rm(dir, { recursive: true, force: true });
});

test("real credential selection, API callers, and sweeps isolate two installations", async () => {
  const first = await githubInstallationCredential();
  const second = await githubInstallationCredential({ repo: "other/app" });
  expect(first?.rateLimitKey).toBe("installation:Iv-acme-limits:9101");
  expect(second?.rateLimitKey).toBe("installation:Iv-acme-limits:9202");
  expect(
    (await githubInstallationCredential({ repo: "ACME/another", write: true }))
      ?.rateLimitKey,
  ).toBe(first!.rateLimitKey);
  expect(
    (await githubInstallationCredential({ owner: "OTHER" }))?.rateLimitKey,
  ).toBe(second!.rateLimitKey);
  expect(
    await githubInstallationCredential({ repo: "missing/app" }),
  ).toBeNull();
  expect(await githubInstallationCredential({ repo: "" })).toBeNull();
  expect(
    await githubInstallationCredential({ repo: "acme/app/extra" }),
  ).toBeNull();

  expect((await githubRequest("GET", "/repos/acme/app/pulls")).status).toBe(
    403,
  );
  expect(await ghRateLimited("rest")).toBe(true);
  // Writes retain their pre-existing attempt-and-record behavior even with a
  // known REST backoff. A local synthetic 429 would skip this successful POST.
  const fixtureFetch = globalThis.fetch;
  let attemptedWrite = false;
  globalThis.fetch = (async (input, init) => {
    if (
      String(input).endsWith("/repos/acme/app/issues/1/comments") &&
      init?.method === "POST"
    ) {
      attemptedWrite = true;
      return Response.json({ id: 1 });
    }
    return fixtureFetch(input, init);
  }) as typeof fetch;
  try {
    expect(
      (
        await githubRequest("POST", "/repos/acme/app/issues/1/comments", {
          body: "Example comment",
        })
      ).ok,
    ).toBe(true);
    expect(attemptedWrite).toBe(true);
  } finally {
    globalThis.fetch = fixtureFetch;
  }
  expect(await ghRateLimited("rest", { repo: "ACME/another" })).toBe(true);
  expect(await ghRateLimited("rest", { repo: "other/app" })).toBe(false);
  expect((await githubRequest("GET", "/repos/other/app/pulls")).ok).toBe(true);
  await expect(getPrAutomationDetails("1", "acme/app")).rejects.toThrow(
    "rate-limited",
  );
  expect(await getPrAutomationDetails("branch", "other/app")).toBeNull();

  await refreshIssueCache();
  expect((await getOpenIssues()).map((issue) => issue.ghRepo)).toEqual([
    "other/app",
  ]);
  expect(calls.some((c) => c.url.includes("/repos/acme/app/issues?"))).toBe(
    false,
  );

  // A headerless rejection must probe the token supplied, not the default.
  await noteGhRateLimited("fixture", undefined, "graphql", second!);
  await __waitForGhProbesForTest();
  expect(calls.find((c) => c.url.endsWith("/rate_limit"))?.auth).toBe(
    "Bearer fake-9202",
  );
  expect(await ghRateLimited("graphql")).toBe(false);
  expect(await ghBackoffUntil("graphql", { repo: "other/another" })).toBe(
    reset * 1000 + 30_000,
  );
  const before = calls.filter((c) => c.url.endsWith("/graphql")).length;
  await listReviewThreads(1, "other/app");
  expect(calls.filter((c) => c.url.endsWith("/graphql"))).toHaveLength(before);
  await listReviewThreads(1, "acme/app");
  expect(calls.filter((c) => c.url.endsWith("/graphql"))).toHaveLength(
    before + 1,
  );

  // A changed default (including the numeric selector) follows the selected ID.
  const nextConfig = join(dir, "next-config.json");
  await writeFile(
    nextConfig,
    JSON.stringify({
      integrations: {
        github: {
          oauthClientId: "Iv-acme-limits",
          appSlug: "acme-app",
          installationId: 9202,
        },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = nextConfig;
  await getConfigAsync();
  expect((await githubInstallationCredential())?.rateLimitKey).toBe(
    second!.rateLimitKey,
  );
  expect(await ghRateLimited("rest")).toBe(false);
  expect(await ghRateLimited("graphql")).toBe(true);
});
