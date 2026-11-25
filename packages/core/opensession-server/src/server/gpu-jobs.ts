/**
 * GPU jobs: run one command on a GPU machine for a session that has none.
 *
 * A session on this machine (or in a CPU Sandbox) keeps its workspace and
 * its agent where they are. When it needs a GPU (a repository's GPU test
 * suite, a GPU render), `run_gpu_job` (gpu-mcp.ts) checkpoints the session's
 * work, wakes or creates one of the session's GPU machines on Modal (keyed
 * `<session>--gpu`, then `<session>--gpu-2` and so on, like a Portal
 * Sandbox's `<session>--portals`), lands the checkpoint there, and starts
 * the command detached inside the machine. Each machine runs one job at a
 * time, so jobs started together run in parallel on separate machines, as
 * many as Modal has GPUs for (a start waits for capacity). The
 * job writes its log and exit code to files in the machine, so a deploy or a
 * crash of this server does not stop it: the registry here is persisted and
 * reattached at boot. When the job ends, the session is woken with how it
 * ended and the tail of its output, exactly once.
 *
 * Machines are kept between jobs so builds stay incremental: a new job goes
 * to a free machine that last ran on the same GPU, and a new machine is
 * created only when every existing one is busy. The idle timers
 * (sandbox/idle.ts) put each to sleep a few minutes after its last job, and
 * archiving or deleting the session sleeps or destroys them.
 *
 * A repository declares its GPU jobs in `.agents/gpu-jobs.json`:
 *
 *   { "jobs": { "render-engine-gpu-tests": {
 *       "description": "…", "command": "scripts/…sh", "gpu": "T4",
 *       "timeoutMinutes": 60 } } }
 *
 * A job may also carry (all opt-in, per call):
 *
 *  - `files`: host files written straight to the machine over the provider's
 *    API after the checkpoint lands, for what must never reach GitHub (an
 *    env file, a key). They are read from the session's worktree (gitignored
 *    files only, as anything else ships in the checkpoint anyway), its
 *    scratch directory or the repository's main checkout, and removed from
 *    the machine when the job ends. Only their machine paths are recorded.
 *  - `identity: "portal"`: the cloud identity a Portal Sandbox gets across
 *    its setup and Portal hooks, instead of an ordinary command's.
 *
 * Every job gets `$OPENSESSION_JOB_OUTPUT`, a directory copied to
 * `<session scratch>/gpu-jobs/<id>/` when it ends (capped), and
 * `execOnGpuJob` runs further commands on the machine while it runs.
 *
 * Cross-session state is this module's own registry file, loaded once; no
 * session files are scanned. All I/O is asynchronous.
 */
import {
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, sep } from "node:path";
import { stateDir } from "./paths";
import { writeJsonAtomicAsync } from "./shared/atomic-write";
import { hostSessionScratchDir } from "./session-scratch";
import type { SandboxCheckpointRecord, UnifiedSession } from "./types";
import type { CheckpointOutcome, LandOutcome } from "./sandbox/checkpoint";
import type { Sandbox } from "./sandbox/provider";
import {
  sandboxGpu,
  sandboxProviderUsability,
  type SandboxGpu,
} from "./sandbox/config";

export const GPU_MACHINE_SUFFIX = "--gpu";
export const GPU_JOB_PROVIDER = "modal" as const;
export const GPU_JOBS_FILE = ".agents/gpu-jobs.json";
export const DEFAULT_GPU_JOB_MINUTES = 60;
export const MAX_GPU_JOB_MINUTES = 6 * 60;
const POLL_MS = 15_000;
const WAKE_TAIL_BYTES = 3000;
const SAVED_LOG_BYTES = 512 * 1024;
const KEEP_ENDED_MS = 7 * 24 * 60 * 60_000;
const REMOTE_ROOT = "/tmp/opensession-gpu-jobs";
/** Host files one job may send, and their total size. */
export const MAX_GPU_JOB_FILES = 20;
export const MAX_GPU_JOB_FILE_BYTES = 16 * 1024 * 1024;
/** What comes back from `$OPENSESSION_JOB_OUTPUT` when a job ends. */
export const MAX_GPU_JOB_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_GPU_JOB_OUTPUT_FILES = 500;
/** What one gpu_exec call may fetch. */
const MAX_GPU_EXEC_FETCH_BYTES = 32 * 1024 * 1024;
const MAX_GPU_EXEC_FETCH_FILES = 20;
const COPY_CHUNK_MIB = 4;
export const DEFAULT_GPU_EXEC_SECONDS = 120;
export const MAX_GPU_EXEC_SECONDS = 600;
const EXEC_STDOUT_BYTES = 64 * 1024;
const EXEC_STDERR_BYTES = 16 * 1024;

const GPU_MACHINE_PATTERN = /--gpu(?:-\d+)?$/;

/** The provider session key of a session's GPU machine: `<session>--gpu`
 *  for the first, `<session>--gpu-<n>` for the ones parallel jobs added. */
export function gpuMachineSessionId(sessionId: string, slot = 1): string {
  return slot > 1
    ? `${sessionId}${GPU_MACHINE_SUFFIX}-${slot}`
    : `${sessionId}${GPU_MACHINE_SUFFIX}`;
}

/** Whether a provider Sandbox id or session key names a GPU job machine. */
export function isGpuJobMachine(sandboxId: string): boolean {
  return GPU_MACHINE_PATTERN.test(sandboxId);
}

/** The session a GPU job machine belongs to (`md-<session>--gpu[-n]`). */
export function gpuMachineOwner(sandboxId: string): string | null {
  const match = GPU_MACHINE_PATTERN.exec(sandboxId);
  if (!match) return null;
  const base = sandboxId.slice(0, match.index);
  return base.startsWith("md-") ? base.slice(3) : base;
}

// ── Repository declarations ──────────────────────────────────────────────

/** `portal`: the job's commands get the cloud identity a Portal Sandbox
 *  gets (the audiences granted to its setup and Portal hooks). */
export type GpuJobIdentity = "portal";

export interface RepoGpuJob {
  description?: string;
  command: string;
  gpu: SandboxGpu;
  timeoutMinutes: number;
  identity?: GpuJobIdentity;
}

/** Parse `.agents/gpu-jobs.json`; malformed entries are dropped. */
export function parseRepoGpuJobs(text: string): Record<string, RepoGpuJob> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  const jobs = (raw as { jobs?: unknown })?.jobs;
  if (!jobs || typeof jobs !== "object") return {};
  const out: Record<string, RepoGpuJob> = {};
  for (const [name, value] of Object.entries(jobs as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name)) continue;
    const entry = value as Record<string, unknown> | null;
    const command =
      typeof entry?.command === "string" ? entry.command.trim() : "";
    if (!command) continue;
    const minutes = Number(entry?.timeoutMinutes);
    out[name] = {
      command,
      gpu: sandboxGpu(entry?.gpu) ?? "T4",
      timeoutMinutes:
        Number.isFinite(minutes) && minutes > 0
          ? Math.min(minutes, MAX_GPU_JOB_MINUTES)
          : DEFAULT_GPU_JOB_MINUTES,
      ...(typeof entry?.description === "string"
        ? { description: entry.description.slice(0, 400) }
        : {}),
      ...(entry?.identity === "portal" ? { identity: "portal" as const } : {}),
    };
  }
  return out;
}

/** The GPU jobs the session's workspace declares (read through its
 *  workspace, wherever that is). */
export async function sessionRepoGpuJobs(
  session: Pick<
    UnifiedSession,
    "id" | "worktreeDir" | "sandbox" | "runner" | "repo"
  >,
): Promise<Record<string, RepoGpuJob>> {
  if (!session.worktreeDir) return {};
  if (!session.sandbox?.provider && !session.runner) {
    const text = await readFile(
      join(session.worktreeDir, GPU_JOBS_FILE),
      "utf8",
    ).catch(() => "");
    return text ? parseRepoGpuJobs(text) : {};
  }
  const { workspaceExecFor } = await import("./sandbox/workspace-exec");
  const exec = await workspaceExecFor(session);
  const result = await exec(["cat", GPU_JOBS_FILE]).catch(() => null);
  return result?.exitCode === 0 ? parseRepoGpuJobs(result.stdout) : {};
}

/** One paragraph for the run's session note, or "" when the repository
 *  declares no GPU jobs or Modal is not ready. Host workspaces only: it is
 *  read every turn, and a Sandbox workspace would have to be woken. */
export async function gpuJobsNote(
  session: Pick<
    UnifiedSession,
    "id" | "worktreeDir" | "sandbox" | "runner" | "repo" | "sandboxGpu"
  >,
): Promise<string> {
  if (session.sandbox?.provider || session.runner || !session.worktreeDir)
    return "";
  if (!gpuJobsAvailable()) return "";
  const jobs = await sessionRepoGpuJobs(session);
  const names = Object.entries(jobs);
  if (!names.length) return "";
  return [
    "## GPU jobs",
    "This machine has no GPU. The repository declares GPU jobs in `.agents/gpu-jobs.json`; run them with `run_gpu_job` (opensession-gpu), never locally:",
    ...names.map(
      ([name, job]) =>
        `- \`${name}\` (${job.gpu})${job.description ? `: ${job.description}` : ""}`,
    ),
    "The job runs on a GPU machine with your uncommitted work and wakes this session when it ends, so start it and end your turn. Pass `command` for a narrower run (one test), on the same machine.",
  ].join("\n");
}

export function gpuJobsAvailable(): boolean {
  try {
    return sandboxProviderUsability(GPU_JOB_PROVIDER).state === "usable";
  } catch {
    return false;
  }
}

// ── Registry ─────────────────────────────────────────────────────────────

export type GpuJobState =
  | "preparing"
  | "running"
  | "exited"
  | "failed"
  | "timed_out"
  | "stopped"
  | "lost";

export interface GpuJobRecord {
  id: string;
  sessionId: string;
  title: string;
  command: string;
  gpu: SandboxGpu;
  state: GpuJobState;
  startedAt: string;
  deadlineAt: string;
  endedAt?: string;
  exitCode?: number;
  error?: string;
  /** The provider session key of the GPU machine it runs on
   *  (gpuMachineSessionId). Older records ran on the first machine. */
  machine?: string;
  /** The Sandbox id of that machine once it is up. */
  sandboxId?: string;
  /** Commit the job ran on, and whether it included uncommitted work. */
  commit?: string;
  /** The checkpoint commit landed on the machine (the head above plus the
   *  session's uncommitted changes), when there was one. */
  checkpoint?: string;
  note?: string;
  startedBy?: string;
  notified?: boolean;
  stopping?: boolean;
  /** Full log copied to this server when the job ended. */
  logPath?: string;
  identity?: GpuJobIdentity;
  /** Machine paths of the host files sent with the job (never their
   *  contents or where they came from), removed when it ends. */
  stagedFiles?: string[];
  /** Where `$OPENSESSION_JOB_OUTPUT` was copied when the job ended, and
   *  what did not fit. */
  outputDir?: string;
  outputFiles?: number;
  outputNote?: string;
  /** How long each preparation step took (milliseconds). */
  timings?: GpuJobTimings;
  /** Whether the job start's landing found the machine already on the
   *  checkpoint (`unchanged`) or moved it (`landed`). */
  landing?: "landed" | "unchanged";
  /** That landing's steps on the machine (`fetch 210ms, …`). */
  landingSteps?: string;
  /** The latest `gpu_exec` sync. */
  lastSync?: GpuJobSync;
}

/** Preparation of a job, step by step, in milliseconds. `checkpointMs`
 *  (capture and push) runs while an existing machine wakes (`machineMs`);
 *  a new machine is created after it, with the checkpoint. `landMs`: the
 *  checkpoint onto an existing machine. `prepareMs`: everything before the
 *  launch; `launchMs`: files and the detached start; `totalMs`: both. */
export interface GpuJobTimings {
  checkpointMs?: number;
  /** The push from a host worktree, beside the landing. */
  pushMs?: number;
  machineMs?: number;
  landMs?: number;
  prepareMs?: number;
  launchMs?: number;
  totalMs?: number;
}

/** What one sync put on a running job's machine. `changed`: the paths whose
 *  content changed (absent when the machine had no landing to compare
 *  with). */
export interface GpuJobSync {
  state: "landed" | "unchanged";
  at: string;
  commit?: string;
  checkpoint?: string;
  changed?: string[];
  /** Capturing the checkpoint (from a Sandbox workspace, and pushing). */
  checkpointMs: number;
  /** Pushing it to GitHub from a host worktree, beside the landing. */
  pushMs?: number;
  landMs: number;
  totalMs?: number;
  /** The landing's steps on the machine (`fetch 210ms, …`). */
  machineSteps?: string;
  /** Whether the checkpoint went to the machine in a bundle from this
   *  host instead of through GitHub. */
  bundled?: boolean;
}

export function formatTimings(timings: GpuJobTimings): string {
  return Object.entries(timings)
    .map(([step, ms]) => `${step.replace(/Ms$/, "")} ${ms}ms`)
    .join(", ");
}

/** `machines`: every GPU machine (provider session key) each session ever
 *  started a job on. Job records are pruned after a week; this is not, so a
 *  machine whose jobs were all pruned is still reused, slept and retired. */
type Registry = { jobs: GpuJobRecord[]; machines?: Record<string, string[]> };
type GpuJobsState = {
  jobs: Map<string, GpuJobRecord>;
  machines: Map<string, Set<string>>;
  loaded?: Promise<void>;
  polling?: ReturnType<typeof setInterval>;
  preparing: Set<string>;
};
const g = globalThis as { __gpuJobs?: GpuJobsState };
const state: GpuJobsState = (g.__gpuJobs ??= {
  jobs: new Map(),
  machines: new Map(),
  preparing: new Set(),
});
// A state object from before `machines` existed (hot reload).
state.machines ??= new Map();

function rememberMachine(sessionId: string, machine: string): void {
  let set = state.machines.get(sessionId);
  if (!set) state.machines.set(sessionId, (set = new Set()));
  set.add(machine);
}

function registryPath(): string {
  return stateDir("gpu-jobs.json");
}

function ensureLoaded(): Promise<void> {
  state.loaded ??= (async () => {
    const text = await readFile(registryPath(), "utf8").catch(() => "");
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as Registry;
      for (const job of parsed.jobs || []) {
        state.jobs.set(job.id, job);
        rememberMachine(job.sessionId, gpuJobMachine(job));
      }
      for (const [sessionId, machines] of Object.entries(parsed.machines || {}))
        for (const machine of machines) rememberMachine(sessionId, machine);
    } catch (error) {
      console.warn("[gpu-jobs] registry unreadable:", error);
    }
  })();
  return state.loaded;
}

async function persist(): Promise<void> {
  const now = Date.now();
  for (const [id, job] of state.jobs)
    if (job.endedAt && now - Date.parse(job.endedAt) > KEEP_ENDED_MS)
      state.jobs.delete(id);
  await writeJsonAtomicAsync(registryPath(), {
    jobs: [...state.jobs.values()],
    machines: Object.fromEntries(
      [...state.machines].map(([sessionId, set]) => [sessionId, [...set]]),
    ),
  } satisfies Registry);
}

export async function listGpuJobs(sessionId: string): Promise<GpuJobRecord[]> {
  await ensureLoaded();
  return [...state.jobs.values()]
    .filter((job) => job.sessionId === sessionId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function isActive(job: GpuJobRecord): boolean {
  return job.state === "preparing" || job.state === "running";
}

/** The GPU machine a job runs on (its provider session key). */
export function gpuJobMachine(
  job: Pick<GpuJobRecord, "machine" | "sessionId">,
): string {
  return job.machine || gpuMachineSessionId(job.sessionId);
}

/** Whether a job is preparing or running on any of the session's GPU
 *  machines. */
export function gpuJobActive(sessionId: string): boolean {
  for (const job of state.jobs.values())
    if (job.sessionId === sessionId && isActive(job)) return true;
  return false;
}

/**
 * The machine a new job of this session goes to: a free one that last ran
 * this GPU (its container needs no switch), else any free one, most recently
 * used first (its build cache is warmest), else a new one with the lowest
 * unused number. `known` adds machines whose job records were pruned; they
 * are free and come after the ones with a record. There is no cap: Modal's
 * GPU capacity is the limit, and a start waits for it. Synchronous, so a job
 * recorded right after this call claims the machine before another start
 * can pick it.
 */
export function pickGpuMachine(
  jobs: Iterable<GpuJobRecord>,
  sessionId: string,
  gpu: SandboxGpu,
  known: Iterable<string> = [],
): string {
  const busy = new Set<string>();
  const last = new Map<string, GpuJobRecord>();
  for (const job of jobs) {
    if (job.sessionId !== sessionId) continue;
    const machine = gpuJobMachine(job);
    if (isActive(job)) busy.add(machine);
    const seen = last.get(machine);
    if (!seen || seen.startedAt < job.startedAt) last.set(machine, job);
  }
  const free = [...last.entries()]
    .filter(([machine]) => !busy.has(machine))
    .sort(
      ([, a], [, b]) =>
        Number(b.gpu === gpu) - Number(a.gpu === gpu) ||
        b.startedAt.localeCompare(a.startedAt),
    );
  if (free[0]) return free[0][0];
  const taken = new Set(last.keys());
  for (const machine of known)
    if (!taken.has(machine)) return machine;
    else taken.add(machine);
  for (let slot = 1; ; slot++) {
    const machine = gpuMachineSessionId(sessionId, slot);
    if (!taken.has(machine)) return machine;
  }
}

/** Sessions that may hold GPU machines (any job or machine on record). */
export function sessionHasGpuMachine(sessionId: string): boolean {
  if (state.machines.get(sessionId)?.size) return true;
  for (const job of state.jobs.values())
    if (job.sessionId === sessionId) return true;
  return false;
}

// ── Starting ─────────────────────────────────────────────────────────────

export interface GpuJobFile {
  /** Host path: absolute, or relative to the session's worktree. */
  from: string;
  /** Machine path: absolute, or relative to the repository root there. */
  to: string;
  /** Octal file mode, default 600. */
  mode?: string;
}

/** A host file read for a job: held in memory until it is on the machine,
 *  never persisted. */
interface LoadedGpuJobFile {
  to: string;
  mode: string;
  content: Buffer;
}

export interface StartGpuJobInput {
  sessionId: string;
  title: string;
  command: string;
  gpu: SandboxGpu;
  timeoutMinutes: number;
  startedBy?: string;
  files?: GpuJobFile[];
  identity?: GpuJobIdentity;
}

function within(path: string, root: string): boolean {
  return (
    path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
  );
}

async function gitIgnored(worktree: string, path: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["git", "-C", worktree, "check-ignore", "-q", "--", path],
    { stdout: "ignore", stderr: "ignore" },
  );
  return (await proc.exited) === 0;
}

/** Validate a target path on the machine; the repository root resolves
 *  relative ones at launch. */
export function gpuJobFileTarget(to: string, cwd: string): string | null {
  if (!to || to.length > 1024 || /[\0\n\r]/.test(to)) return null;
  const path = posix.isAbsolute(to)
    ? posix.normalize(to)
    : posix.join(cwd, posix.normalize(to));
  if (path === "/" || path.endsWith("/")) return null;
  if (within(path, posix.join(cwd, ".git")) || within(path, REMOTE_ROOT))
    return null;
  return path;
}

/**
 * Read the files a job sends. Each `from` must resolve (symlinks followed)
 * inside the session's worktree, its scratch directory or the repository's
 * main checkout. One in the worktree must be gitignored: anything else is
 * pushed with the checkpoint, which is what sending it this way avoids.
 */
export async function loadGpuJobFiles(
  files: GpuJobFile[],
  roots: { worktree?: string; scratch: string; mainCheckout?: string },
): Promise<{ files: LoadedGpuJobFile[] } | { error: string }> {
  if (files.length > MAX_GPU_JOB_FILES)
    return { error: `at most ${MAX_GPU_JOB_FILES} files per job` };
  const real = async (dir?: string) =>
    dir ? await realpath(dir).catch(() => null) : null;
  const [worktree, scratch, main] = await Promise.all([
    real(roots.worktree),
    real(roots.scratch),
    real(roots.mainCheckout),
  ]);
  const loaded: LoadedGpuJobFile[] = [];
  const targets = new Set<string>();
  let total = 0;
  for (const file of files) {
    const mode = file.mode ?? "600";
    if (!/^0?[0-7]{3}$/.test(mode))
      return { error: `${file.to}: mode must be octal, like 600` };
    if (!gpuJobFileTarget(file.to, "/repo"))
      return { error: `${file.to}: not a file path the machine can take` };
    if (targets.has(file.to)) return { error: `${file.to} is sent twice` };
    targets.add(file.to);
    const from =
      isAbsolute(file.from) || !roots.worktree
        ? file.from
        : join(roots.worktree, file.from);
    const path = await realpath(from).catch(() => null);
    if (!path) return { error: `${file.from} does not exist` };
    if (worktree && within(path, worktree)) {
      if (!(await gitIgnored(worktree, path)))
        return {
          error: `${file.from} is not gitignored, so it is already in the checkpoint pushed to GitHub; send only gitignored files, or ones in the session's scratch directory`,
        };
    } else if (
      !(scratch && within(path, scratch)) &&
      !(main && within(path, main))
    )
      return {
        error: `${file.from} is outside the session's worktree, its scratch directory and the repository's main checkout`,
      };
    const info = await stat(path);
    if (!info.isFile()) return { error: `${file.from} is not a file` };
    total += info.size;
    if (total > MAX_GPU_JOB_FILE_BYTES)
      return {
        error: `the files add up to more than ${MAX_GPU_JOB_FILE_BYTES / 1024 / 1024} MB`,
      };
    loaded.push({
      to: file.to,
      mode: mode.replace(/^0/, ""),
      content: await readFile(path),
    });
  }
  return { files: loaded };
}

/** Validate and record the job, then prepare it in the background. */
export async function startGpuJob(
  input: StartGpuJobInput,
): Promise<{ job: GpuJobRecord } | { error: string }> {
  await ensureLoaded();
  if (!gpuJobsAvailable())
    return {
      error:
        "Modal is not connected and ready (Workspace > Sandboxes), so there is no GPU to run on",
    };
  const { findSessionAsync } = await import("./session-cache");
  const session = await findSessionAsync(input.sessionId);
  if (!session) return { error: "no such session" };
  if (session.sandbox?.provider === GPU_JOB_PROVIDER && session.sandboxGpu)
    return {
      error: `this session already runs on a Modal ${session.sandboxGpu} GPU; run the command in your own shell`,
    };
  if (session.runner)
    return { error: "a Runner session's workspace cannot be checkpointed" };
  if (!session.repo || !session.worktreeDir)
    return { error: "this session has no repository workspace" };
  let files: LoadedGpuJobFile[] = [];
  if (input.files?.length) {
    const { getRepo } = await import("./worktree");
    const loaded = await loadGpuJobFiles(input.files, {
      ...(session.sandbox?.provider ? {} : { worktree: session.worktreeDir }),
      scratch: hostSessionScratchDir(session.id),
      mainCheckout: getRepo(session.repo).repo,
    });
    if ("error" in loaded) return { error: loaded.error };
    files = loaded.files;
  }
  const machine = pickGpuMachine(
    state.jobs.values(),
    session.id,
    input.gpu,
    state.machines.get(session.id) ?? [],
  );
  rememberMachine(session.id, machine);
  const minutes = Math.min(
    Math.max(1, input.timeoutMinutes),
    MAX_GPU_JOB_MINUTES,
  );
  const now = Date.now();
  const job: GpuJobRecord = {
    id: `gj-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    sessionId: session.id,
    title: input.title.slice(0, 120),
    command: input.command,
    gpu: input.gpu,
    state: "preparing",
    machine,
    startedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + minutes * 60_000).toISOString(),
    ...(input.startedBy ? { startedBy: input.startedBy } : {}),
    ...(input.identity ? { identity: input.identity } : {}),
  };
  state.jobs.set(job.id, job);
  await persist();
  state.preparing.add(job.id);
  void prepareAndLaunch(job, session, files)
    .catch(async (error) => {
      await settle(job, {
        state: "failed",
        error: (error instanceof Error ? error.message : String(error)).slice(
          0,
          600,
        ),
      });
    })
    .finally(() => state.preparing.delete(job.id));
  return { job };
}

async function prepareAndLaunch(
  job: GpuJobRecord,
  session: UnifiedSession,
  files: LoadedGpuJobFile[] = [],
): Promise<void> {
  const [
    { getSandboxProvider },
    { ensureSandboxWaitingForCapacity },
    checkpoint,
    { getRepo },
    { noteSandboxActivity },
    { withSessionLifecycleLane },
  ] = await Promise.all([
    import("./sandbox"),
    import("./sandbox/reliability"),
    import("./sandbox/checkpoint"),
    import("./worktree"),
    import("./sandbox/idle"),
    import("./sandbox/lifecycle-lane"),
  ]);
  const repo = getRepo(session.repo);
  const timings: GpuJobTimings = {};
  const begun = Date.now();
  const timed = async <T>(
    step: keyof GpuJobTimings,
    run: () => Promise<T>,
  ): Promise<T> => {
    const at = Date.now();
    try {
      return await run();
    } finally {
      timings[step] = Date.now() - at;
    }
  };
  job.timings = timings;

  // The job's GPU machine: woken, created, or switched to this GPU.
  const provider = getSandboxProvider(GPU_JOB_PROVIDER);
  const machineSession = gpuJobMachine(job);
  const existing = await provider.machineFor?.(machineSession);
  const ensure = (
    branch: string,
    landed?: SandboxCheckpointRecord | null,
  ): Promise<Sandbox> =>
    timed("machineMs", () =>
      ensureSandboxWaitingForCapacity(provider, {
        sessionId: machineSession,
        // The machine works for the owning session: its repository and its
        // trust profile (run_gpu_job is interactive-only) scope the workload
        // identity every command on it gets.
        repo: repo.id,
        trustProfile: "interactive",
        branch,
        mode: "code",
        gpu: job.gpu,
        ...(landed
          ? {
              restoreCheckpoint: {
                ref: landed.ref,
                commit: landed.commit,
                branch: landed.branch,
              },
            }
          : {}),
      }),
    );
  // An existing machine needs no checkpoint to wake: wake it while the
  // checkpoint is taken. Its branch is fixed by the landing anyway.
  const waking = existing
    ? ensure(
        session.sandboxCheckpoint?.branch ||
          session.branch ||
          repo.defaultBranch,
      )
    : null;
  waking?.catch(() => {});

  // The session's work, uncommitted changes included, then onto the
  // machine. On the session's lifecycle lane with the landing: another
  // checkpoint (a sync, a turn's) force-pushing the hidden ref between
  // this capture and the machine's fetch would fail the landing.
  // A new machine is created outside the lane (it can take minutes, and a
  // turn waits for the lane); it restores the checkpoint as it is created.
  const prepared = await withSessionLifecycleLane(
    session.id,
    async (): Promise<{
      sandbox?: Sandbox;
      landed: SandboxCheckpointRecord | null;
      branch: string;
    }> => {
      if (!waking) {
        const outcome = await timed("checkpointMs", () =>
          captureCheckpoint(session),
        );
        const landed = outcome.state === "skipped" ? null : outcome.checkpoint;
        const branch = landed?.branch || session.branch || repo.defaultBranch;
        if (outcome.state === "skipped")
          job.note = `Ran on origin/${branch}: the workspace could not be checkpointed (${outcome.reason}), so uncommitted changes are not included.`;
        return { landed, branch };
      }
      // The checkpoint the machine was last put on: everything in it is on
      // the machine, so a bundle on top of it is all the landing needs.
      const previous = [...state.jobs.values()]
        .filter(
          (other) =>
            other.id !== job.id &&
            gpuJobMachine(other) === machineSession &&
            other.checkpoint,
        )
        .sort((x, y) => y.startedAt.localeCompare(x.startedAt))[0];
      const done = await checkpointOnto(session, () => waking, {
        clean: true,
        haves: previous?.checkpoint ? [previous.checkpoint] : [],
      });
      timings.checkpointMs = done.checkpointMs;
      if (done.pushMs !== undefined) timings.pushMs = done.pushMs;
      if (done.landMs !== undefined) timings.landMs = done.landMs;
      const { outcome } = done;
      const landed = outcome.state === "skipped" ? null : outcome.checkpoint;
      const branch = landed?.branch || session.branch || repo.defaultBranch;
      if (outcome.state === "skipped")
        job.note = `Ran on origin/${branch}: the workspace could not be checkpointed (${outcome.reason}), so uncommitted changes are not included.`;
      if (done.land) {
        job.landing = done.land.state;
        if (done.land.head) job.commit = done.land.head;
        if (done.land.steps) job.landingSteps = done.land.steps;
      }
      const sandbox = await waking;
      if (!landed)
        await timed("landMs", async () => {
          const sync = await sandbox.exec(
            [
              "bash",
              "-c",
              `git fetch -q origin ${shellWord(branch)} && git reset -q --hard FETCH_HEAD && git clean -fdq && git update-ref -d ${checkpoint.LANDED_REF}`,
            ],
            { env: await gpuJobEnv(repo), timeoutMs: 5 * 60_000 },
          );
          if (sync.exitCode !== 0)
            throw new Error(
              `could not update the GPU machine to origin/${branch}: ${(sync.stderr || sync.stdout).trim().slice(0, 300)}`,
            );
        });
      return { sandbox, landed, branch };
    },
  );
  const { landed } = prepared;
  const sandbox =
    prepared.sandbox ?? (await ensure(prepared.branch, prepared.landed));
  job.sandboxId = sandbox.id;
  noteSandboxActivity(
    { sandboxId: sandbox.id, sessionId: session.id },
    "agent",
  );
  const env = await gpuJobEnv(repo);
  // A new machine restored the checkpoint while it was created: mark it
  // landed so a sync starts from it. A landing said where it left HEAD.
  if (!job.commit || !existing) {
    const head = await sandbox.exec([
      "bash",
      "-c",
      `${!existing && landed ? `git update-ref ${checkpoint.LANDED_REF} ${shellWord(landed.commit)} 2>/dev/null; ` : ""}git rev-parse HEAD`,
    ]);
    if (head.exitCode === 0) job.commit = head.stdout.trim();
  }
  if (landed && landed.commit !== job.commit) job.checkpoint = landed.commit;
  timings.prepareMs = Date.now() - begun;
  if (job.stopping) {
    await settle(job, { state: "stopped" });
    return;
  }

  // 3. Launch detached: the job outlives this exec and this server.
  const dir = `${REMOTE_ROOT}/${job.id}`;
  const deadlineSeconds = Math.max(
    60,
    Math.round((Date.parse(job.deadlineAt) - Date.now()) / 1000),
  );
  const script = Buffer.from(job.command).toString("base64");
  const launch = [
    `set -e`,
    `mkdir -p ${dir}/output`,
    `printf %s ${script} | base64 -d > ${dir}/command.sh`,
    `cat > ${dir}/wrap.sh <<'WRAP'`,
    `cd "$OPENSESSION_GPU_JOB_CWD"`,
    `timeout --signal=TERM --kill-after=30 ${deadlineSeconds} bash ${dir}/command.sh > ${dir}/log 2>&1`,
    `code=$?`,
    REMOVE_STAGED(dir),
    `echo $code > ${dir}/exit.tmp && mv ${dir}/exit.tmp ${dir}/exit`,
    `WRAP`,
    `cd ${shellWord(sandbox.cwd)}`,
    `OPENSESSION_GPU_JOB_CWD="$PWD" nohup setsid bash ${dir}/wrap.sh >/dev/null 2>&1 < /dev/null &`,
    `echo $! > ${dir}/pid`,
  ].join("\n");
  try {
    await stageFiles(sandbox, job, files);
    const started = await sandbox.exec(["bash", "-c", launch], {
      env: {
        ...env,
        ...jobVariables(job),
        ...(await jobIdentityEnv(job, sandbox.id, repo.id)),
      },
      timeoutMs: 60_000,
    });
    if (started.exitCode !== 0)
      throw new Error(
        `could not start the job: ${(started.stderr || started.stdout).trim().slice(0, 300)}`,
      );
  } catch (error) {
    await removeStaged(sandbox, job);
    throw error;
  }
  job.state = "running";
  timings.launchMs = Date.now() - begun - timings.prepareMs;
  timings.totalMs = Date.now() - begun;
  await persist();
  console.log(
    `[gpu-jobs] ${job.sessionId}: ${job.id} running on ${job.gpu} in ${sandbox.id} after ${formatTimings(timings)}`,
  );
  ensurePolling();
}

/** Checkpoint the session's workspace wherever it is, without landing it
 *  (a new machine restores it as it is created). */
async function captureCheckpoint(
  session: UnifiedSession,
): Promise<CheckpointOutcome> {
  const checkpoint = await import("./sandbox/checkpoint");
  if (session.sandbox?.provider) {
    const { activeSandboxFor } = await import("./session-sandbox");
    return checkpoint.checkpointSessionWorkspace(session, (current) =>
      activeSandboxFor(current as UnifiedSession, { wake: true }),
    );
  }
  return checkpoint.checkpointHostWorkspace(session, session.worktreeDir!);
}

/** What `checkpointOnto` did, with how long each part took. */
interface CheckpointOntoResult {
  outcome: CheckpointOutcome;
  /** Absent when nothing was landed (skipped, or the machine already had
   *  that checkpoint). */
  land?: LandOutcome;
  sandbox?: Sandbox;
  /** Capture (and, from a Sandbox workspace, the push). */
  checkpointMs: number;
  /** The push from a host worktree, which runs beside the landing. */
  pushMs?: number;
  landMs?: number;
}

/**
 * Checkpoint the session's workspace wherever it is (a host worktree or its
 * Sandbox) and land it on a GPU machine. Claims the session's lifecycle
 * lane (reentrant): another checkpoint force-pushing the hidden ref
 * mid-landing would fail its check.
 *
 * From a host worktree the checkpoint is not fetched from GitHub: once it
 * is captured, a bundle of it on top of `haves` (the checkpoint the machine
 * was last put on, whose files it all has) goes straight to the machine
 * while the checkpoint is pushed, and the landing falls back to origin if
 * the bundle does not fit. A Sandbox workspace's checkpoint is pushed, then
 * fetched.
 *
 * `machine` is awaited only once there is something to land; `onMachine`
 * (the commit the machine has) skips the landing when it is this one.
 */
async function checkpointOnto(
  session: UnifiedSession,
  machine: () => Promise<Sandbox>,
  options: { clean: boolean; haves: string[]; onMachine?: string },
): Promise<CheckpointOntoResult> {
  const checkpoint = await import("./sandbox/checkpoint");
  const started = Date.now();
  const result: Partial<CheckpointOntoResult> = {};
  const land = async (
    landed: SandboxCheckpointRecord,
    bundle?: Buffer | null,
  ) => {
    result.sandbox = await machine();
    const at = Date.now();
    try {
      result.land = await checkpoint.landCheckpointInSandbox(
        session.repo,
        result.sandbox,
        landed,
        { clean: options.clean, bundle },
      );
    } finally {
      result.landMs = Date.now() - at;
    }
  };
  const bundleFor = (commit: string) =>
    options.haves.length
      ? checkpoint
          .checkpointBundle(session.worktreeDir!, commit, options.haves)
          .catch(() => null)
      : Promise.resolve(null);
  let outcome: CheckpointOutcome;
  let afterPush: SandboxCheckpointRecord | undefined;
  if (session.sandbox?.provider) {
    const { activeSandboxFor } = await import("./session-sandbox");
    outcome = await checkpoint.checkpointSessionWorkspace(session, (current) =>
      activeSandboxFor(current as UnifiedSession, { wake: true }),
    );
    result.checkpointMs = Date.now() - started;
    if (
      outcome.state !== "skipped" &&
      outcome.checkpoint.commit !== options.onMachine
    )
      await land(outcome.checkpoint);
  } else {
    outcome = await checkpoint.checkpointHostWorkspace(
      session,
      session.worktreeDir!,
      {
        alongsidePush: async (captured) => {
          result.checkpointMs = Date.now() - started;
          if (captured.commit === options.onMachine) return;
          // Without a bundle the machine fetches from origin, which has the
          // checkpoint only once the push is done.
          const bundle = await bundleFor(captured.commit);
          if (bundle) await land(captured, bundle);
          else afterPush = captured;
        },
        onPushed: (ms) => {
          result.pushMs = ms;
        },
      },
    );
    result.checkpointMs ??= Date.now() - started;
    if (afterPush) await land(afterPush);
    if (
      outcome.state === "unchanged" &&
      outcome.checkpoint.commit !== options.onMachine
    )
      await land(
        outcome.checkpoint,
        await bundleFor(outcome.checkpoint.commit),
      );
  }
  return { ...result, outcome, checkpointMs: result.checkpointMs! };
}

/** Paths a sync result lists by name; the rest are counted. */
const MAX_SYNC_PATHS = 50;

/**
 * Land the session's current work (uncommitted changes included) on the
 * machine of one of its running jobs, without stopping the job. Only files
 * whose content changed are rewritten, so a dev server's watcher there
 * rebuilds just those. Untracked files the job made are left alone; files
 * an earlier landing put there that the session has since deleted are
 * removed. Nothing is fetched or reset when the machine already has this
 * checkpoint. Runs on the session's lifecycle lane, so syncs, job starts
 * and other checkpoints of the session never interleave.
 */
export async function syncGpuJob(
  job: GpuJobRecord,
  session: UnifiedSession,
  sandbox: Sandbox,
): Promise<GpuJobSync | { error: string }> {
  const { withSessionLifecycleLane } = await import("./sandbox/lifecycle-lane");
  return withSessionLifecycleLane(session.id, async () => {
    const started = Date.now();
    const done = await checkpointOnto(session, async () => sandbox, {
      clean: false,
      haves: job.checkpoint ? [job.checkpoint] : [],
      ...(job.checkpoint ? { onMachine: job.checkpoint } : {}),
    });
    const { outcome, land } = done;
    if (outcome.state === "skipped")
      return {
        error: `the workspace could not be checkpointed (${outcome.reason}), so nothing was landed and the command did not run`,
      };
    const landed = outcome.checkpoint;
    const changed = land?.state === "landed" ? land.changed : null;
    if (land) {
      if (land.head) job.commit = land.head;
      job.checkpoint = landed.commit;
    }
    const sync: GpuJobSync = {
      state: land?.state ?? "unchanged",
      at: new Date().toISOString(),
      ...(job.commit ? { commit: job.commit } : {}),
      checkpoint: landed.commit,
      ...(changed
        ? {
            changed:
              changed.length > MAX_SYNC_PATHS
                ? [
                    ...changed.slice(0, MAX_SYNC_PATHS),
                    `… and ${changed.length - MAX_SYNC_PATHS} more`,
                  ]
                : changed,
          }
        : {}),
      checkpointMs: done.checkpointMs,
      ...(done.pushMs !== undefined ? { pushMs: done.pushMs } : {}),
      landMs: done.landMs ?? 0,
      totalMs: Date.now() - started,
      ...(land?.steps ? { machineSteps: land.steps } : {}),
      ...(land?.bundled !== undefined ? { bundled: land.bundled } : {}),
    };
    job.lastSync = sync;
    await persist().catch(() => {});
    console.log(
      `[gpu-jobs] ${job.sessionId}: ${job.id} sync ${sync.state} ${landed.commit.slice(0, 12)}` +
        `${changed ? ` (${changed.length} changed)` : ""} in ${sync.totalMs}ms: checkpoint ${sync.checkpointMs}ms` +
        `${sync.pushMs !== undefined ? `, push ${sync.pushMs}ms` : ""}, land ${sync.landMs}ms` +
        `${sync.bundled ? " (bundle)" : ""}${sync.machineSteps ? ` [${sync.machineSteps}]` : ""}`,
    );
    return sync;
  });
}

/** The variables every command of a job sees, the job's own and
 *  gpu_exec's. */
function jobVariables(job: GpuJobRecord): Record<string, string> {
  return {
    OPENSESSION_GPU: job.gpu,
    OPENSESSION_GPU_JOB_ID: job.id,
    OPENSESSION_JOB_OUTPUT: `${REMOTE_ROOT}/${job.id}/output`,
    RUNNER_TEMP: "/tmp",
    CI: "1",
  };
}

/** A job with `identity: "portal"` gets a lease for the audiences granted
 *  to a Portal Sandbox's setup, Portal and ordinary commands (the token
 *  says lifecycle "preview"). Others keep the ordinary command's lease the
 *  Sandbox handle adds. Revoked when the job ends. */
async function jobIdentityEnv(
  job: GpuJobRecord,
  sandboxId: string,
  repoId: string,
): Promise<Record<string, string>> {
  if (job.identity !== "portal") return {};
  const { createWorkloadIdentityEnv } = await import("./workload-identity");
  return createWorkloadIdentityEnv(
    {
      sandboxId,
      provider: GPU_JOB_PROVIDER,
      lifecycle: "preview",
      sessionId: gpuJobMachine(job),
      repoId,
      trustProfile: "interactive",
    },
    { grantLifecycles: ["setup", "preview", "run"] },
  );
}

/** Shell lines that delete the job's staged host files. */
function REMOVE_STAGED(dir: string): string {
  return `test -f ${dir}/staged && while IFS= read -r f; do rm -f -- "$f"; done < ${dir}/staged; rm -rf ${dir}/in`;
}

/** Write the job's host files to the machine: each travels base64 over the
 *  provider's file API into a private inbox, then lands at its target with
 *  its mode. The targets are recorded (and listed on the machine) first, so
 *  whatever ends the job removes them. */
async function stageFiles(
  sandbox: Sandbox,
  job: GpuJobRecord,
  files: LoadedGpuJobFile[],
): Promise<void> {
  if (!files.length) return;
  if (!sandbox.writeFile) throw new Error("this GPU machine cannot take files");
  const dir = `${REMOTE_ROOT}/${job.id}`;
  const targets = files.map((file) => {
    const target = gpuJobFileTarget(file.to, sandbox.cwd);
    if (!target) throw new Error(`${file.to}: not a file path`);
    return target;
  });
  job.stagedFiles = targets;
  await persist();
  const list = Buffer.from(targets.join("\n") + "\n").toString("base64");
  const prepared = await sandbox.exec(
    [
      "bash",
      "-c",
      `umask 077 && mkdir -p ${dir}/in && printf %s ${list} | base64 -d > ${dir}/staged`,
    ],
    { timeoutMs: 60_000 },
  );
  if (prepared.exitCode !== 0)
    throw new Error(
      `could not prepare the job's files: ${(prepared.stderr || prepared.stdout).trim().slice(0, 300)}`,
    );
  for (const [index, file] of files.entries())
    await sandbox.writeFile(
      `${dir}/in/${index}`,
      file.content.toString("base64"),
    );
  const place = files
    .map((file, index) => {
      const target = shellWord(targets[index]!);
      return `mkdir -p "$(dirname ${target})" && rm -f ${target} && (umask 077 && base64 -d < ${dir}/in/${index} > ${target}) && chmod ${file.mode} ${target} && rm -f ${dir}/in/${index}`;
    })
    .join(" && \n");
  const placed = await sandbox.exec(["bash", "-c", place], {
    timeoutMs: 120_000,
  });
  if (placed.exitCode !== 0)
    throw new Error(
      `could not place the job's files: ${(placed.stderr || placed.stdout).trim().slice(0, 300)}`,
    );
}

async function removeStaged(
  sandbox: Sandbox,
  job: GpuJobRecord,
): Promise<void> {
  if (!job.stagedFiles?.length) return;
  await sandbox
    .exec(["bash", "-c", REMOVE_STAGED(`${REMOTE_ROOT}/${job.id}`)], {
      timeoutMs: 60_000,
    })
    .catch(() => {});
}

/** Read access for the job: the repository and the repositories its build
 *  reads (RepoSection.readRepos), answered by an in-shell credential helper
 *  so nothing is written to disk. Read-only: a job cannot push. */
async function gpuJobEnv(repo: {
  ghRepo: string;
  readRepos?: string[];
}): Promise<Record<string, string>> {
  if (!repo.ghRepo) return { GIT_TERMINAL_PROMPT: "0" };
  const [github, credential, { INLINE_GITHUB_CREDENTIAL_HELPER }] =
    await Promise.all([
      import("./github-app"),
      import("./github-git-credential"),
      import("./remote-workspace"),
    ]);
  const token =
    (await github
      .githubAppRepositoryToken(repo.ghRepo, { readOnly: true })
      .catch(() => null)) || "";
  const env = credential.githubGitCredentialEnv(
    token,
    INLINE_GITHUB_CREDENTIAL_HELPER,
  );
  if (!repo.readRepos?.length) return env;
  const read = await github
    .githubAppReadReposToken(repo.ghRepo, repo.readRepos)
    .catch(() => null);
  return read
    ? credential.withReadRepoCredentials(
        { ...env, GH_READ_TOKEN: read },
        repo.readRepos,
      )
    : env;
}

function shellWord(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

// ── Following ────────────────────────────────────────────────────────────

async function machineFor(job: GpuJobRecord): Promise<Sandbox | null> {
  if (!job.sandboxId) return null;
  const { getSandboxProvider } = await import("./sandbox");
  const sandbox = await getSandboxProvider(GPU_JOB_PROVIDER)
    .get(job.sandboxId)
    .catch(() => null);
  if (!sandbox || (await sandbox.status().catch(() => "gone")) !== "running")
    return null;
  return sandbox;
}

function ensurePolling(): void {
  if (state.polling) return;
  state.polling = setInterval(() => {
    void pollAll().catch((error) =>
      console.warn("[gpu-jobs] poll failed:", error),
    );
  }, POLL_MS);
  state.polling.unref?.();
}

let pollRunning = false;
async function pollAll(): Promise<void> {
  if (pollRunning) return;
  pollRunning = true;
  try {
    let running = 0;
    for (const job of [...state.jobs.values()]) {
      if (job.state === "running") {
        running++;
        await checkJob(job).catch((error) =>
          console.warn(`[gpu-jobs] ${job.id}:`, error),
        );
      } else if (job.endedAt && !job.notified) await notifyEnded(job);
    }
    if (!running && !state.preparing.size && state.polling) {
      clearInterval(state.polling);
      state.polling = undefined;
    }
  } finally {
    pollRunning = false;
  }
}

async function checkJob(job: GpuJobRecord): Promise<void> {
  const sandbox = await machineFor(job);
  if (!sandbox) {
    await settle(job, {
      state: "lost",
      error: "the GPU machine stopped while the job was running",
    });
    return;
  }
  // A running job is work on that machine: keep the idle timers and the
  // provider's backstop from putting it to sleep.
  const [{ noteSandboxActivity }, { touchRemoteState }] = await Promise.all([
    import("./sandbox/idle"),
    import("./sandbox/adapters/bootstrap"),
  ]);
  noteSandboxActivity(
    { sandboxId: sandbox.id, sessionId: job.sessionId },
    "agent",
  );
  await touchRemoteState(GPU_JOB_PROVIDER, sandbox.id);
  const dir = `${REMOTE_ROOT}/${job.id}`;
  const probe = await sandbox.exec(
    ["bash", "-c", `cat ${dir}/exit 2>/dev/null || echo running`],
    { timeoutMs: 30_000 },
  );
  if (probe.exitCode !== 0) return;
  const out = probe.stdout.trim();
  if (out === "running") {
    // A stop that did not take (an older stop left the command running):
    // stop it again; the next poll sees its exit file.
    if (job.stopping) {
      await killRemote(sandbox, job);
      return;
    }
    if (Date.now() > Date.parse(job.deadlineAt) + 120_000) {
      await killRemote(sandbox, job);
      await settle(job, { state: "timed_out" }, sandbox);
    }
    return;
  }
  const code = Number(out);
  await settle(
    job,
    job.stopping
      ? { state: "stopped", exitCode: code }
      : code === 124 || code === 137
        ? { state: "timed_out", exitCode: code }
        : { state: "exited", exitCode: code },
    sandbox,
  );
}

/**
 * Stop a job: every process in its session (wrap.sh is a session leader;
 * `timeout` moves itself and the command into a process group of their
 * own, so signalling wrap.sh's group alone leaves the command running), then
 * an exit file if wrap.sh died before writing one, so the poll settles it.
 */
async function killRemote(sandbox: Sandbox, job: GpuJobRecord): Promise<void> {
  const dir = `${REMOTE_ROOT}/${job.id}`;
  const script = [
    `p=$(cat ${dir}/pid 2>/dev/null)`,
    `signal() { local f s; for f in /proc/[0-9]*/stat; do s=$(cat "$f" 2>/dev/null) || continue; set -- \${s##*")"}; [ "$4" = "$p" ] && kill -"$SIG" "\${f//[^0-9]/}" 2>/dev/null; done; kill -"$SIG" -- -"$p" 2>/dev/null; true; }`,
    `if test -n "$p"; then SIG=TERM signal; sleep 5; SIG=KILL signal; fi`,
    REMOVE_STAGED(dir),
    `test -e ${dir}/exit || { echo 143 > ${dir}/exit.stop && mv -n ${dir}/exit.stop ${dir}/exit; }`,
  ].join("\n");
  await sandbox
    .exec(["bash", "-c", script], { timeoutMs: 30_000 })
    .catch(() => {});
}

async function settle(
  job: GpuJobRecord,
  patch: Partial<GpuJobRecord>,
  sandbox?: Sandbox,
): Promise<void> {
  if (job.endedAt) return;
  Object.assign(job, patch, { endedAt: new Date().toISOString() });
  if (job.identity === "portal" && job.sandboxId) {
    // The job's lease (and gpu_exec's) end with it; the next job on this
    // machine gets its own.
    const { revokeWorkloadIdentityForSandbox } =
      await import("./workload-identity");
    revokeWorkloadIdentityForSandbox(job.sandboxId);
  }
  if (sandbox) {
    const dir = `${REMOTE_ROOT}/${job.id}`;
    const log = await sandbox
      .exec(
        ["bash", "-c", `tail -c ${SAVED_LOG_BYTES} ${dir}/log 2>/dev/null`],
        {
          timeoutMs: 60_000,
        },
      )
      .catch(() => null);
    if (log?.stdout) {
      const local = join(hostSessionScratchDir(job.sessionId), "gpu-jobs");
      await mkdir(local, { recursive: true }).catch(() => {});
      job.logPath = join(local, `${job.id}.log`);
      await writeFile(job.logPath, log.stdout).catch(() => {
        job.logPath = undefined;
      });
    }
    await removeStaged(sandbox, job);
    await collectOutputs(sandbox, job).catch((error) => {
      job.outputNote =
        `Its outputs could not be copied: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          300,
        );
    });
    // The idle timers start from the job's end.
    const { noteSandboxActivity } = await import("./sandbox/idle");
    noteSandboxActivity(
      { sandboxId: sandbox.id, sessionId: job.sessionId },
      "agent",
    );
  }
  await persist().catch(() => {});
  console.log(
    `[gpu-jobs] ${job.sessionId}: ${job.id} ${job.state}${job.exitCode !== undefined ? ` (${job.exitCode})` : ""}`,
  );
  await notifyEnded(job);
}

// ── Waking the session ───────────────────────────────────────────────────

const ENDED_WORDS: Record<GpuJobState, string> = {
  preparing: "is preparing",
  running: "is running",
  exited: "exited",
  failed: "could not run",
  timed_out: "hit its time limit and was stopped",
  stopped: "was stopped",
  lost: "was lost",
};

export function gpuJobEndedMessage(job: GpuJobRecord, tail: string): string {
  const took = job.endedAt
    ? Math.round((Date.parse(job.endedAt) - Date.parse(job.startedAt)) / 1000)
    : 0;
  const duration =
    took >= 60 ? `${Math.floor(took / 60)}m ${took % 60}s` : `${took}s`;
  const code =
    job.exitCode !== undefined && job.state !== "failed"
      ? ` with code ${job.exitCode}`
      : "";
  return (
    `A GPU job this session started ended. This is system context, not a new user message.\n\n` +
    `GPU job "${job.title}" (${job.id}, ${job.gpu}) ${ENDED_WORDS[job.state]}${code} after ${duration}.` +
    (job.commit
      ? ` It ran on ${job.commit.slice(0, 12)}${job.checkpoint ? ` with the uncommitted changes of checkpoint ${job.checkpoint.slice(0, 12)}` : ""}.`
      : "") +
    (job.note ? `\n${job.note}` : "") +
    (job.error ? `\nError: ${job.error}` : "") +
    (job.logPath ? `\nFull log: ${job.logPath}` : "") +
    (job.outputDir
      ? `\nOutputs ($OPENSESSION_JOB_OUTPUT, ${job.outputFiles} file${job.outputFiles === 1 ? "" : "s"}): ${job.outputDir}`
      : "") +
    (job.outputNote ? `\n${job.outputNote}` : "") +
    (tail.trim() ? `\nLast output:\n${tail.trimEnd()}` : "")
  );
}

async function notifyEnded(job: GpuJobRecord): Promise<void> {
  if (job.notified) return;
  try {
    const tail = job.logPath
      ? (await readFile(job.logPath, "utf8").catch(() => "")).slice(
          -WAKE_TAIL_BYTES,
        )
      : "";
    const [{ getSessionControl }, { wrapContext }] = await Promise.all([
      import("./session-control"),
      import("./prompt-context"),
    ]);
    const control = getSessionControl();
    if (control.getSession(job.sessionId)) {
      const result = await control.deliverToSession(
        job.sessionId,
        wrapContext(gpuJobEndedMessage(job, tail), "background-wait"),
        undefined,
        { deliveryId: `gpu-job:${job.id}:ended` },
      );
      if (result.status === "error") throw new Error(result.message);
    }
    job.notified = true;
    await persist().catch(() => {});
  } catch (error) {
    console.error(`[gpu-jobs] couldn't wake ${job.sessionId}:`, error);
    ensurePolling();
  }
}

// ── Status and stop ──────────────────────────────────────────────────────

export async function gpuJobStatus(
  id: string,
  sessionId: string,
): Promise<(GpuJobRecord & { tail?: string }) | null> {
  await ensureLoaded();
  const job = state.jobs.get(id);
  if (!job || job.sessionId !== sessionId) return null;
  let tail: string | undefined;
  if (job.state === "running") {
    const sandbox = await machineFor(job);
    const log = await sandbox
      ?.exec(
        ["bash", "-c", `tail -c 4000 ${REMOTE_ROOT}/${job.id}/log 2>/dev/null`],
        { timeoutMs: 30_000 },
      )
      .catch(() => null);
    tail = log?.stdout;
  } else if (job.logPath) {
    tail = (await readFile(job.logPath, "utf8").catch(() => "")).slice(-4000);
  }
  return { ...job, ...(tail !== undefined ? { tail } : {}) };
}

export async function stopGpuJob(
  id: string,
  sessionId: string,
): Promise<{ job: GpuJobRecord } | { error: string }> {
  await ensureLoaded();
  const job = state.jobs.get(id);
  if (!job || job.sessionId !== sessionId)
    return { error: "no GPU job with that id in this session" };
  if (job.endedAt) return { error: `the job already ${job.state}` };
  job.stopping = true;
  await persist().catch(() => {});
  if (job.state === "running") {
    const sandbox = await machineFor(job);
    if (sandbox) await killRemote(sandbox, job);
    ensurePolling();
  }
  return { job };
}

// ── Files back from the machine ─────────────────────────────────────────

interface MachineFile {
  /** Absolute path on the machine. */
  remote: string;
  /** Where it goes under the host directory. */
  rel: string;
  size: number;
}

/** A relative path that stays inside the directory it is joined to. */
export function safeRelativePath(rel: string): string | null {
  if (!rel || rel.startsWith("/") || /[\0\\]/.test(rel)) return null;
  const parts = rel.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join(sep);
}

/** Regular files under `root` on the machine, with sizes. */
async function listMachineFiles(
  sandbox: Sandbox,
  root: string,
): Promise<MachineFile[]> {
  const listed = await sandbox.exec(
    [
      "bash",
      "-c",
      `cd ${shellWord(root)} 2>/dev/null || exit 0; find . -type f -printf '%s\\t%P\\0' | base64 -w0`,
    ],
    { timeoutMs: 60_000 },
  );
  if (listed.exitCode !== 0)
    throw new Error((listed.stderr || listed.stdout).trim().slice(0, 200));
  return parseMachineFileList(
    Buffer.from(listed.stdout.trim(), "base64").toString("utf8"),
    root,
  );
}

/** `find -printf '%s\t%P\0'` output as files, sorted by path. */
export function parseMachineFileList(
  text: string,
  root: string,
): MachineFile[] {
  const files: MachineFile[] = [];
  for (const entry of text.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const size = Number(entry.slice(0, tab));
    const rel = entry.slice(tab + 1);
    if (!Number.isFinite(size) || !rel) continue;
    files.push({ remote: posix.join(root, rel), rel, size });
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Copy files from the machine to `hostDir`, in order, until `maxBytes` or
 * `maxFiles`: base64 over exec in 4 MiB chunks, so binary files (a PNG)
 * arrive intact. Only directories and regular files are created here, and
 * every path is checked to stay inside `hostDir`.
 */
async function copyMachineFiles(
  sandbox: Sandbox,
  files: MachineFile[],
  hostDir: string,
  limits: { maxBytes: number; maxFiles: number },
): Promise<{ copied: string[]; skipped: number; skippedBytes: number }> {
  const copied: string[] = [];
  let skipped = 0;
  let skippedBytes = 0;
  let total = 0;
  for (const file of files) {
    const rel = safeRelativePath(file.rel);
    if (
      !rel ||
      copied.length >= limits.maxFiles ||
      total + file.size > limits.maxBytes
    ) {
      skipped++;
      skippedBytes += file.size;
      continue;
    }
    const dest = join(hostDir, rel);
    await mkdir(dirname(dest), { recursive: true });
    const handle = await open(dest, "w", 0o600);
    try {
      for (let mib = 0; mib * 1024 * 1024 < file.size; mib += COPY_CHUNK_MIB) {
        const chunk = await sandbox.exec(
          [
            "bash",
            "-c",
            `dd if=${shellWord(file.remote)} bs=1M skip=${mib} count=${COPY_CHUNK_MIB} status=none | base64 -w0`,
          ],
          { timeoutMs: 120_000 },
        );
        if (chunk.exitCode !== 0)
          throw new Error(
            `could not read ${file.remote}: ${(chunk.stderr || chunk.stdout).trim().slice(0, 200)}`,
          );
        await handle.write(Buffer.from(chunk.stdout.trim(), "base64"));
      }
    } finally {
      await handle.close();
    }
    total += file.size;
    copied.push(dest);
  }
  return { copied, skipped, skippedBytes };
}

function megabytes(bytes: number): string {
  return `${Math.max(0.1, Math.round(bytes / 1024 / 102.4) / 10)} MB`;
}

/** The job's host directory: `<session scratch>/gpu-jobs/<id>/`. */
export function gpuJobHostDir(
  job: Pick<GpuJobRecord, "id" | "sessionId">,
): string {
  return join(hostSessionScratchDir(job.sessionId), "gpu-jobs", job.id);
}

/** Copy `$OPENSESSION_JOB_OUTPUT` to the job's host directory. */
async function collectOutputs(
  sandbox: Sandbox,
  job: GpuJobRecord,
): Promise<void> {
  const files = await listMachineFiles(
    sandbox,
    `${REMOTE_ROOT}/${job.id}/output`,
  );
  if (!files.length) return;
  const dir = gpuJobHostDir(job);
  const { copied, skipped, skippedBytes } = await copyMachineFiles(
    sandbox,
    files,
    dir,
    { maxBytes: MAX_GPU_JOB_OUTPUT_BYTES, maxFiles: MAX_GPU_JOB_OUTPUT_FILES },
  );
  job.outputDir = dir;
  job.outputFiles = copied.length;
  if (skipped)
    job.outputNote = `${skipped} output file${skipped === 1 ? "" : "s"} (${megabytes(skippedBytes)}) did not fit the ${MAX_GPU_JOB_OUTPUT_BYTES / 1024 / 1024} MB / ${MAX_GPU_JOB_OUTPUT_FILES} file cap and stayed on the machine in ${REMOTE_ROOT}/${job.id}/output until its next job.`;
}

// ── Commands on a running job's machine ─────────────────────────────────

export interface GpuExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Host paths of the fetched files. */
  files?: string[];
  note?: string;
  /** With `sync`: what was landed before the command ran. */
  sync?: GpuJobSync;
}

function keepEnd(text: string, bytes: number): string {
  return text.length > bytes
    ? `[first ${text.length - bytes} characters dropped]\n${text.slice(-bytes)}`
    : text;
}

/**
 * Run a command on the machine of a running job, beside it: same machine,
 * same processes and files, same environment as the job's own command
 * (credentials, identity, `$OPENSESSION_JOB_OUTPUT`), from the repository
 * root. `fetch` copies machine files (a screenshot) to
 * `<session scratch>/gpu-jobs/<id>/fetched/` afterwards.
 */
export async function execOnGpuJob(
  id: string,
  sessionId: string,
  input: {
    command: string;
    timeoutSeconds?: number;
    fetch?: string[];
    sync?: boolean;
  },
): Promise<GpuExecResult | { error: string }> {
  await ensureLoaded();
  const job = state.jobs.get(id);
  if (!job || job.sessionId !== sessionId)
    return { error: "no GPU job with that id in this session" };
  if (job.state === "preparing")
    return {
      error:
        "the job's machine is still being prepared; try again when gpu_job_status says running",
    };
  if (job.state !== "running")
    return {
      error: `the job already ${ENDED_WORDS[job.state]}; gpu_exec runs only beside a running job`,
    };
  const sandbox = await machineFor(job);
  if (!sandbox) return { error: "the job's GPU machine is not running" };
  if ((input.fetch?.length ?? 0) > MAX_GPU_EXEC_FETCH_FILES)
    return { error: `fetch at most ${MAX_GPU_EXEC_FETCH_FILES} files` };
  const [{ findSessionAsync }, { getRepo }, { noteSandboxActivity }] =
    await Promise.all([
      import("./session-cache"),
      import("./worktree"),
      import("./sandbox/idle"),
    ]);
  const session = await findSessionAsync(sessionId);
  if (!session?.repo) return { error: "no such session" };
  const repo = getRepo(session.repo);
  noteSandboxActivity({ sandboxId: sandbox.id, sessionId }, "agent");
  let sync: GpuJobSync | undefined;
  if (input.sync) {
    try {
      const synced = await syncGpuJob(job, session, sandbox);
      if ("error" in synced) return synced;
      sync = synced;
    } catch (error) {
      return {
        error: `could not land the workspace, so the command did not run: ${(error instanceof Error ? error.message : String(error)).slice(0, 400)}`,
      };
    }
  }
  const seconds = Math.min(
    Math.max(1, input.timeoutSeconds ?? DEFAULT_GPU_EXEC_SECONDS),
    MAX_GPU_EXEC_SECONDS,
  );
  const result = await sandbox.exec(["bash", "-c", input.command], {
    env: {
      ...(await gpuJobEnv(repo)),
      ...jobVariables(job),
      ...(await jobIdentityEnv(job, sandbox.id, repo.id)),
    },
    timeoutMs: seconds * 1000,
  });
  const out: GpuExecResult = {
    exitCode: result.exitCode,
    stdout: keepEnd(result.stdout, EXEC_STDOUT_BYTES),
    stderr: keepEnd(result.stderr, EXEC_STDERR_BYTES),
    ...(sync ? { sync } : {}),
  };
  if (result.exitCode === 124)
    out.note = `The command did not finish within ${seconds}s. Start long-lived processes detached (setsid nohup … > file 2>&1 &) so the call returns.`;
  if (input.fetch?.length) {
    const output = jobVariables(job).OPENSESSION_JOB_OUTPUT!;
    const targets = input.fetch.map((raw) => {
      // The one variable a fetch path may name; nothing else is expanded.
      const path = raw.replace(
        /^\$(?:\{OPENSESSION_JOB_OUTPUT\}|OPENSESSION_JOB_OUTPUT\b)/,
        output,
      );
      return posix.isAbsolute(path)
        ? posix.normalize(path)
        : posix.join(sandbox.cwd, path);
    });
    const sized = await sandbox.exec(
      [
        "bash",
        "-c",
        `for p in "$@"; do if test -f "$p"; then printf '%s\\t%s\\0' "$(stat -Lc %s -- "$p")" "$p"; fi; done | base64 -w0`,
        "fetch",
        ...targets,
      ],
      { timeoutMs: 60_000 },
    );
    const found = parseMachineFileList(
      Buffer.from(sized.stdout.trim(), "base64").toString("utf8"),
      "/",
    );
    const used = new Set<string>();
    const files = found.map((file) => {
      let name = basename(file.rel);
      for (let n = 2; used.has(name); n++) name = `${n}-${basename(file.rel)}`;
      used.add(name);
      return { ...file, remote: file.rel, rel: name };
    });
    const { copied, skipped } = await copyMachineFiles(
      sandbox,
      files,
      join(gpuJobHostDir(job), "fetched"),
      {
        maxBytes: MAX_GPU_EXEC_FETCH_BYTES,
        maxFiles: MAX_GPU_EXEC_FETCH_FILES,
      },
    );
    out.files = copied;
    const missing = targets.length - found.length;
    if (missing || skipped)
      out.note = [
        out.note,
        missing
          ? `${missing} fetch path${missing === 1 ? " is" : "s are"} not a file on the machine.`
          : "",
        skipped
          ? `${skipped} file${skipped === 1 ? "" : "s"} did not fit the ${MAX_GPU_EXEC_FETCH_BYTES / 1024 / 1024} MB cap.`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
  }
  return out;
}

// ── Machine lifecycle ────────────────────────────────────────────────────

/** The session's GPU machines (provider session keys) with a job on
 *  record, and the ones a job is preparing or running on. */
function sessionMachines(sessionId: string): {
  all: Set<string>;
  busy: Set<string>;
} {
  const all = new Set<string>(state.machines.get(sessionId));
  const busy = new Set<string>();
  for (const job of state.jobs.values())
    if (job.sessionId === sessionId) {
      all.add(gpuJobMachine(job));
      if (isActive(job)) busy.add(gpuJobMachine(job));
    }
  return { all, busy };
}

/** Sleep the session's GPU machines (archive), or the one `sandboxId` names
 *  (idle), skipping any a job runs on. Whether one was put to sleep. */
export async function sleepGpuMachine(
  sessionId: string,
  sandboxId?: string,
): Promise<boolean> {
  await ensureLoaded();
  const { getSandboxProvider } = await import("./sandbox");
  const provider = getSandboxProvider(GPU_JOB_PROVIDER);
  if (!provider.pause) return false;
  const { all, busy } = sessionMachines(sessionId);
  all.add(gpuMachineSessionId(sessionId));
  let slept = false;
  for (const machine of all) {
    const id = await provider.machineFor?.(machine);
    if (!id || (sandboxId && id !== sandboxId)) continue;
    if (busy.has(machine)) continue;
    await provider.pause(id);
    console.log(`[gpu-jobs] ${sessionId}: GPU machine ${id} asleep`);
    slept = true;
  }
  return slept;
}

/** Destroy the session's GPU machines (the session was deleted). */
export async function retireGpuMachine(sessionId: string): Promise<void> {
  await ensureLoaded();
  if (!sessionHasGpuMachine(sessionId)) return;
  const machines = sessionMachines(sessionId).all;
  for (const job of state.jobs.values())
    if (job.sessionId === sessionId && !job.endedAt) {
      job.notified = true;
      Object.assign(job, {
        state: "stopped",
        endedAt: new Date().toISOString(),
      });
    }
  const { teardownRecordedSandbox } = await import("./session-sandbox");
  const ids = await Promise.all(
    [...machines].map((machine) =>
      teardownRecordedSandbox(machine, { provider: GPU_JOB_PROVIDER }),
    ),
  );
  for (const [jobId, job] of state.jobs)
    if (job.sessionId === sessionId) state.jobs.delete(jobId);
  state.machines.delete(sessionId);
  await persist().catch(() => {});
  for (const id of ids)
    if (id) console.log(`[gpu-jobs] ${sessionId}: GPU machine ${id} retired`);
}

// ── Boot ─────────────────────────────────────────────────────────────────

/** Reattach running jobs; settle jobs a restart caught mid-preparation.
 *  Idempotent; called once from boot. */
export async function startGpuJobs(): Promise<void> {
  await ensureLoaded();
  let pending = false;
  for (const job of state.jobs.values()) {
    if (job.state === "preparing" && !state.preparing.has(job.id)) {
      await settle(job, {
        state: "failed",
        error:
          "Open Session restarted while the GPU machine was being prepared; start the job again",
      });
    } else if (job.state === "running" || (job.endedAt && !job.notified))
      pending = true;
  }
  if (pending) ensurePolling();
  // The idle timers live in memory: a machine whose last job ended shortly
  // before this restart sleeps on schedule instead of at the provider's
  // backstop. One whose job is still running is noted by the poll.
  const lastEnded = new Map<string, GpuJobRecord>();
  const busy = new Set<string>();
  for (const job of state.jobs.values()) {
    if (!job.sandboxId) continue;
    if (isActive(job)) busy.add(job.sandboxId);
    else if (job.endedAt) {
      const seen = lastEnded.get(job.sandboxId);
      if (!seen || seen.endedAt! < job.endedAt)
        lastEnded.set(job.sandboxId, job);
    }
  }
  if (!lastEnded.size) return;
  const { noteSandboxActivity } = await import("./sandbox/idle");
  for (const job of lastEnded.values())
    if (!busy.has(job.sandboxId!))
      noteSandboxActivity(
        { sandboxId: job.sandboxId!, sessionId: job.sessionId },
        "agent",
        Date.parse(job.endedAt!),
      );
}

/** Test seam. */
export function __resetGpuJobsForTest(): void {
  if (state.polling) clearInterval(state.polling);
  state.jobs.clear();
  state.machines.clear();
  state.preparing.clear();
  state.polling = undefined;
  state.loaded = Promise.resolve();
}

/** Test seam: the machine-side file handling, against any Sandbox. */
export const __gpuJobsMachineFilesForTest = {
  stageFiles,
  removeStaged,
  collectOutputs,
  remoteDir: (id: string) => `${REMOTE_ROOT}/${id}`,
};
