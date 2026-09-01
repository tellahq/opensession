import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getConfig,
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

// Each case writes its config to a fresh path (the loader caches by
// path+mtime) and points OPENSESSION_CONFIG at it.
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
function withConfig(contents: string | null): void {
  const dir = mkdtempSync(join(tmpdir(), "bks-config-test-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  if (contents !== null) writeFileSync(path, contents);
  process.env.OPENSESSION_CONFIG = path;
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
  test("supports one canonical public ingress origin", () => {
    withConfig(
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

  test("keeps an unconfigured ingress distinct while setup remains portable", () => {
    withConfig(
      JSON.stringify({ server: { publicBaseUrl: "https://ui.example.test" } }),
    );
    delete process.env.OPENSESSION_UI_BASE;
    delete process.env.OPENSESSION_INGRESS_BASE;

    expect(configuredServer().webhookBaseUrl).toBe("https://ui.example.test");
  });

  test("defaults preview portals to the public UI hostname", () => {
    withConfig(
      JSON.stringify({ server: { publicBaseUrl: "https://os.example.test" } }),
    );
    delete process.env.OPENSESSION_UI_BASE;
    delete process.env.PREVIEW_HOST;
    expect(configuredServer().previewHost).toBe("os.example.test");
  });

  test("no file → portable self-repo defaults", () => {
    withConfig(null); // path exists as a dir entry that was never written
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

  test("repos section is authoritative and applies id-derived defaults", () => {
    withConfig(
      JSON.stringify({
        paths: { worktreesDir: "/srv/worktrees" },
        repos: {
          "acme-app": {
            repo: "/srv/acme-app",
            default: true,
            label: "Acme App",
            deploymentTracking: true,
            warmCachePaths: ["dist/client.js"],
            previewAwsProfile: "acme-dev",
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
      previewAwsProfile: "acme-dev",
      securityInstructions: "Read SECURITY.md.",
    });
    expect(repos.opensession).toBeUndefined();
    expect(defaultRepo().id).toBe("acme-app");
    expect(configuredPaths().worktreesDir).toBe("/srv/worktrees");
  });

  test("unsafe default branch text falls back before reaching prompts", () => {
    withConfig(
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

  test("repo entry without a checkout path is ignored", () => {
    withConfig(
      JSON.stringify({ repos: { phantom: { ghRepo: "acme/phantom" } } }),
    );
    expect(configuredRepos()["phantom"]).toBeUndefined();
  });

  test("malformed file → defaults", () => {
    withConfig("{ this is not json");
    for (const k of ENV_KEYS.slice(1)) delete process.env[k];
    expect(getConfig()).toEqual({});
    expect(defaultRepo().id).toBe("opensession");
    expect(configuredIdentity().team).toEqual([]);
  });

  test("non-object JSON → defaults", () => {
    withConfig(JSON.stringify(["not", "an", "object"]));
    expect(getConfig()).toEqual({});
  });

  test("env vars beat config.json per key", () => {
    withConfig(
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

  test("identity: section present with empty team → empty tables, no throws", () => {
    withConfig(JSON.stringify({ identity: { team: [] } }));
    const identity = configuredIdentity();
    expect(identity.team).toEqual([]);
    expect(identity.slackNames).toEqual({});
  });

  test("persona/branding: defaults with no config file", () => {
    withConfig(null);
    expect(personaName()).toBe("Assistant");
    expect(productName()).toBe("Open Session");
    expect(productMark()).toBe("Open Session");
  });

  test("persona/branding: config overrides apply", () => {
    withConfig(
      JSON.stringify({
        persona: { name: "Ava" },
        branding: { productName: "OpenSession", productMark: "OS" },
      }),
    );
    expect(personaName()).toBe("Ava");
    expect(productName()).toBe("OpenSession");
    expect(productMark()).toBe("OS");
  });

  test("branding: productMark falls back to productName", () => {
    withConfig(JSON.stringify({ branding: { productName: "OpenSession" } }));
    expect(productMark()).toBe("OpenSession");
    // Empty/whitespace strings are treated as unset, not honored.
    withConfig(
      JSON.stringify({
        persona: { name: "  " },
        branding: { productName: "" },
      }),
    );
    expect(personaName()).toBe("Assistant");
    expect(productName()).toBe("Open Session");
  });

  test("organization: name falls back to the product name", () => {
    withConfig(JSON.stringify({ branding: { productName: "OpenSession" } }));
    expect(organizationName()).toBe("OpenSession");

    withConfig(JSON.stringify({ organization: { name: "Acme" } }));
    expect(organizationName()).toBe("Acme");
  });

  test("identity: custom roster is parsed and validated", () => {
    withConfig(
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

  test("updateIdentityConfig: writes names, preserves unknown keys, empty resets", () => {
    withConfig(
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

  test("updateIdentityConfig: creates a missing file, refuses a corrupt one", () => {
    withConfig(null);
    updateIdentityConfig({ productName: "Fresh" });
    expect(productName()).toBe("Fresh");

    withConfig("{ not json");
    expect(() => updateIdentityConfig({ personaName: "X" })).toThrow();
    // The broken hand-edited file is left untouched.
    expect(readFileSync(configPath(), "utf-8")).toBe("{ not json");
  });
});
