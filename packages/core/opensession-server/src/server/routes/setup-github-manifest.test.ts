import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setGithubAppKeyPathForTest } from "../github-app";
import {
  __resetGithubManifestStatesForTest,
  buildGithubAppManifest,
  GITHUB_APP_MANIFEST_EVENTS,
} from "./setup-github-manifest";
import { handleSetupRoutes } from "./setup";
import type { RouteContext } from "./context";

const saved = {
  config: process.env.OPENSESSION_CONFIG,
  envFile: process.env.OPENSESSION_ENV_FILE,
  clientId: process.env.OPENSESSION_GITHUB_CLIENT_ID,
  keyPath: process.env.OPENSESSION_GITHUB_APP_KEY,
};
const originalFetch = globalThis.fetch;
let dir = "";
let configPath = "";
let envPath = "";
let keyPath = "";

function context(
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): RouteContext {
  const url = new URL(`http://100.90.80.70:3850/backstage${path}`);
  return {
    req: new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
    url,
    path: url.pathname.replace(/^\/backstage/, ""),
    publicPrefix: "/backstage",
    authUser: null,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opensession-github-manifest-"));
  configPath = join(dir, "config.json");
  envPath = join(dir, ".opensession.env");
  keyPath = join(dir, "github-app.pem");
  writeFileSync(configPath, JSON.stringify({ integrations: {} }));
  process.env.OPENSESSION_CONFIG = configPath;
  process.env.OPENSESSION_ENV_FILE = envPath;
  delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
  delete process.env.OPENSESSION_GITHUB_APP_KEY;
  __setGithubAppKeyPathForTest(keyPath);
  __resetGithubManifestStatesForTest();
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __setGithubAppKeyPathForTest(undefined);
  __resetGithubManifestStatesForTest();
  if (saved.config === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = saved.config;
  if (saved.envFile === undefined) delete process.env.OPENSESSION_ENV_FILE;
  else process.env.OPENSESSION_ENV_FILE = saved.envFile;
  if (saved.clientId === undefined)
    delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
  else process.env.OPENSESSION_GITHUB_CLIENT_ID = saved.clientId;
  if (saved.keyPath === undefined)
    delete process.env.OPENSESSION_GITHUB_APP_KEY;
  else process.env.OPENSESSION_GITHUB_APP_KEY = saved.keyPath;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("GitHub App manifest", () => {
  test("creates a private-only registration with an inactive webhook", () => {
    const manifest = buildGithubAppManifest({
      origin: "http://100.90.80.70:3850",
      publicPrefix: "/backstage",
      appName: "Open Session Test",
    });
    expect(manifest).toMatchObject({
      name: "Open Session Test",
      url: "http://100.90.80.70:3850",
      redirect_url:
        "http://100.90.80.70:3850/backstage/api/setup/github/manifest/callback",
      public: false,
      default_events: GITHUB_APP_MANIFEST_EVENTS,
    });
    expect(manifest.hook_attributes).toEqual({
      url: "http://100.90.80.70:3850/backstage/github/webhook",
      active: false,
    });
  });

  test("includes the dedicated callback endpoint when public ingress exists", () => {
    const manifest = buildGithubAppManifest({
      origin: "https://private.example.test",
      publicPrefix: "/backstage",
      ingressUrl: "https://ingress.example.test/",
    });
    expect(manifest.hook_attributes).toEqual({
      url: "https://ingress.example.test/github/webhook",
      active: true,
    });
  });

  test("a personal App waits for the verified connection before enabling sign-in", async () => {
    const start = await handleSetupRoutes(
      context("/api/setup/github/manifest", "POST", {
        owner: "personal",
        returnTo: "welcome",
      }),
    );
    expect(start?.status).toBe(200);
    const started = (await start?.json()) as { action: string };
    const action = new URL(started.action);
    expect(action.pathname).toBe("/settings/apps/new");
    const state = action.searchParams.get("state");
    expect(state).toBeTruthy();

    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(
        "https://api.github.com/app-manifests/temporary-code/conversions",
      );
      expect(init?.method).toBe("POST");
      return Response.json(
        {
          id: 42,
          slug: "open-session-personal",
          client_id: "Iv1.personal",
          client_secret: "client-secret-value",
          webhook_secret: "webhook-secret-value",
          pem,
          owner: { login: "octocat" },
        },
        { status: 201 },
      );
    }) as typeof fetch;

    const completed = await handleSetupRoutes(
      context(
        `/api/setup/github/manifest/callback?code=temporary-code&state=${encodeURIComponent(state!)}`,
        "GET",
      ),
    );
    expect(completed?.status).toBe(303);
    expect(completed?.headers.get("location")).toBe(
      "http://100.90.80.70:3850/backstage/welcome?step=github&github_manifest=created",
    );

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.integrations.github).toMatchObject({
      oauthClientId: "Iv1.personal",
      installationOwner: "octocat",
      authOnConnect: true,
    });
    expect(config.integrations.github.appOrg).toBeUndefined();
    // The sign-in gate stays open until device flow returns the account that
    // can be rostered and receive the new session.
    expect(config.integrations.github.userPrAuth).toBeUndefined();
  });

  test("creates, converts, and stores an organization-owned App without exposing secrets", async () => {
    const start = await handleSetupRoutes(
      context("/api/setup/github/manifest", "POST", {
        owner: "organization",
        organization: "acme",
        returnTo: "settings",
      }),
    );
    expect(start?.status).toBe(200);
    const started = (await start?.json()) as {
      action: string;
      manifest: string;
    };
    const action = new URL(started.action);
    expect(action.pathname).toBe("/organizations/acme/settings/apps/new");
    expect(action.searchParams.has("device_flow_enabled")).toBe(false);
    const state = action.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(started.manifest).not.toContain("secret");

    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(
        "https://api.github.com/app-manifests/temporary-code/conversions",
      );
      expect(init?.method).toBe("POST");
      return Response.json(
        {
          id: 42,
          slug: "open-session-acme",
          client_id: "Iv1.acme",
          client_secret: "client-secret-value",
          webhook_secret: "webhook-secret-value",
          pem,
          owner: { login: "acme" },
        },
        { status: 201 },
      );
    }) as typeof fetch;

    const callback = context(
      `/api/setup/github/manifest/callback?code=temporary-code&state=${encodeURIComponent(state!)}`,
      "GET",
    );
    const completed = await handleSetupRoutes(callback);
    expect(completed?.status).toBe(303);
    expect(completed?.headers.get("location")).toBe(
      "http://100.90.80.70:3850/backstage/settings/integrations?github_manifest=created",
    );

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.integrations.github).toMatchObject({
      oauthClientId: "Iv1.acme",
      oauthClientSecret: "client-secret-value",
      appSlug: "open-session-acme",
      installationOwner: "acme",
      appOrg: "acme",
      authOnConnect: true,
    });
    expect(readFileSync(keyPath, "utf8")).toContain("BEGIN PRIVATE KEY");
    expect(readFileSync(envPath, "utf8")).toContain(
      "GITHUB_WEBHOOK_SECRET=webhook-secret-value",
    );

    const replay = await handleSetupRoutes(callback);
    expect(replay?.status).toBe(400);
    expect(existsSync(keyPath)).toBe(true);
  });
});
