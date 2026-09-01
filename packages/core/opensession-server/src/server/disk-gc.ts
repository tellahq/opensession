/**
 * Disk GC — reclaims Rust `target/` build caches from worktrees we KEEP.
 *
 * The hourly `cleanup-closed-worktrees` cron only removes worktrees whose work
 * is already merged into the default branch. A long-lived worktree with an
 * open PR is kept indefinitely and its `target/` grows without bound — that
 * was the actual gap behind the 2026-07-29 disk incident: the root disk hit
 * 96%, `~/worktrees` was 1.18T deduplicated, and `target/debug` was nearly all
 * of it (deps ~58%, incremental ~29%, build ~12%), with single worktrees at
 * 101G / 60G / 38G. Reclaiming 23 idle caches freed 416G (91% -> 70%).
 *
 * Cost of a reclaim is one `cargo build` on resume, cushioned by the global
 * sccache rustc-wrapper (~92% hit rate), so this is cheap to run routinely.
 *
 * Deliberately NOT swept: `node_modules`. Bun hardlinks package files into a
 * shared global store, so deleting a worktree's copy frees almost nothing —
 * summing `du` per worktree reported 211G across idle worktrees, but deleting
 * 21 of them freed ~1G of real space. Sizing many worktrees requires ONE `du`
 * over the parent; per-directory sums double-count shared inodes.
 */

import {
  type Dirent,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statfsSync,
  statSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { audit } from "./audit";
import { configuredPaths } from "./config";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Caches untouched this long are always reclaimed — they'd be rebuilt anyway. */
const COLD_DAYS = num(process.env.OPENSESSION_DISK_GC_COLD_DAYS, 7);
/** Never touch a cache built this recently, even under pressure. */
const HOT_HOURS = num(process.env.OPENSESSION_DISK_GC_HOT_HOURS, 24);
/** Relaxed hot window for the last-resort pass, when HOT_HOURS spared everything. */
const URGENT_HOT_HOURS = num(
  process.env.OPENSESSION_DISK_GC_URGENT_HOT_HOURS,
  2,
);
/** Above this disk usage, start reclaiming stale caches... */
const PRESSURE_PCT = num(process.env.OPENSESSION_DISK_GC_PRESSURE_PCT, 80);
/** ...until back under this. */
const RELIEF_PCT = num(process.env.OPENSESSION_DISK_GC_RELIEF_PCT, 70);
const SWEEP_INTERVAL_MS = num(
  process.env.OPENSESSION_DISK_GC_INTERVAL_MS,
  HOUR,
);
const FIRST_SWEEP_DELAY_MS = 5 * MINUTE;

/** Worktrees that are infrastructure, not disposable session trees. */
const PROTECTED_SUFFIXES = ["-warm-template", "-ask-checkout"];

export interface TargetCache {
  /** Worktree directory the cache belongs to. */
  worktree: string;
  /** The `target/` directory itself. */
  path: string;
  /** Newest mtime seen at bounded depth — when this cache was last built. */
  mtimeMs: number;
}

export interface DiskGcResult {
  reclaimed: string[];
  freedBytes: number;
  pctBefore: number;
  pctAfter: number;
  skippedInUse: number;
  skippedHot: number;
}

/** Disk usage of the filesystem holding `path`, as df reports it. */
export function diskUsagePct(path = "/"): number {
  try {
    const s = statfsSync(path);
    const used = Number(s.blocks) - Number(s.bfree);
    const avail = Number(s.bavail);
    const denom = used + avail;
    return denom > 0 ? (used / denom) * 100 : 0;
  } catch {
    return 0;
  }
}

/**
 * Process names that actually write into a cargo `target/`. Only these pin a
 * worktree — see `worktreesInUse`.
 */
const BUILD_PROCESS_NAMES = new Set([
  "cargo",
  "rustc",
  "rustdoc",
  "rust-analyzer",
  "sccache",
  "wasm-pack",
  "wasm-bindgen",
  "cc",
  "gcc",
  "clang",
  "ld",
  "lld",
  "make",
  "ninja",
]);

/**
 * Worktree directories that are the cwd of a live *build* process. Removing a
 * cache under an active build breaks that build, so these are always spared.
 *
 * Deliberately build-aware rather than "any process": long-lived session
 * subprocesses (stdio MCP servers, engine servers) inherit the session's
 * worktree as their cwd and sit there for hours without ever building. Treating
 * those as in-use pinned essentially every worktree in a busy fleet and made
 * the sweep reclaim nothing — the disk climbed past the pressure threshold with
 * disk-gc running and logging every hour. A running build is still protected
 * twice over: its cargo/rustc child matches here, and `hasEntryNewerThan`
 * spares any target/ touched within HOT_HOURS.
 *
 * Linux reads `/proc`; macOS pairs `ps` with `lsof` for the same process/cwd
 * lookup. Returns null when the platform cannot provide a trustworthy answer,
 * so callers skip the sweep rather than guess.
 */
export function worktreesInUse(root: string): Set<string> | null {
  if (process.platform === "darwin") return macWorktreesInUse(root);

  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {
    return null;
  }
  const inUse = new Set<string>();
  const prefix = `${root}/`;
  for (const pid of pids) {
    let cwd: string;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      continue; // process exited, or not ours to inspect
    }
    if (!cwd.startsWith(prefix)) continue;
    if (!isBuildProcess(pid)) continue;
    const rest = cwd.slice(prefix.length);
    const name = rest.split("/")[0];
    if (name) inUse.add(join(root, name));
  }
  return inUse;
}

function macWorktreesInUse(root: string): Set<string> | null {
  const ps = Bun.spawnSync(["ps", "-axo", "pid=,comm="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (ps.exitCode !== 0) return null;

  const builds = ps.stdout
    .toString()
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(.+?)\s*$/))
    .filter(
      (match): match is RegExpMatchArray =>
        !!match && BUILD_PROCESS_NAMES.has(basename(match[2]!)),
    );
  if (!builds.length) return new Set();
  if (!Bun.which("lsof")) return null;

  const inUse = new Set<string>();
  let canonicalRoot = root;
  try {
    canonicalRoot = realpathSync(root);
  } catch {}
  const prefix = `${canonicalRoot}/`;
  for (const match of builds) {
    const pid = match[1]!;
    const lsof = Bun.spawnSync(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (lsof.exitCode !== 0) {
      try {
        process.kill(Number(pid), 0);
        return null;
      } catch {
        continue; // The build exited between ps and lsof.
      }
    }
    const cwd = lsof.stdout
      .toString()
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1);
    if (!cwd?.startsWith(prefix)) continue;
    const name = cwd.slice(prefix.length).split("/")[0];
    if (name) inUse.add(join(root, name));
  }
  return inUse;
}

/**
 * Whether `pid` looks like a build. Unreadable comm counts as a build so an
 * unknown process errs toward sparing the cache.
 */
function isBuildProcess(pid: string): boolean {
  let comm: string;
  try {
    comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return true;
  }
  if (!comm) return true;
  return BUILD_PROCESS_NAMES.has(comm);
}

/**
 * True if anything under `dir` was modified after `cutoffMs`. Bounded depth
 * with an early exit, so this stays cheap over a multi-GB tree: a build always
 * touches the shallow levels (target/debug, .fingerprint, the binaries).
 */
export function hasEntryNewerThan(
  dir: string,
  cutoffMs: number,
  maxDepth = 3,
): boolean {
  const walk = (d: string, depth: number): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      try {
        if (statSync(p).mtimeMs > cutoffMs) return true;
      } catch {
        continue;
      }
      if (depth < maxDepth && e.isDirectory() && walk(p, depth + 1))
        return true;
    }
    return false;
  };
  return walk(dir, 1);
}

/** Newest mtime at bounded depth — a proxy for "when was this last built". */
function newestMtime(dir: string, maxDepth = 2): number {
  let newest = 0;
  const walk = (d: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      try {
        const m = statSync(p).mtimeMs;
        if (m > newest) newest = m;
      } catch {
        continue;
      }
      if (depth < maxDepth && e.isDirectory()) walk(p, depth + 1);
    }
  };
  walk(dir, 1);
  return newest;
}

/**
 * A cargo target dir, identified by the `CACHEDIR.TAG` cargo writes into it —
 * so a JS directory that happens to be named `target` is never a candidate.
 */
function isCargoTarget(dir: string): boolean {
  try {
    return statSync(join(dir, "CACHEDIR.TAG")).isFile();
  } catch {
    return false;
  }
}

/**
 * Cargo target dirs under every worktree. Searches a few levels deep because
 * a repo can have a nested one, e.g. packages/core/webapp/wasm-bindings/target
 * alongside the workspace root's.
 */
export function findTargetCaches(root: string, maxDepth = 5): TargetCache[] {
  let worktrees: string[];
  try {
    worktrees = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const found: TargetCache[] = [];
  for (const name of worktrees) {
    if (PROTECTED_SUFFIXES.some((s) => name.endsWith(s))) continue;
    const worktree = join(root, name);

    const walk = (dir: string, depth: number) => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name === "node_modules" || e.name === ".git")
          continue;
        const p = join(dir, e.name);
        if (e.name === "target") {
          if (isCargoTarget(p)) {
            found.push({ worktree, path: p, mtimeMs: newestMtime(p) });
            continue; // never descend into a target dir
          }
        }
        if (depth < maxDepth) walk(p, depth + 1);
      }
    };
    walk(worktree, 1);
  }
  return found;
}

async function dirSizeBytes(dir: string): Promise<number> {
  try {
    const out = await Bun.$`du -sx -B1 ${dir}`.nothrow().text();
    return Number(out.split(/\s/)[0]) || 0;
  } catch {
    return 0;
  }
}

/** Remove a cache, falling back to sudo for the root-owned wasm/docker builds. */
async function removeCache(dir: string): Promise<boolean> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    await Bun.$`sudo rm -rf ${dir}`.nothrow().quiet();
  }
  try {
    statSync(dir);
    return false; // still there
  } catch {
    return true;
  }
}

/**
 * One GC pass: reclaim every cold cache, then — only if the disk is still
 * under pressure — the stalest remaining ones until back under RELIEF_PCT.
 */
export async function sweepDiskGc(
  opts: { dryRun?: boolean } = {},
): Promise<DiskGcResult> {
  const root = configuredPaths().worktreesDir;
  const pctBefore = diskUsagePct();
  const result: DiskGcResult = {
    reclaimed: [],
    freedBytes: 0,
    pctBefore,
    pctAfter: pctBefore,
    skippedInUse: 0,
    skippedHot: 0,
  };

  const inUse = worktreesInUse(root);
  if (!inUse) {
    console.warn(
      "[disk-gc] cannot inspect build processes — skipping sweep (never GC without the in-use check)",
    );
    return result;
  }

  const candidates = findTargetCaches(root).filter((c) => {
    if (inUse.has(c.worktree)) {
      result.skippedInUse++;
      return false;
    }
    return true;
  });

  const now = Date.now();
  const coldCutoff = now - COLD_DAYS * DAY;
  const hotCutoff = now - HOT_HOURS * HOUR;

  const reclaim = async (c: TargetCache, reason: string) => {
    const size = await dirSizeBytes(c.path);
    if (opts.dryRun) {
      console.log(
        `[disk-gc] would reclaim (${reason}, ${(size / 1e9).toFixed(1)}GB): ${c.path}`,
      );
      result.reclaimed.push(c.path);
      result.freedBytes += size;
      return;
    }
    if (!(await removeCache(c.path))) {
      console.warn(`[disk-gc] could not remove ${c.path}`);
      return;
    }
    result.reclaimed.push(c.path);
    result.freedBytes += size;
    console.log(
      `[disk-gc] reclaimed (${reason}, ${(size / 1e9).toFixed(1)}GB): ${c.path}`,
    );
    audit({ event: "disk_gc_reclaim", path: c.path, reason, bytes: size });
  };

  // Pass 1 — cold caches. Nothing has built against these in COLD_DAYS, so
  // they'd be rebuilt on resume regardless of what we do here.
  const remaining: TargetCache[] = [];
  for (const c of candidates) {
    if (c.mtimeMs < coldCutoff) await reclaim(c, `cold>${COLD_DAYS}d`);
    else remaining.push(c);
  }

  // Pass 2 — disk pressure. Stalest first, and never a cache built recently.
  if (diskUsagePct() >= PRESSURE_PCT) {
    console.log(
      `[disk-gc] disk at ${diskUsagePct().toFixed(1)}% — reclaiming stale caches`,
    );
    for (const c of remaining.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (diskUsagePct() < RELIEF_PCT) break;
      if (hasEntryNewerThan(c.path, hotCutoff)) {
        result.skippedHot++;
        continue;
      }
      await reclaim(c, "disk-pressure");
    }
    // Pass 3 — still under pressure with every remaining cache inside the
    // HOT_HOURS window. On a busy fleet that is the normal case, not an
    // exception: caches are rebuilt constantly, so a 24h hot window spares all
    // of them and the sweep frees nothing while the disk keeps climbing. Fall
    // back to a much shorter window. Nothing has written to these in
    // URGENT_HOT_HOURS, so no build is in flight; the cost is a rebuild on
    // resume, cushioned by the shared sccache.
    if (diskUsagePct() >= PRESSURE_PCT) {
      const urgentCutoff = now - URGENT_HOT_HOURS * HOUR;
      console.warn(
        `[disk-gc] still at ${diskUsagePct().toFixed(1)}% with all caches inside the ` +
          `${HOT_HOURS}h window — escalating to caches idle >${URGENT_HOT_HOURS}h`,
      );
      for (const c of remaining.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
        if (diskUsagePct() < RELIEF_PCT) break;
        if (result.reclaimed.includes(c.path)) continue;
        if (hasEntryNewerThan(c.path, urgentCutoff)) continue;
        await reclaim(c, `disk-pressure idle>${URGENT_HOT_HOURS}h`);
      }
    }

    const pct = diskUsagePct();
    if (pct >= PRESSURE_PCT) {
      console.warn(
        `[disk-gc] still at ${pct.toFixed(1)}% after GC — look beyond worktrees ` +
          `(docker build cache, ~/.opensession-pi, /opt/firecracker)`,
      );
    }
  }

  result.pctAfter = diskUsagePct();
  if (result.reclaimed.length) {
    audit({
      event: "disk_gc_sweep",
      reclaimed: result.reclaimed.length,
      bytes: result.freedBytes,
      pctBefore: Number(result.pctBefore.toFixed(1)),
      pctAfter: Number(result.pctAfter.toFixed(1)),
    });
    console.log(
      `[disk-gc] sweep done: ${result.reclaimed.length} cache(s), ` +
        `${(result.freedBytes / 1e9).toFixed(1)}GB, disk ${result.pctBefore.toFixed(1)}% -> ${result.pctAfter.toFixed(1)}%`,
    );
  }
  return result;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Start the hourly sweep. Call once from the __opensessionBooted block. */
export function startDiskGc(): void {
  if (sweepTimer) return;
  if (process.env.OPENSESSION_DISK_GC === "0") {
    console.log("[disk-gc] disabled (OPENSESSION_DISK_GC=0)");
    return;
  }
  const run = () =>
    void sweepDiskGc().catch((e) =>
      console.error("[disk-gc] sweep failed:", e),
    );
  setTimeout(run, FIRST_SWEEP_DELAY_MS);
  sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
  console.log(
    `[disk-gc] started (every ${Math.round(SWEEP_INTERVAL_MS / MINUTE)}m; ` +
      `cold>${COLD_DAYS}d always, pressure at ${PRESSURE_PCT}% -> ${RELIEF_PCT}%)`,
  );
}
