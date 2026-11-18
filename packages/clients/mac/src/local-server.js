// "This Mac": the Open Session server the app carries and runs itself, so the
// app works with no server set up anywhere. The compiled server release sits
// in the app's resources; this module starts it on loopback, keeps it running
// while the app runs, and stops it on quit. The window then loads its UI from
// that server exactly as it would from a remote one.
//
// The server is two processes plus a one-shot step, in the order the
// command-line install uses (`opensession start --foreground`): the session
// kernel, the catalog seed, then the gateway. They get their own state folder,
// ports and ownership lock, so a server installed from the command line on the
// same machine is never touched.
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

// Away from 3850/3849/3860, which a command-line install uses.
const PREFERRED_PORTS = { port: 47850, kernelPort: 47849, ingressPort: 47860 };
const KERNEL_READY_MS = 60_000;
const SERVER_READY_MS = 120_000;
// The gateway drains in-flight runs for this long before it exits. Quitting
// the app waits for it, so it is shorter than the server's own default.
const DRAIN_MS = 5_000;
const KILL_AFTER_MS = DRAIN_MS + 5_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const TAIL_LINES = 40;
// A server that keeps dying is reported instead of restarted forever.
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60_000;
// A GUI app gets launchd's bare PATH. These are where a developer's tools
// usually are when the login shell cannot be asked.
const FALLBACK_PATH = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];
const PATH_MARK = "__OS1_PATH__";

function validPort(value) {
  return Number.isInteger(value) && value > 0 && value < 65536;
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: "127.0.0.1", exclusive: true }, () =>
      probe.close(() => resolve(true)),
    );
  });
}

function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen({ port: 0, host: "127.0.0.1" }, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** The login shell's PATH, where Homebrew, `claude`, `gh` and friends are.
 * Shell startup files can print anything, so the value is read from between
 * two markers. Null when the shell did not answer in time. */
function loginShellPath({
  shell = process.env.SHELL || "/bin/zsh",
  execFile = childProcess.execFile,
  timeoutMs = 5_000,
} = {}) {
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-ilc", `printf '${PATH_MARK}%s${PATH_MARK}' "$PATH"`],
      { timeout: timeoutMs, encoding: "utf8", windowsHide: true },
      (_error, stdout) => {
        const match = String(stdout || "").match(
          new RegExp(`${PATH_MARK}(.*?)${PATH_MARK}`, "s"),
        );
        resolve(match && match[1].trim() ? match[1].trim() : null);
      },
    );
  });
}

function mergePath(resolved, home) {
  const entries = [
    ...String(resolved || "").split(":"),
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    ...FALLBACK_PATH,
  ].filter(Boolean);
  return [...new Set(entries)].join(":");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

class LocalServerError extends Error {}

class LocalServer extends EventEmitter {
  constructor({
    // The unpacked server release: the `opensession` executable with its
    // worker and wasm files beside it.
    releaseDir,
    home = os.homedir(),
    stateDir = path.join(home, ".opensession-app"),
    reposDir = path.join(home, "OpenSession", "repos"),
    workspacesDir = path.join(home, "OpenSession", "workspaces"),
    env = process.env,
    spawn = childProcess.spawn,
    execFile = childProcess.execFile,
    fetch = globalThis.fetch,
    resolvePath = loginShellPath,
    preferredPorts = PREFERRED_PORTS,
    readyTimeouts = { kernel: KERNEL_READY_MS, server: SERVER_READY_MS },
  }) {
    super();
    this.releaseDir = releaseDir;
    this.binary = releaseDir ? path.join(releaseDir, "opensession") : null;
    this.home = home;
    this.stateDir = stateDir;
    this.reposDir = reposDir;
    this.workspacesDir = workspacesDir;
    this.env = env;
    this.spawn = spawn;
    this.execFile = execFile;
    this.fetch = fetch;
    this.resolvePath = resolvePath;
    this.preferredPorts = preferredPorts;
    this.readyTimeouts = readyTimeouts;
    this.state = "stopped";
    this.error = null;
    this.ports = null;
    this.kernel = null;
    this.gateway = null;
    this.starting = null;
    this.stopping = null;
    this.restarts = [];
    this.tail = [];
  }

  /** Whether this build of the app carries a server at all. */
  available() {
    return !!this.binary && exists(this.binary);
  }

  get logDir() {
    return path.join(this.stateDir, "logs");
  }

  get planFile() {
    return path.join(this.stateDir, "app.json");
  }

  readPlan() {
    try {
      const plan = JSON.parse(fs.readFileSync(this.planFile, "utf8"));
      return plan && typeof plan === "object" ? plan : {};
    } catch {
      return {};
    }
  }

  writePlan(plan) {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.planFile, JSON.stringify(plan, null, 2), {
      mode: 0o600,
    });
  }

  /** The address the server will answer on. The port is chosen once and kept:
   * the web app's preferences and drafts are stored per origin, so a port
   * that moved between launches would look like a fresh install each time. */
  async url() {
    const ports = await this.resolvePorts();
    return `http://127.0.0.1:${ports.port}/`;
  }

  async resolvePorts() {
    if (this.ports) return this.ports;
    const plan = this.readPlan();
    const ports = {};
    const taken = new Set();
    for (const key of Object.keys(PREFERRED_PORTS)) {
      const candidates = [plan[key], this.preferredPorts[key]].filter(
        validPort,
      );
      let chosen = null;
      for (const candidate of candidates) {
        if (!taken.has(candidate) && (await portFree(candidate))) {
          chosen = candidate;
          break;
        }
      }
      while (!chosen || taken.has(chosen)) chosen = await ephemeralPort();
      taken.add(chosen);
      ports[key] = chosen;
    }
    this.ports = ports;
    this.writePlan({ ...plan, ...ports });
    return ports;
  }

  setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit("state", this.status());
  }

  status() {
    return {
      state: this.state,
      error: this.error,
      url: this.ports ? `http://127.0.0.1:${this.ports.port}/` : null,
      logDir: this.logDir,
    };
  }

  /** Start the server, or join a start already under way. Resolves with its
   * address once it answers health checks. */
  start() {
    if (this.state === "ready") return this.url();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (this.stopping) await this.stopping;
      this.setState("starting");
      try {
        await this.boot();
        this.setState("ready");
        return await this.url();
      } catch (error) {
        await this.teardown();
        // A stop that interrupted the start owns the state from here.
        if (this.state === "starting")
          this.setState("failed", this.describe(error));
        throw error;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  describe(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message || "The local server did not start.";
  }

  async boot() {
    if (!this.available())
      throw new LocalServerError(
        "This build of the app does not include the local server.",
      );
    await this.killLeftovers();
    this.ports = null;
    const ports = await this.resolvePorts();
    const childEnv = await this.childEnvironment(ports);
    await this.seedState(childEnv);
    fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 });

    this.kernel = this.launch("kernel", ["session-kernel-service"], childEnv);
    this.rememberPids();
    await this.waitFor(
      "The session store",
      this.kernel,
      `http://127.0.0.1:${ports.kernelPort}/`,
      this.readyTimeouts.kernel,
      () => true,
    );

    const seed = await this.runOnce(["seed-session-catalogs"], childEnv);
    if (seed !== 0)
      throw new LocalServerError(
        `Preparing the session store failed (exit ${seed}).`,
      );

    this.gateway = this.launch("server", ["server"], childEnv);
    this.rememberPids();
    await this.waitFor(
      "The server",
      this.gateway,
      `http://127.0.0.1:${ports.port}/api/health`,
      this.readyTimeouts.server,
      (response) => response.ok,
    );
  }

  async childEnvironment(ports) {
    const resolved = await this.resolvePath().catch(() => null);
    const origin = `http://127.0.0.1:${ports.port}`;
    const kept = {};
    // What git, ssh and the model CLIs need from the person's session, and
    // nothing else of the app's own environment.
    for (const key of [
      "USER",
      "LOGNAME",
      "SHELL",
      "LANG",
      "LC_ALL",
      "TMPDIR",
      "SSH_AUTH_SOCK",
      "__CF_USER_TEXT_ENCODING",
    ]) {
      if (this.env[key]) kept[key] = this.env[key];
    }
    return {
      ...kept,
      HOME: this.home,
      PATH: mergePath(resolved || this.env.PATH, this.home),
      NODE_ENV: "production",
      OPENSESSION_STATE_DIR: this.stateDir,
      OPENSESSION_DEPLOY_STATE: path.join(this.stateDir, "deploy"),
      OPENSESSION_SESSION_KERNEL_TOKEN: crypto.randomBytes(32).toString("hex"),
      OPENSESSION_SESSION_KERNEL_PORT: String(ports.kernelPort),
      OPENSESSION_SESSION_KERNEL_URL: `http://127.0.0.1:${ports.kernelPort}`,
      OPENSESSION_PUBLIC_INGRESS_PORT: String(ports.ingressPort),
      HOST: "127.0.0.1",
      PORT: String(ports.port),
      OPENSESSION_UI_BASE: origin,
      // Only ever addressed as this machine, so a web page whose domain was
      // re-pointed at 127.0.0.1 is refused.
      OPENSESSION_LOOPBACK_HOSTS_ONLY: "1",
      // Turns run inside the server process, so they end when the app quits
      // and nothing is left running in the background.
      OPENSESSION_EXECUTOR: "0",
      OPENSESSION_PI_DETACH: "0",
      SHUTDOWN_DRAIN_MS: String(DRAIN_MS),
    };
  }

  /** First launch only: a config with the two folders, the engine switched
   * on, and one repository to try a session in. Later launches leave all of
   * it alone, so changes made in the app's settings stay. */
  async seedState(childEnv) {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.reposDir, { recursive: true });
    fs.mkdirSync(this.workspacesDir, { recursive: true });

    const engineFile = path.join(this.stateDir, ".opensession-pi.json");
    if (!exists(engineFile))
      fs.writeFileSync(engineFile, JSON.stringify({ enabled: true }, null, 2));

    const configFile = path.join(this.stateDir, ".opensession", "config.json");
    if (exists(configFile)) return;
    const scratch = path.join(this.reposDir, "scratch");
    await this.ensureScratchRepo(scratch, childEnv);
    const config = {
      onboardingCompleted: false,
      paths: { worktreesDir: this.workspacesDir, reposDir: this.reposDir },
      repos: {
        scratch: {
          label: "Scratch",
          repo: scratch,
          wtPrefix: "scratch",
          defaultBranch: "main",
          default: true,
        },
      },
      identity: { team: [{ name: "Local User" }] },
    };
    fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
    });
  }

  /** A real repository with one commit: a session needs one to branch from. */
  async ensureScratchRepo(dir, childEnv) {
    if (exists(path.join(dir, ".git"))) return;
    fs.mkdirSync(dir, { recursive: true });
    const git = (...args) =>
      new Promise((resolve, reject) => {
        this.execFile(
          "git",
          ["-C", dir, ...args],
          { env: childEnv, timeout: 30_000, encoding: "utf8" },
          (error, _stdout, stderr) => {
            if (!error) return resolve();
            reject(
              new LocalServerError(
                error.code === "ENOENT"
                  ? "Git is not installed. Install the Xcode Command Line Tools with `xcode-select --install`, then try again."
                  : `Creating the first repository failed: ${String(stderr || error.message).trim()}`,
              ),
            );
          },
        );
      });
    await git("init", "-q", "-b", "main");
    fs.writeFileSync(
      path.join(dir, "README.md"),
      "# Scratch\n\nA repository for trying Open Session. Add your own under Settings → Repositories.\n",
    );
    await git("add", "README.md");
    await git(
      "-c",
      "user.name=Open Session",
      "-c",
      "user.email=opensession@localhost",
      "commit",
      "-q",
      "-m",
      "Scratch repository for a first session",
    );
  }

  logStream(name) {
    const file = path.join(this.logDir, `${name}.log`);
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES)
        fs.renameSync(file, `${file}.1`);
    } catch {}
    return fs.createWriteStream(file, { flags: "a", mode: 0o600 });
  }

  remember(name, chunk) {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      this.tail.push(`[${name}] ${line}`);
    }
    if (this.tail.length > TAIL_LINES)
      this.tail.splice(0, this.tail.length - TAIL_LINES);
  }

  launch(name, args, childEnv) {
    const log = this.logStream(name);
    log.on("error", () => {});
    const child = this.spawn(this.binary, args, {
      // Never the release folder: inside a signed app it must not be written.
      cwd: this.stateDir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk) => {
        log.write(chunk);
        this.remember(name, chunk);
      });
    }
    const entry = { name, child, exited: false, code: null };
    entry.done = new Promise((resolve) => {
      child.once("error", (error) => {
        entry.exited = true;
        entry.spawnError = error;
        log.end();
        resolve();
      });
      child.once("exit", (code, signal) => {
        entry.exited = true;
        entry.code = code ?? signal;
        log.end();
        resolve();
        this.onExit(entry);
      });
    });
    return entry;
  }

  runOnce(args, childEnv) {
    return new Promise((resolve) => {
      const log = this.logStream("server");
      log.on("error", () => {});
      const child = this.spawn(this.binary, args, {
        // Never the release folder: inside a signed app it must not be written.
        cwd: this.stateDir,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream?.on("data", (chunk) => {
          log.write(chunk);
          this.remember("seed", chunk);
        });
      }
      child.once("error", () => {
        log.end();
        resolve(-1);
      });
      child.once("exit", (code) => {
        log.end();
        resolve(code ?? -1);
      });
    });
  }

  async waitFor(what, entry, url, timeoutMs, accept) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (entry.exited) {
        throw new LocalServerError(
          entry.spawnError
            ? `${what} could not be started: ${entry.spawnError.message}`
            : `${what} stopped while starting (exit ${entry.code}).`,
        );
      }
      if (this.state !== "starting")
        throw new LocalServerError("Starting was cancelled.");
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2_000);
        try {
          const response = await this.fetch(url, { signal: controller.signal });
          if (accept(response)) return;
        } finally {
          clearTimeout(timer);
        }
      } catch {}
      await sleep(200);
    }
    throw new LocalServerError(`${what} did not answer in time.`);
  }

  /** A server process that goes away while the app is running is started
   * again, a bounded number of times. */
  onExit(entry) {
    if (this.state !== "ready") return;
    if (entry !== this.kernel && entry !== this.gateway) return;
    const now = Date.now();
    this.restarts = this.restarts.filter((at) => now - at < RESTART_WINDOW_MS);
    void (async () => {
      await this.teardown();
      if (this.restarts.length >= MAX_RESTARTS) {
        this.setState(
          "failed",
          `The local server stopped unexpectedly (${entry.name}, exit ${entry.code}).`,
        );
        return;
      }
      this.restarts.push(now);
      this.setState("stopped");
      this.start().catch(() => {});
    })();
  }

  rememberPids() {
    const pids = [this.kernel, this.gateway]
      .filter((entry) => entry && !entry.exited && entry.child.pid)
      .map((entry) => entry.child.pid);
    try {
      this.writePlan({ ...this.readPlan(), pids });
    } catch {}
  }

  /** Processes a crashed or force-quit app left behind still hold the ports
   * and the session store. They are ended only when the pid still belongs to
   * this server's executable, never by pid alone. */
  async killLeftovers() {
    const plan = this.readPlan();
    const pids = Array.isArray(plan.pids) ? plan.pids.filter(validPid) : [];
    if (!pids.length) return;
    for (const pid of pids) {
      if (!(await this.ownsPid(pid))) continue;
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    const deadline = Date.now() + KILL_AFTER_MS;
    for (const pid of pids) {
      while (Date.now() < deadline && (await this.ownsPid(pid)))
        await sleep(100);
      if (await this.ownsPid(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    this.writePlan({ ...plan, pids: [] });
  }

  ownsPid(pid) {
    return new Promise((resolve) => {
      this.execFile(
        "ps",
        ["-o", "command=", "-p", String(pid)],
        { timeout: 5_000, encoding: "utf8" },
        (error, stdout) =>
          resolve(!error && String(stdout).includes(this.binary)),
      );
    });
  }

  async end(entry, graceMs) {
    if (!entry || entry.exited) return;
    try {
      entry.child.kill("SIGTERM");
    } catch {}
    const killer = setTimeout(() => {
      try {
        entry.child.kill("SIGKILL");
      } catch {}
    }, graceMs);
    await entry.done;
    clearTimeout(killer);
  }

  /** Gateway first, so its runs drain while the session store still answers. */
  async teardown() {
    const { gateway, kernel } = this;
    this.gateway = null;
    this.kernel = null;
    await this.end(gateway, KILL_AFTER_MS);
    await this.end(kernel, 5_000);
    try {
      this.writePlan({ ...this.readPlan(), pids: [] });
    } catch {}
  }

  stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      // Leaving "starting" makes a start in flight give up at its next check.
      this.setState("stopping");
      if (this.starting) await this.starting.catch(() => {});
      await this.teardown();
      this.setState("stopped");
    })().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  /** Last resort for an exit that cannot wait: signal both and leave. */
  stopNow() {
    for (const entry of [this.gateway, this.kernel]) {
      if (!entry || entry.exited) continue;
      try {
        entry.child.kill("SIGTERM");
      } catch {}
    }
  }

  recentOutput() {
    return this.tail.join("\n");
  }
}

function validPid(value) {
  return Number.isInteger(value) && value > 1;
}

module.exports = {
  LocalServer,
  LocalServerError,
  PREFERRED_PORTS,
  loginShellPath,
  mergePath,
};
