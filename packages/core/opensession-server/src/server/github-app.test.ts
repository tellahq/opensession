import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setGithubAppKeyPathForTest,
  githubAppCredentialHealth,
  githubAppInstallationToken,
  githubRepositoryMatchesInstallation,
  listGithubAppInstallations,
  updateGithubAppWebhook,
} from "./github-app";

const savedConfig = process.env.OPENSESSION_CONFIG;
const savedClientId = process.env.OPENSESSION_GITHUB_CLIENT_ID;
const originalFetch = globalThis.fetch;
const dirs: string[] = [];

afterEach(() => {
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = savedConfig;
  if (savedClientId === undefined)
    delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
  else process.env.OPENSESSION_GITHUB_CLIENT_ID = savedClientId;
  globalThis.fetch = originalFetch;
  __setGithubAppKeyPathForTest(undefined);
  const cache = globalThis as any;
  cache.__ghAppTokenCacheRead = null;
  cache.__ghAppTokenCacheWrite = null;
  cache.__ghAppLastMintOk = undefined;
  cache.__ghAppLastMintIdentity = undefined;
  cache.__ghAppInstallationsCache = null;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("GitHub App webhook", () => {
  test("connects a later public callback origin with the App JWT", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-github-webhook-"));
    dirs.push(dir);
    const config = join(dir, "config.json");
    const keyPath = join(dir, "github-app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
    writeFileSync(
      config,
      JSON.stringify({
        integrations: {
          github: { oauthClientId: "Iv-webhook-test" },
        },
      }),
    );
    process.env.OPENSESSION_CONFIG = config;
    delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
    __setGithubAppKeyPathForTest(keyPath);
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe("https://api.github.com/app/hook/config");
      expect(init?.method).toBe("PATCH");
      expect(
        String((init?.headers as Record<string, string>).Authorization),
      ).toMatch(/^Bearer /);
      expect(JSON.parse(String(init?.body))).toEqual({
        url: "https://ingress.example.test/github/webhook",
        content_type: "json",
        secret: "shared-secret",
        insecure_ssl: "0",
      });
      return Response.json({
        url: "https://ingress.example.test/github/webhook",
      });
    }) as typeof fetch;

    await updateGithubAppWebhook(
      "https://ingress.example.test",
      "shared-secret",
    );
  });
});

function writeAppIdentity(prefix: string, clientId: string): void {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  const config = join(dir, "config.json");
  const keyPath = join(dir, "github-app.pem");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
  writeFileSync(
    config,
    JSON.stringify({
      integrations: { github: { oauthClientId: clientId } },
    }),
  );
  process.env.OPENSESSION_CONFIG = config;
  delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
  __setGithubAppKeyPathForTest(keyPath);
}

describe("App installation directory", () => {
  test("lists every account the App is installed on", async () => {
    writeAppIdentity(
      "opensession-github-installations-",
      "Iv-installations-test",
    );
    const urls: string[] = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      urls.push(url);
      expect(
        String((init?.headers as Record<string, string>).Authorization),
      ).toMatch(/^Bearer /);
      if (url.endsWith("page=2")) {
        return Response.json([
          { id: 2, account: { login: "acme-org", type: "Organization" } },
          // No account: dropped rather than listed as an empty login.
          { id: 3 },
        ]);
      }
      return Response.json(
        [{ id: 1, account: { login: "solo-dev", type: "User" } }],
        {
          headers: {
            Link: '<https://api.github.com/app/installations?per_page=100&page=2>; rel="next"',
          },
        },
      );
    }) as typeof fetch;

    const expected = [
      { login: "solo-dev", type: "User" },
      { login: "acme-org", type: "Organization" },
    ];
    expect(await listGithubAppInstallations()).toEqual(expected);
    // Briefly cached: the picker refetches on every open.
    expect(await listGithubAppInstallations()).toEqual(expected);
    expect(urls).toEqual([
      "https://api.github.com/app/installations?per_page=100",
      "https://api.github.com/app/installations?per_page=100&page=2",
    ]);
  });

  test("answers null rather than none when GitHub cannot be reached", async () => {
    writeAppIdentity(
      "opensession-github-installations-",
      "Iv-installations-down",
    );
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    expect(await listGithubAppInstallations()).toBeNull();
  });
});

describe("repository-scoped App installation identity", () => {
  test("requires the requested repository owner to match the selected installation", () => {
    expect(
      githubRepositoryMatchesInstallation("tellahq/opensession", "TellaHQ"),
    ).toBe(true);
    expect(
      githubRepositoryMatchesInstallation("acme/opensession", "tellahq"),
    ).toBe(false);
    expect(
      githubRepositoryMatchesInstallation(
        "tellahq/opensession/extra",
        "tellahq",
      ),
    ).toBe(false);
    expect(
      githubRepositoryMatchesInstallation("tellahq/opensession", undefined),
    ).toBe(false);
  });

  test("does not reuse a token cached for a previous installation owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-github-owner-cache-"));
    dirs.push(dir);
    const config = join(dir, "config.json");
    const keyPath = join(dir, "github-app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
    writeFileSync(
      config,
      JSON.stringify({
        integrations: {
          github: {
            oauthClientId: "Iv-owner-test",
            appSlug: "open-session-owner-test",
            installationOwner: "owner-b",
          },
        },
      }),
    );
    process.env.OPENSESSION_CONFIG = config;
    __setGithubAppKeyPathForTest(keyPath);
    (globalThis as any).__ghAppTokenCacheRead = {
      token: "owner-a-token",
      expiresAt: Date.now() + 30 * 60_000,
      installationId: 1,
      installationOwner: "owner-a",
      credentialIdentity: "Iv-owner-test::owner-a",
    };
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("page=2")) {
        return Response.json([{ id: 2, account: { login: "owner-b" } }]);
      }
      if (url.endsWith("/app/installations?per_page=100")) {
        return Response.json([], {
          headers: {
            Link: '<https://api.github.com/app/installations?per_page=100&page=2>; rel="next"',
          },
        });
      }
      if (url.endsWith("/app/installations/2/access_tokens")) {
        return Response.json({
          token: "owner-b-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    expect(await githubAppInstallationToken()).toBe("owner-b-token");
    expect(githubAppCredentialHealth()).toBe("operational");
    const changedConfig = join(dir, "config-owner-c.json");
    writeFileSync(
      changedConfig,
      JSON.stringify({
        integrations: {
          github: {
            oauthClientId: "Iv-owner-test",
            appSlug: "open-session-owner-test",
            installationOwner: "owner-c",
          },
        },
      }),
    );
    process.env.OPENSESSION_CONFIG = changedConfig;
    expect(githubAppCredentialHealth()).toBe("unchecked");
    expect(requests).toEqual([
      "https://api.github.com/app/installations?per_page=100",
      "https://api.github.com/app/installations?per_page=100&page=2",
      "https://api.github.com/app/installations/2/access_tokens",
    ]);
  });
});
