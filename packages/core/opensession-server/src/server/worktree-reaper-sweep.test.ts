import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";
import { getConfigAsync } from "./config";

// End-to-end sweep over a real repo: a done-signal ("tip in origin/main")
// must not reap the checkout of a session a person can still return to.
// Regression for 2026-09-24, when a session whose PR had closed was reaped 6h
// after its last turn and its revived checkout had lost every gitignored file.

const ENV_KEYS = ["OPENSESSION_CONFIG", "OPENSESSION_WORKTREES_DIR"] as const;
const saved = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

const NOW = Date.now();
const HOUR = 3_600_000;
let root: string;
let repoDir: string;
let worktrees: string;

async function addDoneWorktree(branch: string): Promise<string> {
  const dir = join(worktrees, `acme-${branch}`);
  await $`git -C ${repoDir} worktree add -q -b ${branch} ${dir} origin/main`.quiet();
  // Gitignored state a session keeps in its checkout (screenshots, installs).
  mkdirSync(join(dir, "target", "shots"), { recursive: true });
  await Bun.write(join(dir, "target", "shots", "after.png"), "png");
  // Older than the young-checkout window, so only session ownership spares it.
  const old = new Date(NOW - 12 * HOUR);
  utimesSync(join(dir, ".git"), old, old);
  return dir;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "worktree-reaper-sweep-"));
  const origin = join(root, "origin.git");
  repoDir = join(root, "repo");
  worktrees = join(root, "worktrees");
  mkdirSync(worktrees);
  await $`git init -q --bare -b main ${origin}`.quiet();
  await $`git init -q -b main ${repoDir}`.quiet();
  await $`git -C ${repoDir} config user.email test@example.test`.quiet();
  await $`git -C ${repoDir} config user.name Test`.quiet();
  await Bun.write(join(repoDir, ".gitignore"), "target/\n");
  await $`git -C ${repoDir} add .gitignore`.quiet();
  await $`git -C ${repoDir} commit -q -m initial`.quiet();
  await $`git -C ${repoDir} remote add origin ${origin}`.quiet();
  await $`git -C ${repoDir} push -q -u origin main`.quiet();
  await Bun.write(
    join(root, "config.json"),
    JSON.stringify({
      repos: {
        acme: { repo: repoDir, wtPrefix: "acme", defaultBranch: "main" },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = join(root, "config.json");
  process.env.OPENSESSION_WORKTREES_DIR = worktrees;
  await getConfigAsync();
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

describe("sweepWorktreeReaper", () => {
  it("keeps an open session's done checkout and reaps an archived one", async () => {
    const { sweepWorktreeReaper } = await import("./worktree-reaper");
    const open = await addDoneWorktree("open-session");
    const renamed = await addDoneWorktree("renamed-branch");
    const archived = await addDoneWorktree("archived-session");
    const automation = await addDoneWorktree("automation-run");
    const quiet = new Date(NOW - 8 * HOUR).toISOString();

    const result = await sweepWorktreeReaper({
      nowMs: NOW,
      sessions: [
        {
          worktreeDir: open,
          branch: "open-session",
          repo: "acme",
          lastActivity: quiet,
          isRunning: false,
        },
        {
          // Stored path predates a branch rename: matched by repo + branch.
          worktreeDir: join(worktrees, "acme-original-name"),
          branch: "renamed-branch",
          repo: "acme",
          lastActivity: quiet,
          isRunning: false,
        },
        {
          worktreeDir: archived,
          branch: "archived-session",
          repo: "acme",
          lastActivity: quiet,
          isRunning: false,
          archived: true,
        },
        {
          worktreeDir: automation,
          branch: "automation-run",
          repo: "acme",
          lastActivity: quiet,
          isRunning: false,
          automation: "nightly-triage",
        },
      ],
    });

    expect(existsSync(join(open, "target", "shots", "after.png"))).toBe(true);
    expect(existsSync(join(renamed, "target", "shots", "after.png"))).toBe(
      true,
    );
    expect(result.skipped.sessionOpen).toBe(2);
    expect(existsSync(archived)).toBe(false);
    expect(existsSync(automation)).toBe(false);
    expect(result.removed.sort()).toEqual([
      "acme-archived-session",
      "acme-automation-run",
    ]);
    expect(result.parked).toEqual([]);
  });

  it("keeps an archived session's checkout while its PR awaits a deploy", async () => {
    const { sweepWorktreeReaper } = await import("./worktree-reaper");
    const waiting = await addDoneWorktree("awaiting-deploy");
    const quiet = new Date(NOW - 8 * HOUR).toISOString();

    const result = await sweepWorktreeReaper({
      nowMs: NOW,
      awaitingDeploy: new Set(["os-waiting"]),
      sessions: [
        {
          id: "os-waiting",
          worktreeDir: waiting,
          branch: "awaiting-deploy",
          repo: "acme",
          lastActivity: quiet,
          isRunning: false,
          archived: true,
        },
      ],
    });

    expect(existsSync(join(waiting, "target", "shots", "after.png"))).toBe(
      true,
    );
    expect(result.skipped.sessionOpen).toBe(1);
    expect(result.removed).not.toContain("acme-awaiting-deploy");
  });

  it("parks, never reaps, an open session's done checkout past the idle horizon", async () => {
    const { sweepWorktreeReaper } = await import("./worktree-reaper");
    const open = await addDoneWorktree("idle-open-session");
    const renamed = await addDoneWorktree("idle-renamed-branch");
    const stale = new Date(NOW - 8 * 24 * HOUR).toISOString();

    const result = await sweepWorktreeReaper({
      nowMs: NOW,
      sessions: [
        {
          worktreeDir: open,
          branch: "idle-open-session",
          repo: "acme",
          lastActivity: stale,
          isRunning: false,
        },
        {
          // Only the branch ties this session to its revived checkout.
          worktreeDir: join(worktrees, "acme-idle-original-name"),
          branch: "idle-renamed-branch",
          repo: "acme",
          lastActivity: stale,
          isRunning: false,
        },
      ],
    });

    expect(existsSync(open)).toBe(false);
    expect(existsSync(renamed)).toBe(false);
    // Parked (Slack channel and tmux kept), not reaped as done work.
    expect(result.parked.sort()).toEqual([
      "acme-idle-open-session",
      "acme-idle-renamed-branch",
    ]);
  });
});
