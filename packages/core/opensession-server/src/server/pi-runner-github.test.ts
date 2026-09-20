import { getConfigAsync } from "./config";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GITHUB_RUN_AUTH_FILE_ENV, githubRunOwnerLogin } from "./github-auth";
import { AUTO_CONTINUE_USER, githubCredentialUser } from "./auto-continue";
import { mergeGuardDenyReason } from "./command-policy";
import { humanPrompter } from "./session-actors";
import {
  githubCodeRunEnv,
  githubReadReposRunEnv,
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
        ownerTurn: true,
        ownerLogin: "alex",
        baseBranch: "main",
        sharedCheckout: false,
      }),
    ).toBeUndefined();
  });

  test("a person's shared-checkout code turn may push without personal GitHub authority", () => {
    const guard = runGithubMergeGuard({
      isCode: true,
      ownerTurn: true,
      ownerLogin: null,
      baseBranch: "main",
      sharedCheckout: true,
    });
    expect(guard).toEqual({});
    for (const command of [
      "git push origin main",
      "git push origin HEAD:main",
      "git push origin HEAD:refs/heads/main",
    ]) {
      expect(mergeGuardDenyReason(command, guard!)).toBeUndefined();
    }
    expect(mergeGuardDenyReason("gh pr merge 12", guard!)).toContain(
      "cannot merge",
    );
    expect(mergeGuardDenyReason("gh pr review 12 --approve", guard!)).toContain(
      "approving review",
    );
  });

  test("an unconnected person's worktree code turn still protects the base branch", () => {
    const guard = runGithubMergeGuard({
      isCode: true,
      ownerTurn: true,
      ownerLogin: null,
      baseBranch: "production",
      sharedCheckout: false,
    });
    expect(guard).toEqual({ baseBranch: "production" });
    expect(
      mergeGuardDenyReason("git push origin HEAD:production", guard!),
    ).toContain("protected base branch");
  });

  test.each([
    { sender: undefined, author: undefined },
    { sender: "", author: undefined },
    { sender: "   ", author: undefined },
    { sender: "anonymous", author: undefined },
    { sender: AUTO_CONTINUE_USER, author: undefined },
    { sender: AUTO_CONTINUE_USER, author: "   " },
    { sender: "GitHub", author: "Alex" },
  ])(
    "ownerless and machine turns keep protection: %j",
    ({ sender, author }) => {
      const githubUser = githubCredentialUser(sender, author);
      const ownerTurn = humanPrompter(githubUser) !== null;
      expect(ownerTurn).toBe(false);
      const guard = runGithubMergeGuard({
        isCode: true,
        ownerTurn,
        ownerLogin: null,
        baseBranch: "main",
        sharedCheckout: true,
      });
      expect(guard).toEqual({ baseBranch: "main" });
      expect(
        mergeGuardDenyReason("git push origin HEAD:main", guard!),
      ).toContain("protected base branch");
    },
  );

  test("a named owner's continuation retains the shared-checkout workflow", () => {
    const githubUser = githubCredentialUser(AUTO_CONTINUE_USER, "Alex");
    expect(humanPrompter(githubUser)).toBe("Alex");
    expect(
      runGithubMergeGuard({
        isCode: true,
        ownerTurn: humanPrompter(githubUser) !== null,
        ownerLogin: null,
        baseBranch: "main",
        sharedCheckout: true,
      }),
    ).toEqual({});
  });

  test("ask, unattended and machine turns keep protection in either checkout mode", () => {
    for (const sharedCheckout of [true, false]) {
      for (const input of [
        { isCode: false, ownerTurn: true, ownerLogin: "alex" },
        { isCode: false, ownerTurn: true, ownerLogin: null },
        { isCode: false, ownerTurn: false, ownerLogin: null },
        { isCode: true, ownerTurn: false, ownerLogin: null },
        { isCode: true, ownerTurn: false, ownerLogin: "alex" },
      ]) {
        expect(
          runGithubMergeGuard({
            ...input,
            sharedCheckout,
            baseBranch: "production",
          }),
        ).toEqual({ baseBranch: "production" });
      }
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
      await getConfigAsync();
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
      // No read token in the file means none in the shell, whatever the
      // run's automation lists: a remote host never mints on its own.
      const withReadRepos = await runGithubEnv({
        isCode: true,
        ownerTurn: false,
        githubKindRun: false,
        cwd: "/remote/unregistered/repo",
        readRepos: ["tellahq/api"],
      });
      expect(withReadRepos.GH_TOKEN).toBe("projected-service-token");
      expect(withReadRepos.GH_READ_TOKEN).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a projected read token rides beside the primary one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-projected-github-"));
    try {
      const auth = join(dir, "github-auth.json");
      writeFileSync(
        auth,
        JSON.stringify({
          GH_TOKEN: "projected-service-token",
          GH_READ_TOKEN: "projected-read-token",
        }),
      );
      process.env[GITHUB_RUN_AUTH_FILE_ENV] = auth;

      const env = await runGithubEnv({
        isCode: true,
        ownerTurn: false,
        githubKindRun: false,
        cwd: "/remote/unregistered/repo",
        readRepos: ["tellahq/api"],
      });
      expect(env.GH_TOKEN).toBe("projected-service-token");
      expect(env.GITHUB_TOKEN).toBe("projected-service-token");
      expect(env.GH_READ_TOKEN).toBe("projected-read-token");
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
  async function seed(dir: string): Promise<string> {
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
    await getConfigAsync();
    process.env.OPENSESSION_GITHUB_AUTH_STORE = users;
    delete process.env[GITHUB_RUN_AUTH_FILE_ENV];
    return cwd;
  }

  test("a code turn a connected person started acts as them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-run-github-"));
    try {
      const cwd = await seed(dir);
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

  test("a refused sibling-repository mint leaves the primary credential alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-run-github-"));
    try {
      const cwd = await seed(dir);
      // No App key here, so both mints fail closed: the run keeps the
      // (empty) repository-scoped credential and its git wiring, and simply
      // has no GH_READ_TOKEN rather than a wider or a person's token.
      const env = await runGithubEnv({
        isCode: true,
        ownerTurn: false,
        githubKindRun: false,
        cwd,
        readRepos: ["tellahq/api", "tellahq/web"],
      });
      expect(env.GH_TOKEN).toBe("");
      expect(env.GH_READ_TOKEN).toBeUndefined();
      expect(env.GIT_CONFIG_VALUE_2).toBe("git@github.com:");
      expect(Object.values(env)).not.toContain("human-token");
      expect(await githubReadReposRunEnv(cwd, undefined)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ask mode never holds a person's token, whoever started it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-run-github-"));
    try {
      const cwd = await seed(dir);
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
      const cwd = await seed(dir);
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
      const cwd = await seed(dir);
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
      const cwd = await seed(dir);
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

  test("a sandboxed owner turn drops the merge guard only for a projected person token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-run-github-"));
    try {
      await seed(dir);
      const guard = (ownerTurn: boolean) =>
        runGithubMergeGuard({
          isCode: true,
          ownerTurn,
          ownerLogin: ownerTurn ? githubRunOwnerLogin("Alice") : null,
          baseBranch: "main",
          sharedCheckout: false,
        });
      const auth = join(dir, "github-auth.json");
      process.env[GITHUB_RUN_AUTH_FILE_ENV] = auth;
      // The launcher projected Alice's token and named her: the same
      // repository-policy outcome as her turn on the host.
      writeFileSync(
        auth,
        JSON.stringify({ GH_TOKEN: "projected-token", login: "alice" }),
      );
      expect(guard(true)).toBeUndefined();
      // A machine sender's turn in that sandbox keeps the guard regardless.
      expect(guard(false)).toEqual({ baseBranch: "main" });
      // An App projection has no login: guarded, even with a readable store
      // that says Alice is connected.
      writeFileSync(auth, JSON.stringify({ GH_TOKEN: "projected-token" }));
      expect(guard(true)).toEqual({ baseBranch: "main" });
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
    await getConfigAsync();
    const env = await agentGitIdentityEnv({ name: "Nightly sweep", email: "" });
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    // A label identity has no email and gets no trailer.
    expect(env[GIT_COAUTHOR_ENV]).toBeUndefined();
  });
});
