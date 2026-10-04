/**
 * Script runs: long scripts and migrations an agent starts and Open Session
 * supervises, so they survive server restarts and show up in the session.
 *
 * A run is one shell command in the session's workspace on this machine. It
 * is owned by a script host (src/script-host/main.ts) launched in its own
 * transient user scope, outside the server's cgroup, so a deploy or crash of
 * the server leaves it running. The host appends output to the run's log,
 * enforces the deadline, and writes exit.json when the command ends.
 *
 * The server keeps one registry file of runs. On boot (startScriptRuns) it
 * reattaches every run it recorded as running: a run whose exit.json appeared
 * while the server was down is settled now, a live one is watched again, and
 * one whose host vanished without a record is marked lost. When a run ends,
 * the session that started it is woken with how it ended and the tail of its
 * output, exactly once, even across a restart.
 *
 * Relays. A run can carry relays, one per borrowed credential
 * (keychain-runs.ts). The host answers the script's loopback URL and
 * forwards each request over the run's relay socket to this server, which
 * hands it to the registered relay handler. Only the SHA-256 of each relay
 * secret is persisted, so the server can check a request after a restart
 * without the secret ever being written down.
 *
 * Cross-session reads come from the in-memory registry loaded once at boot;
 * nothing here scans session files or actor databases. All filesystem and
 * process work is asynchronous.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ScriptRunWire } from "@tellahq/opensession-protocol/session";
import { writeJsonAtomicAsync } from "./shared/atomic-write";
import { stateDir } from "./paths";
import {
  engineScopeSystemdArgs,
  stopUserScopeAndWait,
  systemdUserEnv,
  systemdUserScopesAvailable,
  userScopeActive,
} from "./systemd-scopes";
import { isCompiledBinary } from "../runner-host/exe";
import {
  EXIT_FILE,
  HOST_FILE,
  RELAY_INDEX_HEADER,
  RELAY_RETRY_HEADER,
  RELAY_SECRETS_ENV,
  SPEC_FILE,
  type ScriptHostExit,
  type ScriptHostSpec,
} from "../script-host/main";

export const DEFAULT_SCRIPT_MINUTES = 60;
export const MAX_SCRIPT_MINUTES = 24 * 60;
const MAX_TITLE_CHARS = 120;
export const MAX_SCRIPT_COMMAND_CHARS = 8_000;
const LOG_TAIL_BYTES = 4096;
const WAKE_TAIL_BYTES = 1500;
/** Ended runs stay listed this long. */
const ENDED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const POLL_MS = 3_000;
/** How often a run's host is checked for life, beyond its exit file. */
const LIVENESS_EVERY_MS = 30_000;
/** A run still alive this long past its deadline is stopped by the server. */
const DEADLINE_GRACE_MS = 60_000;
const BROADCAST_THROTTLE_MS = 2_000;
const PERSIST_THROTTLE_MS = 30_000;
const MAX_UNIX_SOCKET_PATH = 104;

export type ScriptRunState = ScriptRunWire["state"];

/** Why a run is being ended from the server side. */
export type ScriptStopReason = "stopped" | "revoked" | "timed_out";

/** A borrowed credential's leg of a run. Owned by keychain-runs.ts; this
 *  module only counts nothing and persists it. */
export interface ScriptRelayInfo {
  /** Environment variables the script reads this relay's URL from. */
  env: string[];
  service: string;
  host: string;
  grantId: string;
  calls: number;
  denied: number;
  maxCalls: number;
}

interface StoredRelay extends ScriptRelayInfo {
  /** SHA-256 of the URL secret, base64url. */
  secretHash: string;
}

export interface ScriptRunRecord {
  id: string;
  sessionId: string;
  /** "script" for start_script, "credential" for run_with_credential. */
  kind: "script" | "credential";
  title: string;
  command: string;
  cwd: string;
  logPath: string;
  state: ScriptRunState;
  startedAt: string;
  deadline: string;
  startedBy?: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  /** Wake the session when the run ends. */
  notify: boolean;
  /** The wake was delivered (or was not wanted). */
  notified?: boolean;
  /** Set when someone asked the run to stop; it ends with this state. */
  stopping?: ScriptStopReason;
  pid?: number;
  scopeUnit?: string;
  relays?: StoredRelay[];
}

/** What tools, routes and the UI see (the script_runs wire shape). */
export type ScriptRunSummary = ScriptRunWire;

/** Handles one relayed request of a run. Registered by keychain-runs.ts. */
export type ScriptRelayHandler = (
  run: ScriptRunRecord,
  relay: ScriptRelayInfo,
  path: string,
  req: Request,
) => Promise<Response>;

/** Called once when a run reaches a final state. */
export type ScriptRunEndListener = (run: ScriptRunRecord) => Promise<void>;

export interface ScriptRunDeps {
  /** Launches the host. Test seam; the real one uses a user scope. */
  launch?: (input: {
    argv: string[];
    env: Record<string, string>;
    unit: string;
  }) => Promise<{ pid: number; scopeUnit?: string; exited: Promise<unknown> }>;
  /** Whether a host is alive. Test seam. */
  alive?: (run: ScriptRunRecord) => Promise<boolean>;
  /** Ends a host's whole tree. Test seam. */
  kill?: (run: ScriptRunRecord) => Promise<void>;
  /** Wakes the session. Test seam. */
  deliver?: (run: ScriptRunRecord, message: string) => Promise<void>;
  /** Tells viewers. Test seam. */
  broadcast?: (sessionId: string, runs: ScriptRunSummary[]) => void;
  /** Where the registry and run dirs live. Test seam. */
  root?: string;
  /** The host's argv before the run dir. Test seam. */
  hostArgv?: string[];
  /** How often moving call counts are saved. Test seam. */
  persistEveryMs?: number;
}

interface Live {
  relayServer?: ReturnType<typeof Bun.serve>;
  lastLiveness: number;
  ending?: Promise<void>;
}

const g = globalThis as any;
const state: {
  runs: Map<string, ScriptRunRecord>;
  live: Map<string, Live>;
  loaded: boolean;
  loading?: Promise<void>;
  poll?: ReturnType<typeof setInterval>;
  deps: ScriptRunDeps;
  relayHandler?: ScriptRelayHandler;
  endListeners: Set<ScriptRunEndListener>;
  dirtyPersist: boolean;
  persistTimer?: ReturnType<typeof setTimeout>;
  writes: Promise<void>;
  revision: number;
  broadcastTimers: Map<string, ReturnType<typeof setTimeout>>;
} = (g.__scriptRuns ??= {
  runs: new Map(),
  live: new Map(),
  loaded: false,
  deps: {},
  endListeners: new Set(),
  dirtyPersist: false,
  writes: Promise.resolve(),
  revision: 0,
  broadcastTimers: new Map(),
});

function root(): string {
  return state.deps.root ?? stateDir("script-runs");
}
function registryPath(): string {
  return join(root(), "registry.json");
}
function runDir(id: string): string {
  return join(root(), id);
}
/** Beside the run dirs, under a short name: a unix socket path is limited
 *  to about 104 bytes. */
function relaySocketPath(id: string): string {
  return join(root(), `${id.slice(3, 15)}.sock`);
}

export function setScriptRelayHandler(handler: ScriptRelayHandler): void {
  state.relayHandler = handler;
}

export function onScriptRunEnded(listener: ScriptRunEndListener): void {
  state.endListeners.add(listener);
}

/** Replace the process-wide seams. Tests only. */
export function __resetScriptRunsForTest(deps: ScriptRunDeps = {}): void {
  for (const live of state.live.values()) live.relayServer?.stop(true);
  if (state.poll) clearInterval(state.poll);
  if (state.persistTimer) clearTimeout(state.persistTimer);
  for (const timer of state.broadcastTimers.values()) clearTimeout(timer);
  state.runs = new Map();
  state.live = new Map();
  state.loaded = false;
  state.loading = undefined;
  state.poll = undefined;
  state.persistTimer = undefined;
  state.deps = deps;
  state.relayHandler = undefined;
  state.endListeners = new Set();
  state.dirtyPersist = false;
  state.writes = Promise.resolve();
  state.broadcastTimers = new Map();
  g.__scriptRunsStarted = false;
}

// ── Registry ───────────────────────────────────────────────────────────────

async function ensureLoaded(): Promise<void> {
  if (state.loaded) return;
  state.loading ??= (async () => {
    let raw: string | null = null;
    try {
      raw = await readFile(registryPath(), "utf-8");
    } catch (error: any) {
      if (error?.code !== "ENOENT")
        console.error("[scripts] failed to read the registry:", error);
    }
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { runs?: ScriptRunRecord[] };
        const cutoff = Date.now() - ENDED_RETENTION_MS;
        for (const run of parsed.runs ?? []) {
          if (run.endedAt && Date.parse(run.endedAt) < cutoff) continue;
          state.runs.set(run.id, run);
        }
      } catch (error) {
        console.error("[scripts] failed to parse the registry:", error);
      }
    }
    state.loaded = true;
  })();
  await state.loading;
}

/** Write the registry now. Writes are serialized; one that raced a newer
 *  change writes again, so the file always ends on the latest state. */
function persist(): Promise<void> {
  state.revision++;
  state.dirtyPersist = false;
  if (state.persistTimer) {
    clearTimeout(state.persistTimer);
    state.persistTimer = undefined;
  }
  const write = state.writes.then(async () => {
    let written: number;
    do {
      written = state.revision;
      await mkdir(root(), { recursive: true, mode: 0o700 });
      await writeJsonAtomicAsync(
        registryPath(),
        { runs: [...state.runs.values()] },
        false,
        0o600,
      );
    } while (written !== state.revision);
  });
  state.writes = write.catch((error) =>
    console.error("[scripts] failed to write the registry:", error),
  );
  return write;
}

/** Call counts change per request; save them at most every 30 seconds. */
function persistSoon(): void {
  state.dirtyPersist = true;
  if (state.persistTimer) return;
  state.persistTimer = setTimeout(() => {
    state.persistTimer = undefined;
    if (state.dirtyPersist) void persist().catch(() => {});
  }, state.deps.persistEveryMs ?? PERSIST_THROTTLE_MS);
  state.persistTimer.unref?.();
}

/** Save call counts that moved since the last write. For a graceful
 *  shutdown, so a restart loses none of them. */
export async function flushScriptRuns(): Promise<void> {
  if (state.dirtyPersist) await persist().catch(() => {});
}

// ── Views ──────────────────────────────────────────────────────────────────

export function summarizeScriptRun(run: ScriptRunRecord): ScriptRunSummary {
  const {
    relays,
    pid: _pid,
    scopeUnit: _scopeUnit,
    notified: _notified,
    stopping,
    ...rest
  } = run;
  return {
    ...rest,
    ...(stopping && run.state === "running" ? { stopping: true } : {}),
    ...(relays?.length
      ? {
          credentials: relays.map(({ secretHash: _hash, ...relay }) => ({
            ...relay,
          })),
        }
      : {}),
  };
}

export async function listScriptRuns(
  sessionId: string,
): Promise<ScriptRunSummary[]> {
  await ensureLoaded();
  return sessionRuns(sessionId);
}

function sessionRuns(sessionId: string): ScriptRunSummary[] {
  return [...state.runs.values()]
    .filter((run) => run.sessionId === sessionId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(summarizeScriptRun);
}

export async function getScriptRun(
  id: string,
  sessionId: string,
): Promise<ScriptRunRecord | undefined> {
  await ensureLoaded();
  const run = state.runs.get(id);
  return run && run.sessionId === sessionId ? run : undefined;
}

/** Any session's run, for server-side bookkeeping (a revoked grant). */
export async function scriptRunRecord(
  id: string,
): Promise<ScriptRunRecord | undefined> {
  await ensureLoaded();
  return state.runs.get(id);
}

/** The ids of every run that is still going. */
export async function runningScriptRunIds(): Promise<string[]> {
  await ensureLoaded();
  return [...state.runs.values()]
    .filter((run) => run.state === "running")
    .map((run) => run.id);
}

export async function scriptRunStatus(
  id: string,
  sessionId: string,
): Promise<(ScriptRunSummary & { outputTail: string }) | undefined> {
  const run = await getScriptRun(id, sessionId);
  if (!run) return undefined;
  return {
    ...summarizeScriptRun(run),
    outputTail: await readLogTail(run.logPath, LOG_TAIL_BYTES),
  };
}

/** Tell the session's viewers, at most every two seconds per session. */
function announce(sessionId: string, immediate = false): void {
  const send = () => {
    state.broadcastTimers.delete(sessionId);
    const broadcast = state.deps.broadcast ?? defaultBroadcast;
    try {
      broadcast(sessionId, sessionRuns(sessionId));
    } catch (error) {
      console.error("[scripts] broadcast failed:", error);
    }
  };
  if (immediate) {
    const pending = state.broadcastTimers.get(sessionId);
    if (pending) clearTimeout(pending);
    send();
    return;
  }
  if (state.broadcastTimers.has(sessionId)) return;
  const timer = setTimeout(send, BROADCAST_THROTTLE_MS);
  timer.unref?.();
  state.broadcastTimers.set(sessionId, timer);
}

function defaultBroadcast(sessionId: string, runs: ScriptRunSummary[]): void {
  void import("./ws-hub").then(({ broadcastToSession }) =>
    broadcastToSession(sessionId, { type: "script_runs", sessionId, runs }),
  );
}

// ── Starting ───────────────────────────────────────────────────────────────

export interface StartScriptInput {
  sessionId: string;
  command: string;
  /** Existing directory the command runs in. */
  cwd: string;
  /** Where the log goes. The file is named after the run. */
  logDir: string;
  /** The whole environment of the command (relay URLs are added). */
  env: Record<string, string>;
  title?: string;
  kind?: ScriptRunRecord["kind"];
  timeoutMinutes?: number;
  notify?: boolean;
  startedBy?: string;
  /** Run id, when the caller already claimed something under it. */
  id?: string;
  relays?: ScriptRelayInfo[];
  /** Checked right before the host is launched: a reason not to start
   *  after all (e.g. a grant revoked while the run was being prepared). */
  shouldStart?: () => string | undefined;
}

export function newScriptRunId(): string {
  return `sr-${crypto.randomUUID()}`;
}

export async function startScriptRun(
  input: StartScriptInput,
): Promise<{ run: ScriptRunSummary } | { error: string }> {
  await ensureLoaded();
  const minutes = input.timeoutMinutes ?? DEFAULT_SCRIPT_MINUTES;
  if (!(minutes > 0 && minutes <= MAX_SCRIPT_MINUTES))
    return {
      error: `timeoutMinutes must be more than 0 and at most ${MAX_SCRIPT_MINUTES}`,
    };
  if (!input.command.trim()) return { error: "the command is empty" };
  if (input.command.length > MAX_SCRIPT_COMMAND_CHARS)
    return {
      error: `the command is longer than ${MAX_SCRIPT_COMMAND_CHARS} characters; put it in a script file`,
    };
  const dir = await stat(input.cwd).catch(() => null);
  if (!dir?.isDirectory())
    return { error: `cwd ${input.cwd} is not a directory` };

  const id = input.id ?? newScriptRunId();
  const dirPath = runDir(id);
  const socket = relaySocketPath(id);
  if (input.relays?.length && socket.length > MAX_UNIX_SOCKET_PATH)
    return {
      error: `the state directory path is too long for a relay socket (${socket})`,
    };
  const secrets = (input.relays ?? []).map(() =>
    randomBytes(32).toString("base64url"),
  );
  const startedAt = Date.now();
  const deadline = startedAt + minutes * 60_000;
  const run: ScriptRunRecord = {
    id,
    sessionId: input.sessionId,
    kind: input.kind ?? "script",
    title: titleFor(input.title, input.command),
    command: input.command,
    cwd: input.cwd,
    logPath: join(input.logDir, `${id}.log`),
    state: "running",
    startedAt: new Date(startedAt).toISOString(),
    deadline: new Date(deadline).toISOString(),
    notify: input.notify ?? true,
    ...(input.startedBy ? { startedBy: input.startedBy } : {}),
    ...(input.relays?.length
      ? {
          relays: input.relays.map((relay, index) => ({
            ...relay,
            secretHash: hashSecret(secrets[index]!),
          })),
        }
      : {}),
  };

  try {
    await mkdir(dirPath, { recursive: true, mode: 0o700 });
    await mkdir(input.logDir, { recursive: true });
    // Touch the log so a status call right after start finds it.
    await (await open(run.logPath, "a", 0o600)).close();
    const spec: ScriptHostSpec = {
      id,
      command: run.command,
      cwd: run.cwd,
      logPath: run.logPath,
      deadline,
      ...(run.relays
        ? {
            relaySocket: socket,
            relays: run.relays.map((r) => ({ env: r.env })),
          }
        : {}),
    };
    await writeJsonAtomicAsync(join(dirPath, SPEC_FILE), spec, true, 0o600);
  } catch (error) {
    return { error: `couldn't prepare the run: ${errorText(error)}` };
  }

  // The relay must answer before the script makes its first call.
  state.runs.set(id, run);
  const live: Live = { lastLiveness: Date.now() };
  state.live.set(id, live);
  if (run.relays?.length) {
    const served = await serveRelay(run, live);
    if (served) {
      state.runs.delete(id);
      state.live.delete(id);
      return { error: served };
    }
  }

  const refusal = input.shouldStart?.();
  if (refusal) {
    live.relayServer?.stop(true);
    state.runs.delete(id);
    state.live.delete(id);
    return { error: refusal };
  }
  const env: Record<string, string> = { ...input.env };
  if (secrets.length) env[RELAY_SECRETS_ENV] = secrets.join(",");
  const unit = `opensession-script-${id.slice(3, 15)}`;
  try {
    const launched = await (state.deps.launch ?? launchHost)({
      argv: [...(state.deps.hostArgv ?? hostArgv()), dirPath],
      env,
      unit,
    });
    run.pid = launched.pid;
    if (launched.scopeUnit) run.scopeUnit = launched.scopeUnit;
    // A host started by this process reports its own exit at once; after a
    // restart the poll finds the exit file instead.
    void launched.exited.then(() => checkRun(id).catch(() => {}));
  } catch (error) {
    run.state = "failed";
    run.error = `couldn't start: ${errorText(error)}`;
    run.endedAt = new Date().toISOString();
    // The caller hears this from the return value; no wake-up.
    run.notified = true;
    live.relayServer?.stop(true);
    state.live.delete(id);
    await persist().catch(() => {});
    announce(run.sessionId, true);
    return { error: run.error };
  }
  await persist().catch(() => {});
  ensurePolling();
  announce(run.sessionId, true);
  return { run: summarizeScriptRun(run) };
}

function titleFor(title: string | undefined, command: string): string {
  const raw = (title?.trim() || command.trim().split("\n")[0] || "Script")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .trim();
  return raw.length > MAX_TITLE_CHARS
    ? `${raw.slice(0, MAX_TITLE_CHARS - 1)}…`
    : raw;
}

function hostArgv(): string[] {
  if (isCompiledBinary()) return [process.execPath, "script-host"];
  return [
    process.execPath,
    "run",
    join(import.meta.dir, "../script-host/main.ts"),
  ];
}

/** Start the host in its own user scope when systemd is there, so stopping
 *  the server's unit leaves it running. Otherwise in its own session. */
async function launchHost(input: {
  argv: string[];
  env: Record<string, string>;
  unit: string;
}): Promise<{ pid: number; scopeUnit?: string; exited: Promise<unknown> }> {
  const scoped = systemdUserScopesAvailable();
  const cmd = scoped
    ? [
        "systemd-run",
        "--user",
        "--scope",
        "--collect",
        "--quiet",
        `--unit=${input.unit}`,
        ...engineScopeSystemdArgs(),
        // The host forwards SIGTERM and waits for the command's own grace.
        "--property=TimeoutStopSec=20",
        "--",
        ...input.argv,
      ]
    : input.argv;
  const env = scoped ? { ...input.env, ...systemdUserEnv() } : input.env;
  const proc = Bun.spawn({
    cmd,
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    // Not in the server's process group: a signal to the server must not
    // reach the run.
    detached: true,
  });
  proc.unref();
  return {
    pid: proc.pid,
    ...(scoped ? { scopeUnit: input.unit } : {}),
    exited: proc.exited,
  };
}

// ── Relays ─────────────────────────────────────────────────────────────────

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

/** Listen on the run's relay socket. Returns an error message on failure. */
async function serveRelay(
  run: ScriptRunRecord,
  live: Live,
): Promise<string | undefined> {
  const socket = relaySocketPath(run.id);
  try {
    await rm(socket, { force: true });
    live.relayServer = Bun.serve({
      unix: socket,
      fetch: (req) => relay(run.id, req),
    });
    return undefined;
  } catch (error) {
    return `couldn't open the run's relay: ${errorText(error)}`;
  }
}

async function relay(id: string, req: Request): Promise<Response> {
  const run = state.runs.get(id);
  if (!run) return Response.json({ error: "unknown run" }, { status: 410 });
  const index = Number(req.headers.get(RELAY_INDEX_HEADER));
  const leg = run.relays?.[index];
  const url = new URL(req.url);
  const slash = url.pathname.indexOf("/", 1);
  const presented = url.pathname.slice(1, slash === -1 ? undefined : slash);
  if (!leg || !secretMatches(presented, leg.secretHash))
    return Response.json({ error: "not found" }, { status: 404 });
  if (run.state !== "running" || run.stopping)
    return Response.json(
      { error: `this run ${run.stopping ?? run.state}` },
      { status: 410 },
    );
  const handler = state.relayHandler;
  if (!handler)
    // Starting up: the handler registers right after recovery. The host
    // waits and asks again.
    return Response.json(
      { error: "starting up" },
      { status: 503, headers: { [RELAY_RETRY_HEADER]: "1" } },
    );
  const rest = slash === -1 ? "/" : url.pathname.slice(slash);
  const before = { calls: leg.calls, denied: leg.denied };
  try {
    return await handler(run, leg, rest, req);
  } finally {
    if (leg.calls !== before.calls || leg.denied !== before.denied) {
      persistSoon();
      announce(run.sessionId);
    }
  }
}

function secretMatches(presented: string, expectedHash: string): boolean {
  const a = Buffer.from(hashSecret(presented));
  const b = Buffer.from(expectedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Watching and ending ────────────────────────────────────────────────────

function ensurePolling(): void {
  if (state.poll) return;
  state.poll = setInterval(() => void pollRuns(), POLL_MS);
  state.poll.unref?.();
}

async function pollRuns(): Promise<void> {
  let active = false;
  for (const run of state.runs.values()) {
    if (run.state === "running") {
      active = true;
      await checkRun(run.id).catch((error) =>
        console.error(`[scripts] check of ${run.id} failed:`, error),
      );
    } else if (run.notify && !run.notified) {
      active = true;
      await notifyEnded(run);
    }
  }
  if (!active && state.poll) {
    clearInterval(state.poll);
    state.poll = undefined;
  }
}

async function readExit(id: string): Promise<ScriptHostExit | null> {
  try {
    return JSON.parse(
      await readFile(join(runDir(id), EXIT_FILE), "utf-8"),
    ) as ScriptHostExit;
  } catch {
    return null;
  }
}

/** Settle the run if its host recorded an end or is gone. */
async function checkRun(id: string): Promise<void> {
  const run = state.runs.get(id);
  if (!run || run.state !== "running") return;
  const exit = await readExit(id);
  if (exit) return settle(run, exit);
  const live = state.live.get(id) ?? { lastLiveness: 0 };
  state.live.set(id, live);
  const now = Date.now();
  if (now > Date.parse(run.deadline) + DEADLINE_GRACE_MS && !run.stopping) {
    // The host enforces the deadline; this is the backstop.
    void stopRun(run, "timed_out");
    return;
  }
  // While stopping, check every poll: a host killed before it could record
  // its end must not look alive for another half minute.
  if (!run.stopping && now - live.lastLiveness < LIVENESS_EVERY_MS) return;
  live.lastLiveness = now;
  if (await (state.deps.alive ?? hostAlive)(run)) return;
  // The exit file may have landed between the two reads.
  const late = await readExit(id);
  if (late) return settle(run, late);
  return settle(run, null);
}

async function hostAlive(run: ScriptRunRecord): Promise<boolean> {
  if (run.scopeUnit && (await userScopeActive(run.scopeUnit))) return true;
  const pid = await readHostPid(run);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A recycled pid belongs to something else.
  const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf-8").catch(
    () => null,
  );
  return cmdline === null || cmdline.includes(run.id);
}

async function readHostPid(run: ScriptRunRecord): Promise<number | undefined> {
  try {
    const host = JSON.parse(
      await readFile(join(runDir(run.id), HOST_FILE), "utf-8"),
    ) as { pid?: number };
    return host.pid ?? run.pid;
  } catch {
    return run.pid;
  }
}

async function settle(
  run: ScriptRunRecord,
  exit: ScriptHostExit | null,
): Promise<void> {
  const live = state.live.get(run.id);
  if (live?.ending) return live.ending;
  const ending = (async () => {
    if (run.state !== "running") return;
    if (!exit) {
      run.state = run.stopping ?? "lost";
      if (!run.stopping)
        run.error = "the script's host went away without recording an exit";
    } else {
      run.exitCode = exit.code;
      run.signal = exit.signal;
      if (exit.error) run.error = exit.error;
      run.state =
        run.stopping ??
        (exit.reason === "stopped"
          ? "stopped"
          : exit.reason === "timed_out"
            ? "timed_out"
            : exit.reason === "failed"
              ? "failed"
              : "exited");
    }
    run.endedAt = exit?.endedAt ?? new Date().toISOString();
    live?.relayServer?.stop(true);
    if (run.relays?.length)
      await rm(relaySocketPath(run.id), { force: true }).catch(() => {});
    for (const listener of state.endListeners) {
      try {
        await listener(run);
      } catch (error) {
        console.error("[scripts] end listener failed:", error);
      }
    }
    if (!run.notify) run.notified = true;
    await persist().catch(() => {});
    announce(run.sessionId, true);
    await notifyEnded(run);
  })().finally(() => state.live.delete(run.id));
  if (live) live.ending = ending;
  return ending;
}

export async function stopScriptRun(
  id: string,
  sessionId: string,
  reason: ScriptStopReason = "stopped",
): Promise<{ run: ScriptRunSummary } | { error: string }> {
  const run = await getScriptRun(id, sessionId);
  if (!run) return { error: "no script run with that id in this session" };
  if (run.state !== "running") return { error: `the run already ${run.state}` };
  await stopRun(run, reason);
  return { run: summarizeScriptRun(run) };
}

/** End a run from anywhere in the server, e.g. when its grant is revoked. */
export async function endScriptRun(
  id: string,
  reason: ScriptStopReason,
): Promise<void> {
  await ensureLoaded();
  const run = state.runs.get(id);
  if (run?.state === "running") await stopRun(run, reason);
}

async function stopRun(
  run: ScriptRunRecord,
  reason: ScriptStopReason,
): Promise<void> {
  if (run.stopping) return;
  run.stopping = reason;
  await persist().catch(() => {});
  announce(run.sessionId, true);
  await (state.deps.kill ?? killHost)(run);
  ensurePolling();
  // A stopped host normally writes its exit file within the grace period.
  await checkRun(run.id).catch(() => {});
}

async function killHost(run: ScriptRunRecord): Promise<void> {
  if (run.scopeUnit && (await userScopeActive(run.scopeUnit))) {
    // Not awaited to the end: systemd waits for the host's own grace.
    void stopUserScopeAndWait(run.scopeUnit);
    return;
  }
  const pid = await readHostPid(run);
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

// ── Waking the session ─────────────────────────────────────────────────────

const ENDED_WORDS: Record<ScriptRunState, string> = {
  running: "is running",
  exited: "exited",
  failed: "failed to run",
  timed_out: "hit its time limit and was stopped",
  stopped: "was stopped",
  revoked: "was stopped because its credential grant was revoked",
  lost: "was lost",
};

export function scriptEndedMessage(run: ScriptRunRecord, tail: string): string {
  const took = run.endedAt
    ? formatDuration(Date.parse(run.endedAt) - Date.parse(run.startedAt))
    : "";
  const code =
    run.state === "exited"
      ? ` with code ${run.exitCode ?? "?"}`
      : run.signal
        ? ` (${run.signal})`
        : "";
  const counts = run.relays?.length
    ? `\nCredential calls: ${run.relays
        .map(
          (r) =>
            `${r.service} ${r.calls}/${r.maxCalls}${r.denied ? `, ${r.denied} refused` : ""}`,
        )
        .join("; ")}.`
    : "";
  const error = run.error ? `\nError: ${run.error}` : "";
  return (
    `A script this session started ended. This is system context, not a new user message.\n\n` +
    `Script "${run.title}" (${run.id}) ${ENDED_WORDS[run.state]}${code}` +
    `${took ? ` after ${took}` : ""}.${counts}${error}\n` +
    `Full log: ${run.logPath}\n` +
    (tail.trim() ? `Last output:\n${tail.trimEnd()}` : "It printed nothing.")
  );
}

async function notifyEnded(run: ScriptRunRecord): Promise<void> {
  if (!run.notify || run.notified) return;
  try {
    const tail = await readLogTail(run.logPath, WAKE_TAIL_BYTES);
    await (state.deps.deliver ?? deliverWake)(
      run,
      scriptEndedMessage(run, tail),
    );
    run.notified = true;
    await persist().catch(() => {});
  } catch (error) {
    // The poll retries; the delivery id keeps it exactly-once.
    console.error(`[scripts] couldn't wake ${run.sessionId}:`, error);
    ensurePolling();
  }
}

async function deliverWake(
  run: ScriptRunRecord,
  message: string,
): Promise<void> {
  const [{ getSessionControl }, { wrapContext }] = await Promise.all([
    import("./session-control"),
    import("./prompt-context"),
  ]);
  const control = getSessionControl();
  if (!control.getSession(run.sessionId)) return;
  // "background-wait": model-only context that starts its own turn, like a
  // durable agent wait's wake-up.
  const result = await control.deliverToSession(
    run.sessionId,
    wrapContext(message, "background-wait"),
    undefined,
    { deliveryId: `script-run:${run.id}:ended` },
  );
  if (result.status === "error") throw new Error(result.message);
}

// ── Boot ───────────────────────────────────────────────────────────────────

/**
 * Reattach to every run recorded as running. Idempotent; called once at
 * boot. Runs that ended while the server was down are settled, and their
 * sessions woken.
 */
export async function startScriptRuns(deps?: ScriptRunDeps): Promise<void> {
  if (deps) state.deps = { ...state.deps, ...deps };
  if (g.__scriptRunsStarted) return;
  g.__scriptRunsStarted = true;
  await ensureLoaded();
  let reattached = 0;
  for (const run of state.runs.values()) {
    if (run.state !== "running") continue;
    if (state.live.has(run.id)) continue;
    const live: Live = { lastLiveness: 0 };
    state.live.set(run.id, live);
    if (run.relays?.length) {
      const error = await serveRelay(run, live);
      if (error) console.error(`[scripts] ${run.id}: ${error}`);
    }
    reattached++;
    await checkRun(run.id).catch((error) =>
      console.error(`[scripts] check of ${run.id} failed:`, error),
    );
  }
  if (reattached) console.log(`[scripts] reattached ${reattached} run(s)`);
  ensurePolling();
}

// ── Helpers ────────────────────────────────────────────────────────────────

export async function readLogTail(
  path: string,
  bytes: number,
): Promise<string> {
  const file = await open(path, "r").catch(() => null);
  if (!file) return "";
  try {
    const { size } = await file.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    // Drop a partial first line unless the whole log fit.
    const text = buffer.toString("utf-8");
    if (length < size) {
      const newline = text.indexOf("\n");
      if (newline !== -1 && newline < text.length - 1)
        return text.slice(newline + 1);
    }
    return text;
  } finally {
    await file.close();
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wait until a run has ended. Tests only. */
export async function __waitForScriptRunForTest(
  id: string,
  timeoutMs: number,
): Promise<ScriptRunRecord | undefined> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const run = state.runs.get(id);
    if (!run) return undefined;
    if (run.state !== "running" || Date.now() > until) {
      await state.live.get(id)?.ending;
      return run;
    }
    await checkRun(id).catch(() => {});
    await Bun.sleep(25);
  }
}

/** Forget in-memory state so the next call reloads from disk, as a fresh
 *  server would. Tests only. */
export function __simulateRestartForTest(): void {
  for (const live of state.live.values()) live.relayServer?.stop(true);
  if (state.poll) clearInterval(state.poll);
  state.runs = new Map();
  state.live = new Map();
  state.loaded = false;
  state.loading = undefined;
  state.poll = undefined;
  g.__scriptRunsStarted = false;
}

/** Targeted metadata reads for already known live scripts, never discovery. */
export async function scriptResourceRoots(): Promise<
  import("../shared/agent-resources").ResourceRoot[]
> {
  const roots = await Promise.all(
    [...state.runs.values()]
      .filter((run) => run.state === "running")
      .map(async (run) => {
        try {
          const host = JSON.parse(
            await readFile(join(runDir(run.id), HOST_FILE), "utf8"),
          ) as { pid?: number; startTicks?: string; startedAt?: number };
          if (!host.pid || run.state !== "running") return null;
          return {
            pid: host.pid,
            sessionId: run.sessionId,
            runId: run.id,
            kind: "script" as const,
            start: host.startTicks,
            startedAt: host.startedAt ?? Date.parse(run.startedAt),
          };
        } catch {
          return null;
        }
      }),
  );
  return roots.filter(
    (root): root is NonNullable<typeof root> => root !== null,
  );
}
