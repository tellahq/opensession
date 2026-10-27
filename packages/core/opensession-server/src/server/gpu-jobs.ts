/**
 * GPU jobs: run one command on a GPU machine for a session that has none.
 *
 * A session on this machine (or in a CPU Sandbox) keeps its workspace and
 * its agent where they are. When it needs a GPU (a repository's GPU test
 * suite, a GPU render), `run_gpu_job` (gpu-mcp.ts) checkpoints the session's
 * work, wakes or creates the session's GPU machine on Modal (keyed
 * `<session>--gpu`, like a Portal Sandbox's `<session>--portals`), lands the
 * checkpoint there, and starts the command detached inside the machine. The
 * job writes its log and exit code to files in the machine, so a deploy or a
 * crash of this server does not stop it: the registry here is persisted and
 * reattached at boot. When the job ends, the session is woken with how it
 * ended and the tail of its output, exactly once.
 *
 * The machine is kept between jobs so builds stay incremental. The idle
 * timers (sandbox/idle.ts) put it to sleep a few minutes after the last job,
 * and archiving or deleting the session sleeps or destroys it.
 *
 * A repository declares its GPU jobs in `.agents/gpu-jobs.json`:
 *
 *   { "jobs": { "render-engine-gpu-tests": {
 *       "description": "…", "command": "scripts/…sh", "gpu": "T4",
 *       "timeoutMinutes": 60 } } }
 *
 * Cross-session state is this module's own registry file, loaded once; no
 * session files are scanned. All I/O is asynchronous.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "./paths";
import { writeJsonAtomicAsync } from "./shared/atomic-write";
import { hostSessionScratchDir } from "./session-scratch";
import type { UnifiedSession } from "./types";
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

export function gpuMachineSessionId(sessionId: string): string {
  return `${sessionId}${GPU_MACHINE_SUFFIX}`;
}

/** Whether a provider Sandbox id names a session's GPU job machine. */
export function isGpuJobMachine(sandboxId: string): boolean {
  return sandboxId.endsWith(GPU_MACHINE_SUFFIX);
}

/** The session a GPU job machine belongs to (`md-<session>--gpu`). */
export function gpuMachineOwner(sandboxId: string): string | null {
  if (!isGpuJobMachine(sandboxId)) return null;
  const base = sandboxId.slice(0, -GPU_MACHINE_SUFFIX.length);
  return base.startsWith("md-") ? base.slice(3) : base;
}

// ── Repository declarations ──────────────────────────────────────────────

export interface RepoGpuJob {
  description?: string;
  command: string;
  gpu: SandboxGpu;
  timeoutMinutes: number;
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
  /** The Sandbox id of the session's GPU machine once it is up. */
  sandboxId?: string;
  /** Commit the job ran on, and whether it included uncommitted work. */
  commit?: string;
  note?: string;
  startedBy?: string;
  notified?: boolean;
  stopping?: boolean;
  /** Full log copied to this server when the job ended. */
  logPath?: string;
}

type Registry = { jobs: GpuJobRecord[] };
type GpuJobsState = {
  jobs: Map<string, GpuJobRecord>;
  loaded?: Promise<void>;
  polling?: ReturnType<typeof setInterval>;
  preparing: Set<string>;
};
const g = globalThis as { __gpuJobs?: GpuJobsState };
const state: GpuJobsState = (g.__gpuJobs ??= {
  jobs: new Map(),
  preparing: new Set(),
});

function registryPath(): string {
  return stateDir("gpu-jobs.json");
}

function ensureLoaded(): Promise<void> {
  state.loaded ??= (async () => {
    const text = await readFile(registryPath(), "utf8").catch(() => "");
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as Registry;
      for (const job of parsed.jobs || []) state.jobs.set(job.id, job);
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
  } satisfies Registry);
}

export async function listGpuJobs(sessionId: string): Promise<GpuJobRecord[]> {
  await ensureLoaded();
  return [...state.jobs.values()]
    .filter((job) => job.sessionId === sessionId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Whether a job is preparing or running on the session's GPU machine. */
export function gpuJobActive(sessionId: string): boolean {
  for (const job of state.jobs.values())
    if (
      job.sessionId === sessionId &&
      (job.state === "preparing" || job.state === "running")
    )
      return true;
  return false;
}

/** Sessions that may hold a GPU machine (any job on record). */
export function sessionHasGpuMachine(sessionId: string): boolean {
  for (const job of state.jobs.values())
    if (job.sessionId === sessionId) return true;
  return false;
}

// ── Starting ─────────────────────────────────────────────────────────────

export interface StartGpuJobInput {
  sessionId: string;
  title: string;
  command: string;
  gpu: SandboxGpu;
  timeoutMinutes: number;
  startedBy?: string;
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
  if (gpuJobActive(session.id))
    return {
      error:
        "a GPU job is already running for this session; wait for it, or stop it with stop_gpu_job",
    };
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
    startedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + minutes * 60_000).toISOString(),
    ...(input.startedBy ? { startedBy: input.startedBy } : {}),
  };
  state.jobs.set(job.id, job);
  await persist();
  state.preparing.add(job.id);
  void prepareAndLaunch(job, session)
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
): Promise<void> {
  const [
    { getSandboxProvider },
    { ensureSandboxWaitingForCapacity },
    checkpoint,
    { getRepo },
    { noteSandboxActivity },
  ] = await Promise.all([
    import("./sandbox"),
    import("./sandbox/reliability"),
    import("./sandbox/checkpoint"),
    import("./worktree"),
    import("./sandbox/idle"),
  ]);
  const repo = getRepo(session.repo);

  // 1. The session's work, uncommitted changes included.
  let outcome: Awaited<ReturnType<typeof checkpoint.checkpointHostWorkspace>>;
  if (session.sandbox?.provider) {
    const { activeSandboxFor } = await import("./session-sandbox");
    outcome = await checkpoint.checkpointSessionWorkspace(session, (current) =>
      activeSandboxFor(current as UnifiedSession, { wake: true }),
    );
  } else {
    outcome = await checkpoint.checkpointHostWorkspace(
      session,
      session.worktreeDir!,
    );
  }
  const landed = outcome.state === "skipped" ? null : outcome.checkpoint;
  const branch = landed?.branch || session.branch || repo.defaultBranch;
  if (outcome.state === "skipped")
    job.note = `Ran on origin/${branch}: the workspace could not be checkpointed (${outcome.reason}), so uncommitted changes are not included.`;

  // 2. The session's GPU machine: woken, created, or switched to this GPU.
  const provider = getSandboxProvider(GPU_JOB_PROVIDER);
  const machineSession = gpuMachineSessionId(session.id);
  const existing = provider.machineFor?.(machineSession);
  const sandbox = await ensureSandboxWaitingForCapacity(provider, {
    sessionId: machineSession,
    // The machine works for the owning session: its repository and its
    // trust profile (run_gpu_job is interactive-only) scope the workload
    // identity every command on it gets.
    repo: repo.id,
    trustProfile: "interactive",
    branch,
    mode: "code",
    gpu: job.gpu,
    ...(!existing && landed
      ? {
          restoreCheckpoint: {
            ref: landed.ref,
            commit: landed.commit,
            branch: landed.branch,
          },
        }
      : {}),
  });
  job.sandboxId = sandbox.id;
  noteSandboxActivity(
    { sandboxId: sandbox.id, sessionId: session.id },
    "agent",
  );
  const env = await gpuJobEnv(repo);
  if (existing) {
    if (landed)
      await checkpoint.landCheckpointInSandbox(repo.id, sandbox, landed);
    else {
      const sync = await sandbox.exec(
        [
          "bash",
          "-c",
          `git fetch -q origin ${shellWord(branch)} && git reset -q --hard FETCH_HEAD && git clean -fdq`,
        ],
        { env, timeoutMs: 5 * 60_000 },
      );
      if (sync.exitCode !== 0)
        throw new Error(
          `could not update the GPU machine to origin/${branch}: ${(sync.stderr || sync.stdout).trim().slice(0, 300)}`,
        );
    }
  }
  const head = await sandbox.exec(["git", "rev-parse", "HEAD"]);
  if (head.exitCode === 0) job.commit = head.stdout.trim();
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
    `mkdir -p ${dir}`,
    `printf %s ${script} | base64 -d > ${dir}/command.sh`,
    `cat > ${dir}/wrap.sh <<'WRAP'`,
    `cd "$OPENSESSION_GPU_JOB_CWD"`,
    `timeout --signal=TERM --kill-after=30 ${deadlineSeconds} bash ${dir}/command.sh > ${dir}/log 2>&1`,
    `echo $? > ${dir}/exit.tmp && mv ${dir}/exit.tmp ${dir}/exit`,
    `WRAP`,
    `cd ${shellWord(sandbox.cwd)}`,
    `OPENSESSION_GPU_JOB_CWD="$PWD" nohup setsid bash ${dir}/wrap.sh >/dev/null 2>&1 < /dev/null &`,
    `echo $! > ${dir}/pid`,
  ].join("\n");
  const started = await sandbox.exec(["bash", "-c", launch], {
    env: {
      ...env,
      OPENSESSION_GPU: job.gpu,
      OPENSESSION_GPU_JOB_ID: job.id,
      RUNNER_TEMP: "/tmp",
      CI: "1",
    },
    timeoutMs: 60_000,
  });
  if (started.exitCode !== 0)
    throw new Error(
      `could not start the job: ${(started.stderr || started.stdout).trim().slice(0, 300)}`,
    );
  job.state = "running";
  await persist();
  console.log(
    `[gpu-jobs] ${job.sessionId}: ${job.id} running on ${job.gpu} in ${sandbox.id}`,
  );
  ensurePolling();
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
  touchRemoteState(GPU_JOB_PROVIDER, sandbox.id);
  const dir = `${REMOTE_ROOT}/${job.id}`;
  const probe = await sandbox.exec(
    ["bash", "-c", `cat ${dir}/exit 2>/dev/null || echo running`],
    { timeoutMs: 30_000 },
  );
  if (probe.exitCode !== 0) return;
  const out = probe.stdout.trim();
  if (out === "running") {
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

async function killRemote(sandbox: Sandbox, job: GpuJobRecord): Promise<void> {
  const dir = `${REMOTE_ROOT}/${job.id}`;
  await sandbox
    .exec(
      [
        "bash",
        "-c",
        `p=$(cat ${dir}/pid 2>/dev/null) && kill -TERM -- -"$p" 2>/dev/null; sleep 5; kill -KILL -- -"$p" 2>/dev/null; true`,
      ],
      { timeoutMs: 30_000 },
    )
    .catch(() => {});
}

async function settle(
  job: GpuJobRecord,
  patch: Partial<GpuJobRecord>,
  sandbox?: Sandbox,
): Promise<void> {
  if (job.endedAt) return;
  Object.assign(job, patch, { endedAt: new Date().toISOString() });
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
    (job.commit ? ` It ran on ${job.commit.slice(0, 12)}.` : "") +
    (job.note ? `\n${job.note}` : "") +
    (job.error ? `\nError: ${job.error}` : "") +
    (job.logPath ? `\nFull log: ${job.logPath}` : "") +
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

// ── Machine lifecycle ────────────────────────────────────────────────────

/** Sleep the session's GPU machine (archive, idle) unless a job runs. */
export async function sleepGpuMachine(sessionId: string): Promise<boolean> {
  await ensureLoaded();
  if (gpuJobActive(sessionId)) return false;
  const { getSandboxProvider } = await import("./sandbox");
  const provider = getSandboxProvider(GPU_JOB_PROVIDER);
  const id = provider.machineFor?.(gpuMachineSessionId(sessionId));
  if (!id || !provider.pause) return false;
  await provider.pause(id);
  console.log(`[gpu-jobs] ${sessionId}: GPU machine ${id} asleep`);
  return true;
}

/** Destroy the session's GPU machine (the session was deleted). */
export async function retireGpuMachine(sessionId: string): Promise<void> {
  await ensureLoaded();
  if (!sessionHasGpuMachine(sessionId)) return;
  for (const job of state.jobs.values())
    if (job.sessionId === sessionId && !job.endedAt) {
      job.notified = true;
      Object.assign(job, {
        state: "stopped",
        endedAt: new Date().toISOString(),
      });
    }
  const { teardownRecordedSandbox } = await import("./session-sandbox");
  const id = await teardownRecordedSandbox(gpuMachineSessionId(sessionId), {
    provider: GPU_JOB_PROVIDER,
  });
  for (const [jobId, job] of state.jobs)
    if (job.sessionId === sessionId) state.jobs.delete(jobId);
  await persist().catch(() => {});
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
  for (const job of state.jobs.values())
    if (job.sandboxId && job.endedAt) {
      const seen = lastEnded.get(job.sessionId);
      if (!seen || seen.endedAt! < job.endedAt)
        lastEnded.set(job.sessionId, job);
    }
  if (!lastEnded.size) return;
  const { noteSandboxActivity } = await import("./sandbox/idle");
  for (const job of lastEnded.values())
    if (!gpuJobActive(job.sessionId))
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
  state.preparing.clear();
  state.polling = undefined;
  state.loaded = Promise.resolve();
}
