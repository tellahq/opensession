import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getConfigAsync } from "./config";
import {
  connectedGithubAppAccounts,
  githubAppUserTokenForRun,
  githubCredentialForLogin,
  githubCredentialForPrincipal,
  loadGithubAuthStore,
  pollGithubDeviceFlow,
  removeGithubAppAccount,
} from "./github-auth";

const ENV_KEYS = [
  "OPENSESSION_CONFIG",
  "OPENSESSION_GITHUB_CLIENT_ID",
  "OPENSESSION_GITHUB_AUTH_STORE",
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
const originalFetch = globalThis.fetch;

let dir: string;

function account(login: string, token: string) {
  return {
    users: {
      [login.toLowerCase()]: {
        login,
        token,
        source: "device",
        connectedAt: "2026-07-18T00:00:00.000Z",
      },
    },
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "opensession-github-auth-multi-"));
  for (const k of ENV_KEYS) delete process.env[k];
  const config = join(dir, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      identity: { team: [{ name: "Alice Example", github: "alice" }] },
      integrations: {
        github: {
          userPrAuth: true,
          oauthClientId: "Iv-primary",
          apps: [
            {
              id: "personal1",
              owner: "alice",
              ownerType: "User",
              appSlug: "open-session-alice",
              oauthClientId: "Iv-personal",
            },
          ],
        },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = config;
  await getConfigAsync();
  process.env.OPENSESSION_GITHUB_AUTH_STORE = join(dir, "github-auth.json");
  writeFileSync(
    process.env.OPENSESSION_GITHUB_AUTH_STORE,
    JSON.stringify(account("alice", "primary-user-token")),
  );
  await loadGithubAuthStore();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function appStorePath(): string {
  return join(dir, "github-auth.app-personal1.json");
}

describe("sign-in to an additional per-account App", () => {
  test("without it, the person's credential is exactly the primary one", () => {
    const credential = githubCredentialForLogin("alice")!;
    expect(credential.env.GH_TOKEN).toBe("primary-user-token");
    expect(credential.env.GIT_CONFIG_COUNT).toBe("4");
    expect(githubAppUserTokenForRun("personal1", "alice")).toBeNull();
  });

  test("adds an owner-scoped git credential to every resolution of the person", async () => {
    writeFileSync(
      appStorePath(),
      JSON.stringify(account("alice", "personal-user-token")),
    );
    await loadGithubAuthStore();

    for (const credential of [
      githubCredentialForLogin("alice")!,
      githubCredentialForPrincipal("user:alice")!,
    ]) {
      // gh keeps the primary token; git gets the personal one for alice/*.
      expect(credential.principal).toBe("user:alice");
      expect(credential.env.GH_TOKEN).toBe("primary-user-token");
      expect(credential.env.OPENSESSION_GITHUB_OWNER_TOKEN_0).toBe(
        "personal-user-token",
      );
      expect(Object.values(credential.env)).toContain(
        "credential.https://github.com/alice.helper",
      );
    }
    expect(githubAppUserTokenForRun("personal1", "Alice Example")).toEqual({
      login: "alice",
      token: "personal-user-token",
    });
    expect(connectedGithubAppAccounts("personal1").map((a) => a.login)).toEqual(
      ["alice"],
    );

    expect(await removeGithubAppAccount("personal1", "alice")).toBe(true);
    expect(githubCredentialForLogin("alice")!.env.GIT_CONFIG_COUNT).toBe("4");
  });

  test("the device flow stores the token in that App's own store", async () => {
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        expect(JSON.parse(String(init?.body)).client_id).toBe("Iv-personal");
        return Response.json({
          access_token: "ghu_personal",
          expires_in: 28800,
          refresh_token: "ghr_personal",
        });
      }
      if (url === "https://api.github.com/user")
        return Response.json({ login: "alice" });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    const result = await pollGithubDeviceFlow(
      "device-code",
      "alice",
      "personal1",
    );
    expect(result).toMatchObject({ status: "ok", login: "alice" });
    expect(
      JSON.parse(await Bun.file(appStorePath()).text()).users.alice.token,
    ).toBe("ghu_personal");
    // The primary store is untouched.
    expect(
      JSON.parse(
        await Bun.file(process.env.OPENSESSION_GITHUB_AUTH_STORE!).text(),
      ).users.alice.token,
    ).toBe("primary-user-token");
  });
});
