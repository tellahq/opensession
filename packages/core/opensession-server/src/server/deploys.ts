/**
 * Deploys — durable, agent-published internal web apps, modelled on qm's
 * `publish` tool (MIT).
 *
 * A session's preview (src/server/preview.ts) is a dev server tied to a
 * worktree: it dies with the session and points at a checkout that will be
 * deleted. That makes "the agent built us a small internal tool" a demo rather
 * than something the team uses on Monday. A deploy is the durable half:
 *
 *   - the published directory is COPIED into an immutable version snapshot
 *     (~/.opensession-deploys/<id>/versions/<n>/), so it survives the worktree
 *   - it gets a stable link at /d/<name>/ on the main server, behind the same
 *     tailnet + sign-in gate as everything else
 *   - it is supervised: relaunched on crash (with backoff) and on boot
 *   - $DATA_DIR (~/.opensession-deploys/<id>/data) is the ONE durable path;
 *     everything else is reset from the snapshot on every relaunch, so state
 *     that isn't in $DATA_DIR is state you will lose
 *   - rollbackTo flips the live version back to an earlier snapshot
 *
 * Deliberately NOT ported from qm: per-scope share grants. Reaching a deploy
 * requires reaching Open Session, which is already tailnet- and team-gated —
 * an ACL lattice on top would be the scope machinery the qm analysis
 * explicitly recommended against at our size. Deploys are visible to the team;
 * that is stated in the tool description so nobody publishes secrets expecting
 * per-person privacy.
 *
 * Security posture, stated plainly: a deploy is arbitrary agent-authored code
 * running unsandboxed and persistently as the Open Session user. Sessions
 * already run arbitrary code — what is new is that it outlives the session. So
 * publishing is interactive-only (never automations, whose input is untrusted
 * text), every publish/relaunch/stop is audited, and the Deploys UI lists what
 * is running so nothing accumulates unseen.
 */

import { homeDir } from "./paths";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  cpSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { writeJsonAtomic } from "./shared/atomic-write";
import { audit } from "./audit";
import { stateDir } from "./paths";

const DEPLOYS_DIR = stateDir("deploys");
const REGISTRY = join(DEPLOYS_DIR, "registry.json");

/** Host ports for deploys. Kept clear of the webapp dev range (3100-3999) and
 *  its +6000 preview mirror (9100-9999). */
const PORT_MIN = 7100;
const PORT_MAX = 7899;

const MAX_VERSIONS = 10;
/** A deploy that dies this fast, this often, is broken — stop restarting it. */
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES_IN_WINDOW = 5;
const RESTART_DELAY_MS = 1_000;

export interface DeployVersion {
  version: number;
  createdAt: string;
  createdBy: string;
  sessionId?: string;
  entrypoint: string;
  env?: Record<string, string>;
}

export interface Deploy {
  id: string;
  /** URL handle: /d/<name>/. Globally unique, lowercase. */
  name: string;
  owner: string;
  /** The session that last published it — the UI links back to its history. */
  sessionId?: string;
  description?: string;
  port: number;
  currentVersion: number;
  versions: DeployVersion[];
  state: "running" | "stopped" | "crashed";
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

interface Stored {
  deploys: Deploy[];
}

const g = globalThis as any;
const deploys: Map<string, Deploy> = (g.__deploys ??= new Map());
/** Live child processes, by deploy id. Never persisted. */
const procs: Map<string, Subprocess> = (g.__deployProcs ??= new Map());
/** Crash timestamps per deploy, for the restart circuit-breaker. */
const crashes: Map<string, number[]> = (g.__deployCrashes ??= new Map());
/**
 * Processes we are killing on purpose. Without this, a redeploy's own teardown
 * looks like a crash to onExit, which schedules a restart of the OLD version a
 * second later; that restart races the new version for the port, kills it,
 * which looks like another crash… a cascade that trips the breaker while the
 * original process is somehow still serving.
 *
 * Keyed on the PROCESS, not the deploy id, and deliberately so: onExit fires
 * independently of the `exited` promise, so a deploy-id flag cleared when
 * `exited` resolves can still be gone by the time onExit runs. The process
 * object is the one thing both closures agree on.
 */
const intentionalKills = new WeakSet<Subprocess>();
let loaded = false;

function registryPath(): string {
  return process.env.OPENSESSION_DEPLOYS_REGISTRY || REGISTRY;
}

function rootDir(): string {
  return process.env.OPENSESSION_DEPLOYS_DIR || DEPLOYS_DIR;
}

function deployDir(id: string): string {
  return join(rootDir(), id);
}
export function versionDir(id: string, version: number): string {
  return join(deployDir(id), "versions", String(version));
}
export function dataDir(id: string): string {
  return join(deployDir(id), "data");
}

function persist(): void {
  mkdirSync(rootDir(), { recursive: true });
  writeJsonAtomic(registryPath(), {
    deploys: [...deploys.values()],
  } satisfies Stored);
}

function load(): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(registryPath())) return;
  try {
    const data: Stored = JSON.parse(readFileSync(registryPath(), "utf-8"));
    for (const d of data.deploys || []) deploys.set(d.id, d);
  } catch (e) {
    console.error("[deploys] failed to read registry:", e);
  }
}

export function listDeploys(): Deploy[] {
  load();
  return [...deploys.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getDeploy(ref: string): Deploy | undefined {
  load();
  return (
    deploys.get(ref) ||
    [...deploys.values()].find((d) => d.name === ref.toLowerCase())
  );
}

export function isValidDeployName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(name);
}

function allocatePort(): number {
  load();
  const taken = new Set([...deploys.values()].map((d) => d.port));
  for (let p = PORT_MIN; p <= PORT_MAX; p++) if (!taken.has(p)) return p;
  throw new Error("no free deploy port — stop an unused deploy first");
}

// ── Supervision ─────────────────────────────────────────────────────────────

function crashLooping(id: string): boolean {
  const now = Date.now();
  const recent = (crashes.get(id) || []).filter(
    (t) => now - t < CRASH_WINDOW_MS,
  );
  crashes.set(id, recent);
  return recent.length >= MAX_CRASHES_IN_WINDOW;
}

function noteCrash(id: string): void {
  const recent = crashes.get(id) || [];
  recent.push(Date.now());
  crashes.set(id, recent);
}

/**
 * Stop a deploy's process and WAIT for the port to actually be released.
 *
 * Both halves matter. The wait is why a redeploy works at all: spawning the
 * new version while the old one still holds the port makes the new process die
 * on EADDRINUSE, five times in a row, into the crash-loop breaker — leaving
 * the OLD version serving while the registry claims the new one is live. And
 * SIGKILL after a grace period is what makes "stopped" mean stopped for an app
 * that ignores SIGTERM.
 */
async function killProcess(id: string, graceMs = 3_000): Promise<void> {
  const proc = procs.get(id);
  if (!proc) return;
  procs.delete(id);
  intentionalKills.add(proc);
  try {
    proc.kill();
  } catch {
    return; // already gone
  }
  const exited = await Promise.race([
    proc.exited.then(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), graceMs).unref?.()),
  ]);
  if (exited) return;
  try {
    proc.kill("SIGKILL");
    await proc.exited;
  } catch {
    // nothing left to signal
  }
}

/**
 * Launch (or relaunch) a deploy's current version. Idempotent: a live process
 * is left alone unless `force` is set, which is what a publish/rollback wants.
 */
export async function launchDeploy(
  id: string,
  opts?: { force?: boolean },
): Promise<Deploy | undefined> {
  load();
  const d = deploys.get(id);
  if (!d) return undefined;
  const existing = procs.get(id);
  if (existing && !existing.killed && !opts?.force) return d;
  await killProcess(id);

  const version = d.versions.find((v) => v.version === d.currentVersion);
  if (!version) {
    d.state = "crashed";
    d.lastError = `version ${d.currentVersion} is missing from disk`;
    persist();
    return d;
  }
  const cwd = versionDir(id, d.currentVersion);
  if (!existsSync(cwd)) {
    d.state = "crashed";
    d.lastError = `snapshot for version ${d.currentVersion} is missing`;
    persist();
    return d;
  }
  mkdirSync(dataDir(id), { recursive: true });

  let proc: Subprocess;
  try {
    // `exec` so the pid we hold IS the app, not a shell wrapping it — killing
    // the wrapper leaves the real server running and holding the port, which
    // is exactly how "stopped" apps stayed up. publishDeploy rejects compound
    // entrypoints so exec always applies.
    proc = Bun.spawn(["/bin/sh", "-c", `exec ${version.entrypoint}`], {
      cwd,
      env: {
        // A deliberately minimal environment, like agent subprocesses get:
        // a published app must never inherit the server's tokens.
        PATH: process.env.PATH || "/usr/bin:/bin",
        HOME: homeDir(),
        LANG: process.env.LANG || "C.UTF-8",
        PORT: String(d.port),
        DATA_DIR: dataDir(id),
        NODE_ENV: "production",
        ...(version.env || {}),
      },
      stdout: "pipe",
      stderr: "pipe",
      onExit(_proc, exitCode, signalCode) {
        if (procs.get(id) === proc) procs.delete(id);
        const current = deploys.get(id);
        // A deliberate teardown (redeploy, rollback, stop) is not a crash and
        // must not schedule a restart — the caller is already launching the
        // replacement, and a second launcher would fight it for the port.
        if (
          !current ||
          current.state === "stopped" ||
          intentionalKills.has(proc)
        )
          return;
        noteCrash(id);
        current.lastError = `exited (code ${exitCode ?? "null"}${signalCode ? `, signal ${signalCode}` : ""})`;
        if (crashLooping(id)) {
          current.state = "crashed";
          persist();
          audit({
            kind: "deploy_crash_looping",
            deploy: current.name,
            error: current.lastError,
          });
          console.error(
            `[deploys] ${current.name} is crash-looping — not restarting`,
          );
          return;
        }
        persist();
        setTimeout(() => {
          if (deploys.get(id)?.state !== "stopped")
            void launchDeploy(id, { force: true });
        }, RESTART_DELAY_MS).unref?.();
      },
    });
  } catch (e: any) {
    d.state = "crashed";
    d.lastError = `spawn failed: ${e?.message || String(e)}`;
    persist();
    return d;
  }

  procs.set(id, proc);
  d.state = "running";
  delete d.lastError;
  d.updatedAt = new Date().toISOString();
  persist();
  audit({
    kind: "deploy_launched",
    deploy: d.name,
    version: d.currentVersion,
    port: d.port,
  });
  return d;
}

export async function stopDeploy(id: string): Promise<Deploy | undefined> {
  load();
  const d = deploys.get(id);
  if (!d) return undefined;
  // Set the state BEFORE killing: the onExit handler reads it to decide
  // whether an exit is a crash worth restarting or a deliberate stop.
  d.state = "stopped";
  d.updatedAt = new Date().toISOString();
  await killProcess(id);
  crashes.delete(id);
  persist();
  audit({ kind: "deploy_stopped", deploy: d.name });
  return d;
}

export async function deleteDeploy(id: string): Promise<boolean> {
  load();
  const d = deploys.get(id);
  if (!d) return false;
  await stopDeploy(id);
  deploys.delete(id);
  persist();
  try {
    rmSync(deployDir(id), { recursive: true, force: true });
  } catch (e) {
    console.error(`[deploys] failed to remove ${d.name}'s files:`, e);
  }
  audit({ kind: "deploy_deleted", deploy: d.name });
  return true;
}

/** Relaunch everything that should be running. Called once at boot. */
export async function relaunchDeploys(): Promise<void> {
  load();
  for (const d of deploys.values()) {
    if (d.state === "stopped") continue;
    await launchDeploy(d.id, { force: true });
  }
}

// ── Publishing ──────────────────────────────────────────────────────────────

export interface PublishInput {
  /** Absolute directory to snapshot. */
  dir: string;
  entrypoint: string;
  name: string;
  owner: string;
  sessionId?: string;
  description?: string;
  env?: Record<string, string>;
  /** Rename the deploy currently called this to `name`. */
  renameFrom?: string;
}

export interface PublishResult {
  deploy: Deploy;
  version: number;
  url: string;
}

/** Files a snapshot never carries: build detritus and anything git. */
const SNAPSHOT_SKIP = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  ".turbo",
  ".cache",
]);

export function snapshotFilter(src: string): boolean {
  const base = src.split("/").pop() || "";
  return !SNAPSHOT_SKIP.has(base);
}

/**
 * The entrypoint is run as `sh -c "exec <entrypoint>"` so the supervised pid
 * is the app itself (see launchDeploy). `exec` only takes effect on a single
 * command, so a compound one would silently reintroduce the shell wrapper that
 * made "stop" fail to stop anything. Reject it with a fix rather than accept a
 * deploy we cannot reliably kill.
 */
export function compoundEntrypointError(entrypoint: string): string | null {
  if (!/(^|[^&|>])(&&|\|\||[;|])/.test(entrypoint)) return null;
  return (
    "entrypoint must be a single command so it can be supervised directly " +
    `(got "${entrypoint}"). Put the sequence in a start script in the published ` +
    'directory and use that, e.g. entrypoint "sh start.sh".'
  );
}

export function publishDeploy(input: PublishInput): PublishResult {
  load();
  const name = input.name.trim().toLowerCase();
  if (!isValidDeployName(name)) {
    throw new Error(
      "name must be 1-40 lowercase letters, digits or hyphens, starting and ending alphanumeric",
    );
  }
  if (!input.entrypoint.trim()) throw new Error("entrypoint is required");
  const compound = compoundEntrypointError(input.entrypoint.trim());
  if (compound) throw new Error(compound);
  if (!existsSync(input.dir))
    throw new Error(`directory does not exist: ${input.dir}`);

  let d = input.renameFrom ? getDeploy(input.renameFrom) : getDeploy(name);
  if (input.renameFrom && !d)
    throw new Error(`no deploy named "${input.renameFrom}" to rename`);
  const clash = getDeploy(name);
  if (clash && d && clash.id !== d.id)
    throw new Error(`the name "${name}" is already taken`);

  const now = new Date().toISOString();
  if (!d) {
    d = {
      id: `dep-${crypto.randomUUID()}`,
      name,
      owner: input.owner,
      port: allocatePort(),
      currentVersion: 0,
      versions: [],
      state: "stopped",
      createdAt: now,
      updatedAt: now,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.description ? { description: input.description } : {}),
    };
    deploys.set(d.id, d);
  } else {
    d.name = name;
    if (input.sessionId) d.sessionId = input.sessionId;
    if (input.description) d.description = input.description;
  }

  const version = d.currentVersion + 1;
  const dest = versionDir(d.id, version);
  mkdirSync(dest, { recursive: true });
  cpSync(input.dir, dest, {
    recursive: true,
    dereference: true,
    filter: snapshotFilter,
  });

  d.versions.push({
    version,
    createdAt: now,
    createdBy: input.owner,
    entrypoint: input.entrypoint.trim(),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.env ? { env: input.env } : {}),
  });
  d.currentVersion = version;
  d.updatedAt = now;

  // Prune old snapshots, keeping the tail rollbackTo can reach.
  const prunable = d.versions.slice(
    0,
    Math.max(0, d.versions.length - MAX_VERSIONS),
  );
  for (const v of prunable) {
    try {
      rmSync(versionDir(d.id, v.version), { recursive: true, force: true });
    } catch {
      // a snapshot we can't remove is disk we leak, not a failed publish
    }
  }
  d.versions = d.versions.slice(-MAX_VERSIONS);

  persist();
  audit({
    kind: "deploy_published",
    deploy: d.name,
    version,
    by: input.owner,
    session_id: input.sessionId,
  });
  crashes.delete(d.id);
  void launchDeploy(d.id, { force: true });
  return { deploy: deploys.get(d.id)!, version, url: deployUrl(d.name) };
}

export function rollbackDeploy(ref: string, toVersion: number): Deploy {
  load();
  const d = getDeploy(ref);
  if (!d) throw new Error(`no deploy named "${ref}"`);
  if (!d.versions.some((v) => v.version === toVersion)) {
    throw new Error(
      `version ${toVersion} isn't retained — available: ${d.versions.map((v) => v.version).join(", ")}`,
    );
  }
  d.currentVersion = toVersion;
  d.updatedAt = new Date().toISOString();
  persist();
  audit({ kind: "deploy_rolled_back", deploy: d.name, version: toVersion });
  crashes.delete(d.id);
  void launchDeploy(d.id, { force: true });
  return deploys.get(d.id)!;
}

export function deployUrl(name: string): string {
  const base = (process.env.OPENSESSION_PUBLIC_BASE_URL || "").replace(
    /\/+$/,
    "",
  );
  return `${base}/d/${name}/`;
}

/** Recent stdout/stderr for the UI — a crashed app's reason to live. */
export async function deployLogs(id: string, limit = 4000): Promise<string> {
  const proc = procs.get(id);
  if (!proc) return "";
  const chunks: string[] = [];
  for (const stream of [proc.stdout, proc.stderr]) {
    if (!stream || typeof stream === "number") continue;
    try {
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      if (value) chunks.push(new TextDecoder().decode(value));
    } catch {
      // a stream we can't drain just contributes nothing
    }
  }
  return chunks.join("\n").slice(-limit);
}

/** Test seam — drops in-memory state so a suite starts clean. */
export function __resetDeploysForTest(): void {
  deploys.clear();
  procs.clear();
  crashes.clear();
  loaded = false;
}
