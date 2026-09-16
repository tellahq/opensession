import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollGithubDeviceFlow } from "./github-auth";
import { handleAuthRoutes } from "./routes/auth";
import { bootstrapUserAuthOnConnect } from "./routes/connections";
import {
  githubAccountId,
  personalAdmission,
  personalPrincipal,
} from "./personal-access";
import {
  createWebSession,
  refreshWebIdentity,
  resolveWebAuth,
} from "./web-auth";

const keys = [
  "OPENSESSION_CONFIG",
  "OPENSESSION_WEB_SESSIONS_STORE",
  "OPENSESSION_GITHUB_AUTH_STORE",
  "OPENSESSION_GITHUB_CLIENT_ID",
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "personal-access-"));
  for (const key of keys) delete process.env[key];
  process.env.OPENSESSION_CONFIG = join(dir, "config.json");
  process.env.OPENSESSION_WEB_SESSIONS_STORE = join(dir, "sessions.json");
  process.env.OPENSESSION_GITHUB_AUTH_STORE = join(dir, "grants.json");
  writeFileSync(
    process.env.OPENSESSION_CONFIG,
    JSON.stringify({
      identity: {
        team: [
          { name: "Alice", github: "alice" },
          { name: "Bob", github: "bob" },
        ],
      },
      integrations: {
        github: { userPrAuth: true, oauthClientId: "synthetic-client" },
      },
    }),
  );
  delete (globalThis as { __webAuthSessions?: unknown }).__webAuthSessions;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  delete (globalThis as { __webAuthSessions?: unknown }).__webAuthSessions;
  rmSync(dir, { recursive: true, force: true });
});

test("stable account ids reject ambiguous and malformed representations", () => {
  for (const value of [
    null,
    undefined,
    "123",
    0,
    -1,
    1.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(githubAccountId(value)).toBeUndefined();
  }
  expect(githubAccountId(123)).toBe(123);
});

test("personal ownership follows the verified id, never the login or display name", () => {
  expect(
    personalPrincipal({ login: "alice", name: "Bob", githubAccountId: 101 }),
  ).toBe("github:101");
  expect(
    personalPrincipal({
      login: "renamed",
      name: "Alice",
      githubAccountId: 101,
    }),
  ).toBe("github:101");
  expect(
    personalPrincipal({ login: "alice", name: "Alice", githubAccountId: 202 }),
  ).toBe("github:202");
  expect(personalPrincipal({ login: "alice", name: "Alice" })).toBeNull();
  expect(
    personalPrincipal({
      login: "alice",
      name: "Alice",
      githubAccountId: 101,
      automation: true,
    }),
  ).toBeNull();
  expect(personalPrincipal(null)).toBeNull();
});

test("GitHub /user id survives sign-in, cookie persistence and roster refresh", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({
        access_token: "synthetic-token",
        token_type: "bearer",
      });
    }
    expect(url).toBe("https://api.github.com/user");
    return Response.json({ login: "alice", id: 101, name: "Alice" });
  }) as typeof fetch;
  const result = await pollGithubDeviceFlow("synthetic-code", "alice");
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("Expected verified flow");
  expect(result.githubAccountId).toBe(101);
  const url = new URL("http://demo/api/auth/device/poll");
  const response = await handleAuthRoutes({
    url,
    path: url.pathname,
    publicPrefix: "",
    authUser: null,
    req: new Request(url, {
      method: "POST",
      body: JSON.stringify({
        deviceCode: "synthetic-code",
        native: true,
        user: "bob",
        githubAccountId: 202,
      }),
    }),
  });
  const body = await response!.json();
  expect(body.status).toBe("ok");
  const nativeIdentity = resolveWebAuth(
    new Request("http://demo/", {
      headers: { Authorization: `Bearer ${body.token}` },
    }),
  );
  expect(personalPrincipal(nativeIdentity)).toBe("github:101");
  const session = createWebSession(result.login, result.githubAccountId);
  expect(session).not.toBeNull();
  delete (globalThis as { __webAuthSessions?: unknown }).__webAuthSessions;
  const identity = resolveWebAuth(
    new Request("http://demo/api/personal/github/status", {
      headers: { cookie: `opensession_auth=${session!.token}` },
    }),
  );
  expect(personalPrincipal(identity)).toBe("github:101");
  expect(refreshWebIdentity(identity!)?.githubAccountId).toBe(101);
});

test("server-watched sign-in keeps its verified id instead of request identity", async () => {
  const deviceCode = "personal-principal-watched-test";
  const watched = (globalThis as any).__osWatchedDeviceFlows as Map<
    string,
    unknown
  >;
  watched.set(deviceCode, {
    status: "ok",
    login: "alice",
    name: "Alice",
    githubAccountId: 101,
    expiresAt: Date.now() + 60_000,
  });
  globalThis.fetch = (async () => {
    throw new Error("A watched result must not repeat the token exchange");
  }) as unknown as typeof fetch;
  try {
    const url = new URL("http://demo/api/auth/device/poll");
    const response = await handleAuthRoutes({
      url,
      path: url.pathname,
      publicPrefix: "",
      authUser: null,
      req: new Request(url, {
        method: "POST",
        body: JSON.stringify({
          deviceCode,
          native: true,
          githubAccountId: 202,
        }),
      }),
    });
    const body = await response!.json();
    expect(body.status).toBe("ok");
    expect(
      personalPrincipal(
        resolveWebAuth(
          new Request("http://demo/", {
            headers: { Authorization: `Bearer ${body.token}` },
          }),
        ),
      ),
    ).toBe("github:101");
  } finally {
    watched.delete(deviceCode);
  }
});

test("first-account bootstrap retains the id without replacing shared App settings", async () => {
  const config = {
    integrations: {
      github: {
        oauthClientId: "synthetic-client",
        appSlug: "existing-org-app",
        userPrAuth: false,
        authOnConnect: true,
      },
    },
  };
  writeFileSync(process.env.OPENSESSION_CONFIG!, JSON.stringify(config));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://github.com/login/oauth/access_token")
      return Response.json({
        access_token: "synthetic-bootstrap-token",
        token_type: "bearer",
      });
    expect(url).toBe("https://api.github.com/user");
    return Response.json({ login: "alice", id: 101, name: "Alice" });
  }) as typeof fetch;
  const result = await pollGithubDeviceFlow(
    "synthetic-bootstrap-code",
    "alice",
  );
  if (result.status !== "ok") throw new Error("Expected verified flow");
  const session = await bootstrapUserAuthOnConnect(
    result.login,
    result.name,
    result.githubAccountId,
  );
  expect("error" in session).toBe(false);
  if ("error" in session) throw new Error(session.error);
  expect(
    personalPrincipal(
      resolveWebAuth(
        new Request("http://demo/", {
          headers: { Authorization: `Bearer ${session.token}` },
        }),
      ),
    ),
  ).toBe("github:101");
  const savedConfig = await Bun.file(process.env.OPENSESSION_CONFIG!).json();
  expect(savedConfig.integrations.github.oauthClientId).toBe(
    "synthetic-client",
  );
  expect(savedConfig.integrations.github.appSlug).toBe("existing-org-app");
});

test("legacy cookies retain shared sign-in without inventing personal ownership", () => {
  const session = createWebSession("alice");
  const identity = resolveWebAuth(
    new Request("http://demo/", {
      headers: { Authorization: `Bearer ${session!.token}` },
    }),
  );
  expect(identity).toEqual({ login: "alice", name: "Alice" });
  expect(personalPrincipal(identity)).toBeNull();
});

test("connection consent never admits repository sessions", () => {
  expect(personalAdmission()).toMatchObject({
    available: false,
    code: "personal_repository_admission_unavailable",
  });
});
