const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const {
  LocalServer,
  loginShellPath,
  mergePath,
  projectsFolder,
} = require("./local-server");

// A stand-in for the compiled server: the same three roles, each recording how
// it was started, with its behavior read from a file beside it.
const FAKE = `#!${process.execPath}
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
const role = process.argv[2];
let behavior = {};
try { behavior = JSON.parse(fs.readFileSync(path.join(dir, "behavior.json"), "utf8")); } catch {}
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ role, pid: process.pid, env: process.env }) + "\\n");
process.on("SIGTERM", () => {
  fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ role, stopped: true }) + "\\n");
  process.exit(0);
});
if (role === "seed-session-catalogs") process.exit(behavior.seedExit || 0);
if (behavior[role + "Exit"] !== undefined) {
  console.error("fake " + role + " giving up");
  process.exit(behavior[role + "Exit"]);
}
const port = role === "server" ? process.env.PORT : process.env.OPENSESSION_SESSION_KERNEL_PORT;
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, role }));
}).listen(Number(port), "127.0.0.1");
`;

let base;
let releaseDir;
let home;
let servers;

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function make(overrides = {}) {
  const server = new LocalServer({
    releaseDir,
    home,
    env: { PATH: process.env.PATH, USER: "ada", SECRET_OF_THE_APP: "no" },
    resolvePath: async () => process.env.PATH,
    // A Mac with Claude Code installed, and no internet to fetch one from.
    findTool: () => "/usr/local/bin/claude",
    download: async () => {
      throw new Error("no network in tests");
    },
    preferredPorts: {
      port: await freePort(),
      kernelPort: await freePort(),
      ingressPort: await freePort(),
    },
    readyTimeouts: { kernel: 10_000, server: 10_000 },
    ...overrides,
  });
  servers.push(server);
  return server;
}

function calls() {
  try {
    return fs
      .readFileSync(path.join(releaseDir, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function behave(behavior) {
  fs.writeFileSync(
    path.join(releaseDir, "behavior.json"),
    JSON.stringify(behavior),
  );
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "os1-local-server-"));
  releaseDir = path.join(base, "release");
  home = path.join(base, "home");
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(releaseDir, "opensession"), FAKE, { mode: 0o755 });
  servers = [];
});

afterEach(async () => {
  for (const server of servers) await server.stop().catch(() => {});
  fs.rmSync(base, { recursive: true, force: true });
});

describe("LocalServer", () => {
  test("is unavailable in a build that carries no server", async () => {
    const server = await make({ releaseDir: path.join(base, "missing") });
    expect(server.available()).toBe(false);
    await expect(server.start()).rejects.toThrow(/does not include/);
    expect(server.status().state).toBe("failed");
  });

  test("starts the store, seeds it, then the server, and stops both", async () => {
    const server = await make();
    const states = [];
    server.on("state", (status) => states.push(status.state));

    const url = await server.start();
    expect(url).toBe(`http://127.0.0.1:${server.ports.port}/`);
    expect((await fetch(`${url}api/health`)).ok).toBe(true);

    const started = calls().filter((call) => call.pid);
    expect(started.map((call) => call.role)).toEqual([
      "session-kernel-service",
      "seed-session-catalogs",
      "server",
    ]);
    const env = started[2].env;
    // Its own state, ports and ownership lock: a server installed from the
    // command line on the same machine is never touched.
    expect(env.OPENSESSION_STATE_DIR).toBe(path.join(home, ".opensession-app"));
    expect(env.OPENSESSION_DEPLOY_STATE).toBe(
      path.join(home, ".opensession-app", "deploy"),
    );
    expect(env.PORT).toBe(String(server.ports.port));
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.OPENSESSION_PUBLIC_INGRESS_PORT).toBe(
      String(server.ports.ingressPort),
    );
    expect(env.OPENSESSION_LOOPBACK_HOSTS_ONLY).toBe("1");
    // Turns live inside the server, so they end with the app.
    expect(env.OPENSESSION_EXECUTOR).toBe("0");
    expect(env.OPENSESSION_PI_DETACH).toBe("0");
    // And when the app dies without stopping it, the server ends itself: the
    // session store last, so runs drain while it still answers.
    expect(env.OPENSESSION_EXIT_WITH_PARENT).toBe(String(process.pid));
    expect(env.OPENSESSION_EXIT_WITH_PARENT_DELAY_MS).toBeUndefined();
    expect(started[0].env.OPENSESSION_EXIT_WITH_PARENT).toBe(
      String(process.pid),
    );
    expect(
      Number(started[0].env.OPENSESSION_EXIT_WITH_PARENT_DELAY_MS),
    ).toBeGreaterThan(Number(env.SHUTDOWN_DRAIN_MS));
    expect(env.OPENSESSION_SESSION_KERNEL_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(env.OPENSESSION_SESSION_KERNEL_TOKEN).toBe(
      started[0].env.OPENSESSION_SESSION_KERNEL_TOKEN,
    );
    expect(env.HOME).toBe(home);
    // The Mac's own Claude Code is used as it is, found on PATH. Codex's
    // stand-in comes last, so one the person installed wins.
    expect(env.OPENSESSION_CLAUDE_BIN).toBeUndefined();
    expect(env.OPENSESSION_CLAUDE_AUTO_UPDATE).toBeUndefined();
    const toolsBin = path.join(home, ".opensession-app", "tools", "bin");
    expect(env.PATH.split(":").at(-1)).toBe(toolsBin);
    expect(fs.statSync(path.join(toolsBin, "codex")).mode & 0o111).toBe(0o111);
    expect(env.USER).toBe("ada");
    expect(env.SECRET_OF_THE_APP).toBeUndefined();

    const pids = [started[0].pid, started[2].pid];
    expect(server.readPlan().pids.sort()).toEqual([...pids].sort());
    await server.stop();
    expect(states).toEqual(["starting", "ready", "stopping", "stopped"]);
    expect(await until(() => !alive(pids[0]) && !alive(pids[1]))).toBe(true);
    // The server goes first, so its runs drain while the store still answers.
    const stopped = calls().filter((call) => call.stopped);
    expect(stopped.map((call) => call.role)).toEqual([
      "server",
      "session-kernel-service",
    ]);
    expect(server.readPlan().pids).toEqual([]);
  });

  test("writes the first configuration once and then leaves it alone", async () => {
    const server = await make();
    await server.start();
    const configFile = path.join(
      home,
      ".opensession-app",
      ".opensession",
      "config.json",
    );
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    expect(config.paths).toEqual({
      worktreesDir: path.join(home, "OpenSession", "workspaces"),
      reposDir: path.join(home, "OpenSession", "repos"),
    });
    expect(config.repos.scratch.repo).toBe(
      path.join(home, "OpenSession", "repos", "scratch"),
    );
    expect(fs.existsSync(path.join(config.repos.scratch.repo, ".git"))).toBe(
      true,
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(home, ".opensession-app", ".opensession-pi.json"),
          "utf8",
        ),
      ),
    ).toEqual({ enabled: true });
    await server.stop();

    fs.writeFileSync(configFile, JSON.stringify({ repos: {}, mine: true }));
    await server.start();
    expect(JSON.parse(fs.readFileSync(configFile, "utf8")).mine).toBe(true);
  });

  test("keeps its address between launches and moves when it is taken", async () => {
    const first = await make();
    const url = await first.url();
    const again = await make();
    expect(await again.url()).toBe(url);

    const squatter = net.createServer();
    await new Promise((resolve) =>
      squatter.listen(first.ports.port, "127.0.0.1", resolve),
    );
    try {
      const moved = await make();
      expect(await moved.url()).not.toBe(url);
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  test("reports a server that exits while starting and leaves nothing running", async () => {
    behave({ serverExit: 3 });
    const server = await make();
    await expect(server.start()).rejects.toThrow(/stopped while starting/);
    const status = server.status();
    expect(status.state).toBe("failed");
    expect(status.error).toContain("exit 3");
    expect(server.recentOutput()).toContain("fake server giving up");
    const kernel = calls().find(
      (call) => call.role === "session-kernel-service" && call.pid,
    );
    expect(await until(() => !alive(kernel.pid))).toBe(true);

    // The retry the page offers.
    behave({});
    await server.start();
    expect(server.status().state).toBe("ready");
  });

  test("a failed seed does not start the server", async () => {
    behave({ seedExit: 2 });
    const server = await make();
    await expect(server.start()).rejects.toThrow(/exit 2/);
    expect(calls().some((call) => call.role === "server")).toBe(false);
  });

  test("starts again when a process dies while the app is running", async () => {
    const server = await make();
    await server.start();
    const gateway = calls().find((call) => call.role === "server" && call.pid);
    process.kill(gateway.pid, "SIGKILL");
    expect(
      await until(
        () =>
          server.status().state === "ready" &&
          calls().filter((call) => call.role === "server" && call.pid)
            .length === 2,
      ),
    ).toBe(true);
    expect((await fetch(`${await server.url()}api/health`)).ok).toBe(true);
  });

  test("ends what a force-quit app left behind before starting", async () => {
    const crashed = await make();
    await crashed.start();
    const left = crashed.readPlan().pids;
    expect(left.length).toBe(2);
    // The app went away without stopping anything.
    servers.splice(servers.indexOf(crashed), 1);
    crashed.removeAllListeners();
    crashed.state = "abandoned";

    const next = await make({ preferredPorts: crashed.preferredPorts });
    const url = await next.start();
    expect(left.some(alive)).toBe(false);
    // Same address as before, because the old processes no longer hold it.
    expect(url).toBe(`http://127.0.0.1:${crashed.ports.port}/`);
  });

  test("a stop during start wins", async () => {
    const server = await make();
    const starting = server.start().catch((error) => error);
    await until(() => calls().length > 0);
    await server.stop();
    expect(await starting).toBeInstanceOf(Error);
    expect(server.status().state).toBe("stopped");
    const pids = calls()
      .filter((call) => call.pid && call.role !== "seed-session-catalogs")
      .map((call) => call.pid);
    expect(await until(() => !pids.some(alive))).toBe(true);
  });
});

describe("a Mac without Claude Code", () => {
  const managed = () =>
    path.join(home, ".opensession-app", "tools", "claude", "current", "claude");
  // Stands in for local-tools.js: fetches when told to, and says what it did.
  function fakeTools({ fail = false } = {}) {
    const dir = path.join(home, ".opensession-app", "tools");
    const tools = {
      binDir: path.join(dir, "bin"),
      has: false,
      watched: null,
      stops: 0,
      release: null,
      label: () => "Claude Code",
      path: () => managed(),
      installed: () => (tools.has ? "9.9.1" : null),
      prepare: () => {},
      watch: (options) => (tools.watched = options),
      stop: () => {
        tools.stops++;
        tools.release?.(new Error("cancelled"));
      },
      ensure: async (_name, { onProgress }) => {
        onProgress(40, 100);
        await new Promise((resolve, reject) => {
          tools.release = (error) => (error ? reject(error) : resolve());
          if (tools.hold) return;
          if (fail) reject(new Error("offline"));
          else resolve();
        });
        onProgress(100, 100);
        tools.has = true;
      },
    };
    return tools;
  }

  test("downloads it before the first start and points the server at it", async () => {
    const tools = fakeTools();
    const server = await make({ findTool: () => null, tools });
    const steps = [];
    server.on("state", (status) => steps.push([status.state, status.step]));
    await server.start();

    expect(steps).toContainEqual([
      "starting",
      { label: "Claude Code", done: 100, total: 100 },
    ]);
    expect(steps.at(-1)).toEqual(["ready", null]);
    const env = calls().find((call) => call.role === "server").env;
    expect(env.OPENSESSION_CLAUDE_BIN).toBe(managed());
    // The app replaces its copy itself.
    expect(env.OPENSESSION_CLAUDE_AUTO_UPDATE).toBe("0");
    expect(tools.watched).toEqual({ manage: ["claude"] });
  });

  test("starts without it when the download fails, and keeps trying", async () => {
    const tools = fakeTools({ fail: true });
    const server = await make({ findTool: () => null, tools });
    await server.start();
    expect(server.status().state).toBe("ready");
    const env = calls().find((call) => call.role === "server").env;
    // Still where the server looks, so a later download is picked up.
    expect(env.OPENSESSION_CLAUDE_BIN).toBe(managed());
    expect(tools.watched).toEqual({ manage: ["claude"] });
    expect(server.recentOutput()).toContain(
      "Claude Code could not be downloaded: offline",
    );
  });

  test("does not download again once it has a copy", async () => {
    const tools = fakeTools();
    tools.has = true;
    tools.ensure = async () => {
      throw new Error("should not be asked");
    };
    const server = await make({ findTool: () => null, tools });
    await server.start();
    expect(server.recentOutput()).toBe("");
    expect(
      calls().find((call) => call.role === "server").env.OPENSESSION_CLAUDE_BIN,
    ).toBe(managed());
  });

  test("a stop during the download starts nothing", async () => {
    const tools = fakeTools();
    tools.hold = true;
    const server = await make({ findTool: () => null, tools });
    const starting = server.start();
    expect(await until(() => !!tools.release)).toBe(true);
    await server.stop();
    await expect(starting).rejects.toThrow(/cancelled/);
    expect(server.status().state).toBe("stopped");
    expect(calls()).toEqual([]);
  });
});

describe("the folder for repositories and workspaces", () => {
  test("is ~/OpenSession on a Mac that has none, and again once it is ours", () => {
    expect(projectsFolder(home)).toBe(path.join(home, "OpenSession"));
    fs.mkdirSync(path.join(home, "OpenSession", "repos"), { recursive: true });
    fs.mkdirSync(path.join(home, "OpenSession", "workspaces"));
    fs.writeFileSync(path.join(home, "OpenSession", ".DS_Store"), "");
    expect(projectsFolder(home)).toBe(path.join(home, "OpenSession"));
  });

  test("leaves a folder of that name that holds something else alone", async () => {
    // What ~/opensession is on a Mac whose file system ignores case.
    fs.mkdirSync(path.join(home, "OpenSession", ".git"), { recursive: true });
    fs.writeFileSync(path.join(home, "OpenSession", "package.json"), "{}");
    expect(projectsFolder(home)).toBe(path.join(home, "OpenSessionLocal"));

    const server = await make();
    await server.start();
    const config = JSON.parse(
      fs.readFileSync(
        path.join(home, ".opensession-app", ".opensession", "config.json"),
        "utf8",
      ),
    );
    expect(config.paths.reposDir).toBe(
      path.join(home, "OpenSessionLocal", "repos"),
    );
    expect(fs.readdirSync(path.join(home, "OpenSession")).sort()).toEqual([
      ".git",
      "package.json",
    ]);
  });
});

describe("the login shell's PATH", () => {
  test("is read from between markers, ignoring what startup files print", async () => {
    const execFile = (_shell, _args, _options, callback) =>
      callback(
        null,
        "Welcome back!\n__OS1_PATH__/opt/homebrew/bin:/usr/bin__OS1_PATH__\n",
      );
    expect(await loginShellPath({ execFile })).toBe(
      "/opt/homebrew/bin:/usr/bin",
    );
  });

  test("is null when the shell did not answer", async () => {
    const execFile = (_shell, _args, _options, callback) =>
      callback(new Error("timed out"), "");
    expect(await loginShellPath({ execFile })).toBeNull();
  });

  test("gains the usual tool folders once, in order", () => {
    const merged = mergePath("/custom/bin:/usr/bin", "/Users/ada").split(":");
    expect(merged[0]).toBe("/custom/bin");
    expect(merged).toContain("/Users/ada/.local/bin");
    expect(merged).toContain("/opt/homebrew/bin");
    expect(merged.filter((entry) => entry === "/usr/bin").length).toBe(1);
  });
});
