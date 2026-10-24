/**
 * Bounded fresh-worktree setup commands.
 *
 * `.agents/setup`, `worktreeSetup`, `depsInstall` and the `bun install`
 * fallback each run in their own transient setup scope. A command that hangs
 * used to run forever and outlive the session that started it, so:
 *
 *  - every command has a per-repo timeout (`setupTimeoutMinutes`, default 15)
 *    that kills its whole process tree, and systemd's RuntimeMaxSec backs the
 *    timer up after a gateway restart;
 *  - the scope name carries a hash of the worktree, so archiving or deleting
 *    a session stops the setup still running in its checkout;
 *  - the lifecycle reaper stops setup scopes whose owner is archived, or
 *    missing for longer than any setup may run.
 *
 * No import-time effects; all subprocess and filesystem work is async.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readlink, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { configuredRepos, type Repo } from "./config";
import { stopUserScopeAndWait, systemdUserEnv } from "./systemd-scopes";
import type { UnifiedSession } from "./types";
import { workloadArgv, workloadScopingActive } from "./workload-scope";

export const DEFAULT_SETUP_TIMEOUT_MINUTES = 15;
/** systemd's own deadline trails ours, so it only fires when our timer died
 *  with the gateway. */
const RUNTIME_MAX_SLACK_SEC = 60;
const STDERR_TAIL_CHARS = 2048;
const SETUP_UNIT_PREFIX = "opensession-setup-";
const UNIT_SUFFIX = /^(opensession-setup-[0-9a-f]{16})-[0-9a-f]{8}\.scope$/;

export function setupTimeoutMs(repo: Pick<Repo, "setupTimeoutMinutes">) {
  const minutes = repo.setupTimeoutMinutes;
  return (
    (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
      ? minutes
      : DEFAULT_SETUP_TIMEOUT_MINUTES) * 60_000
  );
}

async function canonicalDir(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch {
    return resolve(dir);
  }
}

/** `opensession-setup-<hash>`: shared by every setup scope of one worktree. */
export function setupScopePrefix(canonicalWorktreeDir: string): string {
  const hash = createHash("sha256")
    .update(canonicalWorktreeDir)
    .digest("hex")
    .slice(0, 16);
  return `${SETUP_UNIT_PREFIX}${hash}`;
}

export class SetupTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`setup timed out after ${Math.round(timeoutMs / 60_000)} min`);
    this.name = "SetupTimeoutError";
  }
}

export class SetupStoppedError extends Error {
  constructor() {
    super("setup was stopped because its session ended");
    this.name = "SetupStoppedError";
  }
}

/**
 * One fresh-worktree setup pipeline (warm-template seeding, then each setup
 * command). Registered synchronously before the pipeline's first await, so a
 * session archived while seeding still waits on a lock cancels the commands
 * that would have started afterwards.
 */
export type SetupPipeline = { dir: string; cancelled: boolean };
const pipelines = new Set<SetupPipeline>();

export function beginSetupPipeline(dir: string): SetupPipeline {
  const pipeline = { dir: resolve(dir), cancelled: false };
  pipelines.add(pipeline);
  return pipeline;
}

export function endSetupPipeline(pipeline: SetupPipeline): void {
  pipelines.delete(pipeline);
}

/** Throws SetupStoppedError once the pipeline's session has ended. */
export function assertSetupPipelineLive(pipeline?: SetupPipeline): void {
  if (pipeline?.cancelled) throw new SetupStoppedError();
}

async function cancelPipelines(
  matches: (canonical: string) => boolean,
): Promise<number> {
  let cancelled = 0;
  for (const pipeline of [...pipelines]) {
    if (pipeline.cancelled) continue;
    if (!matches(await canonicalDir(pipeline.dir))) continue;
    pipeline.cancelled = true;
    cancelled++;
  }
  return cancelled;
}

type RunningSetup = {
  dir: string;
  unit?: string;
  stopped: boolean;
  kill: () => Promise<void>;
};
// Setups this process started, so a stop also covers hosts without scopes.
const running = new Set<RunningSetup>();

/**
 * Run one setup command in `cwd`. Rejects on a non-zero exit, with
 * SetupTimeoutError once `timeoutMs` passes (after killing the whole scope or
 * process group), or with SetupStoppedError when the worktree's session ended.
 */
export async function runSetupCommand(
  argv: string[],
  options: { cwd: string; timeoutMs: number; pipeline?: SetupPipeline },
): Promise<void> {
  assertSetupPipelineLive(options.pipeline);
  const dir = await canonicalDir(options.cwd);
  // The session may have ended while the path resolved.
  assertSetupPipelineLive(options.pipeline);
  const unit = workloadScopingActive()
    ? `${setupScopePrefix(dir)}-${randomUUID().replace(/-/g, "").slice(0, 8)}`
    : undefined;
  const command = workloadArgv(argv, "setup", {
    unit,
    properties: [
      `RuntimeMaxSec=${Math.ceil(options.timeoutMs / 1000) + RUNTIME_MAX_SLACK_SEC}`,
    ],
  });
  // Its own process group, so a kill also reaches package-manager workers
  // on hosts without systemd scopes.
  const child = spawn(command[0]!, command.slice(1), {
    cwd: options.cwd,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
  });
  const entry: RunningSetup = {
    dir,
    unit,
    stopped: false,
    kill: async () => {
      if (unit) await stopUserScopeAndWait(unit);
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    },
  };
  running.add(entry);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void entry.kill();
  }, options.timeoutMs);
  try {
    // `exit`, not `close`: a stray grandchild holding stderr open must not
    // keep this await pending after the command itself is gone.
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode) => resolveExit(exitCode));
    });
    if (entry.stopped) throw new SetupStoppedError();
    if (timedOut) throw new SetupTimeoutError(options.timeoutMs);
    if (code !== 0)
      throw new Error(
        `${argv.join(" ")} exited with ${code ?? "a signal"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      );
  } finally {
    clearTimeout(timer);
    running.delete(entry);
    child.stderr?.destroy();
  }
}

async function stopUnits(pattern: string): Promise<void> {
  try {
    const proc = Bun.spawn({
      cmd: ["systemctl", "--user", "stop", pattern],
      env: systemdUserEnv(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  } catch {}
}

/** Stop every setup still running or pending in `dir`, including scopes a
 * previous gateway process started. Returns how many in-process setups
 * (running commands and pending pipelines) it stopped. */
export async function stopWorktreeSetup(
  dir: string,
  options: { scopes?: boolean } = {},
): Promise<number> {
  const canonical = await canonicalDir(dir);
  let stopped = await cancelPipelines((d) => d === canonical);
  for (const entry of [...running]) {
    if (entry.dir !== canonical) continue;
    entry.stopped = true;
    await entry.kill();
    stopped++;
  }
  if (options.scopes ?? workloadScopingActive())
    await stopUnits(`${setupScopePrefix(canonical)}-*.scope`);
  return stopped;
}

export type SetupOwnerSession = Pick<
  UnifiedSession,
  "id" | "worktreeDir" | "attachedRepos" | "aliasIds"
> &
  Partial<Pick<UnifiedSession, "archived" | "runner" | "sandbox">>;

function ownerDirs(session: SetupOwnerSession): string[] {
  return [
    session.worktreeDir,
    ...(session.attachedRepos ?? []).map((repo) => repo.dir),
  ].filter((dir): dir is string => typeof dir === "string" && dir !== "");
}

/**
 * Stop setup running in the checkouts of an archived or deleted session. A
 * checkout another live session still uses (the shared ask checkout) is left
 * alone. Callers treat a failure as retryable: the reaper sweeps again.
 */
export async function stopSessionWorktreeSetup(
  session: SetupOwnerSession,
  options: {
    sessions?: readonly SetupOwnerSession[];
    stop?: (dir: string) => Promise<unknown>;
  } = {},
): Promise<void> {
  // Remote runners and Sandboxes run their setup on another machine.
  if (session.runner || session.sandbox?.sandboxId) return;
  const dirs = ownerDirs(session);
  if (!dirs.length) return;
  const ownerIds = new Set([session.id, ...(session.aliasIds ?? [])]);
  const sessions =
    options.sessions ??
    (await (await import("./session-cache")).getCachedSessionsAsync());
  const otherLiveDirs = new Set(
    sessions
      .filter(
        (other) =>
          !other.archived &&
          !ownerIds.has(other.id) &&
          !other.aliasIds?.some((id) => ownerIds.has(id)),
      )
      .flatMap(ownerDirs),
  );
  const stop = options.stop ?? stopWorktreeSetup;
  for (const dir of new Set(dirs)) {
    if (otherLiveDirs.has(dir) || otherLiveDirs.has(await canonicalDir(dir)))
      continue;
    await stop(dir);
  }
}

/** Archive hook: resolve the session (aliases included), then stop its setup. */
export async function stopArchivedSessionWorktreeSetup(
  sessionId: string,
  options: {
    findSession?: (id: string) => Promise<SetupOwnerSession | undefined>;
  } = {},
): Promise<void> {
  const findSession =
    options.findSession ??
    (async (id: string) => {
      const { findSessionAsync, getCachedSessionsAsync } =
        await import("./session-cache");
      const merged = (await getCachedSessionsAsync()).find(
        (s) => s.id === id || s.aliasIds?.includes(id),
      );
      return merged ?? findSessionAsync(id);
    });
  const session = await findSession(sessionId);
  if (session) await stopSessionWorktreeSetup(session);
}

export type SetupScope = {
  unit: string;
  ageMs: number;
  /** cgroup of the scope, used to find the worktree of a legacy unit name. */
  controlGroup?: string;
};

/** Active setup scopes of this user, with their age. Empty without systemd. */
export async function listSetupScopes(): Promise<SetupScope[]> {
  let text: string;
  let uptimeMs: number;
  try {
    const proc = Bun.spawn({
      cmd: [
        "systemctl",
        "--user",
        "show",
        "--property=Id,ActiveState,ActiveEnterTimestampMonotonic,ControlGroup",
        `${SETUP_UNIT_PREFIX}*.scope`,
      ],
      env: systemdUserEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    uptimeMs =
      Number((await readFile("/proc/uptime", "utf8")).split(" ")[0]) * 1000;
  } catch {
    return [];
  }
  return parseSetupScopes(text, uptimeMs);
}

export function parseSetupScopes(text: string, uptimeMs: number): SetupScope[] {
  const scopes: SetupScope[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const props = new Map<string, string>();
    for (const line of block.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1));
    }
    const unit = props.get("Id");
    if (!unit?.startsWith(SETUP_UNIT_PREFIX)) continue;
    if (props.get("ActiveState") !== "active") continue;
    const enteredMs = Number(props.get("ActiveEnterTimestampMonotonic")) / 1000;
    scopes.push({
      unit,
      ageMs:
        Number.isFinite(enteredMs) && enteredMs > 0 ? uptimeMs - enteredMs : 0,
      controlGroup: props.get("ControlGroup") || undefined,
    });
  }
  return scopes;
}

/** The worktree a scope was started in: from its name, or, for scopes
 * started before names carried the worktree, its first process's cwd. */
async function scopeOwnerKey(scope: SetupScope): Promise<string | null> {
  const match = UNIT_SUFFIX.exec(scope.unit);
  if (match) return match[1]!;
  if (!scope.controlGroup) return null;
  try {
    const pid = (
      await readFile(`/sys/fs/cgroup${scope.controlGroup}/cgroup.procs`, "utf8")
    )
      .split("\n")
      .find((line) => line.trim());
    if (!pid) return null;
    return setupScopePrefix(await readlink(`/proc/${pid.trim()}/cwd`));
  } catch {
    return null;
  }
}

function maxConfiguredSetupTimeoutMs(): number {
  let max = setupTimeoutMs({});
  try {
    for (const repo of Object.values(configuredRepos()))
      max = Math.max(max, setupTimeoutMs(repo));
  } catch {}
  return max;
}

export type SetupReapResult = {
  stopped: Array<{ unit: string; reason: "archived" | "orphaned" }>;
};

/**
 * Lifecycle sweep: stop setup scopes whose worktree owners are all archived,
 * and ownerless ones once they are older than any setup may run (a fresh
 * checkout's session may not be listed yet, and warm templates have none).
 * Owners come from the catalog session list, never from actor databases.
 */
export async function reapSetupScopes(
  sessions: readonly SetupOwnerSession[],
  options: {
    list?: () => Promise<SetupScope[]>;
    stop?: (unit: string) => Promise<void>;
    maxAgeMs?: number;
  } = {},
): Promise<SetupReapResult> {
  const list =
    options.list ??
    (async () => (workloadScopingActive() ? listSetupScopes() : []));
  const owners = new Map<string, boolean[]>();
  for (const session of sessions)
    for (const dir of ownerDirs(session)) {
      const key = setupScopePrefix(await canonicalDir(dir));
      const flags = owners.get(key) ?? [];
      flags.push(session.archived === true);
      owners.set(key, flags);
    }
  // A pipeline still seeding has no scope yet; cancel it before it spawns.
  await cancelPipelines((dir) => {
    const flags = owners.get(setupScopePrefix(dir));
    return !!flags?.length && flags.every(Boolean);
  });
  const scopes = await list();
  if (!scopes.length) return { stopped: [] };
  const maxAgeMs = options.maxAgeMs ?? maxConfiguredSetupTimeoutMs();
  const stop =
    options.stop ??
    ((unit: string) => stopUserScopeAndWait(unit.replace(/\.scope$/, "")));
  const stopped: SetupReapResult["stopped"] = [];
  for (const scope of scopes) {
    const key = await scopeOwnerKey(scope);
    const flags = key ? owners.get(key) : undefined;
    const reason = flags?.length
      ? flags.every(Boolean)
        ? "archived"
        : null
      : scope.ageMs >= maxAgeMs
        ? "orphaned"
        : null;
    if (!reason) continue;
    const name = scope.unit.replace(/\.scope$/, "");
    for (const entry of running) if (entry.unit === name) entry.stopped = true;
    try {
      await stop(scope.unit);
      stopped.push({ unit: scope.unit, reason });
    } catch (error) {
      console.warn(`[worktree-setup] could not reap ${scope.unit}:`, error);
    }
  }
  return { stopped };
}

/**
 * Tell the sessions working in `dir` that setup timed out, as a system chip
 * in their transcripts. Best-effort: a checkout whose session is not listed
 * yet only gets the log line.
 */
export async function recordSetupTimeout(
  dir: string,
  timeoutMs: number,
  options: {
    sessions?: readonly SetupOwnerSession[];
    append?: (sessionId: string, text: string) => Promise<void>;
  } = {},
): Promise<string[]> {
  const keys = new Set([dir, await canonicalDir(dir)]);
  const sessions =
    options.sessions ??
    (await (await import("./session-cache")).getCachedSessionsAsync());
  const minutes = Math.round(timeoutMs / 60_000);
  const text = `Workspace setup timed out after ${minutes} min and was stopped. Dependencies may be missing, so install them before building.`;
  const append =
    options.append ??
    (async (sessionId: string, line: string) => {
      const m = await import("./transcript-persistence");
      await m.applyForwardedTranscript(sessionId, sessionId, [
        m.transcriptLineRunnerNotice(line),
      ]);
    });
  const notified: string[] = [];
  for (const session of sessions) {
    if (session.archived) continue;
    if (!ownerDirs(session).some((d) => keys.has(d))) continue;
    try {
      await append(session.id, text);
      notified.push(session.id);
    } catch (error) {
      console.warn(
        `[worktree-setup] could not record the timeout on ${session.id}:`,
        error,
      );
    }
  }
  return notified;
}
