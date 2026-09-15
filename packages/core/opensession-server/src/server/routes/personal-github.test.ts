import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePersonalGithubRoutes } from "./personal-github";
import type { RouteContext } from "./context";

const savedConfig = process.env.OPENSESSION_CONFIG;
const originalFetch = globalThis.fetch;
let dir: string;
let fetches: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "personal-github-routes-"));
  process.env.OPENSESSION_CONFIG = join(dir, "config.json");
  writeFileSync(
    process.env.OPENSESSION_CONFIG,
    JSON.stringify({
      integrations: {
        github: { userPrAuth: true, oauthClientId: "synthetic" },
      },
    }),
  );
  fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error("Personal admission must precede all external requests");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  expect(fetches).toBe(0);
  globalThis.fetch = originalFetch;
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = savedConfig;
  rmSync(dir, { recursive: true, force: true });
});

const alice = { login: "alice", name: "Alice", githubAccountId: 101 };
const bob = { login: "bob", name: "Bob", githubAccountId: 202 };
function context(
  path: string,
  method = "GET",
  authUser: RouteContext["authUser"] = alice,
): RouteContext {
  const url = new URL(path, "http://demo");
  return {
    url,
    path: url.pathname,
    publicPrefix: "",
    authUser,
    req: new Request(url, {
      method,
      ...(method === "GET"
        ? {}
        : {
            body: JSON.stringify({
              user: "alice",
              githubAccountId: 101,
              isolationQualified: true,
              sandbox: true,
            }),
          }),
    }),
  };
}

test("anonymous, automation, and old clients cannot spoof a verified principal", async () => {
  for (const identity of [
    null,
    { login: "alice", name: "Alice" },
    { ...alice, automation: true },
  ]) {
    const response = await handlePersonalGithubRoutes(
      context("/api/personal/github/manifest", "POST", identity),
    );
    expect(response?.status).toBe(401);
    expect(response?.headers.get("cache-control")).toBe("no-store");
  }
});

test("status reports unavailable separately from existing shared App setup", async () => {
  const response = await handlePersonalGithubRoutes(
    context("/api/personal/github/status"),
  );
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    available: false,
    code: "personal_isolation_unavailable",
  });
  expect(
    await handlePersonalGithubRoutes(
      context("/api/setup/github/manifest", "POST"),
    ),
  ).toBeUndefined();
  expect(
    await handlePersonalGithubRoutes(context("/api/repos")),
  ).toBeUndefined();
});

test("A and B cannot provision, import, refresh, disconnect or bypass qualification", async () => {
  for (const identity of [alice, bob]) {
    for (const [path, method] of [
      ["/api/personal/github/manifest", "POST"],
      ["/api/personal/repos", "POST"],
      ["/api/personal/github/apps/known-a/refresh", "POST"],
      ["/api/personal/github/apps/known-a", "DELETE"],
    ]) {
      const response = await handlePersonalGithubRoutes(
        context(path!, method!, identity),
      );
      expect(response?.status).toBe(503);
      expect(response?.headers.get("vary")).toBe("Cookie, Authorization");
    }
  }
});

test("exact ids and replayed or wrong-owner callbacks disclose nothing and never convert", async () => {
  for (const identity of [alice, bob, alice]) {
    for (const path of [
      "/api/personal/repos/known-a",
      "/api/personal/github/apps/known-a",
      "/api/personal/github/manifest/callback?state=old-a&code=synthetic",
    ]) {
      const response = await handlePersonalGithubRoutes(
        context(path, "GET", identity),
      );
      expect(response?.status).toBe(404);
      expect(await response?.json()).toEqual({ error: "Not found" });
    }
  }
});

test("simple mode cannot enable personal setup even with an injected identity", async () => {
  writeFileSync(process.env.OPENSESSION_CONFIG!, "{}");
  expect(
    (
      await handlePersonalGithubRoutes(
        context("/api/personal/github/manifest", "POST"),
      )
    )?.status,
  ).toBe(401);
});
