import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  bootstrapUserAuthOnConnect,
  handleConnectionsRoutes,
} from "./connections";
import {
  __setGithubAppKeyPathForTest,
  commitGithubAppKeyMutation,
} from "../github-app";
import type { RouteContext } from "./context";

// The GitHub connect routes behave differently by mode: operator mode (web
// sign-in on) gates on the signed-in identity; simple mode (no sign-in) drives
// connect off a resolvable client id and manages the single connected account.
// Every test isolates config + the token/session stores via their env overrides
// so nothing reads the machine's real ~/.opensession.

const ENV_KEYS = [
  "OPENSESSION_CONFIG",
  "OPENSESSION_GITHUB_CLIENT_ID",
  "OPENSESSION_GITHUB_APP_SLUG",
  "OPENSESSION_GITHUB_APP_KEY",
  "OPENSESSION_GITHUB_AUTH_STORE",
  "OPENSESSION_WEB_SESSIONS_STORE",
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "os-connections-test-"));
  for (const k of ENV_KEYS) delete process.env[k];
  // Missing config = simple mode (sign-in off, feature off, no client id).
  process.env.OPENSESSION_CONFIG = join(dir, "config.json");
  process.env.OPENSESSION_GITHUB_AUTH_STORE = join(dir, "github-auth.json");
  process.env.OPENSESSION_WEB_SESSIONS_STORE = join(dir, "web-sessions.json");
  __setGithubAppKeyPathForTest(join(dir, "github-app.pem"));
});

afterEach(() => {
  __setGithubAppKeyPathForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

/** Operator mode: userPrAuth + a client id makes webAuthRequired() true. A
 *  fresh path each call sidesteps getConfig's mtime cache. */
function enableOperatorMode(): void {
  const path = join(
    dir,
    `operator-${Math.random().toString(36).slice(2)}.json`,
  );
  writeFileSync(
    path,
    JSON.stringify({
      integrations: {
        github: { userPrAuth: true, oauthClientId: "test-client-id" },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = path;
}

function enableRoleAwareConnections(): string {
  const mcpConfig = join(dir, "mcp-config.json");
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        "apple-build": {
          command: "opensession",
          args: ["apple-mobile-mcp", "--mode", "build"],
        },
        "apple-release": {
          command: "opensession",
          args: ["apple-mobile-mcp", "--mode", "release"],
          env: {
            APPLE_TEAM_ID: "TEAM123456",
            APPLE_ASC_KEY_ID: "KEY1234567",
            APPLE_ASC_ISSUER_ID: "00000000-0000-0000-0000-000000000000",
            APPLE_ASC_PRIVATE_KEY_PATH: "/protected/AuthKey.p8",
          },
          allowedUsers: ["admin"],
        },
        ordinary: {
          command: "ordinary-mcp",
          allowedUsers: ["admin"],
        },
      },
    }),
  );
  const config = join(
    dir,
    `role-aware-${Math.random().toString(36).slice(2)}.json`,
  );
  writeFileSync(
    config,
    JSON.stringify({
      integrations: {
        github: { userPrAuth: true, oauthClientId: "test-client-id" },
      },
      identity: {
        team: [
          { name: "Admin", github: "admin", admin: true },
          { name: "Member", github: "member", admin: false },
        ],
      },
      paths: { mcpConfig },
    }),
  );
  process.env.OPENSESSION_CONFIG = config;
  return mcpConfig;
}

function storedMcpServers(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf-8")).mcpServers;
}

function context(
  path: string,
  method: string,
  authUser?: RouteContext["authUser"],
  body?: unknown,
): RouteContext {
  const url = new URL(`http://localhost${path}`);
  return {
    req: new Request(url, {
      method,
      ...(body !== undefined
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    }),
    url,
    path,
    publicPrefix: "",
    authUser,
  };
}

const DEVICE = "/api/connections/github/device";

const MEMBER = { login: "member", name: "Member" };
const ADMIN = { login: "admin", name: "Admin" };

describe("Apple release connection authorization", () => {
  test("rejects a non-admin self-add through Apple mobile setup", async () => {
    const mcpConfig = enableRoleAwareConnections();

    const response = await handleConnectionsRoutes(
      context("/api/connections/apple-mobile", "PUT", MEMBER, {
        buildEnabled: true,
        releaseEnabled: true,
        teamId: "TEAM123456",
        allowedUsers: ["member"],
      }),
    );

    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({
      error: "Workspace administrator access is required",
    });
    expect(storedMcpServers(mcpConfig)["apple-release"]).toMatchObject({
      env: { APPLE_ASC_KEY_ID: "KEY1234567" },
      allowedUsers: ["admin"],
    });
  });

  test("rejects non-admin generic Apple release mutations", async () => {
    const mcpConfig = enableRoleAwareConnections();

    for (const path of [
      "/api/connections/mcp/apple-release",
      "/api/connections/mcp/APPLE-RELEASE",
      "/api/connections/mcp/%20apple-release%20",
    ]) {
      for (const [method, body] of [
        ["PUT", { allowedUsers: ["member"] }],
        ["DELETE", undefined],
      ] as const) {
        const response = await handleConnectionsRoutes(
          context(path, method, MEMBER, body),
        );
        expect(response?.status).toBe(403);
      }
    }

    for (const name of [
      "apple-release",
      "APPLE-RELEASE",
      "  apple-release  ",
    ]) {
      const create = await handleConnectionsRoutes(
        context("/api/connections/mcp", "POST", MEMBER, {
          name,
          transport: "stdio",
          command: "malicious-release",
          allowedUsers: ["member"],
        }),
      );
      expect(create?.status).toBe(403);
    }
    expect(storedMcpServers(mcpConfig)["apple-release"]).toMatchObject({
      command: "opensession",
      env: { APPLE_ASC_KEY_ID: "KEY1234567" },
      allowedUsers: ["admin"],
    });
  });

  test("keeps ordinary MCP mutations available to non-admin teammates", async () => {
    const mcpConfig = enableRoleAwareConnections();

    const update = await handleConnectionsRoutes(
      context("/api/connections/mcp/ordinary", "PUT", MEMBER, {
        allowedUsers: ["member"],
      }),
    );
    expect(update?.status).toBe(200);
    expect(storedMcpServers(mcpConfig).ordinary.allowedUsers).toEqual([
      "member",
    ]);

    const remove = await handleConnectionsRoutes(
      context("/api/connections/mcp/ordinary", "DELETE", MEMBER),
    );
    expect(remove?.status).toBe(200);
    expect(storedMcpServers(mcpConfig).ordinary).toBeUndefined();
  });

  test("allows admins to update, remove, and reconfigure Apple release", async () => {
    const mcpConfig = enableRoleAwareConnections();

    const update = await handleConnectionsRoutes(
      context("/api/connections/mcp/apple-release", "PUT", ADMIN, {
        allowedUsers: ["member"],
      }),
    );
    expect(update?.status).toBe(200);
    expect(storedMcpServers(mcpConfig)["apple-release"]).toMatchObject({
      env: { APPLE_ASC_KEY_ID: "KEY1234567" },
      allowedUsers: ["member"],
    });

    const remove = await handleConnectionsRoutes(
      context("/api/connections/mcp/apple-release", "DELETE", ADMIN),
    );
    expect(remove?.status).toBe(200);
    expect(storedMcpServers(mcpConfig)["apple-release"]).toBeUndefined();

    enableRoleAwareConnections();
    const setup = await handleConnectionsRoutes(
      context("/api/connections/apple-mobile", "PUT", ADMIN, {
        buildEnabled: false,
        releaseEnabled: false,
      }),
    );
    expect(setup?.status).toBe(200);
    expect(storedMcpServers(mcpConfig)["apple-build"]).toBeUndefined();
    expect(storedMcpServers(mcpConfig)["apple-release"]).toBeUndefined();
  });
});

describe("GitHub App key transaction", () => {
  test("restores the previous key when config persistence fails", async () => {
    const keyPath = join(dir, "github-app.pem");
    writeFileSync(keyPath, "working-key\n", { mode: 0o600 });

    await expect(
      commitGithubAppKeyMutation("replacement-key", () => {
        throw new Error("config volume full");
      }),
    ).rejects.toThrow("config volume full");
    expect(readFileSync(keyPath, "utf-8")).toBe("working-key\n");
  });

  test("removes config while preserving an ops-managed key", async () => {
    const keyPath = join(dir, "github-app.pem");
    writeFileSync(keyPath, "ops-key\n", { mode: 0o600 });
    process.env.OPENSESSION_GITHUB_APP_KEY = keyPath;
    let committed = false;

    await commitGithubAppKeyMutation(null, () => {
      committed = true;
    });
    expect(committed).toBe(true);
    expect(readFileSync(keyPath, "utf-8")).toBe("ops-key\n");
  });
});

describe("GitHub connect gating", () => {
  test("simple mode without a configured app rejects the connect (400)", async () => {
    const response = await handleConnectionsRoutes(
      context(DEVICE, "POST", null),
    );
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      error: "GitHub connect is not configured",
    });
  });

  test("operator mode requires sign-in before starting a connection (403)", async () => {
    enableOperatorMode();
    const response = await handleConnectionsRoutes(
      context(DEVICE, "POST", null),
    );
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({
      error: "Sign in to connect GitHub",
    });
  });

  test("connect is decoupled from the sign-in gate", async () => {
    // A resolvable client id (env) with sign-in still OFF: connect is available
    // without putting the workspace behind sign-in.
    process.env.OPENSESSION_GITHUB_CLIENT_ID = "simple-client-id";
    const response = await handleConnectionsRoutes(
      context("/api/connections/github", "GET", null),
    );
    const body = await response?.json();
    expect(body.connectAvailable).toBe(true);
    expect(body.webAuthRequired).toBe(false);
    // The client id came from the env var, so the UI names that to unset.
    expect(body.appConfigSource).toBe("env");
  });

  test("no configured app: connect unavailable and no config source", async () => {
    const response = await handleConnectionsRoutes(
      context("/api/connections/github", "GET", null),
    );
    const body = await response?.json();
    expect(body.connectAvailable).toBe(false);
    expect(body.appConfigSource).toBe(null);
  });

  test("app configured via config file reports a config source", async () => {
    const path = join(dir, `app-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        ingress: {
          publicBaseUrl: "https://ingress.os.example.test",
          exposure: "custom",
        },
        integrations: { github: { oauthClientId: "cfg-client-id" } },
      }),
    );
    process.env.OPENSESSION_CONFIG = path;
    const response = await handleConnectionsRoutes(
      context("/api/connections/github", "GET", null),
    );
    const body = await response?.json();
    expect(body.connectAvailable).toBe(true);
    // userPrAuth is off, so a client id alone must not flip the sign-in gate.
    expect(body.webAuthRequired).toBe(false);
    expect(body.appConfigSource).toBe("config");
    expect(body.webhookBaseUrl).toBe("https://ingress.os.example.test");
  });
});

describe("GitHub disconnect ownership", () => {
  test("operator mode: cannot disconnect another signed-in user's account", async () => {
    enableOperatorMode();
    const response = await handleConnectionsRoutes(
      context("/api/connections/github/account/happylinks", "DELETE", {
        login: "9ranty",
        name: "Grant",
      }),
    );
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({
      error: "You can only disconnect your own GitHub account",
    });
  });

  test("simple mode: only the single connected account is manageable", async () => {
    // Nobody connected, so there is no sole account to disconnect.
    const response = await handleConnectionsRoutes(
      context("/api/connections/github/account/happylinks", "DELETE", null),
    );
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({
      error: "You can only disconnect the connected GitHub account",
    });
  });
});

function validPrivateKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

const APP = "/api/connections/github/app";
const GET = "/api/connections/github";

describe("GitHub App config (simple mode)", () => {
  test("POST writes client id + slug + secret to config, connect goes live, and userPrAuth is untouched", async () => {
    const res = await handleConnectionsRoutes(
      context(APP, "POST", null, {
        clientId: "Iv1.abc",
        slug: "my-app",
        secret: "shh",
        appOrg: "acme",
        privateKey: validPrivateKey(),
      }),
    );
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ ok: true });

    // On disk: the App and connect-time sign-in intent are set, but userPrAuth
    // is not introduced until a verified account connects.
    const written = JSON.parse(
      readFileSync(process.env.OPENSESSION_CONFIG!, "utf-8"),
    );
    expect(written.integrations.github.oauthClientId).toBe("Iv1.abc");
    expect(written.integrations.github.appSlug).toBe("my-app");
    expect(written.integrations.github.oauthClientSecret).toBe("shh");
    expect(written.integrations.github.installationOwner).toBe("acme");
    expect(written.integrations.github.authOnConnect).toBe(true);
    expect(written.integrations.github.userPrAuth).toBeUndefined();

    // Live, no restart: the App now reads as configured-from-config, and the
    // workspace is still not behind sign-in.
    const get = await handleConnectionsRoutes(context(GET, "GET", null));
    const body = await get?.json();
    expect(body.connectAvailable).toBe(true);
    expect(body.appConfigSource).toBe("config");
    expect(body.webAuthRequired).toBe(false);
  });

  test("a personal App arms sign-in for its first verified connection", async () => {
    const res = await handleConnectionsRoutes(
      context(APP, "POST", null, {
        clientId: "Iv1.personal",
        slug: "personal-app",
        secret: "shh",
        privateKey: validPrivateKey(),
      }),
    );
    expect(res?.status).toBe(200);

    const written = JSON.parse(
      readFileSync(process.env.OPENSESSION_CONFIG!, "utf-8"),
    );
    expect(written.integrations.github.authOnConnect).toBe(true);
    expect(written.integrations.github.appOrg).toBeUndefined();
    expect(written.integrations.github.installationOwner).toBeUndefined();
    expect(written.integrations.github.userPrAuth).toBeUndefined();
  });

  test("POST without a client id, slug, or secret is rejected (400)", async () => {
    // Missing client id.
    expect(
      (
        await handleConnectionsRoutes(
          context(APP, "POST", null, {
            clientId: "",
            slug: "my-app",
            secret: "shh",
          }),
        )
      )?.status,
    ).toBe(400);
    // Missing secret: required on the UI config path (the token is refreshed
    // with it), so a blank one is refused rather than silently stored.
    expect(
      (
        await handleConnectionsRoutes(
          context(APP, "POST", null, { clientId: "Iv1.abc", slug: "my-app" }),
        )
      )?.status,
    ).toBe(400);
  });

  test("cannot strand selected App bot actions by clearing their key", async () => {
    const path = process.env.OPENSESSION_CONFIG!;
    writeFileSync(
      path,
      JSON.stringify({
        integrations: {
          github: {
            oauthClientId: "Iv1.app-a",
            appSlug: "app-a",
            oauthClientSecret: "shh",
            enabled: true,
          },
        },
      }),
    );
    const keyPath = join(dir, "github-app.pem");
    writeFileSync(keyPath, "app-a-key\n", { mode: 0o600 });

    const replace = await handleConnectionsRoutes(
      context(APP, "POST", null, {
        clientId: "Iv1.app-b",
        slug: "app-b",
        secret: "shh",
      }),
    );
    expect(replace?.status).toBe(409);
    expect(readFileSync(keyPath, "utf-8")).toBe("app-a-key\n");

    const remove = await handleConnectionsRoutes(context(APP, "DELETE", null));
    expect(remove?.status).toBe(409);
    expect(readFileSync(keyPath, "utf-8")).toBe("app-a-key\n");
  });

  test("changing App identity without a new key is rejected", async () => {
    await handleConnectionsRoutes(
      context(APP, "POST", null, {
        clientId: "Iv1.app-a",
        slug: "app-a",
        secret: "shh",
        appOrg: "acme",
        privateKey: validPrivateKey(),
      }),
    );
    const keyPath = join(dir, "github-app.pem");
    writeFileSync(keyPath, "app-a-key\n", { mode: 0o600 });

    const response = await handleConnectionsRoutes(
      context(APP, "POST", null, {
        clientId: "Iv1.app-b",
        slug: "app-b",
        secret: "shh",
      }),
    );
    expect(response?.status).toBe(409);
    expect(existsSync(keyPath)).toBe(true);
  });

  test("DELETE clears the App keys but leaves other github config intact", async () => {
    await handleConnectionsRoutes(
      context(APP, "POST", null, {
        clientId: "Iv1.abc",
        slug: "my-app",
        secret: "shh",
        appOrg: "acme",
        privateKey: validPrivateKey(),
      }),
    );
    // A UI-managed key must be removed with the App; an unrelated github
    // config key proves the config clear remains surgical.
    const keyPath = join(dir, "github-app.pem");
    writeFileSync(keyPath, "old-app-private-key", { mode: 0o600 });
    const path = process.env.OPENSESSION_CONFIG!;
    const cfg = JSON.parse(readFileSync(path, "utf-8"));
    cfg.integrations.github.userPrAuth = false;
    writeFileSync(path, JSON.stringify(cfg));

    const res = await handleConnectionsRoutes(context(APP, "DELETE", null));
    expect(res?.status).toBe(200);

    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.integrations.github.oauthClientId).toBeUndefined();
    expect(after.integrations.github.appSlug).toBeUndefined();
    expect(after.integrations.github.userPrAuth).toBe(false);
    expect(existsSync(keyPath)).toBe(false);

    const get = await handleConnectionsRoutes(context(GET, "GET", null));
    expect((await get?.json()).connectAvailable).toBe(false);
  });

  test("POST is gated to simple mode (operator mode → 403)", async () => {
    enableOperatorMode();
    const res = await handleConnectionsRoutes(
      context(APP, "POST", null, { clientId: "Iv1.abc", slug: "my-app" }),
    );
    expect(res?.status).toBe(403);
  });

  test("an env-set App cannot be overridden from the UI (409)", async () => {
    process.env.OPENSESSION_GITHUB_CLIENT_ID = "env-client";
    const res = await handleConnectionsRoutes(
      context(APP, "POST", null, { clientId: "Iv1.abc", slug: "my-app" }),
    );
    expect(res?.status).toBe(409);
  });
});

// ── The connect-time auth bootstrap (authOnConnect) ──────────────────────────
// Simple-mode connect turning the workspace into operator mode in one request:
// the just-authorized GitHub login is rostered as the first admin BEFORE
// userPrAuth is flipped (single atomic write), a session cookie is set on the
// response, and the intent is cleared. This is auth-critical — a wrong ordering
// would leave the gate on with nobody able to sign in. GitHub is stubbed; the
// login is ground truth from GET /user.

const POLL = "/api/connections/github/device/poll";

function writeGithubConfig(
  github: Record<string, unknown>,
  team?: Record<string, unknown>[],
): string {
  const path = join(dir, `boot-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      integrations: { github },
      ...(team ? { identity: { team } } : {}),
    }),
  );
  process.env.OPENSESSION_CONFIG = path;
  return path;
}

/** Stub the two calls a device poll makes: the token exchange, then GET /user
 *  (which reports WHO authorized). Returns a restore fn. */
function stubGithubDeviceFetch(login: string, name?: string): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/login/oauth/access_token"))
      return new Response(
        JSON.stringify({ access_token: "tok-123", scope: "repo" }),
        { status: 200 },
      );
    if (u.includes("api.github.com/user"))
      return new Response(
        JSON.stringify({ login, ...(name ? { name } : {}) }),
        {
          status: 200,
        },
      );
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

describe("connect-time auth bootstrap", () => {
  test("personal authOnConnect: replaces the local user, flips userPrAuth, and sets a session cookie", async () => {
    const cfg = writeGithubConfig(
      {
        oauthClientId: "cid",
        authOnConnect: true,
      },
      [{ name: "Local User" }],
    );
    const restore = stubGithubDeviceFetch("octocat", "Octo Cat");
    try {
      const res = await handleConnectionsRoutes(
        context(POLL, "POST", null, { deviceCode: "dc-1" }),
      );
      expect(res?.status).toBe(200);
      const body = await res?.json();
      expect(body.status).toBe("ok");
      expect(body.login).toBe("octocat");
      expect(body.authEnabled).toBe(true);
      expect(body.admin).toBe(true);
      // The browser is signed in on this very response.
      expect(res?.headers.get("set-cookie") || "").toContain(
        "opensession_auth=",
      );

      const written = JSON.parse(readFileSync(cfg, "utf-8"));
      // Rostered admin AND the flip live in the SAME persisted file — a single
      // atomic write, so no readable state ever had the gate on without the
      // admin present (the no-locked-out-window property).
      const admin = written.identity.team.find(
        (m: any) => m.github?.toLowerCase() === "octocat",
      );
      expect(admin.admin).toBe(true);
      expect(admin.name).toBe("Octo Cat");
      expect(written.identity.team).toEqual([
        { name: "Octo Cat", github: "octocat", admin: true },
      ]);
      expect(written.integrations.github.userPrAuth).toBe(true);
      // Intent consumed; the personal App learns its verified installation owner.
      expect(written.integrations.github.authOnConnect).toBeUndefined();
      expect(written.integrations.github.appOrg).toBeUndefined();
      expect(written.integrations.github.installationOwner).toBe("octocat");
      expect(written.integrations.github.oauthClientId).toBe("cid");

      // A web session exists for the just-connected login.
      const store = JSON.parse(
        readFileSync(process.env.OPENSESSION_WEB_SESSIONS_STORE!, "utf-8"),
      );
      expect(store.sessions.some((s: any) => s.login === "octocat")).toBe(true);
    } finally {
      restore();
    }
  });

  test("refuses to flip when a concurrent connect replaced the stored account", async () => {
    // The finding: token storage happens before this lock. If a racing poll
    // authorized a different account, the simple-mode store now holds Bob, so
    // enabling sign-in for Alice would roster an admin whose token is gone
    // (githubCredentialForLogin("alice") is null). The in-lock revalidation must
    // refuse and leave the gate + intent untouched.
    const cfg = writeGithubConfig({
      oauthClientId: "cid",
      authOnConnect: true,
    });
    const storePath = join(
      dir,
      `gh-auth-${Math.random().toString(36).slice(2)}.json`,
    );
    writeFileSync(
      storePath,
      JSON.stringify({
        users: {
          bob: {
            login: "bob",
            token: "tok-bob",
            connectedAt: "2020-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    process.env.OPENSESSION_GITHUB_AUTH_STORE = storePath;
    try {
      const boot = await bootstrapUserAuthOnConnect("alice", "Alice");
      expect("error" in boot).toBe(true);
      const written = JSON.parse(readFileSync(cfg, "utf-8"));
      expect(written.integrations.github.userPrAuth).toBeUndefined(); // gate NOT flipped
      expect(written.integrations.github.authOnConnect).toBe(true); // intent NOT consumed
    } finally {
      delete process.env.OPENSESSION_GITHUB_AUTH_STORE;
    }
  });

  test("no authOnConnect: simple mode is unchanged (no cookie, no flip, no roster)", async () => {
    const cfg = writeGithubConfig({ oauthClientId: "cid" });
    const restore = stubGithubDeviceFetch("octocat", "Octo Cat");
    try {
      const res = await handleConnectionsRoutes(
        context(POLL, "POST", null, { deviceCode: "dc-2" }),
      );
      expect(res?.status).toBe(200);
      const body = await res?.json();
      expect(body.status).toBe("ok");
      expect(body.login).toBe("octocat");
      // None of the bootstrap fired.
      expect(body.authEnabled).toBeUndefined();
      expect(body.admin).toBeUndefined();
      expect(res?.headers.get("set-cookie")).toBeNull();

      const written = JSON.parse(readFileSync(cfg, "utf-8"));
      expect(written.integrations.github.userPrAuth).toBeUndefined();
      expect(written.identity).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("preflight refuses the flip when no rostered github login results", async () => {
    const cfg = writeGithubConfig({
      oauthClientId: "cid",
      appOrg: "acme-inc",
      authOnConnect: true,
    });
    // An empty login can't become a sign-in-capable admin, so the preflight
    // fails closed: nothing is persisted, the gate stays off, intent intact.
    const result = await bootstrapUserAuthOnConnect("", undefined);
    expect("error" in result).toBe(true);
    const written = JSON.parse(readFileSync(cfg, "utf-8"));
    expect(written.integrations.github.userPrAuth).toBeUndefined();
    expect(written.integrations.github.authOnConnect).toBe(true);
    expect(written.identity).toBeUndefined();
  });

  test("refuses a second bootstrap once the intent is consumed (TOCTOU)", async () => {
    const cfg = writeGithubConfig({
      oauthClientId: "cid",
      authOnConnect: true,
    });
    // The connecting account is in the store (pollGithubDeviceFlow stored it
    // before the lock), so the in-lock revalidation passes for @alice.
    const storePath = join(
      dir,
      `gh-auth-${Math.random().toString(36).slice(2)}.json`,
    );
    writeFileSync(
      storePath,
      JSON.stringify({
        users: {
          alice: {
            login: "alice",
            token: "tok-alice",
            source: "device",
            connectedAt: "2020-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    process.env.OPENSESSION_GITHUB_AUTH_STORE = storePath;
    try {
      // First connect consumes authOnConnect: rosters @alice, flips the gate.
      const first = await bootstrapUserAuthOnConnect("alice", "Alice");
      expect("error" in first).toBe(false);
      // A second poll that also passed the pre-lock check must be refused INSIDE
      // the lock, or it would roster @bob as a second admin and mint a session.
      const second = await bootstrapUserAuthOnConnect("bob", "Bob");
      expect("error" in second).toBe(true);
      const written = JSON.parse(readFileSync(cfg, "utf-8"));
      const admins = written.identity.team.filter((m: any) => m.admin === true);
      expect(admins.length).toBe(1); // @bob was never rostered
      expect(admins[0].github.toLowerCase()).toBe("alice");
      expect(written.integrations.github.authOnConnect).toBeUndefined();
    } finally {
      delete process.env.OPENSESSION_GITHUB_AUTH_STORE;
    }
  });
});
