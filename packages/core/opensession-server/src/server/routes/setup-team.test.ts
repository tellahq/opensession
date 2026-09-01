import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleSetupTeamRoutes } from "./setup-team";
import type { RouteContext } from "./context";

const savedConfig = process.env.OPENSESSION_CONFIG;
const savedStore = process.env.OPENSESSION_GITHUB_AUTH_STORE;
const originalFetch = globalThis.fetch;
const dirs: string[] = [];

function context(): RouteContext {
  const url = new URL("http://localhost/api/setup/team/sync-github");
  return {
    req: new Request(url, { method: "POST" }),
    url,
    path: url.pathname,
    publicPrefix: "",
    authUser: { login: "ada", name: "Ada Lovelace" },
  };
}

function writeConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "opensession-setup-team-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      // The App wizard records its organization as appOrg before this
      // first-mile import runs.
      integrations: {
        github: { appOrg: "acme", userPrAuth: true, oauthClientId: "Iv-test" },
      },
      identity: { team: [{ name: "Ada Lovelace", github: "ada" }] },
    }),
  );
  process.env.OPENSESSION_CONFIG = path;
  const store = join(dir, "github-auth.json");
  writeFileSync(
    store,
    JSON.stringify({
      users: {
        ada: {
          login: "ada",
          token: "test-token",
          source: "device",
          connectedAt: new Date().toISOString(),
        },
      },
    }),
  );
  process.env.OPENSESSION_GITHUB_AUTH_STORE = store;
  return path;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = savedConfig;
  if (savedStore === undefined)
    delete process.env.OPENSESSION_GITHUB_AUTH_STORE;
  else process.env.OPENSESSION_GITHUB_AUTH_STORE = savedStore;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("GitHub organization member import", () => {
  test("adds every missing GitHub login once and preserves existing profiles", async () => {
    const configPath = writeConfig();
    let fetches = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetches++;
      expect(String(input)).toContain("/orgs/acme/members?per_page=100&page=1");
      return Response.json([
        { login: "ada", type: "User" },
        { login: "grace", type: "User" },
        { login: "acme-bot", type: "Bot" },
      ]);
    }) as unknown as typeof fetch;

    const response = await handleSetupTeamRoutes(context());
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body).toMatchObject({
      organization: "acme",
      synced: true,
      added: 1,
    });
    expect(body.members).toEqual([
      { name: "Ada Lovelace", github: "ada" },
      { name: "grace", github: "grace" },
    ]);

    const stored = JSON.parse(readFileSync(configPath, "utf8"));
    expect(stored.integrations.github.membersImportedOrganization).toBe("acme");
    expect(stored.identity.team).toEqual([
      { name: "Ada Lovelace", github: "ada" },
      { name: "grace", github: "grace" },
    ]);

    globalThis.fetch = (async () => {
      throw new Error("the completed import should not hit GitHub again");
    }) as unknown as typeof fetch;
    const repeated = await handleSetupTeamRoutes(context());
    expect(await repeated?.json()).toMatchObject({
      organization: "acme",
      synced: true,
      alreadyImported: true,
      added: 0,
    });
    expect(fetches).toBe(1);
  });
});
