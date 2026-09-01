import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "node:net";
import {
  listPortalServices,
  listSandboxPortalServices,
  normalizePortalPath,
  readPortalRegistry,
  reapOrphanedPortalServices,
  SANDBOX_PORTAL_AGENT_ENTRY,
  setPortalPath,
  startPortalService,
  startSandboxPortalService,
  stopPortalService,
  stopSandboxPortalService,
} from "./portal-supervisor";
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
});
afterAll(() => {
  if (worktree) rmSync(worktree, { recursive: true, force: true });
  if (previousStateDir == null) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
  if (previousPath == null) delete process.env.PATH;
  else process.env.PATH = previousPath;
  rmSync(processTools, { recursive: true, force: true });
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

  test("keeps generated portal metadata and ports together in .ports.conf", () => {
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
    setPortalPath(worktree, "/health", "api");
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

    setPortalPath(worktree, "/videos", "web");

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
  });
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
  const commandForHarness = (command: string[]) =>
    testSetsid
      ? command.map((part) => part.replace(/\bsetsid\b/g, testSetsid!))
      : command;
  return {
    id: "sandbox-portal-test",
    provider: "docker",
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
