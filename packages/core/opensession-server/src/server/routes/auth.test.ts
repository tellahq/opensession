import { configuredIdentity, getConfigAsync } from "../config";
import { afterEach, expect, spyOn, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAuthRoutes } from "./auth";
import { handleSetupRoutes } from "./setup";
import { connectedGithubAccounts } from "../github-auth";
import * as configMutation from "../config-mutation";
import { refreshWebIdentity, resolveWebAuth } from "../web-auth";
import type { RouteContext } from "./context";

const savedConfig = process.env.OPENSESSION_CONFIG;
const savedStateDir = process.env.OPENSESSION_STATE_DIR;
const dirs: string[] = [];
const originalFetch = globalThis.fetch;
const savedGithubStore = process.env.OPENSESSION_GITHUB_AUTH_STORE;
const savedSessionsStore = process.env.OPENSESSION_WEB_SESSIONS_STORE;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis, "__webAuthSessions");
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

const existingMember = { name: "Acme Teammate", github: "acme-teammate" };

async function signInFixture(
  team: unknown[] = [existingMember],
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "opensession-enrollment-"));
  dirs.push(dir);
  Reflect.deleteProperty(globalThis, "__webAuthSessions");
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
      identity: { team },
    }),
  );
  await getConfigAsync();
  return dir;
}

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

function poll(body: Record<string, unknown> = {}) {
  return handleAuthRoutes(
    post("/api/auth/device/poll", {
      deviceCode: "synthetic-device-code",
      native: true,
      ...body,
    }),
  );
}

// Only GitHub's token exchange and /user are stubbed. All admission, storage,
// session issuance, and workspace management use the production implementations.
function githubAnswers(
  user: unknown = { login: "acme-member", name: "Acme Teammate" },
  grant: unknown = { access_token: "synthetic-device-token" },
  userStatus = 200,
  tokenStatus = 200,
) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token")
      return Response.json(grant, { status: tokenStatus });
    if (url === "https://api.github.com/user")
      return Response.json(user, { status: userStatus });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function storedTeam(dir: string) {
  return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).identity
    .team;
}

function identityFor(token: string) {
  return resolveWebAuth(
    new Request("http://localhost/api/auth/status", {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

test("any verified GitHub login enrolls before session issuance", async () => {
  const dir = await signInFixture();
  githubAnswers({
    login: "AcMe-Member",
    name: "Acme Teammate",
    email: "teammate@example.test",
  });
  const response = await poll({
    login: "acme-teammate",
    name: "Acme Teammate",
    email: "teammate@example.test",
  });
  expect(response?.status).toBe(200);
  const body = await response?.json();
  expect(body).toMatchObject({
    status: "ok",
    login: "acme-member",
    name: "acme-member",
  });
  expect(response?.headers.get("Set-Cookie")).toContain("HttpOnly");
  expect(storedTeam(dir)).toEqual([
    existingMember,
    {
      name: "acme-member",
      github: "acme-member",
      authGeneration: expect.any(String),
    },
  ]);
  expect(identityFor(body.token)).toMatchObject({
    login: "acme-member",
    name: "acme-member",
    authGeneration: storedTeam(dir)[1].authGeneration,
  });
  expect(connectedGithubAccounts().map((account) => account.login)).toEqual([
    "AcMe-Member",
  ]);
  const managed = await handleSetupRoutes(
    post(
      "/api/setup/team",
      { name: "Another Member" },
      identityFor(body.token),
    ),
  );
  expect(managed?.status).toBe(201);
  expect(storedTeam(dir).at(-1).name).toBe("Another Member");
  expect(body).not.toHaveProperty("admin");
  expect(body).not.toHaveProperty("canManage");
  const statusUrl = new URL("http://localhost/api/auth/status");
  const status = await handleAuthRoutes({
    req: new Request(statusUrl, {
      headers: { Authorization: `Bearer ${body.token}` },
    }),
    url: statusUrl,
    path: statusUrl.pathname,
    publicPrefix: "",
    authUser: identityFor(body.token),
  });
  const statusBody = await status?.json();
  expect(statusBody.authenticated).toBe(true);
  expect(statusBody).not.toHaveProperty("admin");
  expect(statusBody).not.toHaveProperty("canManage");
});

test("existing member profiles stay intact and every member can manage the workspace", async () => {
  const member = {
    name: "Acme Member",
    github: "AcMe-Member",
    email: "member@example.test",
    aliases: ["acme"],
  };
  const dir = await signInFixture([existingMember, member]);
  for (const [login, name] of [
    ["ACME-TEAMMATE", existingMember.name],
    ["acme-member", member.name],
  ] as const) {
    githubAnswers({ login, name: "Claimed Different Name" });
    const response = await poll();
    const body = await response?.json();
    expect(body).toMatchObject({
      status: "ok",
      login: login.toLowerCase(),
      name,
    });
    expect(body).not.toHaveProperty("admin");
    expect(body).not.toHaveProperty("canManage");
    const managed = await handleSetupRoutes(
      post(
        "/api/setup/team",
        { name: `Added by ${login}` },
        identityFor(body.token),
      ),
    );
    expect(managed?.status).toBe(201);
  }
  expect(storedTeam(dir).slice(0, 2)).toEqual([existingMember, member]);
  expect(storedTeam(dir)).toHaveLength(4);
});

test("enrollment leaves existing identities unchanged without adding roles", async () => {
  const existing = {
    name: "Acme Owner",
    github: "acme-owner",
    email: "owner@example.test",
  };
  const dir = await signInFixture([existing]);
  githubAnswers();
  expect((await (await poll())?.json()).status).toBe("ok");
  expect(storedTeam(dir)[0]).toEqual(existing);
  expect(storedTeam(dir)[1]).not.toHaveProperty("admin");
});

test("an empty roster can enroll its first member without role fields", async () => {
  const dir = await signInFixture([]);
  githubAnswers();
  const body = await (await poll())?.json();
  expect(body.status).toBe("ok");
  expect(body).not.toHaveProperty("admin");
  expect(body).not.toHaveProperty("canManage");
  expect(storedTeam(dir)[0]).not.toHaveProperty("admin");
});

test("repeated and concurrent first sign-ins create one case-normalized membership", async () => {
  const dir = await signInFixture();
  githubAnswers({ login: "ACME-MEMBER" });
  const results = await Promise.all(Array.from({ length: 8 }, () => poll()));
  for (const response of results)
    expect(await response?.json()).toMatchObject({
      status: "ok",
      login: "acme-member",
    });
  githubAnswers({ login: "acme-member" });
  expect(await (await poll())?.json()).toMatchObject({
    status: "ok",
  });
  expect(storedTeam(dir)).toHaveLength(2);
  expect(
    new Set(
      JSON.parse(
        readFileSync(join(dir, "web-sessions.json"), "utf8"),
      ).sessions.map((s: { authGeneration: string }) => s.authGeneration),
    ).size,
  ).toBe(1);
});

test("name, alias and first-name collisions cannot claim another identity", async () => {
  const protectedMember = {
    ...existingMember,
    name: "acme-member",
    aliases: ["github:acme-member"],
    email: "teammate@example.test",
  };
  const protectedFirst = {
    name: "github:acme-member:2 Person",
    github: "acme-other",
    email: "other@example.test",
  };
  const dir = await signInFixture([protectedMember, protectedFirst]);
  githubAnswers({
    login: "acme-member",
    name: protectedMember.name,
    email: protectedMember.email,
  });
  expect(await (await poll())?.json()).toMatchObject({
    status: "ok",
    name: "github:acme-member:3",
    login: "acme-member",
  });
  expect(storedTeam(dir).slice(0, 2)).toEqual([
    protectedMember,
    protectedFirst,
  ]);
  expect(storedTeam(dir)[2]).not.toHaveProperty("email");
  expect(storedTeam(dir)[2]).not.toHaveProperty("aliases");
});

test("unverified, malformed, expired and pending flows never enroll a member", async () => {
  const dir = await signInFixture();
  for (const grant of [
    { error: "authorization_pending" },
    { error: "expired_token" },
    { error: "access_denied" },
    { error: "incorrect_device_code" },
    { error: "slow_down" },
    {},
    { access_token: 123 },
  ]) {
    githubAnswers(undefined, grant);
    const response = await poll({ login: "acme-member" });
    expect((await response?.json()).status).not.toBe("ok");
    expect(response?.headers.get("Set-Cookie")).toBeNull();
    expect(storedTeam(dir)).toEqual([existingMember]);
  }
  for (const user of [{}, { login: 123 }, { login: "acme-member admin" }]) {
    githubAnswers(user);
    expect(await (await poll())?.json()).toMatchObject({ status: "error" });
  }
  githubAnswers({ login: "acme-member" }, undefined, 401);
  expect(await (await poll())?.json()).toMatchObject({ status: "error" });
  githubAnswers({ login: "acme-member" }, undefined, 200, 500);
  expect(await (await poll())?.json()).toMatchObject({ status: "error" });
  expect((await poll({ deviceCode: "" }))?.status).toBe(400);
  expect(storedTeam(dir)).toEqual([existingMember]);
  expect(connectedGithubAccounts()).toEqual([]);
});

test("failed atomic roster persistence issues no session or in-memory membership; retry works", async () => {
  const dir = await signInFixture();
  githubAnswers();
  const failure = spyOn(
    configMutation,
    "persistRawConfigAsync",
  ).mockRejectedValue(new Error("synthetic disk failure"));
  try {
    const response = await poll();
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({
      status: "error",
      error: "Could not save sign-in. Please try again.",
    });
    expect(response?.headers.get("Set-Cookie")).toBeNull();
    expect(storedTeam(dir)).toEqual([existingMember]);
    expect(configuredIdentity().team).toEqual([existingMember]);
    expect(Reflect.get(globalThis, "__webAuthSessions")?.size ?? 0).toBe(0);
  } finally {
    failure.mockRestore();
  }
  expect(await (await poll())?.json()).toMatchObject({
    status: "ok",
  });
});

test("session persistence failure cannot leave an authenticated session in memory", async () => {
  const dir = await signInFixture();
  githubAnswers();
  mkdirSync(join(dir, "web-sessions.json")); // Atomic rename cannot overwrite a directory.
  const response = await poll();
  expect(response?.status).toBe(503);
  expect(response?.headers.get("Set-Cookie")).toBeNull();
  expect(Reflect.get(globalThis, "__webAuthSessions")?.size ?? 0).toBe(0);
  expect(storedTeam(dir)).toHaveLength(2); // Durable membership, but never a session before it.
  rmSync(join(dir, "web-sessions.json"), { recursive: true });
  expect(await (await poll())?.json()).toMatchObject({
    status: "ok",
  });
});

test("reenrollment never revives old sessions or sockets, even without a request while removed", async () => {
  const dir = await signInFixture();
  githubAnswers();
  const first = await (await poll())?.json();
  const oldIdentity = identityFor(first.token)!;
  const removed = await handleSetupRoutes(
    post(
      "/api/setup/team/acme-member/remove",
      {},
      { login: "acme-teammate", name: existingMember.name },
    ),
  );
  expect(removed?.status).toBe(200);
  // Do not resolve the old session between removal and rejoining: its lazy
  // deletion is not sufficient to stop a previously idle client returning.
  const second = await (await poll())?.json();
  expect(second).toMatchObject({ status: "ok" });
  expect(storedTeam(dir)).toHaveLength(2);
  expect(identityFor(second.token)?.authGeneration).not.toBe(
    oldIdentity.authGeneration,
  );
  expect(refreshWebIdentity(oldIdentity)).toBeNull();
  expect(identityFor(first.token)).toBeNull();
  Reflect.deleteProperty(globalThis, "__webAuthSessions");
  expect(identityFor(first.token)).toBeNull();
  expect(identityFor(second.token)).not.toBeNull();
});

test("a cached verified flow can rejoin without reviving an old member session", async () => {
  const dir = await signInFixture();
  githubAnswers({ login: "acme-teammate" });
  const first = await (await poll())?.json();
  expect(first.status).toBe("ok");
  const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  config.identity.team = [];
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  await getConfigAsync();
  const flows = Reflect.get(globalThis, "__osWatchedDeviceFlows");
  flows.set("synthetic-cached-flow", {
    status: "ok",
    login: "acme-teammate",
    name: "Acme Teammate",
    expiresAt: Date.now() + 60_000,
  });
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("cached flow must not poll GitHub");
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const second = await (
      await poll({ deviceCode: "synthetic-cached-flow" })
    )?.json();
    expect(second).toMatchObject({ status: "ok" });
    expect(identityFor(first.token)).toBeNull();
    expect(identityFor(second.token)).not.toBeNull();
  } finally {
    flows.delete("synthetic-cached-flow");
  }
});

test("cached success cannot enroll with a revoked, expired or missing GitHub grant", async () => {
  const dir = await signInFixture();
  const flows = Reflect.get(globalThis, "__osWatchedDeviceFlows");
  flows.set("synthetic-unusable-flow", {
    status: "ok",
    login: "acme-member",
    expiresAt: Date.now() + 60_000,
  });
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("cached flow must not poll GitHub");
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    for (const account of [
      undefined,
      {
        login: "acme-member",
        token: "synthetic",
        source: "device",
        refreshFailedAt: new Date().toISOString(),
      },
      {
        login: "acme-member",
        token: "synthetic",
        source: "device",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
      { login: "acme-other", token: "synthetic", source: "device" },
    ]) {
      writeFileSync(
        join(dir, "github-auth.json"),
        JSON.stringify({ users: { "acme-member": account } }),
      );
      const response = await poll({ deviceCode: "synthetic-unusable-flow" });
      expect(response?.status).toBe(401);
      expect(response?.headers.get("Set-Cookie")).toBeNull();
      expect(storedTeam(dir)).toEqual([existingMember]);
    }
  } finally {
    flows.delete("synthetic-unusable-flow");
  }
});

test("expired watched results still require a valid device exchange and cannot enroll", async () => {
  const dir = await signInFixture();
  const flows = Reflect.get(globalThis, "__osWatchedDeviceFlows");
  flows.set("synthetic-expired-flow", {
    status: "ok",
    login: "acme-member",
    expiresAt: Date.now() - 1,
  });
  githubAnswers(undefined, { error: "expired_token" });
  expect(
    await (await poll({ deviceCode: "synthetic-expired-flow" }))?.json(),
  ).toEqual({ status: "error", error: "expired_token" });
  expect(storedTeam(dir)).toEqual([existingMember]);
  expect(flows.has("synthetic-expired-flow")).toBe(false);
});

test("verified managed-user logins with underscores can enroll", async () => {
  await signInFixture();
  githubAnswers({ login: "Acme_Managed" });
  expect(await (await poll())?.json()).toMatchObject({
    status: "ok",
    login: "acme_managed",
    name: "acme_managed",
  });
});
