/**
 * Per-user GitHub auth: config gating, token store lookups, runner env
 * building, the web sign-in resolution, and how the device flow's start reads
 * back what GitHub answered (against a stubbed fetch; nothing here talks to
 * GitHub). Store paths are pointed
 * at temp files via their env overrides; audit-emitting mutations
 * (connect/disconnect/sign-in) are exercised only where they don't fire.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  connectedGithubAccounts,
  GITHUB_RUN_AUTH_FILE_ENV,
  githubAuthEnv,
  githubRunEnv,
  githubCredentialForLogin,
  githubCredentialForPrincipal,
  githubReconnectRequired,
  githubUserAuthActive,
  githubUserAuthSettings,
  githubUserLoginForRun,
  pollGithubDeviceFlow,
  refreshExpiringGithubTokens,
  removeGithubAccount,
  resolveGithubCredential,
  serviceGithubCredential,
  soleGithubAccount,
  soleGithubLogin,
  startGithubDeviceFlow,
  validateGithubTokenLogin,
} from "./github-auth";
import { botGhToken } from "./github-limit";
import {
  ensureAutomationWebSession,
  keypadBearerAuthorized,
  refreshWebIdentity,
  resolveWebAuth,
  teamMemberForLogin,
  webAuthRequired,
} from "./web-auth";

const ENV_KEYS = [
  "OPENSESSION_CONFIG",
  "OPENSESSION_CONFIG",
  "OPENSESSION_GITHUB_CLIENT_ID",
  "OPENSESSION_GITHUB_AUTH_STORE",
  GITHUB_RUN_AUTH_FILE_ENV,
  "OPENSESSION_WEB_SESSIONS_STORE",
  "KEYPAD_TOKEN",
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bks-github-auth-test-"));
  for (const k of ENV_KEYS) delete process.env[k];
  // Isolate from the machine's real ~/.opensession/config.json (which may
  // have the feature enabled): a missing file = {} = built-in defaults.
  process.env.OPENSESSION_CONFIG = join(dir, "no-config.json");
  process.env.OPENSESSION_GITHUB_AUTH_STORE = join(dir, "github-auth.json");
  process.env.OPENSESSION_WEB_SESSIONS_STORE = join(dir, "web-sessions.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  // web-auth parks its session map on globalThis — reset between cases.
  delete (globalThis as any).__webAuthSessions;
});

function enableFeature(memberName: string | null = "Alice Example"): void {
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      identity: {
        team: memberName
          ? [
              {
                name: memberName,
                github: "alice",
                slackId: "U_ALICE",
                email: "alice@example.com",
                aliases: ["Alice"],
              },
            ]
          : [],
      },
      integrations: {
        github: { userPrAuth: true, oauthClientId: "test-client-id" },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = path;
}

function seedToken(login = "alice", token = "gho_test123"): void {
  writeFileSync(
    process.env.OPENSESSION_GITHUB_AUTH_STORE!,
    JSON.stringify({
      users: {
        [login.toLowerCase()]: {
          login,
          token,
          source: "device",
          connectedAt: "2026-07-18T00:00:00.000Z",
        },
      },
    }),
  );
}

describe("service credential boundary", () => {
  test("the App does not fall back to ambient gh login", async () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ integrations: { github: {} } }));
    process.env.OPENSESSION_CONFIG = path;
    expect(await botGhToken()).toBeNull();
    await expect(
      resolveGithubCredential(serviceGithubCredential),
    ).rejects.toThrow("selected GitHub bot credential is unavailable");
  });
});

describe("githubUserAuthSettings", () => {
  test("off by default (no config)", () => {
    const s = githubUserAuthSettings();
    expect(s.enabled).toBe(false);
    expect(githubUserAuthActive()).toBe(false);
    expect(webAuthRequired()).toBe(false);
  });

  test("enabled + client id from config activates the feature", () => {
    enableFeature();
    const s = githubUserAuthSettings();
    expect(s.enabled).toBe(true);
    expect(s.clientId).toBe("test-client-id");
    expect(githubUserAuthActive()).toBe(true);
    expect(webAuthRequired()).toBe(true);
  });

  test("enabled without a client id is not active", () => {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({ integrations: { github: { userPrAuth: true } } }),
    );
    process.env.OPENSESSION_CONFIG = path;
    expect(githubUserAuthSettings().enabled).toBe(true);
    expect(githubUserAuthActive()).toBe(false);
  });

  test("env client id wins over config", () => {
    enableFeature();
    process.env.OPENSESSION_GITHUB_CLIENT_ID = "env-client-id";
    expect(githubUserAuthSettings().clientId).toBe("env-client-id");
  });
});

describe("token lookups + runner env", () => {
  test("resolves the session user through the identity table", () => {
    enableFeature();
    seedToken();
    // Configured aliases, Slack ids, email addresses, and GitHub logins all
    // resolve through the same identity table as commit attribution.
    for (const ref of ["Alice", "U_ALICE", "alice@example.com", "alice"]) {
      expect(githubUserLoginForRun(ref)).toBe("alice");
      expect(githubAuthEnv(ref)).toEqual({
        GH_TOKEN: "gho_test123",
        GITHUB_TOKEN: "gho_test123",
      });
    }
  });

  test("simple mode uses the sole account; operator mode empty for unknown/unconnected", () => {
    seedToken();
    // Feature off (simple mode): the single connected account is the identity
    // for every interactive run, regardless of the passed user.
    expect(githubAuthEnv("Alice")).toEqual({
      GH_TOKEN: "gho_test123",
      GITHUB_TOKEN: "gho_test123",
    });
    // The caller may pass a null or unmatched user (simple mode has no per-user
    // login); the sole account is still returned, so an interactive run gets
    // GH_TOKEN. The pi-runner gate keys on interactivity, not on a non-null
    // login — see the githubInteractive boolean.
    expect(githubAuthEnv(null)).toEqual({
      GH_TOKEN: "gho_test123",
      GITHUB_TOKEN: "gho_test123",
    });
    expect(githubAuthEnv("Some Randomer")).toEqual({
      GH_TOKEN: "gho_test123",
      GITHUB_TOKEN: "gho_test123",
    });
    enableFeature();
    expect(githubAuthEnv("Some Randomer")).toEqual({}); // unknown user
    expect(githubAuthEnv(null)).toEqual({});
    expect(githubAuthEnv("Bob")).toEqual({}); // unknown, never connected
    expect(githubUserLoginForRun("Bob")).toBeNull();
  });

  test("run env gives HTTPS git and gh the connected user's token", () => {
    enableFeature();
    seedToken();
    expect(githubRunEnv("Alice")).toMatchObject({
      GH_TOKEN: "gho_test123",
      GITHUB_TOKEN: "gho_test123",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_VALUE_2: "git@github.com:",
      GIT_CONFIG_VALUE_3: "ssh://git@github.com/",
    });
  });

  test("remote run env reads only its projected access-token file", () => {
    const projected = join(dir, "run-github-auth.json");
    writeFileSync(
      projected,
      JSON.stringify({
        GH_TOKEN: "ghu_remote123",
        GITHUB_TOKEN: "ghu_remote123",
        refreshToken: "must-not-be-read",
      }),
    );
    process.env[GITHUB_RUN_AUTH_FILE_ENV] = projected;
    expect(githubRunEnv("Alice")).toMatchObject({
      GH_TOKEN: "ghu_remote123",
      GITHUB_TOKEN: "ghu_remote123",
      GIT_CONFIG_VALUE_2: "git@github.com:",
    });
    expect(JSON.stringify(githubRunEnv("Alice"))).not.toContain(
      "must-not-be-read",
    );
  });

  test("connectedGithubAccounts never exposes tokens", () => {
    // Every credential field, not just `token`: the refresh token mints new
    // access tokens for ~6 months, so leaking it is as bad as leaking the
    // token itself. It reached the API for a while because the public view
    // spread `...rest` and only named `token`.
    writeFileSync(
      process.env.OPENSESSION_GITHUB_AUTH_STORE!,
      JSON.stringify({
        users: {
          alice: {
            login: "alice",
            token: "gho_test123",
            refreshToken: "ghr_secret",
            refreshTokenExpiresAt: "2027-01-01T00:00:00.000Z",
            expiresAt: "2026-07-18T08:00:00.000Z",
            source: "device",
            connectedAt: "2026-07-18T00:00:00.000Z",
          },
        },
      }),
    );
    const accounts = connectedGithubAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].login).toBe("alice");
    for (const secret of ["token", "refreshToken", "refreshTokenExpiresAt"]) {
      expect((accounts[0] as any)[secret]).toBeUndefined();
    }
    expect(JSON.stringify(accounts)).not.toContain("ghr_secret");
    expect(accounts[0].needsReconnect).toBeUndefined();
  });

  test("a dead refresh grant surfaces as needsReconnect", () => {
    writeFileSync(
      process.env.OPENSESSION_GITHUB_AUTH_STORE!,
      JSON.stringify({
        users: {
          alice: {
            login: "alice",
            token: "gho_test123",
            refreshToken: "ghr_dead",
            refreshFailedAt: "2026-08-04T10:00:00.000Z",
            source: "device",
            connectedAt: "2026-07-18T00:00:00.000Z",
          },
        },
      }),
    );
    const [account] = connectedGithubAccounts();
    expect(account.needsReconnect).toBe(true);
    // The marker itself is internal — only the derived flag is public.
    expect((account as any).refreshFailedAt).toBeUndefined();
  });

  test("a dead grant is what the sign-in gate refuses, and only that", () => {
    // The gate blocks the whole app, so what it does NOT fire on matters as
    // much as what it does: a healthy grant, someone who never connected, and
    // an instance with the feature off all have to walk straight through.
    enableFeature();
    seedToken();
    expect(githubReconnectRequired("alice")).toBe(false);
    expect(githubReconnectRequired("bob")).toBe(false);
    expect(githubReconnectRequired(null)).toBe(false);

    writeFileSync(
      process.env.OPENSESSION_GITHUB_AUTH_STORE!,
      JSON.stringify({
        users: {
          alice: {
            login: "alice",
            token: "gho_test123",
            refreshToken: "ghr_dead",
            refreshFailedAt: "2026-08-04T10:00:00.000Z",
            source: "device",
            connectedAt: "2026-07-18T00:00:00.000Z",
          },
        },
      }),
    );
    expect(githubReconnectRequired("alice")).toBe(true);
    expect(githubReconnectRequired("ALICE")).toBe(true); // logins are casefolded
    expect(githubReconnectRequired("bob")).toBe(false);

    // Reconnecting is the way out, and it works by replacing the row: the
    // fresh record carries no refreshFailedAt, so the gate opens again.
    removeGithubAccount("alice");
    seedToken();
    expect(githubReconnectRequired("alice")).toBe(false);
  });

  test("nobody is gated when the feature is off, or when the store is unreadable", () => {
    // Fail-open, deliberately. A GitHub outage or a garbled store must not
    // lock the team out of reading their own sessions; the credential getters
    // are where this fails closed.
    writeFileSync(
      process.env.OPENSESSION_GITHUB_AUTH_STORE!,
      JSON.stringify({
        users: {
          alice: {
            login: "alice",
            token: "t",
            refreshFailedAt: "2026-08-04T10:00:00.000Z",
            connectedAt: "x",
          },
        },
      }),
    );
    expect(githubReconnectRequired("alice")).toBe(false); // feature off
    enableFeature();
    expect(githubReconnectRequired("alice")).toBe(true);
    writeFileSync(process.env.OPENSESSION_GITHUB_AUTH_STORE!, "{ not json");
    expect(githubReconnectRequired("alice")).toBe(false);
  });

  test("accepts pre-source App grants but rejects old static bearer records", () => {
    enableFeature();
    writeFileSync(
      process.env.OPENSESSION_GITHUB_AUTH_STORE!,
      JSON.stringify({
        users: {
          appuser: {
            login: "appuser",
            token: "app-user-token",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            refreshToken: "refresh-token",
            connectedAt: "2026-01-01T00:00:00.000Z",
          },
          staticuser: {
            login: "staticuser",
            token: "old-static-token",
            connectedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    expect(githubCredentialForLogin("appuser")?.principal).toBe("user:appuser");
    expect(githubCredentialForLogin("staticuser")).toBeNull();
  });

  test("builds a credential only for the exact connected login", () => {
    enableFeature();
    seedToken("Alice");
    const credential = githubCredentialForLogin("alice");
    expect(credential).toMatchObject({
      kind: "user",
      principal: "user:alice",
      env: {
        GH_TOKEN: "gho_test123",
        GITHUB_TOKEN: "gho_test123",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "4",
        GIT_CONFIG_VALUE_0: "",
      },
    });
    expect(credential?.env.GIT_CONFIG_VALUE_1).toContain("credential");
    expect(credential?.env.GIT_CONFIG_VALUE_1).not.toContain("gho_test123");
    expect(githubCredentialForLogin("bob")).toBeNull();
  });

  test("durable principals resolve the current token without changing identity", () => {
    enableFeature();
    seedToken("Alice", "gho_old");
    expect(githubCredentialForPrincipal("user:alice")?.env.GH_TOKEN).toBe(
      "gho_old",
    );

    seedToken("Alice", "gho_refreshed");
    const recovered = githubCredentialForPrincipal("user:alice");
    expect(recovered?.principal).toBe("user:alice");
    expect(recovered?.env.GH_TOKEN).toBe("gho_refreshed");
    expect(JSON.stringify(recovered)).not.toContain("gho_old");
    expect(githubCredentialForPrincipal("user:bob")).toBeNull();
  });

  test("rejects a device-flow login that differs from the signed-in user", () => {
    expect(validateGithubTokenLogin("alice", "Alice")).toEqual({ ok: true });
    expect(validateGithubTokenLogin("bob", "alice")).toEqual({
      ok: false,
      error: "GitHub authorized @bob, but the signed-in user is @alice",
    });
  });

  test("removeGithubAccount on an unknown login is a no-op", () => {
    expect(removeGithubAccount("nobody")).toBe(false);
  });
});

describe("starting the device flow", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function githubAnswers(status: number, body: unknown): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status,
      })) as unknown as typeof fetch;
  }

  test("an app without Device Flow enabled says which switch to tick", async () => {
    // GitHub's own answer is the bare code `device_flow_disabled`, which names
    // the setting only if you already know the setting. This is the one
    // misconfiguration that locks the whole team out, so the sentence has to
    // carry the fix: every client shows this string verbatim.
    enableFeature();
    githubAnswers(400, {
      error: "device_flow_disabled",
      error_description: "Device flow is disabled.",
    });
    const result = await startGithubDeviceFlow();
    expect(result).toHaveProperty("error");
    const error = (result as { error: string }).error;
    expect(error).toContain("Enable Device Flow");
    expect(error).toContain("nobody can sign in");
    expect(error).not.toContain("device_flow_disabled");
  });

  test("any other GitHub failure keeps GitHub's own description", async () => {
    enableFeature();
    githubAnswers(404, { error: "not_found", error_description: "Not Found" });
    expect(await startGithubDeviceFlow()).toEqual({ error: "Not Found" });
  });

  test("a configured app gets its code back with the canonical browser URL", async () => {
    enableFeature();
    let requestedScope = "";
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body));
      requestedScope = body.scope;
      return Response.json({
        device_code: "dev-code",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device/authorize",
        interval: 5,
        expires_in: 900,
      });
    }) as unknown as typeof fetch;
    expect(await startGithubDeviceFlow()).toEqual({
      deviceCode: "dev-code",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      interval: 5,
      expiresIn: 900,
    });
    expect(requestedScope).toBe("repo read:org");
  });
});

describe("web sign-in resolution", () => {
  test("local automation gets a distinct machine identity, ordered before humans", () => {
    enableFeature();
    const now = Date.now();
    writeFileSync(
      process.env.OPENSESSION_WEB_SESSIONS_STORE!,
      JSON.stringify({
        sessions: [
          {
            token: "human-token",
            login: "alice",
            name: "Alice Example",
            createdAt: now,
            lastSeenAt: now,
          },
        ],
      }),
    );
    const machine = ensureAutomationWebSession();
    expect(machine?.token).toBeString();
    expect(
      resolveWebAuth(
        new Request("http://x/", {
          headers: { authorization: `Bearer ${machine!.token}` },
        }),
      ),
    ).toEqual({
      login: "opensession-automation",
      name: "Automation",
      automation: true,
    });
    const stored = JSON.parse(
      readFileSync(process.env.OPENSESSION_WEB_SESSIONS_STORE!, "utf8"),
    );
    expect(stored.sessions[0].kind).toBe("automation");
    expect(stored.sessions[1].login).toBe("alice");
  });

  test("team gate: only configured github logins may sign in", () => {
    expect(teamMemberForLogin("alice")).toBeNull();
    enableFeature();
    expect(teamMemberForLogin("alice")?.name).toBe("Alice Example");
    expect(teamMemberForLogin("Alice")?.name).toBe("Alice Example");
    expect(teamMemberForLogin("some-rando")).toBeNull();
  });

  test("resolves the session cookie and Bearer token from a seeded store", () => {
    enableFeature();
    const now = Date.now();
    writeFileSync(
      process.env.OPENSESSION_WEB_SESSIONS_STORE!,
      JSON.stringify({
        sessions: [
          {
            token: "tok-abc",
            login: "alice",
            name: "Alice Example",
            createdAt: now,
            lastSeenAt: now,
          },
        ],
      }),
    );
    const byCookie = resolveWebAuth(
      new Request("http://x/", {
        headers: { cookie: "foo=1; opensession_auth=tok-abc" },
      }),
    );
    expect(byCookie).toEqual({ login: "alice", name: "Alice Example" });
    const byBearer = resolveWebAuth(
      new Request("http://x/", {
        headers: { authorization: "Bearer tok-abc" },
      }),
    );
    expect(byBearer?.login).toBe("alice");
    expect(resolveWebAuth(new Request("http://x/"))).toBeNull();
    expect(
      resolveWebAuth(
        new Request("http://x/", {
          headers: { cookie: "opensession_auth=wrong" },
        }),
      ),
    ).toBeNull();
  });

  test("refreshes a session name from the current roster row", () => {
    enableFeature();
    const now = Date.now();
    writeFileSync(
      process.env.OPENSESSION_WEB_SESSIONS_STORE!,
      JSON.stringify({
        sessions: [
          {
            token: "renamed-token",
            login: "alice",
            name: "Old Alice",
            createdAt: now,
            lastSeenAt: now,
          },
        ],
      }),
    );

    const identity = resolveWebAuth(
      new Request("http://x/", {
        headers: { authorization: "Bearer renamed-token" },
      }),
    );
    expect(identity).toEqual({ login: "alice", name: "Alice Example" });

    enableFeature("Alice Newly Renamed");
    const renamed = resolveWebAuth(
      new Request("http://x/", {
        headers: { authorization: "Bearer renamed-token" },
      }),
    );
    expect(renamed).toEqual({ login: "alice", name: "Alice Newly Renamed" });
    expect(
      JSON.parse(
        readFileSync(process.env.OPENSESSION_WEB_SESSIONS_STORE!, "utf8"),
      ).sessions[0].name,
    ).toBe("Alice Newly Renamed");
  });

  test("revokes a human session when its roster row is removed", () => {
    enableFeature();
    const now = Date.now();
    writeFileSync(
      process.env.OPENSESSION_WEB_SESSIONS_STORE!,
      JSON.stringify({
        sessions: [
          {
            token: "removed-token",
            login: "alice",
            name: "Alice Example",
            createdAt: now,
            lastSeenAt: now,
          },
        ],
      }),
    );

    expect(
      resolveWebAuth(
        new Request("http://x/", {
          headers: { authorization: "Bearer removed-token" },
        }),
      ),
    ).toEqual({ login: "alice", name: "Alice Example" });

    enableFeature(null);
    expect(
      resolveWebAuth(
        new Request("http://x/", {
          headers: { authorization: "Bearer removed-token" },
        }),
      ),
    ).toBeNull();
    expect(
      JSON.parse(
        readFileSync(process.env.OPENSESSION_WEB_SESSIONS_STORE!, "utf8"),
      ).sessions,
    ).toEqual([]);
  });

  test("refreshes identities used by long-lived transports", () => {
    enableFeature();
    expect(refreshWebIdentity({ login: "alice", name: "Old Alice" })).toEqual({
      login: "alice",
      name: "Alice Example",
    });

    enableFeature(null);
    expect(
      refreshWebIdentity({ login: "alice", name: "Alice Example" }),
    ).toBeNull();
    expect(
      refreshWebIdentity({
        login: "opensession-automation",
        name: "Automation",
        automation: true,
      }),
    ).toEqual({
      login: "opensession-automation",
      name: "Automation",
      automation: true,
    });
  });
});

describe("keypad bearer auth", () => {
  test("fails closed when KEYPAD_TOKEN is unset", () => {
    expect(
      keypadBearerAuthorized(
        new Request("http://x/api/keypad", {
          headers: { authorization: "Bearer anything" },
        }),
      ),
    ).toBe(false);
  });

  test("accepts only the configured bearer token", () => {
    process.env.KEYPAD_TOKEN = "keypad-test-secret";
    const request = (authorization?: string) =>
      new Request("http://x/api/keypad", {
        headers: authorization ? { authorization } : undefined,
      });

    expect(keypadBearerAuthorized(request("Bearer keypad-test-secret"))).toBe(
      true,
    );
    expect(keypadBearerAuthorized(request("bearer keypad-test-secret"))).toBe(
      true,
    );
    expect(keypadBearerAuthorized(request("Bearer wrong-secret"))).toBe(false);
    expect(keypadBearerAuthorized(request())).toBe(false);
  });
});

describe("simple-mode credential (App connected, sign-in off)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // A personal App: client id + secret configured, but userPrAuth stays off, so
  // githubUserAuthActive()/webAuthRequired() are both false.
  function simpleModeApp(): void {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        integrations: {
          github: { oauthClientId: "cid", oauthClientSecret: "csecret" },
        },
      }),
    );
    process.env.OPENSESSION_CONFIG = path;
  }

  function writeStore(users: Record<string, unknown>): void {
    writeFileSync(
      process.env.OPENSESSION_GITHUB_AUTH_STORE!,
      JSON.stringify({ users }),
    );
  }

  test("refreshes a personal-app token even with sign-in off", async () => {
    simpleModeApp();
    expect(githubUserAuthActive()).toBe(false);
    const soon = new Date(Date.now() + 60_000).toISOString(); // inside the skew window
    writeStore({
      alice: {
        login: "alice",
        token: "old-token",
        refreshToken: "rt-1",
        expiresAt: soon,
        connectedAt: "2026-07-18T00:00:00.000Z",
      },
    });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("login/oauth/access_token"))
        return new Response(
          JSON.stringify({
            access_token: "new-token",
            refresh_token: "rt-2",
            expires_in: 28800,
            refresh_token_expires_in: 15552000,
            token_type: "bearer",
          }),
          { status: 200 },
        );
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    await refreshExpiringGithubTokens();
    const after = JSON.parse(
      readFileSync(process.env.OPENSESSION_GITHUB_AUTH_STORE!, "utf-8"),
    );
    expect(after.users.alice.token).toBe("new-token");
    expect(after.users.alice.refreshToken).toBe("rt-2");
  });

  test("reconnect authorizing a different account replaces, never strands two", async () => {
    simpleModeApp();
    writeStore({
      alice: {
        login: "alice",
        token: "tok-alice",
        connectedAt: "2026-07-18T00:00:00.000Z",
      },
    });
    // Simple-mode reconnect passes no expected login; GitHub reports @bob.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("login/oauth/access_token"))
        return new Response(
          JSON.stringify({ access_token: "tok-bob", token_type: "bearer" }),
          { status: 200 },
        );
      if (url.includes("api.github.com/user"))
        return new Response(JSON.stringify({ login: "bob", name: "Bob" }), {
          status: 200,
        });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const res = await pollGithubDeviceFlow("device-code");
    expect(res.status).toBe("ok");
    const after = JSON.parse(
      readFileSync(process.env.OPENSESSION_GITHUB_AUTH_STORE!, "utf-8"),
    );
    expect(Object.keys(after.users)).toEqual(["bob"]); // one account, not two
    expect(soleGithubLogin()).toBe("bob"); // recoverable: DELETE can find it
    expect(soleGithubAccount()).not.toBeNull(); // repo ops resolve, no fallback to bot
  });
});
