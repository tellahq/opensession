/**
 * Script runs: a real script host runs a real command, and the run survives
 * the server forgetting it. A restart is simulated by dropping every bit of
 * in-memory state and reattaching from the registry file, as a fresh server
 * process does at boot.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as scripts from "./script-runs";
import type { ScriptRunRecord, ScriptRunSummary } from "./script-runs";

// Short: relay sockets live under it.
const base = mkdtempSync("/tmp/sr-");
const SESSION = "s-scripts";
const HOST = join(import.meta.dir, "../script-host/main.ts");

let wakes: Array<{ id: string; message: string }> = [];
let broadcasts: ScriptRunSummary[][] = [];
let root = "";
let logDir = "";

/** No user scope under test: a plain detached process, like a dev box. */
const launch = async (input: {
  argv: string[];
  env: Record<string, string>;
}) => {
  const proc = Bun.spawn({
    cmd: input.argv,
    env: input.env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
    detached: true,
  });
  return { pid: proc.pid, exited: proc.exited };
};

function deps(extra: Partial<scripts.ScriptRunDeps> = {}) {
  return {
    root,
    launch,
    hostArgv: [process.execPath, "run", HOST],
    deliver: async (run: ScriptRunRecord, message: string) => {
      wakes.push({ id: run.id, message });
    },
    broadcast: (_sessionId: string, runs: ScriptRunSummary[]) => {
      broadcasts.push(runs);
    },
    ...extra,
  };
}

const env = {
  PATH: process.env.PATH || "/usr/bin:/bin",
  HOME: process.env.HOME || "/tmp",
};

let n = 0;
beforeEach(() => {
  n++;
  root = join(base, `root-${n}`);
  logDir = join(base, `logs-${n}`);
  wakes = [];
  broadcasts = [];
  scripts.__resetScriptRunsForTest(deps());
});

afterEach(async () => {
  for (const run of await scripts.listScriptRuns(SESSION))
    if (run.state === "running")
      await scripts.stopScriptRun(run.id, SESSION).catch(() => {});
  for (const run of await scripts.listScriptRuns(SESSION))
    await scripts.__waitForScriptRunForTest(run.id, 15_000);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

async function start(
  command: string,
  extra: Partial<scripts.StartScriptInput> = {},
) {
  const result = await scripts.startScriptRun({
    sessionId: SESSION,
    command,
    cwd: base,
    logDir,
    env,
    ...extra,
  });
  if ("error" in result) throw new Error(result.error);
  return result.run;
}

async function waitFor(predicate: () => boolean, ms = 10_000) {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await Bun.sleep(25);
  }
}

/** A fresh server: nothing in memory, then boot recovery. */
async function restart(extra: Partial<scripts.ScriptRunDeps> = {}) {
  scripts.__simulateRestartForTest();
  await scripts.startScriptRuns(deps(extra));
}

// Real processes: a run takes longer than the 5 second default.
setDefaultTimeout(30_000);

describe("script runs", () => {
  test("marks the session busy while a run is going and refreshes its row", async () => {
    const published: string[] = [];
    scripts.__resetScriptRunsForTest(
      deps({ publishRow: (sessionId) => published.push(sessionId) }),
    );
    const run = await start("sleep 0.3");
    expect(scripts.sessionHasRunningScript(SESSION)).toBe(true);
    expect(scripts.sessionHasRunningScript("s-other")).toBe(false);
    expect(published).toEqual([SESSION]);
    await scripts.__waitForScriptRunForTest(run.id, 10_000);
    expect(scripts.sessionHasRunningScript(SESSION)).toBe(false);
    expect(published).toEqual([SESSION, SESSION]);
  });

  test("runs a command to the end, keeps its output and wakes the session once", async () => {
    const run = await start("echo hello; echo bye >&2; exit 3", {
      title: "Say hello",
    });
    expect(run.state).toBe("running");
    expect(run.title).toBe("Say hello");
    const ended = await scripts.__waitForScriptRunForTest(run.id, 10_000);
    expect(ended?.state).toBe("exited");
    expect(ended?.exitCode).toBe(3);
    expect(readFileSync(run.logPath, "utf-8")).toBe("hello\nbye\n");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.message).toContain('Script "Say hello"');
    expect(wakes[0]!.message).toContain("exited with code 3");
    expect(wakes[0]!.message).toContain("hello\nbye");
    const status = await scripts.scriptRunStatus(run.id, SESSION);
    expect(status?.outputTail).toBe("hello\nbye\n");
    // Viewers saw it start and end.
    expect(broadcasts.at(-1)?.[0]?.state).toBe("exited");
    // Another session can't see it.
    expect(await scripts.scriptRunStatus(run.id, "s-other")).toBeUndefined();
  });

  test("keeps running through a server restart and reports its end after it", async () => {
    const marker = join(base, `marker-${n}`);
    const run = await start(`sleep 1; echo done > ${marker}; echo finished`);
    await restart();
    const listed = await scripts.listScriptRuns(SESSION);
    expect(listed.find((r) => r.id === run.id)?.state).toBe("running");
    const ended = await scripts.__waitForScriptRunForTest(run.id, 10_000);
    expect(ended?.state).toBe("exited");
    expect(ended?.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(wakes.map((w) => w.id)).toEqual([run.id]);
  });

  test("a run that ended while the server was down is settled at boot", async () => {
    const run = await start("echo quick");
    scripts.__simulateRestartForTest();
    await waitFor(() => existsSync(join(root, run.id, "exit.json")));
    await scripts.startScriptRuns(deps());
    const ended = await scripts.__waitForScriptRunForTest(run.id, 5_000);
    expect(ended?.state).toBe("exited");
    expect(wakes).toHaveLength(1);
    // A second boot does not wake it again.
    await restart();
    await Bun.sleep(50);
    expect(wakes).toHaveLength(1);
  });

  test("stop ends the whole process group", async () => {
    const run = await start("sleep 30 & sleep 30; echo never");
    const stopped = await scripts.stopScriptRun(run.id, SESSION);
    // Either still on its way down, or already down.
    expect(
      "run" in stopped &&
        (stopped.run.stopping === true || stopped.run.state === "stopped"),
    ).toBe(true);
    const ended = await scripts.__waitForScriptRunForTest(run.id, 15_000);
    expect(ended?.state).toBe("stopped");
    expect(readFileSync(run.logPath, "utf-8")).not.toContain("never");
    expect(wakes[0]!.message).toContain("was stopped");
  });

  test("the host enforces the deadline", async () => {
    const run = await start("sleep 30", { timeoutMinutes: 0.01 });
    const ended = await scripts.__waitForScriptRunForTest(run.id, 15_000);
    expect(ended?.state).toBe("timed_out");
  });

  test("a host that vanished without an exit record is marked lost", async () => {
    const run = await start("sleep 30");
    await restart({ alive: async () => false, kill: async () => {} });
    const ended = await scripts.__waitForScriptRunForTest(run.id, 5_000);
    expect(ended?.state).toBe("lost");
    expect(wakes[0]!.message).toContain("was lost");
    // Clean up the real process, which the seam above said was gone.
    await waitFor(() => existsSync(join(root, run.id, "host.json")));
    const { pid } = JSON.parse(
      readFileSync(join(root, run.id, "host.json"), "utf-8"),
    );
    process.kill(pid, "SIGTERM");
    await waitFor(() => existsSync(join(root, run.id, "exit.json")));
  });

  test("rejects bad input before starting anything", async () => {
    const missing = await scripts.startScriptRun({
      sessionId: SESSION,
      command: "true",
      cwd: join(base, "nope"),
      logDir,
      env,
    });
    expect("error" in missing && missing.error).toContain("not a directory");
    const long = await scripts.startScriptRun({
      sessionId: SESSION,
      command: "true",
      cwd: base,
      logDir,
      env,
      timeoutMinutes: scripts.MAX_SCRIPT_MINUTES + 1,
    });
    expect("error" in long).toBe(true);
  });

  test("relays reach the handler, hold requests across a restart, and refuse other secrets", async () => {
    const seen: string[] = [];
    scripts.setScriptRelayHandler(async (_run, relay, path, req) => {
      relay.calls++;
      seen.push(`${req.method} ${path}`);
      return Response.json({ path });
    });
    const out = join(base, `relay-${n}.txt`);
    // First call now, second after the "restart" below.
    const run = await start(
      `curl -sf "$API_URL/v1/first" > ${out}; sleep 1.5; curl -sf "$API_URL/v1/second?x=1" >> ${out}; curl -s -o /dev/null -w '%{http_code}' "\${API_URL%/*}/wrong/v1/x" >> ${out}`,
      {
        kind: "credential",
        relays: [
          {
            env: ["API_URL"],
            service: "acme",
            host: "api.example.test",
            grantId: "kg-1",
            calls: 0,
            denied: 0,
          },
        ],
      },
    );
    expect(run.credentials?.[0]?.service).toBe("acme");
    await waitFor(() => seen.length === 1);
    // The server goes away; the host keeps the second request waiting
    // until the relay is back.
    scripts.__simulateRestartForTest();
    await Bun.sleep(1_800);
    await scripts.startScriptRuns(deps());
    scripts.setScriptRelayHandler(async (_run, relay, path, req) => {
      relay.calls++;
      seen.push(`${req.method} ${path}${new URL(req.url).search}`);
      return Response.json({ path });
    });
    const ended = await scripts.__waitForScriptRunForTest(run.id, 15_000);
    expect(ended?.state).toBe("exited");
    expect(seen).toEqual(["GET /v1/first", "GET /v1/second?x=1"]);
    expect(readFileSync(out, "utf-8")).toBe(
      '{"path":"/v1/first"}{"path":"/v1/second"}404',
    );
    // Only the hash of the secret was written down.
    const registry = readFileSync(join(root, "registry.json"), "utf-8");
    expect(registry).toContain("secretHash");
    const spec = readFileSync(join(root, run.id, "spec.json"), "utf-8");
    expect(spec).not.toContain("secret");
  });
});
