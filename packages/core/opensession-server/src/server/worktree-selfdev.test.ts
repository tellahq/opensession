import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve as resolvePath } from "path";
import { configuredSelfDev } from "./config";
import {
  createWorktree,
  ensureAskCheckout,
  getRepo,
  invalidateAskCheckoutRefresh,
  isSharedCheckoutDir,
  prepareAttachedWorktree,
  sharedCheckoutForNewSessions,
  sharedCheckoutForSessionCreate,
  withGitLock,
  worktreePathFor,
} from "./worktree";

/**
 * Config `selfDev` flag: "shared" (default/absent) keeps today's behavior —
 * sessions on a sharedCheckout repo work in the live main checkout;
 * "worktree" flips the session-creation decision point
 * (sharedCheckoutForNewSessions) so they get isolated per-branch worktrees
 * like every other repo. All assertions here stay on the pure decision
 * functions (worktreePathFor + the shared-mode early returns), so no git
 * side effects — same seams as worktree-adopt.test.ts (OPENSESSION_CONFIG /
 * OPENSESSION_WORKTREES_DIR; the config loader caches by path+mtime, so each
 * case writes a fresh file).
 */

const ENV_KEYS = [
  "OPENSESSION_CONFIG",
  "OPENSESSION_CONFIG",
  "OPENSESSION_WORKTREES_DIR",
  "OPENSESSION_WORKTREES_DIR",
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

const dirs: string[] = [];
const WT_DIR = "/selfdev-test/worktrees";
const SELF_REPO = "/selfdev-test/self-main";

function withConfig(extra: Record<string, unknown>): void {
  const dir = mkdtempSync(join(tmpdir(), "bks-selfdev-test-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      paths: { worktreesDir: WT_DIR },
      repos: {
        self: {
          repo: SELF_REPO,
          wtPrefix: "self",
          defaultBranch: "main",
          sharedCheckout: true,
          default: true,
        },
        lib: { repo: "/selfdev-test/lib-main", wtPrefix: "lib" },
      },
      ...extra,
    }),
  );
  for (const k of ENV_KEYS) delete process.env[k];
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

describe("configuredSelfDev parsing", () => {
  test("absent → shared", () => {
    withConfig({});
    expect(configuredSelfDev()).toBe("shared");
  });

  test('explicit "shared"', () => {
    withConfig({ selfDev: "shared" });
    expect(configuredSelfDev()).toBe("shared");
  });

  test('explicit "worktree"', () => {
    withConfig({ selfDev: "worktree" });
    expect(configuredSelfDev()).toBe("worktree");
  });

  test("invalid value → shared, one console.warn per parse", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      withConfig({ selfDev: "wortkree" });
      expect(configuredSelfDev()).toBe("shared");
      // Cached parse (same path+mtime): repeated reads don't re-warn.
      expect(configuredSelfDev()).toBe("shared");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("selfDev");
      // The rest of the file still parses — bad selfDev never voids the config.
      expect(worktreePathFor("b", "lib")).toBe(`${WT_DIR}/lib-b`);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("personal new-session checkout choice", () => {
  test("overrides either repository default and rejects unknown values", () => {
    withConfig({});
    const shared = getRepo("self");
    const isolated = getRepo("lib");

    expect(sharedCheckoutForSessionCreate(shared, "default")).toBe(true);
    expect(sharedCheckoutForSessionCreate(shared, "worktree")).toBe(false);
    expect(sharedCheckoutForSessionCreate(isolated, "default")).toBe(false);
    expect(sharedCheckoutForSessionCreate(isolated, "checkout")).toBe(true);
    expect(sharedCheckoutForSessionCreate(shared, "surprise")).toBe(true);
  });
});

describe("selfDev absent/shared — byte-identical current behavior", () => {
  test("new-session paths resolve to the live main checkout", async () => {
    withConfig({});
    const repo = getRepo("self");
    expect(sharedCheckoutForNewSessions(repo)).toBe(true);
    expect(worktreePathFor("feat-x", "self")).toBe(SELF_REPO);
    // Shared-mode early returns — no git runs behind these.
    expect(await createWorktree("feat-x", "self")).toBe(SELF_REPO);
    expect(await ensureAskCheckout("self")).toBe(SELF_REPO);
    // `isolated` still forces a real per-branch path (from-PR / automations).
    expect(worktreePathFor("feat-x", "self", { isolated: true })).toBe(
      `${WT_DIR}/self-feat-x`,
    );
    // Attach guard: the shared checkout can't be attached to another session.
    await expect(prepareAttachedWorktree("self", "feat-x")).rejects.toThrow(
      /shared-checkout/,
    );
  });

  test("builtin defaults (no config file): opensession repo = this checkout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bks-selfdev-test-"));
    dirs.push(dir);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.OPENSESSION_CONFIG = join(dir, "never-written.json");

    const OPENSESSION_ROOT = resolvePath(import.meta.dir, "../../../../..");
    expect(configuredSelfDev()).toBe("shared");
    expect(worktreePathFor("feat-x")).toBe(OPENSESSION_ROOT);
    expect(await createWorktree("feat-x")).toBe(OPENSESSION_ROOT);
    expect(await ensureAskCheckout()).toBe(OPENSESSION_ROOT);
  });
});

describe("Ask checkout default branch invalidation", () => {
  let sequence = 0;

  function setupAskRepo() {
    const dir = mkdtempSync(join(tmpdir(), "bks-ask-checkout-test-"));
    dirs.push(dir);
    const repoId = `app-${++sequence}`;
    const repo = join(dir, "repo");
    const remote = join(dir, "remote.git");
    const worktrees = join(dir, "worktrees");
    const config = join(dir, "config.json");
    const git = (...args: string[]) => {
      expect(Bun.spawnSync(["git", ...args]).exitCode).toBe(0);
    };

    git("init", "-q", "-b", "main", repo);
    writeFileSync(join(repo, "README.md"), "main\n");
    git("-C", repo, "add", "README.md");
    git(
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "-m",
      "main",
    );
    git("-C", repo, "checkout", "-q", "-b", "release");
    writeFileSync(join(repo, "README.md"), "release\n");
    git("-C", repo, "add", "README.md");
    git(
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "-m",
      "release",
    );
    git("-C", repo, "checkout", "-q", "main");
    git("init", "-q", "--bare", remote);
    git("-C", repo, "remote", "add", "origin", remote);
    git("-C", repo, "push", "-q", "-u", "origin", "main", "release");

    const writeConfig = (defaultBranch: string) => {
      writeFileSync(
        config,
        JSON.stringify({
          paths: { worktreesDir: worktrees },
          repos: {
            [repoId]: { repo, wtPrefix: repoId, defaultBranch, default: true },
          },
        }),
      );
      process.env.OPENSESSION_CONFIG = config;
    };
    const branchHead = (dir: string, branch: string) =>
      Bun.spawnSync(["git", "-C", dir, "rev-parse", branch])
        .stdout.toString()
        .trim();

    return { branchHead, repo, repoId, writeConfig };
  }

  test("waits for the checkout to move to the new default before returning", async () => {
    const { branchHead, repo, repoId, writeConfig } = setupAskRepo();
    writeConfig("main");
    const askDir = await ensureAskCheckout(repoId);
    expect(branchHead(askDir, "HEAD")).toBe(branchHead(repo, "origin/main"));

    writeConfig("release");
    invalidateAskCheckoutRefresh(repoId);
    expect(await ensureAskCheckout(repoId)).toBe(askDir);
    expect(branchHead(askDir, "HEAD")).toBe(branchHead(repo, "origin/release"));
  });

  test("applies an invalidation queued while another call creates the checkout", async () => {
    const { branchHead, repo, repoId, writeConfig } = setupAskRepo();
    writeConfig("main");

    let releaseLock!: () => void;
    let enteredLock!: () => void;
    const entered = new Promise<void>((resolve) => (enteredLock = resolve));
    const blocked = new Promise<void>((resolve) => (releaseLock = resolve));
    const blocker = withGitLock(async () => {
      enteredLock();
      await blocked;
    });
    await entered;

    const creating = ensureAskCheckout(repoId);
    writeConfig("release");
    invalidateAskCheckoutRefresh(repoId);
    const afterChange = ensureAskCheckout(repoId);
    releaseLock();
    await blocker;

    const askDir = await creating;
    expect(await afterChange).toBe(askDir);
    expect(branchHead(askDir, "HEAD")).toBe(branchHead(repo, "origin/release"));
  });
});

describe('selfDev: "worktree" — isolated worktrees for the self repo', () => {
  test("new-session paths pick the per-branch worktree", () => {
    withConfig({ selfDev: "worktree" });
    const repo = getRepo("self");
    expect(sharedCheckoutForNewSessions(repo)).toBe(false);
    expect(worktreePathFor("feat-x", "self")).toBe(`${WT_DIR}/self-feat-x`);
    expect(worktreePathFor("feat-x", "self", { isolated: true })).toBe(
      `${WT_DIR}/self-feat-x`,
    );
  });

  test("non-shared repos are unaffected", () => {
    withConfig({ selfDev: "worktree" });
    expect(sharedCheckoutForNewSessions(getRepo("lib"))).toBe(false);
    expect(worktreePathFor("feat-x", "lib")).toBe(`${WT_DIR}/lib-feat-x`);
  });

  test("existing shared-mode dirs are still recognized (guards keep applying)", () => {
    withConfig({ selfDev: "worktree" });
    // isSharedCheckoutDir stays keyed on the repo property, NOT the mode:
    // sessions created before the flip recorded the live checkout as their
    // dir, and its no-reset/commit-scoping guards must survive the mode.
    expect(isSharedCheckoutDir(SELF_REPO)).toBe(true);
    expect(isSharedCheckoutDir(`${WT_DIR}/self-ask-checkout`)).toBe(true);
    expect(isSharedCheckoutDir(`${WT_DIR}/self-feat-x`)).toBe(false);
  });
});
