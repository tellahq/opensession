import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import type { Repo } from "./config";
import {
  activeSessionBranches,
  activeSessionWorktrees,
  bankWorkingState,
  idleSessionWorktrees,
  type WorktreeActivitySession,
} from "./worktree-reaper";

const NOW = Date.parse("2026-08-08T12:00:00Z");
const CUTOFF = NOW - 7 * 86_400_000;
const ACTIVE_CUTOFF = NOW - 6 * 3_600_000;

function session(
  dir: string,
  opts: Partial<WorktreeActivitySession> = {},
): WorktreeActivitySession {
  return {
    worktreeDir: dir,
    attachedRepos: [],
    branch: null,
    lastActivity: "2026-07-31T00:00:00Z",
    isRunning: false,
    ...opts,
  };
}

describe("idleSessionWorktrees", () => {
  it("parks a checkout whose owning session is older than the cutoff", () => {
    const idle = idleSessionWorktrees([session("/worktrees/old")], CUTOFF);
    expect(idle.has("/worktrees/old")).toBe(true);
  });

  it("keeps recent and running sessions", () => {
    const idle = idleSessionWorktrees(
      [
        session("/worktrees/recent", {
          lastActivity: "2026-08-08T00:00:00Z",
        }),
        session("/worktrees/running", { isRunning: true }),
      ],
      CUTOFF,
    );
    expect(idle.has("/worktrees/recent")).toBe(false);
    expect(idle.has("/worktrees/running")).toBe(false);
  });

  it("lets one recent or running owner protect a shared checkout", () => {
    const idle = idleSessionWorktrees(
      [
        session("/worktrees/shared"),
        session("/worktrees/shared", {
          lastActivity: "2026-08-07T00:00:00Z",
        }),
      ],
      CUTOFF,
    );
    expect(idle.has("/worktrees/shared")).toBe(false);
  });

  it("tracks attached repo worktrees", () => {
    const idle = idleSessionWorktrees(
      [
        session("/worktrees/primary", {
          attachedRepos: [
            { repo: "secondary", branch: "topic", dir: "/worktrees/attached" },
          ],
        }),
      ],
      CUTOFF,
    );
    expect(idle.has("/worktrees/primary")).toBe(true);
    expect(idle.has("/worktrees/attached")).toBe(true);
  });

  it("fails closed when session activity is malformed", () => {
    const idle = idleSessionWorktrees(
      [session("/worktrees/unknown", { lastActivity: "not-a-date" })],
      CUTOFF,
    );
    expect(idle.has("/worktrees/unknown")).toBe(false);
  });

  it("parks automation-only checkouts on the shorter automation cutoff", () => {
    const idle = idleSessionWorktrees(
      [
        session("/worktrees/auto", {
          automation: "plain-ticket-triage",
          lastActivity: "2026-08-06T00:00:00Z",
        }),
      ],
      CUTOFF,
      NOW - 86_400_000,
    );
    expect(idle.has("/worktrees/auto")).toBe(true);
  });

  it("keeps the general cutoff when any owner is not an automation", () => {
    const idle = idleSessionWorktrees(
      [
        session("/worktrees/mixed", {
          automation: "plain-ticket-triage",
          lastActivity: "2026-08-06T00:00:00Z",
        }),
        session("/worktrees/mixed", { lastActivity: "2026-08-06T00:00:00Z" }),
      ],
      CUTOFF,
      NOW - 86_400_000,
    );
    expect(idle.has("/worktrees/mixed")).toBe(false);
  });

  it("keeps a recent automation checkout inside the automation window", () => {
    const idle = idleSessionWorktrees(
      [
        session("/worktrees/auto-fresh", {
          automation: "plain-ticket-triage",
          lastActivity: "2026-08-08T02:00:00Z",
        }),
      ],
      CUTOFF,
      NOW - 86_400_000,
    );
    expect(idle.has("/worktrees/auto-fresh")).toBe(false);
  });
});

describe("activeSessionWorktrees", () => {
  it("holds a checkout whose session was touched inside the window", () => {
    const active = activeSessionWorktrees(
      [session("/worktrees/live", { lastActivity: "2026-08-08T11:00:00Z" })],
      ACTIVE_CUTOFF,
    );
    expect(active.has("/worktrees/live")).toBe(true);
  });

  it("releases a checkout whose session went quiet before the window", () => {
    const active = activeSessionWorktrees(
      [session("/worktrees/quiet", { lastActivity: "2026-08-08T02:00:00Z" })],
      ACTIVE_CUTOFF,
    );
    expect(active.has("/worktrees/quiet")).toBe(false);
  });

  it("fails closed on running and malformed sessions", () => {
    const active = activeSessionWorktrees(
      [
        session("/worktrees/running", { isRunning: true }),
        session("/worktrees/unknown", { lastActivity: "not-a-date" }),
      ],
      ACTIVE_CUTOFF,
    );
    expect(active.has("/worktrees/running")).toBe(true);
    expect(active.has("/worktrees/unknown")).toBe(true);
  });

  it("lets one recent owner hold a shared checkout, and covers attached repos", () => {
    const active = activeSessionWorktrees(
      [
        session("/worktrees/shared"),
        session("/worktrees/shared", {
          lastActivity: "2026-08-08T11:30:00Z",
          attachedRepos: [
            { repo: "secondary", branch: "topic", dir: "/worktrees/attached" },
          ],
        }),
      ],
      ACTIVE_CUTOFF,
    );
    expect(active.has("/worktrees/shared")).toBe(true);
    expect(active.has("/worktrees/attached")).toBe(true);
  });

  it("never claims a worktree no session owns", () => {
    const active = activeSessionWorktrees([], ACTIVE_CUTOFF);
    expect(active.has("/worktrees/orphan")).toBe(false);
  });
});

describe("activeSessionBranches", () => {
  it("holds a revived branch when the recorded worktree path is stale", () => {
    const active = activeSessionBranches(
      [
        session("/worktrees/original-name", {
          repo: "tella-fusion",
          branch: "renamed-branch",
          lastActivity: "2026-08-08T11:00:00Z",
        }),
      ],
      ACTIVE_CUTOFF,
    );
    expect(active.get("tella-fusion")?.has("renamed-branch")).toBe(true);
  });

  it("holds running attached branches and releases old inactive branches", () => {
    const active = activeSessionBranches(
      [
        session("/worktrees/primary", {
          repo: "primary",
          branch: "old-primary",
          attachedRepos: [
            {
              repo: "secondary",
              branch: "live-attached",
              dir: "/worktrees/attached-old-path",
            },
          ],
          isRunning: true,
        }),
        session("/worktrees/quiet", {
          repo: "primary",
          branch: "quiet-branch",
          lastActivity: "2026-08-08T02:00:00Z",
        }),
      ],
      ACTIVE_CUTOFF,
    );
    expect(active.get("primary")?.has("old-primary")).toBe(true);
    expect(active.get("secondary")?.has("live-attached")).toBe(true);
    expect(active.get("primary")?.has("quiet-branch")).toBe(false);
  });
});

describe("worktree reaper wiring", () => {
  it("refreshes live run state before an irreversible sweep", () => {
    const boot = readFileSync(
      join(import.meta.dir, "../../opensession.ts"),
      "utf8",
    );
    expect(boot).toContain(
      "startWorktreeReaper(() => enrichSessionRuntime(getCachedSessions()))",
    );
  });
});

describe("bankWorkingState", () => {
  let tmp: string;
  let savedStateDir: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "wt-bank-"));
    savedStateDir = process.env.OPENSESSION_STATE_DIR;
    process.env.OPENSESSION_STATE_DIR = join(tmp, "state");
  });

  afterEach(async () => {
    if (savedStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
    else process.env.OPENSESSION_STATE_DIR = savedStateDir;
    await rm(tmp, { recursive: true, force: true });
  });

  async function makeWorkRepo(): Promise<string> {
    const origin = join(tmp, "origin.git");
    const work = join(tmp, "work");
    await $`git init --bare -q ${origin}`.quiet();
    await $`git init -q -b main ${work}`.quiet();
    await $`git -C ${work} config user.email t@t.test`.quiet();
    await $`git -C ${work} config user.name t`.quiet();
    await Bun.write(join(work, "a.txt"), "base\n");
    await $`git -C ${work} add a.txt`.quiet();
    await $`git -C ${work} commit -q -m base`.quiet();
    await $`git -C ${work} remote add origin ${origin}`.quiet();
    await $`git -C ${work} push -q origin main`.quiet();
    return work;
  }

  it("banks tracked edits, untracked files and unpushed commits, then verifies", async () => {
    const work = await makeWorkRepo();
    await Bun.write(join(work, "c.txt"), "committed but unpushed\n");
    await $`git -C ${work} add c.txt`.quiet();
    await $`git -C ${work} commit -q -m unpushed`.quiet();
    await Bun.write(join(work, "a.txt"), "base\nedited\n");
    await Bun.write(join(work, "b.txt"), "untracked\n");
    const dirty = (await $`git -C ${work} status --porcelain`.quiet())
      .text()
      .trim();
    const unpushed = (
      await $`git -C ${work} log --oneline HEAD --not --remotes`.quiet()
    )
      .text()
      .trim();
    expect(dirty).not.toBe("");
    expect(unpushed).not.toBe("");

    const bankDir = await bankWorkingState(
      { id: "testrepo" } as Repo,
      work,
      "feature/x",
      "test reason",
      { dirty, unpushed },
    );
    expect(bankDir).not.toBeNull();
    if (!bankDir) return;
    expect(readFileSync(join(bankDir, "tracked.patch"), "utf8")).toContain(
      "+edited",
    );
    expect(existsSync(join(bankDir, "untracked.tar.gz"))).toBe(true);
    const verify =
      await $`git -C ${work} bundle verify ${join(bankDir, "unpushed.bundle")}`
        .quiet()
        .nothrow();
    expect(verify.exitCode).toBe(0);
    const meta = JSON.parse(
      readFileSync(join(bankDir, "metadata.json"), "utf8"),
    );
    expect(meta.branch).toBe("feature/x");
    expect(meta.untrackedFiles).toBe(1);
  });

  it("banks an untracked-only tree without a patch or bundle", async () => {
    const work = await makeWorkRepo();
    await Bun.write(join(work, "b.txt"), "untracked\n");
    const dirty = (await $`git -C ${work} status --porcelain`.quiet())
      .text()
      .trim();
    const bankDir = await bankWorkingState(
      { id: "testrepo" } as Repo,
      work,
      "feature/y",
      "test reason",
      { dirty, unpushed: "" },
    );
    expect(bankDir).not.toBeNull();
    if (!bankDir) return;
    expect(existsSync(join(bankDir, "untracked.tar.gz"))).toBe(true);
    expect(existsSync(join(bankDir, "unpushed.bundle"))).toBe(false);
    expect(existsSync(join(bankDir, "tracked.patch"))).toBe(false);
  });
});
