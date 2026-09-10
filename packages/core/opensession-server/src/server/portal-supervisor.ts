/**
 * Session-local Portal service supervisor.
 *
 * `.ports.conf` remains the interoperable registry read by lifecycle scripts.
 * Open Session owns the `# opensession-portal` records inside that file so an
 * agent can inspect services without becoming their process manager.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { audit } from "./audit";
import { ensureAgentAwsCredsFile } from "./aws-creds";
import { configuredPaths, configuredServer } from "./config";
import {
  ensureSandboxPortalRelay,
  mintSandboxPortalGrant,
  revokeSandboxPortalRelay,
  sandboxPortalRelayConnected,
  waitForSandboxPortalRelay,
} from "./sandbox-portal-relay";
import {
  remoteSandboxCallbackBaseUrl,
  usesOutboundSandboxPortalRelay,
} from "./sandbox/config";
import { shellQuoteWord } from "./sandbox/adapters/bootstrap";
import { sandboxHttpsPortFor } from "./sandbox/preview-ports";
import { cacheSandboxPortalRecords } from "./sandbox-portals";
import { REPO_ROOT } from "../runner-host/protocol";
import {
  previewScopeCommand,
  stopUserScopeAndWait,
  systemdUserScopesAvailable,
  userScopeActive,
} from "./systemd-scopes";
import {
  sandboxSessionScratchDir,
  sessionScratchRoot,
} from "./session-scratch";
import type { Sandbox } from "./sandbox/provider";
import type { UnifiedSession } from "./types";

export type PortalState =
  | "starting"
  | "awake"
  | "sleeping"
  | "waking"
  | "failed"
  | "stopped";
export type PortalRecord = {
  name: string;
  key: string;
  command: string;
  port: number;
  /** The session that owns this process. Persisted so a restarted server can reap it. */
  sessionId?: string;
  description?: string;
  defaultPath?: string;
  state: PortalState;
  pid?: number;
  /** Detached user scope for a host Portal's complete process tree. */
  scopeUnit?: string;
  startedAt?: string;
  /** Persisted only when the idle reaper sleeps the Portal. Hot-path request
   * touches stay in memory so every proxied asset does not rewrite .ports.conf. */
  lastAccessedAt?: string;
  sleptAt?: string;
  readyTimeoutMs?: number;
  lastError?: string;
};

/** The longest a Portal may take to listen. A cold Sandbox resume can spend
 * minutes pulling a lazy volume before a dev server binds, and the waiting
 * page keeps the person informed meanwhile. The same bound decides when a
 * "starting" record is stuck. */
export const MAX_PORTAL_READY_MS = 600_000;

const PREFIX = "# opensession-portal ";
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const MIN_PORT = 1024;
const MAX_PORT = 19_000;
export const SANDBOX_PORTAL_PATH =
  "/home/ubuntu/.bun/bin:/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const remoteRelayAgents: Map<string, { expiresAt: number }> = ((
  globalThis as Record<string, unknown>
).__opensessionSandboxPortalAgents ??= new Map()) as Map<
  string,
  { expiresAt: number }
>;
const remoteRelayAgentStarts: Map<string, Promise<string | null>> = ((
  globalThis as Record<string, unknown>
).__opensessionSandboxPortalAgentStarts ??= new Map()) as Map<
  string,
  Promise<string | null>
>;
const PORTAL_REAP_INTERVAL_MS = 5 * 60_000;
const DEFAULT_PORTAL_IDLE_MS = 30 * 60_000;
const DEFAULT_MAX_HOST_PORTALS = 4;
const DEFAULT_MIN_AVAILABLE_MEMORY_MB = 24 * 1024;

type HostPortalRef = {
  sessionId: string;
  worktreeDir: string;
  name: string;
  port: number;
};

const portalGlobal = globalThis as unknown as {
  __opensessionHostPortalRefs?: Map<number, HostPortalRef>;
  __opensessionHostPortalAccess?: Map<string, number>;
  __opensessionHostPortalWakes?: Map<
    string,
    Promise<PortalRecord & { url: string }>
  >;
  __opensessionHostPortalReservations?: Set<string>;
};
const hostPortalRefs = (portalGlobal.__opensessionHostPortalRefs ??= new Map());
const hostPortalAccess = (portalGlobal.__opensessionHostPortalAccess ??=
  new Map());
const hostPortalWakes = (portalGlobal.__opensessionHostPortalWakes ??=
  new Map());
const hostPortalReservations =
  (portalGlobal.__opensessionHostPortalReservations ??= new Set());
export const SANDBOX_PORTAL_AGENT_ENTRY = `${REPO_ROOT}/packages/core/opensession-server/src/runner-host/sandbox-portal-agent.ts`;

function portalKey(name: string): string {
  return `PORTAL_${name.toUpperCase().replace(/-/g, "_")}_PORT`;
}

function validateName(name: string): string {
  const value = name.trim().toLowerCase();
  if (!NAME.test(value))
    throw new Error(
      "Portal names use lowercase letters, numbers, and hyphens.",
    );
  return value;
}

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT)
    throw new Error(`Portal port must be between ${MIN_PORT} and ${MAX_PORT}.`);
  return port;
}

function validateKey(key?: string): string | undefined {
  if (key == null) return undefined;
  if (!/^[A-Z][A-Z0-9_]*_PORT$/.test(key))
    throw new Error("Portal service keys must be uppercase *_PORT names.");
  return key;
}

function registryPath(worktreeDir: string): string {
  return join(worktreeDir, ".ports.conf");
}

/**
 * Provider command transports must return byte-clean stdout, but keep the
 * registry safe if one accidentally wraps output in terminal title/prompt
 * sequences. Persisting those bytes turns `.ports.conf` into executable junk
 * when a repository sources it during startup.
 */
function sanitizePortalRegistryText(contents: string): string {
  return contents
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function parsePortalRegistry(contents: string): PortalRecord[] {
  const records: PortalRecord[] = [];
  for (const line of sanitizePortalRegistryText(contents).split("\n")) {
    if (!line.startsWith(PREFIX)) continue;
    try {
      const value = JSON.parse(line.slice(PREFIX.length)) as PortalRecord;
      if (
        !value ||
        typeof value !== "object" ||
        !NAME.test(value.name) ||
        !Number.isInteger(value.port) ||
        typeof value.command !== "string"
      )
        continue;
      records.push({
        ...value,
        key: validateKey(value.key) ?? portalKey(value.name),
        port: validatePort(value.port),
      });
    } catch {}
  }
  return records;
}

export function readPortalRegistry(worktreeDir: string): PortalRecord[] {
  const path = registryPath(worktreeDir);
  return existsSync(path)
    ? parsePortalRegistry(readFileSync(path, "utf8"))
    : [];
}

function serializedPortalRegistry(
  previousText: string,
  records: PortalRecord[],
): string {
  const previous = sanitizePortalRegistryText(previousText).split("\n");
  const generatedKeys = new Set(records.map((record) => record.key));
  const kept = previous.filter((line) => {
    if (line.startsWith(PREFIX)) return false;
    const key = line.match(/^\s*([A-Z0-9_]+_PORT)\s*=/)?.[1];
    return !key || !generatedKeys.has(key);
  });
  while (kept.at(-1) === "") kept.pop();
  const generated = records.flatMap((record) => [
    `${PREFIX}${JSON.stringify(record)}`,
    `${record.key}=${record.port}`,
  ]);
  return [...kept, ...generated, ""].join("\n");
}

function writePortalRegistry(
  worktreeDir: string,
  records: PortalRecord[],
): void {
  const path = registryPath(worktreeDir);
  const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, serializedPortalRegistry(previous, records));
}

async function portListening(port: number): Promise<boolean> {
  const proc = Bun.spawn(
    ["bash", "-lc", `exec 3<>/dev/tcp/127.0.0.1/${port}`],
    { stdout: "ignore", stderr: "ignore" },
  );
  return (await proc.exited) === 0;
}

async function pidAlive(pid?: number): Promise<boolean> {
  if (!pid || pid < 2) return false;
  const proc = Bun.spawn(["kill", "-0", String(pid)], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

/**
 * The primitives a Portal registry needs. Host and Sandbox supervise the same
 * persisted state machine and differ only in how they read and write
 * `.ports.conf`, probe a port, inspect a pid, and signal a process group, so
 * they share one implementation of list/start/stop/restart/setPath below.
 *
 * `writeRegistry` must re-read the file it is about to replace: a service can
 * take 15 seconds to come up, and unrelated `.ports.conf` lines written in
 * that window (the preview seeder's WEBAPP_PORT rewrite, for one) would
 * otherwise be reverted by a stale snapshot.
 */
type PortalOps = {
  readRegistry: () => Promise<PortalRecord[]>;
  writeRegistry: (records: PortalRecord[]) => Promise<void>;
  probePort: (port: number) => Promise<boolean>;
  pidAlive: (pid?: number) => Promise<boolean>;
  signalGroup: (pid: number, signal: "SIGTERM" | "SIGKILL") => Promise<void>;
  scopeAlive?: (unit: string) => Promise<boolean>;
  stopScope?: (unit: string) => Promise<void>;
};

function hostPortalOps(worktreeDir: string): PortalOps {
  return {
    readRegistry: async () => readPortalRegistry(worktreeDir),
    writeRegistry: async (records) => writePortalRegistry(worktreeDir, records),
    probePort: portListening,
    pidAlive,
    scopeAlive: userScopeActive,
    stopScope: stopUserScopeAndWait,
    // Signal the whole setsid group even if its original leader has already
    // exited. That is the common failure mode for a supervisor which leaves
    // its worker behind after a server restart.
    signalGroup: async (pid, signal) => {
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {}
      }
    },
  };
}

type PortalProcess = Pick<PortalRecord, "pid" | "scopeUnit">;

async function portalProcessAlive(
  ops: PortalOps,
  processRef: PortalProcess,
): Promise<boolean> {
  // The systemd-run client remains in the gateway cgroup while its detached
  // scope runs. Check both so launch cannot race unit creation, while a new
  // gateway can still rediscover a surviving Portal by its persisted unit.
  if (
    processRef.scopeUnit &&
    ops.scopeAlive &&
    (await ops.scopeAlive(processRef.scopeUnit))
  )
    return true;
  return ops.pidAlive(processRef.pid);
}

async function waitForPortalPort(
  ops: PortalOps,
  port: number,
  processRef: PortalProcess,
  timeoutMs = 15_000,
): Promise<"ready" | "exited" | "timeout"> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await ops.probePort(port)) return "ready";
    if (!(await portalProcessAlive(ops, processRef))) return "exited";
    await Bun.sleep(200);
  }
  return "timeout";
}

async function allocatePort(worktreeDir: string): Promise<number> {
  const reserved = new Set(
    readPortalRegistry(worktreeDir).map((record) => record.port),
  );
  for (let port = 4_000; port < 9_000; port++) {
    if (!reserved.has(port) && !(await portListening(port))) return port;
  }
  throw new Error("No Portal ports are available.");
}

async function allocateSandboxPort(
  sandbox: Sandbox,
  records: PortalRecord[],
): Promise<number> {
  const reserved = new Set(records.map((record) => record.port));
  // Docker and local microVM Sandboxes have a fixed published range. Remote
  // providers use their outbound relay and never expose a provider URL here.
  if (usesOutboundSandboxPortalRelay(sandbox.provider)) {
    for (let port = 4_000; port < 9_000; port++)
      if (!reserved.has(port)) return port;
    throw new Error("No Sandbox Portal ports are available.");
  }
  const published = Object.keys(await sandbox.ports())
    .map(Number)
    .filter(
      (port) => Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT,
    )
    .sort((a, b) => a - b);
  if (published.length) {
    const port = published.find((candidate) => !reserved.has(candidate));
    if (port != null) return port;
    throw new Error("No published Sandbox Portal ports are available.");
  }
  for (let port = 4_000; port < 9_000; port++)
    if (!reserved.has(port)) return port;
  throw new Error("No Sandbox Portal ports are available.");
}

export function normalizePortalPath(path?: string): string | undefined {
  if (!path?.trim()) return undefined;
  const value = path.trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\n"))
    throw new Error("Portal path must be root-relative.");
  return value;
}

function upsert(records: PortalRecord[], next: PortalRecord): PortalRecord[] {
  const index = records.findIndex((record) => record.name === next.name);
  if (index < 0) return [...records, next];
  const copy = [...records];
  copy[index] = next;
  return copy;
}

/** " See <log>" plus the last lines of the log when it is readable here. */
function portalLogHint(logPath: string | undefined): string {
  if (!logPath) return "";
  let tail = "";
  try {
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
      tail = lines.slice(-12).join("\n").slice(-1_500);
    }
  } catch {}
  return tail ? ` Log (${logPath}):\n${tail}` : ` Log: ${logPath}`;
}

async function listPortals(ops: PortalOps): Promise<PortalRecord[]> {
  const records = await ops.readRegistry();
  let changed = false;
  const checked = await Promise.all(
    records.map(async (record) => {
      if (
        record.state === "stopped" ||
        record.state === "failed" ||
        record.state === "sleeping"
      )
        return record;
      const listening = await ops.probePort(record.port);
      const alive = await portalProcessAlive(ops, record);
      // "pid alive but not listening" only means starting while the Portal has
      // never been awake. Once it WAS awake, losing the listener is a crash even
      // when a wrapper (just/concurrently) survives its dead dev server —
      // otherwise the record ghosts as an eternal "starting" stub: invisible as
      // a live Portal, yet blocking every new start with "already exists".
      // Records poisoned before this rule existed lost their awake history, so
      // also fail a "starting" record stuck past the maximum readiness window.
      const startedMs = record.startedAt
        ? Date.now() - Date.parse(record.startedAt)
        : 0;
      const stuckStarting =
        record.state === "starting" && startedMs > MAX_PORTAL_READY_MS;
      const state: PortalState = listening
        ? "awake"
        : alive && record.state !== "awake" && !stuckStarting
          ? "starting"
          : "failed";
      if (state === record.state) return record;
      changed = true;
      return {
        ...record,
        state,
        ...(state === "failed"
          ? { lastError: "The service is no longer listening." }
          : {}),
      };
    }),
  );
  if (changed) await ops.writeRegistry(checked);
  return checked;
}

/**
 * Start a Portal and drive it through starting -> awake, persisting every
 * transition. `launch` owns the one side-specific step: spawn the process and
 * return its pid, or throw with the message the caller should see.
 */
async function startPortal(
  ops: PortalOps,
  input: {
    sessionId: string;
    name: string;
    command: string;
    port?: number;
    key?: string;
    description?: string;
    defaultPath?: string;
    readyTimeoutMs?: number;
    /** Host Portals record their owner so a restarted server can reap them; Sandbox Portals die with the Sandbox. */
    ownsProcess: boolean;
    allocatePort: (records: PortalRecord[]) => Promise<number>;
    /** Extra, side-specific qualification of the chosen port (published Sandbox ports). */
    qualifyPort?: (port: number, records: PortalRecord[]) => Promise<void>;
    urlFor: (port: number) => string;
    /** Where the service's stdout/stderr land. Named in failure messages so
     *  an agent can read why a Portal died; the tail is inlined when the file
     *  is readable from here (host Portals). */
    logPath?: string;
    launch: (context: {
      name: string;
      command: string;
      port: number;
      url: string;
    }) => Promise<Required<Pick<PortalRecord, "pid">> & PortalProcess>;
  },
): Promise<PortalRecord & { url: string }> {
  const name = validateName(input.name);
  const command = input.command.trim();
  if (!command || command.length > 8_000)
    throw new Error("Portal command is required.");
  const records = await listPortals(ops);
  const current = records.find((record) => record.name === name);
  if (
    current &&
    current.state !== "stopped" &&
    current.state !== "failed" &&
    current.state !== "sleeping"
  ) {
    const key = validateKey(input.key) ?? portalKey(name);
    const sameService =
      current.command === command &&
      current.key === key &&
      (input.port == null || current.port === input.port);
    if (current.state === "awake" && sameService)
      return { ...current, url: input.urlFor(current.port) };
    throw new Error(`Portal '${name}' already exists. Restart it instead.`);
  }
  // A dead record can leave its process group behind (a crashed dev server's
  // wrapper, watchers, lock holders). Reap it before starting anew so the
  // fresh start does not collide with orphaned ReScript/Next processes.
  if (current) await terminatePortalProcess(ops, current);
  const port =
    input.port == null
      ? await input.allocatePort(records)
      : validatePort(input.port);
  if (
    records.some((record) => record.name !== name && record.port === port) ||
    (await ops.probePort(port))
  )
    throw new Error(`Port ${port} is already in use.`);
  await input.qualifyPort?.(port, records);
  const url = input.urlFor(port);
  const base: PortalRecord = {
    name,
    key: validateKey(input.key) ?? portalKey(name),
    command,
    port,
    ...(input.ownsProcess ? { sessionId: input.sessionId } : {}),
    ...(input.description?.trim()
      ? { description: input.description.trim().slice(0, 240) }
      : {}),
    ...(normalizePortalPath(input.defaultPath)
      ? { defaultPath: normalizePortalPath(input.defaultPath) }
      : {}),
    ...(input.readyTimeoutMs ? { readyTimeoutMs: input.readyTimeoutMs } : {}),
    state: "starting",
    startedAt: new Date().toISOString(),
  };
  await ops.writeRegistry(upsert(records, base));
  let processRef: Required<Pick<PortalRecord, "pid">> & PortalProcess;
  try {
    processRef = await input.launch({ name, command, port, url });
  } catch (error) {
    const failed = {
      ...base,
      state: "failed" as const,
      lastError: (error as Error).message,
    };
    await ops.writeRegistry(upsert(records, failed));
    throw error;
  }
  const record = { ...base, ...processRef };
  await ops.writeRegistry(upsert(records, record));
  const readyTimeoutMs = Math.min(
    MAX_PORTAL_READY_MS,
    Math.max(5_000, input.readyTimeoutMs ?? 15_000),
  );
  const readiness = await waitForPortalPort(
    ops,
    port,
    processRef,
    readyTimeoutMs,
  );
  if (readiness !== "ready") {
    const lastError =
      (readiness === "exited"
        ? "The Portal process exited before it started listening."
        : `Nothing listened on port ${port} within ${Math.round(readyTimeoutMs / 1_000)} seconds.`) +
      portalLogHint(input.logPath);
    // A timed-out process may still be compiling and can leave watchers or
    // lock files behind. Never lose its PID by overwriting the failed record
    // before the complete process group has been terminated.
    await terminatePortalProcess(ops, processRef);
    const failed = {
      ...record,
      pid: undefined,
      scopeUnit: undefined,
      state: "failed" as const,
      lastError,
    };
    await ops.writeRegistry(upsert(records, failed));
    throw new Error(lastError);
  }
  const awake = { ...record, state: "awake" as const };
  await ops.writeRegistry(upsert(records, awake));
  return { ...awake, url };
}

async function terminatePortalProcess(
  ops: PortalOps,
  processRef: PortalProcess,
): Promise<void> {
  if (processRef.scopeUnit && ops.stopScope) {
    await ops.stopScope(processRef.scopeUnit);
    if (!(await portalProcessAlive(ops, processRef))) return;
  }
  const pid = processRef.pid;
  if (!pid || pid < 2 || !(await ops.pidAlive(pid))) return;
  await ops.signalGroup(pid, "SIGTERM");
  await Bun.sleep(1_500);
  if (await ops.pidAlive(pid)) await ops.signalGroup(pid, "SIGKILL");
}

async function stopPortal(ops: PortalOps, name: string): Promise<PortalRecord> {
  const records = await ops.readRegistry();
  const current = records.find((record) => record.name === name);
  if (!current) throw new Error(`Portal '${name}' does not exist.`);
  await terminatePortalProcess(ops, current);
  const stopped = {
    ...current,
    state: "stopped" as const,
    pid: undefined,
    scopeUnit: undefined,
  };
  await ops.writeRegistry(upsert(records, stopped));
  return stopped;
}

/** Apply a default path to one Portal, or to all of them when no name is given. */
function withPortalPath(
  records: PortalRecord[],
  path: string,
  name?: string,
): PortalRecord[] {
  const value = normalizePortalPath(path);
  if (name && !records.some((record) => record.name === validateName(name)))
    throw new Error(`Portal '${name}' does not exist.`);
  return records.map((record) =>
    !name || record.name === validateName(name)
      ? { ...record, defaultPath: value }
      : record,
  );
}

export async function listPortalServices(
  worktreeDir: string,
): Promise<PortalRecord[]> {
  const records = await listPortals(hostPortalOps(worktreeDir));
  for (const record of records) registerHostPortal(worktreeDir, record);
  return records;
}

export async function startPortalService(input: {
  sessionId: string;
  worktreeDir: string;
  name: string;
  command: string;
  port?: number;
  key?: string;
  description?: string;
  defaultPath?: string;
  readyTimeoutMs?: number;
  /** Narrow, caller-owned additions for a trusted declared recipe. */
  env?: Record<string, string>;
}): Promise<PortalRecord & { url: string }> {
  const current = readPortalRegistry(input.worktreeDir).find(
    (record) => record.name === input.name,
  );
  const releaseAdmission =
    current?.state === "awake"
      ? () => {}
      : reserveHostPortalStart(input.worktreeDir, input.name);
  const logDir = join(sessionScratchRoot(), input.sessionId, "portals");
  const logPath = join(logDir, `${input.name}.log`);
  // The same short-lived AWS credentials the agent's own shell gets (a pointer
  // to a file the server keeps fresh). The service cgroup denies IMDS, and a
  // repository's dev server (tella-fusion's start.sh) otherwise falls back to
  // an operator SSO profile and hangs on an interactive login. {} when the
  // mint is off.
  try {
    const awsEnv = await ensureAgentAwsCredsFile();
    const started = await startPortal(hostPortalOps(input.worktreeDir), {
      ...input,
      ownsProcess: true,
      logPath,
      allocatePort: () => allocatePort(input.worktreeDir),
      urlFor: (port) =>
        `https://${configuredServer().previewHost}:${port + 6_000}`,
      launch: async ({ name, command, port, url }) => {
        mkdirSync(logDir, { recursive: true });
        const log = openSync(logPath, "w");
        const directCommand = ["setsid", "bash", "-lc", `exec ${command}`];
        const portalEnv = {
          PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
          HOME: process.env.HOME || "/tmp",
          ...awsEnv,
          ...input.env,
          PORT: String(port),
          PORTAL_URL: url,
          OPENSESSION_PORTAL: name,
          // Next's detached telemetry flusher escapes the Portal process group
          // during shutdown. Portals do not need telemetry, so never create it.
          NEXT_TELEMETRY_DISABLED: "1",
        };
        const scoped = previewScopeCommand(
          directCommand,
          input.worktreeDir,
          name,
          { env: portalEnv },
        );
        const proc = Bun.spawn(scoped.command, {
          cwd: input.worktreeDir,
          // Portal commands are user-authored code. Do not hand them the Open
          // Session service environment, which can include operator credentials.
          env: scoped.env,
          stdin: "ignore",
          stdout: log,
          stderr: log,
        });
        closeSync(log);
        proc.unref();
        return {
          pid: proc.pid,
          ...(scoped.unit ? { scopeUnit: scoped.unit } : {}),
        };
      },
    });
    registerHostPortal(input.worktreeDir, started, true);
    audit({
      msg: "portal_started",
      session_id: input.sessionId,
      portal: started.name,
      port: started.port,
    });
    return started;
  } finally {
    releaseAdmission();
  }
}

export async function stopPortalService(input: {
  sessionId: string;
  worktreeDir: string;
  name: string;
}): Promise<PortalRecord> {
  const stopped = await stopPortal(
    hostPortalOps(input.worktreeDir),
    validateName(input.name),
  );
  audit({
    msg: "portal_stopped",
    session_id: input.sessionId,
    portal: stopped.name,
    port: stopped.port,
  });
  return stopped;
}

async function sleepPortalService(input: {
  sessionId: string;
  worktreeDir: string;
  name: string;
  lastAccessedAt: number;
}): Promise<PortalRecord> {
  const ops = hostPortalOps(input.worktreeDir);
  const records = await ops.readRegistry();
  const current = records.find((record) => record.name === input.name);
  if (!current) throw new Error(`Portal '${input.name}' does not exist.`);
  if (current.state !== "awake") return current;
  await terminatePortalProcess(ops, current);
  const now = new Date().toISOString();
  const sleeping = {
    ...current,
    state: "sleeping" as const,
    pid: undefined,
    scopeUnit: undefined,
    lastAccessedAt: new Date(input.lastAccessedAt).toISOString(),
    sleptAt: now,
  };
  await ops.writeRegistry(upsert(records, sleeping));
  registerHostPortal(input.worktreeDir, sleeping);
  audit({
    msg: "portal_slept",
    session_id: input.sessionId,
    portal: sleeping.name,
    port: sleeping.port,
  });
  return sleeping;
}

/** Stop every host-managed Portal before its session workspace is removed. */
export async function stopAllPortalServices(input: {
  sessionId: string;
  worktreeDir: string;
}): Promise<void> {
  const records = readPortalRegistry(input.worktreeDir);
  for (const record of records) {
    if (record.state === "stopped") continue;
    try {
      await stopPortalService({ ...input, name: record.name });
    } catch (error) {
      console.warn(
        `[portals] could not stop ${record.name} for ${input.sessionId}:`,
        error,
      );
    }
  }
}

export type PortalOwnerSession = Pick<
  UnifiedSession,
  "id" | "worktreeDir" | "attachedRepos"
> &
  Partial<Pick<UnifiedSession, "isRunning">>;
export type PortalReapResult = {
  stopped: Array<{ sessionId: string; worktreeDir: string; name: string }>;
};

export type PortalSleepResult = {
  slept: Array<{ sessionId: string; worktreeDir: string; name: string }>;
};

export async function sleepIdlePortalServices(
  sessions: readonly PortalOwnerSession[],
  options: { now?: number; idleMs?: number } = {},
): Promise<PortalSleepResult> {
  const now = options.now ?? Date.now();
  const idleMs =
    options.idleMs ??
    positiveIntegerEnv("OPENSESSION_PORTAL_IDLE_MS", DEFAULT_PORTAL_IDLE_MS);
  const owners = new Map(sessions.map((session) => [session.id, session]));
  const ownerDirs = sessions
    .flatMap((session) => [
      session.worktreeDir,
      ...(session.attachedRepos ?? []).map((repo) => repo.dir),
    ])
    .filter((dir): dir is string => typeof dir === "string");
  const slept: PortalSleepResult["slept"] = [];
  for (const { ref, record } of managedHostPortals(ownerDirs)) {
    const owner = owners.get(ref.sessionId);
    if (!owner) continue; // The orphan reaper owns this case.
    const key = portalRefKey(ref.worktreeDir, ref.name);
    const persistedAccess = Date.parse(
      record.lastAccessedAt ?? record.startedAt ?? "",
    );
    const lastAccessedAt =
      hostPortalAccess.get(key) ??
      (Number.isFinite(persistedAccess) ? persistedAccess : now);
    if (
      !portalShouldSleep({
        state: record.state,
        ownerRunning: !!owner.isRunning,
        now,
        lastAccessedAt,
        idleMs,
      })
    )
      continue;
    try {
      await sleepPortalService({
        sessionId: ref.sessionId,
        worktreeDir: ref.worktreeDir,
        name: ref.name,
        lastAccessedAt,
      });
      slept.push({
        sessionId: ref.sessionId,
        worktreeDir: ref.worktreeDir,
        name: ref.name,
      });
    } catch (error) {
      console.warn(
        `[portals] could not sleep idle ${ref.name} in ${ref.worktreeDir}:`,
        error,
      );
    }
  }
  return { slept };
}

export function portalsNeedingContainment(
  records: readonly PortalRecord[],
  scopesAvailable = systemdUserScopesAvailable(),
): PortalRecord[] {
  if (!scopesAvailable) return [];
  return records.filter(
    (record) =>
      (record.state === "awake" || record.state === "starting") &&
      !record.scopeUnit &&
      !!record.pid,
  );
}

export type PortalContainmentMigrationResult = {
  migrated: Array<{ sessionId: string; worktreeDir: string; name: string }>;
};

/**
 * One key per directory, whatever path spells it. Sessions record the shared
 * checkout under both its real name and an old symlinked alias; keyed by the
 * spelling, the same registry read under the alias made every Portal owned by
 * a session spelled the other way look orphaned, and the reaper killed it.
 */
function canonicalDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

function portalRefKey(worktreeDir: string, name: string): string {
  return `${canonicalDir(worktreeDir)}\0${name}`;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function registerHostPortal(
  worktreeDir: string,
  portal: PortalRecord,
  accessedNow = false,
): void {
  if (!portal.sessionId) return;
  const ref = {
    sessionId: portal.sessionId,
    worktreeDir: canonicalDir(worktreeDir),
    name: portal.name,
    port: portal.port,
  };
  hostPortalRefs.set(portal.port, ref);
  const key = portalRefKey(ref.worktreeDir, ref.name);
  if (accessedNow) {
    hostPortalAccess.set(key, Date.now());
  } else if (!hostPortalAccess.has(key)) {
    const persisted = Date.parse(
      portal.lastAccessedAt ?? portal.startedAt ?? "",
    );
    hostPortalAccess.set(
      key,
      Number.isFinite(persisted) ? persisted : Date.now(),
    );
  }
}

function managedHostPortals(additionalDirs: readonly string[] = []): Array<{
  ref: HostPortalRef;
  record: PortalRecord;
}> {
  const dirs = new Set(additionalDirs.filter(Boolean).map(canonicalDir));
  for (const ref of hostPortalRefs.values()) dirs.add(ref.worktreeDir);
  try {
    for (const entry of readdirSync(configuredPaths().worktreesDir, {
      withFileTypes: true,
    })) {
      if (entry.isDirectory())
        dirs.add(
          canonicalDir(join(configuredPaths().worktreesDir, entry.name)),
        );
    }
  } catch {}
  const portals: Array<{ ref: HostPortalRef; record: PortalRecord }> = [];
  for (const worktreeDir of dirs) {
    for (const record of readPortalRegistry(worktreeDir)) {
      if (
        !record.sessionId ||
        (!record.scopeUnit && record.state !== "sleeping")
      )
        continue;
      registerHostPortal(worktreeDir, record);
      portals.push({
        ref: {
          sessionId: record.sessionId,
          worktreeDir,
          name: record.name,
          port: record.port,
        },
        record,
      });
    }
  }
  return portals;
}

function hostPortalRecord(
  sourcePort: number,
): { ref: HostPortalRef; record: PortalRecord } | undefined {
  if (
    !Number.isInteger(sourcePort) ||
    sourcePort < MIN_PORT ||
    sourcePort >= 14_000
  )
    return;
  let ref = hostPortalRefs.get(sourcePort);
  if (!ref) {
    managedHostPortals();
    ref = hostPortalRefs.get(sourcePort);
  }
  if (!ref) return;
  const record = readPortalRegistry(ref.worktreeDir).find(
    (candidate) =>
      candidate.name === ref!.name && candidate.port === sourcePort,
  );
  if (!record) {
    hostPortalRefs.delete(sourcePort);
    return;
  }
  return { ref, record };
}

/** Resolve one Caddy host-Portal upstream and record real HTTP activity. */
export function hostPortalRouteStatus(
  sourcePort: number,
): { state: PortalState; sessionId: string } | undefined {
  const found = hostPortalRecord(sourcePort);
  if (!found) return;
  if (found.record.state === "awake")
    hostPortalAccess.set(
      portalRefKey(found.ref.worktreeDir, found.ref.name),
      Date.now(),
    );
  return { state: found.record.state, sessionId: found.ref.sessionId };
}

/** Wake a Portal that the idle reaper deliberately slept. Concurrent browser
 * refreshes share one cold start rather than spawning competing dev servers. */
export function wakeHostPortalRoute(
  sourcePort: number,
): Promise<PortalRecord & { url: string }> {
  const found = hostPortalRecord(sourcePort);
  if (!found) return Promise.reject(new Error("Host Portal is not registered"));
  if (found.record.state === "awake") {
    registerHostPortal(found.ref.worktreeDir, found.record, true);
    return Promise.resolve({
      ...found.record,
      url: `https://${configuredServer().previewHost}:${sourcePort + 6_000}`,
    });
  }
  if (found.record.state !== "sleeping")
    return Promise.reject(
      new Error(`Host Portal is ${found.record.state}, not sleeping`),
    );
  const key = portalRefKey(found.ref.worktreeDir, found.ref.name);
  const existing = hostPortalWakes.get(key);
  if (existing) return existing;
  const wake = startPortalService({
    sessionId: found.ref.sessionId,
    worktreeDir: found.ref.worktreeDir,
    name: found.record.name,
    command: found.record.command,
    port: found.record.port,
    key: found.record.key,
    description: found.record.description,
    defaultPath: found.record.defaultPath,
    readyTimeoutMs: found.record.readyTimeoutMs ?? 180_000,
  }).finally(() => hostPortalWakes.delete(key));
  hostPortalWakes.set(key, wake);
  return wake;
}

export function hostPortalAdmissionReason(input: {
  active: number;
  reserved?: number;
  maxActive: number;
  availableMemoryMb: number;
  minAvailableMemoryMb: number;
}): string | undefined {
  if (input.active + (input.reserved ?? 0) >= input.maxActive)
    return `Host Portal capacity is full (${input.maxActive} active)`;
  if (input.availableMemoryMb < input.minAvailableMemoryMb)
    return `Host memory is below the Portal safety floor (${Math.round(input.availableMemoryMb)} MB available; ${input.minAvailableMemoryMb} MB required)`;
  return undefined;
}

function availableMemoryMb(): number {
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(
      readFileSync("/proc/meminfo", "utf8"),
    );
    return match ? Number(match[1]) / 1024 : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function reserveHostPortalStart(worktreeDir: string, name: string): () => void {
  const key = portalRefKey(worktreeDir, name);
  const active = managedHostPortals().filter(({ record }) =>
    ["starting", "waking", "awake"].includes(record.state),
  ).length;
  const reason = hostPortalAdmissionReason({
    active,
    reserved: hostPortalReservations.size,
    maxActive: positiveIntegerEnv(
      "OPENSESSION_MAX_HOST_PORTALS",
      DEFAULT_MAX_HOST_PORTALS,
    ),
    availableMemoryMb: availableMemoryMb(),
    minAvailableMemoryMb: positiveIntegerEnv(
      "OPENSESSION_PORTAL_MIN_AVAILABLE_MEMORY_MB",
      DEFAULT_MIN_AVAILABLE_MEMORY_MB,
    ),
  });
  if (reason)
    throw new Error(`${reason}. Stop another Portal or wait for it to sleep.`);
  hostPortalReservations.add(key);
  return () => hostPortalReservations.delete(key);
}

export function portalShouldSleep(input: {
  state: PortalState;
  ownerRunning: boolean;
  now: number;
  lastAccessedAt: number;
  idleMs: number;
}): boolean {
  return (
    input.state === "awake" &&
    !input.ownerRunning &&
    input.now - input.lastAccessedAt >= input.idleMs
  );
}

/**
 * Stop host Portal process groups that no live session owns. Portal records
 * are intentionally stored with the worktree, which survives a coordinator
 * restart, so this closes the gap between a crashed delete and the next human
 * action. Legacy records without sessionId are only reaped when no session
 * owns their worktree at all.
 */
export async function reapOrphanedPortalServices(
  sessions: readonly PortalOwnerSession[],
): Promise<PortalReapResult> {
  const owners = new Map<string, Set<string>>();
  const addOwner = (dir: string | null | undefined, sessionId: string) => {
    if (!dir) return;
    const key = canonicalDir(dir);
    const set = owners.get(key) ?? new Set<string>();
    set.add(sessionId);
    owners.set(key, set);
  };
  for (const session of sessions) {
    addOwner(session.worktreeDir, session.id);
    for (const repo of session.attachedRepos ?? [])
      addOwner(repo.dir, session.id);
  }

  // Include session worktrees outside the normal worktree root, then discover
  // deleted-session worktrees below the managed root. We only act on explicit
  // OpenSession Portal records, never arbitrary processes in those directories.
  const dirs = new Set(owners.keys());
  try {
    for (const entry of readdirSync(configuredPaths().worktreesDir, {
      withFileTypes: true,
    })) {
      if (entry.isDirectory())
        dirs.add(
          canonicalDir(join(configuredPaths().worktreesDir, entry.name)),
        );
    }
  } catch {}

  const stopped: PortalReapResult["stopped"] = [];
  for (const worktreeDir of dirs) {
    const liveOwners = owners.get(worktreeDir) ?? new Set<string>();
    for (const portal of readPortalRegistry(worktreeDir)) {
      if (portal.state === "stopped" || portal.state === "failed") continue;
      const orphaned = portal.sessionId
        ? !liveOwners.has(portal.sessionId)
        : liveOwners.size === 0;
      if (!orphaned) continue;
      const sessionId = portal.sessionId || "orphaned-portal";
      try {
        await stopPortalService({ sessionId, worktreeDir, name: portal.name });
        stopped.push({ sessionId, worktreeDir, name: portal.name });
        audit({
          msg: "portal_orphan_reaped",
          session_id: sessionId,
          portal: portal.name,
        });
      } catch (error) {
        console.warn(
          `[portals] could not reap ${portal.name} in ${worktreeDir}:`,
          error,
        );
      }
    }
  }
  return { stopped };
}

/**
 * A release predating Portal scopes can leave live preview trees inside the
 * gateway service cgroup. Restart only durable, live-owned Portal records so
 * they re-enter through startPortalService and acquire their private scope.
 * Stopped/failed records and non-systemd development hosts are untouched.
 */
export async function migrateUnscopedPortalServices(
  sessions: readonly PortalOwnerSession[],
): Promise<PortalContainmentMigrationResult> {
  if (!systemdUserScopesAvailable()) return { migrated: [] };
  const owners = new Map<string, Set<string>>();
  const addOwner = (dir: string | null | undefined, sessionId: string) => {
    if (!dir) return;
    const key = canonicalDir(dir);
    const set = owners.get(key) ?? new Set<string>();
    set.add(sessionId);
    owners.set(key, set);
  };
  for (const session of sessions) {
    addOwner(session.worktreeDir, session.id);
    for (const repo of session.attachedRepos ?? [])
      addOwner(repo.dir, session.id);
  }

  const migrated: PortalContainmentMigrationResult["migrated"] = [];
  for (const [worktreeDir, liveOwners] of owners) {
    const records = readPortalRegistry(worktreeDir);
    for (const portal of portalsNeedingContainment(records, true)) {
      const owned = portal.sessionId
        ? liveOwners.has(portal.sessionId)
        : liveOwners.size > 0;
      if (!owned) continue;
      const sessionId = portal.sessionId || liveOwners.values().next().value;
      if (!sessionId) continue;
      try {
        await restartPortalService({
          sessionId,
          worktreeDir,
          name: portal.name,
          readyTimeoutMs: 180_000,
        });
        migrated.push({ sessionId, worktreeDir, name: portal.name });
        audit({
          msg: "portal_containment_migrated",
          session_id: sessionId,
          portal: portal.name,
        });
      } catch (error) {
        console.warn(
          `[portals] could not migrate ${portal.name} in ${worktreeDir} into a private scope:`,
          error,
        );
      }
    }
  }
  return { migrated };
}

let portalReapTimer: ReturnType<typeof setInterval> | null = null;
let portalReconcileInFlight = false;

/** Reconcile Portal process groups after boot and every five minutes. */
export function startPortalReaper(
  getSessions: () => readonly PortalOwnerSession[] = () => [],
): void {
  if (portalReapTimer) return;
  const run = () => {
    if (portalReconcileInFlight) return;
    let sessions: readonly PortalOwnerSession[];
    try {
      sessions = getSessions();
    } catch (error) {
      console.error(
        "[portals] session snapshot failed; skipping orphan reap:",
        error,
      );
      return;
    }
    portalReconcileInFlight = true;
    void reapOrphanedPortalServices(sessions)
      .then(async ({ stopped }) => {
        if (stopped.length)
          console.log(
            `[portals] reaped ${stopped.length} orphaned Portal service(s)`,
          );
        const { slept } = await sleepIdlePortalServices(sessions);
        if (slept.length)
          console.log(`[portals] slept ${slept.length} idle Portal service(s)`);
        const { migrated } = await migrateUnscopedPortalServices(sessions);
        if (migrated.length)
          console.log(
            `[portals] migrated ${migrated.length} Portal service(s) into private scopes`,
          );
      })
      .catch((error) =>
        console.error("[portals] reconciliation failed:", error),
      )
      .finally(() => {
        portalReconcileInFlight = false;
      });
  };
  run();
  portalReapTimer = setInterval(run, PORTAL_REAP_INTERVAL_MS);
  portalReapTimer.unref?.();
  console.log(
    `[portals] orphan reaper started (every ${PORTAL_REAP_INTERVAL_MS / 60_000}m)`,
  );
}

export async function restartPortalService(input: {
  sessionId: string;
  worktreeDir: string;
  name: string;
  env?: Record<string, string>;
  readyTimeoutMs?: number;
}): Promise<PortalRecord & { url: string }> {
  const name = validateName(input.name);
  const current = readPortalRegistry(input.worktreeDir).find(
    (record) => record.name === name,
  );
  if (!current) throw new Error(`Portal '${name}' does not exist.`);
  await stopPortalService(input);
  return startPortalService({
    ...input,
    name,
    key: current.key,
    command: current.command,
    port: current.port,
    description: current.description,
    defaultPath: current.defaultPath,
    readyTimeoutMs: input.readyTimeoutMs ?? current.readyTimeoutMs,
  });
}

export function setPortalPath(
  worktreeDir: string,
  path: string,
  name?: string,
): PortalRecord[] {
  const next = withPortalPath(readPortalRegistry(worktreeDir), path, name);
  writePortalRegistry(worktreeDir, next);
  return next;
}

/**
 * The sandbox counterpart intentionally uses only the Sandbox command seam.
 * The host never obtains a provider preview URL, shell, or arbitrary port:
 * commands run in the current Sandbox workspace and published ports are
 * qualified by `getSandboxPreviewStatus` before Caddy exposes them.
 */
async function readSandboxPortalRegistry(
  sandbox: Sandbox,
): Promise<{ text: string; records: PortalRecord[] }> {
  const response = await sandbox.exec([
    "bash",
    "-c",
    "cat .ports.conf 2>/dev/null || true",
  ]);
  return {
    text: response.stdout,
    records: parsePortalRegistry(response.stdout),
  };
}

async function writeSandboxPortalRegistry(
  sandbox: Sandbox,
  records: PortalRecord[],
): Promise<void> {
  const { text } = await readSandboxPortalRegistry(sandbox);
  const data = Buffer.from(serializedPortalRegistry(text, records)).toString(
    "base64",
  );
  const response = await sandbox.exec([
    "bash",
    "-c",
    `printf %s ${shellQuoteWord(data)} | base64 -d > .ports.conf`,
  ]);
  if (response.exitCode !== 0)
    throw new Error(
      response.stderr.trim() || "Could not update the Sandbox Portal registry.",
    );
}

function sandboxPortalOps(sandbox: Sandbox, sessionId?: string): PortalOps {
  return {
    readRegistry: async () =>
      (await readSandboxPortalRegistry(sandbox)).records,
    writeRegistry: async (records) => {
      await writeSandboxPortalRegistry(sandbox, records);
      if (sessionId) cacheSandboxPortalRecords(sessionId, sandbox.id, records);
    },
    probePort: async (port) =>
      (
        await sandbox.exec([
          "timeout",
          "2",
          "bash",
          "-c",
          `exec 3<>/dev/tcp/127.0.0.1/${port}`,
        ])
      ).exitCode === 0,
    pidAlive: async (pid) => {
      if (!pid || pid < 2) return false;
      return (await sandbox.exec(["kill", "-0", String(pid)])).exitCode === 0;
    },
    signalGroup: async (pid, signal) => {
      const flag = signal === "SIGKILL" ? "-KILL" : "-TERM";
      await sandbox.exec([
        "bash",
        "-c",
        `kill ${flag} -- -${pid} 2>/dev/null || kill ${flag} ${pid} 2>/dev/null || true`,
      ]);
    },
  };
}

/**
 * Connect a remote Sandbox service to its session-scoped, outbound-only Portal
 * relay. Local providers stay behind the same authenticated Portal surface,
 * but can use their private host mapping directly and need no sidecar.
 *
 * The sidecar is intentionally launched from the bootstrapped Open Session
 * checkout, never downloaded from a provider URL. Repeated calls renew a
 * short-lived grant before it expires; the server replaces the old socket.
 */
export async function ensureRemoteSandboxPortalAgent(input: {
  sessionId: string;
  sandbox: Sandbox;
  port: number;
}): Promise<string | null> {
  if (!usesOutboundSandboxPortalRelay(input.sandbox.provider)) return null;
  const agentKey = `${input.sessionId}:${input.sandbox.id}:${input.port}`;
  const relayIdentity = {
    sessionId: input.sessionId,
    sandboxId: input.sandbox.id,
    port: input.port,
  };
  const current = remoteRelayAgents.get(agentKey);
  if (
    current &&
    current.expiresAt > Date.now() + 30_000 &&
    sandboxPortalRelayConnected(relayIdentity)
  ) {
    return ensureSandboxPortalRelay(relayIdentity);
  }
  const existingStart = remoteRelayAgentStarts.get(agentKey);
  if (existingStart) return existingStart;
  const start = (async () => {
    const grant = mintSandboxPortalGrant(relayIdentity);
    const callbackBase = remoteSandboxCallbackBaseUrl().replace(/\/$/, "");
    const endpoint = `${callbackBase}/sandbox-portal-ws?session=${encodeURIComponent(input.sessionId)}&sandbox=${encodeURIComponent(input.sandbox.id)}&port=${input.port}`;
    const logDir = sandboxSessionScratchDir(input.sessionId);
    const logPath = `${logDir}/sandbox-portal-${input.port}.log`;
    // Portal transport fixes must not wait for a repository image refresh or
    // mutate the prepared project. Copy this small, self-contained sidecar
    // into session scratch on every launch; the app workspace stays untouched.
    const agentPath = `${logDir}/sandbox-portal-agent.ts`;
    const agentPayload = Buffer.from(
      readFileSync(SANDBOX_PORTAL_AGENT_ENTRY, "utf8"),
    ).toString("base64");
    const relayLaunch = `mkdir -p ${shellQuoteWord(logDir)} && printf %s ${shellQuoteWord(agentPayload)} | base64 -d > ${shellQuoteWord(agentPath)} && OPENSESSION_SANDBOX_PORTAL_WS_URL=${shellQuoteWord(endpoint)} OPENSESSION_SANDBOX_PORTAL_TOKEN=${shellQuoteWord(grant.token)} OPENSESSION_SANDBOX_PORTAL_PORT=${shellQuoteWord(String(input.port))} OPENSESSION_SANDBOX_PORTAL_EXPIRES_AT=${shellQuoteWord(String(grant.expiresAt))} exec /home/ubuntu/.bun/bin/bun run ${shellQuoteWord(agentPath)} </dev/null >${shellQuoteWord(logPath)} 2>&1`;
    const started = await input.sandbox.exec(["bash", "-c", relayLaunch], {
      background: true,
      timeoutMs: 15_000,
    });
    if (started.exitCode !== 0)
      throw new Error(
        started.stderr.trim() || "Could not start the Sandbox Portal relay.",
      );
    remoteRelayAgents.set(agentKey, { expiresAt: grant.expiresAt });
    return ensureSandboxPortalRelay(relayIdentity);
  })();
  remoteRelayAgentStarts.set(agentKey, start);
  try {
    return await start;
  } finally {
    if (remoteRelayAgentStarts.get(agentKey) === start)
      remoteRelayAgentStarts.delete(agentKey);
  }
}

export function forgetRemoteSandboxPortalAgents(
  sandboxId: string,
  port?: number,
): void {
  for (const agentKey of remoteRelayAgents.keys()) {
    const [, id, agentPort] = agentKey.split(":");
    if (id === sandboxId && (port == null || Number(agentPort) === port))
      remoteRelayAgents.delete(agentKey);
  }
}

export async function listSandboxPortalServices(
  sandbox: Sandbox,
): Promise<PortalRecord[]> {
  return listPortals(sandboxPortalOps(sandbox));
}

/** The registry as persisted, without the liveness probe. A sandbox that just
 * woke has no processes left, so every record still marked live is a Portal
 * to restore rather than one to declare failed. */
export async function readSandboxPortalRecords(
  sandbox: Sandbox,
): Promise<PortalRecord[]> {
  return (await readSandboxPortalRegistry(sandbox)).records;
}

/**
 * The Portals the registry marks live whose process is gone: a provider that
 * stopped and restarted the Sandbox on its own (an idle timeout) leaves the
 * registry intact and every process dead, while the session's lifecycle never
 * saw a wake. `marked` is the registry as persisted; `probed` is the same
 * registry after the liveness probe (listSandboxPortalServices). A Portal the
 * probe still finds awake or starting is healthy and stays untouched.
 */
export function portalsToRestore(
  marked: PortalRecord[],
  probed: PortalRecord[],
): PortalRecord[] {
  const live = new Set(
    probed
      .filter(
        (record) => record.state !== "stopped" && record.state !== "failed",
      )
      .map((record) => record.name),
  );
  return marked.filter(
    (record) =>
      record.state !== "stopped" &&
      record.state !== "failed" &&
      !live.has(record.name),
  );
}

type SandboxPortalStartInput = {
  sessionId: string;
  sandbox: Sandbox;
  name: string;
  command: string;
  port?: number;
  key?: string;
  description?: string;
  readyTimeoutMs?: number;
  /** Short-lived workload identity for a trusted declared recipe. */
  env?: Record<string, string>;
};

function sandboxPortalOperations(): Map<string, Promise<PortalRecord>> {
  const global = globalThis as typeof globalThis & {
    __opensessionSandboxPortalOperations?: Map<string, Promise<PortalRecord>>;
  };
  return (global.__opensessionSandboxPortalOperations ??= new Map());
}

/** Whether a start, restart, or wake-restore for this Sandbox Portal is
 * running right now. The forward-auth probe shows the waiting page for it
 * instead of proxying to a port nobody listens on yet. */
export function sandboxPortalOperationPending(
  sandboxId: string,
  name: string,
): boolean {
  return sandboxPortalOperations().has(`${sandboxId}:${name}`);
}

function withSandboxPortalOperation(
  input: Pick<SandboxPortalStartInput, "sandbox" | "name">,
  operation: () => Promise<PortalRecord>,
): Promise<PortalRecord> {
  const operations = sandboxPortalOperations();
  const key = `${input.sandbox.id}:${validateName(input.name)}`;
  const current = operations.get(key);
  if (current) return current;
  const task = operation().finally(() => {
    if (operations.get(key) === task) operations.delete(key);
  });
  operations.set(key, task);
  return task;
}

async function startSandboxPortalServiceInner(
  input: SandboxPortalStartInput,
): Promise<PortalRecord> {
  // Sandbox-side path: it must match the agent's $OPENSESSION_SCRATCH there,
  // not the host's scratch root.
  const sandboxRuntimeDir = join(
    sandboxSessionScratchDir(input.sessionId),
    "portals",
  );
  const awake = await startPortal(
    sandboxPortalOps(input.sandbox, input.sessionId),
    {
      ...input,
      ownsProcess: false,
      allocatePort: (records) => allocateSandboxPort(input.sandbox, records),
      qualifyPort: async (port) => {
        const published = usesOutboundSandboxPortalRelay(input.sandbox.provider)
          ? {}
          : await input.sandbox.ports();
        if (Object.keys(published).length && !(port in published))
          throw new Error(`Port ${port} is not published for this Sandbox.`);
      },
      urlFor: (port) =>
        `https://${configuredServer().previewHost}:${sandboxHttpsPortFor(input.sandbox.id, port)}`,
      logPath: `${sandboxRuntimeDir}/${input.name}.log`,
      launch: async ({ name, command, port, url }) => {
        const runtimeDir = sandboxRuntimeDir;
        const legacyLogPath = `.opensession-portal-${name}.log`;
        const legacyPidPath = `.opensession-portal-${name}.pid`;
        const logPath = `${runtimeDir}/${name}.log`;
        const pidPath = `${runtimeDir}/${name}.pid`;
        // Provider command endpoints are allowed to reap children when a
        // synchronous shell returns. Start the service through the provider's
        // native detached lane. Logs and the short-lived PID marker live in
        // session scratch, never in the user's Git workspace.
        const launch = `rm -f ${shellQuoteWord(legacyLogPath)} ${shellQuoteWord(legacyPidPath)} && mkdir -p ${shellQuoteWord(runtimeDir)} && printf '%s\\n' $$ > ${shellQuoteWord(pidPath)} && HOME=/home/ubuntu PATH=${shellQuoteWord(SANDBOX_PORTAL_PATH)} PORT=${shellQuoteWord(String(port))} PORTAL_URL=${shellQuoteWord(url)} OPENSESSION_PORTAL=${shellQuoteWord(name)} exec setsid bash -c ${shellQuoteWord(`exec ${command}`)} >${shellQuoteWord(logPath)} 2>&1`;
        const launched = await input.sandbox.exec(["bash", "-c", launch], {
          env: input.env,
          background: true,
          timeoutMs: 15_000,
        });
        if (launched.exitCode !== 0)
          throw new Error(
            launched.stderr.trim() || "Could not start the Portal process.",
          );
        for (let attempt = 0; attempt < 20; attempt++) {
          const marker = await input.sandbox.exec([
            "bash",
            "-c",
            `cat ${shellQuoteWord(pidPath)} 2>/dev/null || true`,
          ]);
          const pid = Number(marker.stdout.trim());
          if (Number.isInteger(pid) && pid >= 2) {
            await input.sandbox.exec(["rm", "-f", pidPath]);
            return { pid };
          }
          await Bun.sleep(250);
        }
        throw new Error(
          "The detached Portal process did not publish its process id.",
        );
      },
    },
  );
  await ensureRemoteSandboxPortalAgent({
    sessionId: input.sessionId,
    sandbox: input.sandbox,
    port: awake.port,
  });
  if (
    usesOutboundSandboxPortalRelay(input.sandbox.provider) &&
    !(await waitForSandboxPortalRelay(
      {
        sessionId: input.sessionId,
        sandboxId: input.sandbox.id,
        port: awake.port,
      },
      15_000,
    ))
  ) {
    await stopPortal(
      sandboxPortalOps(input.sandbox, input.sessionId),
      awake.name,
    );
    revokeSandboxPortalRelay(input.sandbox.id, awake.port);
    forgetRemoteSandboxPortalAgents(input.sandbox.id, awake.port);
    throw new Error(
      `Portal relay did not connect within 15 seconds. See sandbox-portal-${awake.port}.log in this session's scratch directory.`,
    );
  }
  audit({
    msg: "sandbox_portal_started",
    session_id: input.sessionId,
    sandbox_id: input.sandbox.id,
    portal: awake.name,
    port: awake.port,
  });
  // The Sandbox preview URL is derived per request from the published port,
  // so the record stays url-free the way its callers persist it.
  const { url: _url, ...record } = awake;
  return record;
}

export function startSandboxPortalService(
  input: SandboxPortalStartInput,
): Promise<PortalRecord> {
  return withSandboxPortalOperation(input, () =>
    startSandboxPortalServiceInner(input),
  );
}

export async function stopSandboxPortalService(input: {
  sessionId: string;
  sandbox: Sandbox;
  name: string;
}): Promise<PortalRecord> {
  const stopped = await stopPortal(
    sandboxPortalOps(input.sandbox, input.sessionId),
    validateName(input.name),
  );
  revokeSandboxPortalRelay(input.sandbox.id, stopped.port);
  forgetRemoteSandboxPortalAgents(input.sandbox.id, stopped.port);
  audit({
    msg: "sandbox_portal_stopped",
    session_id: input.sessionId,
    sandbox_id: input.sandbox.id,
    portal: stopped.name,
    port: stopped.port,
  });
  return stopped;
}

export function restartSandboxPortalService(input: {
  sessionId: string;
  sandbox: Sandbox;
  name: string;
  command?: string;
  port?: number;
  key?: string;
  description?: string;
  env?: Record<string, string>;
  readyTimeoutMs?: number;
}): Promise<PortalRecord> {
  return withSandboxPortalOperation(input, async () => {
    const name = validateName(input.name);
    const current = (await sandboxPortalOps(input.sandbox).readRegistry()).find(
      (record) => record.name === name,
    );
    if (!current) throw new Error(`Portal '${name}' does not exist.`);
    await stopSandboxPortalService(input);
    return startSandboxPortalServiceInner({
      ...input,
      name,
      key: input.key ?? current.key,
      command: input.command ?? current.command,
      port: input.port ?? current.port,
      description: input.description ?? current.description,
    });
  });
}

export async function setSandboxPortalPath(
  sandbox: Sandbox,
  path: string,
  name?: string,
): Promise<PortalRecord[]> {
  const ops = sandboxPortalOps(sandbox);
  const next = withPortalPath(await ops.readRegistry(), path, name);
  await ops.writeRegistry(next);
  return next;
}
