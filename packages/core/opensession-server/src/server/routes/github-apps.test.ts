import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigAsync } from "../config";
import { __setGithubAppKeyPathForTest } from "../github-app";
import { __setAdditionalGithubAppKeyDirForTest } from "../github-app-registry";
import { loadGithubAuthStore } from "../github-auth";
import type { RouteContext } from "./context";
import { handleGithubAppsRoutes } from "./github-apps";

const saved = {
  config: process.env.OPENSESSION_CONFIG,
  store: process.env.OPENSESSION_GITHUB_AUTH_STORE,
  clientId: process.env.OPENSESSION_GITHUB_CLIENT_ID,
};
const originalFetch = globalThis.fetch;
let dir = "";
let configPath = "";

function context(
  path: string,
  method: "GET" | "POST" | "DELETE",
  authUser: RouteContext["authUser"] = null,
): RouteContext {
  const url = new URL(`http://localhost${path}`);
  return {
    req: new Request(url, { method }),
    url,
    path,
    publicPrefix: "",
    authUser,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "opensession-github-apps-route-"));
  configPath = join(dir, "config.json");
  const keyDir = join(dir, "github-apps");
  mkdirSync(keyDir);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  writeFileSync(join(dir, "github-app.pem"), pem);
  writeFileSync(join(keyDir, "personal1.pem"), pem);
  writeFileSync(
    configPath,
    JSON.stringify({
      integrations: {
        github: {
          oauthClientId: "Iv-primary",
          appSlug: "open-session-acme",
          installationOwner: "acme",
          apps: [
            {
              id: "personal1",
              owner: "octocat",
              ownerType: "User",
              appSlug: "open-session-octocat",
              oauthClientId: "Iv-personal",
              webhookSecret: "whsec-value",
            },
          ],
        },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = configPath;
  delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
  await getConfigAsync();
  process.env.OPENSESSION_GITHUB_AUTH_STORE = join(dir, "github-auth.json");
  writeFileSync(
    join(dir, "github-auth.app-personal1.json"),
    JSON.stringify({
      users: {
        octocat: {
          login: "octocat",
          token: "ghu_secret",
          refreshToken: "ghr_secret",
          source: "device",
          connectedAt: "2026-07-18T00:00:00.000Z",
        },
      },
    }),
  );
  await loadGithubAuthStore();
  __setAdditionalGithubAppKeyDirForTest(keyDir);
  await __setGithubAppKeyPathForTest(join(dir, "github-app.pem"));
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).startsWith("https://api.github.com/app/installations?"))
      return Response.json([
        { id: 9, account: { login: "octocat", type: "User" } },
      ]);
    throw new Error(`Unexpected request: ${String(input)}`);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  __setAdditionalGithubAppKeyDirForTest(undefined);
  await __setGithubAppKeyPathForTest(undefined);
  for (const [key, env] of [
    ["config", "OPENSESSION_CONFIG"],
    ["store", "OPENSESSION_GITHUB_AUTH_STORE"],
    ["clientId", "OPENSESSION_GITHUB_CLIENT_ID"],
  ] as const) {
    if (saved[key] === undefined) delete process.env[env];
    else process.env[env] = saved[key];
  }
  await getConfigAsync();
  (globalThis as any).__ghExtraAppInstallationsCache = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("GitHub account Apps settings API", () => {
  test("lists each App with its installation and sign-in, never a token", async () => {
    const response = await handleGithubAppsRoutes(
      context("/api/connections/github/apps", "GET"),
    );
    expect(response?.status).toBe(200);
    const text = await response!.text();
    expect(text).not.toContain("ghu_secret");
    expect(text).not.toContain("ghr_secret");
    expect(text).not.toContain("whsec-value");
    const body = JSON.parse(text);
    expect(body.primary).toMatchObject({ slug: "open-session-acme" });
    expect(body.apps).toEqual([
      expect.objectContaining({
        id: "personal1",
        owner: "octocat",
        keyConfigured: true,
        installed: true,
        accounts: [expect.objectContaining({ login: "octocat" })],
      }),
    ]);
  });

  test("refuses automation callers", async () => {
    const response = await handleGithubAppsRoutes(
      context("/api/connections/github/apps", "GET", {
        login: "bot",
        name: "Bot",
        automation: true,
      }),
    );
    expect(response?.status).toBe(403);
  });

  test("removing an App drops its config entry, key and sign-ins and keeps the first App", async () => {
    const response = await handleGithubAppsRoutes(
      context("/api/connections/github/apps/personal1", "DELETE"),
    );
    expect(response?.status).toBe(200);
    const github = JSON.parse(readFileSync(configPath, "utf8")).integrations
      .github;
    expect(github.apps).toBeUndefined();
    expect(github.oauthClientId).toBe("Iv-primary");
    expect(existsSync(join(dir, "github-apps", "personal1.pem"))).toBe(false);
    expect(existsSync(join(dir, "github-auth.app-personal1.json"))).toBe(false);
    expect(existsSync(join(dir, "github-app.pem"))).toBe(true);
  });
});
