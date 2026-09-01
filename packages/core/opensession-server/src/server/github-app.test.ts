import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setGithubAppKeyPathForTest,
  githubAppCredentialHealth,
  githubAppInstallationToken,
  githubAppRepositoryToken,
  githubRepositoryMatchesInstallation,
  githubToken,
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
  cache.__ghAppTokenCache = undefined;
  cache.__ghAppTokenWarned = undefined;
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
    let calls = 0;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls++;
      expect(String(input)).toBe(
        "https://api.github.com/app/installations?per_page=100&page=1",
      );
      expect(
        String((init?.headers as Record<string, string>).Authorization),
      ).toMatch(/^Bearer /);
      return Response.json([
        { id: 1, account: { login: "solo-dev", type: "User" } },
        { id: 2, account: { login: "acme-org", type: "Organization" } },
        // No account: dropped rather than listed as an empty login.
        { id: 3 },
      ]);
    }) as typeof fetch;

    const expected = [
      { id: 1, login: "solo-dev", type: "User" },
      { id: 2, login: "acme-org", type: "Organization" },
    ];
    expect(await listGithubAppInstallations()).toEqual(expected);
    // Briefly cached: the picker refetches on every open.
    expect(await listGithubAppInstallations()).toEqual(expected);
    expect(calls).toBe(1);
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

  function writeOwnerConfig(path: string, installationOwner?: string): void {
    writeFileSync(
      path,
      JSON.stringify({
        integrations: {
          github: {
            oauthClientId: "Iv-owner-test",
            appSlug: "open-session-owner-test",
            ...(installationOwner ? { installationOwner } : {}),
          },
        },
      }),
    );
  }

  /** Two installations (owner-a: 1, owner-b: 2) that mint distinct tokens. */
  function twoInstallationFetch(requests: string[]): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method || "GET"} ${url}`);
      if (url.startsWith("https://api.github.com/app/installations?")) {
        return Response.json([
          { id: 1, account: { login: "Owner-A", type: "Organization" } },
          { id: 2, account: { login: "owner-b", type: "Organization" } },
        ]);
      }
      const mint = url.match(/\/app\/installations\/(\d+)\/access_tokens$/);
      if (mint) {
        const body = JSON.parse(String(init?.body));
        const scope = body.repositories
          ? `repo:${body.repositories.join(",")}`
          : body.permissions.contents === "write"
            ? "write"
            : "read";
        return Response.json({
          token: `ghs_${mint[1]}_${scope}`,
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
  }

  test("does not reuse a token cached for a previous default owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-github-owner-cache-"));
    dirs.push(dir);
    const config = join(dir, "config.json");
    const keyPath = join(dir, "github-app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
    writeOwnerConfig(config, "owner-b");
    process.env.OPENSESSION_CONFIG = config;
    delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
    __setGithubAppKeyPathForTest(keyPath);
    (globalThis as any).__ghAppTokenCache = new Map([
      [
        "Iv-owner-test:1:read",
        {
          token: "owner-a-token",
          expiresAt: Date.now() + 30 * 60_000,
          installationId: 1,
          installationOwner: "owner-a",
        },
      ],
    ]);
    const requests: string[] = [];
    globalThis.fetch = twoInstallationFetch(requests);

    expect(await githubAppInstallationToken()).toBe("ghs_2_read");
    expect(githubAppCredentialHealth()).toBe("operational");
    const changedConfig = join(dir, "config-owner-c.json");
    writeOwnerConfig(changedConfig, "owner-c");
    process.env.OPENSESSION_CONFIG = changedConfig;
    expect(githubAppCredentialHealth()).toBe("unchecked");
    expect(requests).toEqual([
      "GET https://api.github.com/app/installations?per_page=100&page=1",
      "POST https://api.github.com/app/installations/2/access_tokens",
    ]);
  });

  test("mints per repository owner across several installations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-github-multi-"));
    dirs.push(dir);
    const config = join(dir, "config.json");
    const keyPath = join(dir, "github-app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
    writeOwnerConfig(config, "owner-a");
    process.env.OPENSESSION_CONFIG = config;
    delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
    __setGithubAppKeyPathForTest(keyPath);
    const requests: string[] = [];
    globalThis.fetch = twoInstallationFetch(requests);

    // No repository: the configured default owner serves.
    expect(await githubToken()).toBe("ghs_1_read");
    expect(await githubToken({ write: true })).toBe("ghs_1_write");
    // A repository selects its owner's installation, case-insensitively.
    expect(await githubToken({ repo: "owner-b/app" })).toBe("ghs_2_read");
    expect(await githubToken({ repo: "OWNER-A/app", write: true })).toBe(
      "ghs_1_write",
    );
    // Repository-scoped code tokens follow the owner too.
    expect(await githubAppRepositoryToken("owner-b/app")).toBe(
      "ghs_2_repo:app",
    );
    expect(await githubAppRepositoryToken("owner-a/tool")).toBe(
      "ghs_1_repo:tool",
    );
    // An owner the App is not installed on fails closed, without a mint.
    expect(await githubToken({ repo: "stranger/app" })).toBeNull();
    expect(await githubAppRepositoryToken("stranger/app")).toBeNull();
    expect(await githubToken({ repo: "owner-a/app/extra" })).toBeNull();
    // The refusal of a foreign owner never marks the default credential dead.
    expect(githubAppCredentialHealth()).toBe("operational");

    // Default and explicit selectors share a cache only when they resolve to
    // the same installation and permission scope.
    const mints = requests.filter((r) => r.startsWith("POST"));
    expect(mints).toEqual([
      "POST https://api.github.com/app/installations/1/access_tokens",
      "POST https://api.github.com/app/installations/1/access_tokens",
      "POST https://api.github.com/app/installations/2/access_tokens",
      "POST https://api.github.com/app/installations/2/access_tokens",
      "POST https://api.github.com/app/installations/1/access_tokens",
    ]);
    // Cached per installation and scope: repeating costs no further mint.
    expect(await githubToken({ repo: "owner-b/app" })).toBe("ghs_2_read");
    expect(await githubToken({ repo: "OWNER-A/app", write: true })).toBe(
      "ghs_1_write",
    );
    expect(await githubToken()).toBe("ghs_1_read");
    expect(requests.filter((r) => r.startsWith("POST"))).toHaveLength(5);
  });

  test("a second installation works without a configured default owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-github-nodefault-"));
    dirs.push(dir);
    const config = join(dir, "config.json");
    const keyPath = join(dir, "github-app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
    // With no default and several installations, repo-less calls fail closed,
    // while repository calls still resolve their own installation.
    writeOwnerConfig(config);
    process.env.OPENSESSION_CONFIG = config;
    delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
    __setGithubAppKeyPathForTest(keyPath);
    globalThis.fetch = twoInstallationFetch([]);

    expect(await githubToken()).toBeNull();
    expect(githubAppCredentialHealth()).toBe("unavailable");
    expect(await githubToken({ repo: "owner-b/app" })).toBe("ghs_2_read");
  });
});
