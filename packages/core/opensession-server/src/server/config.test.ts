import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getConfig,
  getConfigAsync,
  configuredRepos,
  configuredPaths,
  configuredServer,
  configuredIdentity,
  configPath,
  defaultRepo,
  personaName,
  organizationName,
  productName,
  productMark,
  updateIdentityConfig,
} from "./config";
import { reviewTeamDirectory } from "./people";

// Each case writes a fresh config namespace and awaits its snapshot.
const ENV_KEYS = [
  "OPENSESSION_CONFIG",
  "OPENSESSION_WORKTREES_DIR",
  "OPENSESSION_CLAUDE_BIN",
  "OPENSESSION_PI_BIN",
  "OPENSESSION_MCP_CONFIG",
  "OPENSESSION_UI_BASE",
  "OPENSESSION_INGRESS_BASE",
  "PREVIEW_HOST",
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

const dirs: string[] = [];
async function withConfig(contents: string | null): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "bks-config-test-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  if (contents !== null) writeFileSync(path, contents);
  process.env.OPENSESSION_CONFIG = path;
  await getConfigAsync();
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("config loader", () => {
  test("async snapshots preserve defaults and observe config replacement", async () => {
    await withConfig(
      JSON.stringify({ repos: { alpha: { repo: "/alpha", default: true } } }),
    );
    expect(defaultRepo(configuredRepos(await getConfigAsync())).id).toBe(
      "alpha",
    );
    await withConfig(
      JSON.stringify({ repos: { beta: { repo: "/beta", default: true } } }),
    );
    expect(defaultRepo(configuredRepos(await getConfigAsync())).id).toBe(
      "beta",
    );
    await withConfig(null);
    expect(await getConfigAsync()).toEqual({});
    expect(defaultRepo(configuredRepos(await getConfigAsync())).id).toBe(
      "opensession",
    );
  });

  test("supports one canonical public ingress origin", async () => {
    await withConfig(
      JSON.stringify({
        server: { publicBaseUrl: "https://ui.example.test" },
        ingress: {
          publicBaseUrl: "https://ingress.example.test",
          exposure: "custom",
        },
      }),
    );
    delete process.env.OPENSESSION_UI_BASE;
    delete process.env.OPENSESSION_INGRESS_BASE;

    expect(configuredServer().publicBaseUrl).toBe("https://ui.example.test");
    expect(configuredServer().webhookBaseUrl).toBe(
      "https://ingress.example.test",
    );

    process.env.OPENSESSION_INGRESS_BASE = "https://env-ingress.example.test";
    expect(configuredServer().webhookBaseUrl).toBe(
      "https://env-ingress.example.test",
    );
  });

  test("keeps an unconfigured ingress distinct while setup remains portable", async () => {
    await withConfig(
      JSON.stringify({ server: { publicBaseUrl: "https://ui.example.test" } }),
    );
    delete process.env.OPENSESSION_UI_BASE;
    delete process.env.OPENSESSION_INGRESS_BASE;

    expect(configuredServer().webhookBaseUrl).toBe("https://ui.example.test");
  });

  test("defaults preview portals to the public UI hostname", async () => {
    await withConfig(
      JSON.stringify({ server: { publicBaseUrl: "https://os.example.test" } }),
    );
    delete process.env.OPENSESSION_UI_BASE;
    delete process.env.PREVIEW_HOST;
    expect(configuredServer().previewHost).toBe("os.example.test");
  });

  test("no file → portable self-repo defaults", async () => {
    await withConfig(null); // path exists as a dir entry that was never written
    for (const k of ENV_KEYS.slice(1)) delete process.env[k];

    expect(getConfig()).toEqual({});

    const repos = configuredRepos();
    expect(Object.keys(repos)).toEqual(["opensession"]);
    expect(repos.opensession).toMatchObject({
      id: "opensession",
      label: "Open Session",
      wtPrefix: "opensession",
      defaultBranch: "main",
      ghRepo: "",
      sharedCheckout: true,
      default: true,
    });
    expect(defaultRepo().id).toBe("opensession");

    const paths = configuredPaths();
    expect(paths.claudeBin).toBe(Bun.which("claude") || "claude");
    expect(paths.worktreesDir).toBe(
      `${process.env.HOME}/.opensession/worktrees`,
    );

    const identity = configuredIdentity();
    expect(identity).toEqual({
      team: [],
      reviewTeams: [],
      slackNames: {},
      defaultTimezone: "UTC",
    });

    expect(configuredServer().caddyAdmin).toBe("http://localhost:2019");
  });

  test("repos section is authoritative and applies id-derived defaults", async () => {
    await withConfig(
      JSON.stringify({
        paths: { worktreesDir: "/srv/worktrees" },
        repos: {
          "acme-app": {
            repo: "/srv/acme-app",
            default: true,
            label: "Acme App",
            deploymentTracking: true,
            warmCachePaths: ["dist/client.js"],
            securityInstructions: "Read SECURITY.md.",
          },
        },
      }),
    );
    for (const k of ENV_KEYS.slice(1)) delete process.env[k];

    const repos = configuredRepos();
    expect(repos["acme-app"]).toEqual({
      id: "acme-app",
      label: "Acme App",
      repo: "/srv/acme-app",
      wtPrefix: "acme-app",
      defaultBranch: "main",
      ghRepo: "",
      default: true,
      deploymentTracking: true,
      warmCachePaths: ["dist/client.js"],
      securityInstructions: "Read SECURITY.md.",
    });
    expect(repos.opensession).toBeUndefined();
    expect(defaultRepo().id).toBe("acme-app");
    expect(configuredPaths().worktreesDir).toBe("/srv/worktrees");
  });

  test("publication mode is per repo and independent of checkout isolation", async () => {
    await withConfig(
      JSON.stringify({
        selfDev: "worktree",
        repos: {
          direct: {
            repo: "/srv/direct",
            sharedCheckout: true,
            publicationMode: "direct",
          },
          explicit: { repo: "/srv/explicit", publicationMode: "pull-request" },
          normal: { repo: "/srv/normal" },
          invalid: { repo: "/srv/invalid", publicationMode: "force" },
        },
      }),
    );
    const repos = configuredRepos();
    expect(repos.direct.publicationMode).toBe("direct");
    expect(repos.direct.sharedCheckout).toBe(true);
    expect(repos.explicit.publicationMode).toBe("pull-request");
    expect(repos.normal.publicationMode).toBeUndefined();
    expect(repos.invalid.publicationMode).toBeUndefined();
  });

  test("unsafe default branch text falls back before reaching prompts", async () => {
    await withConfig(
      JSON.stringify({
        repos: {
          app: {
            repo: "/srv/app",
            defaultBranch: "main;echo-not-a-command",
            default: true,
          },
        },
      }),
    );
    expect(configuredRepos().app.defaultBranch).toBe("main");
  });

  test("repo entry without a checkout path is ignored", async () => {
    await withConfig(
      JSON.stringify({ repos: { phantom: { ghRepo: "acme/phantom" } } }),
    );
    expect(configuredRepos()["phantom"]).toBeUndefined();
  });

  test("malformed file → defaults", async () => {
    await withConfig("{ this is not json");
    for (const k of ENV_KEYS.slice(1)) delete process.env[k];
    expect(getConfig()).toEqual({});
    expect(defaultRepo().id).toBe("opensession");
    expect(configuredIdentity().team).toEqual([]);
  });

  test("non-object JSON → defaults", async () => {
    await withConfig(JSON.stringify(["not", "an", "object"]));
    expect(getConfig()).toEqual({});
  });

  test("env vars beat config.json per key", async () => {
    await withConfig(
      JSON.stringify({
        paths: {
          worktreesDir: "/from-config/worktrees",
          claudeBin: "/from-config/claude",
        },
        repos: { app: { repo: "/from-config/app" } },
      }),
    );
    process.env.OPENSESSION_WORKTREES_DIR = "/from-env/worktrees";
    process.env.OPENSESSION_CLAUDE_BIN = "/from-env/claude";

    expect(configuredPaths().worktreesDir).toBe("/from-env/worktrees");
    expect(configuredPaths().claudeBin).toBe("/from-env/claude");
    expect(configuredRepos().app.repo).toBe("/from-config/app");

    // …and the config value applies once the env var is gone.
    delete process.env.OPENSESSION_WORKTREES_DIR;
    expect(configuredPaths().worktreesDir).toBe("/from-config/worktrees");
    expect(configuredRepos().app.repo).toBe("/from-config/app");
  });

  test("identity: section present with empty team → empty tables, no throws", async () => {
    await withConfig(JSON.stringify({ identity: { team: [] } }));
    const identity = configuredIdentity();
    expect(identity.team).toEqual([]);
    expect(identity.slackNames).toEqual({});
  });

  test("persona/branding: defaults with no config file", async () => {
    await withConfig(null);
    expect(personaName()).toBe("Assistant");
    expect(productName()).toBe("Open Session");
    expect(productMark()).toBe("Open Session");
  });

  test("persona/branding: config overrides apply", async () => {
    await withConfig(
      JSON.stringify({
        persona: { name: "Ava" },
        branding: { productName: "OpenSession", productMark: "OS" },
      }),
    );
    expect(personaName()).toBe("Ava");
    expect(productName()).toBe("OpenSession");
    expect(productMark()).toBe("OS");
  });

  test("branding: productMark falls back to productName", async () => {
    await withConfig(
      JSON.stringify({ branding: { productName: "OpenSession" } }),
    );
    expect(productMark()).toBe("OpenSession");
    // Empty/whitespace strings are treated as unset, not honored.
    await withConfig(
      JSON.stringify({
        persona: { name: "  " },
        branding: { productName: "" },
      }),
    );
    expect(personaName()).toBe("Assistant");
    expect(productName()).toBe("Open Session");
  });

  test("organization: name falls back to the product name", async () => {
    await withConfig(
      JSON.stringify({ branding: { productName: "OpenSession" } }),
    );
    expect(organizationName()).toBe("OpenSession");

    await withConfig(JSON.stringify({ organization: { name: "Acme" } }));
    expect(organizationName()).toBe("Acme");
  });

  test("identity: custom roster is parsed and validated", async () => {
    await withConfig(
      JSON.stringify({
        identity: {
          team: [
            {
              name: "Ada Lovelace",
              email: "ada@acme.dev",
              github: "ada",
              slackId: "U111",
              aliases: ["ada"],
            },
            { notAName: true }, // invalid — dropped
          ],
          reviewTeams: [
            {
              name: "Platform reviewers",
              github: "acme/platform-reviewers",
              members: ["Ada", "Grace"],
            },
            { name: "Invalid", github: "not-a-team", members: ["Ada"] },
          ],
          slackNames: { U222: "Bot", U333: 42 }, // non-string values dropped
        },
      }),
    );
    const identity = configuredIdentity();
    expect(identity.team).toEqual([
      {
        name: "Ada Lovelace",
        email: "ada@acme.dev",
        github: "ada",
        slackId: "U111",
        aliases: ["ada"],
      },
    ]);
    expect(identity.reviewTeams).toEqual([
      {
        name: "Platform reviewers",
        github: "acme/platform-reviewers",
        members: ["Ada", "Grace"],
      },
    ]);
    expect(reviewTeamDirectory()).toEqual([
      {
        name: "Platform reviewers",
        github: "acme/platform-reviewers",
        members: ["Ada"],
      },
    ]);
    expect(identity.slackNames).toEqual({ U222: "Bot" });
  });

  test("updateIdentityConfig: writes names, preserves unknown keys, empty resets", async () => {
    await withConfig(
      JSON.stringify({
        server: { port: 4000 },
        persona: { name: "Old", company: "Acme" },
        futureSection: { keep: true },
      }),
    );
    updateIdentityConfig({ personaName: " Ava ", productName: "OS¹" });
    expect(personaName()).toBe("Ava");
    expect(productName()).toBe("OS¹");
    const raw = JSON.parse(readFileSync(configPath(), "utf-8"));
    // Untouched keys — modeled and unmodeled alike — survive the write.
    expect(raw.server).toEqual({ port: 4000 });
    expect(raw.persona.company).toBe("Acme");
    expect(raw.futureSection).toEqual({ keep: true });

    // Empty string deletes the key; an emptied section disappears entirely.
    updateIdentityConfig({ personaName: "", productName: "" });
    expect(personaName()).toBe("Assistant");
    expect(productName()).toBe("Open Session");
    expect(
      JSON.parse(readFileSync(configPath(), "utf-8")).branding,
    ).toBeUndefined();
  });

  test("updateIdentityConfig: creates a missing file, refuses a corrupt one", async () => {
    await withConfig(null);
    updateIdentityConfig({ productName: "Fresh" });
    expect(productName()).toBe("Fresh");

    await withConfig("{ not json");
    expect(() => updateIdentityConfig({ personaName: "X" })).toThrow();
    // The broken hand-edited file is left untouched.
    expect(readFileSync(configPath(), "utf-8")).toBe("{ not json");
  });
});
