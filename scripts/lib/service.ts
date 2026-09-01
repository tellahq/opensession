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

import { chmodSync, existsSync, mkdirSync, readFileSync } from "fs";
import { userInfo } from "os";
import { dirname, join } from "path";
import {
  BIN_DIR,
  ENV_PATH,
  EXECUTOR_SERVICE_NAME,
  EXECUTOR_SERVICE_PATH,
  EXECUTOR_TOKEN_PATH,
  HOME,
  INGRESS_SERVICE_PATH,
  OPENSESSION_HOME,
  REPO_ROOT,
  SERVICE_NAME,
  SERVICE_PATH,
  SESSION_KERNEL_SERVICE_NAME,
  SESSION_KERNEL_SERVICE_PATH,
  SESSION_KERNEL_TOKEN_PATH,
  SHIM_PATH,
  SOCKET_NAME,
  SOCKET_PATH,
  STAGED_EXECUTOR_UNIT_PATH,
  STAGED_INGRESS_UNIT_PATH,
  STAGED_SOCKET_PATH,
  STAGED_SESSION_KERNEL_UNIT_PATH,
  STAGED_UNIT_PATH,
  USER_INGRESS_UNIT_PATH,
  USER_SESSION_KERNEL_TOKEN_PATH,
  USER_SESSION_KERNEL_UNIT_PATH,
  USER_SOCKET_PATH,
  USER_UNIT_PATH,
} from "./paths";
import { isCompiledBinary } from "../../packages/core/opensession-server/src/runner-host/exe";
import { dim, fail, info, ok, run, runInherit, warn } from "./ui";

export type Supervisor = "systemd" | "launchd" | "none";
/** Which systemd manager owns the unit. */
export type SystemdScope = "user" | "system";

export const LAUNCHD_LABEL = "dev.opensession.server";
export const LAUNCHD_PLIST = join(
  HOME,
  "Library",
  "LaunchAgents",
  `${LAUNCHD_LABEL}.plist`,
);
/** The plist execs this named launcher rather than `/bin/bash -c …` so macOS
 *  names the background login item "OpenSession", not "bash". It lives in the
 * home root, NOT bin/: on a case-insensitive filesystem (macOS default)
 * `bin/OpenSession` and the `bin/opensession` shim are the same file, so writing
 * the launcher there would follow the shim symlink and clobber the binary. */
export const LAUNCHD_LAUNCHER = join(OPENSESSION_HOME, "OpenSession");
export const LAUNCHD_SESSION_KERNEL_LABEL = "dev.opensession.session-kernel";
export const LAUNCHD_SESSION_KERNEL_PLIST = join(
  HOME,
  "Library",
  "LaunchAgents",
  `${LAUNCHD_SESSION_KERNEL_LABEL}.plist`,
);
export const LAUNCHD_SESSION_KERNEL_LAUNCHER = join(
  OPENSESSION_HOME,
  "OpenSessionKernel",
);
export const LOG_DIR = join(OPENSESSION_HOME, "logs");
const RUN_HOST_HELPER = "/usr/local/libexec/opensession-run-host";

function envFileValue(name: string): string | undefined {
  if (!existsSync(ENV_PATH)) return undefined;
  const prefix = `${name}=`;
  const raw = readFileSync(ENV_PATH, "utf8")
    .split("\n")
    .findLast((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
  if (!raw) return undefined;
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function defaultStatePath(base: string): string {
  const current = join(HOME, ".opensession", base);
  const legacy = join(HOME, `.opensession-${base}`);
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
}

function runHostsRoot(): string {
  const sessionsDir =
    process.env.OPENSESSION_SESSIONS_DIR ||
    envFileValue("OPENSESSION_SESSIONS_DIR") ||
    (process.env.OPENSESSION_STATE_DIR || envFileValue("OPENSESSION_STATE_DIR")
      ? join(
          process.env.OPENSESSION_STATE_DIR ||
            envFileValue("OPENSESSION_STATE_DIR")!,
          ".opensession-sessions",
        )
      : defaultStatePath("sessions"));
  return join(sessionsDir, "run-hosts");
}

/** The service's working directory must survive release swaps. A release install
 *  runs from the `~/.opensession/src` symlink, which `opensession update`
 *  repoints; REPO_ROOT is the versioned release dir that same update prunes, so
 *  baking it into the unit strands the service once the old release is gone.
 *  Prefer the symlink when it exists (release install); fall back to REPO_ROOT
 *  for a source checkout that has no such symlink. */
export function serviceWorkdir(): string {
  if (process.platform === "darwin") {
    const current = join(
      process.env.OPENSESSION_DEPLOY_STATE || defaultStatePath("deploy"),
      "current",
    );
    if (existsSync(current)) return current;
  }
  const link = join(OPENSESSION_HOME, "src");
  return existsSync(link) ? link : REPO_ROOT;
}

export function supervisor(): Supervisor {
  if (process.platform === "darwin") return "launchd";
  if (Bun.which("systemctl") && existsSync("/run/systemd/system"))
    return "systemd";
  return "none";
}

/** Kept for callers that only care whether *some* supervisor exists. */
export function hasSystemd(): boolean {
  return supervisor() !== "none";
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

type CommandResult = Awaited<ReturnType<typeof run>>;

/**
 * launchd can return EIO briefly after bootout while it finishes unregistering
 * the old job. A deploy must not leave both services unloaded in that window.
 */
export async function bootstrapLaunchAgent(
  label: string,
  plist: string,
  options: {
    domain?: string;
    attempts?: number;
    retryDelayMs?: number;
    runCommand?: typeof run;
    pause?: (ms: number) => Promise<void>;
  } = {},
): Promise<CommandResult> {
  const launchdDomain = options.domain ?? domain();
  const attempts = options.attempts ?? 40;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const runCommand = options.runCommand ?? run;
  const pause = options.pause ?? Bun.sleep;
  let result: CommandResult = { code: 1, stdout: "", stderr: "" };

  for (let attempt = 0; attempt < attempts; attempt++) {
    result = await runCommand(["launchctl", "bootstrap", launchdDomain, plist]);
    if (result.code === 0) return result;
    if (!/Bootstrap failed:\s*5:\s*Input\/output error/i.test(result.stderr))
      return result;

    // EIO can race with successful registration, so verify before retrying.
    const registered = await runCommand(
      ["launchctl", "print", `${launchdDomain}/${label}`],
      { quiet: true },
    );
    if (registered.code === 0)
      return { code: 0, stdout: registered.stdout, stderr: "" };
    if (attempt + 1 < attempts) await pause(retryDelayMs);
  }

  return result;
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
  return scope === "user"
    ? ["systemctl", "--user", ...args]
    : ["sudo", "systemctl", ...args];
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
        scope === "user"
          ? ["systemctl", "--user", "is-active", SERVICE_NAME]
          : ["systemctl", "is-active", SERVICE_NAME],
        { env: userEnv() },
      );
      if (stdout === "active" || stdout === "activating") return "active";
      // systemctl prints one of these on stdout when it could actually look.
      if (["inactive", "failed", "deactivating"].includes(stdout))
        return "inactive";
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
      if (/could not find service|No such process/i.test(stderr))
        return "inactive";
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
 * Source install: `bun run packages/core/opensession-server/opensession.ts`
 * from the checkout.
 */
function serverExec(): { cmd: string; binDir: string } {
  if (isCompiledBinary())
    return { cmd: `${SHIM_PATH} server`, binDir: BIN_DIR };
  const bun = bunPath();
  return {
    cmd: `${bun} run packages/core/opensession-server/opensession.ts`,
    binDir: bun.replace(/\/bun$/, ""),
  };
}

function bunPath(): string {
  // A release install carries its own bun at <checkout>/bin/bun and puts no
  // bun on PATH; prefer it so the rendered ExecStart works even when the unit
  // is installed from a shell where bun is not on PATH (else 203/EXEC). Fall
  // back to PATH (source installs) then the standard ~/.bun location.
  const bundled = join(serviceWorkdir(), "bin", "bun");
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
export async function renderSocketUnit(
  scope: SystemdScope = "user",
): Promise<string> {
  const template = join(REPO_ROOT, "opensession.socket");
  if (!existsSync(template))
    throw new Error(`missing socket unit template at ${template}`);
  const port = process.env.PORT || envFileValue("PORT") || "3850";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535)
    throw new Error("PORT must be a valid TCP port");
  let unit = (await Bun.file(template).text())
    .replace(/^ListenStream=.*$/m, `ListenStream=127.0.0.1:${port}`)
    .replace(
      /^Service=.*$/m,
      isCompiledBinary()
        ? "Service=opensession.service"
        : "Service=opensession-ingress.service",
    )
    .replace(
      /^WantedBy=.*$/m,
      scope === "system"
        ? "WantedBy=sockets.target"
        : "WantedBy=default.target",
    );
  return unit;
}

export async function renderIngressUnit(
  scope: SystemdScope = "user",
): Promise<string> {
  const template = join(REPO_ROOT, "opensession-ingress.service");
  if (!existsSync(template))
    throw new Error(`missing ingress unit template at ${template}`);
  let unit = (await Bun.file(template).text())
    .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${serviceWorkdir()}`)
    .replace(
      /^ExecStart=.*$/m,
      `ExecStart=${bunPath()} run packages/core/opensession-server/src/server/gateway-ingress.ts`,
    )
    .replace(/^Environment="HOME=.*"$/m, `Environment="HOME=${HOME}"`)
    .replace(
      /^Environment="PATH=.*"$/m,
      `Environment="PATH=${servicePath(dirname(bunPath()))}"`,
    );
  if (scope === "system")
    return unit.replace(/^User=.*$/m, `User=${await resolveUsername()}`);
  return unit
    .replace(/^Slice=opensession-control\.slice\n/m, "")
    .replace(/^User=.*\n/m, "")
    .replace(/^IPAddressDeny=.*\n/m, "")
    .replace(/^WantedBy=.*$/m, "WantedBy=default.target");
}

export async function renderUnit(
  scope: SystemdScope = "user",
): Promise<string> {
  const template = join(REPO_ROOT, "opensession.service");
  if (!existsSync(template)) {
    throw new Error(`missing unit template at ${template}`);
  }
  const exec = serverExec();
  const compiled = isCompiledBinary();
  let unit = (await Bun.file(template).text())
    .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${serviceWorkdir()}`)
    .replace(
      /^ExecStart=.*$/m,
      compiled
        ? `ExecStart=${exec.cmd}`
        : `ExecStart=${bunPath()} run packages/core/opensession-server/src/server/gateway-supervisor.ts`,
    )
    .replace(
      /^Environment="PATH=.*"$/m,
      `Environment="PATH=${servicePath(exec.binDir)}"`,
    );
  if (compiled) {
    unit = unit
      .replace(
        /^Wants=opensession\.socket opensession-ingress\.service$/m,
        "Requires=opensession.socket",
      )
      .replace(
        /^After=network\.target opensession-ingress\.service/m,
        "After=network.target opensession.socket",
      )
      .replace(/^Type=simple$/m, "Type=simple\nSockets=opensession.socket")
      .replace(/^Environment="OPENSESSION_EXTERNAL_INGRESS=1"\n/m, "");
  }
  const credentialMarker =
    "# EXECUTOR_CREDENTIAL: rendered installs replace this marker. Keeping the\n" +
    "# source template optional lets the previous deploy script introduce this\n" +
    "# release without failing before it knows how to install the credential.\n";
  if (scope === "system") {
    return unit
      .replace(/^User=.*$/m, `User=${await resolveUsername()}`)
      .replace(/^EnvironmentFile=.*$/m, `EnvironmentFile=${ENV_PATH}`)
      .replace(
        credentialMarker,
        "LoadCredential=executor-token:/etc/opensession/executor-token\n",
      )
      .replace(
        /^# SESSION_KERNEL_CREDENTIAL$/m,
        `LoadCredential=session-kernel-token:${SESSION_KERNEL_TOKEN_PATH}`,
      );
  }
  // A user manager cannot consume the root-owned executor credential or launch
  // its fixed privileged host units. Keep simple mode genuinely rootless by
  // running turns in the gateway process. The system scope retains detached,
  // restart-surviving execution through the independent executor service.
  return unit
    .replace(/^Slice=opensession-control\.slice\n/m, "")
    .replace(
      /^# SESSION_KERNEL_CREDENTIAL$/m,
      `LoadCredential=session-kernel-token:${USER_SESSION_KERNEL_TOKEN_PATH}`,
    )
    .replace(
      /^After=network\.target opensession-ingress\.service opensession-session-kernel\.service opensession-executor\.service$/m,
      "After=network.target opensession-ingress.service opensession-session-kernel.service",
    )
    .replace(
      credentialMarker,
      'Environment="OPENSESSION_EXECUTOR=0"\n' +
        'Environment="OPENSESSION_PI_DETACH=0"\n',
    )
    .replace(/^User=.*\n/m, "")
    .replace(/^EnvironmentFile=.*$/m, `EnvironmentFile=-${ENV_PATH}`)
    .replace(/^IPAddressDeny=.*\n/m, "")
    .replace(/^WantedBy=.*$/m, "WantedBy=default.target");
}

function executorPathEnvironment(): string {
  const values = [
    ["HOME", HOME],
    [
      "OPENSESSION_STATE_DIR",
      process.env.OPENSESSION_STATE_DIR ||
        envFileValue("OPENSESSION_STATE_DIR"),
    ],
    [
      "OPENSESSION_SESSIONS_DIR",
      process.env.OPENSESSION_SESSIONS_DIR ||
        envFileValue("OPENSESSION_SESSIONS_DIR"),
    ],
  ] satisfies Array<readonly [string, string | undefined]>;
  const lines: string[] = [];
  for (const [key, value] of values) {
    if (!value) continue;
    lines.push(
      `Environment="${key}=${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    );
  }
  return lines.join("\n");
}

/** Render the independently restartable executor for system scope. */
export async function renderExecutorUnit(): Promise<string> {
  const template = join(serviceWorkdir(), "opensession-executor.service");
  if (!existsSync(template)) {
    throw new Error(`missing executor unit template at ${template}`);
  }
  const bun = bunPath();
  const compiled = isCompiledBinary();
  const exec = compiled
    ? `${SHIM_PATH} executor`
    : `${bun} run packages/core/opensession-server/src/executor/main.ts`;
  const binDir = compiled ? dirname(SHIM_PATH) : bun.replace(/\/bun$/, "");
  return (await Bun.file(template).text())
    .replace(/^User=.*$/m, `User=${await resolveUsername()}`)
    .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${serviceWorkdir()}`)
    .replace(/^# EXECUTOR_PATH_ENV$/m, executorPathEnvironment())
    .replace(/^ExecStart=.*$/m, `ExecStart=${exec}`)
    .replace(
      /^Environment="PATH=.*"$/m,
      `Environment="PATH=${servicePath(binDir)}"`,
    );
}

/** Render the independently supervised SessionKernel owner. */
export async function renderSessionKernelUnit(
  scope: SystemdScope = "system",
): Promise<string> {
  const template = join(serviceWorkdir(), "opensession-session-kernel.service");
  if (!existsSync(template))
    throw new Error(`missing session kernel unit template at ${template}`);
  const bun = bunPath();
  const compiled = isCompiledBinary();
  const exec = compiled
    ? `${SHIM_PATH} session-kernel-service`
    : `${bun} run packages/core/opensession-server/src/session-kernel-service.ts`;
  const binDir = compiled ? dirname(SHIM_PATH) : bun.replace(/\/bun$/, "");
  let unit = (await Bun.file(template).text())
    .replace(/^User=.*$/m, `User=${await resolveUsername()}`)
    .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${serviceWorkdir()}`)
    .replace(/^# SESSION_KERNEL_PATH_ENV$/m, executorPathEnvironment())
    .replace(/^ExecStart=.*$/m, `ExecStart=${exec}`)
    .replace(
      /^Environment="PATH=.*"$/m,
      `Environment="PATH=${servicePath(binDir)}"`,
    );
  if (scope === "system") return unit;
  return unit
    .replace(/^Slice=opensession-control\.slice\n/m, "")
    .replace(/^User=.*\n/m, "")
    .replace(
      /^LoadCredential=session-kernel-token:.*$/m,
      `LoadCredential=session-kernel-token:${USER_SESSION_KERNEL_TOKEN_PATH}`,
    )
    .replace(/^IPAddressAllow=.*\n/m, "")
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
    await fetch("http://169.254.169.254/", {
      signal: AbortSignal.timeout(1000),
      redirect: "manual",
    });
    return true;
  } catch {
    return false;
  }
}

export const IMDS_OVERRIDE_ENV = "OPENSESSION_ALLOW_IMDS";

/** Important, non-dimmed remediation shown when a user service would expose IMDS. */
export function metadataInstallBlockGuidance(uid: number): string[] {
  return [
    "This host can reach the cloud instance metadata endpoint used by EC2 at 169.254.169.254.",
    "On EC2, agents could use that endpoint to obtain the instance's IAM role credentials.",
    "The rootless service cannot reliably block that access itself, so Open Session did not install or start it.",
    "",
    "Recommended: block metadata access for this user:",
    `  sudo iptables -I OUTPUT -d 169.254.169.254 -m owner --uid-owner ${uid} -j REJECT`,
    "Then rerun the same Open Session installation command.",
    "",
    `Only if this instance has no cloud role credentials to protect, rerun with ${IMDS_OVERRIDE_ENV}=1 to explicitly skip this safety check.`,
  ];
}

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
  const linger = await run([
    "timeout",
    "20",
    "loginctl",
    "show-user",
    user,
    "-p",
    "Linger",
    "--value",
  ]);
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
    `cd ${serviceWorkdir()} || exit 1\n` +
    `set -a; [ -f ${ENV_PATH} ] && . ${ENV_PATH}; set +a\n` +
    `export OPENSESSION_SESSION_KERNEL_TOKEN_FILE=${USER_SESSION_KERNEL_TOKEN_PATH}\n` +
    `exec ${exec.cmd}\n`
  );
}

export function renderSessionKernelLauncher(): string {
  const compiled = isCompiledBinary();
  const exec = compiled
    ? `${SHIM_PATH} session-kernel-service`
    : `${bunPath()} run packages/core/opensession-server/src/session-kernel-service.ts`;
  return (
    `#!/bin/bash\n` + `cd ${serviceWorkdir()} || exit 1\n` + `exec ${exec}\n`
  );
}

export function renderSessionKernelPlist(): string {
  const binDir = isCompiledBinary()
    ? dirname(SHIM_PATH)
    : bunPath().replace(/\/bun$/, "");
  const state =
    process.env.OPENSESSION_STATE_DIR || envFileValue("OPENSESSION_STATE_DIR");
  const sessions =
    process.env.OPENSESSION_SESSIONS_DIR ||
    envFileValue("OPENSESSION_SESSIONS_DIR");
  const optional = [
    state
      ? `    <key>OPENSESSION_STATE_DIR</key><string>${xml(state)}</string>`
      : "",
    sessions
      ? `    <key>OPENSESSION_SESSIONS_DIR</key><string>${xml(sessions)}</string>`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_SESSION_KERNEL_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(LAUNCHD_SESSION_KERNEL_LAUNCHER)}</string></array>
  <key>WorkingDirectory</key><string>${xml(serviceWorkdir())}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(servicePath(binDir))}</string>
    <key>HOME</key><string>${xml(HOME)}</string>
    <key>NODE_ENV</key><string>production</string>
    <key>OPENSESSION_SESSION_KERNEL_TOKEN_FILE</key><string>${xml(USER_SESSION_KERNEL_TOKEN_PATH)}</string>
${optional}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(LOG_DIR, "session-kernel.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(LOG_DIR, "session-kernel.err.log"))}</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
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
  <key>WorkingDirectory</key><string>${xml(serviceWorkdir())}</string>
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

export async function install(
  opts: { scope?: SystemdScope } = {},
): Promise<boolean> {
  switch (supervisor()) {
    case "systemd": {
      const scope = opts.scope ?? "user";
      const wasActive = installedScope() === scope && (await isActive());
      const unit = await renderUnit(scope);
      const sourceIngress = !isCompiledBinary();
      const ingressUnit = sourceIngress ? await renderIngressUnit(scope) : "";
      const socketUnit = await renderSocketUnit(scope);
      const kernelUnit = await renderSessionKernelUnit(scope);
      const env = userEnv();
      let migratedUserUnit: string | null = null;
      let migratedUserIngressUnit: string | null = null;
      let migratedUserKernelUnit: string | null = null;
      let migratedUserSocketUnit: string | null = null;

      if (scope === "user") {
        if (
          process.env[IMDS_OVERRIDE_ENV] !== "1" &&
          (await metadataEndpointReachable())
        ) {
          const uid = process.getuid?.() ?? 0;
          fail("service installation blocked: EC2/cloud metadata is reachable");
          for (const line of metadataInstallBlockGuidance(uid)) info(line);
          return false;
        }
        if (existsSync(SERVICE_PATH)) {
          warn(
            `a system unit exists at ${SERVICE_PATH}`,
            "remove it (sudo systemctl disable --now opensession) or use --system",
          );
          return false;
        }
        mkdirSync(dirname(USER_UNIT_PATH), { recursive: true });
        if (!existsSync(USER_SESSION_KERNEL_TOKEN_PATH)) {
          await Bun.write(
            USER_SESSION_KERNEL_TOKEN_PATH,
            `${crypto.randomUUID()}${crypto.randomUUID()}\n`,
          );
          chmodSync(USER_SESSION_KERNEL_TOKEN_PATH, 0o600);
        }
        await Bun.write(USER_UNIT_PATH, unit);
        if (sourceIngress) await Bun.write(USER_INGRESS_UNIT_PATH, ingressUnit);
        await Bun.write(USER_SOCKET_PATH, socketUnit);
        await Bun.write(USER_SESSION_KERNEL_UNIT_PATH, kernelUnit);
        info(dim(`installed ${USER_UNIT_PATH}`));
        if (sourceIngress) info(dim(`installed ${USER_INGRESS_UNIT_PATH}`));
        info(dim(`installed ${USER_SOCKET_PATH}`));
        info(dim(`installed ${USER_SESSION_KERNEL_UNIT_PATH}`));
        await enableLinger();
        const runtimeDir =
          process.env.XDG_RUNTIME_DIR ?? env.XDG_RUNTIME_DIR ?? "";
        for (
          let i = 0;
          i < 20 && !existsSync(join(runtimeDir, "systemd", "private"));
          i++
        ) {
          await Bun.sleep(500);
        }
      } else {
        const executorUnit = await renderExecutorUnit();
        await Bun.write(STAGED_UNIT_PATH, unit);
        if (sourceIngress)
          await Bun.write(STAGED_INGRESS_UNIT_PATH, ingressUnit);
        await Bun.write(STAGED_SOCKET_PATH, socketUnit);
        await Bun.write(STAGED_EXECUTOR_UNIT_PATH, executorUnit);
        await Bun.write(STAGED_SESSION_KERNEL_UNIT_PATH, kernelUnit);
        const serviceUser = await resolveUsername();
        const compiled = isCompiledBinary();
        const runnerBin = compiled ? SHIM_PATH : bunPath();
        const bun = compiled ? runnerBin : bunPath();
        const pathValue = servicePath(
          compiled ? BIN_DIR : bun.replace(/\/bun$/, ""),
        );
        const executorWasActive =
          (await run(["systemctl", "is-active", EXECUTOR_SERVICE_NAME]))
            .stdout === "active";
        info(
          dim(`installing ${STAGED_UNIT_PATH} -> ${SERVICE_PATH} (needs sudo)`),
        );
        const prep = [
          [
            "sudo",
            join(serviceWorkdir(), "deploy", "install-resource-control.sh"),
          ],
          [
            "sudo",
            join(serviceWorkdir(), "deploy", "install-executor-credential.sh"),
            EXECUTOR_TOKEN_PATH,
          ],
          [
            "sudo",
            join(
              serviceWorkdir(),
              "deploy",
              "install-session-kernel-credential.sh",
            ),
            SESSION_KERNEL_TOKEN_PATH,
          ],
          [
            "sudo",
            join(serviceWorkdir(), "deploy", "install-run-host-helper.sh"),
            serviceUser,
            serviceWorkdir(),
            bun,
            HOME,
            ENV_PATH,
            runHostsRoot(),
            pathValue,
            process.env.OPENSESSION_DEPLOY_CHECKOUT || serviceWorkdir(),
            process.env.OPENSESSION_DEPLOY_STATE || defaultStatePath("deploy"),
            process.env.OPENSESSION_DEPLOY_ALLOW_RESET === "1" ? "1" : "0",
            process.env.OPENSESSION_HEALTH_URL ||
              "http://127.0.0.1:3850/api/health",
            compiled ? "compiled" : "source",
            runnerBin,
          ],
          ["sudo", "-n", RUN_HOST_HELPER, "check"],
          ["sudo", "cp", STAGED_UNIT_PATH, SERVICE_PATH],
          ...(sourceIngress
            ? [["sudo", "cp", STAGED_INGRESS_UNIT_PATH, INGRESS_SERVICE_PATH]]
            : []),
          ["sudo", "cp", STAGED_SOCKET_PATH, SOCKET_PATH],
          ["sudo", "cp", STAGED_EXECUTOR_UNIT_PATH, EXECUTOR_SERVICE_PATH],
          [
            "sudo",
            "cp",
            STAGED_SESSION_KERNEL_UNIT_PATH,
            SESSION_KERNEL_SERVICE_PATH,
          ],
          [
            "sudo",
            "rm",
            "-f",
            "/etc/systemd/system/opensession.service.d/executor-credential.conf",
          ],
        ];
        for (const cmd of prep) {
          if ((await runInherit(cmd)) !== 0) {
            warn(`failed: ${cmd.join(" ")}`);
            return false;
          }
        }
        if (existsSync(USER_UNIT_PATH)) {
          info(
            dim(
              "stopping the existing user service; the system units take over",
            ),
          );
          migratedUserUnit = await Bun.file(USER_UNIT_PATH).text();
          if (existsSync(USER_INGRESS_UNIT_PATH))
            migratedUserIngressUnit = await Bun.file(
              USER_INGRESS_UNIT_PATH,
            ).text();
          if (existsSync(USER_SESSION_KERNEL_UNIT_PATH))
            migratedUserKernelUnit = await Bun.file(
              USER_SESSION_KERNEL_UNIT_PATH,
            ).text();
          if (existsSync(USER_SOCKET_PATH))
            migratedUserSocketUnit = await Bun.file(USER_SOCKET_PATH).text();
          await runInherit(
            systemctl("user", ["disable", "--now", SERVICE_NAME]),
            undefined,
            env,
          );
          await runInherit(
            systemctl("user", [
              "disable",
              "--now",
              SESSION_KERNEL_SERVICE_NAME,
            ]),
            undefined,
            env,
          );
          if (existsSync(USER_INGRESS_UNIT_PATH))
            await runInherit(
              systemctl("user", [
                "disable",
                "--now",
                "opensession-ingress.service",
              ]),
              undefined,
              env,
            );
          if (existsSync(USER_SOCKET_PATH))
            await runInherit(
              systemctl("user", ["disable", "--now", SOCKET_NAME]),
              undefined,
              env,
            );
          await run([
            "rm",
            "-f",
            USER_UNIT_PATH,
            USER_INGRESS_UNIT_PATH,
            USER_SOCKET_PATH,
            USER_SESSION_KERNEL_UNIT_PATH,
          ]);
          await runInherit(
            systemctl("user", ["daemon-reload"]),
            undefined,
            env,
          );
        }
        const start = [
          ...(wasActive ? [["sudo", "systemctl", "stop", SERVICE_NAME]] : []),
          ["sudo", "systemctl", "daemon-reload"],
          ["sudo", "systemctl", "enable", "--now", SOCKET_NAME],
          ...(sourceIngress
            ? [
                [
                  "sudo",
                  "systemctl",
                  "enable",
                  "--now",
                  "opensession-ingress.service",
                ],
              ]
            : []),
          ["sudo", "systemctl", "enable", EXECUTOR_SERVICE_NAME],
          [
            "sudo",
            "systemctl",
            executorWasActive ? "restart" : "start",
            EXECUTOR_SERVICE_NAME,
          ],
          ["sudo", "systemctl", "enable", SESSION_KERNEL_SERVICE_NAME],
          ["sudo", "systemctl", "restart", SESSION_KERNEL_SERVICE_NAME],
          ["sudo", "systemctl", "enable", "--now", SERVICE_NAME],
        ];
        for (const cmd of start) {
          if ((await runInherit(cmd)) !== 0) {
            warn(`failed: ${cmd.join(" ")}`);
            if (migratedUserUnit) {
              warn("restoring the user service");
              mkdirSync(dirname(USER_UNIT_PATH), { recursive: true });
              await Bun.write(USER_UNIT_PATH, migratedUserUnit);
              if (migratedUserIngressUnit)
                await Bun.write(
                  USER_INGRESS_UNIT_PATH,
                  migratedUserIngressUnit,
                );
              if (migratedUserKernelUnit)
                await Bun.write(
                  USER_SESSION_KERNEL_UNIT_PATH,
                  migratedUserKernelUnit,
                );
              if (migratedUserSocketUnit)
                await Bun.write(USER_SOCKET_PATH, migratedUserSocketUnit);
              await runInherit(
                systemctl("user", ["daemon-reload"]),
                undefined,
                env,
              );
              if (migratedUserKernelUnit)
                await runInherit(
                  systemctl("user", [
                    "enable",
                    "--now",
                    SESSION_KERNEL_SERVICE_NAME,
                  ]),
                  undefined,
                  env,
                );
              if (migratedUserIngressUnit)
                await runInherit(
                  systemctl("user", [
                    "enable",
                    "--now",
                    "opensession-ingress.service",
                  ]),
                  undefined,
                  env,
                );
              await runInherit(
                systemctl("user", ["enable", "--now", SOCKET_NAME]),
                undefined,
                env,
              );
              await runInherit(
                systemctl("user", ["enable", "--now", SERVICE_NAME]),
                undefined,
                env,
              );
            }
            return false;
          }
        }
        ok(
          wasActive
            ? "system services reinstalled and restarted"
            : "system services installed and started",
        );
        return true;
      }

      for (const cmd of [
        ...(wasActive ? [systemctl(scope, ["stop", SERVICE_NAME])] : []),
        systemctl(scope, ["daemon-reload"]),
        systemctl(scope, ["enable", "--now", SOCKET_NAME]),
        ...(sourceIngress
          ? [
              systemctl(scope, [
                "enable",
                "--now",
                "opensession-ingress.service",
              ]),
            ]
          : []),
        systemctl(scope, ["enable", SESSION_KERNEL_SERVICE_NAME]),
        systemctl(scope, ["restart", SESSION_KERNEL_SERVICE_NAME]),
        systemctl(scope, ["enable", "--now", SERVICE_NAME]),
      ]) {
        if ((await runInherit(cmd, undefined, env)) !== 0) {
          warn(`failed: ${cmd.join(" ")}`);
          return false;
        }
      }
      ok(
        wasActive
          ? "user service reinstalled and restarted"
          : "user service installed and started",
      );
      return true;
    }

    case "launchd": {
      mkdirSync(join(HOME, "Library", "LaunchAgents"), { recursive: true });
      mkdirSync(LOG_DIR, { recursive: true });
      mkdirSync(dirname(LAUNCHD_LAUNCHER), { recursive: true });
      if (!existsSync(USER_SESSION_KERNEL_TOKEN_PATH)) {
        await Bun.write(
          USER_SESSION_KERNEL_TOKEN_PATH,
          `${crypto.randomUUID()}${crypto.randomUUID()}\n`,
        );
        chmodSync(USER_SESSION_KERNEL_TOKEN_PATH, 0o600);
      }
      await Bun.write(LAUNCHD_LAUNCHER, renderLauncher());
      await Bun.write(
        LAUNCHD_SESSION_KERNEL_LAUNCHER,
        renderSessionKernelLauncher(),
      );
      chmodSync(LAUNCHD_LAUNCHER, 0o755);
      chmodSync(LAUNCHD_SESSION_KERNEL_LAUNCHER, 0o755);
      await Bun.write(LAUNCHD_PLIST, renderPlist());
      await Bun.write(LAUNCHD_SESSION_KERNEL_PLIST, renderSessionKernelPlist());
      await run(["launchctl", "bootout", `${domain()}/${LAUNCHD_LABEL}`]);
      await run([
        "launchctl",
        "bootout",
        `${domain()}/${LAUNCHD_SESSION_KERNEL_LABEL}`,
      ]);
      const kernel = await bootstrapLaunchAgent(
        LAUNCHD_SESSION_KERNEL_LABEL,
        LAUNCHD_SESSION_KERNEL_PLIST,
      );
      if (kernel.code !== 0) {
        warn(`launchctl actor bootstrap failed: ${kernel.stderr}`);
        return false;
      }
      const { code, stderr } = await bootstrapLaunchAgent(
        LAUNCHD_LABEL,
        LAUNCHD_PLIST,
      );
      if (code !== 0) {
        warn(`launchctl bootstrap failed: ${stderr}`);
        return false;
      }
      ok("LaunchAgent installed and started", LAUNCHD_PLIST);
      return true;
    }

    default:
      warn(
        "no service manager available: run `opensession start --foreground`",
      );
      return false;
  }
}

/** Restart the independent executor after a system-scope release swap. */
export async function restartExecutor(): Promise<number> {
  if (supervisor() !== "systemd" || installedScope() !== "system") return 0;
  return await runInherit([
    "sudo",
    "systemctl",
    "restart",
    EXECUTOR_SERVICE_NAME,
  ]);
}

export async function control(
  action: "start" | "stop" | "restart",
): Promise<number> {
  if (!(await isInstalled())) {
    warn(
      `no service installed — run it directly with ${dim("opensession start --foreground")}`,
    );
    return 1;
  }

  if (supervisor() === "launchd") {
    const label = `${domain()}/${LAUNCHD_LABEL}`;
    const kernel = `${domain()}/${LAUNCHD_SESSION_KERNEL_LABEL}`;
    switch (action) {
      case "start": {
        const actorLoaded =
          (await run(["launchctl", "print", kernel], { quiet: true })).code ===
          0;
        const actor = await runInherit(
          actorLoaded
            ? ["launchctl", "kickstart", kernel]
            : [
                "launchctl",
                "bootstrap",
                domain(),
                LAUNCHD_SESSION_KERNEL_PLIST,
              ],
        );
        if (actor !== 0) return actor;
        const gatewayLoaded =
          (await run(["launchctl", "print", label], { quiet: true })).code ===
          0;
        return await runInherit(
          gatewayLoaded
            ? ["launchctl", "kickstart", label]
            : ["launchctl", "bootstrap", domain(), LAUNCHD_PLIST],
        );
      }
      case "stop": {
        const gateway = await runInherit(["launchctl", "bootout", label]);
        const actor = await runInherit(["launchctl", "bootout", kernel]);
        return gateway || actor;
      }
      case "restart": {
        await runInherit(["launchctl", "bootout", label]);
        const actor = await runInherit([
          "launchctl",
          "kickstart",
          "-k",
          kernel,
        ]);
        if (actor !== 0) return actor;
        return await runInherit([
          "launchctl",
          "bootstrap",
          domain(),
          LAUNCHD_PLIST,
        ]);
      }
    }
  }

  const scope = installedScope() ?? "user";
  const env = userEnv();
  if (action === "start") {
    const socket = await runInherit(
      systemctl(scope, ["start", SOCKET_NAME]),
      undefined,
      env,
    );
    if (socket !== 0) return socket;
    const actor = await runInherit(
      systemctl(scope, ["start", SESSION_KERNEL_SERVICE_NAME]),
      undefined,
      env,
    );
    return actor === 0
      ? await runInherit(
          systemctl(scope, ["start", SERVICE_NAME]),
          undefined,
          env,
        )
      : actor;
  }
  const gateway = await runInherit(
    systemctl(scope, ["stop", SERVICE_NAME]),
    undefined,
    env,
  );
  const actor = await runInherit(
    systemctl(scope, [
      action === "restart" ? "restart" : "stop",
      SESSION_KERNEL_SERVICE_NAME,
    ]),
    undefined,
    env,
  );
  if (action === "stop") {
    const socket = await runInherit(
      systemctl(scope, ["stop", SOCKET_NAME]),
      undefined,
      env,
    );
    return gateway || actor || socket;
  }
  return actor === 0
    ? await runInherit(
        systemctl(scope, ["start", SERVICE_NAME]),
        undefined,
        env,
      )
    : actor;
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
  const cmd = [
    "journalctl",
    ...(scope === "user" ? ["--user"] : []),
    "-u",
    SERVICE_NAME,
    "-n",
    String(lines),
  ];
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
      await runInherit(
        systemctl(scope, ["disable", "--now", SERVICE_NAME]),
        undefined,
        env,
      );
      await runInherit(
        systemctl(scope, ["disable", "--now", "opensession-ingress.service"]),
        undefined,
        env,
      );
      await runInherit(
        systemctl(scope, ["disable", "--now", SOCKET_NAME]),
        undefined,
        env,
      );
      if (scope === "user") {
        await runInherit(
          systemctl(scope, ["disable", "--now", SESSION_KERNEL_SERVICE_NAME]),
          undefined,
          env,
        );
        await run([
          "rm",
          "-f",
          USER_UNIT_PATH,
          USER_INGRESS_UNIT_PATH,
          USER_SOCKET_PATH,
          USER_SESSION_KERNEL_UNIT_PATH,
          USER_SESSION_KERNEL_TOKEN_PATH,
        ]);
        await runInherit(systemctl(scope, ["daemon-reload"]), undefined, env);
        ok("user service removed");
        return true;
      }
      await runInherit([
        "sudo",
        "systemctl",
        "disable",
        "--now",
        EXECUTOR_SERVICE_NAME,
      ]);
      await runInherit([
        "sudo",
        "systemctl",
        "disable",
        "--now",
        SESSION_KERNEL_SERVICE_NAME,
      ]);
      for (const path of [
        SERVICE_PATH,
        INGRESS_SERVICE_PATH,
        SOCKET_PATH,
        EXECUTOR_SERVICE_PATH,
        SESSION_KERNEL_SERVICE_PATH,
        "/etc/systemd/system/opensession.service.d/executor-credential.conf",
        "/etc/systemd/system/opensession.service.d/session-kernel-credential.conf",
        EXECUTOR_TOKEN_PATH,
        SESSION_KERNEL_TOKEN_PATH,
        "/etc/opensession/run-host.conf",
        "/etc/sudoers.d/opensession-run-host",
        RUN_HOST_HELPER,
      ]) {
        if ((await runInherit(["sudo", "rm", "-f", path])) !== 0) return false;
      }
      await runInherit([
        "sudo",
        "rmdir",
        "/etc/systemd/system/opensession.service.d",
        "/etc/opensession",
      ]);
      await runInherit(systemctl(scope, ["daemon-reload"]), undefined, env);
      ok("system services and executor policy removed");
      return true;
    }
    case "launchd": {
      if (!existsSync(LAUNCHD_PLIST)) return true;
      await run(["launchctl", "bootout", `${domain()}/${LAUNCHD_LABEL}`]);
      await run([
        "launchctl",
        "bootout",
        `${domain()}/${LAUNCHD_SESSION_KERNEL_LABEL}`,
      ]);
      await run([
        "rm",
        "-f",
        LAUNCHD_PLIST,
        LAUNCHD_LAUNCHER,
        LAUNCHD_SESSION_KERNEL_PLIST,
        LAUNCHD_SESSION_KERNEL_LAUNCHER,
        USER_SESSION_KERNEL_TOKEN_PATH,
      ]);
      ok("LaunchAgent removed");
      return true;
    }
    default:
      return true;
  }
}
