import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GITHUB_RUN_AUTH_FILE_ENV } from "./github-auth";
import { githubCodeRunEnv } from "./pi-runner";

const keys = [
  "OPENSESSION_CONFIG",
  "OPENSESSION_GITHUB_AUTH_STORE",
  GITHUB_RUN_AUTH_FILE_ENV,
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("recovered GitHub code-run credentials", () => {
  test("fails closed instead of selecting a connected human", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-recovered-github-"));
    try {
      const cwd = join(dir, "repo");
      mkdirSync(cwd);
      const config = join(dir, "config.json");
      const users = join(dir, "github-users.json");
      writeFileSync(
        config,
        JSON.stringify({
          integrations: { github: {} },
          repos: {
            app: {
              repo: cwd,
              ghRepo: "tellahq/app",
              defaultBranch: "main",
            },
          },
        }),
      );
      writeFileSync(
        users,
        JSON.stringify({
          users: {
            alice: {
              login: "alice",
              token: "human-token",
              source: "device",
              connectedAt: new Date().toISOString(),
            },
          },
        }),
      );
      process.env.OPENSESSION_CONFIG = config;
      process.env.OPENSESSION_GITHUB_AUTH_STORE = users;
      delete process.env[GITHUB_RUN_AUTH_FILE_ENV];

      const env = await githubCodeRunEnv(cwd);
      expect(env.GH_TOKEN).toBe("");
      expect(env.GIT_CONFIG_VALUE_2).toBe("git@github.com:");
      expect(Object.values(env)).not.toContain("human-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("remote recovery consumes only its projected run-scoped file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-projected-github-"));
    try {
      const auth = join(dir, "github-auth.json");
      writeFileSync(
        auth,
        JSON.stringify({ GH_TOKEN: "projected-service-token" }),
      );
      process.env[GITHUB_RUN_AUTH_FILE_ENV] = auth;

      const env = await githubCodeRunEnv("/remote/unregistered/repo");
      expect(env.GH_TOKEN).toBe("projected-service-token");
      expect(env.GIT_CONFIG_VALUE_2).toBe("git@github.com:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
