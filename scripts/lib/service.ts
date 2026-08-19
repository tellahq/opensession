/**
 * Service lifecycle for the `opensession` CLI, across systemd and launchd.
 *
 * Linux (systemd): the repo's `opensession.service` is a copy of Tella's
 * deployed unit, with that box's user, checkout path and bun path baked in —
 * it is a template here, never a file to install verbatim. `renderUnit()`
 * rewrites the host-specific directives and leaves every tuning comment
 * (KillMode, the drain window, the IMDS block) intact, because those encode
 * hard-won behaviour that a fresh install wants too.
 *
 * Two systemd scopes. The default is a **user** unit under
 * `~/.config/systemd/user`, which needs no root: `loginctl enable-linger`
 * keeps the user manager (and so the server) alive across logout and reboot.
 * The **system** unit under `/etc/systemd/system` is the operator path
 * (`opensession service install --system`), for boxes where the server should
 * not depend on a user session at all. Whichever file exists decides how
 * `status`/`stop`/`logs` talk to systemd; user first, since that is the one
 * an install creates without asking.
 *
 * macOS (launchd): a per-user LaunchAgent, which needs no root at all. launchd
 * has no equivalent of systemd's EnvironmentFile, so the agent execs through a
 * login shell that sources `~/.opensession.env` first — otherwise none of the
 * integration flags or secrets would reach the server.
 *
 * Anywhere else, everything degrades to "no supervisor" and the CLI runs the
 * server in the foreground.
 */

import { chmodSync, existsSync, mkdirSync } from "fs";
import { userInfo } from "os";
import { dirname, join } from "path";
import {
  BIN_DIR,
  ENV_PATH,
  HOME,
  OPENSESSION_HOME,
  REPO_ROOT,
  SERVICE_NAME,
  SERVICE_PATH,
  SHIM_PATH,
  USER_UNIT_PATH,
} from "./paths";
import { isCompiledBinary } from "../../src/runner-host/exe";
import { dim, info, ok, run, runInherit, warn } from "./ui";

export type Supervisor = "systemd" | "launchd" | "none";
/** Which systemd manager owns the unit. */
export type SystemdScope = "user" | "system";

export const LAUNCHD_LABEL = "dev.opensession.server";
export const LAUNCHD_PLIST = join(HOME, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
/** The plist execs this named launcher rather than `/bin/bash -c …` so macOS
 *  names the background login item "OpenSession", not "bash". It lives in the
 * home root, NOT bin/: on a case-insensitive filesystem (macOS default)
 * `bin/OpenSession` and the `bin/opensession` shim are the same file, so writing
 * the launcher there would follow the shim symlink and clobber the binary. */
export const LAUNCHD_LAUNCHER = join(OPENSESSION_HOME, "OpenSession");
export const LOG_DIR = join(OPENSESSION_HOME, "logs");

export function supervisor(): Supervisor {
  if (process.platform === "darwin") return "launchd";
  if (Bun.which("systemctl") && existsSync("/run/systemd/system")) return "systemd";
  return "none";
}

/** Kept for callers that only care whether *some* supervisor exists. */
export function hasSystemd(): boolean {
  return supervisor() !== "none";
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

/**
 * `systemctl --user` needs to find the user manager's socket. A login shell
 * has XDG_RUNTIME_DIR set by pam_systemd; a plain `ssh host cmd`, cron, or the
 * installer piped through bash does not, and every user-scope call then fails
 * with "Failed to connect to bus: No medium found". Point it at the standard
 * location when it is missing.
 */
function userEnv(): Record<string, string> {
  if (process.env.XDG_RUNTIME_DIR) return {};
  return { XDG_RUNTIME_DIR: `/run/user/${process.getuid?.() ?? ""}` };
}

function systemctl(scope: SystemdScope, args: string[]): string[] {
  return scope === "user" ? ["systemctl", "--user", ...args] : ["sudo", "systemctl", ...args];
}

/** The scope whose unit file exists on this box, if any. */
export function installedScope(): SystemdScope | undefined {
  if (existsSync(USER_UNIT_PATH)) return "user";
  if (existsSync(SERVICE_PATH)) return "system";
  return undefined;
}

export async function isInstalled(): Promise<boolean> {
  switch (supervisor()) {
    case "systemd":
      return installedScope() !== undefined;
    case "launchd":
      return existsSync(LAUNCHD_PLIST);
    default:
      return false;
  }
}

/**
 * Tri-state on purpose. Querying the supervisor can fail in ways that mean
 * "I could not tell", not "it is stopped" — a non-root user with no session
 * bus gets `Failed to connect to bus` from systemctl, and reporting that as
 * "not running" while the service is happily serving traffic is worse than
 * admitting ignorance.
 */
export type ServiceState = "active" | "inactive" | "unknown";

export async function state(): Promise<ServiceState> {
  switch (supervisor()) {
    case "systemd": {
      const scope = installedScope() ?? "user";
      const { stdout } = await run(
        scope === "user" ? ["systemctl", "--user", "is-active", SERVICE_NAME] : ["systemctl", "is-active", SERVICE_NAME],
        { env: userEnv() },
      );
      if (stdout === "active" || stdout === "activating") return "active";
      // systemctl prints one of these on stdout when it could actually look.
      if (["inactive", "failed", "deactivating"].includes(stdout)) return "inactive";
      return "unknown";
    }
    case "launchd": {
      const { code, stdout, stderr } = await run([
        "launchctl",
        "print",
        `${domain()}/${LAUNCHD_LABEL}`,
      ]);
      if (code === 0) return /\bpid = \d+/.test(stdout) ? "active" : "inactive";
      // launchctl says this when the label simply is not loaded.
      if (/could not find service|No such process/i.test(stderr)) return "inactive";
      return "unknown";
    }
    default:
      return "unknown";
  }
}

export async function isActive(): Promise<boolean> {
  return (await state()) === "active";
}

/** PATH for the service. Engine subprocesses inherit it, so a thin one shows
 * up much later as "command not found" inside an agent run. */
function servicePath(bunDir: string): string {
  return [
    bunDir,
    join(HOME, ".opencode", "bin"),
    join(HOME, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ].join(":");
}

/**
 * How the service starts the server, and the dir to head the PATH with.
 *
 * Compiled-binary install: the binary is the server behind `server`, and the
 * unit runs it through the shim symlink (BIN_DIR/opensession) so `opensession
 * update` can repoint it without re-rendering the unit. The sharp sidecar
 * resolves via the binary's realpath, not PATH.
 *
 * Source install: `bun run opensession.ts` from the checkout.
 */
function serverExec(): { cmd: string; binDir: string } {
  if (isCompiledBinary()) return { cmd: `${SHIM_PATH} server`, binDir: BIN_DIR };
  const bun = bunPath();
  return { cmd: `${bun} run opensession.ts`, binDir: bun.replace(/\/bun$/, "") };
}

function bunPath(): string {
  // A release install carries its own bun at <checkout>/bin/bun and puts no
  // bun on PATH; prefer it so the rendered ExecStart works even when the unit
  // is installed from a shell where bun is not on PATH (else 203/EXEC). Fall
  // back to PATH (source installs) then the standard ~/.bun location.
  const bundled = join(REPO_ROOT, "bin", "bun");
  if (existsSync(bundled)) return bundled;
  return Bun.which("bun") ?? join(HOME, ".bun", "bin", "bun");
}

/**
 * Who the service should run as.
 *
 * `os.userInfo().username` is not trustworthy on its own: in a container
 * entered as a uid with no USER in the environment it returns the literal
 * string "unknown". That produced a unit containing `User=unknown`, which
 * installs and enables without complaint and then fails every start with
 * `status=217/USER` — a late, opaque failure a long way from its cause.
 *
 * So: try several sources, and verify the answer resolves to a real account
 * before using it. If none does, refuse to render rather than emit a unit that
 * is guaranteed to fail.
 */
async function resolveUsername(): Promise<string> {
  let fromApi: string | undefined;
  try {
    const name = userInfo().username;
    if (name && name !== "unknown") fromApi = name;
  } catch {
    // getpwuid can fail outright in minimal environments.
  }

  const candidates = [
    fromApi,
    process.env.USER,
    process.env.LOGNAME,
    (await run(["id", "-un"])).stdout,
  ];

  for (const candidate of candidates) {
    const name = candidate?.trim();
    if (!name || name === "unknown") continue;
    // `id -u <name>` is the cheapest "does this account exist" check.
    if ((await run(["id", "-u", name])).code === 0) return name;
  }

  throw new Error(
    "could not determine which user to run the service as — " +
      "set USER in the environment, or edit User= in the generated unit",
  );
}

/**
 * Rewrite the repo's systemd unit for this box.
 *
 * The user-scope rendering differs from the system one in exactly the ways a
 * user manager forces:
 *  - no `User=` (a user unit already runs as its owner; systemd rejects it);
 *  - no `IPAddressDeny=` (per-user managers can only apply it under
 *    PrivateUsers=, which needs unprivileged user namespaces and breaks the
 *    engine's sandboxes on stock Ubuntu; the instance-role mint is opt-in
 *    anyway, see AGENT_AWS_CREDS);
 *  - `WantedBy=default.target` (`multi-user.target` does not exist per user);
 *  - `EnvironmentFile=-…` so a box that has not written secrets yet still
 *    starts, instead of failing with a unit that looks fine.
 */
export async function renderUnit(scope: SystemdScope = "user"): Promise<string> {
  const template = join(REPO_ROOT, "opensession.service");
  if (!existsSync(template)) {
    throw new Error(`missing unit template at ${template}`);
  }
  const exec = serverExec();
  let unit = (await Bun.file(template).text())
    .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${REPO_ROOT}`)
    .replace(/^ExecStart=.*$/m, `ExecStart=${exec.cmd}`)
    .replace(
      /^Environment="PATH=.*"$/m,
      `Environment="PATH=${servicePath(exec.binDir)}"`,
    );
  if (scope === "system") {
    return unit
      .replace(/^User=.*$/m, `User=${await resolveUsername()}`)
      .replace(/^EnvironmentFile=.*$/m, `EnvironmentFile=${ENV_PATH}`);
  }
  return unit
    .replace(/^User=.*\n/m, "")
    .replace(/^EnvironmentFile=.*$/m, `EnvironmentFile=-${ENV_PATH}`)
    .replace(/^IPAddressDeny=.*\n/m, "")
    .replace(/^WantedBy=.*$/m, "WantedBy=default.target");
}

/**
 * Is a cloud instance-metadata endpoint answering on this box?
 *
 * The system unit blocks 169.254.169.254 for the server's own children with
 * IPAddressDeny=; a per-user manager cannot enforce that directive on stock
 * Ubuntu (it needs PrivateUsers=, which the apparmor unprivileged-userns
 * restriction denies, so systemd applies nothing and says nothing). On a box
 * with an attached cloud role, a user-scope install would therefore let an
 * agent child mint role credentials from untrusted text. Probe before
 * installing: any HTTP answer at all from the endpoint (AWS IMDSv1/v2, GCP,
 * Azure all live there) counts; a timeout or connection error is "no cloud
 * metadata here", which is every laptop, VM and bare VPS.
 */
export async function metadataEndpointReachable(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    await fetch("http://169.254.169.254/", { signal: AbortSignal.timeout(1000), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

export const IMDS_OVERRIDE_ENV = "OPENSESSION_ALLOW_IMDS";

/**
 * Keep the user manager alive without a login session, so the user unit
 * survives logout and comes back after a reboot. logind lets a user set
 * linger on themselves without root on current distributions (polkit
 * `set-self-linger` is allow-any on Ubuntu 24.04); older policies want an
 * admin, so fall back to a non-interactive sudo before giving up with the
 * command to run by hand. Each call is bounded: a wedged logind otherwise
 * hangs the installer indefinitely.
 */
export async function enableLinger(): Promise<boolean> {
  const user = (await run(["id", "-un"])).stdout || process.env.USER || "";
  const linger = await run(["timeout", "20", "loginctl", "show-user", user, "-p", "Linger", "--value"]);
  if (linger.stdout === "yes") return true;
  for (const cmd of [
    ["timeout", "20", "loginctl", "enable-linger"],
    ["sudo", "-n", "timeout", "20", "loginctl", "enable-linger", user],
  ]) {
    if ((await run(cmd)).code === 0) return true;
  }
  warn(
    "could not enable linger, so the service stops when you log out",
    `run: sudo loginctl enable-linger ${user}`,
  );
  return false;
}

/** Poll the health endpoint until the server answers or `ms` elapse. */
export async function waitHealthy(url: string, ms = 90_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return true;
    } catch {}
    await Bun.sleep(1000);
  }
  return false;
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Render the macOS LaunchAgent. */
/**
 * The launcher the LaunchAgent execs. launchd has no EnvironmentFile, so the
 * env file is sourced in a shell before the server starts (`set -a` exports
 * everything it defines). It lives as a named script — rather than an inline
 * `/bin/bash -c …` in the plist — so macOS names the background login item
 * after it ("opensession-service"), not "bash".
 */
export function renderLauncher(): string {
  const exec = serverExec();
  return (
    `#!/bin/bash\n` +
    `# macOS shows this file's name in Login Items & Extensions; hence "OpenSession".\n` +
    `cd ${REPO_ROOT} || exit 1\n` +
    `set -a; [ -f ${ENV_PATH} ] && . ${ENV_PATH}; set +a\n` +
    `exec ${exec.cmd}\n`
  );
}

export function renderPlist(): string {
  const exec = serverExec();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(LAUNCHD_LAUNCHER)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(REPO_ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(servicePath(exec.binDir))}</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(LOG_DIR, "server.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(LOG_DIR, "server.err.log"))}</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
}

export async function install(opts: { scope?: SystemdScope } = {}): Promise<boolean> {
  switch (supervisor()) {
    case "systemd": {
      const scope = opts.scope ?? "user";
      // `enable --now` is a no-op on an already-running unit: a re-onboard
      // (say, to rebind from 127.0.0.1 to the tailnet IP) would leave the old
      // process serving with the pre-onboard env. Restart in that case so the
      // new unit and env actually take effect.
      const wasActive = installedScope() === scope && (await isActive());
      const unit = await renderUnit(scope);
      const env = userEnv();
      // Set when a user→system migration removes the user unit, so a later
      // failure can put it back rather than leave the box with no service.
      let migratedUserUnit: string | null = null;

      if (scope === "user") {
        // See metadataEndpointReachable: on a cloud box the user unit cannot
        // block the metadata endpoint, so it is not installed by default.
        if (process.env[IMDS_OVERRIDE_ENV] !== "1" && (await metadataEndpointReachable())) {
          const uid = process.getuid?.() ?? 0;
          warn("a cloud metadata endpoint (169.254.169.254) answers on this box; the service unit cannot reliably block agent access to it");
          info(dim("  The engine detaches each session into its own systemd user scope, outside any"));
          info(dim("  unit's cgroup, so neither the user nor the --system unit's IPAddressDeny reaches"));
          info(dim("  those children. Block it at the host, which covers every process this user runs:"));
          info(dim(`    sudo iptables -I OUTPUT -d 169.254.169.254 -m owner --uid-owner ${uid} -j REJECT`));
          info(dim("  then re-run install. (Whole-host: drop the --uid-owner clause.) Alternatively keep"));
          info(dim("  engines inside the --system unit's cgroup with OPENSESSION_OC_DETACH=0, at the cost"));
          info(dim("  of losing detached-run survival across restarts."));
          info(dim(`  If this box has no cloud role worth protecting: ${IMDS_OVERRIDE_ENV}=1 opensession service install`));
          return false;
        }
        // Both scopes serving the same port would fight; a user install
        // supersedes a system one only if the operator removes that by hand.
        if (existsSync(SERVICE_PATH)) {
          warn(
            `a system unit exists at ${SERVICE_PATH}`,
            "remove it (sudo systemctl disable --now opensession) or use --system",
          );
          return false;
        }
        mkdirSync(dirname(USER_UNIT_PATH), { recursive: true });
        await Bun.write(USER_UNIT_PATH, unit);
        info(dim(`installed ${USER_UNIT_PATH}`));
        await enableLinger();
        // Enabling linger starts user@<uid>.service; from a session that had
        // no user manager (plain ssh command, cron), give its bus a moment to
        // appear before the first `systemctl --user` call.
        const runtimeDir = process.env.XDG_RUNTIME_DIR ?? env.XDG_RUNTIME_DIR ?? "";
        for (let i = 0; i < 20 && !existsSync(join(runtimeDir, "systemd", "private")); i++) {
          await Bun.sleep(500);
        }
      } else {
        // Put the system unit in place FIRST — the privileged step. If sudo is
        // denied or the copy fails, the running user unit is untouched, so
        // switching scopes can never cause an outage on a box without sudo.
        // Only once the file is installed do we migrate off the user unit
        // (running both would fight over port 3850, and installedScope()
        // prefers the user file, so status/logs/uninstall would address it).
        const staged = join(OPENSESSION_HOME, "opensession.service");
        await Bun.write(staged, unit);
        info(dim(`installing ${staged} -> ${SERVICE_PATH} (needs sudo)`));
        if ((await runInherit(["sudo", "cp", staged, SERVICE_PATH])) !== 0) {
          warn(`failed: sudo cp ${staged} ${SERVICE_PATH}`);
          return false;
        }
        if (existsSync(USER_UNIT_PATH)) {
          info(dim("stopping the existing user service; the system unit takes over"));
          migratedUserUnit = await Bun.file(USER_UNIT_PATH).text();
          await runInherit(systemctl("user", ["disable", "--now", SERVICE_NAME]), undefined, env);
          await run(["rm", "-f", USER_UNIT_PATH]);
          await runInherit(systemctl("user", ["daemon-reload"]), undefined, env);
        }
      }

      for (const cmd of [
        systemctl(scope, ["daemon-reload"]),
        systemctl(scope, ["enable", "--now", SERVICE_NAME]),
        ...(wasActive ? [systemctl(scope, ["restart", SERVICE_NAME])] : []),
      ]) {
        if ((await runInherit(cmd, undefined, env)) !== 0) {
          warn(`failed: ${cmd.join(" ")}`);
          // A system install that migrated off the user unit and then failed to
          // start would leave the box with no service; put the user unit back.
          if (migratedUserUnit) {
            warn("restoring the user service");
            mkdirSync(dirname(USER_UNIT_PATH), { recursive: true });
            await Bun.write(USER_UNIT_PATH, migratedUserUnit);
            await runInherit(systemctl("user", ["daemon-reload"]), undefined, env);
            await runInherit(systemctl("user", ["enable", "--now", SERVICE_NAME]), undefined, env);
          }
          return false;
        }
      }
      ok(
        wasActive
          ? `${scope} service reinstalled and restarted`
          : `${scope} service installed and started`,
      );
      return true;
    }

    case "launchd": {
      // A user LaunchAgent needs no root, which is the whole reason to prefer
      // it over a system daemon here.
      mkdirSync(join(HOME, "Library", "LaunchAgents"), { recursive: true });
      mkdirSync(LOG_DIR, { recursive: true });
      mkdirSync(dirname(LAUNCHD_LAUNCHER), { recursive: true });
      await Bun.write(LAUNCHD_LAUNCHER, renderLauncher());
      chmodSync(LAUNCHD_LAUNCHER, 0o755);
      await Bun.write(LAUNCHD_PLIST, renderPlist());

      // Replace any previous registration; bootout fails harmlessly if absent.
      await run(["launchctl", "bootout", `${domain()}/${LAUNCHD_LABEL}`]);
      const { code, stderr } = await run(["launchctl", "bootstrap", domain(), LAUNCHD_PLIST]);
      if (code !== 0) {
        warn(`launchctl bootstrap failed: ${stderr}`);
        return false;
      }
      ok("LaunchAgent installed and started", LAUNCHD_PLIST);
      return true;
    }

    default:
      warn("no service manager available — run `opensession start --foreground`");
      return false;
  }
}

export async function control(action: "start" | "stop" | "restart"): Promise<number> {
  if (!(await isInstalled())) {
    warn(`no service installed — run it directly with ${dim("opensession start --foreground")}`);
    return 1;
  }

  if (supervisor() === "launchd") {
    const label = `${domain()}/${LAUNCHD_LABEL}`;
    switch (action) {
      case "start":
        return await runInherit(["launchctl", "kickstart", label]);
      case "stop":
        return await runInherit(["launchctl", "bootout", label]);
      case "restart":
        return await runInherit(["launchctl", "kickstart", "-k", label]);
    }
  }

  const scope = installedScope() ?? "user";
  return await runInherit(systemctl(scope, [action, SERVICE_NAME]), undefined, userEnv());
}

export async function logs(follow: boolean, lines: number): Promise<number> {
  if (!(await isInstalled())) {
    warn("no service installed — nothing to tail");
    return 1;
  }

  if (supervisor() === "launchd") {
    // launchd writes to the files named in the plist; there is no journal.
    const out = join(LOG_DIR, "server.log");
    if (!existsSync(out)) {
      warn(`no log file yet at ${out}`);
      return 1;
    }
    const cmd = ["tail", "-n", String(lines)];
    if (follow) cmd.push("-f");
    cmd.push(out);
    return await runInherit(cmd);
  }

  const scope = installedScope() ?? "user";
  const cmd = ["journalctl", ...(scope === "user" ? ["--user"] : []), "-u", SERVICE_NAME, "-n", String(lines)];
  if (follow) cmd.push("-f");
  return await runInherit(cmd, undefined, userEnv());
}

/** Remove the unit (either scope) or LaunchAgent, stopping it first. */
export async function uninstall(): Promise<boolean> {
  switch (supervisor()) {
    case "systemd": {
      const scope = installedScope();
      if (!scope) return true;
      const env = userEnv();
      await runInherit(systemctl(scope, ["disable", "--now", SERVICE_NAME]), undefined, env);
      if (scope === "user") {
        await run(["rm", "-f", USER_UNIT_PATH]);
      } else if ((await runInherit(["sudo", "rm", "-f", SERVICE_PATH])) !== 0) {
        return false;
      }
      await runInherit(systemctl(scope, ["daemon-reload"]), undefined, env);
      ok(`${scope} service removed`);
      return true;
    }
    case "launchd": {
      if (!existsSync(LAUNCHD_PLIST)) return true;
      await run(["launchctl", "bootout", `${domain()}/${LAUNCHD_LABEL}`]);
      await run(["rm", "-f", LAUNCHD_PLIST, LAUNCHD_LAUNCHER]);
      ok("LaunchAgent removed");
      return true;
    }
    default:
      return true;
  }
}
