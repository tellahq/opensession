/**
 * DockerProvider — the Docker sandbox backend (docs/self-hosting-sandboxes.md;
 * "bind-mount mode" is the default).
 *
 * One long-lived container per session (`bks-sbx-<sessionId>`, image
 * `opensession-runner:latest` — see deploy/sandbox/), kept alive across turns so
 * engine session state (~/.claude history, codex rollouts) and dev servers
 * survive. A run is the SAME runner-host entry the systemd path uses
 * (src/runner-host/host.ts), `docker exec`'d into the container; opensession
 * talks to it over the host's unix socket in a bind-mounted per-session run
 * dir, reusing host-client's HostHandle (NDJSON protocol, ask proxying,
 * reconnect, respawn-to-resume) with a Docker HostLauncher. Because the
 * socket + spec/meta/journal files live on a bind mount, a restarted
 * opensession reattaches to a still-running in-container run exactly like it
 * would to a systemd host — that's what makes restart-resume work.
 *
 * Mount design (all deliberate, see also deploy/sandbox/README.md):
 *
 *  - NO volume at /home/ubuntu. The image bakes the claude CLI and the runner
 *    bundle under /home/ubuntu; a $HOME volume would shadow both (and copy the
 *    ~223MB vendored codex binary per session). Engine state persists in two
 *    named volumes mounted at exactly ~/.claude and ~/.codex.
 *  - The session worktree is bind-mounted rw at its IDENTICAL host path, so
 *    @-mention search, diff, git status/push and previews keep working
 *    host-side with zero changes.
 *  - Git worktrees are not self-contained: `<worktree>/.git` is a file whose
 *    gitdir points at `<main-checkout>/.git/worktrees/<name>` by absolute
 *    path, and objects/refs live in the main checkout's .git. So the main
 *    checkout's `.git` directory is ALSO bind-mounted rw at its identical
 *    path (resolved via `git rev-parse --git-common-dir`, never guessed).
 *    Mounting the shared .git rw is an accepted Phase 1 tradeoff: a sandboxed
 *    session can touch other worktrees' refs — same trust level as host runs
 *    today. Phase 2's volume-owned workspaces remove it.
 *  - ~/.claude/projects/<munged-cwd> (the engine transcript dir for THIS cwd)
 *    is bind-mounted from the host over the ~/.claude volume, so the session
 *    viewer's transcript tail, parseTranscript handoffs, and resume-continuity
 *    with host runs of the same worktree all keep working. Narrow on purpose:
 *    only this worktree's transcript dir, not the host's whole ~/.claude.
 *  - The run-rpc socket (~/.opensession-sessions/opensession-rpc.sock) is
 *    bind-mounted (a socket can't be mounted ro) so the opensession-* stdio
 *    proxies work from inside. Caveat: if opensession rebinds the socket (real
 *    restart), the bind still points at the old inode until the CONTAINER is
 *    restarted — the idle-stop/start cycle self-heals this, and mcp-proxy
 *    retries until then.
 *  - ~/.ssh, ~/.gitconfig, ~/.config/gh, mcp-config.json and
 *    ~/.opensession-claude-accounts.json are mounted read-only for git/gh/PR
 *    parity and in-container account-pool selection. Interactive sessions
 *    only — the same ambient trust those runs already have on the host today.
 *    Automations are NOT sandboxed in Phase 1 (the wiring refuses them), so
 *    none of this is reachable from untrusted prompt text.
 *  - ~/.opensession-audit is mounted rw so in-container runs land in the same
 *    audit log stream as host runs (appendFileSync, O_APPEND).
 *
 * Later additions (docs/self-hosting-sandboxes.md):
 *  - VOLUME workspaces (config `workspace: "volume"`, new sandboxes only): the
 *    workspace is a per-session named volume (`<name>-ws`) mounted at the
 *    session's canonical worktree path, cloned from the repo's origin INSIDE
 *    the container (host creds mounted ro do the auth) — no host worktree at
 *    all. The mode is sticky per sandbox (recorded in the state file; a later
 *    config flip never re-mounts an existing workspace). destroy() removes the
 *    workspace volume — that data loss is the mode's contract: push your work.
 *    Host-side reads (diff/status/@-mentions) reach it through the
 *    workspace-exec choke point. A local-path origin URL (scratch/test repos)
 *    is mounted ro so the in-container clone can read it; real repos clone
 *    over ssh/https. Attached repos are rejected in volume mode.
 *  - Attached-repo mounts (bind mode): each attachedDirs entry is bind-mounted
 *    rw at its identical path plus its repo's common .git — a changed set
 *    recreates the container on the next ensure (mounts are create-time).
 *  - Preview ports: config `previewPorts` publishes each listed container port
 *    to a random loopback host port at create time (docker -p 127.0.0.1::p);
 *    `ports()` reads the live mapping for preview.ts's Caddy routing.
 *
 * Snapshots (config `snapshots: { enabled: true, … }` — background-agents'
 * warm-restore pattern adapted to Docker; default OFF):
 *  - On the idle-stop sweep (and only while no run is active), the container is
 *    `docker commit`ed to `bks-snap-<sessionId>:t<millis>` + `:latest` BEFORE
 *    the stop; a snapshot failure logs and never blocks the stop. At most
 *    `maxPerSession` timestamped snapshots are kept per session (older ones
 *    deleted right after each commit).
 *  - ensure() for a session whose container is GONE (docker rm'd, host reboot
 *    with pruning, …) creates the new container FROM the newest snapshot image
 *    instead of the base image — same mounts/volumes logic, different image.
 *  - **What a snapshot actually captures — read this before expecting more:**
 *    `docker commit` records the container LAYER only. Engine state (~/.claude,
 *    ~/.codex) lives on named volumes and the workspace is a bind mount (bind
 *    mode) or the `-ws` named volume (volume mode) — none of that is in the
 *    image. The snapshot mainly captures installed deps, apt packages, and
 *    global caches written to the container layer between runs. Never expect
 *    workspace or session state in a snapshot; volumes carry those across the
 *    rm/recreate exactly as before.
 *  - Volume-mode workspaces get a "quick sync" after a snapshot restore
 *    (`git fetch origin` + `git status` inside — NEVER a reset/checkout; refs
 *    freshen, work is untouched) when `quickSyncOnRestore` (default true).
 *  - destroy() also removes the session's snapshot images, and the idle sweep
 *    prunes `bks-snap-*` images orphaned by sessions deleted while their
 *    sandbox was already gone (state file + container + session file all
 *    absent). `docker image prune` is deliberately NOT run here.
 *
 * Known Phase 1 caveats (documented, not chased):
 *  - External MCP servers from mcp-config.json now spawn INSIDE the container;
 *    ones with host-only deps won't start there.
 *  - Codex models: codex account homes (CODEX_HOME dirs) are not mounted, so
 *    codex runs inside a sandbox have no account pool yet. Claude first.
 *  - `aws: true` runs can't mint creds inside the container (IMDS is blocked
 *    by the DOCKER-USER rule — deploy/sandbox/setup-host.sh); getAgentAwsEnv
 *    degrades to no AWS env.
 *
 * Runner internals: nothing here hot-reloads meaningfully into live runs —
 * wire-ups need a real restart (see CLAUDE.md "Hot reload & restarts").
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "fs";
import { dirname, resolve as resolvePath } from "path";
import { homeDir, OPENSESSION_SESSIONS_DIR } from "../paths";
import { stateDir } from "../paths";
import {
  journalSet,
  journalClear,
  journalClearIfLineage,
  journalRecordAbnormalCompletion,
  type ActiveRunRecord,
} from "../run-journal";
import { shouldPersistModelSwitch, type StreamEvent } from "../run-events";
import { recoveryKind, restartContinuationPrompt } from "../agent-runner";
import { modelSupportsSteer, providerFor } from "../models";
import {
  hostRunBusy,
  hostSteer,
  hostInterruptSteer,
  hostCancel,
} from "../host-registry";
import { registerRunToken, unregisterRunToken } from "../run-rpc";
import { writeJsonAtomic } from "../shared/atomic-write";
import {
  HostHandle,
  HostLaunchNotDispatchedError,
  reconcileUncertainHostEvents,
  type HandleCallbacks,
  type HostLauncher,
} from "../host-client";
import {
  registerRunWsHost,
  unregisterRunWsHost,
  runWsConnector,
} from "../run-ws";
import { getTranscriptPath } from "../sessions";
import { listCodexAccounts } from "../codex-accounts";
import {
  dropSandboxPreviewRoutes,
  externalPreviewCommandDirs,
} from "../preview";
import { configuredPaths } from "../config";
import { codeStorageConfig } from "../config";
import { authedRemoteUrl } from "../codestorage/auth";
import { parseCsRemote } from "../codestorage/remote";
import { redactUrl } from "../shared/redact";
import { createWorkloadIdentityEnv } from "../workload-identity";
import {
  REPOS,
  getRepo,
  repoForPath,
  worktreePathFor,
  type Repo,
} from "../worktree";
import { LocalProvider } from "./local";
import {
  DEFAULT_SANDBOX_PREVIEW_PORTS,
  sandboxConfig,
  sandboxSnapshots,
  sandboxTransport,
  sandboxCallbackBaseUrl,
  type SandboxTransport,
} from "./config";
import { decideSandboxHostRecovery } from "./recovery";
import {
  HOST_SPEC_NAME,
  HOST_META_NAME,
  HOST_JOURNAL_NAME,
  HOST_LOG_NAME,
  HOST_ENTRY,
  rpcSocketPath,
  type RunHostSpec,
  type RunHostMeta,
} from "../../runner-host/protocol";
import type {
  ExecOpts,
  ExecResult,
  PortMap,
  RunHandle,
  RunHandleCallbacks,
  Sandbox,
  SandboxProvider,
  SandboxSessionSpec,
  SandboxStatus,
} from "./provider";

const HOME = homeDir();
const CONTAINER_PREFIX = "bks-sbx-";
const DEFAULT_IMAGE = "opensession-runner:latest";
const DEFAULT_CPUS = 4;
const DEFAULT_MEMORY = "8g";
const DEFAULT_IDLE_STOP_MINUTES = 30;
const SWEEP_INTERVAL_MS = 5 * 60_000;
/** Pre-published preview range: every sandbox container publishes these
 *  container ports to random loopback host ports at create, so a dev server
 *  started AFTER creation (ports are create-time-only in docker) still has a
 *  routable port — startSandboxPreview allocates from this set. Config
 *  `previewPorts` overrides; exhaustion = widen it + recreate the container. */
/** Cap for a `.agents/setup` lifecycle run (one-shot, per workspace). */
const SETUP_TIMEOUT_MS = 10 * 60_000;

/** Provider-owned state, one file per sandbox — lets get() reattach (or fully
 *  recreate a removed container with identical mounts) after any restart. */
const STATE_DIR = `${OPENSESSION_SESSIONS_DIR}/sandboxes`;
/** Per-session run dirs (spec/meta/journal/socket/log per run), bind-mounted
 *  into the session's container at the identical path. */
const RUNS_BASE = `${OPENSESSION_SESSIONS_DIR}/sandbox-runs`;

interface DockerSandboxState {
  sandboxId: string;
  sessionId: string;
  cwd: string;
  image: string;
  createdAt: string;
  /** Last run start/end — drives the idle-stop sweep. */
  lastActivityAt: string;
  /** How the workspace is materialized. Sticky for the sandbox's lifetime;
   *  absent (pre-Phase-2 state files) = "bind". */
  workspace?: "bind" | "volume";
  /** Repo id + branch, recorded so get() can recreate a volume workspace's
   *  container (the clone source and checkout) after a docker rm. */
  repoId?: string;
  branch?: string;
  /** Attached-repo dirs mounted at create time (bind mode) — a differing set
   *  on the next ensure() recreates the container with fresh mounts. */
  attachedDirs?: string[];
  /** Run transport the container was created for. "ws" containers don't mount
   *  the run-rpc socket (proxies dial /rpc-ws instead); a config
   *  flip recreates the container on the next ensure (mounts are create-time).
   *  Absent (pre-Phase-3 state files) = "socket". */
  transport?: SandboxTransport;
  /** Whether the `.agents/setup` lifecycle hook already ran (or was
   *  skipped — snapshot restore / script absent). One-shot per sandbox. */
  setupRan?: boolean;
  /** How the current container came to exist: fresh create vs snapshot
   *  restore. Lifecycle scripts receive it as OPENSESSION_BOOT_MODE. */
  bootMode?: "fresh" | "snapshot-restore";
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^[^a-zA-Z0-9]+/, "");
}

export function containerNameFor(sessionId: string): string {
  return `${CONTAINER_PREFIX}${sanitizeName(sessionId)}`.slice(0, 100);
}

/** Snapshot image repo for a sandbox: `bks-snap-<sessionId>` (image repos must
 *  be lowercase, unlike container names). Derived from the container name so
 *  destroy() can clean images even when the state file is already gone. */
const SNAPSHOT_PREFIX = "bks-snap-";

export function snapshotRepoForSandbox(sandboxId: string): string {
  const sessionPart = sandboxId.startsWith(CONTAINER_PREFIX)
    ? sandboxId.slice(CONTAINER_PREFIX.length)
    : sanitizeName(sandboxId);
  return `${SNAPSHOT_PREFIX}${sessionPart.toLowerCase()}`.slice(0, 100);
}

function statePath(sandboxId: string): string {
  return `${STATE_DIR}/${sandboxId}.json`;
}

function readState(sandboxId: string): DockerSandboxState | null {
  try {
    if (!existsSync(statePath(sandboxId))) return null;
    return JSON.parse(readFileSync(statePath(sandboxId), "utf-8"));
  } catch {
    return null;
  }
}

function writeState(state: DockerSandboxState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeJsonAtomic(statePath(state.sandboxId), state);
}

function touchStateActivity(sandboxId: string): void {
  const s = readState(sandboxId);
  if (s) {
    s.lastActivityAt = new Date().toISOString();
    writeState(s);
  }
}

/** Activity touch for callers outside this module (the Shell tab's terminal
 *  start counts as interaction — it resets the idle-stop clock like a run
 *  does; an OPEN shell deliberately doesn't hold the container awake). */
export function touchSandboxActivity(sandboxId: string): void {
  touchStateActivity(sandboxId);
}

function sessionRunsDir(sessionId: string): string {
  return `${RUNS_BASE}/${sanitizeName(sessionId)}`;
}

/** Run `docker <args>` (argv array — nothing is shell-interpolated). */
async function docker(
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<ExecResult> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts?.timeoutMs ?? 120_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function containerStatus(name: string): Promise<SandboxStatus> {
  const r = await docker(["inspect", "-f", "{{.State.Status}}", name]);
  if (r.exitCode !== 0) return "gone";
  return r.stdout.trim() === "running" ? "running" : "stopped";
}

/** Container status by name, for callers outside this module (the
 *  workspace-exec choke point checks "actually running" without starting). */
export function dockerContainerStatus(name: string): Promise<SandboxStatus> {
  return containerStatus(name);
}

/**
 * A raw in-container exec bound to `cwd` that NEVER starts a stopped
 * container (unlike Sandbox.exec) — the workspace-exec choke point uses it
 * for read surfaces, where waking a stopped sandbox just to run `git status`
 * would defeat the idle-stop policy. A container that stops between the
 * caller's status check and the exec simply returns a non-zero exit.
 */
export function rawDockerExec(container: string, cwd: string) {
  return (cmd: string[], opts?: ExecOpts): Promise<ExecResult> => {
    const envArgs = Object.entries(opts?.env || {}).flatMap(([k, v]) => [
      "-e",
      `${k}=${v}`,
    ]);
    return docker(["exec", "-w", cwd, ...envArgs, container, ...cmd]);
  };
}

async function ensureStarted(name: string): Promise<void> {
  const st = await containerStatus(name);
  if (st === "running") return;
  if (st === "gone")
    throw new Error(`sandbox container ${name} does not exist`);
  const r = await docker(["start", name]);
  if (r.exitCode !== 0) {
    throw new Error(
      `docker start ${name} failed: ${r.stderr.trim().slice(0, 300)}`,
    );
  }
}

// ── Snapshots (see the "Snapshots" header section for the semantics) ──────────

async function listSnapshotTags(repo: string): Promise<string[]> {
  const r = await docker(["image", "ls", repo, "--format", "{{.Tag}}"]);
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((t) => t && t !== "<none>");
}

/** `<repo>:latest` when the sandbox has a snapshot image, else null. */
async function latestSnapshotImage(sandboxId: string): Promise<string | null> {
  const repo = snapshotRepoForSandbox(sandboxId);
  const r = await docker([
    "image",
    "inspect",
    "-f",
    "{{.Id}}",
    `${repo}:latest`,
  ]);
  return r.exitCode === 0 ? `${repo}:latest` : null;
}

/**
 * `docker commit` the sandbox container to `bks-snap-<sessionId>:t<millis>`
 * (+ `:latest`), labeled with the session id and timestamp, then prune older
 * timestamped snapshots beyond `maxPerSession`. Skipped (returns null) while a
 * run is active for the session — never snapshot a mid-run container — or when
 * the container/state is gone. Throws on a failed commit; the idle sweep
 * catches and stops the container anyway. Exported for the verify suite.
 *
 * Remember what this captures: the container LAYER only (installed deps, apt,
 * global caches) — engine state and workspaces live on volumes/bind mounts and
 * are NOT in the image (see header).
 */
export async function snapshotSandboxImage(
  sandboxId: string,
): Promise<string | null> {
  const state = readState(sandboxId);
  if (!state) return null;
  if (hostRunBusy(state.sessionId)) {
    console.log(`[sandbox] skipping snapshot of ${sandboxId}: a run is active`);
    return null;
  }
  if ((await containerStatus(sandboxId)) === "gone") return null;
  const repo = snapshotRepoForSandbox(sandboxId);
  const tag = `t${Date.now()}`;
  const r = await docker(
    [
      "commit",
      "-c",
      `LABEL opensession.snapshot="1"`,
      "-c",
      `LABEL opensession.session="${state.sessionId}"`,
      "-c",
      `LABEL opensession.snapshotAt="${new Date().toISOString()}"`,
      "-m",
      `opensession sandbox snapshot of ${sandboxId}`,
      sandboxId,
      `${repo}:${tag}`,
    ],
    { timeoutMs: 300_000 },
  );
  if (r.exitCode !== 0) {
    throw new Error(
      `docker commit ${sandboxId} → ${repo}:${tag} failed: ${r.stderr.trim().slice(0, 300)}`,
    );
  }
  await docker(["tag", `${repo}:${tag}`, `${repo}:latest`]);
  // Strict maxPerSession: `t<millis>` tags sort lexicographically = by time
  // (fixed digit count until 2286). `-f` because a live container restored
  // from an old snapshot, or a newer snapshot layered on top of it, still
  // references its layers: -f drops the TAG now (that's the quota we enforce)
  // and docker keeps shared layer data alive only as long as dependents do.
  const keep = Math.max(1, sandboxSnapshots().maxPerSession);
  const tTags = (await listSnapshotTags(repo))
    .filter((t) => /^t\d+$/.test(t))
    .sort()
    .reverse();
  for (const old of tTags.slice(keep)) {
    await docker(["rmi", "-f", `${repo}:${old}`]);
  }
  return `${repo}:${tag}`;
}

/** Remove every snapshot image of a sandbox (destroy + orphan sweep). */
async function removeSnapshotImages(sandboxId: string): Promise<void> {
  const repo = snapshotRepoForSandbox(sandboxId);
  for (const t of await listSnapshotTags(repo)) {
    await docker(["rmi", "-f", `${repo}:${t}`]);
  }
}

/**
 * Sweep `bks-snap-*` images orphaned by sessions deleted while their sandbox
 * was already gone (so destroy() never saw them): no provider state file, no
 * container, and no session file left. Sessions that still exist keep their
 * snapshots — that's the warm-restore path. Fail-safe: images whose session
 * label is unreadable are left alone. Throttled to once an hour (it lists
 * images); runs piggybacked on the idle sweep. NOTE: the 14-day archived-
 * session sweep lives in opensession.ts and funnels through destroy(), which
 * cleans snapshots itself — this covers only the already-gone-sandbox gap.
 */
async function sweepOrphanSnapshots(): Promise<void> {
  const g = globalThis as { __sandboxSnapOrphanSweepAt?: number };
  if (
    g.__sandboxSnapOrphanSweepAt &&
    Date.now() - g.__sandboxSnapOrphanSweepAt < 60 * 60_000
  ) {
    return;
  }
  g.__sandboxSnapOrphanSweepAt = Date.now();
  const r = await docker([
    "images",
    "--filter",
    `reference=${SNAPSHOT_PREFIX}*`,
    "--format",
    "{{.Repository}}",
  ]);
  if (r.exitCode !== 0) return;
  for (const repo of new Set(
    r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  )) {
    try {
      const tags = await listSnapshotTags(repo);
      if (!tags.length) continue;
      const lbl = await docker([
        "image",
        "inspect",
        "-f",
        `{{index .Config.Labels "opensession.session"}}`,
        `${repo}:${tags[0]}`,
      ]);
      const sessionId = lbl.exitCode === 0 ? lbl.stdout.trim() : "";
      if (!sessionId) continue; // unknown provenance — keep
      const container = containerNameFor(sessionId);
      if (readState(container)) continue; // still tracked → destroy() cleans
      if ((await containerStatus(container)) !== "gone") continue;
      if (existsSync(`${OPENSESSION_SESSIONS_DIR}/${sessionId}.json`)) continue; // session alive — keep
      console.log(
        `[sandbox] removing orphaned snapshot images ${repo} (session ${sessionId} deleted, sandbox gone)`,
      );
      await removeSnapshotImages(container);
    } catch (e) {
      console.warn(`[sandbox] orphan snapshot sweep failed for ${repo}:`, e);
    }
  }
}

/** Paths that end up inside a `sh -c` log-redirect line must be boring. They
 *  are always provider-constructed (OPENSESSION_SESSIONS_DIR + sanitized ids), so
 *  this is an assertion, not an escape. */
function assertSafePath(p: string): string {
  if (!/^[A-Za-z0-9_\/.@:-]+$/.test(p)) {
    throw new Error(`refusing unsafe path for in-container exec: ${p}`);
  }
  return p;
}

/** Host-side resolution of the main checkout's .git dir for a worktree —
 *  `<worktree>/.git` is a pointer file; the common dir holds objects/refs. */
async function gitCommonDir(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, "rev-parse", "--git-common-dir"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw new Error(
      `git rev-parse --git-common-dir failed in ${cwd}: ${err.trim()}`,
    );
  return resolvePath(cwd, out.trim());
}

// ── Container creation ────────────────────────────────────────────────────────

function isMainCheckout(cwd: string): boolean {
  return Object.values(REPOS).some((r) => r.repo === cwd);
}

/** Host-side resolution of a repo's origin URL — the clone source for
 *  volume-mode workspaces. */
async function repoOriginUrl(repoDir: string): Promise<string> {
  const proc = Bun.spawn(
    ["git", "-C", repoDir, "remote", "get-url", "origin"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 || !out.trim()) {
    throw new Error(
      `cannot resolve origin URL for ${repoDir}: ${err.trim() || "no origin"}`,
    );
  }
  return out.trim();
}

/**
 * Host-side engine config files projected read-only into a container, as
 * [hostSrc, containerDest] pairs. Sources honor the host-side env seams
 * (OPENSESSION_MODEL_PROVIDERS_CONFIG / OPENSESSION_PI_CONFIG; test/verify suites
 * point them at temp files); destinations stay the legacy default paths the
 * in-container process (which has no such env) dual-reads.
 *  - Pi bridge config: bridge mode, accounts restriction, turn timeout.
 *    without it every pi/anthropic/* run in a sandbox fails with
 *    "bridge disabled".
 *  - Pi engine config: the enabled gate + Anthropic transport policy. Without
 *    it every pi/* run in a sandbox refuses with "pi engine is not enabled"
 *    (pi credentials are the claude/codex account mounts above, shared with
 *    the pi engine).
 * A missing source is simply omitted: the engine then reports its own clear
 * config error in-container. Exported for the sandbox engine-config tests.
 */
export function engineConfigMounts(
  home = HOME,
): Array<[src: string, dest: string]> {
  const out: Array<[string, string]> = [];
  const providerSrc =
    process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG ||
    stateDir("model-providers.json");
  if (existsSync(providerSrc))
    out.push([providerSrc, `${home}/.opensession-model-providers.json`]);
  const piSrc = process.env.OPENSESSION_PI_CONFIG || stateDir("pi.json");
  if (existsSync(piSrc)) out.push([piSrc, `${home}/.opensession-pi.json`]);
  return out;
}

interface CreateContainerOpts {
  workspace: "bind" | "volume";
  /** Attached-repo worktrees to mount (bind mode only). */
  attachedDirs: string[];
  /** Repo backing a volume workspace (clone source + default branch). */
  repo?: Repo;
  /** Run transport (see DockerSandboxState.transport). */
  transport: SandboxTransport;
  /** Image to create from (snapshot restore); default = config/base image. */
  image?: string;
}

async function createContainer(
  name: string,
  sessionId: string,
  cwd: string,
  opts: CreateContainerOpts,
): Promise<void> {
  const cfg = sandboxConfig();
  const image = opts.image || cfg.image || DEFAULT_IMAGE;
  const cpus = cfg.cpus || DEFAULT_CPUS;
  const memory = cfg.memory || DEFAULT_MEMORY;

  const vol = (host: string, container: string, ro = false) => [
    "-v",
    `${host}:${container}${ro ? ":ro" : ""}`,
  ];

  // Workspace mounts. Bind mode: the host worktree + its git common dir, rw at
  // identical paths. Volume mode: a per-session named volume at the canonical
  // worktree path (cloned by setupVolumeWorkspace after start) — plus the
  // origin repo itself mounted ro when it's a local path (scratch/test repos),
  // since the in-container clone must be able to read its source.
  const workspaceMounts: string[] = [];
  if (opts.workspace === "volume") {
    workspaceMounts.push(...vol(`${name}-ws`, cwd));
    const originUrl = opts.repo ? await repoOriginUrl(opts.repo.repo) : "";
    if (originUrl.startsWith("/") && existsSync(originUrl)) {
      workspaceMounts.push(...vol(originUrl, originUrl, true));
    }
  } else {
    const commonGit = await gitCommonDir(cwd);
    if (commonGit === `${cwd}/.git`) {
      // Standalone checkout (not a linked worktree) — only ever legitimate for
      // scratch/test repos; main checkouts were already refused in ensure().
      console.warn(
        `[sandbox] ${name}: ${cwd} is a standalone checkout (no separate common .git)`,
      );
    }
    workspaceMounts.push(
      ...vol(cwd, cwd),
      ...(commonGit !== `${cwd}/.git` ? vol(commonGit, commonGit) : []),
    );
    // Attached repos (multi-repo sessions): each worktree + its repo's common
    // .git, rw at identical paths — same trust as the primary workspace.
    const mounted = new Set([cwd, commonGit]);
    for (const dir of opts.attachedDirs) {
      if (mounted.has(dir)) continue;
      mounted.add(dir);
      workspaceMounts.push(...vol(dir, dir));
      try {
        const attCommon = await gitCommonDir(dir);
        if (attCommon !== `${dir}/.git` && !mounted.has(attCommon)) {
          mounted.add(attCommon);
          workspaceMounts.push(...vol(attCommon, attCommon));
        }
      } catch (e) {
        console.warn(
          `[sandbox] ${name}: could not resolve common .git for attached ${dir}:`,
          e,
        );
      }
    }
  }

  const runsDir = sessionRunsDir(sessionId);
  mkdirSync(runsDir, { recursive: true });
  // Engine transcript dir for this cwd, host-side (see mount design above).
  // Volume mode keeps it too: transcripts are engine state, not workspace —
  // mounting them host-side keeps the session viewer's tail working.
  const transcriptDir = dirname(getTranscriptPath(cwd, "x"));
  mkdirSync(transcriptDir, { recursive: true });

  const mounts: string[] = [
    // Named volumes ONLY at ~/.claude and ~/.codex — never at /home/ubuntu
    // (a $HOME volume would shadow the image's claude install + repo bundle).
    ...vol(`${name}-claude`, `${HOME}/.claude`),
    ...vol(`${name}-codex`, `${HOME}/.codex`),
    ...workspaceMounts,
    // Host-visible engine transcripts for this cwd (over the .claude volume).
    ...vol(transcriptDir, transcriptDir),
    // Per-session run dirs: spec/meta/journal/host.sock/log for every run.
    ...vol(runsDir, runsDir),
    // Audit log parity (append-only jsonl stream). Deliberately rw where the
    // other trust mounts are ro: in-container runs must land in the SAME audit
    // stream as host runs (append-only writes via O_APPEND), and host runs can
    // already write here today — so this is parity with host-run trust, not an
    // escalation. Worst case a hostile run scribbles on its own audit trail;
    // it gains no credentials or control surface from it.
    ...vol(stateDir("audit"), stateDir("audit")),
  ];
  mkdirSync(stateDir("audit"), { recursive: true });

  // run-rpc socket (opensession-* proxies). WS transport skips it — the proxies
  // dial /rpc-ws instead, which also removes the stale-inode caveat
  // (a rebound socket needed a container restart to re-resolve). Guard:
  // mounting a MISSING host path would make docker create a directory there
  // and break run-rpc's bind.
  if (opts.transport !== "ws") {
    const rpcSock = rpcSocketPath(OPENSESSION_SESSIONS_DIR);
    try {
      if (statSync(rpcSock).isSocket()) mounts.push(...vol(rpcSock, rpcSock));
      else
        console.warn(
          `[sandbox] ${rpcSock} exists but is not a socket — opensession-* proxies disabled`,
        );
    } catch {
      console.warn(
        `[sandbox] ${rpcSock} missing — opensession-* proxies will be unavailable in ${name}`,
      );
    }
  }

  // Read-only trust mounts (interactive parity — see header).
  const roIfExists = (p: string, label: string) => {
    if (existsSync(p)) mounts.push(...vol(p, p, true));
    else
      console.warn(
        `[sandbox] ${label} (${p}) missing — skipping mount for ${name}`,
      );
  };
  roIfExists(`${HOME}/.ssh`, "ssh keys");
  roIfExists(`${HOME}/.gitconfig`, "gitconfig");
  roIfExists(`${HOME}/.config/gh`, "gh config");
  roIfExists(
    process.env.OPENSESSION_MCP_CONFIG || configuredPaths().mcpConfig,
    "mcp-config.json",
  );
  roIfExists(
    process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH ||
      stateDir("claude-accounts.json"),
    "claude account pool",
  );
  // Codex/ChatGPT account material, for pi/openai/* dispatch
  // IN-CONTAINER (pickOpenaiAccount reads the pool store; bindOpenaiAccount
  // reads each home-account's CODEX_HOME/auth.json and seeds an access-token-
  // only pi auth.json under the container-local
  // ~/.opensession-pi/openai-data — never these mounts). Without them an
  // openai model in a sandbox died as pi's bare "model not found".
  // Mounted per-FILE and ro on purpose: the auth.json files carry the
  // rotation-sensitive refresh-token family (pi-openai-auth.ts header)
  // — sandboxed code must never be able to rotate/corrupt them, and native
  // codex runs in-container keep their own per-sandbox ~/.codex volume
  // (an in-container refresh attempt against a ro auth.json fails loudly
  // instead of corrupting the host family).
  roIfExists(stateDir("codex-accounts.json"), "codex account pool");
  // SuperGrok pool for pi/xai-oauth/* dispatch in-container. Read-only, and
  // the pool refuses to refresh against a read-only store: an xAI refresh
  // rotates the grant, so a container refresh would strand the host's copy.
  // The host's upkeep tick keeps every stored access token ahead of expiry
  // instead (xai-accounts.ts).
  roIfExists(stateDir("xai-accounts.json"), "xai account pool");
  for (const acct of listCodexAccounts()) {
    if (acct.kind === "home")
      roIfExists(`${acct.value}/auth.json`, `codex auth (${acct.name})`);
  }
  // Engine config files (see engineConfigMounts): the pi bridge config
  // and the pi engine gate, ro at their legacy in-container names.
  for (const [src, dest] of engineConfigMounts())
    mounts.push(...vol(src, dest, true));
  // External preview commands at identical paths, read-only. Repo-owned
  // lifecycle scripts already arrive with the workspace.
  for (const dir of externalPreviewCommandDirs()) {
    roIfExists(dir, `preview command directory ${dir}`);
  }

  // Preview ports: publish each container port on a random LOOPBACK host
  // port (Caddy fronts them with the tailnet HTTPS origin — see preview.ts;
  // nothing is exposed off-host). Create-time only, hence the pre-published
  // DEFAULT range: a dev server started later still lands on a routable port
  // (startSandboxPreview allocates from this set).
  const portArgs = (
    cfg.previewPorts?.length ? cfg.previewPorts : DEFAULT_SANDBOX_PREVIEW_PORTS
  ).flatMap((p) => ["-p", `127.0.0.1::${p}`]);

  const r = await docker([
    "create",
    "--name",
    name,
    "--label",
    "opensession.sandbox=1",
    "--label",
    `opensession.session=${sessionId}`,
    "--init",
    "--restart",
    "no",
    "--cpus",
    String(cpus),
    "--memory",
    memory,
    ...portArgs,
    ...mounts,
    image,
  ]);
  if (r.exitCode !== 0) {
    throw new Error(
      `docker create ${name} failed: ${r.stderr.trim().slice(0, 500)}`,
    );
  }
}

/**
 * Materialize a volume workspace after (re)start: clone from origin (host
 * creds are mounted ro; local-path origins are mounted ro by createContainer)
 * and check out the session's branch — tracking origin/<branch> when it
 * exists, else cut from origin/<defaultBranch>, mirroring createWorktree.
 * Idempotent: an already-cloned volume only re-verifies the checkout.
 */
async function setupVolumeWorkspace(
  name: string,
  cwd: string,
  repo: Repo,
  branch: string,
): Promise<void> {
  // A fresh named volume's mountpoint is root-owned (the path doesn't exist
  // in the image, so there's no ownership to copy) — chown before cloning.
  const own = await docker([
    "exec",
    "-u",
    "0",
    name,
    "chown",
    "1000:1000",
    assertSafePath(cwd),
  ]);
  if (own.exitCode !== 0) {
    throw new Error(
      `sandbox ${name}: chown of workspace volume failed: ${own.stderr.trim().slice(0, 300)}`,
    );
  }
  const cloned = await docker(["exec", name, "test", "-d", `${cwd}/.git`]);
  if (cloned.exitCode !== 0) {
    const originUrl = await repoOriginUrl(repo.repo);
    // Redact credentials before logging — https origins can carry a token in
    // the userinfo part (https://x-access-token:ghp_…@github.com/…), and git
    // echoes remote URLs (post-insteadOf, so authed for cs repos) into stderr.
    console.log(
      `[sandbox] ${name}: cloning ${redactUrl(originUrl)} into workspace volume at ${cwd}`,
    );
    const clone = await docker(
      ["exec", name, "git", "clone", "--", originUrl, cwd],
      { timeoutMs: 600_000 },
    );
    if (clone.exitCode !== 0) {
      throw new Error(
        `sandbox ${name}: in-container clone failed: ${redactUrl(clone.stderr.trim()).slice(0, 500)}`,
      );
    }
  }
  const cur = await docker([
    "exec",
    "-w",
    assertSafePath(cwd),
    name,
    "git",
    "branch",
    "--show-current",
  ]);
  if (cur.exitCode === 0 && cur.stdout.trim() === branch) return;
  const hasRemote = await docker([
    "exec",
    "-w",
    cwd,
    name,
    "git",
    "rev-parse",
    "--verify",
    "--quiet",
    `origin/${branch}`,
  ]);
  const startPoint =
    hasRemote.exitCode === 0
      ? `origin/${branch}`
      : `origin/${repo.defaultBranch}`;
  const co = await docker([
    "exec",
    "-w",
    cwd,
    name,
    "git",
    "checkout",
    "-B",
    branch,
    startPoint,
  ]);
  if (co.exitCode !== 0) {
    throw new Error(
      `sandbox ${name}: checkout -B ${branch} ${startPoint} failed: ${co.stderr.trim().slice(0, 300)}`,
    );
  }
}

/** Container-side git config carrying code.storage auth (see setupCsGitAuth).
 *  Its own file, included from /etc/gitconfig, so re-minting on every ensure()
 *  is a wholesale overwrite — no stale url sections accumulate. */
const CS_GITCONFIG_PATH = "/etc/gitconfig-opensession-cs";

/**
 * In-container git auth for code.storage repos. The host-side URL-scoped
 * credential helper is a bun script plus a private key, both deliberately NOT
 * mounted into containers — so in-container git (volume-mode clones, bind-mode
 * pushes: the branch IS the change request on this host) would have no
 * credentials at all. Instead the container gets a system-level
 * `url.<authed>.insteadOf <credential-free>` rewrite per repo, container-local
 * (/etc is container layer, never a shared mount — the host and the shared
 * bind-mounted .git/config are untouched). 30-day TTL to match the sandbox's
 * life, same tradeoff as remoteCloneUrl (bootstrap.ts); re-minted fresh on
 * every ensure(). Best-effort: a failure logs (redacted) and leaves git in the
 * credential-free state it had before.
 */
async function setupCsGitAuth(name: string, repos: Repo[]): Promise<void> {
  if (!codeStorageConfig()) return;
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const repo of repos) {
    if (repo.host !== "codestorage" || seen.has(repo.id)) continue;
    seen.add(repo.id);
    try {
      const csRepoId =
        repo.csRepo || parseCsRemote(await repoOriginUrl(repo.repo))?.repoId;
      if (!csRepoId) continue;
      // Prefix mapping without the .git suffix so both `…/<repo>.git` and
      // `…/<repo>` remote spellings rewrite.
      const authed = (
        await authedRemoteUrl(csRepoId, { ttlSeconds: 30 * 24 * 3600 })
      ).replace(/\.git$/, "");
      const clean = authed.replace(/^https:\/\/[^@]*@/, "https://");
      lines.push(`[url "${authed}"]`, `\tinsteadOf = ${clean}`);
    } catch (e) {
      console.warn(
        `[sandbox] ${name}: code.storage auth setup failed for ${repo.id}: ${redactUrl(String((e as Error)?.message || e)).slice(0, 300)}`,
      );
    }
  }
  if (!lines.length) return;
  // JWTs are base64url (plus the URL scaffolding) — safe inside a quoted
  // heredoc. Root: /etc/gitconfig* is root-owned in the image.
  const script =
    `cat > ${CS_GITCONFIG_PATH} <<'OSCSEOF'\n${lines.join("\n")}\nOSCSEOF\n` +
    // World-readable like /etc/gitconfig: the sandbox user's git must read it,
    // and the token is the sandbox's own credential (container-local file).
    `chmod 644 ${CS_GITCONFIG_PATH}\n` +
    `git config --system --get-all include.path 2>/dev/null | grep -qxF ${CS_GITCONFIG_PATH} || git config --system --add include.path ${CS_GITCONFIG_PATH}`;
  const r = await docker(["exec", "-u", "0", name, "sh", "-c", script]);
  if (r.exitCode !== 0) {
    console.warn(
      `[sandbox] ${name}: writing code.storage git auth failed: ${redactUrl(r.stderr.trim()).slice(0, 300)}`,
    );
  }
}

/**
 * In-container dirs that must be ubuntu-owned for the runner to work, but that
 * docker materializes ROOT-owned when it creates missing parents of bind-mount
 * targets. The session store is the canonical case: the per-session run dir is
 * mounted at `<sessions>/sandbox-runs/<id>`, and when the image doesn't
 * pre-seed `<sessions>`, docker creates `<sessions>` +
 * `<sessions>/sandbox-runs` as root and the in-container pi runner then
 * EACCESes on `mkdir <sessions>/pi`
 * (regressed 2026-07-09, bks-019f4742-e65c). Exported for the regression test.
 */
export function containerStateDirFixups(): string[] {
  return [OPENSESSION_SESSIONS_DIR, `${OPENSESSION_SESSIONS_DIR}/sandbox-runs`];
}

/** One-time in-container setup after (re)start. Idempotent. */
async function setupContainer(name: string, cwd: string): Promise<void> {
  // Seed ~/.claude/settings.json when the volume is empty — the volume mount
  // shadows the image's seeded file (docker's copy-up covers the very first
  // mount, but not a volume that was created empty out-of-band).
  const seed = await docker([
    "exec",
    name,
    "sh",
    "-c",
    `test -s ${HOME}/.claude/settings.json || printf '{}' > ${HOME}/.claude/settings.json`,
  ]);
  if (seed.exitCode !== 0) {
    throw new Error(
      `sandbox ${name}: seeding ~/.claude failed: ${seed.stderr.trim().slice(0, 300)}`,
    );
  }
  // Re-own the docker-created mount-target parents (see containerStateDirFixups).
  // Only the dirs themselves, never -R: their CONTENTS are bind mounts owned by
  // the host. Idempotent, and works with images from before the state rename.
  const fixups = containerStateDirFixups().map((d) => assertSafePath(d));
  const own = await docker([
    "exec",
    "-u",
    "0",
    name,
    "sh",
    "-c",
    `mkdir -p ${fixups.join(" ")} && chown 1000:1000 ${fixups.join(" ")}`,
  ]);
  if (own.exitCode !== 0) {
    throw new Error(
      `sandbox ${name}: re-owning state dirs failed: ${own.stderr.trim().slice(0, 300)}`,
    );
  }
  // Trap (b) from the plan: verify the worktree actually works inside — the
  // .git pointer file must resolve through the mounted common dir.
  const git = await docker([
    "exec",
    "-w",
    assertSafePath(cwd),
    name,
    "git",
    "status",
    "--porcelain",
  ]);
  if (git.exitCode !== 0) {
    throw new Error(
      `sandbox ${name}: git status failed inside the container (worktree/.git mounts broken?): ${git.stderr.trim().slice(0, 300)}`,
    );
  }
}

/**
 * Repo-local lifecycle hook `.agents/setup` (docs/repo-lifecycle.md, kept
 * minimal): run ONCE per workspace materialization, inside
 * the container, cwd = the workspace — the place for repo-specific dep
 * installs / codegen a sandboxed dev server needs. Skipped when the container
 * was restored from a snapshot (its container layer already carries the
 * setup's effects — that's what snapshots capture). Failure logs loudly but
 * never blocks the session, and is NOT retried (one-shot semantics; the log
 * lives in the session's bind-mounted run dir). `.agents/start.sh` is the
 * sibling hook — preview.ts runs it as the dev-server bring-up.
 *
 * Returns true when the hook is settled (ran / skipped / absent) so the
 * caller records `setupRan` and never re-enters.
 */
async function runWorkspaceSetup(
  name: string,
  sessionId: string,
  cwd: string,
  bootMode: "fresh" | "snapshot-restore",
  repo: Pick<Repo, "id">,
  trustProfile?: "interactive" | "automation",
): Promise<boolean> {
  const script = `${cwd}/.agents/setup`;
  const probe = await docker(["exec", name, "test", "-f", script]);
  if (probe.exitCode !== 0) return true; // no hook — settled
  if (bootMode === "snapshot-restore") {
    console.log(
      `[sandbox] ${name}: skipping ${script} (snapshot restore carries its effects)`,
    );
    return true;
  }
  const log = assertSafePath(
    `${sessionRunsDir(sessionId)}/workspace-setup.log`,
  );
  const identityEnv = createWorkloadIdentityEnv({
    sandboxId: name,
    provider: "docker",
    lifecycle: "setup",
    sessionId,
    repoId: repo.id,
    trustProfile,
  });
  const identityArgs = Object.entries(identityEnv).flatMap(([key, value]) => [
    "-e",
    `${key}=${value}`,
  ]);
  console.log(
    `[sandbox] ${name}: running workspace setup hook ${script} (log: ${log})`,
  );
  const r = await docker(
    [
      "exec",
      "-w",
      assertSafePath(cwd),
      "-e",
      `OPENSESSION_BOOT_MODE=${bootMode}`,
      ...identityArgs,
      name,
      "sh",
      "-c",
      `bash ${assertSafePath(script)} >> ${log} 2>&1`,
    ],
    { timeoutMs: SETUP_TIMEOUT_MS },
  );
  if (r.exitCode !== 0) {
    console.warn(
      `[sandbox] ${name}: workspace setup hook failed (exit ${r.exitCode}) — continuing; see ${log}`,
    );
  }
  return true;
}

// ── The docker HostLauncher: `docker exec` instead of systemd-run ─────────────

function makeDockerLauncher(
  container: string,
  sessionId: string,
): HostLauncher {
  return {
    async alive(dir, meta: RunHostMeta | null) {
      if (!meta?.pid) return false;
      const r = await docker([
        "exec",
        container,
        "kill",
        "-0",
        String(meta.pid),
      ]);
      return r.exitCode === 0;
    },
    newRunDir: (hostId) =>
      `${sessionRunsDir(sessionId)}/${sanitizeName(hostId)}`,
    // WS-transport runs (spec.wsToken present) attach through the run-ws
    // dial-back instead of the run dir's unix socket. Socket runs return
    // undefined = HostHandle's default unix connector.
    connector: (_dir, spec) =>
      spec.wsToken ? runWsConnector(spec.hostId) : undefined,
    async launch(hostId, dir, onDispatching) {
      await ensureStarted(container);
      const specPath = assertSafePath(`${dir}/${HOST_SPEC_NAME}`);
      const logPath = assertSafePath(`${dir}/${HOST_LOG_NAME}`);
      // Detached exec (-d): the in-container host must NOT die with opensession —
      // its socket lives on the bind-mounted run dir, so a restarted opensession
      // reconnects. All output goes to the run dir's host.log (host-visible).
      // Env mirrors what launchHostUnit provides, MINUS ~/.backstage.env:
      // the container gets no ambient credentials; MCP servers carry their own
      // env via mcp-config.json, and the account pool file is mounted ro.
      const env = (kv: string) => ["-e", kv];
      // WS transport: register the run's dial-back token (spec.json was just
      // written to `dir` — respawns included) and point the host at the run-ws
      // + rpc-ws routes instead of socket paths.
      const spec = readJsonSafe<RunHostSpec>(`${dir}/${HOST_SPEC_NAME}`);
      const workloadIdentityEnv = createWorkloadIdentityEnv({
        sandboxId: container,
        provider: "docker",
        lifecycle: "run",
        sessionId,
        trustProfile: spec?.trustProfile,
      });
      const wsEnv: string[] = [];
      if (spec?.wsToken) {
        const base = sandboxCallbackBaseUrl();
        registerRunWsHost(hostId, spec.wsToken);
        wsEnv.push(
          // Primary prefix — the server accepts /backstage too, so URLs baked
          // into already-running containers stay valid.
          ...env(`OPENSESSION_RUN_WS_URL=${base}/run-ws/${hostId}`),
          ...env(`OPENSESSION_RUN_WS_TOKEN=${spec.wsToken}`),
          ...env(`OPENSESSION_RPC_WS_URL=${base}/rpc-ws`),
        );
      }
      const args = [
        "exec",
        "-d",
        // New env names primary; deprecated aliases ride along so an
        // un-migrated in-container build keeps working.
        ...env(`OPENSESSION_RUN_JOURNAL=${dir}/journal.json`),
        ...env(`OPENSESSION_RUN_JOURNAL=${dir}/journal.json`),
        ...Object.entries(workloadIdentityEnv).flatMap(([key, value]) =>
          env(`${key}=${value}`),
        ),
        ...env("NODE_ENV=production"),
        ...(process.env.OPENSESSION_MODEL
          ? env(`OPENSESSION_MODEL=${process.env.OPENSESSION_MODEL}`)
          : []),
        ...(process.env.OPENSESSION_UI_BASE
          ? env(`OPENSESSION_UI_BASE=${process.env.OPENSESSION_UI_BASE}`)
          : []),
        ...wsEnv,
        container,
        "sh",
        "-c",
        `exec bun run ${assertSafePath(HOST_ENTRY)} ${specPath} >> ${logPath} 2>&1`,
      ];
      onDispatching?.();
      const r = await docker(args);
      if (r.exitCode !== 0) {
        if (spec?.wsToken) unregisterRunWsHost(hostId);
        throw new HostLaunchNotDispatchedError(
          `docker exec (run host) failed: ${r.stderr.trim().slice(0, 400)}`,
        );
      }
    },
    evidence(dir) {
      const meta = readJsonSafe<RunHostMeta>(`${dir}/${HOST_META_NAME}`);
      const journal = readJsonSafe<Record<string, ActiveRunRecord>>(
        `${dir}/${HOST_JOURNAL_NAME}`,
      );
      return {
        started: !!meta?.pid || !!journal,
        ...(meta?.engineSessionId
          ? { engineSessionId: meta.engineSessionId }
          : {}),
        ...(meta?.done ? { done: meta.done } : {}),
      };
    },
    async stop(hostId, dir) {
      await Bun.write(`${dir}/cancelled`, "cancelled\n");
      const meta = readJsonSafe<RunHostMeta>(`${dir}/${HOST_META_NAME}`);
      const startup = readJsonSafe<{ pid?: number }>(`${dir}/startup.json`);
      const pid = meta?.pid || startup?.pid || 0;
      if (pid) {
        const specPath = assertSafePath(`${dir}/${HOST_SPEC_NAME}`);
        const script =
          `is_host() { [ -r /proc/${pid}/cmdline ] && ` +
          `tr '\\0' '\\n' < /proc/${pid}/cmdline | grep -Fqx -- '${specPath}'; }; ` +
          `is_host && kill -TERM ${pid} 2>/dev/null || true; sleep 1; ` +
          `is_host && kill -KILL ${pid} 2>/dev/null || true; sleep 0.2; ! is_host`;
        const result = await docker(["exec", container, "sh", "-c", script]);
        if (result.exitCode !== 0)
          throw new Error(`Could not prove sandbox host ${hostId} absent`);
      }
      unregisterRunWsHost(hostId);
    },
  };
}

// ── Run journal bookkeeping (opensession side) ──────────────────────────────────

function recordForSpec(spec: RunHostSpec, sandboxId: string): ActiveRunRecord {
  return {
    runKey: spec.hostId,
    osSessionId: spec.osSessionId,
    claudeSessionId: spec.engineSessionId,
    prompt: spec.prompt,
    promptEntryId: spec.promptEntryId,
    cwd: spec.cwd,
    mode: spec.mode,
    mcpServers: spec.mcpServers,
    user: spec.user,
    deniedTools: spec.deniedTools,
    publicationPolicy: spec.publicationPolicy,
    confirmTools: spec.confirmTools,
    aws: spec.aws,
    model: spec.model,
    selectedModel: spec.selectedModel ?? spec.model,
    transientFallback: spec.transientFallback,
    effort: spec.effort,
    fastMode: spec.fastMode,
    accountId: spec.accountId,
    accountStrict: spec.accountStrict,
    usageCredits: spec.usageCredits,
    fallbackModel: spec.fallbackModel,
    sandboxId,
    sandboxProvider: "docker",
    launchPhase: "prepared",
    trustProfile: spec.trustProfile,
    kind: spec.journalKind || "prompt",
    firstJournaledAt: spec.firstJournaledAt,
    resumeAttempts: spec.resumeAttempts,
    lastResumeAt: spec.lastResumeAt,
    startedAt: new Date().toISOString(),
  };
}

/**
 * Journal the run in the shared active-runs.json (with sandboxId/provider so
 * resumeInterruptedRuns can reattach through this module after a restart),
 * track the engine session id from init events, and clear on completion.
 */
async function* withRunJournal(
  events: AsyncGenerator<StreamEvent>,
  record: ActiveRunRecord,
): AsyncGenerator<StreamEvent> {
  await journalSet(record);
  touchStateActivity(record.sandboxId!);
  let sawDone = false;
  let sawTerminal = false;
  let sourceCompleted = false;
  try {
    for await (const ev of events) {
      if (
        ev.type === "init" &&
        ev.sessionId &&
        ev.sessionId !== record.claudeSessionId
      ) {
        record.claudeSessionId = ev.sessionId;
        await journalSet(record);
      }
      if (ev.type === "model_switch" && ev.toModel) {
        record.model = ev.toModel;
        record.transientFallback = ev.temporaryFallback === true;
        if (shouldPersistModelSwitch(ev)) record.selectedModel = ev.toModel;
        await journalSet(record);
      }
      if (ev.type === "done") sawDone = true;
      if (ev.type === "done" || ev.type === "error") sawTerminal = true;
      yield ev;
    }
    sourceCompleted = true;
  } finally {
    if (sourceCompleted && sawTerminal) journalClear(record.runKey);
    else if (sourceCompleted) await journalRecordAbnormalCompletion(record);
    touchStateActivity(record.sandboxId!);
    if (sawDone) schedulePostRunSnapshot(record.sandboxId!);
  }
}

/**
 * Post-prompt snapshot (background-agents' "snapshot after every turn",
 * adapted): after a sandboxed run completes SUCCESSFULLY, commit the
 * container layer so a later docker-rm/reboot restores warm. Guarded by
 * config `snapshots.enabled` (same switch as the idle-stop snapshot);
 * delayed a few seconds so the run's host-registry control has deregistered
 * (snapshotSandboxImage refuses while the session reads busy) and deduped
 * per sandbox so back-to-back turns don't stack commits.
 */
function schedulePostRunSnapshot(sandboxId: string): void {
  if (!sandboxSnapshots().enabled) return;
  const g = globalThis as { __sandboxPostRunSnaps?: Set<string> };
  const pending = (g.__sandboxPostRunSnaps ??= new Set());
  if (pending.has(sandboxId)) return;
  pending.add(sandboxId);
  setTimeout(() => {
    pending.delete(sandboxId);
    snapshotSandboxImage(sandboxId)
      .then((img) => {
        if (img)
          console.log(`[sandbox] post-run snapshot of ${sandboxId} → ${img}`);
      })
      .catch((e) =>
        console.warn(`[sandbox] post-run snapshot of ${sandboxId} failed:`, e),
      );
  }, 8_000);
}

// ── Sandbox handle ────────────────────────────────────────────────────────────

function makeDockerSandbox(
  sandboxId: string,
  sessionId: string,
  cwd: string,
  workspace: "bind" | "volume" = "bind",
  transport: SandboxTransport = "socket",
  bootMode: "fresh" | "snapshot-restore" = "fresh",
): Sandbox {
  const launcher = makeDockerLauncher(sandboxId, sessionId);
  const sandboxHandle: Sandbox = {
    id: sandboxId,
    provider: "docker",
    cwd,
    workspace,
    bootMode,

    async exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult> {
      await ensureStarted(sandboxId);
      const envArgs = Object.entries({
        ...createWorkloadIdentityEnv({
          sandboxId,
          provider: "docker",
          lifecycle: "run",
          sessionId,
        }),
        ...opts?.env,
      }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      return docker(["exec", "-w", cwd, ...envArgs, sandboxId, ...cmd]);
    },

    /**
     * Eager variant: awaits the docker exec + socket connect and THROWS on any
     * launch failure, so callers with a fallback (maybeLaunchSandboxedRun →
     * host run) can catch it before committing the turn to the sandbox.
     */
    async launchRunEager(
      spec: RunHostSpec,
      cb?: RunHandleCallbacks,
    ): Promise<RunHandle> {
      const dir = launcher.newRunDir(spec.hostId);
      const callbacks: HandleCallbacks = {
        onAskUser: cb?.onAskUser,
        onSteerFailed: cb?.onSteerFailed,
      };
      // WS transport: mint the dial-back token BEFORE the spec is written —
      // launch() reads it back from spec.json (fresh launches and respawns
      // alike) and registers it with the run-ws route.
      if (transport === "ws") spec.wsToken ??= crypto.randomUUID();
      const record = recordForSpec(spec, sandboxId);
      mkdirSync(dir, { recursive: true });
      writeJsonAtomic(`${dir}/${HOST_SPEC_NAME}`, spec);
      // The complete recovery spec must exist before the journal listener can
      // acknowledge the create dispatch, but ownership must precede launch.
      await journalSet(record);
      let handle: HostHandle | undefined;
      let uncertainLaunch = false;
      // Per-step marks: a stalled await in this chain is otherwise silent
      // (2026-07-09: launches ran in-sandbox while opensession never attached).
      const t0 = Date.now();
      const mark = (step: string) =>
        console.log(
          `[sandbox] launch ${spec.hostId.slice(0, 11)}: ${step} (+${Date.now() - t0}ms)`,
        );
      try {
        // Construct (and register) the control BEFORE dispatch so exact-token
        // Stop reaches the launching host: cancelAgentRunTokenAndWait sees
        // hostRunBusy(token) during the launch await, and cancelHost's stop
        // backstop plus the cancelled startup marker fence the dispatch race.
        handle = new HostHandle(dir, spec, callbacks, launcher);
        await launcher.launch(spec.hostId, dir, async () => {
          record.launchPhase = "launching";
          await journalSet(record);
        });
        record.launchPhase = "started";
        await journalSet(record);
        mark("host exec dispatched");
        if (handle.cancelled)
          throw new HostLaunchNotDispatchedError(
            `${spec.hostId} was cancelled while launching`,
          );
        await handle.connectWithWait(30_000);
        mark("host attached");
      } catch (error) {
        const definitelyNotDispatched =
          record.launchPhase === "prepared" ||
          error instanceof HostLaunchNotDispatchedError ||
          // A stop backstop that proved absence during the launch/connect
          // await already finished this handle: retire it like a
          // never-dispatched launch instead of reconciling an ended owner.
          handle?.ended === true;
        if (definitelyNotDispatched) {
          journalClearIfLineage(record);
          handle?.abandon();
          unregisterRunToken(spec.rpcToken);
          if (spec.wsToken) unregisterRunWsHost(spec.hostId);
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {}
          throw error;
        }
        // The launch call may have reached Docker. Keep spec, token, route,
        // handle and journal, and transfer them to a live reconciliation owner.
        uncertainLaunch = true;
        handle ??= new HostHandle(dir, spec, callbacks, launcher);
        console.warn(
          `[sandbox] ${spec.hostId}: launch outcome uncertain; waiting for host attachment`,
          error,
        );
      }
      const ownedHandle = handle!;
      const rawEvents = uncertainLaunch
        ? reconcileUncertainHostEvents(ownedHandle, "Sandbox host")
        : ownedHandle.events();
      const gen = withRunJournal(rawEvents, record);
      return {
        events: () => gen,
        steerable: modelSupportsSteer(spec.model),
        // HostHandle registers its control in host-registry keyed by the bks
        // session id — route through the same helpers the WS handlers use.
        steer: (text, images) => hostSteer(spec.osSessionId, text, images),
        interruptSteer: (text, images) =>
          hostInterruptSteer(spec.osSessionId, text, images),
        cancel: () => hostCancel(spec.osSessionId),
      };
    },

    launchRun(spec: RunHostSpec, cb?: RunHandleCallbacks): RunHandle {
      // Setup is async but RunHandle is sync — do the launch inside the
      // generator (consumed exactly once, like every runner entry point) and
      // degrade a launch failure to an error event. Callers that can fall back
      // to another backend should prefer launchRunEager above.
      const gen = (async function* (): AsyncGenerator<StreamEvent> {
        let eager: RunHandle;
        try {
          eager = await sandboxHandle.launchRunEager!(spec, cb);
        } catch (e: any) {
          yield {
            type: "error",
            content: `Sandbox run failed to start: ${e?.message || e}`,
          };
          return;
        }
        yield* eager.events();
      })();
      return {
        events: () => gen,
        steerable: modelSupportsSteer(spec.model),
        steer: (text, images) => hostSteer(spec.osSessionId, text, images),
        interruptSteer: (text, images) =>
          hostInterruptSteer(spec.osSessionId, text, images),
        cancel: () => hostCancel(spec.osSessionId),
      };
    },

    // Live published-port mapping (container port → loopback host port).
    // Empty when the container isn't running or no previewPorts are
    // configured. preview.ts routes Caddy at the host side of this map.
    async ports(): Promise<PortMap> {
      const r = await docker(["port", sandboxId]);
      if (r.exitCode !== 0) return {};
      const map: PortMap = {};
      for (const line of r.stdout.split("\n")) {
        const m = line.match(/^(\d+)\/tcp -> (?:\[[^\]]*\]|[0-9.]+):(\d+)\s*$/);
        if (!m) continue;
        const inner = parseInt(m[1], 10);
        if (!(inner in map)) map[inner] = parseInt(m[2], 10);
      }
      return map;
    },

    status: () => containerStatus(sandboxId),
  };
  return sandboxHandle;
}

// ── Idle-stop sweep ───────────────────────────────────────────────────────────

/** Exported for the verify suite, which backdates a state file and calls it
 *  directly to exercise the real snapshot-then-stop ordering. `onlySandboxId`
 *  scopes the sweep to one sandbox (verify must never snapshot/stop the live
 *  server's sandboxes with its scratch config) and skips the orphan sweep. */
export async function sweepIdleSandboxes(
  onlySandboxId?: string,
): Promise<void> {
  const cfg = sandboxConfig();
  const idleMs = (cfg.idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES) * 60_000;
  let states: string[] = [];
  try {
    states = existsSync(STATE_DIR) ? readdirSync(STATE_DIR) : [];
  } catch {
    return;
  }
  for (const f of states) {
    if (!f.endsWith(".json")) continue;
    const state = readState(f.slice(0, -5));
    if (!state) continue;
    if (onlySandboxId && state.sandboxId !== onlySandboxId) continue;
    try {
      if ((await containerStatus(state.sandboxId)) !== "running") continue;
      // Idle = no active run for the session (host-registry has a live control
      // handle for every attached run) and no activity inside the window.
      if (hostRunBusy(state.sessionId)) continue;
      const last = Date.parse(state.lastActivityAt || state.createdAt) || 0;
      if (Date.now() - last < idleMs) continue;
      // Snapshot BEFORE the stop (warm-restore pattern). A failure logs and
      // never blocks the stop; snapshotSandboxImage itself refuses while a run
      // is active (defense — the busy check above already covered it).
      const snaps = sandboxSnapshots();
      if (snaps.enabled && snaps.onIdle) {
        try {
          const img = await snapshotSandboxImage(state.sandboxId);
          if (img)
            console.log(
              `[sandbox] snapshotted ${state.sandboxId} → ${img} before idle-stop`,
            );
        } catch (e) {
          console.warn(
            `[sandbox] idle snapshot of ${state.sandboxId} failed (stopping anyway):`,
            e,
          );
        }
        // A run may have started during the (slow) commit — don't stop it now.
        if (hostRunBusy(state.sessionId)) continue;
      }
      console.log(
        `[sandbox] stopping idle container ${state.sandboxId} (idle > ${idleMs / 60_000}m)`,
      );
      await docker(["stop", "-t", "10", state.sandboxId], {
        timeoutMs: 60_000,
      });
    } catch (e) {
      console.warn(`[sandbox] idle sweep failed for ${state.sandboxId}:`, e);
    }
  }
  if (!onlySandboxId) await sweepOrphanSnapshots();
}

/** Arm the idle-stop sweep once per process; parked on globalThis like the
 *  other schedulers so `bun --hot` reloads don't stack timers. */
function ensureIdleSweep(): void {
  const g = globalThis as any;
  if (g.__sandboxIdleSweepTimer) return;
  g.__sandboxIdleSweepTimer = setInterval(() => {
    void sweepIdleSandboxes();
  }, SWEEP_INTERVAL_MS);
}

// ── Provider ──────────────────────────────────────────────────────────────────

// NOT prewarmed: the warm-on-typing prewarm pool (src/server/sandbox/
// prewarm.ts) is remote-only by design. Docker mounts — workspace bind/volume,
// run dir, per-session claude/codex state volumes — are fixed at `docker
// create` time, so a container created before the session exists could never
// get the session's mounts; and a cold docker ensure is ~2-3s anyway (the
// image is prebaked, and a worktree's `git fetch origin` measured ~1.5s on
// this host — under the threshold where prewarming it would pay).

// Workspace resolution is delegated here so a cwd derived through the docker
// provider is byte-identical to the local provider's (and to the session
// paths' own resolution, which passes an already-resolved cwd in `spec.cwd`).
const localResolver = new LocalProvider();

/**
 * Serialize every lifecycle operation per sandbox. A separate ensure-only
 * lock let destroy() remove a newly recreated container or its state file
 * while ensure() was still setting it up. The sandbox id is the sole owner key
 * for ensure, get/recreate, and destroy, parked on globalThis so `bun --hot`
 * reloads do not fork the chains.
 */
function withLifecycleLock<T>(
  sandboxId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const g = globalThis as unknown as {
    __sandboxLifecycleChains?: Map<string, Promise<unknown>>;
    __sandboxEnsureChains?: Map<string, Promise<unknown>>;
  };
  const chains = (g.__sandboxLifecycleChains ??=
    g.__sandboxEnsureChains ?? new Map());
  delete g.__sandboxEnsureChains;
  const prev = chains.get(sandboxId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  chains.set(sandboxId, tail);
  void tail.finally(() => {
    if (chains.get(sandboxId) === tail) chains.delete(sandboxId);
  });
  return run;
}

export function _withDockerLifecycleLockForTest<T>(
  sandboxId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withLifecycleLock(sandboxId, fn);
}

export class DockerProvider implements SandboxProvider {
  readonly id = "docker" as const;

  /**
   * Create-or-reuse the session's container. The worktree itself is resolved
   * HOST-SIDE first (worktree creation, .env seeding, bun install all stay on
   * the host in Phase 1 — the container only ever sees the finished dir).
   */
  ensure(spec: SandboxSessionSpec): Promise<Sandbox> {
    return withLifecycleLock(containerNameFor(spec.sessionId), () =>
      this.ensureInner(spec),
    );
  }

  private async ensureInner(spec: SandboxSessionSpec): Promise<Sandbox> {
    ensureIdleSweep();
    const name = containerNameFor(spec.sessionId);
    const existing = readState(name);

    // Workspace mode. Sticky per sandbox: the state file's recorded mode wins
    // over a later config flip (a volume workspace's data lives in its volume
    // — re-binding it to a host path would orphan the work, and vice versa).
    // Volume applies only to workspaces with no host dir: an existing host
    // worktree (pre-existing session, shared workspace) stays bind-mounted.
    const repo = getRepo(spec.repo || existing?.repoId);
    const branch = spec.branch || existing?.branch;
    const canonical =
      spec.cwd ||
      (branch
        ? worktreePathFor(branch, repo.id, { isolated: true })
        : undefined);
    const wantVolume = existing?.workspace
      ? existing.workspace === "volume"
      : sandboxConfig().workspace === "volume";
    let workspace: "bind" | "volume";
    let cwd: string;
    if (
      wantVolume &&
      canonical &&
      !existsSync(canonical) &&
      spec.mode !== "ask"
    ) {
      if (!branch) {
        throw new Error(
          "volume-mode sandbox needs a branch to clone/check out",
        );
      }
      workspace = "volume";
      cwd = canonical;
    } else {
      // Bind mode resolves the workspace HOST-SIDE first (worktree creation,
      // .env seeding, bun install all stay on the host — the container only
      // ever sees the finished dir).
      workspace = "bind";
      cwd = (await localResolver.ensure(spec)).cwd;
    }
    // A main checkout must never be bind-mounted rw into a sandbox as its
    // workspace: shared checkouts (opensession self-hosting) and repo mainlines
    // stay host-only forever (docs/self-hosting-sandboxes.md). This also catches
    // the "falsy worktreeDir defaulted to the main checkout" session shape.
    if (isMainCheckout(cwd)) {
      throw new Error(
        `refusing to sandbox ${cwd}: it is a shared main checkout — docker sandboxes only run isolated worktrees`,
      );
    }
    const attachedDirs = [
      ...new Set(spec.attachedDirs || existing?.attachedDirs || []),
    ]
      .filter((d) => existsSync(d))
      .sort();
    if (workspace === "volume" && attachedDirs.length) {
      throw new Error(
        "attached repos are not supported in volume-mode sandboxes — detach them or use bind mode",
      );
    }

    // Transport follows the CURRENT config (not sticky): a flip changes the
    // mount set (rpc socket vs none), so a mismatched container is recreated
    // below — that's the safe migration path, volumes survive the rm.
    const transport = sandboxTransport();

    let status = await containerStatus(name);
    // Whether this ensure() (re)started the container — drives the stale-
    // .tunnels.env clear below (the supervisor-on-boot equivalent of the
    // background-agents contract).
    const wasRunning = status === "running";
    if (
      status !== "gone" &&
      existing &&
      (existing.cwd !== cwd ||
        (existing.transport || "socket") !== transport ||
        (existing.attachedDirs || []).join("\n") !== attachedDirs.join("\n"))
    ) {
      // The session's workspace moved (branch/worktree changed), the run
      // transport flipped, or the attached-repo set changed — the old
      // container's mounts are stale. Recreate it; the named volumes (engine
      // state AND a volume-mode workspace) survive `docker rm`.
      console.warn(
        `[sandbox] ${name}: mounts changed (${existing.cwd} → ${cwd}, transport ${existing.transport || "socket"} → ${transport}); recreating container`,
      );
      await docker(["rm", "-f", name]);
      status = "gone";
    }
    // Image the container runs. A GONE container with a snapshot image
    // (snapshots enabled) is restored FROM the snapshot — container-layer
    // state (installed deps/apt/caches) comes back; volumes/bind mounts carry
    // engine + workspace state regardless (see the "Snapshots" header).
    let image = existing?.image || sandboxConfig().image || DEFAULT_IMAGE;
    let restoredFromSnapshot = false;
    let bootMode: "fresh" | "snapshot-restore" = existing?.bootMode || "fresh";
    if (status === "gone") {
      image = sandboxConfig().image || DEFAULT_IMAGE;
      if (sandboxSnapshots().enabled) {
        const snapImage = await latestSnapshotImage(name);
        if (snapImage) {
          image = snapImage;
          restoredFromSnapshot = true;
          console.log(
            `[sandbox] ${name}: creating container from snapshot ${snapImage}`,
          );
        }
      }
      bootMode = restoredFromSnapshot ? "snapshot-restore" : "fresh";
      await createContainer(name, spec.sessionId, cwd, {
        workspace,
        attachedDirs,
        repo: workspace === "volume" ? repo : undefined,
        transport,
        image,
      });
    }
    await ensureStarted(name);
    // Before any in-container git: code.storage repos need container-side auth
    // (the host credential helper isn't mounted). Attached repos too — their
    // worktrees are bind-mounted rw and the agent pushes from them.
    const attachedRepos: Repo[] = [];
    for (const dir of attachedDirs) {
      try {
        attachedRepos.push(repoForPath(dir));
      } catch {
        // Unregistered path — nothing to auth.
      }
    }
    await setupCsGitAuth(name, [repo, ...attachedRepos]);
    if (workspace === "volume") {
      await setupVolumeWorkspace(name, cwd, repo, branch!);
      if (restoredFromSnapshot && sandboxSnapshots().quickSyncOnRestore) {
        // Quick sync after a snapshot restore: freshen refs only — NEVER a
        // reset/checkout; un-pushed work in the volume stays untouched.
        const f = await docker(
          ["exec", "-w", assertSafePath(cwd), name, "git", "fetch", "origin"],
          { timeoutMs: 120_000 },
        );
        if (f.exitCode !== 0) {
          console.warn(
            `[sandbox] ${name}: quick-sync git fetch failed (continuing): ${redactUrl(f.stderr.trim()).slice(0, 200)}`,
          );
        } else {
          await docker([
            "exec",
            "-w",
            cwd,
            name,
            "git",
            "status",
            "--porcelain",
          ]);
        }
      }
    }
    await setupContainer(name, cwd);
    // Container (re)start: clear a stale .tunnels.env — its URLs described the
    // previous boot's preview; startSandboxPreview rewrites it fresh.
    if (!wasRunning) {
      await docker([
        "exec",
        name,
        "sh",
        "-c",
        `rm -f ${assertSafePath(cwd)}/.tunnels.env`,
      ]);
    }
    // One-shot `.agents/setup` lifecycle hook (skipped on snapshot
    // restore; never retried once settled — see runWorkspaceSetup).
    let setupRan = existing?.setupRan === true;
    if (!setupRan) {
      setupRan = await runWorkspaceSetup(
        name,
        spec.sessionId,
        cwd,
        bootMode,
        repo,
        spec.trustProfile,
      );
    }
    writeState({
      sandboxId: name,
      sessionId: spec.sessionId,
      cwd,
      image,
      createdAt: existing?.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      workspace,
      repoId: repo.id,
      transport,
      bootMode,
      ...(setupRan ? { setupRan } : {}),
      ...(branch ? { branch } : {}),
      ...(attachedDirs.length ? { attachedDirs } : {}),
    });
    return makeDockerSandbox(
      name,
      spec.sessionId,
      cwd,
      workspace,
      transport,
      bootMode,
    );
  }

  /**
   * Reattach after a restart. A stopped container is fine (launchRun/exec
   * start it lazily); a REMOVED container is recreated from the provider's
   * state file when possible, since the volumes (engine state) outlive it.
   */
  async get(sandboxId: string): Promise<Sandbox | null> {
    return withLifecycleLock(sandboxId, () => this.getInner(sandboxId));
  }

  private async getInner(sandboxId: string): Promise<Sandbox | null> {
    ensureIdleSweep();
    const state = readState(sandboxId);
    const status = await containerStatus(sandboxId);
    if (status === "gone") {
      if (!state) return null;
      try {
        return await this.ensureInner({
          sessionId: state.sessionId,
          cwd: state.cwd,
          repo: state.repoId,
          branch: state.branch,
          attachedDirs: state.attachedDirs,
        });
      } catch (e) {
        console.warn(`[sandbox] could not recreate ${sandboxId}:`, e);
        return null;
      }
    }
    if (!state) {
      // Container exists but state was lost — recover what we can from labels.
      const r = await docker([
        "inspect",
        "-f",
        '{{index .Config.Labels "opensession.session"}}',
        sandboxId,
      ]);
      const sessionId = r.exitCode === 0 ? r.stdout.trim() : "";
      if (!sessionId) return null;
      const runs = await docker([
        "inspect",
        "-f",
        "{{range .Mounts}}{{.Source}}\n{{end}}",
        sandboxId,
      ]);
      // cwd is unknowable without state; refuse rather than guess.
      console.warn(
        `[sandbox] ${sandboxId} has no state file — exec-only reattach (mounts: ${runs.stdout.split("\n")[0] || "?"})`,
      );
      return null;
    }
    return makeDockerSandbox(
      sandboxId,
      state.sessionId,
      state.cwd,
      state.workspace || "bind",
      state.transport || "socket",
      state.bootMode || "fresh",
    );
  }

  /** Tear down container + its named volumes + snapshot images + provider
   *  state. A bind-mode worktree is untouched (it belongs to the host's
   *  worktree lifecycle); a volume-mode WORKSPACE is deleted with its `-ws`
   *  volume — that data loss is the mode's documented contract (push your
   *  work). */
  async destroy(sandboxId: string): Promise<void> {
    await withLifecycleLock(sandboxId, () => this.destroyInner(sandboxId));
  }

  private async destroyInner(sandboxId: string): Promise<void> {
    await docker(["rm", "-f", sandboxId]);
    await docker([
      "volume",
      "rm",
      "-f",
      `${sandboxId}-claude`,
      `${sandboxId}-codex`,
      `${sandboxId}-ws`,
    ]);
    await removeSnapshotImages(sandboxId);
    // Release the sandbox's https-port allocations + their Caddy routes.
    await dropSandboxPreviewRoutes(sandboxId).catch(() => {});
    const state = readState(sandboxId);
    try {
      unlinkSync(statePath(sandboxId));
    } catch {}
    if (state) {
      try {
        rmSync(sessionRunsDir(state.sessionId), {
          recursive: true,
          force: true,
        });
      } catch {}
    }
  }
}

// ── Restart-resume (called from agent-runner's resumeInterruptedRuns) ─────────

function readJsonSafe<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Resume a journaled docker-sandbox run after a opensession restart.
 *
 *  1. If the in-container run host is STILL ALIVE (containers outlive the
 *     opensession process), reattach to its socket — nothing is re-prompted.
 *  2. If it ended while we were down, deliver its terminal event.
 *  3. Otherwise relaunch in the same sandbox with the standard continuation
 *     prompt against the journaled engine session.
 *
 * Returns null when the sandbox is gone and can't be recreated (the caller
 * logs it; the session's next user prompt will re-ensure a container).
 */
export async function resumeDockerSandboxRun(
  run: ActiveRunRecord,
  cb: HandleCallbacks,
): Promise<AsyncGenerator<StreamEvent> | null> {
  if (!run.sandboxId || !run.osSessionId) return null;
  const provider = new DockerProvider();
  const sandbox = await provider.get(run.sandboxId);
  if (!sandbox) return null;

  const launcher = makeDockerLauncher(run.sandboxId, run.osSessionId);
  const oldDir = launcher.newRunDir(run.runKey);
  const oldSpec = readJsonSafe<RunHostSpec>(`${oldDir}/${HOST_SPEC_NAME}`);
  const meta = readJsonSafe<RunHostMeta>(`${oldDir}/${HOST_META_NAME}`);
  const privateJournal = readJsonSafe<Record<string, ActiveRunRecord>>(
    `${oldDir}/${HOST_JOURNAL_NAME}`,
  );
  const privateRun = privateJournal
    ? Object.values(privateJournal)[0]
    : undefined;
  if (oldSpec) {
    if (meta?.done) {
      // Ended while opensession was down: hand the terminal event to the normal
      // consumption bookkeeping, then clean up.
      try {
        rmSync(oldDir, { recursive: true, force: true });
      } catch {}
      const done = meta.done;
      const selectedModel = meta.selectedModel;
      const initialModel = oldSpec.selectedModel ?? oldSpec.model;
      return (async function* () {
        if (selectedModel && selectedModel !== initialModel) {
          yield {
            type: "model_switch",
            fromModel: initialModel,
            toModel: selectedModel,
            switchReason: "out of credits",
            temporaryFallback: false,
          } satisfies StreamEvent;
        }
        yield done;
      })();
    }
    if (
      (await containerStatus(run.sandboxId)) === "running" &&
      (await launcher.alive(oldDir, meta))
    ) {
      if (oldSpec.rpcToken) {
        registerRunToken(oldSpec.rpcToken, {
          sessionId: oldSpec.osSessionId,
          user: oldSpec.user,
        });
      }
      // WS-transport run: re-register the dial-back token so the still-alive
      // host's reconnect loop can get back in (it's been retrying since the
      // restart dropped the route).
      if (oldSpec.wsToken) registerRunWsHost(oldSpec.hostId, oldSpec.wsToken);
      console.log(
        `[sandbox] reattaching to live run ${run.runKey} in ${run.sandboxId}`,
      );
      const handle = new HostHandle(oldDir, oldSpec, cb, launcher, run.runKey);
      try {
        await handle.connectWithWait(15_000);
      } catch (e) {
        // Drop the host-registry control the ctor registered (and the run
        // token registered just above) — a failed reattach must not leave
        // hostRunBusy() true forever. Keep oldDir: the in-container host may
        // still be alive, and a later resume attempt needs the spec.
        handle.abandon();
        throw e;
      }
      return withRunJournal(handle.events(), {
        ...run,
        startedAt: run.startedAt,
      });
    }
  }

  // Host process died with (or before) the restart — relaunch a continuation
  // in the same sandbox so the engine session's in-container state is reused.
  const recovery = decideSandboxHostRecovery({
    run,
    meta: meta,
    privateRun,
    hasCompleteSpec: !!oldSpec,
  });
  if (recovery.kind === "uncertain")
    throw new Error(
      `Sandbox run ${run.runKey} has execution evidence but no resumable engine session`,
    );
  const effectiveEngineSessionId =
    recovery.kind === "resume" ? recovery.engineSessionId : undefined;
  const prompt = effectiveEngineSessionId
    ? restartContinuationPrompt(run.prompt)
    : run.prompt;
  if (!prompt) return null;
  const rpcToken = oldSpec?.proxyMcpServers?.length
    ? crypto.randomUUID()
    : undefined;
  if (rpcToken)
    registerRunToken(rpcToken, { sessionId: run.osSessionId, user: run.user });
  const hostId = `rh-${Bun.randomUUIDv7()}`;
  const spec: RunHostSpec =
    recovery.kind === "replay"
      ? {
          ...(oldSpec as RunHostSpec),
          hostId,
          rpcToken,
          ...((oldSpec as RunHostSpec).wsToken
            ? { wsToken: crypto.randomUUID() }
            : {}),
          journalKind: recoveryKind(run.kind, "resume"),
          firstJournaledAt: run.firstJournaledAt,
          resumeAttempts: run.resumeAttempts,
          lastResumeAt: run.lastResumeAt,
        }
      : {
          hostId,
          osSessionId: run.osSessionId,
          prompt,
          promptEntryId: effectiveEngineSessionId
            ? undefined
            : run.promptEntryId,
          engineSessionId: effectiveEngineSessionId,
          cwd: run.cwd,
          mode: run.mode,
          model: run.model,
          selectedModel: run.selectedModel ?? run.model,
          transientFallback: run.transientFallback,
          mcpServers: run.mcpServers,
          proxyMcpServers: oldSpec?.proxyMcpServers,
          rpcToken,
          reposNote: oldSpec?.reposNote,
          deniedTools: run.deniedTools,
          confirmTools: run.confirmTools,
          aws: run.aws,
          author: oldSpec?.author,
          user: run.user,
          fallbackModel: run.fallbackModel,
          effort: run.effort,
          fastMode: run.fastMode,
          accountId: run.accountId,
          accountStrict: run.accountStrict,
          usageCredits: run.usageCredits,
          trustProfile: oldSpec?.trustProfile ?? run.trustProfile,
          journalKind: recoveryKind(run.kind, "resume"),
          firstJournaledAt: run.firstJournaledAt,
          resumeAttempts: run.resumeAttempts,
          lastResumeAt: run.lastResumeAt,
        };
  console.log(
    `[sandbox] relaunching interrupted run ${run.runKey} in ${run.sandboxId} as ${spec.hostId}`,
  );
  const replacement = sandbox.launchRunEager
    ? await sandbox.launchRunEager(spec, { onAskUser: cb.onAskUser })
    : sandbox.launchRun(spec, { onAskUser: cb.onAskUser });
  try {
    if (oldDir && existsSync(oldDir))
      rmSync(oldDir, { recursive: true, force: true });
  } catch {}
  return replacement.events();
}
