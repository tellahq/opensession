import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setWorkloadScopingForTest } from "./workload-scope";
import {
  DEFAULT_SETUP_TIMEOUT_MINUTES,
  parseSetupScopes,
  reapSetupScopes,
  recordSetupTimeout,
  runSetupCommand,
  SetupStoppedError,
  SetupTimeoutError,
  setupScopePrefix,
  setupTimeoutMs,
  stopSessionWorktreeSetup,
  stopWorktreeSetup,
  type SetupOwnerSession,
} from "./worktree-setup";

let dir: string;

beforeEach(async () => {
  __setWorkloadScopingForTest(false);
  dir = await realpath(await mkdtemp(join(tmpdir(), "os-setup-")));
});

afterEach(async () => {
  __setWorkloadScopingForTest(null);
  await rm(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("condition not met");
}

function session(
  id: string,
  worktreeDir: string | null,
  extra: Partial<SetupOwnerSession> = {},
): SetupOwnerSession {
  return { id, worktreeDir, ...extra } as SetupOwnerSession;
}

// A setup command whose background child (a package-manager worker) records
// its pid, then both hang.
const HANGING = ["sh", "-c", "sleep 30 & echo $! > child.pid; sleep 30"];

describe("setupTimeoutMs", () => {
  test("defaults to 15 minutes and honours the repo setting", () => {
    expect(DEFAULT_SETUP_TIMEOUT_MINUTES).toBe(15);
    expect(setupTimeoutMs({})).toBe(15 * 60_000);
    expect(setupTimeoutMs({ setupTimeoutMinutes: 2 })).toBe(2 * 60_000);
    expect(setupTimeoutMs({ setupTimeoutMinutes: 0 })).toBe(15 * 60_000);
    expect(setupTimeoutMs({ setupTimeoutMinutes: -1 })).toBe(15 * 60_000);
  });
});

describe("runSetupCommand", () => {
  test("resolves on success and rejects with stderr on failure", async () => {
    await runSetupCommand(["true"], { cwd: dir, timeoutMs: 5_000 });
    await expect(
      runSetupCommand(["sh", "-c", "echo boom >&2; exit 3"], {
        cwd: dir,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/exited with 3: boom/);
  });

  test("a hung setup times out and its whole process tree dies", async () => {
    const run = runSetupCommand(HANGING, { cwd: dir, timeoutMs: 300 });
    await expect(run).rejects.toBeInstanceOf(SetupTimeoutError);
    const pid = Number(await readFile(join(dir, "child.pid"), "utf8"));
    await waitFor(() => !alive(pid));
  });

  test("stopping the worktree's setup ends it without a timeout", async () => {
    const run = runSetupCommand(HANGING, { cwd: dir, timeoutMs: 30_000 });
    const settled = run.then(
      () => null,
      (error) => error,
    );
    await waitFor(() =>
      readFile(join(dir, "child.pid"), "utf8").then(
        (text) => text.trim() !== "",
        () => false,
      ),
    );
    const pid = Number(await readFile(join(dir, "child.pid"), "utf8"));
    expect(await stopWorktreeSetup(dir, { scopes: false })).toBe(1);
    expect(await settled).toBeInstanceOf(SetupStoppedError);
    await waitFor(() => !alive(pid));
  });
});

describe("stopSessionWorktreeSetup", () => {
  test("stops every checkout of the session", async () => {
    const stopped: string[] = [];
    await stopSessionWorktreeSetup(
      session("a", "/wt/a", {
        attachedRepos: [{ repo: "other", dir: "/wt/a-other" }] as never,
      }),
      { sessions: [], stop: async (d) => void stopped.push(d) },
    );
    expect(stopped).toEqual(["/wt/a", "/wt/a-other"]);
  });

  test("leaves a checkout another live session still uses", async () => {
    const stopped: string[] = [];
    await stopSessionWorktreeSetup(session("a", "/wt/shared"), {
      sessions: [
        session("a", "/wt/shared"),
        session("b", "/wt/shared"),
        session("c", "/wt/c", { archived: true }),
      ],
      stop: async (d) => void stopped.push(d),
    });
    expect(stopped).toEqual([]);
    await stopSessionWorktreeSetup(session("a", "/wt/shared"), {
      sessions: [session("b", "/wt/shared", { archived: true })],
      stop: async (d) => void stopped.push(d),
    });
    expect(stopped).toEqual(["/wt/shared"]);
  });

  test("an alias of the same session is not another owner", async () => {
    const stopped: string[] = [];
    await stopSessionWorktreeSetup(
      session("a", "/wt/a", { aliasIds: ["slack-1"] }),
      {
        sessions: [session("slack-1", "/wt/a")],
        stop: async (d) => void stopped.push(d),
      },
    );
    expect(stopped).toEqual(["/wt/a"]);
  });

  test("skips sessions whose setup ran on a runner or in a Sandbox", async () => {
    const stopped: string[] = [];
    const stop = async (d: string) => void stopped.push(d);
    await stopSessionWorktreeSetup(
      session("a", "/wt/a", { runner: { id: "r" } as never }),
      { sessions: [], stop },
    );
    await stopSessionWorktreeSetup(
      session("b", "/wt/b", { sandbox: { sandboxId: "s" } as never }),
      { sessions: [], stop },
    );
    expect(stopped).toEqual([]);
  });
});

describe("reapSetupScopes", () => {
  const unitFor = (worktree: string, suffix = "0123abcd") =>
    `${setupScopePrefix(worktree)}-${suffix}.scope`;

  test("stops archived owners' and long-orphaned scopes only", async () => {
    const stopped: string[] = [];
    const scopes = [
      { unit: unitFor("/wt/archived"), ageMs: 1_000 },
      { unit: unitFor("/wt/live"), ageMs: 99 * 60_000 },
      { unit: unitFor("/wt/mixed"), ageMs: 1_000 },
      { unit: unitFor("/wt/gone"), ageMs: 1_000 },
      { unit: unitFor("/wt/gone", "ffffeeee"), ageMs: 16 * 60_000 },
    ];
    const result = await reapSetupScopes(
      [
        session("a", "/wt/archived", { archived: true }),
        session("b", "/wt/live"),
        session("c", "/wt/mixed", { archived: true }),
        session("d", "/wt/mixed"),
      ],
      {
        list: async () => scopes,
        stop: async (unit) => void stopped.push(unit),
        maxAgeMs: 15 * 60_000,
      },
    );
    expect(result.stopped).toEqual([
      { unit: unitFor("/wt/archived"), reason: "archived" },
      { unit: unitFor("/wt/gone", "ffffeeee"), reason: "orphaned" },
    ]);
    expect(stopped).toEqual(result.stopped.map((s) => s.unit));
  });

  test("owners of attached checkouts count", async () => {
    const stopped: string[] = [];
    await reapSetupScopes(
      [
        session("a", "/wt/a", {
          archived: true,
          attachedRepos: [{ repo: "x", dir: "/wt/a-x" }] as never,
        }),
      ],
      {
        list: async () => [{ unit: unitFor("/wt/a-x"), ageMs: 0 }],
        stop: async (unit) => void stopped.push(unit),
        maxAgeMs: 1,
      },
    );
    expect(stopped).toEqual([unitFor("/wt/a-x")]);
  });
});

describe("parseSetupScopes", () => {
  test("reads active setup scopes and their age from systemctl show", () => {
    const text = [
      "Id=opensession-setup-0123456789abcdef-0123abcd.scope",
      "ActiveState=active",
      "ActiveEnterTimestampMonotonic=1000000",
      "ControlGroup=/user.slice/a.scope",
      "",
      "Id=opensession-setup-fedcba9876543210.scope",
      "ActiveState=inactive",
      "ActiveEnterTimestampMonotonic=0",
      "",
    ].join("\n");
    expect(parseSetupScopes(text, 61_000)).toEqual([
      {
        unit: "opensession-setup-0123456789abcdef-0123abcd.scope",
        ageMs: 60_000,
        controlGroup: "/user.slice/a.scope",
      },
    ]);
  });
});

describe("recordSetupTimeout", () => {
  test("notifies the live sessions working in the checkout", async () => {
    const notices: Array<[string, string]> = [];
    const notified = await recordSetupTimeout(dir, 15 * 60_000, {
      sessions: [
        session("a", dir),
        session("b", dir, { archived: true }),
        session("c", "/wt/elsewhere"),
      ],
      append: async (id, text) => void notices.push([id, text]),
    });
    expect(notified).toEqual(["a"]);
    expect(notices[0]?.[1]).toContain("Workspace setup timed out after 15 min");
  });
});

describe("pending setup pipelines", () => {
  test("archiving while seeding waits stops setup before it starts", async () => {
    const { seedAndInstallWorktree } = await import("./worktree");
    let releaseSeed!: () => void;
    let seeding!: () => void;
    const seedStarted = new Promise<void>((r) => (seeding = r));
    const pipeline = seedAndInstallWorktree(
      {
        id: "acme",
        worktreeSetup: "touch setup-ran",
        depsInstall: "touch deps-ran",
      } as never,
      dir,
      "acme-branch",
      () => {
        seeding();
        return new Promise<void>((r) => (releaseSeed = r));
      },
    );
    await seedStarted;
    // The session is archived while seeding still waits on its lock.
    expect(await stopWorktreeSetup(dir, { scopes: false })).toBe(1);
    releaseSeed();
    await pipeline;
    expect(await Bun.file(join(dir, "setup-ran")).exists()).toBe(false);
    expect(await Bun.file(join(dir, "deps-ran")).exists()).toBe(false);
  });

  test("the reaper cancels a pending pipeline of an archived owner", async () => {
    const { seedAndInstallWorktree } = await import("./worktree");
    let releaseSeed!: () => void;
    let seeding!: () => void;
    const seedStarted = new Promise<void>((r) => (seeding = r));
    const pipeline = seedAndInstallWorktree(
      { id: "acme", depsInstall: "touch deps-ran" } as never,
      dir,
      "acme-branch",
      () => {
        seeding();
        return new Promise<void>((r) => (releaseSeed = r));
      },
    );
    await seedStarted;
    await reapSetupScopes([session("a", dir, { archived: true })], {
      list: async () => [],
    });
    releaseSeed();
    await pipeline;
    expect(await Bun.file(join(dir, "deps-ran")).exists()).toBe(false);
  });

  test("an uncancelled pipeline runs its setup after seeding", async () => {
    const { seedAndInstallWorktree } = await import("./worktree");
    await seedAndInstallWorktree(
      { id: "acme", depsInstall: "touch deps-ran" } as never,
      dir,
      "acme-branch",
      async () => {},
    );
    expect(await Bun.file(join(dir, "deps-ran")).exists()).toBe(true);
  });
});
