/**
 * Preview pool: warm, already-booted dev-server containers per repo, so the
 * session Preview button serves in seconds instead of paying a cold `just dev`
 * boot (~1 min on a large repo).
 *
 * Shape (per pool-enabled repo):
 *  - One GOLDEN IMAGE (`os-preview-golden-<repo>:latest`): the repo cloned
 *    INSIDE the container FS (never a host worktree — the closed-worktree
 *    cleanup cron reaps host worktrees parked at origin/main), deps installed,
 *    dev server booted once and route-warmed, then committed. Rebuilt on a
 *    schedule / on demand; warm boots from it take ~11s (vs ~100s truly cold).
 *  - N WARM CONTAINERS booted from the golden image: `running` of them live,
 *    `paused` of them `docker pause`d after warming (unpause is ~ms; a frozen
 *    container costs only RAM, ~2GB). Each publishes container port 3300 onto
 *    a host port from the normal webapp dev range (3100-3999) — that is what
 *    lets the EXISTING preview machinery (ss-based status, httpsPortFor's
 *    +6000 Caddy route, PREVIEW_URL) work unchanged.
 *  - CLAIM on preview start: pick a ready container (unpause if needed),
 *    refresh its AWS creds, sync the session worktree's diff into the
 *    workspace (HMR recompiles just the delta), and point the session's
 *    `.ports.conf` WEBAPP_PORT at the container's host port. From there the
 *    normal getPreviewStatus path sees a listening webapp and exposes the URL.
 *    A 2s sync loop keeps following the worktree while the preview is open.
 *
 * Hard-won boot lessons encoded here (2026-07-23 experiment):
 *  - `.ports.conf` must be COMPLETE before start.sh runs — a partial file
 *    leaves sibling services with empty ports and concurrently kills the boot.
 *  - Some apps resolve AWS creds through a configured named profile
 *    (AWS_PROFILE makes the SDK v3 default chain skip environment credentials),
 *    and start.sh's own profile-baking is gated on the aws CLI the runner
 *    image deliberately lacks — so we write ~/.aws/credentials in-container
 *    ourselves, and refresh it on claim/sweep (the vended creds are
 *    short-lived).
 *  - ReScript's watch.lock survives ungraceful kills and blocks the next boot
 *    ("A ReScript build is already running") — every boot cleans it first.
 *  - Wait-for-up polling must FAIL EARLY on dead boots (grep the log for
 *    `error: Recipe`, check the process), never poll a corpse to timeout.
 */

import { $ } from "bun";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentAwsEnv } from "./aws-creds";
import { codeStorageConfig, configuredRepos, type Repo } from "./config";
import { authedRemoteUrl } from "./codestorage/auth";
import { homeDir, OPENSESSION_SESSIONS_DIR } from "./paths";
import { isDevInstance } from "./dev-mode";
import { sandboxConfig } from "./sandbox/config";
import {
  injectCloneCredential,
  shellQuoteWord,
} from "./sandbox/adapters/bootstrap";
import { redactUrl } from "./shared/redact";

// ── Config ───────────────────────────────────────────────────────────────────

export type PreviewPoolBackend = "docker" | "daytona" | "microvm";

export interface PreviewPoolRepoConfig {
  enabled: boolean;
  /**
   * Where warm containers live (default "docker": local containers from the
   * golden image). "daytona": remote Daytona sandboxes, provisioned once and
   * kept running (ready) or stopped-with-disk (the "paused" tier — a claim
   * restarts them, ~30s, still far cheaper than a cold boot). Requires the
   * Ready Daytona workspace connection and its sized org snapshot.
   */
  backend: PreviewPoolBackend;
  /** Warm containers kept RUNNING (default 1). */
  running: number;
  /** Additional warm containers kept PAUSED (default 1). */
  paused: number;
  cpus: number;
  memory: string;
  /** Rebuild the golden image when older than this (default 24h). */
  goldenIntervalHours: number;
  /**
   * Keep the DEV_AUTH_* login bypass in preview containers (default false:
   * previews use the app's normal auth). The bypass is always active DURING
   * the golden build so route warming pre-compiles authed pages; when this
   * is false the vars are stripped from the image before commit. (A host
   * bring-up keeps its bypass either way — this only affects the pool.)
   */
  devAuthBypass: boolean;
  /** Release a claimed preview whose status hasn't been polled for this long
   *  (default 90 min) — the UI polls every few seconds while it's on screen. */
  claimIdleMinutes: number;
}

const DEFAULTS: Omit<PreviewPoolRepoConfig, "enabled"> = {
  // Microvm became the default 2026-07-24 after the restart-survival test:
  // snapshot restores beat warm docker containers on both latency and RAM.
  // Docker/daytona remain selectable per repo.
  backend: "microvm",
  running: 1,
  paused: 1,
  cpus: 4,
  memory: "8g",
  goldenIntervalHours: 24,
  devAuthBypass: false,
  claimIdleMinutes: 90,
};

function poolDir(): string {
  return join(OPENSESSION_SESSIONS_DIR, "preview-pool");
}

function configFile(): string {
  return join(poolDir(), "config.json");
}

export function previewPoolConfig(repoId: string): PreviewPoolRepoConfig {
  try {
    const raw = JSON.parse(readFileSync(configFile(), "utf-8"));
    const r = raw?.repos?.[repoId] ?? {};
    return {
      enabled: r.enabled === true,
      backend:
        r.backend === "daytona" || r.backend === "microvm"
          ? r.backend
          : "docker",
      running: clampInt(r.running, 0, 4, DEFAULTS.running),
      paused: clampInt(r.paused, 0, 8, DEFAULTS.paused),
      cpus: clampInt(r.cpus, 1, 16, DEFAULTS.cpus),
      memory: typeof r.memory === "string" ? r.memory : DEFAULTS.memory,
      goldenIntervalHours: clampInt(
        r.goldenIntervalHours,
        1,
        24 * 7,
        DEFAULTS.goldenIntervalHours,
      ),
      devAuthBypass: r.devAuthBypass === true,
      claimIdleMinutes: clampInt(
        r.claimIdleMinutes,
        5,
        24 * 60,
        DEFAULTS.claimIdleMinutes,
      ),
    };
  } catch {
    return { enabled: false, ...DEFAULTS };
  }
}

export function setPreviewPoolConfig(
  repoId: string,
  patch: Partial<PreviewPoolRepoConfig>,
): void {
  mkdirSync(poolDir(), { recursive: true });
  let raw: { repos?: Record<string, unknown> } = {};
  try {
    raw = JSON.parse(readFileSync(configFile(), "utf-8"));
  } catch {}
  raw.repos ??= {};
  raw.repos[repoId] = { ...(raw.repos[repoId] as object), ...patch };
  writeFileSync(configFile(), JSON.stringify(raw, null, 2));
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? Math.round(v) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}

// ── State ────────────────────────────────────────────────────────────────────

/** In-container workspace path (inside the golden image's FS — the images
 *  are built with the same home layout as the host, see bootstrap.ts). */
const WORKSPACE = `${homeDir()}/preview-workspace`;
const CONTAINER_PORT = 3300;
const POOL_LABEL = "os-preview-pool";
/** Untracked marker a claim drops in the workspace — tells the container's
 *  boot cmd to keep the converged branch instead of resetting to default. */
const CLAIMED_MARKER = ".bks-claimed";
/** Changed-file count above which a claim reboots the dev server instead of
 *  letting HMR chew through the flip (a live flip of a big delta produces a
 *  module-graph error storm — flapping 500s — until ReScript resettles). */
const LIVE_FLIP_MAX_FILES = 30;

interface PoolContainer {
  /** Docker container name, or the Daytona sandbox id (backend "daytona"). */
  name: string;
  repoId: string;
  /** Which backend `name` refers to. Absent = docker (pre-field records). */
  backend?: PreviewPoolBackend;
  /** warming = boot in flight; ready = serving; paused = frozen warm spare
   *  (docker pause / daytona stop-with-disk); claimed = attached to a
   *  session worktree. */
  state: "warming" | "ready" | "paused" | "claimed";
  /** Published loopback port (docker). 0 for remote backends — they carry
   *  `previewUrl` instead. */
  hostPort: number;
  /** The backend's own public preview origin (daytona getPreviewLink, or the
   *  microvm backend's per-clone Caddy route). */
  previewUrl?: string;
  /** Microvm clone index (netns/veth/disk namespace, see clone.sh). */
  mvmIdx?: number;
  /** origin/<default> sha the workspace was reset to at boot. */
  bootSha: string;
  /** Commit the workspace tree is currently converged to (defaults to
   *  bootSha; updated when a claim checks out the session's HEAD). The
   *  uncommitted-file sync diffs against THIS. */
  syncBase?: string;
  createdAt: string;
  sessionWorktree?: string;
  claimedAt?: string;
  /** Last preview-status poll for the claiming worktree (the UI polls every
   *  few seconds while someone is looking) — the sweep releases claims idle
   *  longer than claimIdleMinutes. */
  lastSeenAt?: string;
}

interface PoolState {
  golden?: { sha: string; builtAt: string; lastError?: string };
  /** A default-branch change retired the old pool and still needs a complete
   * golden rebuild before any replacement members may be spawned. */
  branchRebuildPending?: boolean;
  containers: Record<string, PoolContainer>;
}

function stateFile(repoId: string): string {
  return join(poolDir(), `state-${repoId}.json`);
}

function readState(repoId: string): PoolState {
  try {
    const s = JSON.parse(readFileSync(stateFile(repoId), "utf-8"));
    return {
      golden: s.golden,
      branchRebuildPending: s.branchRebuildPending === true,
      containers: s.containers ?? {},
    };
  } catch {
    return { containers: {} };
  }
}

function writeState(repoId: string, state: PoolState): void {
  mkdirSync(poolDir(), { recursive: true });
  const tmp = `${stateFile(repoId)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, stateFile(repoId));
}

function patchContainer(
  repoId: string,
  name: string,
  patch: Partial<PoolContainer> | null,
): void {
  const state = readState(repoId);
  if (patch === null) delete state.containers[name];
  else
    state.containers[name] = {
      ...state.containers[name],
      ...patch,
    } as PoolContainer;
  writeState(repoId, state);
}

const g = globalThis as unknown as {
  __previewPoolTimer?: ReturnType<typeof setInterval>;
  __previewPoolBusy?: Map<string, Promise<unknown>>;
  __previewPoolSyncs?: Map<
    string,
    { timer: ReturnType<typeof setInterval>; mtimes: Map<string, number> }
  >;
};
const busy: Map<string, Promise<unknown>> = (g.__previewPoolBusy ??= new Map());
const defaultBranchInvalidationVersion = new Map<string, number>();
const retiredDefaultBranchMembers = new Map<string, PoolContainer[]>();
/** worktreeDir -> live sync loop. */
const syncs = (g.__previewPoolSyncs ??= new Map());

function goldenImage(repoId: string): string {
  return `os-preview-golden-${repoId}`;
}

/**
 * Artifacts that MUST exist in a workspace after the .agents/setup hook for the app to
 * actually render — the golden build refuses to commit without them (their
 * absence only surfaces later as module-not-found crashes on page compile).
 */
function provisionMarkers(repoId: string): string[] {
  return configuredRepos()[repoId]?.warmCachePaths ?? [];
}

// ── Docker helpers ───────────────────────────────────────────────────────────

async function docker(
  args: string[],
  timeoutMs = 60_000,
): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, timeoutMs);
  const collect = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([out, err, code]) => ({
    ok: code === 0 && !timedOut,
    out: (out + err).trim(),
  }));
  // Absolute backstop: stream reads can wedge after a kill — never let a
  // docker call hang the caller past its budget (bit us live 2026-07-23:
  // a timed-out in-container clone left the whole golden build stuck).
  const result = await Promise.race([
    collect,
    new Promise<{ ok: boolean; out: string }>((res) =>
      setTimeout(
        () =>
          res({
            ok: false,
            out: `docker ${args[0]} timed out after ${timeoutMs}ms`,
          }),
        timeoutMs + 10_000,
      ),
    ),
  ]);
  clearTimeout(killer);
  if (timedOut)
    return {
      ok: false,
      out: `timed out after ${timeoutMs}ms: ${result.out.slice(-300)}`,
    };
  return result;
}

async function dockerExec(
  name: string,
  script: string,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; out: string }> {
  return docker(["exec", name, "bash", "-c", script], timeoutMs);
}

async function containerRunning(
  name: string,
): Promise<"running" | "paused" | "gone"> {
  const r = await docker(["inspect", name, "--format", "{{.State.Status}}"]);
  if (!r.ok) return "gone";
  if (r.out.includes("paused")) return "paused";
  return r.out.includes("running") ? "running" : "gone";
}

// ── Daytona backend plumbing ─────────────────────────────────────────────────
// Same pool semantics on remote Daytona sandboxes: `ready` = sandbox running
// with the dev server up (claim = instant); `paused` = sandbox STOPPED with
// its disk kept (claim restarts it + reboots dev on warm caches, ~30-60s).
// The public per-sandbox preview link replaces the docker host-port + Caddy
// route. The SDK is imported lazily so docker-only setups never load it.

async function daytonaClientForPool() {
  const { getSandboxConnection, sandboxProviderCredential } =
    await import("./sandbox/connections");
  const cfg = getSandboxConnection("daytona")?.settings;
  const credential = sandboxProviderCredential("daytona") as
    | { apiKey: string }
    | undefined;
  if (!credential)
    throw new Error(
      "preview-pool daytona backend: no Ready workspace connection",
    );
  const { Daytona } = await import("@daytonaio/sdk");
  return new Daytona({
    apiKey: credential.apiKey,
    apiUrl: cfg?.apiUrl,
    target: cfg?.target as never,
  });
}

async function daytonaSbx(id: string) {
  return (await daytonaClientForPool()).get(id);
}

function isDaytona(c: PoolContainer): boolean {
  return c.backend === "daytona";
}

// ── Microvm backend plumbing ─────────────────────────────────────────────────
// Firecracker clones restored from the golden memory snapshot (verified on
// this r8i: reflink disk 5ms, snapshot load+resume 18ms, page 200 in ~2s).
// Each clone runs in a private netns (clone.sh) — host reaches the guest at
// 10.200.<idx>.2 (3300 dev, 8080 agent, 8081 root agent). No warm members
// are needed: claims restore on demand, so running/paused can be 0.

const MVM_DIR = "/opt/firecracker";
const MVM_STORE = `${MVM_DIR}/store`;
const MVM_SCRIPTS = `${process.cwd()}/deploy/sandbox/microvm`;
/** Caddy https port band for microvm previews: 9001-9063 — BELOW the
 *  9100-9999 host-preview band (no collision) and inside the 9xxx range the
 *  tailnet ACL demonstrably passes (ports >9999 hang from member devices
 *  while loopback works — every 101xx preview URL was unreachable from
 *  a member browser). */
const MVM_HTTPS_BASE = 9000;

function isMicrovm(c: PoolContainer): boolean {
  return c.backend === "microvm";
}

function mvmIp(c: PoolContainer): string {
  return `10.200.${c.mvmIdx}.2`;
}

async function mvmAgent(
  c: PoolContainer,
  body: { command: string; timeoutMs?: number },
  root = false,
): Promise<{ ok: boolean; out: string }> {
  try {
    const res = await fetch(`http://${mvmIp(c)}:${root ? 8081 : 8080}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((body.timeoutMs ?? 60_000) + 5_000),
    });
    const r = (await res.json()) as {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      ok: (r.exitCode ?? 1) === 0,
      out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(),
    };
  } catch (e) {
    return { ok: false, out: String((e as Error)?.message || e) };
  }
}

function mvmGoldenReady(): boolean {
  return (
    existsSync(`${MVM_STORE}/golden.vmstate`) &&
    existsSync(`${MVM_STORE}/golden.mem`)
  );
}

/** Clone indexes owned by the general `microvm` sandbox provider. Preview
 * allocation and orphan GC share the same host-level Firecracker namespace,
 * even though their goldens/stores are deliberately separate. */
function sandboxMicrovmIndexes(): Set<number> {
  const indexes = new Set<number>();
  const dir = join(OPENSESSION_SESSIONS_DIR, "sandboxes");
  try {
    for (const file of readdirSync(dir)) {
      if (!file.startsWith("microvm-") || !file.endsWith(".json")) continue;
      try {
        const state = JSON.parse(readFileSync(join(dir, file), "utf-8")) as {
          sandboxId?: string;
        };
        const match = /^microvm-(\d+)$/.exec(state.sandboxId || "");
        if (match) indexes.add(Number(match[1]));
      } catch {}
    }
  } catch {}
  return indexes;
}

async function sudoRun(
  args: string[],
  timeoutMs = 120_000,
): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["sudo", "-n", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const killer = setTimeout(() => proc.kill(9), timeoutMs);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);
  return { ok: code === 0, out: (out + err).trim() };
}

/**
 * Keep the golden memory snapshot resident in the host page cache. The "18ms
 * restore" depends entirely on golden.mem (~12GB) being cached: after a few
 * days of build churn the LRU evicts it and the next claim's prefault re-reads
 * the whole file from EBS (~2.5 min observed 2026-07-27, ×2 when claims race).
 * A periodic re-read refreshes the pages' recency; a cached pass costs a few
 * seconds of memory bandwidth every 15 min. Fire-and-forget, never stacked.
 *
 * PAUSED (opt-in via OPENSESSION_MVM_PREFAULT=1) 2026-07-27: on a loaded host
 * the cold pass grinds EBS for minutes, and the restart-looping server kept
 * re-starting it from scratch (the throttle lives on globalThis). Paused
 * until we fix it properly — a real fix wants the read to
 * survive restarts (throttle stamp on disk) and to be cheap when cold
 * (e.g. vmtouch with a rate cap, or pinning only the hot subset).
 */
const MVM_PREFAULT_EVERY_MS = 15 * 60_000;
function touchGoldenMem(): void {
  if (process.env.OPENSESSION_MVM_PREFAULT !== "1") return;
  const t = globalThis as {
    __mvmPrefaultAt?: number;
    __mvmPrefaultBusy?: boolean;
  };
  if (
    t.__mvmPrefaultBusy ||
    Date.now() - (t.__mvmPrefaultAt ?? 0) < MVM_PREFAULT_EVERY_MS
  )
    return;
  if (!mvmGoldenReady()) return;
  t.__mvmPrefaultBusy = true;
  try {
    const proc = Bun.spawn(
      ["cat", `${MVM_STORE}/golden.mem`, `${MVM_STORE}/golden.vmstate`],
      {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      },
    );
    proc.exited
      .then(() => {
        t.__mvmPrefaultAt = Date.now();
      })
      .finally(() => {
        t.__mvmPrefaultBusy = false;
      });
    proc.unref();
  } catch {
    t.__mvmPrefaultBusy = false;
  }
}

/** Restore a clone from the golden snapshot and expose it via Caddy. */
async function spawnMicrovmClone(repo: Repo): Promise<PoolContainer | null> {
  if (!mvmGoldenReady()) {
    console.warn(
      `[preview-pool] ${repo.id}: no microvm golden snapshot — run the refresh (POST /preview-pool/${repo.id}/refresh)`,
    );
    return null;
  }
  // Free index across all repos (netns space is host-global). The reserved
  // set closes the window between concurrent spawners' state scans — two
  // spawns picked the same index and the second's destroy-first create
  // killed the first's live VM (2026-07-24).
  const reserved = ((
    globalThis as { __mvmReservedIdx?: Set<number> }
  ).__mvmReservedIdx ??= new Set<number>());
  const used = new Set<number>([...reserved, ...sandboxMicrovmIndexes()]);
  for (const rid of Object.keys(configuredRepos())) {
    for (const cc of Object.values(readState(rid).containers)) {
      if (cc.mvmIdx != null) used.add(cc.mvmIdx);
    }
  }
  let idx = 1;
  while (used.has(idx) && idx < 64) idx++;
  if (idx >= 64) {
    console.warn("[preview-pool] microvm: no free clone index");
    return null;
  }
  reserved.add(idx);
  const name = `mvm${idx}-${repo.id}`;
  const c: PoolContainer = {
    name,
    repoId: repo.id,
    backend: "microvm",
    state: "warming",
    hostPort: 0,
    mvmIdx: idx,
    bootSha: "",
    createdAt: new Date().toISOString(),
  };
  patchContainer(repo.id, name, c);
  const r = await sudoRun(
    ["bash", `${MVM_SCRIPTS}/clone.sh`, "create", String(idx), MVM_STORE],
    180_000,
  ).finally(() => reserved.delete(idx));
  if (!r.ok) {
    console.warn(
      `[preview-pool] microvm clone ${idx} failed: ${r.out.slice(-400)}`,
    );
    patchContainer(repo.id, name, null);
    await sudoRun([
      "bash",
      `${MVM_SCRIPTS}/clone.sh`,
      "destroy",
      String(idx),
      MVM_STORE,
    ]).catch(() => {});
    return null;
  }
  // Fresh creds (the snapshot's are stale) + a background poke so the app
  // re-establishes its dead pooled TCP connections before the user's click.
  await refreshContainerCreds(c).catch(() => {});
  void fetch(`http://${mvmIp(c)}:3300/api/session`, {
    headers: { Host: `localhost:${CONTAINER_PORT}` },
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {});
  // Caddy route: the tailnet-cert front, dialing the guest directly with the
  // Host rewritten to what the app's dev routing expects.
  const { previewHost } = await import("./preview");
  const host = await previewHost();
  const httpsPort = MVM_HTTPS_BASE + idx;
  const route = {
    listen: [`:${httpsPort}`],
    routes: [
      {
        match: [{ host: [host] }],
        handle: [
          {
            handler: "reverse_proxy",
            upstreams: [{ dial: `${mvmIp(c)}:${CONTAINER_PORT}` }],
            headers: {
              request: { set: { Host: [`localhost:${CONTAINER_PORT}`] } },
            },
          },
        ],
        terminal: true,
      },
    ],
  };
  const path = `http://localhost:2019/config/apps/http/servers/preview_${httpsPort}`;
  let res = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(route),
  }).catch(() => null);
  if (res && res.status === 409) {
    await fetch(path, { method: "DELETE" }).catch(() => {});
    res = await fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(route),
    }).catch(() => null);
  }
  const bootSha = (
    await mvmAgent(c, { command: `git -C ${WORKSPACE} rev-parse HEAD` })
  ).out.trim();
  const previewUrl = `https://${host}:${httpsPort}`;
  patchContainer(repo.id, name, { state: "ready", bootSha, previewUrl });
  c.state = "ready";
  c.bootSha = bootSha;
  c.previewUrl = previewUrl;
  console.log(
    `[preview-pool] ${repo.id}: microvm clone ${idx} ready at ${previewUrl} (${bootSha.slice(0, 10)})`,
  );
  return c;
}

/** One-shot script in the pool workspace, whichever backend. Never throws. */
async function poolExec(
  c: PoolContainer,
  script: string,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; out: string }> {
  if (isMicrovm(c)) return mvmAgent(c, { command: script, timeoutMs });
  if (!isDaytona(c)) return dockerExec(c.name, script, timeoutMs);
  try {
    const sbx = await daytonaSbx(c.name);
    // base64-wrapped: JSON.stringify escapes newlines to literal \n, which
    // destroyed every multi-line script (the creds heredoc became cat args —
    // live failure 22:20). Plain `bash -c`, NOT `-l`: a login shell sources
    // the image profile, which execs a zsh the snapshot doesn't ship. No
    // cwd: the workspace doesn't exist until the toolchain step creates it.
    const b64 = Buffer.from(script, "utf-8").toString("base64");
    const res = await sbx.process.executeCommand(
      `bash -c 'echo ${b64} | base64 -d | bash'`,
      undefined,
      undefined,
      Math.max(10, Math.round(timeoutMs / 1000)),
    );
    return {
      ok: (res.exitCode ?? 1) === 0,
      out: String(res.result ?? "").trim(),
    };
  } catch (e) {
    return { ok: false, out: String((e as Error)?.message || e) };
  }
}

async function poolWriteFile(
  c: PoolContainer,
  path: string,
  content: string,
): Promise<boolean> {
  if (isMicrovm(c)) {
    try {
      const res = await fetch(`http://${mvmIp(c)}:8080/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path,
          content: Buffer.from(content, "utf-8").toString("base64"),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
  if (!isDaytona(c)) {
    const r = await dockerExec(
      c.name,
      `mkdir -p ${JSON.stringify(path.replace(/\/[^/]+$/, ""))} && cat > ${JSON.stringify(path)} <<'BKSPOOLEOF'\n${content}\nBKSPOOLEOF`,
    );
    return r.ok;
  }
  try {
    const sbx = await daytonaSbx(c.name);
    await sbx.fs.uploadFile(Buffer.from(content, "utf-8"), path);
    return true;
  } catch {
    return false;
  }
}

/** Gitignored files the app needs to boot, carried from the operator-owned
 *  host checkout because git can't. */
export const SEED_ENV_FILES = ["packages/core/webapp/.env.local", ".envrc"];

/** Host content for one seed file, with the dev-auth bypass stripped unless
 *  this repo's previews deliberately keep it. Null when the host has no such
 *  file. */
function envSeedContent(repo: Repo, rel: string): string | null {
  const src = join(repo.repo, rel);
  if (!existsSync(src)) return null;
  const content = readFileSync(src, "utf-8");
  if (rel.endsWith(".env.local") && !previewPoolConfig(repo.id).devAuthBypass) {
    return content.replace(/^DEV_AUTH_.*\n?/gm, "");
  }
  return content;
}

/** Re-seed env into a pool member about to (re)boot its dev server. Exported
 *  for tests.
 *
 *  These files carry credentials that rotate, and the boot paths advance the
 *  git tree but never them — so a container keeps whatever was current the day
 *  its golden image was committed or its sandbox provisioned. A rotated Vercel
 *  Flags key sat in the golden for weeks that way, and every preview's editor
 *  answered 500 on /api/flags/collaboration until the image was rebuilt.
 *
 *  Warn rather than fail: a host file we can't read is no reason to refuse a
 *  reboot, and the member still has its previous copy. */
export async function reseedEnv(c: PoolContainer): Promise<void> {
  const repo = configuredRepos()[c.repoId];
  if (!repo) return;
  for (const rel of SEED_ENV_FILES) {
    const content = envSeedContent(repo, rel);
    if (content === null) continue;
    if (!(await poolWriteFile(c, `${WORKSPACE}/${rel}`, content))) {
      console.warn(
        `[preview-pool] ${c.repoId}: re-seeding ${rel} into ${c.name} failed`,
      );
    }
  }
}

/** Same seeding for a docker container that hasn't started yet, where exec
 *  isn't available — `docker cp` needs a path, so the (already gitignored)
 *  content goes through a private temp file. Exported for tests. */
export async function copySeedEnvFiles(
  name: string,
  repo: Repo,
): Promise<void> {
  const staging = mkdtempSync(join(tmpdir(), "os-preview-seed-"));
  try {
    for (const rel of SEED_ENV_FILES) {
      const content = envSeedContent(repo, rel);
      if (content === null) continue;
      const staged = join(staging, rel.replace(/\//g, "_"));
      writeFileSync(staged, content, { mode: 0o600 });
      const cp = await docker(["cp", staged, `${name}:${WORKSPACE}/${rel}`]);
      if (!cp.ok)
        console.warn(
          `[preview-pool] ${repo.id}: seeding ${rel} into ${name} failed`,
        );
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** running/paused/gone in pool terms (daytona "stopped" maps to paused). */
async function poolRuntimeStatus(
  c: PoolContainer,
): Promise<"running" | "paused" | "gone"> {
  if (isMicrovm(c)) {
    // The transient scope is the authoritative process handle.
    const r = await $`systemctl is-active --quiet os-fc-clone${c.mvmIdx}`
      .quiet()
      .nothrow();
    if (r.exitCode === 0) return "running";
    // A transient check hiccup must not delete a live claim — the agent
    // answering proves the VM is alive.
    const alive = await mvmAgent(c, { command: "echo alive", timeoutMs: 3000 });
    return alive.ok ? "running" : "gone";
  }
  if (!isDaytona(c)) return containerRunning(c.name);
  try {
    const sbx = await daytonaSbx(c.name);
    await (sbx as { refreshData?: () => Promise<void> }).refreshData?.();
    const s = String((sbx as { state?: string }).state ?? "").toLowerCase();
    if (s.includes("started") || s.includes("running")) return "running";
    if (
      s.includes("stopped") ||
      s.includes("stopping") ||
      s.includes("starting")
    )
      return "paused";
    return "gone";
  } catch {
    return "gone";
  }
}

async function poolDestroyRef(c: PoolContainer): Promise<void> {
  if (isMicrovm(c)) {
    await sudoRun([
      "bash",
      `${MVM_SCRIPTS}/clone.sh`,
      "destroy",
      String(c.mvmIdx),
      MVM_STORE,
    ]).catch(() => {});
    if (c.mvmIdx != null) {
      await fetch(
        `http://localhost:2019/config/apps/http/servers/preview_${MVM_HTTPS_BASE + c.mvmIdx}`,
        { method: "DELETE" },
      ).catch(() => {});
    }
    return;
  }
  if (!isDaytona(c)) {
    await docker(["rm", "-f", c.name]);
    return;
  }
  try {
    const client = await daytonaClientForPool();
    const sbx = await client.get(c.name);
    if (sbx) await client.delete(sbx, 120);
  } catch (e) {
    console.warn(`[preview-pool] daytona delete ${c.name}:`, e);
  }
}

async function poolFreeze(c: PoolContainer): Promise<boolean> {
  if (isMicrovm(c)) {
    return (
      await sudoRun([
        "curl",
        "-s",
        "--unix-socket",
        `${MVM_STORE}/fc-clone${c.mvmIdx}.sock`,
        "-X",
        "PATCH",
        "http://x/vm",
        "-H",
        "Content-Type: application/json",
        "-d",
        '{"state":"Paused"}',
      ])
    ).ok;
  }
  if (!isDaytona(c)) return (await docker(["pause", c.name])).ok;
  try {
    const sbx = await daytonaSbx(c.name);
    await (sbx as unknown as { stop: (t?: number) => Promise<void> }).stop(120);
    return true;
  } catch (e) {
    console.warn(`[preview-pool] daytona stop ${c.name}:`, e);
    return false;
  }
}

/** Bring a frozen pool member back to serving. Docker unpause is ~ms; a
 *  stopped daytona sandbox restarts and reboots its dev server (~30-60s on
 *  warm disk) — callers treat the member as "starting" until the probe is
 *  green. */
async function poolUnfreeze(c: PoolContainer): Promise<boolean> {
  if (isMicrovm(c)) {
    return (
      await sudoRun([
        "curl",
        "-s",
        "--unix-socket",
        `${MVM_STORE}/fc-clone${c.mvmIdx}.sock`,
        "-X",
        "PATCH",
        "http://x/vm",
        "-H",
        "Content-Type: application/json",
        "-d",
        '{"state":"Resumed"}',
      ])
    ).ok;
  }
  if (!isDaytona(c)) return (await docker(["unpause", c.name])).ok;
  try {
    const sbx = await daytonaSbx(c.name);
    await sbx.start();
    await launchDaytonaDev(c);
    return true;
  } catch (e) {
    console.warn(`[preview-pool] daytona start ${c.name}:`, e);
    return false;
  }
}

/** Reboot the dev tree for a clean module graph (big-delta claims). */
async function poolRestartDev(c: PoolContainer): Promise<void> {
  await reseedEnv(c);
  if (isMicrovm(c)) {
    await mvmAgent(
      c,
      {
        command: `pkill -TERM -f 'start.sh|dev-services|next dev|concurrently' 2>/dev/null; sleep 3; pkill -KILL -f 'next dev|rescript' 2>/dev/null; cd ${WORKSPACE} && : > /tmp/boot.log && (setpriv --reuid 1000 --regid 1000 --init-groups env HOME=${homeDir()} USER=ubuntu PATH=/usr/local/sbin:/usr/local/bin:/usr/local/bun/bin:/usr/sbin:/usr/bin:/sbin:/bin WEBAPP_PORT=${CONTAINER_PORT} OPENSESSION_BOOT_MODE=snapshot-restore bash .agents/start.sh < /dev/null > /tmp/boot.log 2>&1 &) && echo relaunched`,
        timeoutMs: 30_000,
      },
      true,
    );
    return;
  }
  if (!isDaytona(c)) {
    await docker(["restart", "-t", "5", c.name], 60_000);
    return;
  }
  await poolExec(
    c,
    `pkill -TERM -f 'start.sh|dev-services|next dev|concurrently' 2>/dev/null; sleep 3; pkill -KILL -f 'next dev|rescript' 2>/dev/null; true`,
    30_000,
  );
  await launchDaytonaDev(c);
}

/** (Re)launch the dev server inside a daytona sandbox. MUST go through a
 *  Daytona process session with runAsync — plain-exec children are reaped
 *  when the exec ends (verified live: setsid-orphaned dev servers died a
 *  couple of minutes after passing the ready gate). */
async function launchDaytonaDev(c: PoolContainer): Promise<void> {
  await reseedEnv(c);
  const env = `WEBAPP_PORT=${CONTAINER_PORT} OPENSESSION_BOOT_MODE=snapshot-restore${c.previewUrl ? ` PREVIEW_URL=${c.previewUrl}` : ""}`;
  // stdin MUST be detached: next dev exits cleanly on stdin EOF (its
  // keyboard-shortcut listener), and the process session's pipe closing
  // produced exactly that — "next dev exited with code 0" crash-loops.
  const script = `export PATH="/usr/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH" && ${BOOT_PREP} && ${env} bash .agents/start.sh < /dev/null > /tmp/boot.log 2>&1`;
  const b64 = Buffer.from(script, "utf-8").toString("base64");
  const sbx = await daytonaSbx(c.name);
  const sid = `os-preview-dev-${Date.now().toString(36)}`;
  await sbx.process.createSession(sid);
  await sbx.process.executeSessionCommand(sid, {
    command: `bash -c 'echo ${b64} | base64 -d | bash'`,
    runAsync: true,
  } as never);
}

/** A free host port in the webapp dev range, so httpsPortFor(+6000) applies. */
async function allocateHostPort(): Promise<number | null> {
  for (let i = 0; i < 25; i++) {
    const port = 3100 + Math.floor(Math.random() * 900);
    const raw = await $`ss -tlnH sport = :${port}`.quiet().nothrow().text();
    if (!raw.trim()) return port;
  }
  return null;
}

// ── Boot scripts (run inside the container) ─────────────────────────────────

function fullPortsConf(): string {
  // Fixed sibling ports are fine: every container has its own network ns.
  return [
    `WEBAPP_PORT=${CONTAINER_PORT}`,
    "INSTANT_PORT=5312",
    "WEBAPP_WORKFLOW_PORT=6412",
    "WEBAPP_EMAILS_PREVIEW_PORT=6518",
    "TEMPORAL_PORT=7312",
    "TEMPORAL_UI_PORT=8312",
    "",
  ].join("\n");
}

/**
 * Write the AWS profile file inside a running container (see module doc).
 * The default section supports provisioning steps; any named profiles declared
 * by registered repos support applications that set AWS_PROFILE themselves.
 */
async function refreshContainerCreds(
  target: string | PoolContainer,
): Promise<boolean> {
  const env = await getAgentAwsEnv();
  if (!env.AWS_ACCESS_KEY_ID) return false;
  const section = [
    `aws_access_key_id = ${env.AWS_ACCESS_KEY_ID}`,
    `aws_secret_access_key = ${env.AWS_SECRET_ACCESS_KEY}`,
    ...(env.AWS_SESSION_TOKEN
      ? [`aws_session_token = ${env.AWS_SESSION_TOKEN}`]
      : []),
  ];
  const profiles = [
    ...new Set(
      Object.values(configuredRepos())
        .map((repo) => repo.previewAwsProfile)
        .filter((value): value is string => !!value),
    ),
  ];
  const lines = [
    "[default]",
    ...section,
    "",
    ...profiles.flatMap((profile) => [`[${profile}]`, ...section, ""]),
  ].join("\n");
  const region = env.AWS_REGION || "us-east-2";
  const configLines = [
    "[default]",
    `region = ${region}`,
    ...profiles.flatMap((profile) => [
      "",
      `[profile ${profile}]`,
      `region = ${region}`,
    ]),
    "",
  ].join("\\n");
  const script = `mkdir -p ~/.aws && cat > ~/.aws/credentials <<'BKSEOF'\n${lines}\nBKSEOF\nprintf '%b' '${configLines}' > ~/.aws/config && chmod 600 ~/.aws/credentials`;
  const r =
    typeof target === "string"
      ? await dockerExec(target, script)
      : await poolExec(target, script);
  return r.ok;
}

export async function cloneUrlFor(
  repo: Repo,
  opts?: { longLived?: boolean },
): Promise<string | null> {
  if (repo.host === "codestorage") {
    // Default: short-lived — pool fetches use the URL immediately, and the 1h
    // TTL covers even a slow golden build's clone. `longLived` (30 days) is
    // for URLs baked into a warm container's boot command line, which re-runs
    // on the `docker restart` clean-reboot path hours or days later — the
    // tradeoff is a write-scoped repo token visible in docker inspect for the
    // container's life (same call as sandbox remotes, bootstrap.ts).
    if (!repo.csRepo || !codeStorageConfig()) return null;
    return authedRemoteUrl(
      repo.csRepo,
      opts?.longLived ? { ttlSeconds: 30 * 24 * 3600 } : {},
    );
  }
  if (!repo.ghRepo) return null;
  // Installation tokens expire too quickly to bake into a container command
  // that may restart days later. Warm restarts use the golden tree; one-shot
  // golden and Daytona operations mint a fresh repository token below.
  if (opts?.longLived) return null;
  const plain = `https://github.com/${repo.ghRepo}.git`;
  const selected = await injectCloneCredential(plain);
  return selected === plain ? null : selected;
}

/** Boot preamble every warm/golden boot runs: lock cleanup + full ports.conf. */
const BOOT_PREP = [
  `cd ${WORKSPACE}`,
  // The committed image can carry a stale /tmp/boot.log from the golden
  // build's shutdown (its 'error: Recipe … signal 15' lines). start.sh's
  // redirect truncates it — but only after the git-advance step, and
  // waitForUp's early error grep reads the stale file in that window and
  // kills a healthy boot. Truncate FIRST.
  `: > /tmp/boot.log`,
  // ReScript watch.lock survives SIGKILL and blocks the next boot.
  `find . -maxdepth 6 -name watch.lock -not -path '*/node_modules/*' -delete 2>/dev/null || true`,
  `rm -f .ports/dev-pgid`,
].join(" && ");

/**
 * Wait for the in-container dev server to answer on the host port — with
 * failure exits: a dead boot (log shows a failed recipe / start.sh exited)
 * aborts immediately with the log tail instead of polling out the clock.
 */
async function waitForUp(
  name: string,
  hostPort: number,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  let probes = 0;
  while (Date.now() < deadline) {
    const code = await httpCode(
      `http://127.0.0.1:${hostPort}/`,
      "localhost:3300",
      5,
    );
    if (code !== 0) return { ok: true, detail: `HTTP ${code}` };
    probes++;
    if (probes % 3 === 0) {
      if ((await containerRunning(name)) !== "running") {
        return { ok: false, detail: "container died" };
      }
      const log = await dockerExec(
        name,
        `sed 's/\\x1b\\[[0-9;]*m//g' /tmp/boot.log 2>/dev/null | grep -aE 'error: Recipe|Watcher exited|exited with code' | tail -3`,
      );
      if (log.out.includes("error: Recipe")) {
        const tail = await dockerExec(
          name,
          "tail -c 1500 /tmp/boot.log 2>/dev/null",
        );
        return { ok: false, detail: `boot failed: ${log.out}\n${tail.out}` };
      }
    }
    await Bun.sleep(2000);
  }
  return { ok: false, detail: "timed out" };
}

async function httpCode(
  url: string,
  host: string,
  timeoutSec: number,
): Promise<number> {
  try {
    const res = await fetch(url, {
      headers: { Host: host },
      signal: AbortSignal.timeout(timeoutSec * 1000),
      redirect: "manual",
    });
    return res.status;
  } catch {
    return 0;
  }
}

/** Request the repo's warm routes so Turbopack pre-compiles them. */
async function warmRoutes(repo: Repo, hostPort: number): Promise<void> {
  let routes = ["/"];
  try {
    const raw = await dockerReadWorkspaceFile(repo, ".agents/preview.json");
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed?.warmRoutes) && parsed.warmRoutes.length)
      routes = parsed.warmRoutes;
  } catch {}
  for (const r of routes) {
    await httpCode(`http://127.0.0.1:${hostPort}${r}`, "localhost:3300", 120);
  }
}

async function dockerReadWorkspaceFile(
  _repo: Repo,
  rel: string,
): Promise<string | null> {
  // Read from the host main checkout — same content, no container roundtrip.
  const repoRoot = _repo.repo;
  const p = join(repoRoot, rel);
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
}

/** Is this HTTP status "the app answered"? Daytona's proxy answers even
 *  when the upstream is down (502/503) or the link is token-gated (401) —
 *  those mean NOT up. Docker's loopback only answers when dev listens. */
function poolCodeLive(c: PoolContainer, code: number): boolean {
  if (code === 0) return false;
  if (!isDaytona(c)) return true;
  return code < 500 && code !== 401 && code !== 403;
}

/** HTTP status for a path on a pool member's app, whichever backend. */
async function poolHttpCode(
  c: PoolContainer,
  path: string,
  timeoutSec: number,
): Promise<number> {
  if (isMicrovm(c)) {
    return httpCode(
      `http://${mvmIp(c)}:${CONTAINER_PORT}${path}`,
      `localhost:${CONTAINER_PORT}`,
      timeoutSec,
    );
  }
  if (isDaytona(c)) {
    if (!c.previewUrl) return 0;
    try {
      const res = await fetch(`${c.previewUrl.replace(/\/$/, "")}${path}`, {
        signal: AbortSignal.timeout(timeoutSec * 1000),
        redirect: "manual",
      });
      return res.status;
    } catch {
      return 0;
    }
  }
  return httpCode(
    `http://127.0.0.1:${c.hostPort}${path}`,
    `localhost:${CONTAINER_PORT}`,
    timeoutSec,
  );
}

/** Backend-generic waitForUp for pool members (see waitForUp's contract). */
async function waitForPoolUp(
  c: PoolContainer,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  let probes = 0;
  while (Date.now() < deadline) {
    const code = await poolHttpCode(c, "/", 6);
    if (poolCodeLive(c, code)) return { ok: true, detail: `HTTP ${code}` };
    probes++;
    if (probes % 3 === 0) {
      if ((await poolRuntimeStatus(c)) === "gone")
        return { ok: false, detail: "sandbox gone" };
      const log = await poolExec(
        c,
        `sed 's/\\x1b\\[[0-9;]*m//g' /tmp/boot.log 2>/dev/null | grep -aE 'error: Recipe|Watcher exited' | tail -3`,
      );
      if (log.out.includes("error: Recipe")) {
        const tail = await poolExec(
          c,
          "tail -c 1500 /tmp/boot.log 2>/dev/null",
        );
        return { ok: false, detail: `boot failed: ${log.out}\n${tail.out}` };
      }
    }
    await Bun.sleep(2500);
  }
  return { ok: false, detail: "timed out" };
}

async function warmRoutesPool(repo: Repo, c: PoolContainer): Promise<void> {
  let routes = ["/"];
  try {
    const raw = await dockerReadWorkspaceFile(repo, ".agents/preview.json");
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed?.warmRoutes) && parsed.warmRoutes.length)
      routes = parsed.warmRoutes;
  } catch {}
  for (const r of routes) await poolHttpCode(c, r, 120);
}

/**
 * Provision + boot a warm Daytona sandbox. Unlike docker there is no golden
 * image: each sandbox pays the full provision once (toolchain + clone + deps
 * + WASM + boot, ~5-10 min) and then lives warm — `ready` running, `paused`
 * stopped-with-disk (restart ≈30-60s on warm caches). Path parity with the
 * docker image is kept by creating the same workspace path via sudo,
 * so every shared boot/converge script works unchanged.
 */
async function spawnDaytonaWarm(repo: Repo): Promise<void> {
  const cloneUrl = await cloneUrlFor(repo);
  if (!cloneUrl) {
    return console.warn(
      `[preview-pool] ${repo.id}: daytona backend needs a ghRepo + selected GitHub credential`,
    );
  }
  const client = await daytonaClientForPool();
  const scfg = sandboxConfig();
  const sbx = await client.create(
    {
      ...(scfg.daytona?.snapshot ? { snapshot: scfg.daytona.snapshot } : {}),
      labels: { [POOL_LABEL]: repo.id, "os-preview-pool-kind": "warm" },
      // Preview links are token-gated by Daytona's proxy (401 for browsers);
      // public:true makes the per-sandbox URL open — access control is the
      // unguessable sandbox uuid, same trade-off as Modal publicPreviews.
      public: true,
      // Never auto-stop a warm pool member — the sweep manages lifecycle.
      autoStopInterval: 0,
    } as never,
    { timeout: 300 },
  );
  const c: PoolContainer = {
    name: sbx.id,
    repoId: repo.id,
    backend: "daytona",
    state: "warming",
    hostPort: 0,
    bootSha: "",
    createdAt: new Date().toISOString(),
  };
  patchContainer(repo.id, sbx.id, c);
  const fail = async (msg: string) => {
    // git failure output can echo the full authed clone URL (live JWT).
    console.warn(
      `[preview-pool] ${repo.id}: daytona warm ${sbx.id} failed: ${redactUrl(msg).slice(0, 600)}`,
    );
    await destroyContainer(repo.id, sbx.id);
  };
  try {
    const link = await sbx.getPreviewLink(CONTAINER_PORT);
    if (!link?.url) return void (await fail("no preview link"));
    c.previewUrl = link.url;
    patchContainer(repo.id, sbx.id, { previewUrl: link.url });

    // Toolchain + path parity (idempotent; daytonaio/sandbox has passwordless
    // sudo). just needs >=1.40 for Justfile modules — same pin rationale as
    // the docker image.
    const tool = await poolExec(
      c,
      [
        `sudo mkdir -p ${WORKSPACE.replace(/\/[^/]+$/, "")} && sudo chown $(id -un) ${WORKSPACE.replace(/\/[^/]+$/, "")}`,
        `command -v git >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq git)`,
        `/usr/bin/node -v 2>/dev/null | grep -q '^v24' || (curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - >/dev/null && sudo apt-get install -y -qq nodejs)`,
        `command -v bun >/dev/null || (curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1)`,
        `export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"`,
        `command -v just >/dev/null || (curl -fsSL https://just.systems/install.sh | sudo bash -s -- --to /usr/local/bin >/dev/null)`,
        `sudo apt-get install -y -qq lsof >/dev/null 2>&1 || true`,
        `echo TOOLCHAIN-OK`,
      ].join(" && "),
      12 * 60_000,
    );
    if (!tool.out.includes("TOOLCHAIN-OK"))
      return void (await fail(`toolchain: ${tool.out.slice(-400)}`));

    await refreshContainerCreds(c);
    const clone = await poolExec(
      c,
      `[ -d ${WORKSPACE}/.git ] || git clone --depth 1 --branch ${shellQuoteWord(repo.defaultBranch)} ${JSON.stringify(cloneUrl)} ${WORKSPACE}`,
      8 * 60_000,
    );
    if (!clone.ok) return void (await fail(`clone: ${clone.out.slice(-400)}`));
    if (repo.host !== "codestorage") {
      // git clone persists its authority in remote.origin.url. Remove the
      // repository-scoped App token before any repository-owned setup/start
      // code can inspect it.
      const safeOrigin = `https://github.com/${repo.ghRepo}.git`;
      const scrub = await poolExec(
        c,
        `git -C ${WORKSPACE} remote set-url origin ${shellQuoteWord(safeOrigin)}`,
      );
      if (!scrub.ok)
        return void (await fail(`credential scrub: ${scrub.out.slice(-400)}`));
    }

    for (const rel of SEED_ENV_FILES) {
      const content = envSeedContent(repo, rel);
      if (content === null) continue;
      if (!(await poolWriteFile(c, `${WORKSPACE}/${rel}`, content))) {
        return void (await fail(`seed ${rel} failed`));
      }
    }
    await poolWriteFile(c, `${WORKSPACE}/.ports.conf`, fullPortsConf());

    const setup = await poolExec(
      c,
      `export PATH="/usr/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"; cd ${WORKSPACE} && [ -f .agents/setup ] && OPENSESSION_BOOT_MODE=fresh bash .agents/setup || true`,
      20 * 60_000,
    );
    if (setup.out.includes("ERROR:"))
      return void (await fail(`.agents/setup: ${setup.out.slice(-400)}`));
    for (const marker of provisionMarkers(repo.id)) {
      const chk = await poolExec(c, `test -e ${WORKSPACE}/${marker}`);
      if (!chk.ok) {
        return void (await fail(
          `provisioning incomplete: ${marker} missing — setup said: ${setup.out.slice(-500)}`,
        ));
      }
    }

    await launchDaytonaDev(c);
    const up = await waitForPoolUp(c, 6 * 60_000);
    if (!up.ok) return void (await fail(`boot: ${up.detail}`));
    const bootSha = (
      await poolExec(c, `git -C ${WORKSPACE} rev-parse HEAD`)
    ).out.trim();
    await warmRoutesPool(repo, c);
    patchContainer(repo.id, sbx.id, {
      state: "ready",
      bootSha,
      previewUrl: c.previewUrl,
    });
    console.log(
      `[preview-pool] ${repo.id}: daytona warm ${sbx.id} ready at ${c.previewUrl} (${bootSha.slice(0, 10)})`,
    );
  } catch (e) {
    await fail(String((e as Error)?.message || e));
  }
}

// ── Golden image build ───────────────────────────────────────────────────────

async function originDefaultSha(repo: Repo): Promise<string | null> {
  await $`git -C ${repo.repo} fetch origin ${repo.defaultBranch} --quiet`
    .quiet()
    .nothrow();
  const sha = (
    await $`git -C ${repo.repo} rev-parse origin/${repo.defaultBranch}`
      .quiet()
      .nothrow()
      .text()
  ).trim();
  return sha || null;
}

export async function refreshGoldenImage(
  repoId: string,
  force = false,
): Promise<boolean> {
  const existing = busy.get(`golden-${repoId}`);
  if (existing) return existing as Promise<boolean>;
  // The microvm golden derives FROM the docker golden image: refresh the
  // docker image first (skips when fresh), then run the export→boot→warm→
  // snapshot pipeline (deploy/sandbox/microvm/refresh-golden.sh, ~15 min).
  const backend = previewPoolConfig(repoId).backend;
  const job: Promise<boolean> =
    backend === "microvm"
      ? (async () => {
          if (!(await doRefreshGolden(repoId, force))) return false;
          const env = await getAgentAwsEnv();
          const section = [
            `aws_access_key_id = ${env.AWS_ACCESS_KEY_ID}`,
            `aws_secret_access_key = ${env.AWS_SECRET_ACCESS_KEY}`,
            ...(env.AWS_SESSION_TOKEN
              ? [`aws_session_token = ${env.AWS_SESSION_TOKEN}`]
              : []),
          ];
          const profile = configuredRepos()[repoId]?.previewAwsProfile;
          const b64 = Buffer.from(
            [
              "[default]",
              ...section,
              "",
              ...(profile ? [`[${profile}]`, ...section, ""] : []),
            ].join("\n"),
            "utf-8",
          ).toString("base64");
          const region = env.AWS_REGION || "us-east-1";
          const configB64 = Buffer.from(
            [
              "[default]",
              `region = ${region}`,
              ...(profile
                ? ["", `[profile ${profile}]`, `region = ${region}`]
                : []),
              "",
            ].join("\n"),
            "utf-8",
          ).toString("base64");
          const r = await sudoRun(
            [
              "env",
              `OPENSESSION_AWS_B64=${b64}`,
              `OPENSESSION_AWS_CONFIG_B64=${configB64}`,
              "bash",
              `${MVM_SCRIPTS}/refresh-golden.sh`,
              repoId,
              MVM_STORE,
            ],
            30 * 60_000,
          );
          if (!r.ok) {
            console.warn(
              `[preview-pool] ${repoId}: microvm golden refresh failed: ${redactUrl(r.out.slice(-600))}`,
            );
            return false;
          }
          console.log(`[preview-pool] ${repoId}: microvm golden refreshed`);
          return true;
        })()
      : doRefreshGolden(repoId, force);
  const run = job
    .then((succeeded) => {
      if (succeeded) {
        const state = readState(repoId);
        delete state.branchRebuildPending;
        writeState(repoId, state);
      }
      return succeeded;
    })
    .finally(() => busy.delete(`golden-${repoId}`));
  busy.set(`golden-${repoId}`, run);
  return run;
}

async function doRefreshGolden(
  repoId: string,
  force: boolean,
): Promise<boolean> {
  const repo = configuredRepos()[repoId];
  if (!repo) return false;
  const cfg = previewPoolConfig(repoId);
  if (!cfg.enabled && !force) return true;
  const state = readState(repoId);
  const sha = await originDefaultSha(repo);
  if (!sha) return false;
  const imageExists = (
    await docker(["image", "inspect", `${goldenImage(repoId)}:latest`])
  ).ok;
  const ageMs = state.golden?.builtAt
    ? Date.now() - Date.parse(state.golden.builtAt)
    : Infinity;
  if (
    !force &&
    imageExists &&
    state.golden?.sha &&
    ageMs < cfg.goldenIntervalHours * 3_600_000
  ) {
    return true;
  }
  const started = Date.now();
  const name = `os-preview-goldenbuild-${repoId}`;
  const cloneUrl = await cloneUrlFor(repo);
  console.log(
    `[preview-pool] ${repoId}: building golden image at ${sha.slice(0, 10)}`,
  );
  const fail = async (rawMsg: string): Promise<false> => {
    // git failure output can echo the full authed clone URL (live JWT).
    const msg = redactUrl(rawMsg);
    console.warn(
      `[preview-pool] ${repoId}: golden build failed: ${msg.slice(0, 800)}`,
    );
    writeState(repoId, {
      ...readState(repoId),
      golden: {
        ...(readState(repoId).golden ?? { sha: "", builtAt: "" }),
        lastError: msg.slice(0, 500),
      },
    });
    await docker(["rm", "-f", name]);
    return false;
  };

  try {
    await docker(["rm", "-f", name]);
    const run = await docker([
      "run",
      "-d",
      "--name",
      name,
      "--label",
      `${POOL_LABEL}=goldenbuild`,
      "-v",
      `${repo.repo}:/src:ro`,
      "-p",
      `127.0.0.1::${CONTAINER_PORT}`,
      "--cpus",
      String(cfg.cpus),
      "--memory",
      cfg.memory,
      "opensession-runner:latest",
      "sleep",
      "infinity",
    ]);
    if (!run.ok) return fail(`docker run: ${run.out}`);

    // Workspace: clone from the RO-mounted host checkout (fast), then align
    // to origin/<default> over https so the golden never lags the remote.
    // Depth 1: the workspace never needs history (worktree->container sync is
    // computed host-side; the container only ever resets to a fetched tip).
    let r = await dockerExec(
      name,
      `git clone --depth 1 --branch ${shellQuoteWord(repo.defaultBranch)} file:///src ${WORKSPACE}`,
      5 * 60_000,
    );
    if (!r.ok) return fail(`clone: ${r.out.slice(-500)}`);
    if (cloneUrl) {
      r = await dockerExec(
        name,
        `cd ${WORKSPACE} && git fetch --depth 1 ${JSON.stringify(cloneUrl)} ${shellQuoteWord(repo.defaultBranch)} && git reset --hard FETCH_HEAD`,
        5 * 60_000,
      );
      if (!r.ok) return fail(`fetch/reset: ${r.out.slice(-500)}`);
    }
    const wsSha = (
      await dockerExec(name, `git -C ${WORKSPACE} rev-parse HEAD`)
    ).out.trim();

    // Seed gitignored env files from the host checkout (same seeding the
    // session worktrees get — .env.local is required by start.sh).
    for (const rel of ["packages/core/webapp/.env.local", ".envrc"]) {
      const src = join(repo.repo, rel);
      if (!existsSync(src)) continue;
      await docker(["cp", src, `${name}:${WORKSPACE}/${rel}`]);
    }
    await dockerExec(
      name,
      `cat > ${WORKSPACE}/.ports.conf <<'EOF'\n${fullPortsConf()}EOF`,
    );
    if (!(await refreshContainerCreds(name))) {
      console.warn(
        `[preview-pool] ${repoId}: no AWS creds available for golden build (WASM install may fail)`,
      );
    }

    // One-shot provisioning via the repo's own lifecycle contract.
    const setup = await dockerExec(
      name,
      `cd ${WORKSPACE} && [ -f .agents/setup ] && OPENSESSION_BOOT_MODE=fresh bash .agents/setup || true`,
      15 * 60_000,
    );
    if (setup.out.includes("ERROR:"))
      return fail(`.agents/setup: ${setup.out.slice(-500)}`);
    // The setup hook treats a failed WASM install as a non-fatal WARN, but a golden
    // without these artifacts boots into module-not-found crashes on first
    // page compile — verify hard instead of shipping a degraded image.
    for (const marker of provisionMarkers(repoId)) {
      const chk = await dockerExec(name, `test -e ${WORKSPACE}/${marker}`);
      if (!chk.ok) {
        return fail(
          `provisioning incomplete: ${marker} missing after .agents/setup (S3 WASM install failed? ${setup.out.slice(-300)})`,
        );
      }
    }

    // Boot, wait (with failure exits), warm, stop cleanly.
    const inspect = await docker(["port", name, `${CONTAINER_PORT}/tcp`]);
    const hostPort = parseInt(inspect.out.match(/:(\d+)$/m)?.[1] ?? "", 10);
    if (!hostPort) return fail(`no published port: ${inspect.out}`);
    await docker([
      "exec",
      "-d",
      "-e",
      `WEBAPP_PORT=${CONTAINER_PORT}`,
      "-e",
      "OPENSESSION_BOOT_MODE=fresh",
      "-w",
      WORKSPACE,
      name,
      "bash",
      "-c",
      `${BOOT_PREP} && exec bash .agents/start.sh > /tmp/boot.log 2>&1`,
    ]);
    const up = await waitForUp(name, hostPort, 5 * 60_000);
    if (!up.ok) return fail(`boot: ${up.detail}`);
    await warmRoutes(repo, hostPort);
    // Route warming compiles real pages — if that crashed the dev tree
    // (e.g. missing artifacts), the image is broken; don't commit it.
    const post = await dockerExec(
      name,
      `grep -aE 'error: Recipe|fatal error' /tmp/boot.log | head -2; true`,
    );
    if (post.out.trim())
      return fail(
        `dev server died during route warming: ${post.out.slice(0, 300)}`,
      );

    // Graceful stop so the image carries no dev-server runtime state.
    await dockerExec(
      name,
      `pkill -TERM -f 'start.sh|dev-services|next dev|concurrently' 2>/dev/null; sleep 5; pkill -KILL -f 'next dev|rescript' 2>/dev/null; ${BOOT_PREP}; rm -f /tmp/boot.log; true`,
      30_000,
    );
    // Previews use the app's NORMAL auth by default: the DEV_AUTH_* bypass
    // stays active during the build (so route warming pre-compiles authed
    // pages into the cache) and is stripped from the image before commit.
    if (!cfg.devAuthBypass) {
      await dockerExec(
        name,
        `find ${WORKSPACE} -maxdepth 4 -name '.env.local' -not -path '*/node_modules/*' -exec sed -i '/^DEV_AUTH_/d' {} +`,
      );
    }
    await docker(["stop", "-t", "10", name], 30_000);
    // Committing an ~8GB layer is I/O-bound and can take many minutes when
    // the host is busy — a timeout here discards a fully verified build.
    const commit = await docker(
      ["commit", name, `${goldenImage(repoId)}:new`],
      15 * 60_000,
    );
    if (!commit.ok) return fail(`commit: ${commit.out}`);
    // Rotate: latest -> prev, new -> latest.
    await docker(["rmi", `${goldenImage(repoId)}:prev`]);
    await docker([
      "tag",
      `${goldenImage(repoId)}:latest`,
      `${goldenImage(repoId)}:prev`,
    ]);
    await docker([
      "tag",
      `${goldenImage(repoId)}:new`,
      `${goldenImage(repoId)}:latest`,
    ]);
    await docker(["rmi", `${goldenImage(repoId)}:new`]);
    await docker(["rm", "-f", name]);

    writeState(repoId, {
      ...readState(repoId),
      golden: { sha: wsSha || sha, builtAt: new Date().toISOString() },
    });
    console.log(
      `[preview-pool] ${repoId}: golden image ready at ${(wsSha || sha).slice(0, 10)} in ${Math.round((Date.now() - started) / 1000)}s`,
    );
    // Old-golden warm spares are stale — retire unclaimed ones so the pool
    // refills from the new image (claimed ones live until their preview ends).
    const st = readState(repoId);
    for (const [cname, c] of Object.entries(st.containers)) {
      if (c.state !== "claimed") await destroyContainer(repoId, cname);
    }
    return true;
  } catch (e) {
    return fail(String((e as Error)?.message || e));
  }
}

// ── Warm containers ──────────────────────────────────────────────────────────

async function spawnWarmContainer(repo: Repo): Promise<void> {
  const cfg = previewPoolConfig(repo.id);
  const hostPort = await allocateHostPort();
  if (!hostPort)
    return console.warn(`[preview-pool] ${repo.id}: no free host port`);
  const name = `os-preview-warm-${repo.id}-${Math.random().toString(36).slice(2, 8)}`;
  const { previewHost, httpsPortFor } = await import("./preview");
  const host = await previewHost();
  const previewUrl = `https://${host}:${httpsPortFor(hostPort)}`;
  // Never bake an hour-lived repository token into a boot command that can be
  // re-run days later.
  const cloneUrl = await cloneUrlFor(repo, { longLived: true });

  patchContainer(repo.id, name, {
    name,
    repoId: repo.id,
    state: "warming",
    hostPort,
    bootSha: "",
    createdAt: new Date().toISOString(),
  });

  // Advance the workspace to current origin/<default> before boot so warm
  // containers never serve a stale golden tree (delta fetch — seconds).
  // Guarded by the claimed-marker: once a claim converges the workspace to a
  // session branch, a `docker restart` (the big-delta clean-reboot path) must
  // NOT reset it back to the default branch.
  const advance = cloneUrl
    ? `{ [ -f ${WORKSPACE}/${CLAIMED_MARKER} ] || (git fetch --depth 1 ${JSON.stringify(cloneUrl)} ${shellQuoteWord(repo.defaultBranch)} && git reset --hard FETCH_HEAD) || true; } && `
    : "";
  // create + seed + start rather than `run`: the golden image carries the env
  // files that were current when it was committed, and the boot command reads
  // them immediately — copying them in after `run` would race the app's own
  // startup. On a created-but-not-started container only `docker cp` works
  // (poolWriteFile's docker path needs a running container to exec in).
  const create = await docker([
    "create",
    "--name",
    name,
    "--label",
    `${POOL_LABEL}=${repo.id}`,
    "-p",
    `127.0.0.1:${hostPort}:${CONTAINER_PORT}`,
    "--cpus",
    String(cfg.cpus),
    "--memory",
    cfg.memory,
    "-e",
    `WEBAPP_PORT=${CONTAINER_PORT}`,
    "-e",
    "OPENSESSION_BOOT_MODE=snapshot-restore",
    "-e",
    `PREVIEW_URL=${previewUrl}`,
    // No AWS_* env: apps may resolve credentials via their configured profile;
    // refreshContainerCreds writes both default and named sections.
    "-w",
    WORKSPACE,
    `${goldenImage(repo.id)}:latest`,
    "bash",
    "-c",
    `${BOOT_PREP} && ${advance}exec bash .agents/start.sh > /tmp/boot.log 2>&1`,
  ]);
  if (!create.ok) {
    patchContainer(repo.id, name, null);
    // docker failure output can echo the command line, authed cloneUrl included.
    return console.warn(
      `[preview-pool] ${repo.id}: warm spawn failed: ${redactUrl(create.out.slice(-300))}`,
    );
  }
  await copySeedEnvFiles(name, repo);
  const run = await docker(["start", name]);
  if (!run.ok) {
    await docker(["rm", "-f", name]);
    patchContainer(repo.id, name, null);
    return console.warn(
      `[preview-pool] ${repo.id}: warm start failed: ${redactUrl(run.out.slice(-300))}`,
    );
  }
  await refreshContainerCreds(name);
  const up = await waitForUp(name, hostPort, 4 * 60_000);
  if (!up.ok) {
    console.warn(
      `[preview-pool] ${repo.id}: warm boot failed (${up.detail.slice(0, 500)})`,
    );
    return destroyContainer(repo.id, name);
  }
  const bootSha = (
    await dockerExec(name, `git -C ${WORKSPACE} rev-parse HEAD`)
  ).out.trim();
  await warmRoutes(repo, hostPort);
  patchContainer(repo.id, name, { state: "ready", bootSha });
  console.log(
    `[preview-pool] ${repo.id}: warm container ${name} ready on :${hostPort} (${bootSha.slice(0, 10)})`,
  );
}

async function destroyContainer(repoId: string, name: string): Promise<void> {
  const c = readState(repoId).containers[name];
  if (c) await poolDestroyRef(c);
  else await docker(["rm", "-f", name]);
  patchContainer(repoId, name, null);
}

/** Refill only when a branch-derived golden artifact was rebuilt. Daytona
 * provisions directly and therefore has no golden gate. */
export async function rebuildInvalidatedPreviewPool(
  backend: PreviewPoolBackend,
  rebuildGolden: () => Promise<boolean>,
  refill: () => Promise<void>,
): Promise<boolean> {
  if (backend !== "daytona" && !(await rebuildGolden())) return false;
  await refill();
  return true;
}

/** Retire every unclaimed member derived from the previous default branch,
 * then rebuild and refill from the new one. Multiple changes coalesce, but a
 * change arriving during a rebuild advances the generation and gets another
 * pass rather than being lost behind the in-flight work. */
export function invalidatePreviewPoolDefaultBranch(repoId: string): void {
  const version = (defaultBranchInvalidationVersion.get(repoId) || 0) + 1;
  defaultBranchInvalidationVersion.set(repoId, version);

  const detachUnclaimed = () => {
    const state = readState(repoId);
    const retired = Object.values(state.containers).filter(
      (container) => container.state !== "claimed",
    );
    for (const container of retired) delete state.containers[container.name];
    delete state.golden;
    state.branchRebuildPending = true;
    writeState(repoId, state);
    if (retired.length) {
      const queued = retiredDefaultBranchMembers.get(repoId) || [];
      queued.push(...retired);
      retiredDefaultBranchMembers.set(repoId, queued);
    }
  };
  // Remove stale members from the claimable state before any asynchronous
  // cleanup so a request racing this invalidation cannot claim one.
  detachUnclaimed();

  const key = `default-branch-${repoId}`;
  if (busy.has(key)) return;
  let handledVersion = 0;
  const run = (async () => {
    while (
      handledVersion < (defaultBranchInvalidationVersion.get(repoId) || 0)
    ) {
      const targetVersion = defaultBranchInvalidationVersion.get(repoId) || 0;
      const sweep = busy.get("sweep");
      if (sweep) await sweep;
      const golden = busy.get(`golden-${repoId}`);
      if (golden) await golden;

      // A sweep or golden build that was already in flight may have added more
      // old-branch members after the synchronous detach above.
      detachUnclaimed();
      const retired = retiredDefaultBranchMembers.get(repoId)?.splice(0) || [];
      for (const container of retired) {
        await poolDestroyRef(container).catch((error) => {
          console.warn(
            `[preview-pool] ${repoId}: could not retire ${container.name}:`,
            error,
          );
        });
      }

      const repo = configuredRepos()[repoId];
      if (!repo) return;
      const cfg = previewPoolConfig(repoId);
      if (cfg.enabled) {
        await rebuildInvalidatedPreviewPool(
          cfg.backend,
          () => refreshGoldenImage(repoId, true),
          () => ensurePool(repo),
        );
      }
      handledVersion = targetVersion;
    }
  })()
    .catch((error) => {
      console.warn(
        `[preview-pool] ${repoId}: default branch invalidation failed:`,
        error,
      );
    })
    .finally(() => busy.delete(key));
  busy.set(key, run);
}

/** Reconcile one repo's pool: docker truth vs state, then top up. */
async function ensurePool(repo: Repo): Promise<void> {
  const cfg = previewPoolConfig(repo.id);
  const state = readState(repo.id);

  // Reconcile against docker.
  for (const [name, c] of Object.entries(state.containers)) {
    const status = await poolRuntimeStatus(c);
    if (status === "gone") {
      // Microvm leftovers need their netns/disk/route cleaned, not just the
      // record dropped.
      if (isMicrovm(c)) await destroyContainer(repo.id, name);
      else patchContainer(repo.id, name, null);
      continue;
    }
    if (
      c.state === "claimed" &&
      c.sessionWorktree &&
      !existsSync(c.sessionWorktree)
    ) {
      await destroyContainer(repo.id, name); // session worktree is gone
      continue;
    }
    // Idle claims: nobody has polled this preview's status in a while — the
    // viewer is gone. Release the container (the pool refills fresh ones).
    if (c.state === "claimed") {
      const lastSeen = Date.parse(c.lastSeenAt || c.claimedAt || c.createdAt);
      if (Date.now() - lastSeen > cfg.claimIdleMinutes * 60_000) {
        console.log(
          `[preview-pool] ${repo.id}: releasing idle claim ${name} (${c.sessionWorktree})`,
        );
        await destroyContainer(repo.id, name);
      }
      continue;
    }
    // A warming entry with no live boot (e.g. process restarted mid-boot).
    if (
      c.state === "warming" &&
      Date.now() - Date.parse(c.createdAt) > 10 * 60_000
    ) {
      await destroyContainer(repo.id, name);
    }
  }

  if (!cfg.enabled) {
    // Disabled: drain unclaimed warm containers.
    for (const [name, c] of Object.entries(readState(repo.id).containers)) {
      if (c.state !== "claimed") await destroyContainer(repo.id, name);
    }
    return;
  }

  // A failed branch-change rebuild leaves the old artifact installed, but it
  // must stay quarantined. Retry the rebuild and do not spawn until the full
  // backend-specific pipeline succeeds and clears this persistent marker.
  if (
    cfg.backend !== "daytona" &&
    readState(repo.id).branchRebuildPending &&
    !(await refreshGoldenImage(repo.id, true))
  ) {
    return;
  }

  // Golden images are a docker concept; daytona sandboxes provision directly.
  if (
    cfg.backend === "docker" &&
    !(await docker(["image", "inspect", `${goldenImage(repo.id)}:latest`])).ok
  ) {
    await refreshGoldenImage(repo.id);
    return;
  }
  // The microvm backend needs its golden snapshot before anything can spawn.
  if (cfg.backend === "microvm" && !mvmGoldenReady()) {
    console.warn(
      `[preview-pool] ${repo.id}: microvm backend enabled but no golden snapshot — POST /preview-pool/${repo.id}/refresh builds it`,
    );
    return;
  }

  const fresh = readState(repo.id).containers;
  // A backend switch strands members of the other backend — drain them so
  // the pool converges onto the configured one.
  for (const [name, c] of Object.entries(fresh)) {
    if (c.state !== "claimed" && (c.backend ?? "docker") !== cfg.backend) {
      await destroyContainer(repo.id, name);
    }
  }
  const mine = Object.values(readState(repo.id).containers).filter(
    (c) => (c.backend ?? "docker") === cfg.backend,
  );
  const ready = mine.filter((c) => c.state === "ready");
  const pausedList = mine.filter((c) => c.state === "paused");

  // Keep `running` ready + `paused` frozen. Excess ready -> freeze; shortfall
  // paused -> unfreeze (docker: ~ms unpause; daytona: sandbox restart, treated
  // as starting until the probe greens); then spawn the WHOLE remaining
  // deficit at once (bounded) — one-per-tick refills left the pool empty for
  // 10+ min after a golden rotation, so every click fell back to host boots.
  if (ready.length > cfg.running) {
    for (const c of ready.slice(cfg.running)) {
      if (await poolFreeze(c))
        patchContainer(repo.id, c.name, { state: "paused" });
    }
  }
  // Drain paused members beyond target — with microvm's restore-on-demand
  // (running/paused 0) idle VMs must actually go away, not linger frozen.
  const pausedNow = Object.values(readState(repo.id).containers).filter(
    (c) => (c.backend ?? "docker") === cfg.backend && c.state === "paused",
  );
  for (const c of pausedNow.slice(cfg.paused)) {
    await destroyContainer(repo.id, c.name);
  }
  if (ready.length < cfg.running && pausedList.length > 0) {
    const c = pausedList[0];
    if (await poolUnfreeze(c))
      patchContainer(repo.id, c.name, { state: "ready" });
  }

  const after = Object.values(readState(repo.id).containers).filter(
    (c) => (c.backend ?? "docker") === cfg.backend,
  );
  const live = after.filter((c) => c.state !== "claimed").length;
  const deficit = Math.min(cfg.running + cfg.paused - live, 2); // bound load
  if (deficit > 0) {
    const spawn =
      cfg.backend === "daytona"
        ? spawnDaytonaWarm
        : cfg.backend === "microvm"
          ? async (r: Repo) => void (await spawnMicrovmClone(r))
          : spawnWarmContainer;
    await Promise.all(Array.from({ length: deficit }, () => spawn(repo)));
  }
  // Freshly-booted extras get frozen by the next tick's excess-ready branch.
}

// ── Claim / release (the preview integration surface) ───────────────────────

export interface PoolClaim {
  containerName: string;
  hostPort: number;
  repoId: string;
  /** Remote backends' public preview origin (no host port / Caddy route). */
  previewUrl?: string;
}

/** The active pool claim backing a worktree's preview, if any. */
export function poolClaimFor(worktreeDir: string): PoolClaim | null {
  for (const repoId of Object.keys(configuredRepos())) {
    for (const c of Object.values(readState(repoId).containers)) {
      if (c.state === "claimed" && c.sessionWorktree === worktreeDir) {
        return {
          containerName: c.name,
          hostPort: c.hostPort,
          repoId,
          previewUrl: c.previewUrl,
        };
      }
    }
  }
  return null;
}

export function previewPoolEnabled(repoId: string): boolean {
  return previewPoolConfig(repoId).enabled;
}

/**
 * Is the claimed container's dev server actually answering? docker-proxy
 * listens on the host port for the container's whole lifetime, so ss-level
 * checks always look "up" — pool-backed preview status must probe the app.
 * null = worktree has no pool claim (caller uses its normal detection).
 */
export async function poolPreviewLive(
  worktreeDir: string,
): Promise<boolean | null> {
  const claim = poolClaimFor(worktreeDir);
  if (!claim) return null;
  // Status polls double as the claim's liveness signal (throttled writes).
  const c = readState(claim.repoId).containers[claim.containerName];
  if (
    c &&
    Date.now() - Date.parse(c.lastSeenAt || c.claimedAt || c.createdAt) > 60_000
  ) {
    patchContainer(claim.repoId, claim.containerName, {
      lastSeenAt: new Date().toISOString(),
    });
  }
  if (!c) return false;
  return poolCodeLive(c, await poolHttpCode(c, "/", isDaytona(c) ? 5 : 2));
}

/**
 * Claim a warm container for a session worktree. Returns the claim (the
 * caller writes WEBAPP_PORT=<hostPort> into the worktree's .ports.conf and
 * lets the normal status path take over) or null when the pool has nothing
 * ready — the caller falls back to the host boot path.
 */
export async function claimPoolPreview(
  repoId: string,
  worktreeDir: string,
): Promise<PoolClaim | null> {
  // Concurrent claims for one worktree must coalesce: a microvm spawn can take
  // minutes when golden.mem has to be re-read from EBS, and a second claim
  // arriving mid-spawn sees no ready container and spawns (then claims) a
  // SECOND clone for the same worktree (2026-07-27: mvm1+mvm2 both ended up
  // claimed by one session, the duplicate prefault halving EBS throughput).
  const key = `claim:${worktreeDir}`;
  const inFlight = busy.get(key);
  if (inFlight) return inFlight as Promise<PoolClaim | null>;
  const run = claimPoolPreviewInner(repoId, worktreeDir).finally(() =>
    busy.delete(key),
  );
  busy.set(key, run);
  return run;
}

async function claimPoolPreviewInner(
  repoId: string,
  worktreeDir: string,
): Promise<PoolClaim | null> {
  const repo = configuredRepos()[repoId];
  if (
    !repo ||
    !previewPoolEnabled(repoId) ||
    busy.has(`default-branch-${repoId}`)
  )
    return null;
  const already = poolClaimFor(worktreeDir);
  if (already) return already;

  const backend = previewPoolConfig(repoId).backend;
  const state = readState(repoId);
  if (backend !== "daytona" && state.branchRebuildPending) return null;
  const eligible = Object.values(state.containers).filter(
    (c) => (c.backend ?? "docker") === backend,
  );
  let pick = eligible.find((c) => c.state === "ready");
  if (!pick) {
    pick = eligible.find((c) => c.state === "paused");
    if (pick && !(await poolUnfreeze(pick))) pick = undefined;
  }
  if (!pick && backend === "microvm") {
    // Restores are ~2s — create on demand instead of falling back.
    pick = (await spawnMicrovmClone(configuredRepos()[repoId])) ?? undefined;
  }
  if (!pick) {
    // Nothing warm: kick a replenish and let the caller fall back.
    void sweepPool().catch(() => {});
    return null;
  }
  patchContainer(repoId, pick.name, {
    state: "claimed",
    sessionWorktree: worktreeDir,
    claimedAt: new Date().toISOString(),
  });
  await refreshContainerCreds(pick);
  // The container may have fetched a newer origin/<default> than the host
  // repo has — make sure bootSha resolves locally before diffing against it.
  if (pick.bootSha) {
    const have = await $`git -C ${worktreeDir} cat-file -e ${pick.bootSha}`
      .quiet()
      .nothrow();
    if (have.exitCode !== 0) {
      await $`git -C ${repo.repo} fetch origin ${repo.defaultBranch} --quiet`
        .quiet()
        .nothrow();
    }
  }
  try {
    const preBase = pick.syncBase || pick.bootSha;
    await convergeContainerToWorktree(repo, worktreeDir, pick);
    // Keep the converged branch across container restarts (see advance guard).
    await poolExec(pick, `touch ${WORKSPACE}/${CLAIMED_MARKER}`);
    // A big flip live under the dev server's watchers causes a module-graph
    // error storm (flapping 500s while ReScript resettles) — reboot the dev
    // tree instead: clean graph on warm caches, ~20-40s, no error overlay.
    const delta =
      pick.syncBase && pick.syncBase !== preBase
        ? (
            await $`git -C ${worktreeDir} diff --name-only ${preBase} HEAD`
              .quiet()
              .nothrow()
              .text()
          )
            .split("\n")
            .filter(Boolean).length
        : 0;
    // Microvm claims NEVER reboot: the snapshot's live watchers are the
    // asset — a reboot discards the warm process state and grinds page-cold
    // under memory pressure (measured: worse than a docker cold boot).
    // ReScript/Turbopack handle the checkout incrementally instead.
    if (delta > LIVE_FLIP_MAX_FILES && !isMicrovm(pick)) {
      console.log(
        `[preview-pool] ${pick.name}: ${delta} files changed — rebooting dev server for a clean graph`,
      );
      await poolRestartDev(pick);
    }
    await syncWorktreeIntoContainer(repo, worktreeDir, pick);
  } catch (e) {
    console.warn(
      `[preview-pool] initial sync into ${pick.name} failed — destroying the claim and falling back to a host preview:`,
      e,
    );
    stopSyncLoop(worktreeDir);
    try {
      await destroyContainer(repoId, pick.name);
    } catch (destroyError) {
      // Do not leave a failed claim discoverable. The orphan sweep cleans any
      // microvm resources the failed destroy could not remove.
      patchContainer(repoId, pick.name, null);
      console.warn(
        `[preview-pool] cleanup of failed claim ${pick.name} failed:`,
        destroyError,
      );
    }
    void sweepPool().catch(() => {});
    return null;
  }
  startSyncLoop(repo, worktreeDir, pick);
  void sweepPool().catch(() => {}); // replenish the pool in the background
  console.log(
    `[preview-pool] ${repoId}: ${worktreeDir} claimed ${pick.name} (${
      pick.previewUrl || `:${pick.hostPort}`
    })`,
  );
  return {
    containerName: pick.name,
    hostPort: pick.hostPort,
    repoId,
    previewUrl: pick.previewUrl,
  };
}

/** Release a worktree's pool preview: stop syncing, destroy the container. */
export async function releasePoolPreview(
  worktreeDir: string,
): Promise<boolean> {
  const claim = poolClaimFor(worktreeDir);
  if (!claim) return false;
  console.log(
    `[preview-pool] release: claim=${claim.containerName}, stopping sync`,
  );
  stopSyncLoop(worktreeDir);
  console.log(`[preview-pool] release: destroying ${claim.containerName}`);
  await destroyContainer(claim.repoId, claim.containerName);
  console.log(`[preview-pool] release: destroyed ${claim.containerName}`);
  void sweepPool().catch(() => {});
  console.log(
    `[preview-pool] released ${claim.containerName} for ${worktreeDir}`,
  );
  return true;
}

// ── Worktree -> container file sync ──────────────────────────────────────────

/**
 * Converge the container workspace's TRACKED tree to the worktree's HEAD via
 * `git checkout -f` — atomic adds/removes, so ReScript/Turbopack never see an
 * incoherent module graph. (File-level copying of a big reverse delta broke
 * exactly that way on an old branch: main-only modules got deleted while
 * files importing them stayed — a live Module-not-found.)
 *
 * Object transfer, in order:
 *  1. shallow fetch of the exact sha from the remote (works whenever the
 *     commit is pushed — the overwhelmingly common case here);
 *  2. streamed `git bundle` from the host worktree (covers un-pushed local
 *     commits, which are by construction ahead of a pushed/known base).
 * Returns the sha the workspace now sits at (the sync base for uncommitted
 * file diffs).
 */
async function convergeContainerToWorktree(
  repo: Repo,
  worktreeDir: string,
  c: PoolContainer,
): Promise<string> {
  // One converge per container at a time: the claim's converge and a status-
  // poll-resumed sync loop's re-converge raced into the same workspace and
  // the loser died on git's index.lock (live 21:34, killed a fresh claim).
  const key = `converge-${c.name}`;
  const inflight = busy.get(key) as Promise<string> | undefined;
  if (inflight) return inflight;
  const run = doConverge(repo, worktreeDir, c).finally(() => busy.delete(key));
  busy.set(key, run);
  return run;
}

async function doConverge(
  repo: Repo,
  worktreeDir: string,
  c: PoolContainer,
): Promise<string> {
  const base = c.syncBase || c.bootSha;
  const head = (
    await $`git -C ${worktreeDir} rev-parse HEAD`.quiet().nothrow().text()
  ).trim();
  if (!head || head === base) return base;

  const inContainer = async (sha: string) =>
    (await poolExec(c, `git -C ${WORKSPACE} cat-file -e ${sha}`)).ok;

  if (!(await inContainer(head))) {
    const cloneUrl = await cloneUrlFor(repo);
    let fetched = false;
    if (cloneUrl) {
      const r = await poolExec(
        c,
        `cd ${WORKSPACE} && git fetch -q --depth 1 ${JSON.stringify(cloneUrl)} ${head}`,
        3 * 60_000,
      );
      fetched = r.ok;
    }
    if (!fetched && isDaytona(c)) {
      // No stdin streaming to remote sandboxes — un-pushed commits can't be
      // bundled over. Push the branch and re-claim.
      throw new Error(
        `sha ${head.slice(0, 10)} not fetchable from the remote — push the branch for daytona previews`,
      );
    }
    if (!fetched && isMicrovm(c)) {
      // Ship the bundle through the agent's /files endpoint (base64).
      const tmp = `/tmp/claim-${Date.now().toString(36)}.bundle`;
      const b =
        await $`git -C ${worktreeDir} bundle create ${tmp} HEAD ^${base}`
          .quiet()
          .nothrow();
      if (b.exitCode !== 0) throw new Error("bundle create failed");
      const bytes = readFileSync(tmp);
      const { unlinkSync } = await import("node:fs");
      unlinkSync(tmp);
      if (bytes.length > 30 * 1024 * 1024)
        throw new Error(
          "bundle too large for the agent channel — push the branch",
        );
      const up = await fetch(`http://${mvmIp(c)}:8080/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/tmp/claim.bundle",
          content: bytes.toString("base64"),
        }),
        signal: AbortSignal.timeout(60_000),
      }).catch(() => null);
      if (!up?.ok) throw new Error("bundle upload to microvm agent failed");
      const f = await poolExec(
        c,
        `cd ${WORKSPACE} && git fetch -q /tmp/claim.bundle HEAD && rm -f /tmp/claim.bundle`,
        2 * 60_000,
      );
      if (!f.ok) throw new Error(`bundle fetch failed: ${f.out.slice(-300)}`);
      fetched = true;
    }
    if (!fetched) {
      // Un-pushed HEAD: stream a bundle of HEAD ^base from the host.
      const bundle = Bun.spawn(
        ["git", "-C", worktreeDir, "bundle", "create", "-", "HEAD", `^${base}`],
        { stdout: "pipe", stderr: "pipe" },
      );
      const recv = Bun.spawn(
        [
          "docker",
          "exec",
          "-i",
          c.name,
          "bash",
          "-c",
          "cat > /tmp/claim.bundle",
        ],
        { stdin: bundle.stdout, stdout: "ignore", stderr: "pipe" },
      );
      const [bcode, rcode] = await Promise.all([bundle.exited, recv.exited]);
      if (bcode !== 0 || rcode !== 0) {
        throw new Error(
          `bundle transfer failed (git=${bcode} docker=${rcode})`,
        );
      }
      const f = await dockerExec(
        c.name,
        `cd ${WORKSPACE} && git fetch -q /tmp/claim.bundle HEAD && rm -f /tmp/claim.bundle`,
        2 * 60_000,
      );
      if (!f.ok) throw new Error(`bundle fetch failed: ${f.out.slice(-300)}`);
    }
  }

  const co = await poolExec(
    c,
    `cd ${WORKSPACE} && git checkout -q -f ${head} && git rev-parse HEAD`,
    2 * 60_000,
  );
  if (!co.ok || !co.out.includes(head)) {
    throw new Error(
      `in-container checkout of ${head.slice(0, 10)} failed: ${co.out.slice(-300)}`,
    );
  }
  patchContainer(repo.id, c.name, { syncBase: head });
  c.syncBase = head;
  console.log(
    `[preview-pool] ${c.name}: workspace converged ${base.slice(0, 10)} -> ${head.slice(0, 10)}`,
  );
  return head;
}

/**
 * Changed files between the container's bootSha and the worktree's current
 * content (tracked diffs + untracked non-ignored files). The container tree
 * converges to the worktree's exact content; its own gitignored build state
 * (lib/, .next) is never touched.
 */
async function changedFiles(
  worktreeDir: string,
  bootSha: string,
): Promise<{ copy: string[]; drop: string[] }> {
  const diff = await $`git -C ${worktreeDir} diff --name-status ${bootSha}`
    .quiet()
    .nothrow()
    .text();
  const untracked =
    await $`git -C ${worktreeDir} ls-files -o --exclude-standard`
      .quiet()
      .nothrow()
      .text();
  const copy: string[] = [];
  const drop: string[] = [];
  for (const line of diff.split("\n")) {
    const m = line.match(/^([A-Z])\S*\t(.+?)(\t(.+))?$/);
    if (!m) continue;
    if (m[1] === "D") drop.push(m[2]);
    else if (m[1] === "R") {
      drop.push(m[2]);
      if (m[4]) copy.push(m[4]);
    } else copy.push(m[2]);
  }
  for (const f of untracked.split("\n")) if (f.trim()) copy.push(f.trim());
  return { copy, drop };
}

async function syncWorktreeIntoContainer(
  repo: Repo,
  worktreeDir: string,
  c: PoolContainer,
  mtimes?: Map<string, number>,
): Promise<void> {
  const base = c.syncBase || c.bootSha;
  if (!base) return;
  const { copy, drop } = await changedFiles(worktreeDir, base);
  const toCopy: string[] = [];
  for (const rel of copy) {
    const abs = join(worktreeDir, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const stamp = st.mtimeMs + st.size;
    if (mtimes && mtimes.get(rel) === stamp) continue;
    mtimes?.set(rel, stamp);
    toCopy.push(rel);
  }
  if (drop.length) {
    const rmList = drop.map((p) => JSON.stringify(p)).join(" ");
    await poolExec(c, `cd ${WORKSPACE} && rm -f ${rmList} 2>/dev/null; true`);
    if (mtimes) for (const p of drop) mtimes.delete(p);
  }
  if (!toCopy.length) return;
  if (isDaytona(c)) {
    // No stdin streaming to remote sandboxes — upload per file (uncommitted
    // deltas are small; converge carries the tracked bulk). Cap pathological
    // files rather than stalling the loop.
    const sbx = await daytonaSbx(c.name);
    for (const rel of toCopy) {
      const abs = join(worktreeDir, rel);
      try {
        const st = statSync(abs);
        if (st.size > 8 * 1024 * 1024) {
          console.warn(
            `[preview-pool] sync skipping ${rel} (${Math.round(st.size / 1e6)}MB)`,
          );
          continue;
        }
        await sbx.fs.uploadFile(readFileSync(abs), `${WORKSPACE}/${rel}`);
      } catch (e) {
        console.warn(`[preview-pool] sync upload ${rel} failed:`, e);
        mtimes?.delete(rel);
      }
    }
    return;
  }
  // tar stream keeps modes and creates parent dirs in one round trip.
  const tar = Bun.spawn(["tar", "-C", worktreeDir, "-cf", "-", ...toCopy], {
    stdout: "pipe",
  });
  const untar = Bun.spawn(
    ["docker", "exec", "-i", c.name, "tar", "-C", WORKSPACE, "-xf", "-"],
    {
      stdin: tar.stdout,
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  await Promise.all([tar.exited, untar.exited]);
}

function startSyncLoop(
  repo: Repo,
  worktreeDir: string,
  c: PoolContainer,
): void {
  stopSyncLoop(worktreeDir);
  const mtimes = new Map<string, number>();
  let busyTick = false;
  const timer = setInterval(
    () => {
      if (busyTick) return; // a converge can outlast the interval
      busyTick = true;
      void (async () => {
        const claim = poolClaimFor(worktreeDir);
        if (!claim || claim.containerName !== c.name)
          return stopSyncLoop(worktreeDir);
        if ((await poolRuntimeStatus(c)) !== "running")
          return stopSyncLoop(worktreeDir);
        // The agent may commit mid-session — re-converge when HEAD moves so
        // tracked changes land atomically, then sync uncommitted files.
        const head = (
          await $`git -C ${worktreeDir} rev-parse HEAD`.quiet().nothrow().text()
        ).trim();
        if (head && head !== (c.syncBase || c.bootSha)) {
          await convergeContainerToWorktree(repo, worktreeDir, c).catch((e) =>
            console.warn(`[preview-pool] re-converge of ${c.name} failed:`, e),
          );
          mtimes.clear();
        }
        await syncWorktreeIntoContainer(repo, worktreeDir, c, mtimes).catch(
          () => {},
        );
      })().finally(() => {
        busyTick = false;
      });
      // Remote backends pay HTTPS round-trips per tick — poll gentler.
    },
    isDaytona(c) ? 5000 : 2000,
  );
  (timer as { unref?: () => void }).unref?.();
  syncs.set(worktreeDir, { timer, mtimes });
}

function stopSyncLoop(worktreeDir: string): void {
  const s = syncs.get(worktreeDir);
  if (s) clearInterval(s.timer);
  syncs.delete(worktreeDir);
}

/**
 * Re-attach the sync loop after a process restart (claims persist on disk,
 * timers don't). Called from the preview status path — cheap no-op when the
 * loop is already live.
 */
export function resumePoolSyncIfNeeded(worktreeDir: string): void {
  if (syncs.has(worktreeDir)) return;
  const claim = poolClaimFor(worktreeDir);
  if (!claim) return;
  const repo = configuredRepos()[claim.repoId];
  const c = readState(claim.repoId).containers[claim.containerName];
  if (repo && c) startSyncLoop(repo, worktreeDir, c);
}

// ── Scheduler + status ───────────────────────────────────────────────────────

/**
 * Reap microvm leftovers nothing tracks anymore: live os-fc-clone scopes,
 * netns, COW disks and Caddy routes whose index no repo's state knows.
 * Crash-safe cleanup — spawn/destroy failures at any step can strand these.
 */
async function gcMicrovmOrphans(): Promise<void> {
  const known = sandboxMicrovmIndexes();
  for (const rid of Object.keys(configuredRepos())) {
    for (const c of Object.values(readState(rid).containers)) {
      if (c.mvmIdx != null) known.add(c.mvmIdx);
    }
  }
  const units = await $`systemctl list-units --plain --no-legend 'os-fc-clone*'`
    .quiet()
    .nothrow()
    .text();
  for (const m of units.matchAll(/os-fc-clone(\d+)/g)) {
    const idx = parseInt(m[1], 10);
    if (!known.has(idx)) {
      console.log(`[preview-pool] gc: reaping orphaned clone ${idx}`);
      await sudoRun([
        "bash",
        `${MVM_SCRIPTS}/clone.sh`,
        "destroy",
        String(idx),
        MVM_STORE,
      ]).catch(() => {});
      await fetch(
        `http://localhost:2019/config/apps/http/servers/preview_${MVM_HTTPS_BASE + idx}`,
        { method: "DELETE" },
      ).catch(() => {});
    }
  }
  // Disks/netns without a live scope (partial destroys). clone.sh destroy is
  // idempotent and cleans all three.
  const disks = await $`ls /opt/firecracker/store 2>/dev/null`
    .quiet()
    .nothrow()
    .text();
  for (const m of disks.matchAll(/clone(\d+)\.ext4/g)) {
    const idx = parseInt(m[1], 10);
    if (known.has(idx)) continue;
    const live = await $`systemctl is-active --quiet os-fc-clone${idx}`
      .quiet()
      .nothrow();
    if (live.exitCode !== 0) {
      console.log(`[preview-pool] gc: sweeping dead clone ${idx} leftovers`);
      await sudoRun([
        "bash",
        `${MVM_SCRIPTS}/clone.sh`,
        "destroy",
        String(idx),
        MVM_STORE,
      ]).catch(() => {});
    }
  }
}

/** Run one reconcile pass now (golden freshness + container top-up). */
export function previewPoolSweepNow(): Promise<void> {
  return sweepPool();
}

async function sweepPool(): Promise<void> {
  const existing = busy.get("sweep");
  if (existing) return existing as Promise<void>;
  const run = (async () => {
    for (const repo of Object.values(configuredRepos())) {
      if (repo.sharedCheckout) continue;
      const cfg = previewPoolConfig(repo.id);
      if (!cfg.enabled) {
        // Still reconcile so disabling drains leftovers.
        if (Object.keys(readState(repo.id).containers).length)
          await ensurePool(repo).catch(() => {});
        continue;
      }
      // Golden images are docker-only; daytona sandboxes provision directly.
      if (cfg.backend === "docker") {
        const refreshed = await refreshGoldenImage(repo.id).catch((e) => {
          console.warn(`[preview-pool] golden refresh ${repo.id} failed:`, e);
          return false;
        });
        // A normal age-based refresh may keep serving the last good image on
        // failure. A branch-change rebuild may not, and ensurePool would only
        // repeat the same expensive failed build during this sweep.
        if (!refreshed && readState(repo.id).branchRebuildPending) continue;
      }
      await ensurePool(repo).catch((e) =>
        console.warn(`[preview-pool] ensure ${repo.id} failed:`, e),
      );
      if (cfg.backend === "microvm") {
        await gcMicrovmOrphans().catch((e) =>
          console.warn("[preview-pool] microvm gc failed:", e),
        );
        touchGoldenMem();
      }
      // Keep live warm containers' short-lived creds fresh.
      for (const c of Object.values(readState(repo.id).containers)) {
        if (c.state === "ready") await refreshContainerCreds(c).catch(() => {});
      }
    }
    await reapOrphanGoldenbuilds().catch((e) =>
      console.warn("[preview-pool] goldenbuild reap failed:", e),
    );
  })().finally(() => busy.delete("sweep"));
  busy.set("sweep", run);
  return run;
}

/**
 * Reap orphaned golden-build containers. The build flow removes its container
 * on success AND failure, but a process death mid-build (restart, crash)
 * leaves it running `sleep infinity` — often with the warmed dev stack (next
 * dev/turbopack, rescript watch, esbuild) still alive inside, burning CPU and
 * RAM indefinitely (2026-07-27: one ran for 3 days). Anything with the
 * goldenbuild label older than 2h that no in-flight build owns is an orphan;
 * real builds finish well inside that (setup 15m + boot 5m + commit 15m caps).
 */
async function reapOrphanGoldenbuilds(): Promise<void> {
  const ls = await docker([
    "ps",
    "--filter",
    `label=${POOL_LABEL}=goldenbuild`,
    "--format",
    "{{.Names}}\t{{.CreatedAt}}",
  ]);
  if (!ls.ok) return;
  for (const line of ls.out.split("\n")) {
    const [name, createdAt] = line.split("\t");
    if (!name?.startsWith("os-preview-goldenbuild-")) continue;
    const repoId = name.slice("os-preview-goldenbuild-".length);
    if (busy.has(`golden-${repoId}`)) continue;
    // docker CreatedAt: "2026-07-24 13:20:01 +0000 UTC"
    const created = Date.parse((createdAt ?? "").replace(" UTC", "").trim());
    if (!Number.isFinite(created) || Date.now() - created < 2 * 60 * 60_000)
      continue;
    console.warn(
      `[preview-pool] reaping orphaned golden-build container ${name} (created ${createdAt})`,
    );
    await docker(["rm", "-f", name]);
  }
}

/** Arm the pool sweep. Called once from opensession.ts's boot block — never at
 *  module scope: the sweep docker-rm's containers, and this module is reachable
 *  from the routes graph, so arming it at import let any script or test reap
 *  the live pool 20s later. */
export function ensurePreviewPoolScheduler(): void {
  // Dev instances: the sweep docker-rm's os-preview-*/golden containers on
  // the shared docker daemon — it would reap production's warm pool.
  if (isDevInstance()) return;
  if (g.__previewPoolTimer) return;
  const t = setInterval(() => {
    sweepPool().catch((e) => console.warn("[preview-pool] sweep failed:", e));
  }, 5 * 60_000);
  (t as { unref?: () => void }).unref?.();
  g.__previewPoolTimer = t;
  // First sweep shortly after boot (not immediately — let the server settle).
  setTimeout(() => void sweepPool().catch(() => {}), 20_000);
}

export interface PreviewPoolStatusEntry {
  repoId: string;
  config: PreviewPoolRepoConfig;
  golden: PoolState["golden"] | null;
  goldenBuilding: boolean;
  containers: PoolContainer[];
}

export function previewPoolStatus(): PreviewPoolStatusEntry[] {
  return Object.values(configuredRepos())
    .filter((r) => !r.sharedCheckout)
    .map((r) => {
      const state = readState(r.id);
      return {
        repoId: r.id,
        config: previewPoolConfig(r.id),
        golden: state.golden ?? null,
        goldenBuilding: busy.has(`golden-${r.id}`),
        containers: Object.values(state.containers),
      };
    });
}
