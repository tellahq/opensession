// When the GitHub PR agent posts on the App installation token, its comments
// are authored by "<app-slug>[bot]". The agent must recognise that identity
// as ours from either the config slug or the env slug, alongside policy aliases
// retained for historical App names.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { githubBotLogins, isGithubBotLogin } from "./config";

const saved = {
  config: process.env.OPENSESSION_CONFIG,
  appSlug: process.env.OPENSESSION_GITHUB_APP_SLUG,
};
const dirs: string[] = [];

// The loader caches by path+mtime, so each case gets a fresh path.
function withConfig(obj: unknown): void {
  const dir = mkdtempSync(join(tmpdir(), "gh-bot-login-test-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(obj));
  process.env.OPENSESSION_CONFIG = path;
  delete process.env.OPENSESSION_GITHUB_APP_SLUG;
}

afterEach(() => {
  const restore = (k: string, v: string | undefined) =>
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  restore("OPENSESSION_CONFIG", saved.config);
  restore("OPENSESSION_GITHUB_APP_SLUG", saved.appSlug);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("githubBotLogins with a GitHub App", () => {
  test("recognises the App's <slug>[bot] author as ours (lowercased)", () => {
    withConfig({ integrations: { github: { appSlug: "Open-Session-v6a6" } } });
    expect(githubBotLogins()).toContain("open-session-v6a6[bot]");
  });

  test("resolves the slug from the env with precedence over config", () => {
    withConfig({ integrations: { github: { appSlug: "config-slug" } } });
    process.env.OPENSESSION_GITHUB_APP_SLUG = "env-slug";
    expect(githubBotLogins()).toContain("env-slug[bot]");
    expect(githubBotLogins()).not.toContain("config-slug[bot]");
  });

  test("resolves the slug from the env even with no config slug", () => {
    withConfig({ integrations: { github: {} } });
    process.env.OPENSESSION_GITHUB_APP_SLUG = "env-only";
    expect(githubBotLogins()).toContain("env-only[bot]");
  });

  test("no App slug configured contributes no App bot login", () => {
    withConfig({ integrations: { github: {} } });
    expect(githubBotLogins()).toEqual([]);
  });
});

describe("isGithubBotLogin", () => {
  test("matches any of our bot logins, not just the first", () => {
    withConfig({
      policy: { githubBotLogins: ["acme-automation"] },
      integrations: { github: { appSlug: "open-session-v6a6" } },
    });
    // Both the historical policy alias and current App bot are ours.
    expect(isGithubBotLogin("acme-automation")).toBe(true);
    expect(isGithubBotLogin("open-session-v6a6[bot]")).toBe(true);
    // Case-insensitive.
    expect(isGithubBotLogin("Open-Session-v6a6[bot]")).toBe(true);
    // A human is not ours.
    expect(isGithubBotLogin("some-human")).toBe(false);
    expect(isGithubBotLogin("")).toBe(false);
    expect(isGithubBotLogin(null)).toBe(false);
  });
});
