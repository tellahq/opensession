import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleSetupRoutes } from "./setup";
import type { RouteContext } from "./context";

const savedConfig = process.env.OPENSESSION_CONFIG;
const savedAuthStore = process.env.OPENSESSION_GITHUB_AUTH_STORE;
const savedAppKey = process.env.OPENSESSION_GITHUB_APP_KEY;
const dirs: string[] = [];

function setupFiles(account?: { login: string; name?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "opensession-setup-github-toggle-"));
  dirs.push(dir);
  const config = join(dir, "config.json");
  const authStore = join(dir, "github-auth.json");
  const appKey = join(dir, "github-app.pem");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(appKey, privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  writeFileSync(
    config,
    JSON.stringify({
      integrations: {
        github: {
          oauthClientId: "client-id",
          oauthClientSecret: "client-secret",
          appSlug: "open-session-acme",
          installationOwner: "acme",
        },
      },
      identity: { team: [{ name: "Local User" }] },
    }),
  );
  writeFileSync(
    authStore,
    JSON.stringify({
      users: account
        ? {
            [account.login.toLowerCase()]: {
              login: account.login,
              ...(account.name ? { name: account.name } : {}),
              token: "token",
              source: "device",
              connectedAt: "2026-01-01T00:00:00.000Z",
            },
          }
        : {},
    }),
  );
  process.env.OPENSESSION_CONFIG = config;
  process.env.OPENSESSION_GITHUB_AUTH_STORE = authStore;
  process.env.OPENSESSION_GITHUB_APP_KEY = appKey;
  return config;
}

function githubRequest(body: Record<string, unknown>): RouteContext {
  const url = new URL("http://localhost/api/setup/github");
  return {
    req: new Request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    url,
    path: url.pathname,
    publicPrefix: "",
  };
}

afterEach(() => {
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = savedConfig;
  if (savedAuthStore === undefined)
    delete process.env.OPENSESSION_GITHUB_AUTH_STORE;
  else process.env.OPENSESSION_GITHUB_AUTH_STORE = savedAuthStore;
  if (savedAppKey === undefined) delete process.env.OPENSESSION_GITHUB_APP_KEY;
  else process.env.OPENSESSION_GITHUB_APP_KEY = savedAppKey;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("enabling GitHub sign-in", () => {
  test("rosters the sole connected account as admin on a personal install", async () => {
    const config = setupFiles({ login: "jasmoony", name: "Jas Moony" });

    const response = await handleSetupRoutes(
      githubRequest({ userPrAuth: true }),
    );
    expect(response?.status).toBe(200);
    const written = JSON.parse(readFileSync(config, "utf8"));
    expect(written.integrations.github).toMatchObject({
      userPrAuth: true,
    });
    expect(written.identity.team).toEqual([
      { name: "Jas Moony", github: "jasmoony", admin: true },
    ]);
  });

  test("refuses to lock an empty personal install behind sign-in", async () => {
    const config = setupFiles();

    const response = await handleSetupRoutes(
      githubRequest({ userPrAuth: true }),
    );
    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      error:
        "Connect one GitHub account or add a team member before enabling GitHub sign-in",
    });
    const written = JSON.parse(readFileSync(config, "utf8"));
    expect(written.integrations.github.userPrAuth).toBeUndefined();
    expect(written.identity.team).toEqual([{ name: "Local User" }]);
  });

  test("saves the mention handle used by the GitHub agent", async () => {
    const config = setupFiles();

    const response = await handleSetupRoutes(
      githubRequest({ mentionHandle: "@session-bot" }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ restartRequired: true });
    const written = JSON.parse(readFileSync(config, "utf8"));
    expect(written.integrations.github.mentionHandles).toEqual(["session-bot"]);
  });
});

describe("GitHub App identity settings", () => {
  test("persists the slug and installation owner with the existing client id", async () => {
    const config = setupFiles();
    const url = new URL("http://localhost/api/setup/github");
    const response = await handleSetupRoutes({
      req: new Request(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appSlug: "open-session-acme",
          installationOwner: "acme",
        }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });

    expect(response?.status).toBe(200);
    const written = JSON.parse(readFileSync(config, "utf8"));
    expect(written.integrations.github).toMatchObject({
      oauthClientId: "client-id",
      appSlug: "open-session-acme",
      installationOwner: "acme",
    });
  });

  test("clears a legacy installation id when changing owners", async () => {
    const config = setupFiles();
    const current = JSON.parse(readFileSync(config, "utf8"));
    current.integrations.github.installationId = 123;
    writeFileSync(config, JSON.stringify(current));

    const response = await handleSetupRoutes(
      githubRequest({ installationOwner: "other-owner" }),
    );

    expect(response?.status).toBe(200);
    const written = JSON.parse(readFileSync(config, "utf8"));
    expect(written.integrations.github.installationOwner).toBe("other-owner");
    expect(written.integrations.github.installationId).toBeUndefined();
  });

  test("allows clearing the optional default installation owner", async () => {
    const config = setupFiles();
    const url = new URL("http://localhost/api/setup/github");
    const response = await handleSetupRoutes({
      req: new Request(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationOwner: "" }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });

    expect(response?.status).toBe(200);
    const written = JSON.parse(readFileSync(config, "utf8"));
    expect(written.integrations.github.installationOwner).toBeUndefined();
  });
});
