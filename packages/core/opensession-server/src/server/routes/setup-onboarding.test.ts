import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSetupRoutes } from "./setup";
import type { RouteContext } from "./context";

const savedConfig = process.env.OPENSESSION_CONFIG;
const savedGithubStore = process.env.OPENSESSION_GITHUB_AUTH_STORE;
const dirs: string[] = [];

function request(
  method: "GET" | "PUT",
  body?: unknown,
  authUser: RouteContext["authUser"] = { login: "admin", name: "Admin" },
): RouteContext {
  const url = new URL("http://localhost/api/setup/onboarding");
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
    path: url.pathname,
    publicPrefix: "",
    authUser,
  };
}

afterEach(() => {
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = savedConfig;
  if (savedGithubStore === undefined)
    delete process.env.OPENSESSION_GITHUB_AUTH_STORE;
  else process.env.OPENSESSION_GITHUB_AUTH_STORE = savedGithubStore;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("instance onboarding flag", () => {
  test("treats an existing pre-flag instance as already onboarded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-onboarding-legacy-"));
    dirs.push(dir);
    process.env.OPENSESSION_CONFIG = join(dir, "config.json");

    const response = await handleSetupRoutes(request("GET"));
    expect(await response?.json()).toEqual({ completed: true });
  });

  test("stays required until the final action explicitly completes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-onboarding-"));
    dirs.push(dir);
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ onboardingCompleted: false }));
    process.env.OPENSESSION_CONFIG = config;
    process.env.OPENSESSION_GITHUB_AUTH_STORE = join(dir, "github-auth.json");

    const before = await handleSetupRoutes(request("GET"));
    expect(await before?.json()).toEqual({ completed: false });
    expect(JSON.parse(readFileSync(config, "utf8"))).toMatchObject({
      onboardingCompleted: false,
      identity: { team: [{ name: "Local User" }] },
    });

    const completed = await handleSetupRoutes(
      request("PUT", { completed: true }),
    );
    expect(completed?.status).toBe(200);
    expect(await completed?.json()).toEqual({ completed: true });
    expect(JSON.parse(readFileSync(config, "utf8"))).toMatchObject({
      onboardingCompleted: true,
      identity: {
        team: [{ name: "Admin", github: "admin", admin: true }],
      },
    });

    const after = await handleSetupRoutes(request("GET"));
    expect(await after?.json()).toEqual({ completed: true });
  });

  test("creates a local member when onboarding finishes without sign-in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-onboarding-local-"));
    dirs.push(dir);
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ onboardingCompleted: false }));
    process.env.OPENSESSION_CONFIG = config;
    process.env.OPENSESSION_GITHUB_AUTH_STORE = join(dir, "github-auth.json");

    const completed = await handleSetupRoutes(
      request("PUT", { completed: true }, null),
    );
    expect(completed?.status).toBe(200);
    expect(JSON.parse(readFileSync(config, "utf8"))).toMatchObject({
      onboardingCompleted: true,
      identity: { team: [{ name: "Local User" }] },
    });
  });

  test("preserves an existing member when onboarding finishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-onboarding-member-"));
    dirs.push(dir);
    const config = join(dir, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        onboardingCompleted: false,
        identity: { team: [{ name: "Ada Lovelace" }] },
      }),
    );
    process.env.OPENSESSION_CONFIG = config;

    await handleSetupRoutes(request("PUT", { completed: true }, null));
    expect(JSON.parse(readFileSync(config, "utf8")).identity.team).toEqual([
      { name: "Ada Lovelace" },
    ]);
  });
});
