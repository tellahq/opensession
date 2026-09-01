import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSetupRoutes } from "./setup";
import type { RouteContext } from "./context";

const saved = {
  home: process.env.HOME,
  config: process.env.OPENSESSION_CONFIG,
  envFile: process.env.OPENSESSION_ENV_FILE,
  enabled: process.env.ENABLE_GITHUB_AGENT,
};
const dirs: string[] = [];

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("HOME", saved.home);
  restore("OPENSESSION_CONFIG", saved.config);
  restore("OPENSESSION_ENV_FILE", saved.envFile);
  restore("ENABLE_GITHUB_AGENT", saved.enabled);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("GitHub integration status", () => {
  test("reports the App credential without a static-token field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-github-app-status-"));
    dirs.push(dir);
    const state = join(dir, ".opensession");
    mkdirSync(state);
    const config = join(state, "config.json");
    const envFile = join(dir, ".opensession.env");
    writeFileSync(
      config,
      JSON.stringify({
        integrations: {
          github: {
            enabled: true,
            oauthClientId: "Iv-test-client",
            appSlug: "open-session-test",
            installationOwner: "acme",
          },
        },
        identity: { team: [{ name: "Admin", github: "admin", admin: true }] },
      }),
    );
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(
      join(state, "github-app.pem"),
      privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600 },
    );
    writeFileSync(envFile, "ENABLE_GITHUB_AGENT=true\n");
    process.env.HOME = dir;
    process.env.OPENSESSION_CONFIG = config;
    process.env.OPENSESSION_ENV_FILE = envFile;
    process.env.ENABLE_GITHUB_AGENT = "true";

    const url = new URL("http://localhost/api/setup/status");
    const context: RouteContext = {
      req: new Request(url),
      url,
      path: url.pathname,
      publicPrefix: "",
      authUser: { login: "admin", name: "Admin" },
    };
    const response = await handleSetupRoutes(context);
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as any;
    expect(body.github).toMatchObject({
      appSlug: "open-session-test",
      installationOwner: "acme",
      appCredentialConfigured: true,
      privateKeyConfigured: true,
    });
    const github = body.integrations.find((item: any) => item.id === "github");
    expect(github.missingRequired).toEqual([]);
    expect(github.env.map((item: any) => item.name)).not.toContain(
      "GITHUB_API_TOKEN",
    );
  });
});
