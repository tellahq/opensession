import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "node:net";
import {
  listPortalServices,
  listSandboxPortalServices,
  normalizePortalPath,
  portalsNeedingContainment,
  type PortalRecord,
  portalsToRestore,
  readPortalRegistry,
  reapOrphanedPortalServices,
  SANDBOX_PORTAL_AGENT_ENTRY,
  setPortalPath,
  startPortalService,
  startSandboxPortalService,
  stopPortalService,
  stopSandboxPortalService,
} from "./portal-supervisor";
import {
  _setHostPortalCapacityProbeForTests,
  HostPortalActivity,
  PORTAL_IDLE_MS,
} from "./portal-lifecycle";
import { sleepingSandboxPortalStatus } from "./sandbox-portals";
import type { Sandbox } from "./sandbox/provider";

let worktree = "";
const previousStateDir = process.env.OPENSESSION_STATE_DIR;
const previousPath = process.env.PATH;
const processTools = mkdtempSync(join(tmpdir(), "os-process-tools-"));
let testSetsid = Bun.which("setsid");
if (!testSetsid) {
  const shim = join(processTools, "setsid");
  writeFileSync(
    shim,
    [
      "#!/usr/bin/env python3",
      "import os, sys",
      "os.setsid()",
      "os.execvp(sys.argv[1], sys.argv[1:])",
      "",
    ].join("\n"),
  );
  chmodSync(shim, 0o755);
  testSetsid = shim;
  process.env.PATH = `${processTools}:${previousPath || ""}`;
}

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "os-portals-test-"));
  process.env.OPENSESSION_STATE_DIR = worktree;
  // Real Portals start below; the host running this suite may itself be
  // under memory pressure, which must not decide the outcome.
  _setHostPortalCapacityProbeForTests(async () => {});
});
afterAll(() => {
  _setHostPortalCapacityProbeForTests(null);
  if (worktree) rmSync(worktree, { recursive: true, force: true });
  if (previousStateDir == null) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
  if (previousPath == null) delete process.env.PATH;
  else process.env.PATH = previousPath;
  rmSync(processTools, { recursive: true, force: true });
});

describe("host Portal lifecycle cleanup", () => {
  function registry(owner: string | undefined = "owner") {
    const records: PortalRecord[] = [
      {
        name: "web",
        key: "WEB_PORT",
        command: "serve",
        port: 18091,
        state: "awake",
        sessionId: owner,
        startedAt: "2020-01-01T00:00:00Z",
      },
    ];
    writeFileSync(
      join(worktree, ".ports.conf"),
      records
        .map((record) => `# opensession-portal ${JSON.stringify(record)}`)
        .join("\n"),
    );
  }

  const owner = (archived = false) => ({
    id: "owner",
    worktreeDir: worktree,
    attachedRepos: [],
    archived,
  });

  test("archived owners no longer protect their preview, even with connections", async () => {
    registry();
    const result = await reapOrphanedPortalServices([owner(true)], {
      activePorts: new Set([18091]),
    });
    expect(result.stopped).toHaveLength(1);
    expect(readPortalRegistry(worktree)[0]?.state).toBe("stopped");
  });

  test("preserves a sibling owner's Portal in a shared worktree", async () => {
    registry();
    const result = await reapOrphanedPortalServices(
      [owner(), { ...owner(true), id: "sibling" }],
      { activePorts: new Set() },
    );
    expect(result.stopped).toEqual([]);
  });

  test("legacy ownerless Portals survive until every worktree owner archives", async () => {
    registry("");
    expect(
      (
        await reapOrphanedPortalServices([
          owner(),
          { ...owner(true), id: "sibling" },
        ])
      ).stopped,
    ).toEqual([]);
    expect(
      (await reapOrphanedPortalServices([owner(true)])).stopped,
    ).toHaveLength(1);
  });

  test("expires unused Portals but preserves HTTP activity and established connections", async () => {
    registry();
    const activity = new HostPortalActivity();
    const sweep = (
      now: number,
      ports: ReadonlySet<number> | null = new Set(),
    ) =>
      reapOrphanedPortalServices([owner()], {
        now,
        activity,
        activePorts: ports,
      });
    expect((await sweep(0)).stopped).toEqual([]);
    activity.touch(18091, PORTAL_IDLE_MS - 1);
    expect((await sweep(PORTAL_IDLE_MS)).stopped).toEqual([]);
    expect((await sweep(2 * PORTAL_IDLE_MS, new Set([18091]))).stopped).toEqual(
      [],
    );
    expect((await sweep(3 * PORTAL_IDLE_MS, null)).stopped).toEqual([]);
    expect((await sweep(3 * PORTAL_IDLE_MS)).stopped).toHaveLength(1);
  });

  test("a starved host refuses a fresh Portal and records why", async () => {
    _setHostPortalCapacityProbeForTests(async () => {
      throw new Error("Cannot start Portal: host memory is nearly full.");
    });
    await expect(
      startPortalService({
        sessionId: "owner",
        worktreeDir: worktree,
        name: "web",
        port: 18093,
        command: "sleep 60",
      }),
    ).rejects.toThrow("host memory is nearly full");
    expect(readPortalRegistry(worktree)[0]).toMatchObject({
      name: "web",
      state: "failed",
      lastError: expect.stringContaining("host memory is nearly full"),
    });
  });

  test("an expired generation cannot stop a replacement", async () => {
    registry();
    await expect(
      stopPortalService({
        sessionId: "owner",
        worktreeDir: worktree,
        name: "web",
        expectedGeneration: "obsolete",
      }),
    ).rejects.toThrow("Portal changed");
    expect(readPortalRegistry(worktree)[0]?.state).toBe("awake");
  });

  test("concurrent registry updates preserve unrelated services", async () => {
    registry();
    const web = readPortalRegistry(worktree)[0];
    writeFileSync(
      join(worktree, ".ports.conf"),
      [web, { ...web, name: "api", key: "API_PORT", port: 18092 }]
        .map((record) => `# opensession-portal ${JSON.stringify(record)}`)
        .join("\n"),
    );
    await Promise.all([
      setPortalPath(worktree, "/web", "web"),
      setPortalPath(worktree, "/api", "api"),
    ]);
    expect(
      readPortalRegistry(worktree).map((record) => record.defaultPath),
    ).toEqual(["/web", "/api"]);
  });
});

describe("portalsToRestore", () => {
  const record = (
    name: string,
    state: PortalRecord["state"],
    pid = 100,
  ): PortalRecord => ({
    name,
    key: `${name.toUpperCase()}_PORT`,
    command: `serve ${name}`,
    port: 4000,
    state,
    pid,
  });

  test("restarts only live-marked Portals the probe found dead", () => {
    const marked = [
      record("web", "awake"),
      record("api", "awake"),
      record("old", "stopped"),
      record("broken", "failed"),
    ];
    const probed = [
      record("web", "awake"),
      record("api", "failed"),
      record("old", "stopped"),
      record("broken", "failed"),
    ];
    expect(portalsToRestore(marked, probed).map((r) => r.name)).toEqual([
      "api",
    ]);
  });

  test("treats a Portal the probe no longer lists as dead", () => {
    expect(
      portalsToRestore([record("web", "awake")], []).map((r) => r.name),
    ).toEqual(["web"]);
  });

  test("leaves a starting Portal alone", () => {
    expect(
      portalsToRestore(
        [record("web", "starting")],
        [record("web", "starting")],
      ),
    ).toEqual([]);
  });
});

describe("Portal containment migration", () => {
  test("selects only live legacy host Portals when user scopes are available", () => {
    const record = (
      name: string,
      state: PortalRecord["state"],
      extra: Partial<PortalRecord> = {},
    ): PortalRecord => ({
      name,
      key: `${name.toUpperCase()}_PORT`,
      command: `serve ${name}`,
      port: 4000,
      state,
      pid: 100,
      ...extra,
    });
    const records = [
      record("awake-legacy", "awake"),
      record("starting-legacy", "starting"),
      record("managed", "awake", { scopeUnit: "opensession-preview-a" }),
      record("stopped", "stopped"),
      record("failed", "failed"),
      record("missing-pid", "awake", { pid: undefined }),
    ];

    expect(portalsNeedingContainment(records, true).map((r) => r.name)).toEqual(
      ["awake-legacy", "starting-legacy"],
    );
    expect(portalsNeedingContainment(records, false)).toEqual([]);
  });
});

describe("session Portal supervisor", () => {
  test("accepts only root-relative default routes", () => {
    expect(
      normalizePortalPath(" /video/vid_fixture/edit?status=Subtitles "),
    ).toBe("/video/vid_fixture/edit?status=Subtitles");
    expect(normalizePortalPath(" ")).toBeUndefined();
    for (const path of ["video/fixture", "//other.example/path", "/bad\npath"])
      expect(() => normalizePortalPath(path)).toThrow(
        "Portal path must be root-relative",
      );
  });

  test("launches the remote relay from the current runner layout", () => {
    expect(SANDBOX_PORTAL_AGENT_ENTRY).toEndWith(
      "/packages/core/opensession-server/src/runner-host/sandbox-portal-agent.ts",
    );
    expect(existsSync(SANDBOX_PORTAL_AGENT_ENTRY)).toBe(true);
  });

  test("keeps generated portal metadata and ports together in .ports.conf", async () => {
    writeFileSync(join(worktree, ".ports.conf"), "WEBAPP_PORT=3300\n");
    const record = {
      name: "api",
      key: "PORTAL_API_PORT",
      command: "bun run api",
      port: 4200,
      state: "stopped" as const,
    };
    writeFileSync(
      join(worktree, ".ports.conf"),
      `${PREFIX(record)}\nPORTAL_API_PORT=4200\nWEBAPP_PORT=3300\n`,
    );
    await setPortalPath(worktree, "/health", "api");
    const [portal] = readPortalRegistry(worktree);
    expect(portal).toMatchObject({
      name: "api",
      key: "PORTAL_API_PORT",
      port: 4200,
      defaultPath: "/health",
    });
    expect(Bun.file(join(worktree, ".ports.conf")).text()).resolves.toContain(
      "WEBAPP_PORT=3300",
    );
  });

  test("removes provider terminal control sequences before persisting the registry", async () => {
    const record = {
      name: "web",
      key: "WEBAPP_PORT",
      command: "just dev",
      port: 4000,
      state: "stopped" as const,
    };
    writeFileSync(
      join(worktree, ".ports.conf"),
      `\x1b]0;@modal: cat .ports.conf\x07${PREFIX(record)}\nWEBAPP_PORT=4000\n`,
    );

    await setPortalPath(worktree, "/videos", "web");

    const text = await Bun.file(join(worktree, ".ports.conf")).text();
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("@modal");
    expect(text).toContain("WEBAPP_PORT=4000");
    expect(readPortalRegistry(worktree)[0]).toMatchObject({
      defaultPath: "/videos",
    });
  });

  test("starts, verifies, and stops only its own process group", async () => {
    const port = 18_701;
    process.env.PORTAL_SUPERVISOR_TEST_SECRET = "must-not-reach-portal";
    const portal = await startPortalService({
      sessionId: "os-portal-test",
      worktreeDir: worktree,
      name: "test-app",
      port,
      command:
        "bun -e 'Bun.serve({port:Number(process.env.PORT),fetch(){return new Response(process.env.PORTAL_SUPERVISOR_TEST_SECRET || \"ok\")}})'",
    });
    expect(portal.state).toBe("awake");
    expect(portal.url).toContain(`:${port + 6000}`);
    const repeated = await startPortalService({
      sessionId: "os-portal-test",
      worktreeDir: worktree,
      name: "test-app",
      port,
      command:
        "bun -e 'Bun.serve({port:Number(process.env.PORT),fetch(){return new Response(process.env.PORTAL_SUPERVISOR_TEST_SECRET || \"ok\")}})'",
    });
    expect(repeated.pid).toBe(portal.pid);
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("ok");
    expect((await listPortalServices(worktree))[0]?.state).toBe("awake");
    await stopPortalService({
      sessionId: "os-portal-test",
      worktreeDir: worktree,
      name: "test-app",
    });
    delete process.env.PORTAL_SUPERVISOR_TEST_SECRET;
    expect((await listPortalServices(worktree))[0]?.state).toBe("stopped");
  });

  test("fails a starting record stuck past the readiness window", async () => {
    // A record poisoned before the awake-history rule: state "starting", pid
    // alive, started long ago, nothing listening. It must surface as failed.
    const wrapper = Bun.spawn(["sleep", "60"]);
    const record = {
      name: "web-stuck",
      key: "WEBAPP_PORT",
      command: "just dev",
      port: 18_779,
      state: "starting",
      pid: wrapper.pid,
      startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    };
    writeFileSync(
      join(worktree, ".ports.conf"),
      `${PREFIX(record)}\nWEBAPP_PORT=18779\n`,
    );
    const [portal] = await listPortalServices(worktree);
    expect(portal?.state).toBe("failed");
    wrapper.kill();
  });

  test("marks a crashed awake Portal failed instead of an eternal starting ghost", async () => {
    // A wrapper pid that survives its dead dev server: pid alive, port dead,
    // recorded state awake. This must surface as failed, not "starting".
    const wrapper = Bun.spawn(["sleep", "60"]);
    const record = {
      name: "web-crashed",
      key: "WEBAPP_PORT",
      command: "just dev",
      port: 18_777,
      state: "awake",
      pid: wrapper.pid,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(worktree, ".ports.conf"),
      `${PREFIX(record)}\nWEBAPP_PORT=18777\n`,
    );
    const [portal] = await listPortalServices(worktree);
    expect(portal?.state).toBe("failed");
    wrapper.kill();
  });

  test("starting over a failed Portal reaps its leftover process group", async () => {
    const leftover = Bun.spawn(["sleep", "60"]);
    const record = {
      name: "web-retry",
      key: "WEBAPP_PORT",
      command: "just dev",
      port: 18_778,
      state: "failed",
      pid: leftover.pid,
      lastError: "The service is no longer listening.",
    };
    writeFileSync(
      join(worktree, ".ports.conf"),
      `${PREFIX(record)}\nWEBAPP_PORT=18778\n`,
    );
    const portal = await startPortalService({
      sessionId: "os-retry-test",
      worktreeDir: worktree,
      name: "web-retry",
      port: 18_778,
      command:
        "bun -e 'Bun.serve({port:Number(process.env.PORT),fetch(){return new Response(\"ok\")}})'",
    });
    expect(portal.state).toBe("awake");
    expect(
      Bun.spawnSync(["kill", "-0", String(leftover.pid)]).exitCode,
    ).not.toBe(0);
    await stopPortalService({
      sessionId: "os-retry-test",
      worktreeDir: worktree,
      name: "web-retry",
    });
  });

  test("terminates a Portal process group when readiness times out", async () => {
    const port = 18_704;
    const pidFile = join(worktree, "timed-out.pid");
    await expect(
      startPortalService({
        sessionId: "os-timeout-test",
        worktreeDir: worktree,
        name: "slow-app",
        port,
        command: `bash -c 'echo $$ > ${pidFile}; exec sleep 60'`,
        readyTimeoutMs: 5_000,
      }),
    ).rejects.toThrow("Nothing listened on port 18704 within 5 seconds.");
    const pid = Number(await Bun.file(pidFile).text());
    expect(pid).toBeGreaterThan(1);
    expect(() => process.kill(pid, 0)).toThrow();
    const failed = readPortalRegistry(worktree)[0];
    expect(failed).toMatchObject({ name: "slow-app", state: "failed" });
    expect(failed?.pid).toBeUndefined();
  }, 10_000);

  test("reaps a Portal whose durable owner no longer owns the worktree", async () => {
    const port = 18_703;
    await startPortalService({
      sessionId: "deleted-session",
      worktreeDir: worktree,
      name: "orphan",
      port,
      command:
        "bun -e 'Bun.serve({port:Number(process.env.PORT),fetch(){return new Response(\"orphan\")}})'",
    });
    expect(readPortalRegistry(worktree)[0]).toMatchObject({
      sessionId: "deleted-session",
      state: "awake",
    });
    expect(
      (
        await reapOrphanedPortalServices([
          { id: "deleted-session", worktreeDir: worktree, attachedRepos: [] },
        ])
      ).stopped,
    ).toEqual([]);
    expect((await listPortalServices(worktree))[0]?.state).toBe("awake");

    const result = await reapOrphanedPortalServices([
      { id: "replacement-session", worktreeDir: worktree, attachedRepos: [] },
    ]);
    expect(result.stopped).toEqual([
      expect.objectContaining({
        sessionId: "deleted-session",
        worktreeDir: worktree,
        name: "orphan",
      }),
    ]);
    expect((await listPortalServices(worktree))[0]?.state).toBe("stopped");
  });

  test("a worktree spelled through a symlink is the same worktree to the reaper", async () => {
    const alias = join(
      mkdtempSync(join(tmpdir(), "os-portals-alias-")),
      "repo",
    );
    symlinkSync(worktree, alias);
    await startPortalService({
      sessionId: "owner",
      worktreeDir: worktree,
      name: "shared",
      port: 18_705,
      command:
        "bun -e 'Bun.serve({port:Number(process.env.PORT),fetch(){return new Response(\"shared\")}})'",
    });
    // Another live session records the same checkout under its alias. Keyed
    // by spelling, the registry read under the alias saw only that session
    // as owner and reaped the Portal.
    const result = await reapOrphanedPortalServices([
      { id: "owner", worktreeDir: worktree, attachedRepos: [] },
      { id: "other", worktreeDir: alias, attachedRepos: [] },
    ]);
    expect(result.stopped).toEqual([]);
    expect((await listPortalServices(worktree))[0]?.state).toBe("awake");
    await stopPortalService({
      sessionId: "owner",
      worktreeDir: worktree,
      name: "shared",
    });
  });

  test("supervises and deduplicates a Portal through the Sandbox execution boundary", async () => {
    const port = await freePort();
    const sandbox = sandboxFor(worktree, port);
    const input = {
      sessionId: "os-sandbox-portal-test",
      sandbox,
      name: "remote-app",
      port,
      // Absolute interpreter path: the sandbox launch line pins PATH to the
      // real sandbox layout (/home/ubuntu/.bun/bin), which this host-executed
      // fake does not have on CI — a bare `bun` exits before listening there.
      command: `${process.execPath} -e 'Bun.serve({port:Number(process.env.PORT),fetch(){return new Response("sandbox")}})'`,
    };
    const [portal, duplicate] = await Promise.all([
      startSandboxPortalService(input),
      startSandboxPortalService(input),
    ]);
    expect(portal.state).toBe("awake");
    expect(duplicate.pid).toBe(portal.pid);
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe(
      "sandbox",
    );
    expect(
      existsSync(join(worktree, ".opensession-portal-remote-app.log")),
    ).toBe(false);
    expect((await listSandboxPortalServices(sandbox))[0]).toMatchObject({
      name: "remote-app",
      state: "awake",
    });
    expect(
      sleepingSandboxPortalStatus("os-sandbox-portal-test", sandbox.id)
        ?.services,
    ).toEqual([
      expect.objectContaining({
        name: "remote-app",
        state: "sleeping",
        managed: true,
      }),
    ]);
    await stopSandboxPortalService({
      sessionId: "os-sandbox-portal-test",
      sandbox,
      name: "remote-app",
    });
    expect((await listSandboxPortalServices(sandbox))[0]?.state).toBe(
      "stopped",
    );
    expect(
      sleepingSandboxPortalStatus("os-sandbox-portal-test", sandbox.id)
        ?.services,
    ).toEqual([
      expect.objectContaining({
        name: "remote-app",
        state: "stopped",
        managed: true,
      }),
    ]);
  }, 10_000);
});

function PREFIX(record: unknown): string {
  return `# opensession-portal ${JSON.stringify(record)}`;
}

async function freePort(): Promise<number> {
  for (let offset = 0; offset < 1_000; offset++) {
    const port = 18_000 + ((process.pid + offset) % 1_000);
    const server = createServer();
    const available = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (!available) continue;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }
  throw new Error("no free Portal test port");
}

function sandboxFor(cwd: string, port: number): Sandbox {
  // The fake runs Sandbox commands on the host. Translate the guest's fixed
  // scratch root so macOS and non-root Linux tests do not write /home/ubuntu.
  const guestScratchRoot = "/home/ubuntu/.opensession/session-scratch";
  const hostScratchRoot = join(cwd, ".sandbox-session-scratch");
  const commandForHarness = (command: string[]) =>
    command.map((part) => {
      const withHostScratch = part.replaceAll(
        guestScratchRoot,
        hostScratchRoot,
      );
      return testSetsid
        ? withHostScratch.replace(/\bsetsid\b/g, testSetsid)
        : withHostScratch;
    });
  return {
    id: "sandbox-portal-test",
    provider: "local",
    cwd,
    async exec(command, options) {
      if (options?.background) {
        const proc = Bun.spawn(commandForHarness(command), {
          cwd,
          env: { ...process.env, ...options.env },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        proc.unref();
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const proc = Bun.spawn(commandForHarness(command), {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, stdout, stderr };
    },
    launchRun: () => {
      throw new Error("not used");
    },
    async ports() {
      return { [port]: port };
    },
    async status() {
      return "running";
    },
  };
}
