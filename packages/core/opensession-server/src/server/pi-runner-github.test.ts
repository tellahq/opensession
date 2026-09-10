import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GITHUB_RUN_AUTH_FILE_ENV } from "./github-auth";
import { AUTO_CONTINUE_USER, githubCredentialUser } from "./auto-continue";
import {
  githubCodeRunEnv,
  githubReadRunEnv,
  runGithubEnv,
  runGithubMergeGuard,
} from "./pi-runner";

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

describe("GitHub publication authority", () => {
  test("a connected person's code turn follows repository policy", () => {
    expect(
      runGithubMergeGuard({
        isCode: true,
        ownerLogin: "alex",
        baseBranch: "main",
      }),
    ).toBeUndefined();
  });

  test("ask and non-person code turns keep their protected branch guard", () => {
    for (const input of [
      { isCode: false, ownerLogin: "alex" },
      { isCode: false, ownerLogin: null },
      { isCode: true, ownerLogin: null },
    ]) {
      expect(
        runGithubMergeGuard({ ...input, baseBranch: "production" }),
      ).toEqual({ baseBranch: "production" });
    }
  });
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

      // The read-run variant holds the same boundary: an unavailable App
      // mint yields an empty credential with the SSH rewrite, never a
      // connected human's token.
      const readEnv = await githubReadRunEnv(cwd);
      expect(readEnv.GH_TOKEN).toBe("");
      expect(readEnv.GIT_CONFIG_VALUE_2).toBe("git@github.com:");
      expect(Object.values(readEnv)).not.toContain("human-token");
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

describe("which credential a run's shell holds", () => {
  // A registered repo with a connected person and no App: the App mint
  // fails closed to an empty token, so "human-token" versus "" tells the
  // two paths apart.
  function seed(dir: string): string {
    const cwd = join(dir, "repo");
    mkdirSync(cwd);
    const config = join(dir, "config.json");
    const users = join(dir, "github-users.json");
    writeFileSync(
      config,
      JSON.stringify({
        identity: {
          team: [
            { name: "Alice Example", github: "alice", aliases: ["Alice"] },
          ],
        },
        // Operator mode: identities resolve through the team table, so an
        // unmapped sender is nobody (simple mode would hand the sole
        // connected account to any human-started turn by design).
        integrations: {
          github: { userPrAuth: true, oauthClientId: "test-client-id" },
        },
        repos: {
          app: { repo: cwd, ghRepo: "tellahq/app", defaultBranch: "main" },
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
    return cwd;
  }

  test("a code turn a connected person started acts as them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-run-github-"));
    try {
      const cwd = seed(dir);
      const env = await runGithubEnv({
        isCode: true,
        ownerTurn: true,
        user: githubCredentialUser("Alice", "Alice Example"),
        githubKindRun: false,
        cwd,
      });
      expect(env.GH_TOKEN).toBe("human-token");
      expect(env.GITHUB_TOKEN).toBe("human-token");
      // HTTPS git goes through the same token; SSH remotes are rewritten so a
      // host key can never stand in.
      expect(env.GIT_CONFIG_VALUE_2).toBe("git@github.com:");
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      // An auto-continue of that person's prompt resolves the owner (#322).
      const nudged = await runGithubEnv({
        isCode: true,
        ownerTurn: true,
        user: githubCredentialUser(AUTO_CONTINUE_USER, "Alice Example"),
        githubKindRun: false,
        cwd,
      });
      expect(nudged.GH_TOKEN).toBe("human-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ask mode never holds a person's token, whoever started it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-run-github-"));
    try {
      const cwd = seed(dir);
      const env = await runGithubEnv({
        isCode: false,
        ownerTurn: true,
        user: "Alice",
        githubKindRun: true,
        launcherEnv: { GH_TOKEN: "launcher-token" },
        cwd,
      });
      // The App read set (unavailable here, so empty), not the person and
      // not a launcher-supplied token.
      expect(env.GH_TOKEN).toBe("");
      expect(Object.values(env)).not.toContain("human-token");
      expect(Object.values(env)).not.toContain("launcher-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("automations and machine senders hold the App token, not a person's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-run-github-"));
    try {
      const cwd = seed(dir);
      // An unattended run (ownerTurn is false for every unattended kind) and
      // a handoff or worker report into an interactive session (a machine
      // sender makes ownerTurn false) both fall through to the App code set.
      for (const user of [
        githubCredentialUser(undefined, "Nightly sweep"),
        githubCredentialUser("review-handoff", "Alice Example"),
      ]) {
        const env = await runGithubEnv({
          isCode: true,
          ownerTurn: false,
          user,
          githubKindRun: false,
          cwd,
        });
        expect(env.GH_TOKEN).toBe("");
        expect(Object.values(env)).not.toContain("human-token");
      }
      // A github-* code loop keeps its launcher-projected token.
      const loop = await runGithubEnv({
        isCode: true,
        ownerTurn: false,
        user: undefined,
        githubKindRun: true,
        launcherEnv: { GH_TOKEN: "launcher-token" },
        cwd,
      });
      expect(loop.GH_TOKEN).toBe("launcher-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a disconnected or unmapped person falls back to the App token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-run-github-"));
    try {
      const cwd = seed(dir);
      const unmapped = await runGithubEnv({
        isCode: true,
        ownerTurn: true,
        user: "Some Randomer",
        githubKindRun: false,
        cwd,
      });
      expect(unmapped.GH_TOKEN).toBe("");
      expect(Object.values(unmapped)).not.toContain("human-token");
      writeFileSync(
        process.env.OPENSESSION_GITHUB_AUTH_STORE!,
        JSON.stringify({ users: {} }),
      );
      const disconnected = await runGithubEnv({
        isCode: true,
        ownerTurn: true,
        user: "Alice",
        githubKindRun: false,
        cwd,
      });
      // Still a credential-shaped env: the SSH rewrite stays so a missing
      // token fails closed instead of reaching a host key.
      expect(disconnected.GH_TOKEN).toBe("");
      expect(disconnected.GIT_CONFIG_VALUE_2).toBe("git@github.com:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a remote host uses only its projected file, never the person store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-run-github-"));
    try {
      const cwd = seed(dir);
      const auth = join(dir, "github-auth.json");
      writeFileSync(auth, JSON.stringify({ GH_TOKEN: "projected-token" }));
      process.env[GITHUB_RUN_AUTH_FILE_ENV] = auth;
      const env = await runGithubEnv({
        isCode: true,
        ownerTurn: true,
        user: "Alice",
        githubKindRun: false,
        cwd,
      });
      expect(env.GH_TOKEN).toBe("projected-token");
      expect(Object.values(env)).not.toContain("human-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agent git identity", () => {
  const savedSlug = process.env.OPENSESSION_GITHUB_APP_SLUG;
  const savedFetch = globalThis.fetch;
  afterEach(() => {
    if (savedSlug === undefined) delete process.env.OPENSESSION_GITHUB_APP_SLUG;
    else process.env.OPENSESSION_GITHUB_APP_SLUG = savedSlug;
    globalThis.fetch = savedFetch;
  });

  test("never carries a person's git identity; the person is the co-author", async () => {
    const { agentGitIdentityEnv, GIT_COAUTHOR_ENV } =
      await import("./pi-runner");
    process.env.OPENSESSION_GITHUB_APP_SLUG = "example-app";
    globalThis.fetch = Object.assign(
      async () => {
        throw new Error("offline");
      },
      { preconnect: savedFetch.preconnect },
    );
    const env = await agentGitIdentityEnv({
      name: "Alice Example",
      email: "alice@example.com",
    });
    expect(env.GIT_AUTHOR_NAME).toBe("example-app[bot]");
    expect(env.GIT_COMMITTER_NAME).toBe("example-app[bot]");
    expect(env.GIT_AUTHOR_EMAIL).toBe(
      "example-app[bot]@users.noreply.github.com",
    );
    expect(env[GIT_COAUTHOR_ENV]).toBe("Alice Example <alice@example.com>");
    expect(JSON.stringify(env)).not.toContain('GIT_AUTHOR_NAME":"Alice');
  });

  test("without an App the bot identity is absent and git's own config decides", async () => {
    const { agentGitIdentityEnv, GIT_COAUTHOR_ENV } =
      await import("./pi-runner");
    delete process.env.OPENSESSION_GITHUB_APP_SLUG;
    process.env.OPENSESSION_CONFIG = "/nonexistent/config.json";
    const env = await agentGitIdentityEnv({ name: "Nightly sweep", email: "" });
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    // A label identity has no email and gets no trailer.
    expect(env[GIT_COAUTHOR_ENV]).toBeUndefined();
  });
});
