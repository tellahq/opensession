import { $ } from "bun";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { createWorktree } from "../worktree";
import {
  adoptExistingCheckout,
  githubCredentialHelperCommand,
  handleSetupRepoRoutes,
  matchesCodeStorageCheckout,
  normalizeDefaultBranch,
  validGithubFullName,
  listReposViaAppInstallation,
} from "./setup-repos";
import type { RouteContext } from "./context";

const originalConfig = process.env.OPENSESSION_CONFIG;
const tempDirs: string[] = [];

function createGitRepo(dir: string): string {
  const repo = join(dir, "repo");
  const remote = join(dir, "remote.git");
  expect(
    Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]).exitCode,
  ).toBe(0);
  writeFileSync(join(repo, "README.md"), "test\n");
  expect(Bun.spawnSync(["git", "-C", repo, "add", "README.md"]).exitCode).toBe(
    0,
  );
  expect(
    Bun.spawnSync([
      "git",
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "-m",
      "initial",
    ]).exitCode,
  ).toBe(0);
  expect(Bun.spawnSync(["git", "-C", repo, "branch", "master"]).exitCode).toBe(
    0,
  );
  expect(Bun.spawnSync(["git", "init", "-q", "--bare", remote]).exitCode).toBe(
    0,
  );
  expect(
    Bun.spawnSync(["git", "-C", repo, "remote", "add", "origin", remote])
      .exitCode,
  ).toBe(0);
  expect(
    Bun.spawnSync([
      "git",
      "-C",
      repo,
      "push",
      "-q",
      "-u",
      "origin",
      "main",
      "master",
    ]).exitCode,
  ).toBe(0);
  return repo;
}

afterEach(() => {
  if (originalConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = originalConfig;
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("validGithubFullName", () => {
  test("accepts ordinary owner/name pairs", () => {
    expect(validGithubFullName("tellahq/tella-fusion")).toBe(true);
    expect(validGithubFullName("owner/repo.name")).toBe(true);
    expect(validGithubFullName("o-w_n.er/re-po_1")).toBe(true);
  });

  test("rejects non-strings and empty parts", () => {
    expect(validGithubFullName(undefined)).toBe(false);
    expect(validGithubFullName(null)).toBe(false);
    expect(validGithubFullName(42)).toBe(false);
    expect(validGithubFullName("")).toBe(false);
    expect(validGithubFullName("owner/")).toBe(false);
    expect(validGithubFullName("/repo")).toBe(false);
    expect(validGithubFullName("just-a-name")).toBe(false);
  });

  test("rejects extra path segments and traversal", () => {
    expect(validGithubFullName("a/b/c")).toBe(false);
    expect(validGithubFullName("../etc/passwd")).toBe(false);
    expect(validGithubFullName("owner/..%2Fescape")).toBe(false);
  });

  test("rejects shell- and URL-meaningful characters", () => {
    expect(validGithubFullName("owner/repo;rm -rf /")).toBe(false);
    expect(validGithubFullName("owner/repo$(id)")).toBe(false);
    expect(validGithubFullName("owner/repo name")).toBe(false);
    expect(validGithubFullName("owner/repo\n")).toBe(false);
    expect(validGithubFullName("https://github.com/owner/repo")).toBe(false);
    expect(validGithubFullName("owner/repo?x=1")).toBe(false);
    expect(validGithubFullName("owner/repo#frag")).toBe(false);
    // The clone receives the full https URL through an argv array, so a
    // hyphen-prefixed owner cannot become a command flag.
    expect(validGithubFullName("--flag/repo")).toBe(true);
  });
});

describe("App installation repository listing", () => {
  test("uses the installation endpoint rather than a user endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json({
        repositories: [
          {
            full_name: "tellahq/opensession",
            private: true,
            default_branch: "main",
            pushed_at: "2026-08-24T00:00:00Z",
          },
        ],
      });
    }) as typeof fetch;
    try {
      const repos = await listReposViaAppInstallation("ghs_installation");
      expect(repos.map((repo) => repo.fullName)).toEqual([
        "tellahq/opensession",
      ]);
      expect(urls).toEqual([
        "https://api.github.com/installation/repositories?per_page=100&page=1",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("githubCredentialHelperCommand", () => {
  test("uses the stable installed command for compiled releases", () => {
    expect(
      githubCredentialHelperCommand(
        "/home/alice/Open Session/bin/opensession",
        true,
      ),
    ).toBe("!'/home/alice/Open Session/bin/opensession' github-credential");
  });

  test("falls back to the source script before the shim is installed", () => {
    const command = githubCredentialHelperCommand(
      "/missing/opensession",
      false,
    );
    expect(command).toStartWith("!bun ");
    expect(command).toEndWith("scripts/gh-credential.ts");
  });
});

describe("normalizeDefaultBranch", () => {
  test("accepts ordinary and nested branch names", async () => {
    await expect(normalizeDefaultBranch("master")).resolves.toBe("master");
    await expect(normalizeDefaultBranch(" release/12.x ")).resolves.toBe(
      "release/12.x",
    );
  });

  test("rejects values git cannot use as branch names", async () => {
    await expect(normalizeDefaultBranch(undefined)).resolves.toBeNull();
    await expect(normalizeDefaultBranch(" ")).resolves.toBeNull();
    await expect(normalizeDefaultBranch("bad branch")).resolves.toBeNull();
    await expect(normalizeDefaultBranch("feature..next")).resolves.toBeNull();
    await expect(normalizeDefaultBranch("-dangerous")).resolves.toBeNull();
  });

  test("rejects git-valid shell and Markdown metacharacters", async () => {
    await expect(
      normalizeDefaultBranch("release;echo-not-a-command"),
    ).resolves.toBeNull();
    await expect(normalizeDefaultBranch("release`whoami`")).resolves.toBeNull();
    await expect(
      normalizeDefaultBranch("release$(whoami)"),
    ).resolves.toBeNull();
  });
});

describe("repository default branch settings", () => {
  test("updates only the selected repo config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-repo-config-"));
    tempDirs.push(dir);
    const path = join(dir, "config.json");
    const repo = createGitRepo(dir);
    process.env.OPENSESSION_CONFIG = path;
    writeFileSync(
      path,
      JSON.stringify({
        repos: {
          "compiler:legacy": {
            label: "Compiler",
            repo,
            defaultBranch: "main",
            customSetting: "preserved",
          },
        },
      }),
    );

    const url = new URL("http://localhost/api/setup/repos/compiler%3Alegacy");
    const response = await handleSetupRepoRoutes({
      req: new Request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultBranch: "master" }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      id: "compiler:legacy",
      defaultBranch: "master",
      isolatedWorktrees: true,
    });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.repos["compiler:legacy"].defaultBranch).toBe("master");
    expect(saved.repos["compiler:legacy"].customSetting).toBe("preserved");
  });

  test("updates worktree isolation only for the selected repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-repo-config-"));
    tempDirs.push(dir);
    const path = join(dir, "config.json");
    const repo = createGitRepo(dir);
    process.env.OPENSESSION_CONFIG = path;
    writeFileSync(
      path,
      JSON.stringify({
        repos: {
          compiler: {
            repo,
            defaultBranch: "main",
            sharedCheckout: true,
            customSetting: "preserved",
          },
          docs: {
            repo: join(dir, "docs"),
            defaultBranch: "main",
            sharedCheckout: true,
          },
        },
      }),
    );

    const url = new URL("http://localhost/api/setup/repos/compiler");
    const response = await handleSetupRepoRoutes({
      req: new Request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isolatedWorktrees: true }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      id: "compiler",
      defaultBranch: "main",
      isolatedWorktrees: true,
    });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.repos.compiler.sharedCheckout).toBe(false);
    expect(saved.repos.compiler.customSetting).toBe("preserved");
    expect(saved.repos.docs.sharedCheckout).toBe(true);
  });

  test("migrates the legacy global override without changing other repos", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-repo-config-"));
    tempDirs.push(dir);
    const path = join(dir, "config.json");
    const repo = createGitRepo(dir);
    process.env.OPENSESSION_CONFIG = path;
    writeFileSync(
      path,
      JSON.stringify({
        selfDev: "worktree",
        repos: {
          app: { repo, defaultBranch: "main", sharedCheckout: true },
          docs: {
            repo: join(dir, "docs"),
            defaultBranch: "main",
            sharedCheckout: true,
          },
        },
      }),
    );

    const url = new URL("http://localhost/api/setup/repos/app");
    const response = await handleSetupRepoRoutes({
      req: new Request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isolatedWorktrees: false }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });

    expect(response?.status).toBe(200);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.selfDev).toBeUndefined();
    expect(saved.repos.app.sharedCheckout).toBe(true);
    expect(saved.repos.docs.sharedCheckout).toBe(false);
  });

  test("rejects a non-boolean worktree setting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-repo-config-"));
    tempDirs.push(dir);
    const path = join(dir, "config.json");
    const repo = createGitRepo(dir);
    process.env.OPENSESSION_CONFIG = path;
    writeFileSync(
      path,
      JSON.stringify({ repos: { app: { repo, defaultBranch: "main" } } }),
    );

    const url = new URL("http://localhost/api/setup/repos/app");
    const response = await handleSetupRepoRoutes({
      req: new Request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isolatedWorktrees: "yes" }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });

    expect(response?.status).toBe(400);
    expect(
      JSON.parse(readFileSync(path, "utf8")).repos.app.sharedCheckout,
    ).toBeUndefined();
  });

  test("rejects a branch that does not exist without changing config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-repo-config-"));
    tempDirs.push(dir);
    const path = join(dir, "config.json");
    const repo = createGitRepo(dir);
    process.env.OPENSESSION_CONFIG = path;
    writeFileSync(
      path,
      JSON.stringify({ repos: { compiler: { repo, defaultBranch: "main" } } }),
    );

    const url = new URL("http://localhost/api/setup/repos/compiler");
    const response = await handleSetupRepoRoutes({
      req: new Request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultBranch: "missing" }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });

    expect(response?.status).toBe(400);
    expect(
      JSON.parse(readFileSync(path, "utf8")).repos.compiler.defaultBranch,
    ).toBe("main");
  });

  test("rejects prototype-special repository ids", async () => {
    const url = new URL("http://localhost/api/setup/repos/__proto__");
    const response = await handleSetupRepoRoutes({
      req: new Request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultBranch: "main" }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });

    expect(response?.status).toBe(400);
    expect(Object.prototype).not.toHaveProperty("defaultBranch");
  });

  test("rejects a shared checkout branch that is not currently checked out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-repo-config-"));
    tempDirs.push(dir);
    const path = join(dir, "config.json");
    const repo = createGitRepo(dir);
    process.env.OPENSESSION_CONFIG = path;
    writeFileSync(
      path,
      JSON.stringify({
        repos: {
          app: { repo, defaultBranch: "main", sharedCheckout: true },
        },
      }),
    );

    const url = new URL("http://localhost/api/setup/repos/app");
    const response = await handleSetupRepoRoutes({
      req: new Request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultBranch: "master" }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });

    expect(response?.status).toBe(400);
    expect(JSON.parse(readFileSync(path, "utf8")).repos.app.defaultBranch).toBe(
      "main",
    );
  });
});

describe("adoptExistingCheckout", () => {
  const roots: string[] = [];
  const tmpRoot = () => {
    const dir = mkdtempSync(join(tmpdir(), "os-adopt-"));
    roots.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  });

  async function makeCheckout(dir: string, origin: string): Promise<string> {
    mkdirSync(dir, { recursive: true });
    await $`git -C ${dir} init -q -b main`.quiet();
    await $`git -C ${dir} remote add origin ${origin}`.quiet();
    await $`git -C ${dir} -c user.email=t@e -c user.name=t commit -q --allow-empty -m init`.quiet();
    await $`git -C ${dir} update-ref refs/remotes/origin/main HEAD`.quiet();
    await $`git -C ${dir} symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main`.quiet();
    return dir;
  }

  test("returns null when nothing is at the destination", async () => {
    expect(
      await adoptExistingCheckout(join(tmpRoot(), "absent"), () => true),
    ).toBe(null);
  });

  test("adopts a checkout of the same repo (no token needed)", async () => {
    const dest = await makeCheckout(
      join(tmpRoot(), "widget"),
      "https://github.com/acme/widget.git",
    );
    const adopted = await adoptExistingCheckout(
      dest,
      (i) => (i.ghRepo || "").toLowerCase() === "acme/widget",
    );
    expect(adopted?.ghRepo).toBe("acme/widget");
    expect(adopted?.defaultBranch).toBe("main");
  });

  test("only adopts a code.storage checkout from the configured organization", async () => {
    const dest = await makeCheckout(
      join(tmpRoot(), "widget"),
      "https://old-org.code.storage/acme/widget.git",
    );
    const inspected = await adoptExistingCheckout(dest, (i) =>
      matchesCodeStorageCheckout(i, "old-org", "acme/widget"),
    );
    expect(inspected?.cs).toEqual({ org: "old-org", repoId: "acme/widget" });
    expect(
      adoptExistingCheckout(dest, (i) =>
        matchesCodeStorageCheckout(i, "new-org", "acme/widget"),
      ),
    ).rejects.toThrow(/Clone destination already exists/);
  });

  test("refuses a checkout of a different repo", async () => {
    const dest = await makeCheckout(
      join(tmpRoot(), "widget"),
      "https://github.com/acme/other.git",
    );
    expect(
      adoptExistingCheckout(
        dest,
        (i) => (i.ghRepo || "").toLowerCase() === "acme/widget",
      ),
    ).rejects.toThrow(/Clone destination already exists/);
  });

  test("refuses a non-git directory at the destination", async () => {
    const dest = join(tmpRoot(), "widget");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "notes.txt"), "hi");
    expect(adoptExistingCheckout(dest, () => true)).rejects.toThrow(
      /Clone destination already exists/,
    );
  });
});

const savedConfig = process.env.OPENSESSION_CONFIG;
const savedWorktreesDir = process.env.OPENSESSION_WORKTREES_DIR;
const savedHome = process.env.HOME;
const localRoots: string[] = [];

afterEach(() => {
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = savedConfig;
  if (savedWorktreesDir === undefined)
    delete process.env.OPENSESSION_WORKTREES_DIR;
  else process.env.OPENSESSION_WORKTREES_DIR = savedWorktreesDir;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  for (const dir of localRoots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function localRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "opensession-local-repo-"));
  localRoots.push(root);
  return root;
}

function gitRaw(args: string[], cwd?: string): string {
  const result = Bun.spawnSync(["git", ...args], {
    ...(cwd ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.toString();
}

function git(args: string[], cwd?: string): string {
  return gitRaw(args, cwd).trim();
}

function createRemoteCheckout(
  root: string,
  name = "existing-checkout",
  defaultBranch = "trunk",
): string {
  const remote = join(root, `${name}.git`);
  const checkout = join(root, name);
  git(["init", "--bare", "-b", defaultBranch, remote]);
  git(["init", "-b", defaultBranch, checkout]);
  git(["config", "user.name", "Open Session test"], checkout);
  git(["config", "user.email", "test@opensession.dev"], checkout);
  writeFileSync(join(checkout, "README.md"), `${name}\n`);
  git(["add", "README.md"], checkout);
  git(["commit", "-m", "Initial commit"], checkout);
  git(["remote", "add", "origin", remote], checkout);
  git(["push", "-u", "origin", defaultBranch], checkout);
  git(["remote", "set-head", "origin", defaultBranch], checkout);
  return checkout;
}

function postRepo(body: unknown): RouteContext {
  const url = new URL("http://localhost/api/setup/repos");
  return {
    req: new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    url,
    path: url.pathname,
    publicPrefix: "",
  };
}

describe("local repository registration", () => {
  test.serial("registers a usable checkout without cloning it", async () => {
    const root = localRoot();
    const checkout = createRemoteCheckout(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ repos: {} }));
    process.env.OPENSESSION_CONFIG = configPath;
    process.env.OPENSESSION_WORKTREES_DIR = join(root, "worktrees");

    const response = await handleSetupRepoRoutes(
      postRepo({ source: "local", path: checkout }),
    );

    expect(response?.status).toBe(201);
    expect(await response?.json()).toMatchObject({
      id: "existing-checkout",
      repo: realpathSync(checkout),
      defaultBranch: "trunk",
      default: true,
    });
    const worktree = await createWorktree(
      "registered-worktree",
      "existing-checkout",
    );
    expect(existsSync(worktree)).toBe(true);
    expect(git(["branch", "--show-current"], worktree)).toBe(
      "registered-worktree",
    );
  });

  test.serial("preserves the implicit built-in repository", async () => {
    const root = localRoot();
    const checkout = createRemoteCheckout(root, "local-project");
    const configPath = join(root, "missing-config.json");
    process.env.OPENSESSION_CONFIG = configPath;

    const response = await handleSetupRepoRoutes(
      postRepo({ source: "local", path: checkout }),
    );

    expect(response?.status).toBe(201);
    const saved = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(saved.repos.opensession).toMatchObject({
      label: "Open Session",
      sharedCheckout: true,
      default: true,
    });
    expect(saved.repos["local-project"]).toMatchObject({
      repo: realpathSync(checkout),
      defaultBranch: "trunk",
    });
  });

  test.serial(
    "uses the remote default instead of the checked-out topic branch",
    async () => {
      const root = localRoot();
      const checkout = createRemoteCheckout(root, "topic-checkout", "main");
      git(["switch", "-c", "topic"], checkout);
      writeFileSync(join(checkout, "topic.txt"), "topic\n");
      git(["add", "topic.txt"], checkout);
      git(["commit", "-m", "Topic commit"], checkout);
      git(["push", "-u", "origin", "topic"], checkout);
      git(["remote", "set-head", "origin", "-d"], checkout);
      const configPath = join(root, "config.json");
      writeFileSync(configPath, JSON.stringify({ repos: {} }));
      process.env.OPENSESSION_CONFIG = configPath;

      const response = await handleSetupRepoRoutes(
        postRepo({ source: "local", path: checkout }),
      );

      expect(response?.status).toBe(201);
      expect(await response?.json()).toMatchObject({ defaultBranch: "main" });
    },
  );

  test.serial("rejects a repository without a usable origin", async () => {
    const root = localRoot();
    const checkout = join(root, "originless");
    git(["init", "-b", "main", checkout]);
    git(["config", "user.name", "Open Session test"], checkout);
    git(["config", "user.email", "test@opensession.dev"], checkout);
    writeFileSync(join(checkout, "README.md"), "originless\n");
    git(["add", "README.md"], checkout);
    git(["commit", "-m", "Initial commit"], checkout);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ repos: {} }));
    process.env.OPENSESSION_CONFIG = configPath;

    const response = await handleSetupRepoRoutes(
      postRepo({ source: "local", path: checkout }),
    );

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      error: "Repository must have an origin remote",
    });
  });

  test.serial("rejects the same checkout through a symlink", async () => {
    const root = localRoot();
    const checkout = createRemoteCheckout(root, "duplicate-target");
    const symlink = join(root, "checkout-link");
    symlinkSync(checkout, symlink);
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: {
          existing: {
            repo: symlink,
            wtPrefix: "existing",
            defaultBranch: "trunk",
          },
        },
      }),
    );
    process.env.OPENSESSION_CONFIG = configPath;

    const response = await handleSetupRepoRoutes(
      postRepo({ source: "local", path: checkout }),
    );

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      error: `Repository is already registered: ${realpathSync(checkout)}`,
    });
  });

  test.serial("rejects a duplicate worktree prefix", async () => {
    const root = localRoot();
    const checkout = createRemoteCheckout(root, "prefix-target");
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: {
          existing: {
            repo: join(root, "different-checkout"),
            wtPrefix: "prefix-target",
            defaultBranch: "main",
          },
        },
      }),
    );
    process.env.OPENSESSION_CONFIG = configPath;

    const response = await handleSetupRepoRoutes(
      postRepo({ source: "local", path: checkout }),
    );

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      error: "Worktree prefix already registered: prefix-target",
    });
  });

  test.serial("rejects the same local origin through a file URL", async () => {
    const root = localRoot();
    const registeredCheckout = createRemoteCheckout(root, "registered", "main");
    const remote = join(root, "registered.git");
    const duplicateCheckout = join(root, "duplicate");
    git(["clone", remote, duplicateCheckout]);
    git(
      ["remote", "set-url", "origin", pathToFileURL(remote).href],
      duplicateCheckout,
    );
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: {
          existing: {
            repo: registeredCheckout,
            wtPrefix: "existing",
            defaultBranch: "main",
          },
        },
      }),
    );
    process.env.OPENSESSION_CONFIG = configPath;

    const response = await handleSetupRepoRoutes(
      postRepo({ source: "local", path: duplicateCheckout }),
    );

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      error: "Repository origin is already registered: existing",
    });
  });

  test.serial(
    "rejects a remote registration whose checkout path is already owned",
    async () => {
      const root = localRoot();
      const checkouts = join(root, "checkouts");
      mkdirSync(checkouts, { recursive: true });
      const checkout = createRemoteCheckout(checkouts, "widget", "main");
      const configPath = join(root, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: {
            legacy: {
              repo: checkout,
              wtPrefix: "legacy",
              defaultBranch: "main",
            },
          },
        }),
      );
      process.env.HOME = root;
      process.env.OPENSESSION_CONFIG = configPath;

      const response = await handleSetupRepoRoutes(
        postRepo({ fullName: "acme/widget" }),
      );

      expect(response?.status).toBe(409);
      expect(await response?.json()).toEqual({
        error: `Repository is already registered: ${realpathSync(checkout)}`,
      });
    },
  );

  test.serial("configures a detected code.storage checkout", async () => {
    const root = localRoot();
    const checkout = createRemoteCheckout(root, "cs-checkout");
    git(
      [
        "remote",
        "set-url",
        "origin",
        "https://acme.code.storage/team/widget.git",
      ],
      checkout,
    );
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: {},
        integrations: {
          codeStorage: { org: "acme", privateKeyPath: join(root, "key.pem") },
        },
      }),
    );
    process.env.OPENSESSION_CONFIG = configPath;

    const response = await handleSetupRepoRoutes(
      postRepo({ source: "local", path: checkout }),
    );

    expect(response?.status).toBe(201);
    expect(await response?.json()).toMatchObject({
      host: "codestorage",
      csRepo: "team/widget",
    });
    expect(
      gitRaw(
        ["config", "--get-all", "credential.https://acme.code.storage.helper"],
        checkout,
      )
        .replace(/\n$/, "")
        .split("\n"),
    ).toEqual(["", expect.stringContaining("scripts/cs-credential.ts")]);
  });

  test.serial("does not overwrite a malformed repos config", async () => {
    const root = localRoot();
    const checkout = createRemoteCheckout(root, "malformed-config");
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ repos: [] }));
    process.env.OPENSESSION_CONFIG = configPath;

    const response = await handleSetupRepoRoutes(
      postRepo({ source: "local", path: checkout }),
    );

    expect(response?.status).toBe(500);
    expect(await response?.json()).toEqual({
      error: "Config repos must contain a JSON object",
    });
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
      repos: [],
    });
  });

  test.serial("requires an absolute path", async () => {
    const response = await handleSetupRepoRoutes(
      postRepo({ source: "local", path: "relative/repo" }),
    );

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      error: "path must be an absolute path to a Git repository",
    });
  });
});
