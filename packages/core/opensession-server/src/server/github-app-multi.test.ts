import { getConfigAsync } from "./config";
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setGithubAppKeyPathForTest,
  githubAppRepositoryToken,
  githubToken,
  listEveryGithubAppInstallation,
  loadAdditionalGithubAppKeyState,
  withAdditionalAppRunCredentials,
} from "./github-app";
import {
  __setAdditionalGithubAppKeyDirForTest,
  additionalGithubAppForOwner,
  additionalGithubApps,
  githubWebhookPath,
} from "./github-app-registry";
import { githubGitCredentialEnv } from "./github-git-credential";

const savedConfig = process.env.OPENSESSION_CONFIG;
const savedClientId = process.env.OPENSESSION_GITHUB_CLIENT_ID;
const originalFetch = globalThis.fetch;
const dirs: string[] = [];

afterEach(async () => {
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else {
    process.env.OPENSESSION_CONFIG = savedConfig;
    await getConfigAsync();
  }
  if (savedClientId === undefined)
    delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
  else process.env.OPENSESSION_GITHUB_CLIENT_ID = savedClientId;
  globalThis.fetch = originalFetch;
  await __setGithubAppKeyPathForTest(undefined);
  __setAdditionalGithubAppKeyDirForTest(undefined);
  const cache = globalThis as any;
  cache.__ghAppTokenCache = undefined;
  cache.__ghAppTokenWarned = undefined;
  cache.__ghAppInstallationsCache = null;
  cache.__ghExtraAppInstallationsCache = undefined;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function pem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ format: "pem", type: "pkcs8" }) as string;
}

/** JWT issuer (the App's client id) of an App-authenticated request. */
function issuer(init?: RequestInit): string {
  const auth = String(
    (init?.headers as Record<string, string> | undefined)?.Authorization || "",
  );
  const payload = auth.replace(/^Bearer /, "").split(".")[1] || "";
  return JSON.parse(Buffer.from(payload, "base64url").toString()).iss;
}

/**
 * The primary App (Iv-primary) is installed on the org `acme` (id 1). An
 * additional App (Iv-personal) belongs to the personal account `octocat` and
 * is installed there (id 9). Each App only answers for its own client id.
 */
async function setup(opts: { apps?: unknown[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "opensession-github-multi-app-"));
  dirs.push(dir);
  const config = join(dir, "config.json");
  const keyPath = join(dir, "github-app.pem");
  const keyDir = join(dir, "github-apps");
  mkdirSync(keyDir);
  writeFileSync(keyPath, pem());
  writeFileSync(join(keyDir, "personal1.pem"), pem());
  writeFileSync(
    config,
    JSON.stringify({
      integrations: {
        github: {
          oauthClientId: "Iv-primary",
          appSlug: "open-session-acme",
          installationOwner: "acme",
          apps: opts.apps ?? [
            {
              id: "personal1",
              owner: "OctoCat",
              ownerType: "User",
              appSlug: "open-session-octocat",
              oauthClientId: "Iv-personal",
              oauthClientSecret: "secret",
              webhookSecret: "hook-secret",
            },
          ],
        },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = config;
  await getConfigAsync();
  delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
  __setAdditionalGithubAppKeyDirForTest(keyDir);
  await __setGithubAppKeyPathForTest(keyPath);
  for (const app of additionalGithubApps())
    await loadAdditionalGithubAppKeyState(app);
  const requests: string[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const iss = issuer(init);
    requests.push(`${iss} ${init?.method || "GET"} ${url}`);
    if (url.startsWith("https://api.github.com/app/installations?")) {
      return Response.json(
        iss === "Iv-primary"
          ? [{ id: 1, account: { login: "acme", type: "Organization" } }]
          : [{ id: 9, account: { login: "octocat", type: "User" } }],
      );
    }
    const mint = url.match(/\/app\/installations\/(\d+)\/access_tokens$/);
    if (mint) {
      // An App can only mint for its own installations.
      const own = iss === "Iv-primary" ? "1" : "9";
      if (mint[1] !== own)
        return Response.json({ message: "Not Found" }, { status: 404 });
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
  return { requests };
}

describe("additional per-account GitHub Apps", () => {
  test("pick the App by repository owner and leave every other owner on the primary App", async () => {
    const { requests } = await setup();
    expect(additionalGithubAppForOwner("octocat")?.id).toBe("personal1");
    expect(additionalGithubAppForOwner("acme")).toBeNull();

    expect(await githubToken({ repo: "octocat/fork" })).toBe("ghs_9_read");
    expect(await githubToken({ repo: "OCTOCAT/fork", write: true })).toBe(
      "ghs_9_write",
    );
    expect(await githubAppRepositoryToken("octocat/fork")).toBe(
      "ghs_9_repo:fork",
    );
    // The primary App keeps its owners and the repo-less default.
    expect(await githubToken({ repo: "acme/app" })).toBe("ghs_1_read");
    expect(await githubToken()).toBe("ghs_1_read");
    // An owner neither App serves still fails closed.
    expect(await githubToken({ repo: "stranger/app" })).toBeNull();

    // Every octocat request authenticated as the personal App, every other
    // one as the primary App.
    for (const line of requests) {
      if (/installations\/9\//.test(line))
        expect(line).toMatch(/^Iv-personal /);
      if (/installations\/1\//.test(line)) expect(line).toMatch(/^Iv-primary /);
    }
  });

  test("without an apps list the primary App serves every owner exactly as before", async () => {
    const { requests } = await setup({ apps: [] });
    expect(additionalGithubApps()).toEqual([]);
    expect(await githubToken({ repo: "octocat/fork" })).toBeNull();
    expect(await githubToken({ repo: "acme/app" })).toBe("ghs_1_read");
    expect(requests.every((line) => line.startsWith("Iv-primary "))).toBe(true);
  });

  test("ignores incomplete and duplicate entries", async () => {
    await setup({
      apps: [
        { id: "Bad Id", owner: "x", appSlug: "s", oauthClientId: "c" },
        { id: "noowner", appSlug: "s", oauthClientId: "c" },
        { id: "first", owner: "dup", appSlug: "s1", oauthClientId: "c1" },
        { id: "second", owner: "DUP", appSlug: "s2", oauthClientId: "c2" },
      ],
    });
    expect(additionalGithubApps().map((app) => app.id)).toEqual(["first"]);
    expect(githubWebhookPath("first")).toBe("/github/webhook/first");
    expect(githubWebhookPath()).toBe("/github/webhook");
  });

  test("the repository picker lists the additional App's account beside the primary installations", async () => {
    await setup();
    const installations = await listEveryGithubAppInstallation();
    expect(installations?.map((i) => i.login).sort()).toEqual([
      "acme",
      "octocat",
    ]);
  });

  test("a run spanning both accounts gets an owner-scoped credential for the additional App", async () => {
    await setup();
    const primary = githubGitCredentialEnv("ghs_1_repo:app");
    const env = await withAdditionalAppRunCredentials(primary, {
      ghRepo: "acme/app",
      attachedRepos: ["octocat/fork"],
      personal: false,
    });
    // The session's own repository keeps the primary token for gh.
    expect(env.GH_TOKEN).toBe("ghs_1_repo:app");
    expect(env.OPENSESSION_GITHUB_OWNER_TOKEN_0).toBe("ghs_9_repo:fork");
    const keys = Object.entries(env)
      .filter(([k]) => /^GIT_CONFIG_KEY_\d+$/.test(k))
      .sort(
        ([a], [b]) => Number(a.split("_").pop()) - Number(b.split("_").pop()),
      )
      .map(([, v]) => v);
    // Owner helpers sit after the reset and before the general helper.
    expect(keys.slice(0, 4)).toEqual([
      "credential.https://github.com.helper",
      "credential.https://github.com/OctoCat.helper",
      "credential.https://github.com/octocat.helper",
      "credential.https://github.com.helper",
    ]);

    // A session whose own repository is under the personal account points
    // gh there too.
    const own = await withAdditionalAppRunCredentials(primary, {
      ghRepo: "octocat/fork",
      personal: false,
    });
    expect(own.GH_TOKEN).toBe("ghs_9_repo:fork");
    expect(own.GITHUB_TOKEN).toBe("ghs_9_repo:fork");

    // Nothing to add for a run that only touches the primary App's owners.
    const untouched = await withAdditionalAppRunCredentials(primary, {
      ghRepo: "acme/app",
      personal: false,
    });
    expect(untouched).toEqual(primary);
  });
});
