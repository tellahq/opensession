/**
 * BoxProvider — remote sandbox adapter over the Boat API
 * (https://docs.boat.dev/api/v1). Boat is the product formerly called Box at
 * ascii.dev; the provider id stays `box` so stored connections, session state
 * and repo templates keep working. Sandboxes are persistent Ubuntu VMs with
 * small/default/large machine profiles, Docker inside,
 * per-second billing, EU) with archive/resume snapshots — archival is
 * recoverable, so the idle contract is gentler than E2B's kill-on-countdown.
 *
 * No SDK dependency: the public API is plain JSON, and a small typed fetch
 * client keeps provider failures and request ids visible. Endpoints (base
 * https://boat.dev/api/v1, Bearer `boat_…` key; legacy `box_…` keys still
 * authenticate, and boxApiBaseUrl maps the retired ascii.dev base):
 *   POST /sandboxes {ttlSeconds,noEnv}    create (returns provisioning; poll GET)
 *   GET  /sandboxes, GET /sandboxes/{id}      list (cursor-paginated) / get
 *   PATCH /sandboxes/{id} {name,ttlSeconds}  rename + reset the auto-stop timer
 *   POST /sandboxes/{id}/commands         sync/detached shell exec (600s sync cap)
 *   GET  /sandboxes/{id}/commands/{pid}   detached process status + log tails
 *   PUT  /sandboxes/{id}/files            write file (base64)
 *   POST /sandboxes/{id}/stop|resume      persistent pause/resume
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
 *    (https://<subdomain>-<port>.on.boat.dev, `_token`-protected by default)
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
  SandboxDesktop,
  SandboxDesktopControl,
} from "../provider";
import { x11DesktopControl } from "../x11-desktop";
import {
  assertDialbackReachable,
  bootstrapRemoteSandbox,
  findRemoteStateBySession,
  makeRemoteSandbox,
  readRemoteState,
  runResumeHook,
  remoteCloneUrl,
  remoteWarmWorkspaceDir,
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

const DEFAULT_API_URL = "https://boat.dev/api/v1";

/** The Box API moved from https://ascii.dev/api/box/v1 to Boat's
 *  https://boat.dev/api/v1, where `/sandboxes` replaced `/boxes`. The retired
 *  base still answers, but only for the old paths, so a stored legacy base is
 *  mapped to the new one instead of 404ing every call. */
export function boxApiBaseUrl(configured?: string | null): string {
  const value = (configured || "").trim().replace(/\/+$/, "");
  if (!value) return DEFAULT_API_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.hostname === "ascii.dev") url.hostname = "boat.dev";
  if (url.hostname === "boat.dev" && url.pathname === "/api/box/v1") {
    url.pathname = "/api/v1";
  }
  return url.toString().replace(/\/+$/, "");
}

/** Public routes the in-sandbox `host` CLI prints. Machine images built
 *  before the rename still print the ascii.dev domain. */
export const BOX_PREVIEW_URL_PATTERN =
  /https:\/\/[^\s"']+\.on\.(?:boat|ascii)\.dev[^\s"']*/;
const DEFAULT_IDLE_STOP_MINUTES = 30;
const POLL_INTERVAL_MS = 2_500;
const COMMAND_TAIL_BYTES = 524_288;
const TEMPLATE_WAIT_MS = 15 * 60_000;

/** States where the VM is up and can take commands. `running` is their
 *  "agent busy" state — still a live VM. */
const LIVE_STATES = new Set(["ready", "idle", "running"]);

/** `POST /sandboxes/{id}/desktop` answers with a tokenized 60fps stream page.
 * The token rides in the URL fragment, so the URL itself is the secret. */
export function boxDesktopUrl(response: { desktopUrl?: unknown }): string {
  const url =
    typeof response.desktopUrl === "string" ? response.desktopUrl : "";
  if (!/^https:\/\//.test(url))
    throw new Error("Box did not return a desktop URL");
  return url;
}

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
  sandboxes: BoxRecord[];
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
    apiUrl: boxApiBaseUrl(settings.apiUrl),
  };
}

/** Delays before re-sending an idempotent read the Boat API answered with a
 *  gateway error, or that never reached it. A lookup on the wake path that
 *  failed on one 502 used to fail the Portal Sandbox's refresh outright. */
const BOX_READ_RETRY_DELAYS_MS = [500, 1_500];

export function boxReadRetryable(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status === undefined)
    return !/timed out after/.test(
      error instanceof Error ? error.message : String(error),
    );
  return status === 502 || status === 503 || status === 504;
}

async function boxApi<T>(
  cfg: BoxClientConfig,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<T> {
  if (method !== "GET") return boxApiOnce(cfg, method, path, body, timeoutMs);
  for (let attempt = 0; ; attempt++) {
    try {
      return await boxApiOnce<T>(cfg, method, path, body, timeoutMs);
    } catch (error) {
      const delay = BOX_READ_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !boxReadRetryable(error)) throw error;
      await sleep(delay);
    }
  }
}

async function boxApiOnce<T>(
  cfg: BoxClientConfig,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cfg.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // The bare "The operation timed out." of AbortSignal.timeout named
    // neither the call nor the budget when it reached the session record
    // and the journal; a create that stalled read like anything else.
    if ((error as { name?: unknown })?.name === "TimeoutError")
      throw new Error(
        `box API ${method} ${path} timed out after ${Math.round(timeoutMs / 1000)}s`,
      );
    throw error;
  }
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

/** 409 codes that mean the command plane has not accepted the request yet:
 *  `boat_starting` while provisioning, `boat_restoring` in the first seconds
 *  of a resume, plus the pre-rename `box_starting` spelling. */
const COMMAND_PLANE_UNAVAILABLE_CODES = new Set([
  "machine_not_running",
  "boat_starting",
  "boat_restoring",
  "box_starting",
]);

/** A 409 here means Boat has not accepted the command — retrying after a
 * resume is safe. It is distinct from a 502, where the command may have run. */
export function boxCommandPlaneUnavailable(error: unknown): boolean {
  const detail = error as { status?: number; code?: string };
  return (
    detail?.status === 409 &&
    COMMAND_PLANE_UNAVAILABLE_CODES.has(String(detail.code || ""))
  );
}

async function getBox(
  cfg: BoxClientConfig,
  boxId: string,
): Promise<BoxRecord | null> {
  try {
    const res = await boxApi<{ sandbox?: BoxRecord } & BoxRecord>(
      cfg,
      "GET",
      `/sandboxes/${boxId}`,
    );
    return res.sandbox || res;
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
      new Error("Choose one of Boat's Small, Default, or Large machine sizes"),
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
        await boxApi(cfg, "POST", `/sandboxes/${boxId}/resume`, {
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
  return `${BOX_HOME_GUARD} && mkdir -p /home/ubuntu/.tmp && export TMPDIR=/home/ubuntu/.tmp && ${s}`;
}

export function boxNativeFilePath(path: string): string {
  if (path === "/home/ubuntu") return "/home/user";
  if (path.startsWith("/home/ubuntu/")) {
    return `/home/user/${path.slice("/home/ubuntu/".length)}`;
  }
  return path;
}

/**
 * Box restores an archived home lazily: every file is fetched on first
 * read. Warm what a woken or adopted workspace touches first, in the
 * background: the bun and node binaries (the Portal relay and the app's
 * dev server start on them; bun alone is ~80 MB), git's pack indexes, and
 * every tracked file's metadata.
 */
export function boxResumePrimeCommand(cwd: string): string {
  return (
    `{ cat /home/ubuntu/.bun/bin/bun "$(command -v node)" >/dev/null 2>&1 & } ; ` +
    `if test -d ${shellQuoteWord(cwd)}/.git; then cd ${shellQuoteWord(cwd)} && ` +
    `{ cat "$(git rev-parse --git-common-dir)"/objects/pack/*.idx >/dev/null 2>&1; ` +
    `git ls-files -z | xargs -0 -r -n 64 -P 16 stat -c '%n' -- >/dev/null 2>&1; ` +
    `GIT_OPTIONAL_LOCKS=0 git status --porcelain >/dev/null 2>&1; }; fi; wait`
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

/** Printed by BOX_RUNTIME_HOME_COMMAND while Boat is still restoring the
 *  home lazily. During that restore /home/user is a FUSE layer that fetches
 *  files on first read, and content written through Box's native file API
 *  lands in the raw backing store, invisible to the workspace until the
 *  restore finishes. Every file write must then go through the shell path. */
export const BOX_RUNTIME_HOME_LAZY_MARKER = "__OPENSESSION_BOX_HOME_LAZY__";

/** Prints "hydrating" while Boat's lazy restore still serves /home/user
 *  through FUSE, "ready" once it is plain disk. */
export const BOX_HOME_HYDRATION_PROBE =
  'case "$(stat -f -c %T /home/user 2>/dev/null)" in fuse*) echo hydrating;; *) echo ready;; esac';

/**
 * Make /home/ubuntu, the path Open Session uses on every Linux guest, a
 * symlink to Boat's own home, /home/user.
 *
 * A restored Box serves /home/user through a FUSE layer (ascii-lazyfs) while
 * it copies the disk in, then retires that layer and leaves plain ext4. A
 * symlink resolves through /home/user on every lookup, so it follows that
 * handover. The bind mount used before captured the FUSE mount itself and
 * kept the workspace on it for the machine's whole life: listing 20k files
 * took 12.5 s instead of 0.03 s, and a dev server took minutes to start.
 *
 * Paths keep the /home/ubuntu spelling Open Session shares with the host;
 * resolved paths (pwd -P, realpath) read /home/user, consistently for the
 * image build and every session started from it. A bind mount left by an
 * older release is detached lazily: processes inside keep their view until
 * they exit. Serialized, since concurrent commands may all arrive here.
 */
export const BOX_RUNTIME_HOME_COMMAND =
  "test -d /home/user && test -w /home/user && " +
  "flock /tmp/.opensession-home.lock sh -c '" +
  'if [ "$(readlink /home/ubuntu)" != /home/user ]; then ' +
  "if [ -L /home/ubuntu ]; then sudo -n rm /home/ubuntu || exit 1; " +
  "else " +
  "while mountpoint -q /home/ubuntu; do sudo -n umount -l /home/ubuntu || exit 1; done; " +
  'if [ -d /home/ubuntu ] && [ -z "$(ls -A /home/ubuntu)" ]; then sudo -n rmdir /home/ubuntu || exit 1; ' +
  'elif [ -e /home/ubuntu ]; then echo "cannot replace non-empty /home/ubuntu" >&2; exit 1; fi; ' +
  "fi; " +
  "sudo -n ln -s /home/user /home/ubuntu; " +
  "fi' && " +
  '[ "$(readlink /home/ubuntu)" = /home/user ] && test -w /home/ubuntu/ && ' +
  `{ case "$(stat -f -c %T /home/user 2>/dev/null)" in fuse*) echo ${BOX_RUNTIME_HOME_LAZY_MARKER};; esac; true; }`;

/** Prefix of every composed Box command. When Box restarts a VM on its own
 *  (an archive and resume, host maintenance), the VM root is rebuilt and
 *  /home/ubuntu is gone while this process still holds a driver that set it
 *  up once; every command with a workspace cwd would then fail with "No
 *  such file or directory". Re-establish it in the same command: one
 *  readlink when it is in place. */
export const BOX_HOME_GUARD = `{ [ "$(readlink /home/ubuntu)" = /home/user ] || { ${BOX_RUNTIME_HOME_COMMAND}; } >/dev/null; }`;

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
  // False once the home command reports a lazily restored /home/ubuntu: the
  // native file API writes the backing store, which that mount does not show.
  let nativeFilesCoherent = true;
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
      `/sandboxes/${boxId}/commands`,
      { command: shell, detached: true },
      60_000,
    );

  const ensureRuntimeHome = async () => {
    // Box persists /home/user across archive/resume and named snapshots, while
    // the VM root is rebuilt. Link the cross-provider path to it on every boot
    // (see BOX_RUNTIME_HOME_COMMAND for why a link and not a bind mount).
    const response = result(
      await boxApi<BoxCommandResponse>(
        cfg,
        "POST",
        `/sandboxes/${boxId}/commands`,
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
    if (response.stdout.includes(BOX_RUNTIME_HOME_LAZY_MARKER))
      nativeFilesCoherent = false;
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
          `/sandboxes/${boxId}/commands`,
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
              `/sandboxes/${boxId}/resume`,
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
      `/sandboxes/${boxId}/commands`,
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
            `/sandboxes/${boxId}/commands/${started.processId}?tailBytes=${COMMAND_TAIL_BYTES}`,
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
      if (!runtimeHomeReady) {
        if (!commandPlaneReady) await waitForCommandPlane();
        await ensureRuntimeHome();
      }
      if (!nativeFilesCoherent) {
        // A lazily restored home only shows writes made through /home/ubuntu.
        const shell = `mkdir -p ${shellQuoteWord(dirname(path))} && printf %s ${shellQuoteWord(
          Buffer.from(content, "utf8").toString("base64"),
        )} | base64 -d > ${shellQuoteWord(path)}`;
        const written = result(
          await afterCommandPlaneReady(() => execOnce(shell, 60_000)),
        );
        if (written.exitCode !== 0)
          throw new Error(
            `Box writeFile(${path}) failed: ${written.stderr.trim().slice(0, 300)}`,
          );
        return;
      }
      // Box canonicalizes file paths and permits only /home/user or /tmp.
      // /home/ubuntu is our link to that persistent home, so translate
      // the prefix explicitly and use the native file API instead of serializing
      // every launch-time credential write through a shell command.
      const nativePath = boxNativeFilePath(path);
      await afterCommandPlaneReady(() =>
        boxApi(
          cfg,
          "PUT",
          `/sandboxes/${boxId}/files`,
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
      // Its per-command HTTP proxy can report boat_direct_failed while the VM
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
          if (home.stdout.includes(BOX_RUNTIME_HOME_LAZY_MARKER))
            nativeFilesCoherent = false;
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
    `/sandboxes/${box.id}/sshkey`,
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
    // Boat installs no outbound policy, and its images may carry a prebuilt
    // Portal cache with the app's dev secrets (portal-prebuild.ts).
    if (trust.trustProfile === "automation")
      throw new Error(
        "Boat sandboxes are for interactive sessions; automations stay on Daytona",
      );
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
            await boxApi(cfg, "PATCH", `/sandboxes/${candidate.id}`, {
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
      // noEnv: never inject the Boat account's dashboard secrets — every
      // credential a run needs is uploaded scoped per launch (bootstrap.ts).
      const create = (from?: string) =>
        boxApi<{ sandbox: BoxRecord }>(
          cfg,
          "POST",
          `/sandboxes`,
          {
            type: machineType,
            ttlSeconds: idleTtlSeconds(),
            noEnv: true,
            ...(from ? { from } : {}),
          },
          60_000,
        );
      let created: { sandbox: BoxRecord };
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
      box = created.sandbox;
      mark("box created");
      // The session name is the provider-side recovery index. The durable
      // local id written below is the hot path; the name remains useful for
      // operator recovery when local state is lost. A
      // rename failure is non-fatal — the local state file still maps it.
      try {
        await boxApi(cfg, "PATCH", `/sandboxes/${box.id}`, {
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
        await boxApi(cfg, "PATCH", `/sandboxes/${box.id}`, {
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
    // A parked standby (a prewarm or a kept-ready Box) comes back with the
    // same lazily restored disk; its warm clone is what the workspace step
    // and the app are about to read.
    const adoptingParked = lifecycleRefreshed && stateOf(box) !== "running";
    await driver.ensureStarted();
    mark("box started");
    if (resumingExistingWorkspace) primeBoxWorkspaceAfterResume(driver, cwd);
    else if (adoptingParked)
      primeBoxWorkspaceAfterResume(driver, remoteWarmWorkspaceDir(repo.id));
    // Cheap dial-back probe BEFORE the expensive bootstrap — same rationale
    // as daytona: a box that can't reach our callback URL can never run.
    await assertDialbackReachable(driver, "box");
    mark("dial-back verified");
    await bootstrapRemoteSandbox(driver, "box");
    mark("runtime ready");
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
      spec.restoreCheckpoint
        ? { restoreCheckpoint: spec.restoreCheckpoint }
        : {},
    );
    mark("workspace ready");
    if (resumingExistingWorkspace) {
      await runResumeHook(driver, this.id, box.id, {
        cwd,
        sessionId: spec.sessionId,
        repoId: repo.id,
        trustProfile: trust.trustProfile,
      });
      mark("resume hook ran");
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
    return Object.assign(this.makeHandle(cfg, box.id, spec.sessionId, cwd), {
      wokeFromSleep: resumingExistingWorkspace,
    });
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
            const m = `${r.stdout} ${r.stderr}`.match(BOX_PREVIEW_URL_PATTERN);
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
        void boxApi(cfg, "PATCH", `/sandboxes/${boxId}`, {
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

  async desktop(sandboxId: string): Promise<SandboxDesktop> {
    const cfg = boxClientConfig();
    const box = await getBox(cfg, sandboxId);
    if (!box || !LIVE_STATES.has(String(box.state || "")))
      throw new Error("Wake the sandbox first");
    const response = await boxApi<{ desktopUrl?: unknown }>(
      cfg,
      "POST",
      `/sandboxes/${sandboxId}/desktop`,
      undefined,
      60_000,
    );
    return { url: boxDesktopUrl(response) };
  }

  /** Box has no control API, but every box runs a real X display on `:0`
   *  with xdotool and ImageMagick installed, so the agent drives it over exec. */
  async desktopControl(sandboxId: string): Promise<SandboxDesktopControl> {
    const box = await getBox(boxClientConfig(), sandboxId);
    if (!box || !LIVE_STATES.has(String(box.state || "")))
      throw new Error("Wake the sandbox first");
    const sandbox = await this.get(sandboxId);
    if (!sandbox) throw new Error("Wake the sandbox first");
    return x11DesktopControl((cmd, opts) => sandbox.exec(cmd, opts));
  }

  async pause(sandboxId: string): Promise<void> {
    const cfg = boxClientConfig();
    const box = await getBox(cfg, sandboxId);
    if (!box || String(box.state || "") === "archived") return;
    await boxApi(
      cfg,
      "POST",
      `/sandboxes/${sandboxId}/stop`,
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
        await boxApi(cfg, "POST", `/sandboxes/${sandboxId}/resume`, {
          noEnv: true,
          ttlSeconds: idleTtlSeconds(),
        });
      }
      await waitForLive(cfg, sandboxId, 300_000);
    }
    const driver = boxDriver(cfg, sandboxId);
    await driver.ensureStarted();
    if (resumed) {
      primeBoxWorkspaceAfterResume(driver, state.cwd);
      await runResumeHook(driver, this.id, sandboxId, state);
    }
    return Object.assign(
      this.makeHandle(cfg, sandboxId, state.sessionId, state.cwd),
      { wokeFromSleep: resumed },
    );
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
  await recordBoxRepoTemplate(cfg, repoId, name);
  console.log(`[sandbox:box] recovered completed repo template ${name}`);
  return readRemoteRepoTemplate("box", repoId);
}

/** Point the local mapping at `name` and drop the snapshot it replaced. Box
 * caps named snapshots per account (10 at the time of writing), so every
 * superseded template must go, best-effort, or publication starts failing
 * with `named_snapshot_limit` after a handful of toolchain changes. */
async function recordBoxRepoTemplate(
  cfg: BoxClientConfig,
  repoId: string,
  name: string,
): Promise<void> {
  const { previous } = writeRemoteRepoTemplate("box", repoId, name);
  if (!previous?.artifactId || previous.artifactId === name) return;
  try {
    await deleteNamedSnapshot(cfg, previous.artifactId);
    console.log(
      `[sandbox:box] deleted superseded repo template ${previous.artifactId}`,
    );
  } catch (error) {
    console.warn(
      `[sandbox:box] could not delete superseded repo template ${previous.artifactId}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
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

async function stopBox(
  cfg: BoxClientConfig,
  boxId: string,
  timeoutMs = 10 * 60_000,
): Promise<void> {
  const box = await getBox(cfg, boxId);
  if (!box || String(box.state || "") === "archived") return;
  await boxApi(
    cfg,
    "POST",
    `/sandboxes/${boxId}/stop`,
    { force: false },
    60_000,
  );
  await waitForState(cfg, boxId, new Set(["archived"]), timeoutMs);
}

/** Archiving a prepared tella-fusion workspace (~14 GB) has taken Box longer
 * than the 10-minute stop wait; the template publish is the one caller that
 * must outlast it. */
const TEMPLATE_ARCHIVE_WAIT_MS = 30 * 60_000;

async function archiveAndForgetBox(
  cfg: BoxClientConfig,
  boxId: string,
): Promise<void> {
  await stopBox(cfg, boxId);
  // Keep the non-billing archived resource visible in Box, but remove session
  // and prewarm identity so it cannot be rediscovered or reaped repeatedly.
  try {
    await boxApi(cfg, "PATCH", `/sandboxes/${boxId}`, {
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
      boxApi<{ sandbox: BoxRecord }>(
        cfg,
        "POST",
        "/sandboxes",
        {
          type,
          noEnv: true,
          ttlSeconds: Math.min(30 * 24 * 60 * 60, opts.autoStopMinutes * 60),
          ...(from ? { from } : {}),
        },
        60_000,
      );
    let response: { sandbox: BoxRecord };
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
    await boxApi(cfg, "PATCH", `/sandboxes/${response.sandbox.id}`, { name });
    await waitForLive(cfg, response.sandbox.id, 300_000);
    const driver = boxDriver(cfg, response.sandbox.id);
    await driver.ensureStarted();
    return {
      sandboxId: response.sandbox.id,
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
      await recordBoxRepoTemplate(cfg, repo.id, name);
      console.log(
        `[sandbox:box] recovered in-flight post-setup repo template ${name}`,
      );
      return;
    }
    // Box already captures a final filesystem snapshot while stopping. Saving
    // a named template from that archived state reuses the completed capture;
    // saving from a running multi-gigabyte tella-fusion Box stayed in `saving`
    // for hours and was repeatedly interrupted by coordinator restarts.
    await stopBox(cfg, sandboxId, TEMPLATE_ARCHIVE_WAIT_MS);
    if (existing) {
      await deleteNamedSnapshot(cfg, name);
      await waitForNamedSnapshotGone(cfg, name);
    }
    await boxApi(cfg, "POST", "/named-snapshots", { sandboxId, name }, 60_000);
    await waitForNamedSnapshot(cfg, name);
    await recordBoxRepoTemplate(cfg, repo.id, name);
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
    await boxApi(boxClientConfig(), "PATCH", `/sandboxes/${sandboxId}`, {
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
        `/sandboxes?${query}`,
      );
      for (const box of response.sandboxes || []) {
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
    '[ "$(readlink /home/ubuntu)" = /home/user ] && test -w /home/ubuntu/ && ' +
      "echo probe > /home/ubuntu/.opensession-home-probe && test -e /home/user/.opensession-home-probe && rm -f /home/ubuntu/.opensession-home-probe && " +
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
  progress("Checking Boat account", 25);
  await boxApi(cfg, "GET", "/me");
  const limits = await boxApi<{
    canStart?: boolean;
    blockedReason?: string | null;
  }>(cfg, "GET", "/limits");
  if (limits.canStart === false) {
    throw Object.assign(
      new Error(limits.blockedReason || "Boat account cannot start a sandbox"),
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
    const created = await boxApi<{ sandbox: BoxRecord }>(
      cfg,
      "POST",
      "/sandboxes",
      {
        type: "small",
        ttlSeconds: 600,
        noEnv: true,
      },
      60_000,
    );
    boxIds.push(created.sandbox.id);
    await boxApi(cfg, "PATCH", `/sandboxes/${created.sandbox.id}`, {
      name: `opensession-qualification-${suffix}`,
    });
    await waitForLive(cfg, created.sandbox.id, 300_000);
    let driver = boxDriver(cfg, created.sandbox.id);
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
    if (!BOX_PREVIEW_URL_PATTERN.test(`${preview.stdout} ${preview.stderr}`)) {
      throw new Error("Box private preview URL check failed");
    }

    progress("Checking archive and resume", 60);
    await stopBox(cfg, created.sandbox.id);
    await boxApi(cfg, "POST", `/sandboxes/${created.sandbox.id}/resume`, {
      type: "small",
      noEnv: true,
      ttlSeconds: 600,
    });
    await waitForLive(cfg, created.sandbox.id, 300_000);
    driver = boxDriver(cfg, created.sandbox.id);
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
        sandboxId: created.sandbox.id,
        name: snapshotName,
      },
      60_000,
    );
    await waitForNamedSnapshot(cfg, snapshotName);
    progress("Restoring qualification snapshot", 84);
    const restored = await boxApi<{ sandbox: BoxRecord }>(
      cfg,
      "POST",
      "/sandboxes",
      {
        from: snapshotName,
        type: "small",
        noEnv: true,
        ttlSeconds: 600,
      },
      60_000,
    );
    boxIds.push(restored.sandbox.id);
    if (restored.sandbox.id === created.sandbox.id) {
      throw new Error("Box named-snapshot restore was not distinct");
    }
    await boxApi(cfg, "PATCH", `/sandboxes/${restored.sandbox.id}`, {
      name: `opensession-qualification-${suffix}-restore`,
    });
    await waitForLive(cfg, restored.sandbox.id, 300_000);
    const restoredDriver = boxDriver(cfg, restored.sandbox.id);
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
