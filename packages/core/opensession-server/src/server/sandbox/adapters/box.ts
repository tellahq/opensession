/**
 * BoxProvider — remote sandbox adapter over the ascii.dev Box API
 * (https://docs.ascii.dev/box/api/v1). Boxes are persistent Ubuntu VMs with
 * small/default/large machine profiles, Docker inside,
 * per-second billing, EU) with archive/resume snapshots — archival is
 * recoverable, so the idle contract is gentler than E2B's kill-on-countdown.
 *
 * No SDK dependency: the public API is plain JSON, and a small typed fetch
 * client keeps provider failures and request ids visible. Endpoints (base
 * https://ascii.dev/api/box/v1, Bearer `box_…` key):
 *   POST /boxes {ttlSeconds,noEnv}    create (returns provisioning; poll GET)
 *   GET  /boxes, GET /boxes/{id}      list (cursor-paginated) / get
 *   PATCH /boxes/{id} {name,ttlSeconds}  rename + reset the auto-stop timer
 *   POST /boxes/{id}/commands         sync/detached shell exec (600s sync cap)
 *   GET  /boxes/{id}/commands/{pid}   detached process status + log tails
 *   PUT  /boxes/{id}/files            write file (base64)
 *   POST /boxes/{id}/stop|resume      persistent pause/resume
 *   POST /named-snapshots             reusable repo templates
 *
 * Shape (shared machinery in ./bootstrap.ts):
 *  - ensure(): find the session's box by NAME (`PATCH name=<sessionId>` after
 *    create — the API has no labels; the local state file is the fallback
 *    index), create otherwise, resume if archived, bootstrap the runner
 *    payload, clone the workspace inside (always volume-style).
 *  - Idle model: a box has a TTL countdown to ARCHIVAL (max 30 days; archived
 *    boxes resume with disk intact). Created with idleStopMinutes and reset
 *    via PATCH on touchActivity — mirroring E2B's countdown-extension, but a
 *    missed touch archives (recoverable) instead of killing the workspace.
 *  - exec(): uses the 600-second synchronous command surface and Box's native
 *    detached-process API for longer calls. execBackground() is native too.
 *  - ports(): the in-box `host <port>` CLI registers a public HTTPS route
 *    (https://<subdomain>-<port>.on.ascii.dev, `_token`-protected by default)
 *    and prints the URL — parsed into PortMap `{url}` entries.
 *  - prewarm/templates: opt-in project setup is sealed into a named snapshot;
 *    new sessions restore it in seconds and warm-on-typing boxes are adopted.
 *  - pause()/resume()/destroy(): stop/archive retains the durable workspace
 *    without billing; the public API intentionally exposes archive, not hard
 *    deletion, so destroy releases compute and forgets the local association.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import { stateDir } from "../../paths";
import { getRepo, worktreePathFor } from "../../worktree";
import { sandboxConfig } from "../config";
import {
  getSandboxConnection,
  sandboxProviderCredential,
} from "../connections";
import type {
  PortMap,
  Sandbox,
  SandboxProvider,
  SandboxSessionSpec,
  SandboxStatus,
} from "../provider";
import {
  assertDialbackReachable,
  bootstrapRemoteSandbox,
  findRemoteStateBySession,
  makeRemoteSandbox,
  readRemoteState,
  remoteCloneUrl,
  removeRemoteState,
  resolveTrustPolicy,
  setupRemoteWorkspace,
  shellQuoteWord,
  touchRemoteState,
  withRemoteEnsureLock,
  writeRemoteState,
  type RemoteDriver,
  type RemoteExecOpts,
} from "./bootstrap";
import {
  claimPrewarmOrWait,
  discardClaimedPrewarm,
  PREWARM_KEY_LABEL,
  PREWARM_LABEL,
  type PrewarmAdapter,
  type SandboxMachineSettings,
} from "../prewarm";
import {
  invalidateRemoteRepoTemplate,
  readRemoteRepoTemplate,
  remoteRepoTemplateName,
  sealRemoteRepoTemplate,
  writeRemoteRepoTemplate,
} from "../remote-repo-template";

const DEFAULT_API_URL = "https://ascii.dev/api/box/v1";
const DEFAULT_IDLE_STOP_MINUTES = 30;
const POLL_INTERVAL_MS = 2_500;
const COMMAND_TAIL_BYTES = 524_288;
const TEMPLATE_WAIT_MS = 15 * 60_000;

/** States where the VM is up and can take commands. `running` is their
 *  "agent busy" state — still a live VM. */
const LIVE_STATES = new Set(["ready", "idle", "running"]);

interface BoxRecord {
  id: string;
  name?: string;
  state?: string;
  url?: string | null;
  ip?: string | null;
  sshEndpoint?: string | null;
  type?: BoxMachineType;
}

export type BoxMachineType = "small" | "default" | "large";

interface BoxCommandResponse {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

interface BoxCommandStartedResponse {
  processId: number;
  success?: boolean;
}

interface BoxCommandStatusResponse extends BoxCommandResponse {
  processId: number;
  running: boolean;
  status?: "running" | "exited" | "lost";
}

interface BoxListPage {
  boxes: BoxRecord[];
  pageInfo?: { nextCursor: string | null; hasMore: boolean };
}

interface BoxClientConfig {
  apiKey: string;
  apiUrl: string;
}

function boxClientConfig(): BoxClientConfig {
  const settings = getSandboxConnection("box")?.settings || {};
  const apiKey = (
    sandboxProviderCredential("box") as { apiKey: string } | undefined
  )?.apiKey;
  if (!apiKey) {
    throw new Error("Box workspace credentials are not configured");
  }
  return {
    apiKey,
    apiUrl: (settings.apiUrl || DEFAULT_API_URL).replace(/\/+$/, ""),
  };
}

async function boxApi<T>(
  cfg: BoxClientConfig,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<T> {
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 300);
    let code: string | undefined;
    let requestId: string | undefined;
    try {
      const parsed = JSON.parse(text) as {
        code?: string;
        message?: string;
        requestId?: string;
      };
      code = parsed.code;
      requestId = parsed.requestId;
      detail = parsed.message || detail;
    } catch {}
    const err = new Error(
      `box API ${method} ${path} failed: HTTP ${res.status}${code ? ` ${code}` : ""}${detail ? ` — ${detail}` : ""}${requestId ? ` (request ${requestId})` : ""}`,
    ) as Error & { status?: number; code?: string; requestId?: string };
    err.status = res.status;
    err.code = code;
    err.requestId = requestId;
    throw err;
  }
  return (await res.json()) as T;
}

function isNotFound(e: unknown): boolean {
  return (e as { status?: number })?.status === 404;
}

/** A 409 here means Box has not accepted the command — retrying after a
 * resume is safe. It is distinct from a 502, where the command may have run. */
export function boxCommandPlaneUnavailable(error: unknown): boolean {
  const detail = error as { status?: number; code?: string };
  return (
    detail?.status === 409 &&
    (detail.code === "machine_not_running" || detail.code === "box_starting")
  );
}

async function getBox(
  cfg: BoxClientConfig,
  boxId: string,
): Promise<BoxRecord | null> {
  try {
    const res = await boxApi<{ box?: BoxRecord } & BoxRecord>(
      cfg,
      "GET",
      `/boxes/${boxId}`,
    );
    return res.box || res;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

function stateOf(box: BoxRecord | null): SandboxStatus {
  if (!box) return "gone";
  const s = String(box.state || "");
  if (LIVE_STATES.has(s)) return "running";
  if (s === "error") return "gone";
  // init/provisioning/provisioned/cloning/archiving/archived — recoverable.
  return "stopped";
}

function idleTtlSeconds(): number {
  return Math.min(
    30 * 24 * 60 * 60,
    (sandboxConfig().idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES) * 60,
  );
}

const BOX_MACHINE_PROFILES: Record<
  BoxMachineType,
  Required<SandboxMachineSettings>
> = {
  small: { cpu: 2, memoryMb: 4_096, diskGb: 40 },
  default: { cpu: 4, memoryMb: 8_192, diskGb: 80 },
  large: { cpu: 8, memoryMb: 16_384, diskGb: 100 },
};

export function boxMachineType(
  settings?: SandboxMachineSettings,
): BoxMachineType {
  if (!settings || !Object.keys(settings).length) return "default";
  const match = (
    Object.entries(BOX_MACHINE_PROFILES) as Array<
      [BoxMachineType, Required<SandboxMachineSettings>]
    >
  ).find(
    ([, profile]) =>
      profile.cpu === settings.cpu &&
      profile.memoryMb === settings.memoryMb &&
      profile.diskGb === settings.diskGb,
  );
  if (!match) {
    throw Object.assign(
      new Error("Choose one of Box's Small, Default, or Large machine sizes"),
      {
        code: "MACHINE_SETTINGS_INVALID",
      },
    );
  }
  return match[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForLive(
  cfg: BoxClientConfig,
  boxId: string,
  deadlineMs: number,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let last = "";
  let resumeRequested = false;
  while (Date.now() < deadline) {
    const box = await getBox(cfg, boxId);
    if (!box) throw new Error(`box ${boxId} is gone`);
    last = String(box.state || "");
    if (LIVE_STATES.has(last)) return;
    if (last === "error") throw new Error(`box ${boxId} is in error state`);
    if (last === "archived" && !resumeRequested) {
      resumeRequested = true;
      try {
        await boxApi(cfg, "POST", `/boxes/${boxId}/resume`, {
          noEnv: true,
          ttlSeconds: idleTtlSeconds(),
        });
      } catch (e) {
        // The response may be lost after Box accepted the wake. Never turn one
        // follow-up into dozens of start-counting resume requests.
        console.warn(
          `[sandbox:box] resume(${boxId}) failed (will only poll):`,
          e,
        );
      }
    }
    await sleep(3_000);
  }
  throw new Error(
    `box ${boxId} did not become ready in ${deadlineMs}ms (state: ${last})`,
  );
}

async function waitForState(
  cfg: BoxClientConfig,
  boxId: string,
  expected: Set<string>,
  deadlineMs: number,
): Promise<BoxRecord> {
  const deadline = Date.now() + deadlineMs;
  let last = "";
  while (Date.now() < deadline) {
    const box = await getBox(cfg, boxId);
    if (!box) throw new Error(`box ${boxId} is gone`);
    last = String(box.state || "");
    if (expected.has(last)) return box;
    if (last === "error")
      throw new Error(`box ${boxId} entered the error state`);
    await sleep(3_000);
  }
  throw new Error(
    `box ${boxId} did not reach ${[...expected].join("/")} (state: ${last})`,
  );
}

// ── Driver ────────────────────────────────────────────────────────────────────

/** cwd/env fold into the command string: the commands endpoint only takes a
 *  cwd RELATIVE to the box work dir, and no env at all. */
export function boxComposeShell(cmd: string, opts?: RemoteExecOpts): string {
  let s = cmd;
  const env = opts?.env && Object.keys(opts.env).length ? opts.env : undefined;
  if (env) {
    const pairs = Object.entries(env)
      .map(([k, v]) => `${k}=${shellQuoteWord(v)}`)
      .join(" ");
    s = `env ${pairs} sh -c ${shellQuoteWord(s)}`;
  }
  if (opts?.cwd) s = `cd ${shellQuoteWord(opts.cwd)} && { ${s}\n}`;
  return `mkdir -p /home/ubuntu/.tmp && export TMPDIR=/home/ubuntu/.tmp && ${s}`;
}

export function boxNativeFilePath(path: string): string {
  if (path === "/home/ubuntu") return "/home/user";
  if (path.startsWith("/home/ubuntu/")) {
    return `/home/user/${path.slice("/home/ubuntu/".length)}`;
  }
  return path;
}

export function boxResumePrimeCommand(cwd: string): string {
  return (
    `if test -d ${shellQuoteWord(cwd)}/.git; then cd ${shellQuoteWord(cwd)} && ` +
    `{ git ls-files -z | xargs -0 -r -n 64 -P 16 stat -c '%n' -- >/dev/null 2>&1; ` +
    `GIT_OPTIONAL_LOCKS=0 git status --porcelain >/dev/null 2>&1; }; fi`
  );
}

function primeBoxWorkspaceAfterResume(driver: RemoteDriver, cwd: string): void {
  void driver
    .execBackground(boxResumePrimeCommand(cwd), { timeoutMs: 15_000 })
    .catch((error) => {
      console.warn(
        `[sandbox:box] could not start resumed workspace hydration:`,
        error,
      );
    });
}

export const BOX_RUNTIME_HOME_COMMAND =
  "test -d /home/user && test -w /home/user && " +
  "if mountpoint -q /home/ubuntu; then " +
  "if ! test /home/ubuntu -ef /home/user; then " +
  "sudo -n umount /home/ubuntu && sudo -n mount --bind /home/user /home/ubuntu; fi; " +
  "else " +
  "if [ -L /home/ubuntu ]; then sudo -n rm /home/ubuntu; " +
  'elif [ -d /home/ubuntu ] && [ -z "$(ls -A /home/ubuntu)" ]; then sudo -n rmdir /home/ubuntu; ' +
  "elif [ -e /home/ubuntu ]; then echo 'cannot replace non-empty /home/ubuntu' >&2; exit 1; fi; " +
  "sudo -n mkdir -p /home/ubuntu && sudo -n mount --bind /home/user /home/ubuntu; " +
  "fi && test ! -L /home/ubuntu && mountpoint -q /home/ubuntu && " +
  "test /home/ubuntu -ef /home/user && test -w /home/ubuntu";

function boxSshTargets(): Map<string, BoxSshTarget> {
  const global = globalThis as typeof globalThis & {
    __opensessionBoxSshTargets?: Map<string, BoxSshTarget>;
  };
  return (global.__opensessionBoxSshTargets ??= new Map());
}

export function parseBoxSshEndpoint(
  endpoint: string | null | undefined,
): { host: string; port: number } | null {
  const value = endpoint?.trim();
  if (!value) return null;
  const bracketed = value.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketed) return { host: bracketed[1]!, port: Number(bracketed[2]) };
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || value.slice(0, separator).includes(":")) return null;
  const port = Number(value.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host: value.slice(0, separator), port };
}

function existingBoxSshTarget(
  box: BoxRecord,
  user = "user",
): BoxSshTarget | null {
  const endpoint = parseBoxSshEndpoint(box.sshEndpoint);
  if (!endpoint || !existsSync(boxSshPrivateKey)) return null;
  return { ...endpoint, user, privateKeyPath: boxSshPrivateKey };
}

export function boxKnownHostsKey(
  target: Pick<BoxSshTarget, "host" | "port">,
): string {
  return target.port === 22 ? target.host : `[${target.host}]:${target.port}`;
}

export function boxMachineIpSshEndpoint(
  machineIp: string | null | undefined,
): { host: string; port: number } | null {
  const value = machineIp?.trim();
  // The documented sshkey response returns a direct IPv4 machineIp and uses
  // OpenSSH's standard port. IPv6 is not a safe fallback here: Box also
  // exposes an IPv6 machine address that is not reachable from every host.
  return value && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)
    ? { host: value, port: 22 }
    : null;
}

/** Box regenerates its SSH host key when an archived VM resumes. The endpoint
 * comes from Box's authenticated API and we install our public key in that
 * same API call, so forget only this exact host:port before accepting the new
 * provider key. */
async function forgetBoxSshHostKey(
  target: Pick<BoxSshTarget, "host" | "port">,
): Promise<void> {
  const knownHosts = `${boxSshKeyDir}/known_hosts`;
  if (!existsSync(knownHosts)) return;
  const process = Bun.spawn(
    ["ssh-keygen", "-q", "-R", boxKnownHostsKey(target), "-f", knownHosts],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  await process.exited;
}

function boxSshArgs(target: BoxSshTarget, command: string): string[] {
  return [
    "ssh",
    "-p",
    String(target.port),
    "-i",
    target.privateKeyPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${boxSshKeyDir}/known_hosts`,
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    // Reuse one host-local authenticated connection for launch material. The
    // %C hash scopes the socket to user/host/port/key, and OpenSSH falls back
    // safely when a resumed VM has killed the old master.
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=120",
    "-o",
    `ControlPath=${boxSshKeyDir}/cm-%C`,
    `${target.user}@${target.host}`,
    command,
  ];
}

async function boxSshExec(
  target: BoxSshTarget,
  shell: string,
  timeoutMs: number,
) {
  const process = Bun.spawn(boxSshArgs(target, shell), {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill();
    } catch {}
  }, timeoutMs);
  timer.unref?.();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]).finally(() => clearTimeout(timer));
  return { exitCode: timedOut ? 124 : exitCode, stdout, stderr };
}

async function boxSshWriteFile(
  target: BoxSshTarget,
  path: string,
  content: string,
): Promise<void> {
  const command = `mkdir -p ${shellQuoteWord(dirname(path))} && cat > ${shellQuoteWord(path)}`;
  const process = Bun.spawn(boxSshArgs(target, command), {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  process.stdin.write(content);
  await process.stdin.end();
  const [stderr, exitCode] = await Promise.all([
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(
      `Box SSH writeFile(${path}) failed: ${stderr.trim().slice(0, 300)}`,
    );
}

export function boxDriver(cfg: BoxClientConfig, boxId: string): RemoteDriver {
  let runtimeHomeReady = false;
  let commandPlaneReady = false;
  const result = (response: BoxCommandResponse) => ({
    exitCode: response.timedOut ? 124 : Number(response.exitCode ?? 1),
    stdout: response.stdout ?? "",
    stderr:
      (response.stderr ?? "") +
      (response.timedOut ? "\n[box] command timed out" : ""),
  });

  const startDetached = (shell: string) =>
    boxApi<BoxCommandStartedResponse>(
      cfg,
      "POST",
      `/boxes/${boxId}/commands`,
      { command: shell, detached: true },
      60_000,
    );

  const ensureRuntimeHome = async () => {
    // Box persists /home/user across archive/resume and named snapshots, while
    // the VM root is rebuilt. Bind-mount it at the cross-provider path on every
    // boot: unlike a symlink, this keeps path-sensitive tools such as direnv on
    // the stable /home/ubuntu spelling.
    const response = result(
      await boxApi<BoxCommandResponse>(
        cfg,
        "POST",
        `/boxes/${boxId}/commands`,
        { command: BOX_RUNTIME_HOME_COMMAND, timeoutSeconds: 60 },
        90_000,
      ),
    );
    if (response.exitCode !== 0) {
      throw new Error(
        `Box cannot provide Open Session's durable /home/ubuntu runtime path: ${(
          response.stderr || response.stdout
        )
          .trim()
          .slice(0, 200)}`,
      );
    }
    runtimeHomeReady = true;
  };

  const waitForCommandPlane = async () => {
    const deadline = Date.now() + 90_000;
    let last: unknown;
    let resumeRequested = false;
    while (Date.now() < deadline) {
      try {
        const probe = await boxApi<BoxCommandResponse>(
          cfg,
          "POST",
          `/boxes/${boxId}/commands`,
          { command: "true", timeoutSeconds: 15 },
          30_000,
        );
        if (probe.exitCode === 0 && !probe.timedOut) {
          commandPlaneReady = true;
          return;
        }
        // `true` is a read-only readiness probe. Box can briefly accept the
        // request after a wake but return an unsuccessful result while the VM
        // command service is still settling. Keep polling within the bounded
        // readiness window instead of treating that transient as a launch
        // failure.
        last = new Error("Box command readiness probe did not succeed");
        await sleep(POLL_INTERVAL_MS);
      } catch (error) {
        last = error;
        if (!boxCommandPlaneUnavailable(error)) throw error;
        // Resume consumes the provider's daily start quota even when repeated
        // for the same archived Box. Request it once, then readiness-poll only.
        if (!resumeRequested) {
          resumeRequested = true;
          try {
            await boxApi(
              cfg,
              "POST",
              `/boxes/${boxId}/resume`,
              { noEnv: true },
              30_000,
            );
          } catch (resumeError) {
            if (!boxCommandPlaneUnavailable(resumeError)) throw resumeError;
          }
        }
        await sleep(POLL_INTERVAL_MS);
      }
    }
    throw new Error(
      `Box ${boxId} did not accept commands after resume: ${
        last instanceof Error ? last.message : String(last || "unknown error")
      }`,
    );
  };

  const execOnce = (shell: string, timeoutMs: number) =>
    boxApi<BoxCommandResponse>(
      cfg,
      "POST",
      `/boxes/${boxId}/commands`,
      {
        command: shell,
        timeoutSeconds: Math.max(1, Math.min(600, Math.ceil(timeoutMs / 1000))),
      },
      timeoutMs + 30_000,
    );

  /** Retry exactly once only when Box confirms it accepted no request. */
  const afterCommandPlaneReady = async <T>(
    run: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (!boxCommandPlaneUnavailable(error)) throw error;
      runtimeHomeReady = false;
      commandPlaneReady = false;
      await waitForCommandPlane();
      await ensureRuntimeHome();
      return run();
    }
  };

  const execDetached = async (shell: string, timeoutMs: number) => {
    try {
      const started = await afterCommandPlaneReady(() => startDetached(shell));
      if (!Number.isInteger(started.processId)) {
        throw new Error("Box returned no process id for detached command");
      }
      const deadline = Date.now() + timeoutMs;
      let last: BoxCommandStatusResponse | undefined;
      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        try {
          last = await boxApi<BoxCommandStatusResponse>(
            cfg,
            "GET",
            `/boxes/${boxId}/commands/${started.processId}?tailBytes=${COMMAND_TAIL_BYTES}`,
            undefined,
            30_000,
          );
        } catch (error) {
          // The process was already accepted. Do not re-submit it; merely
          // wait for the command service to return before polling again.
          if (!boxCommandPlaneUnavailable(error)) throw error;
          runtimeHomeReady = false;
          commandPlaneReady = false;
          await waitForCommandPlane();
          await ensureRuntimeHome();
          continue;
        }
        if (!last.running) return result(last);
      }
      return {
        exitCode: 124,
        stdout: last?.stdout ?? "",
        stderr:
          (last?.stderr ?? "") +
          `\n[box] detached command ${started.processId} exceeded ${timeoutMs}ms`,
      };
    } catch (error) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  };

  return {
    async exec(cmd: string, opts?: RemoteExecOpts) {
      const shell = boxComposeShell(cmd, opts);
      const timeoutMs = opts?.timeoutMs ?? 120_000;
      const ssh = boxSshTargets().get(boxId);
      if (ssh) return boxSshExec(ssh, shell, timeoutMs);
      // Keep short probes on Box's reliable synchronous endpoint. Long setup
      // work and explicitly backgrounded workspace work use its independent
      // detached-process lane, so a clone or fetch cannot monopolize the
      // command plane while a run host is trying to launch.
      if (opts?.detached || timeoutMs >= 180_000)
        return execDetached(shell, timeoutMs);
      try {
        return result(
          await afterCommandPlaneReady(() => execOnce(shell, timeoutMs)),
        );
      } catch (error) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async execBackground(cmd: string, opts?: RemoteExecOpts) {
      const shell = boxComposeShell(cmd, opts);
      const ssh = boxSshTargets().get(boxId);
      if (ssh) {
        const detached = `nohup bash -c ${shellQuoteWord(shell)} </dev/null >/dev/null 2>&1 &`;
        const result = await boxSshExec(
          ssh,
          detached,
          opts?.timeoutMs ?? 30_000,
        );
        if (result.exitCode !== 0)
          throw new Error(
            result.stderr.trim() || "Box SSH background launch failed",
          );
        return;
      }
      const started = await afterCommandPlaneReady(() => startDetached(shell));
      if (!Number.isInteger(started.processId)) {
        throw new Error("Box returned no process id for background command");
      }
    },

    async writeFile(path: string, content: string) {
      const ssh = boxSshTargets().get(boxId);
      if (ssh) return boxSshWriteFile(ssh, path, content);
      // Box canonicalizes file paths and permits only /home/user or /tmp.
      // /home/ubuntu is our bind mount of that persistent home, so translate
      // the prefix explicitly and use the native file API instead of serializing
      // every launch-time credential write through a shell command.
      const nativePath = boxNativeFilePath(path);
      await afterCommandPlaneReady(() =>
        boxApi(
          cfg,
          "PUT",
          `/boxes/${boxId}/files`,
          { path: nativePath, content, encoding: "utf8" },
          60_000,
        ),
      );
    },

    async ensureStarted() {
      let box = await getBox(cfg, boxId);
      if (!box) throw new Error(`box ${boxId} is gone`);
      if (!LIVE_STATES.has(String(box.state || ""))) {
        runtimeHomeReady = false;
        commandPlaneReady = false;
        boxSshTargets().delete(boxId);
        await waitForLive(cfg, boxId, 300_000);
        box = await getBox(cfg, boxId);
        if (!box) throw new Error(`box ${boxId} disappeared after resume`);
      }

      // Box recommends a customer daemon/SSH lane for high-frequency control.
      // Its per-command HTTP proxy can report box_direct_failed while the VM
      // and durable disk are healthy. Reuse the installed key and the current
      // IPv4 endpoint after coordinator restarts and archive/resume rotations.
      const existingSsh =
        boxSshTargets().get(boxId) || existingBoxSshTarget(box);
      if (existingSsh) {
        const probe = await boxSshExec(existingSsh, "true", 20_000);
        if (probe.exitCode === 0) {
          boxSshTargets().set(boxId, existingSsh);
          const home = await boxSshExec(
            existingSsh,
            BOX_RUNTIME_HOME_COMMAND,
            60_000,
          );
          if (home.exitCode !== 0) {
            boxSshTargets().delete(boxId);
            throw new Error(
              `Box SSH could not restore /home/ubuntu: ${(home.stderr || home.stdout).trim().slice(0, 200)}`,
            );
          }
          runtimeHomeReady = true;
          commandPlaneReady = true;
          return;
        }
      }

      if (!commandPlaneReady) await waitForCommandPlane();
      if (!runtimeHomeReady) await ensureRuntimeHome();
      try {
        const target = await installBoxSshTarget(cfg, box);
        boxSshTargets().set(boxId, target);
      } catch (error) {
        console.warn(
          `[sandbox:box] could not establish SSH control lane for ${boxId}:`,
          error,
        );
      }
    },
  };
}

interface BoxSshKeyResponse {
  success?: boolean;
  machineIp?: string | null;
  sshUser?: string;
}

export interface BoxSshTarget {
  host: string;
  port: number;
  user: string;
  privateKeyPath: string;
}

const boxSshKeyDir = stateDir("sandbox-box-ssh");
const boxSshPrivateKey = `${boxSshKeyDir}/id_ed25519`;

async function ensureBoxSshKey(): Promise<{
  privateKeyPath: string;
  publicKey: string;
}> {
  const g = globalThis as typeof globalThis & {
    __opensessionBoxSshKey?: Promise<{
      privateKeyPath: string;
      publicKey: string;
    }>;
  };
  g.__opensessionBoxSshKey ??= (async () => {
    mkdirSync(boxSshKeyDir, { recursive: true, mode: 0o700 });
    chmodSync(boxSshKeyDir, 0o700);
    if (
      !existsSync(boxSshPrivateKey) ||
      !existsSync(`${boxSshPrivateKey}.pub`)
    ) {
      const process = Bun.spawn(
        [
          "ssh-keygen",
          "-q",
          "-t",
          "ed25519",
          "-N",
          "",
          "-C",
          "opensession-box",
          "-f",
          boxSshPrivateKey,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      const [exitCode, stderr] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
      ]);
      if (exitCode !== 0) {
        throw new Error(
          `could not create the Box terminal SSH key: ${stderr.trim()}`,
        );
      }
    }
    chmodSync(boxSshPrivateKey, 0o600);
    return {
      privateKeyPath: boxSshPrivateKey,
      publicKey: readFileSync(`${boxSshPrivateKey}.pub`, "utf-8").trim(),
    };
  })();
  try {
    return await g.__opensessionBoxSshKey;
  } catch (error) {
    delete g.__opensessionBoxSshKey;
    throw error;
  }
}

async function installBoxSshTarget(
  cfg: BoxClientConfig,
  box: BoxRecord,
): Promise<BoxSshTarget> {
  const key = await ensureBoxSshKey();
  const response = await boxApi<BoxSshKeyResponse>(
    cfg,
    "POST",
    `/boxes/${box.id}/sshkey`,
    { key: key.publicKey },
    60_000,
  );
  // The SSH endpoint can appear only after key installation. Refresh once
  // instead of giving up and paying Box's slow per-command HTTP proxy for the
  // whole session. Some API versions also return host:port in machineIp.
  let endpoint = parseBoxSshEndpoint(box.sshEndpoint);
  if (!endpoint)
    endpoint = parseBoxSshEndpoint((await getBox(cfg, box.id))?.sshEndpoint);
  if (!endpoint) endpoint = boxMachineIpSshEndpoint(response.machineIp);
  if (!response.success || !endpoint) {
    throw new Error("Box did not return a reachable SSH endpoint");
  }
  const target = {
    ...endpoint,
    user: response.sshUser || "user",
    privateKeyPath: key.privateKeyPath,
  };
  await forgetBoxSshHostKey(target);
  return target;
}

/** Wake a Box and install Open Session's dedicated public key for a real
 * interactive terminal. The private key never leaves this host. */
export async function boxSshTarget(sandboxId: string): Promise<BoxSshTarget> {
  const cfg = boxClientConfig();
  let box = await getBox(cfg, sandboxId);
  if (!box || stateOf(box) === "gone")
    throw new Error(`box ${sandboxId} is gone`);
  await boxDriver(cfg, sandboxId).ensureStarted();
  box = await getBox(cfg, sandboxId);
  if (!box) throw new Error(`box ${sandboxId} disappeared after resume`);
  const cached = boxSshTargets().get(sandboxId);
  if (cached) return cached;
  const target = await installBoxSshTarget(cfg, box);
  boxSshTargets().set(sandboxId, target);
  return target;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class BoxProvider implements SandboxProvider {
  readonly id = "box" as const;

  ensure(spec: SandboxSessionSpec): Promise<Sandbox> {
    return withRemoteEnsureLock(this.id, spec.sessionId, () =>
      this.ensureInner(spec),
    );
  }

  private async ensureInner(spec: SandboxSessionSpec): Promise<Sandbox> {
    const startedAt = Date.now();
    const mark = (stage: string) =>
      console.log(
        `[sandbox:box] ${spec.sessionId}: ${stage} (+${Date.now() - startedAt}ms)`,
      );
    if (spec.attachedDirs?.length) {
      throw new Error(
        "attached repos are not supported in remote sandboxes — detach them or use docker/local",
      );
    }
    const cfg = boxClientConfig();
    const prevState = findRemoteStateBySession(this.id, spec.sessionId);
    const trust = resolveTrustPolicy(spec, prevState);
    const repo = getRepo(spec.repo || prevState?.repoId);
    const branch = spec.branch || prevState?.branch || repo.defaultBranch;
    const cwd =
      spec.cwd ||
      prevState?.cwd ||
      worktreePathFor(branch, repo.id, { isolated: true });

    // The durable local mapping is written immediately after provider create,
    // before workspace setup. Prefer its O(1) id lookup: listing up to 500
    // account Boxes for a brand-new session added avoidable provider latency.
    let box: BoxRecord | null = null;
    let lifecycleRefreshed = false;
    if (prevState) {
      try {
        box = await getBox(cfg, prevState.sandboxId);
      } catch {}
    }
    if (box && stateOf(box) === "gone") box = null;
    if (!box) {
      const claim = await claimPrewarmOrWait(this.id, repo.id, spec.sessionId);
      if (claim) {
        try {
          const candidate = await getBox(cfg, claim.sandboxId);
          if (candidate && stateOf(candidate) !== "gone") {
            await boxApi(cfg, "PATCH", `/boxes/${candidate.id}`, {
              name: spec.sessionId,
              ttlSeconds: idleTtlSeconds(),
            });
            lifecycleRefreshed = true;
            box = candidate;
            console.log(
              `[sandbox:box] adopted prewarmed box ${candidate.id} for ${spec.sessionId}`,
            );
          } else {
            discardClaimedPrewarm(this.id, claim.sandboxId);
          }
        } catch (error) {
          console.warn(
            "[sandbox:box] prewarm adoption failed (cold-creating):",
            error,
          );
          discardClaimedPrewarm(this.id, claim.sandboxId);
        }
      }
    }
    if (!box) {
      console.log(`[sandbox:box] creating box for ${spec.sessionId}`);
      const template = readRemoteRepoTemplate("box", repo.id);
      const { sandboxEnvironmentSettings } = await import("../environments");
      const machineType = boxMachineType(
        sandboxEnvironmentSettings(repo.id, "box"),
      );
      // noEnv: never inject the ascii account's dashboard secrets — every
      // credential a run needs is uploaded scoped per launch (bootstrap.ts).
      const create = (from?: string) =>
        boxApi<{ box: BoxRecord }>(
          cfg,
          "POST",
          `/boxes`,
          {
            type: machineType,
            ttlSeconds: idleTtlSeconds(),
            noEnv: true,
            ...(from ? { from } : {}),
          },
          60_000,
        );
      let created: { box: BoxRecord };
      try {
        created = await create(template?.artifactId);
      } catch (error) {
        if (!template || !isNotFound(error)) throw error;
        invalidateRemoteRepoTemplate("box", repo.id);
        console.warn(
          `[sandbox:box] repo template ${template.artifactId} is unavailable; retrying cold`,
        );
        created = await create();
      }
      box = created.box;
      mark("box created");
      // The session name is the provider-side recovery index. The durable
      // local id written below is the hot path; the name remains useful for
      // operator recovery when local state is lost. A
      // rename failure is non-fatal — the local state file still maps it.
      try {
        await boxApi(cfg, "PATCH", `/boxes/${box.id}`, {
          name: spec.sessionId,
        });
      } catch (e) {
        console.warn(
          `[sandbox:box] rename(${box.id}) failed (state file still maps it):`,
          e,
        );
      }
    } else if (!lifecycleRefreshed) {
      // Reused an existing box. Adoption already refreshed this countdown in
      // the rename request above, so avoid a duplicate provider round trip.
      try {
        await boxApi(cfg, "PATCH", `/boxes/${box.id}`, {
          ttlSeconds: idleTtlSeconds(),
        });
      } catch {}
    }

    writeRemoteState({
      sandboxId: box.id,
      provider: this.id,
      sessionId: spec.sessionId,
      cwd,
      repoId: repo.id,
      branch,
      createdAt: prevState?.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      ...trust,
    });

    const driver = boxDriver(cfg, box.id);
    const resumingExistingWorkspace = Boolean(
      prevState && prevState.sandboxId === box.id && stateOf(box) !== "running",
    );
    await driver.ensureStarted();
    mark("box started");
    if (resumingExistingWorkspace) primeBoxWorkspaceAfterResume(driver, cwd);
    // Cheap dial-back probe BEFORE the expensive bootstrap — same rationale
    // as daytona: a box that can't reach our callback URL can never run.
    await assertDialbackReachable(driver, "box");
    mark("dial-back verified");
    await bootstrapRemoteSandbox(driver, "box");
    mark("runner ready");
    await setupRemoteWorkspace(
      driver,
      cwd,
      await remoteCloneUrl(repo),
      branch,
      repo.defaultBranch,
      repo.id,
      {
        sandboxId: box.id,
        provider: this.id,
        sessionId: spec.sessionId,
        repoId: repo.id,
        trustProfile: trust.trustProfile,
      },
    );
    mark("workspace ready");
    writeRemoteState({
      sandboxId: box.id,
      provider: this.id,
      sessionId: spec.sessionId,
      cwd,
      repoId: repo.id,
      branch,
      createdAt: prevState?.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      ...trust,
    });
    return this.makeHandle(cfg, box.id, spec.sessionId, cwd);
  }

  private makeHandle(
    cfg: BoxClientConfig,
    boxId: string,
    sessionId: string,
    cwd: string,
  ): Sandbox {
    const providerId = this.id;
    const driver = boxDriver(cfg, boxId);
    return makeRemoteSandbox({
      providerId,
      sandboxId: boxId,
      sessionId,
      cwd,
      driver,
      async ports(requestedPorts = []): Promise<PortMap> {
        const map: PortMap = {};
        const ports = new Set([
          ...(sandboxConfig().previewPorts || []),
          ...requestedPorts.filter(
            (port) => Number.isInteger(port) && port > 0 && port <= 65_535,
          ),
        ]);
        for (const port of ports) {
          try {
            // The in-box `host` CLI registers (idempotently) a public HTTPS
            // route for the port and prints its URL — `_token`-protected by
            // default, which suits us: these land in the session UI, not on
            // the open internet.
            const r = await driver.exec(`host ${port} --private`, {
              timeoutMs: 45_000,
            });
            const m = `${r.stdout} ${r.stderr}`.match(
              /https:\/\/[^\s"']+\.on\.ascii\.dev[^\s"']*/,
            );
            if (m) map[port] = { url: m[0] };
            else {
              console.warn(
                `[sandbox:box] host ${port} printed no URL:`,
                (r.stderr || r.stdout).trim().slice(0, 200),
              );
            }
          } catch (e) {
            console.warn(`[sandbox:box] host ${port} failed:`, e);
          }
        }
        return map;
      },
      async status(): Promise<SandboxStatus> {
        try {
          return stateOf(await getBox(cfg, boxId));
        } catch {
          return "gone";
        }
      },
      touchActivity: () => {
        touchRemoteState(providerId, boxId);
        // Reset the archival countdown (their TTL is a hard deadline, not an
        // idle timer) — same keepalive shape as E2B's setTimeout extension.
        void boxApi(cfg, "PATCH", `/boxes/${boxId}`, {
          ttlSeconds: idleTtlSeconds(),
        }).catch((e) =>
          console.warn(`[sandbox:box] ttl refresh(${boxId}) failed:`, e),
        );
      },
    });
  }

  async get(sandboxId: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, sandboxId);
    if (!state) return null;
    try {
      const cfg = boxClientConfig();
      const box = await getBox(cfg, sandboxId);
      if (!box || stateOf(box) === "gone") return null;
      return this.makeHandle(cfg, sandboxId, state.sessionId, state.cwd);
    } catch (e) {
      console.warn(`[sandbox:box] get(${sandboxId}) failed:`, e);
      return null;
    }
  }

  async pause(sandboxId: string): Promise<void> {
    const cfg = boxClientConfig();
    const box = await getBox(cfg, sandboxId);
    if (!box || String(box.state || "") === "archived") return;
    await boxApi(
      cfg,
      "POST",
      `/boxes/${sandboxId}/stop`,
      { force: false },
      60_000,
    );
    await waitForState(cfg, sandboxId, new Set(["archived"]), 10 * 60_000);
  }

  async resume(sandboxId: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, sandboxId);
    if (!state) return null;
    const cfg = boxClientConfig();
    const box = await getBox(cfg, sandboxId);
    if (!box) return null;
    const resumed = !LIVE_STATES.has(String(box.state || ""));
    if (resumed) {
      if (String(box.state || "") === "archived") {
        await boxApi(cfg, "POST", `/boxes/${sandboxId}/resume`, {
          noEnv: true,
          ttlSeconds: idleTtlSeconds(),
        });
      }
      await waitForLive(cfg, sandboxId, 300_000);
    }
    const driver = boxDriver(cfg, sandboxId);
    await driver.ensureStarted();
    if (resumed) primeBoxWorkspaceAfterResume(driver, state.cwd);
    return this.makeHandle(cfg, sandboxId, state.sessionId, state.cwd);
  }

  /** Box's public API exposes durable archival rather than hard deletion.
   * Stop releases compute/billing and removing local state makes the resource
   * unreachable from Open Session; the user's Box dashboard retains it. */
  async destroy(sandboxId: string): Promise<void> {
    try {
      const cfg = boxClientConfig();
      const box = await getBox(cfg, sandboxId);
      if (box) await archiveAndForgetBox(cfg, sandboxId);
    } catch (e) {
      if (!isNotFound(e)) {
        console.warn(`[sandbox:box] destroy(${sandboxId}):`, e);
        // Never forget a Box that may still be running and billable.
        throw e;
      }
    }
    removeRemoteState(this.id, sandboxId);
  }
}

// ── Project templates + warm-on-typing ──────────────────────────────────────

interface NamedSnapshot {
  name: string;
  status: "saving" | "ready" | "failed";
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function boxSnapshotSaveIsRecoverable(
  snapshot: Pick<NamedSnapshot, "status" | "createdAt" | "updatedAt">,
  now = Date.now(),
): boolean {
  const startedAt = Date.parse(snapshot.updatedAt || snapshot.createdAt || "");
  const age = now - startedAt;
  return (
    snapshot.status === "saving" &&
    Number.isFinite(startedAt) &&
    age >= 0 &&
    age < 20 * 60_000
  );
}

function boxSnapshotName(repoId: string): string {
  return remoteRepoTemplateName("box", repoId).slice(0, 63).replace(/-+$/, "");
}

async function getNamedSnapshot(
  cfg: BoxClientConfig,
  name: string,
): Promise<NamedSnapshot | null> {
  try {
    const response = await boxApi<{ snapshot: NamedSnapshot }>(
      cfg,
      "GET",
      `/named-snapshots/${encodeURIComponent(name)}`,
    );
    return response.snapshot;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function waitForNamedSnapshot(
  cfg: BoxClientConfig,
  name: string,
  timeoutMs = TEMPLATE_WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await getNamedSnapshot(cfg, name);
    if (snapshot?.status === "ready") return;
    if (snapshot?.status === "failed") {
      throw new Error(
        `Box named snapshot ${name} failed: ${snapshot.error || "unknown error"}`,
      );
    }
    await sleep(3_000);
  }
  throw new Error(
    `Box named snapshot ${name} was not ready after ${timeoutMs}ms`,
  );
}

async function recoverBoxRepoTemplate(cfg: BoxClientConfig, repoId: string) {
  const stored = readRemoteRepoTemplate("box", repoId);
  if (stored) return stored;
  const name = boxSnapshotName(repoId);
  let snapshot = await getNamedSnapshot(cfg, name);
  if (snapshot && boxSnapshotSaveIsRecoverable(snapshot)) {
    await waitForNamedSnapshot(cfg, name);
    snapshot = await getNamedSnapshot(cfg, name);
  }
  if (snapshot?.status !== "ready") return null;
  writeRemoteRepoTemplate("box", repoId, name);
  console.log(`[sandbox:box] recovered completed repo template ${name}`);
  return readRemoteRepoTemplate("box", repoId);
}

async function deleteNamedSnapshot(
  cfg: BoxClientConfig,
  name: string,
): Promise<void> {
  try {
    await boxApi(cfg, "DELETE", `/named-snapshots/${encodeURIComponent(name)}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function waitForNamedSnapshotGone(
  cfg: BoxClientConfig,
  name: string,
  timeoutMs = 2 * 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await getNamedSnapshot(cfg, name))) return;
    await sleep(2_000);
  }
  throw new Error(
    `Box named snapshot ${name} was not deleted after ${timeoutMs}ms`,
  );
}

async function stopBox(cfg: BoxClientConfig, boxId: string): Promise<void> {
  const box = await getBox(cfg, boxId);
  if (!box || String(box.state || "") === "archived") return;
  await boxApi(cfg, "POST", `/boxes/${boxId}/stop`, { force: false }, 60_000);
  await waitForState(cfg, boxId, new Set(["archived"]), 10 * 60_000);
}

async function archiveAndForgetBox(
  cfg: BoxClientConfig,
  boxId: string,
): Promise<void> {
  await stopBox(cfg, boxId);
  // Keep the non-billing archived resource visible in Box, but remove session
  // and prewarm identity so it cannot be rediscovered or reaped repeatedly.
  try {
    await boxApi(cfg, "PATCH", `/boxes/${boxId}`, {
      name: `opensession-archived-${boxId}`,
    });
  } catch (error) {
    if (!isNotFound(error)) {
      console.warn(
        `[sandbox:box] archived ${boxId} but could not clear its name:`,
        error,
      );
    }
  }
}

export const boxPrewarmAdapter: PrewarmAdapter = {
  async create(labels, opts) {
    const cfg = boxClientConfig();
    const key = labels[PREWARM_KEY_LABEL] || "";
    const repoId = key.startsWith("box:") ? key.slice("box:".length) : "";
    if (!repoId)
      throw new Error(`invalid Box prewarm key: ${key || "(missing)"}`);
    const template = await recoverBoxRepoTemplate(cfg, repoId);
    const type = boxMachineType(opts.resources);
    const create = (from?: string) =>
      boxApi<{ box: BoxRecord }>(
        cfg,
        "POST",
        "/boxes",
        {
          type,
          noEnv: true,
          ttlSeconds: Math.min(30 * 24 * 60 * 60, opts.autoStopMinutes * 60),
          ...(from ? { from } : {}),
        },
        60_000,
      );
    let response: { box: BoxRecord };
    let restoredFromTemplate = Boolean(template);
    try {
      response = await create(template?.artifactId);
    } catch (error) {
      if (!template || !isNotFound(error)) throw error;
      invalidateRemoteRepoTemplate("box", repoId);
      restoredFromTemplate = false;
      response = await create();
    }
    // Encode rather than sanitize the key: the orphan sweep needs to recover
    // `box:<repo>` exactly so two Open Session instances sharing an account
    // never archive one another's prewarms.
    const name =
      `opensession-prewarm-${Buffer.from(key).toString("base64url")}`.slice(
        0,
        120,
      );
    await boxApi(cfg, "PATCH", `/boxes/${response.box.id}`, { name });
    await waitForLive(cfg, response.box.id, 300_000);
    const driver = boxDriver(cfg, response.box.id);
    await driver.ensureStarted();
    return {
      sandboxId: response.box.id,
      driver,
      restoredFromTemplate,
    };
  },

  async publishTemplate(sandboxId, repo) {
    const cfg = boxClientConfig();
    const name = boxSnapshotName(repo.id);
    const driver = boxDriver(cfg, sandboxId);
    await sealRemoteRepoTemplate(driver, "box", repo);
    const existing = await getNamedSnapshot(cfg, name);
    if (existing && boxSnapshotSaveIsRecoverable(existing)) {
      // Snapshot publication survives a coordinator restart. Its deterministic
      // name includes the runner signature, so finishing this recent in-flight
      // save is the exact artifact the restarted prewarm needs. A provider save
      // stuck longer than 20 minutes is deleted and rebuilt below instead of
      // blocking every rebuild on the same dead operation forever.
      await waitForNamedSnapshot(cfg, name);
      writeRemoteRepoTemplate("box", repo.id, name);
      console.log(
        `[sandbox:box] recovered in-flight post-setup repo template ${name}`,
      );
      return;
    }
    // Box already captures a final filesystem snapshot while stopping. Saving
    // a named template from that archived state reuses the completed capture;
    // saving from a running multi-gigabyte tella-fusion Box stayed in `saving`
    // for hours and was repeatedly interrupted by coordinator restarts.
    await stopBox(cfg, sandboxId);
    if (existing) {
      await deleteNamedSnapshot(cfg, name);
      await waitForNamedSnapshotGone(cfg, name);
    }
    await boxApi(
      cfg,
      "POST",
      "/named-snapshots",
      { boxId: sandboxId, name },
      60_000,
    );
    await waitForNamedSnapshot(cfg, name);
    writeRemoteRepoTemplate("box", repo.id, name);
    console.log(`[sandbox:box] published post-setup repo template ${name}`);
  },

  async park(sandboxId) {
    await stopBox(boxClientConfig(), sandboxId);
  },

  async destroy(sandboxId) {
    try {
      await archiveAndForgetBox(boxClientConfig(), sandboxId);
    } catch (error) {
      console.warn(`[sandbox:box] prewarm archive(${sandboxId}):`, error);
      throw error;
    }
  },

  async keepAlive(sandboxId, opts) {
    await boxApi(boxClientConfig(), "PATCH", `/boxes/${sandboxId}`, {
      ttlSeconds: Math.min(30 * 24 * 60 * 60, opts.autoStopMinutes * 60),
    });
  },

  async listPrewarmed() {
    const cfg = boxClientConfig();
    const out: Array<{ id: string; key: string }> = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const query: string = `limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response: BoxListPage = await boxApi<BoxListPage>(
        cfg,
        "GET",
        `/boxes?${query}`,
      );
      for (const box of response.boxes || []) {
        const prefix = "opensession-prewarm-";
        if (box.name?.startsWith(prefix)) {
          try {
            out.push({
              id: box.id,
              key: Buffer.from(
                box.name.slice(prefix.length),
                "base64url",
              ).toString("utf-8"),
            });
          } catch {
            out.push({ id: box.id, key: "" });
          }
        }
      }
      if (!response.pageInfo?.hasMore || !response.pageInfo.nextCursor) break;
      cursor = response.pageInfo.nextCursor;
    }
    return out;
  },
};

async function assertBoxRuntimeHome(driver: RemoteDriver): Promise<void> {
  const probe = await driver.exec(
    "test ! -L /home/ubuntu && mountpoint -q /home/ubuntu && test /home/ubuntu -ef /home/user && " +
      "temporary=$(mktemp -d) && case $temporary in /home/ubuntu/.tmp/*) rmdir $temporary ;; *) exit 1 ;; esac",
  );
  if (probe.exitCode !== 0) {
    throw new Error(
      "Box did not preserve /home/ubuntu as the durable canonical home",
    );
  }
}

/** Workspace qualification: credentials/quota, exec semantics, file upload,
 * private preview registration, stop/resume persistence, and a distinct
 * named-snapshot restore. Every disposable box is archived in finally. */
export async function qualifyBoxConnection(
  progress: (stage: string, value: number) => void = () => undefined,
): Promise<void> {
  const cfg = boxClientConfig();
  progress("Checking Box account", 25);
  await boxApi(cfg, "GET", "/me");
  const limits = await boxApi<{
    canStart?: boolean;
    blockedReason?: string | null;
  }>(cfg, "GET", "/limits");
  if (limits.canStart === false) {
    throw Object.assign(
      new Error(limits.blockedReason || "Box account cannot start a sandbox"),
      {
        code: "PROVIDER_QUOTA",
      },
    );
  }

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const snapshotName = `opensession-qualification-${suffix}`;
  const boxIds: string[] = [];
  try {
    progress("Creating qualification Box", 35);
    const created = await boxApi<{ box: BoxRecord }>(
      cfg,
      "POST",
      "/boxes",
      {
        type: "small",
        ttlSeconds: 600,
        noEnv: true,
      },
      60_000,
    );
    boxIds.push(created.box.id);
    await boxApi(cfg, "PATCH", `/boxes/${created.box.id}`, {
      name: `opensession-qualification-${suffix}`,
    });
    await waitForLive(cfg, created.box.id, 300_000);
    let driver = boxDriver(cfg, created.box.id);
    await driver.ensureStarted();
    await assertBoxRuntimeHome(driver);
    progress("Checking commands and private ingress", 45);
    await assertDialbackReachable(driver, "box-qualification");
    const semantics = await driver.exec(
      "printf qualification-out; printf qualification-err >&2; exit 7",
      { timeoutMs: 60_000 },
    );
    if (
      semantics.exitCode !== 7 ||
      !semantics.stdout.includes("qualification-out") ||
      !semantics.stderr.includes("qualification-err")
    )
      throw new Error(
        "Box exec stream or exit-code semantics are incompatible",
      );
    await driver.writeFile(
      "/home/ubuntu/.opensession-qualification",
      "opensession-qualified",
    );
    const preview = await driver.exec("host 8765 --private", {
      timeoutMs: 60_000,
    });
    if (
      !/https:\/\/[^\s"']+\.on\.ascii\.dev[^\s"']*/.test(
        `${preview.stdout} ${preview.stderr}`,
      )
    ) {
      throw new Error("Box private preview URL check failed");
    }

    progress("Checking archive and resume", 60);
    await stopBox(cfg, created.box.id);
    await boxApi(cfg, "POST", `/boxes/${created.box.id}/resume`, {
      type: "small",
      noEnv: true,
      ttlSeconds: 600,
    });
    await waitForLive(cfg, created.box.id, 300_000);
    driver = boxDriver(cfg, created.box.id);
    await driver.ensureStarted();
    await assertBoxRuntimeHome(driver);
    const persisted = await driver.exec(
      'test "$(cat /home/ubuntu/.opensession-qualification)" = opensession-qualified',
    );
    if (persisted.exitCode !== 0)
      throw new Error("Box stop/resume lost filesystem state");

    progress("Creating qualification snapshot", 72);
    await boxApi(
      cfg,
      "POST",
      "/named-snapshots",
      {
        boxId: created.box.id,
        name: snapshotName,
      },
      60_000,
    );
    await waitForNamedSnapshot(cfg, snapshotName);
    progress("Restoring qualification snapshot", 84);
    const restored = await boxApi<{ box: BoxRecord }>(
      cfg,
      "POST",
      "/boxes",
      {
        from: snapshotName,
        type: "small",
        noEnv: true,
        ttlSeconds: 600,
      },
      60_000,
    );
    boxIds.push(restored.box.id);
    if (restored.box.id === created.box.id) {
      throw new Error("Box named-snapshot restore was not distinct");
    }
    await boxApi(cfg, "PATCH", `/boxes/${restored.box.id}`, {
      name: `opensession-qualification-${suffix}-restore`,
    });
    await waitForLive(cfg, restored.box.id, 300_000);
    const restoredDriver = boxDriver(cfg, restored.box.id);
    await restoredDriver.ensureStarted();
    await assertBoxRuntimeHome(restoredDriver);
    const restoredProbe = await restoredDriver.exec(
      'test "$(cat /home/ubuntu/.opensession-qualification)" = opensession-qualified',
    );
    if (restoredProbe.exitCode !== 0) {
      throw new Error("Box named snapshot did not restore filesystem state");
    }
  } finally {
    progress("Cleaning up qualification resources", 94);
    const cleanupErrors: string[] = [];
    for (const boxId of boxIds.reverse()) {
      await archiveAndForgetBox(cfg, boxId).catch((error) => {
        cleanupErrors.push(
          `${boxId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    await deleteNamedSnapshot(cfg, snapshotName).catch((error) => {
      cleanupErrors.push(
        `${snapshotName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (cleanupErrors.length) {
      throw new Error(
        `Box qualification cleanup failed — ${cleanupErrors.join("; ")}`,
      );
    }
  }
}

export async function deleteBoxTemplateArtifact(
  artifactId: string,
): Promise<void> {
  await deleteNamedSnapshot(boxClientConfig(), artifactId);
}
