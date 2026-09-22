import { configuredIdentity, getConfigAsync } from "../config";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAuthRoutes } from "./auth";
import { handleSetupRoutes } from "./setup";
import { connectedGithubAccounts } from "../github-auth";
import { resolveWebAuth } from "../web-auth";
import type { RouteContext } from "./context";

const savedConfig = process.env.OPENSESSION_CONFIG;
const savedStateDir = process.env.OPENSESSION_STATE_DIR;
const dirs: string[] = [];
const originalFetch = globalThis.fetch;
const savedGithubStore = process.env.OPENSESSION_GITHUB_AUTH_STORE;
const savedSessionsStore = process.env.OPENSESSION_WEB_SESSIONS_STORE;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (savedGithubStore === undefined)
    delete process.env.OPENSESSION_GITHUB_AUTH_STORE;
  else process.env.OPENSESSION_GITHUB_AUTH_STORE = savedGithubStore;
  if (savedSessionsStore === undefined)
    delete process.env.OPENSESSION_WEB_SESSIONS_STORE;
  else process.env.OPENSESSION_WEB_SESSIONS_STORE = savedSessionsStore;
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else {
    process.env.OPENSESSION_CONFIG = savedConfig;
    await getConfigAsync();
  }
  if (savedStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = savedStateDir;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("auth status names the server before sign-in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensession-auth-status-"));
  dirs.push(dir);
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ organization: { name: "Acme" } }));
  process.env.OPENSESSION_CONFIG = config;
  await getConfigAsync();

  const url = new URL("http://localhost/api/auth/status");
  const context: RouteContext = {
    req: new Request(url),
    url,
    path: url.pathname,
    publicPrefix: "",
    authUser: null,
  };
  const response = await handleAuthRoutes(context);

  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    authenticated: false,
    organizationName: "Acme",
  });
});

test("auth status carries the organization icon when one is configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensession-auth-status-"));
  dirs.push(dir);
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ organization: { name: "Acme" } }));
  process.env.OPENSESSION_CONFIG = config;
  await getConfigAsync();
  // The icon lives in the state dir (organizationIconPath), not beside the
  // config, so this test isolates that too.
  process.env.OPENSESSION_STATE_DIR = dir;

  const url = new URL("http://localhost/api/auth/status");
  const context: RouteContext = {
    req: new Request(url),
    url,
    path: url.pathname,
    publicPrefix: "",
    authUser: null,
  };
  const without = await handleAuthRoutes(context);
  expect((await without?.json()).organizationIconUrl).toBeNull();

  // An uploaded icon answers with its revisioned static URL, which the sign-in
  // gate can load because static assets stay pre-auth.
  mkdirSync(join(dir, ".opensession-organization"), { recursive: true });
  writeFileSync(
    join(dir, ".opensession-organization", "icon.png"),
    "png-bytes",
  );
  const withIcon = await handleAuthRoutes(context);
  expect((await withIcon?.json()).organizationIconUrl).toMatch(
    /^\/organization-icon\.png\?v=[a-f0-9]{12}$/,
  );
});

test("GitHub sign-in requires an administrator to add the login to Members first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensession-member-admission-"));
  dirs.push(dir);
  process.env.OPENSESSION_CONFIG = join(dir, "config.json");
  process.env.OPENSESSION_STATE_DIR = dir;
  process.env.OPENSESSION_GITHUB_AUTH_STORE = join(dir, "github-auth.json");
  process.env.OPENSESSION_WEB_SESSIONS_STORE = join(dir, "web-sessions.json");
  writeFileSync(
    process.env.OPENSESSION_CONFIG,
    JSON.stringify({
      integrations: {
        github: { userPrAuth: true, oauthClientId: "test-client" },
      },
      identity: {
        team: [{ name: "Acme Admin", github: "acme-admin", admin: true }],
      },
    }),
  );
  await getConfigAsync();

  // Only the external GitHub device-token exchange is stubbed. Admission,
  // roster mutation, and web-session issuance use their real route handlers.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({
        access_token: "synthetic-device-token",
        token_type: "bearer",
      });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ login: "acme-member", name: "Acme Member" });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  function post(
    path: string,
    body: unknown,
    authUser: RouteContext["authUser"] = null,
  ): RouteContext {
    const url = new URL(path, "http://localhost");
    return {
      req: new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      url,
      path,
      publicPrefix: "",
      authUser,
    };
  }
  const poll = () =>
    handleAuthRoutes(
      post("/api/auth/device/poll", { deviceCode: "synthetic-device-code" }),
    );
  const denied = await poll();
  expect(await denied?.json()).toEqual({
    status: "error",
    error:
      "GitHub account @acme-member is not a workspace member. Ask a workspace administrator to add your GitHub login in Settings > Members, then try signing in again.",
  });
  expect(denied?.headers.get("Set-Cookie")).toBeNull();
  expect(connectedGithubAccounts()).toEqual([]);
  expect(configuredIdentity().team).toHaveLength(1);

  const member = { name: "Acme Member", github: "acme-member" };
  const unauthorized = await handleSetupRoutes(
    post("/api/setup/team", member, {
      login: "acme-member",
      name: "Acme Member",
    }),
  );
  expect(unauthorized?.status).toBe(403);
  expect(configuredIdentity().team).toHaveLength(1);

  const added = await handleSetupRoutes(
    post("/api/setup/team", member, {
      login: "acme-admin",
      name: "Acme Admin",
    }),
  );
  expect(added?.status).toBe(201);
  expect(await added?.json()).toEqual({ member });
  await getConfigAsync();
  expect(configuredIdentity().team).toContainEqual(member);

  const accepted = await poll();
  expect(await accepted?.json()).toEqual({
    status: "ok",
    login: "acme-member",
    name: "Acme Member",
    admin: false,
  });
  const cookie = accepted?.headers.get("Set-Cookie");
  expect(cookie).toContain("HttpOnly");
  expect(
    resolveWebAuth(
      new Request("http://localhost/api/auth/status", {
        headers: { Cookie: cookie! },
      }),
    ),
  ).toEqual({ login: "acme-member", name: "Acme Member" });
  expect(connectedGithubAccounts().map((account) => account.login)).toEqual([
    "acme-member",
  ]);
});
