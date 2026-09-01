/**
 * Host metrics: disk, memory, load, process fleets, cgroup accounting.
 *
 * Extracted from routes/system.ts so the same builder can answer both the
 * /api/health endpoint and the `opensession-health` MCP tool (health-mcp.ts).
 * The monitor that reads these numbers is an unattended automation, and an
 * automation cannot fetch its own host over HTTP: web-fetch.ts refuses
 * loopback by design, and no engine hands an unattended ask run a shell. So
 * the metrics have to be reachable as a tool, and that means they cannot live
 * inside a route handler.
 *
 * Pure reads of /proc, statfs and the cgroup tree. No side effects at import.
 */

import { readFileSync, readdirSync, statfsSync } from "node:fs";
import { cpus, loadavg } from "node:os";

// ── Gateway event-loop lag ──────────────────────────────────────────────────
// The session-performance contract measures only the CLIENT (docs/
// session-performance.md); the server had no equivalent, so gateway loop
// saturation was only discoverable as unexplained global latency. A 100 ms
// heartbeat records how late each tick fires; the delta over the expected
// interval is time the loop spent blocked (synchronous SQLite, big JSON,
// WS fanout). Parked on globalThis (hot-reload safe), armed only from boot
// via startEventLoopLagMonitor — never at import (AGENTS.md invariant).
const LAG_TICK_MS = 100;
const LAG_WINDOW = 600; // ring buffer ≈ last minute

type LoopLagState = {
  timer?: ReturnType<typeof setInterval>;
  lastTick: number;
  ring: Float64Array;
  ringNext: number;
  ringFilled: number;
  /** Cumulative ticks whose lag exceeded 100 ms since boot. */
  stalls100: number;
  /** Worst single lag since boot, ms. */
  worstMs: number;
};

const lagGlobal = globalThis as typeof globalThis & {
  __osLoopLag?: LoopLagState;
};

/** Idempotent; called once from opensession.ts boot. Timer is unref'd so it
 *  never keeps the process alive. */
export function startEventLoopLagMonitor(): void {
  if (lagGlobal.__osLoopLag?.timer) return;
  const state: LoopLagState = lagGlobal.__osLoopLag ?? {
    lastTick: performance.now(),
    ring: new Float64Array(LAG_WINDOW),
    ringNext: 0,
    ringFilled: 0,
    stalls100: 0,
    worstMs: 0,
  };
  lagGlobal.__osLoopLag = state;
  state.lastTick = performance.now();
  state.timer = setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - state.lastTick - LAG_TICK_MS);
    state.lastTick = now;
    state.ring[state.ringNext] = lag;
    state.ringNext = (state.ringNext + 1) % LAG_WINDOW;
    if (state.ringFilled < LAG_WINDOW) state.ringFilled++;
    if (lag > 100) state.stalls100++;
    if (lag > state.worstMs) state.worstMs = lag;
  }, LAG_TICK_MS);
  state.timer.unref?.();
}

function eventLoopSnapshot(): Record<string, unknown> | null {
  const state = lagGlobal.__osLoopLag;
  if (!state || state.ringFilled === 0) return null;
  const samples = Array.from(state.ring.subarray(0, state.ringFilled)).sort(
    (a, b) => a - b,
  );
  const pick = (p: number) =>
    samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
  return {
    windowSeconds: Math.round((state.ringFilled * LAG_TICK_MS) / 1000),
    lagP50Ms: +pick(0.5).toFixed(2),
    lagP95Ms: +pick(0.95).toFixed(2),
    lagMaxMs: +samples[samples.length - 1].toFixed(2),
    stallsOver100MsSinceBoot: state.stalls100,
    worstMsSinceBoot: +state.worstMs.toFixed(2),
  };
}

/** Host metrics for /api/health and the `read_host_metrics` tool. The
 *  health-monitor automation reads these numbers through the tool: it runs
 *  unattended in ask mode, which has no shell on either engine, and it cannot
 *  fetch its own host over HTTP because web-fetch.ts refuses loopback. Keep
 *  these fields stable, and keep both readers on this one builder. */
export function systemStats(): Record<string, unknown> {
  try {
    const mem: Record<string, number> = {};
    for (const line of readFileSync("/proc/meminfo", "utf-8").split("\n")) {
      const m = line.match(/^(\w+):\s+(\d+) kB/);
      if (m) mem[m[1]] = Number(m[2]) * 1024;
    }
    const s = statfsSync("/");
    const totalBytes = s.blocks * s.bsize;
    const availBytes = s.bavail * s.bsize;
    const [load1, load5, load15] = loadavg();
    return {
      disk: {
        mount: "/",
        totalGb: +(totalBytes / 1e9).toFixed(1),
        availGb: +(availBytes / 1e9).toFixed(1),
        usedPct: +((1 - availBytes / totalBytes) * 100).toFixed(1),
      },
      memory: {
        totalGb: +((mem.MemTotal || 0) / 1e9).toFixed(2),
        availableGb: +((mem.MemAvailable || 0) / 1e9).toFixed(2),
        availablePct: mem.MemTotal
          ? +(((mem.MemAvailable || 0) / mem.MemTotal) * 100).toFixed(1)
          : null,
        swapUsedGb: +(
          ((mem.SwapTotal || 0) - (mem.SwapFree || 0)) /
          1e9
        ).toFixed(2),
      },
      load: { "1m": load1, "5m": load5, "15m": load15, cores: cpus().length },
      eventLoop: eventLoopSnapshot(),
      processes: processCensus(),
      cgroups: cgroupCensus(),
    };
  } catch (e) {
    return { error: String((e as Error)?.message || e) };
  }
}

interface CgroupMemorySnapshot {
  unit: string;
  currentGb: number;
  peakGb: number | null;
  anonGb: number;
  fileGb: number;
  highGb: number | null;
  maxGb: number | null;
  tasks: number | null;
  oom: number;
  oomKill: number;
}

const gb = (bytes: number): number => +(bytes / 1e9).toFixed(2);

function readCgroupNumber(path: string): number | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    if (!value || value === "max") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readCgroupMap(path: string): Record<string, number> {
  const values: Record<string, number> = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const [key, raw] = line.trim().split(/\s+/, 2);
      const parsed = Number(raw);
      if (key && Number.isFinite(parsed)) values[key] = parsed;
    }
  } catch {}
  return values;
}

function cgroupSnapshot(dir: string): CgroupMemorySnapshot | null {
  const current = readCgroupNumber(`${dir}/memory.current`);
  if (current == null) return null;
  const peak = readCgroupNumber(`${dir}/memory.peak`);
  const high = readCgroupNumber(`${dir}/memory.high`);
  const max = readCgroupNumber(`${dir}/memory.max`);
  const tasks = readCgroupNumber(`${dir}/pids.current`);
  const stat = readCgroupMap(`${dir}/memory.stat`);
  const events = readCgroupMap(`${dir}/memory.events`);
  return {
    unit: dir.slice(dir.lastIndexOf("/") + 1),
    currentGb: gb(current),
    peakGb: peak == null ? null : gb(peak),
    anonGb: gb(stat.anon || 0),
    fileGb: gb(stat.file || 0),
    highGb: high == null ? null : gb(high),
    maxGb: max == null ? null : gb(max),
    tasks,
    oom: events.oom || 0,
    oomKill: events.oom_kill || 0,
  };
}

function collectScopeDirs(root: string, out: string[], depth = 0): void {
  if (depth > 5) return;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = `${root}/${entry.name}`;
      if (/^opensession-(?:oc|preview)-.*\.scope$/.test(entry.name)) {
        out.push(path);
        continue;
      }
      collectScopeDirs(path, out, depth + 1);
    }
  } catch {}
}

function summarizeScopes(
  scopes: CgroupMemorySnapshot[],
): Record<string, unknown> {
  const sorted = scopes.sort((a, b) => b.currentGb - a.currentGb);
  return {
    count: sorted.length,
    currentGb: +sorted
      .reduce((sum, scope) => sum + scope.currentGb, 0)
      .toFixed(2),
    anonGb: +sorted.reduce((sum, scope) => sum + scope.anonGb, 0).toFixed(2),
    fileGb: +sorted.reduce((sum, scope) => sum + scope.fileGb, 0).toFixed(2),
    oomKills: sorted.reduce((sum, scope) => sum + scope.oomKill, 0),
    top: sorted.slice(0, 5),
  };
}

let cgroupCache: { at: number; data: Record<string, unknown> } | null = null;

/** cgroup v2 resource accounting for the coordinator and detached fleets.
 * Includes anon vs file cache so a reclaimable compiler cache is not mistaken
 * for the anonymous-memory exhaustion that wedged the host on 2026-07-31. */
function cgroupCensus(): Record<string, unknown> {
  if (cgroupCache && Date.now() - cgroupCache.at < 60_000)
    return cgroupCache.data;
  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const userRoot = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service`;
    const dirs: string[] = [];
    collectScopeDirs(userRoot, dirs);
    const snapshots = dirs
      .map(cgroupSnapshot)
      .filter((snapshot): snapshot is CgroupMemorySnapshot => snapshot != null);
    const selfRelative = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((line) => line.startsWith("0::"))
      ?.slice(3);
    const data = {
      coordinator: selfRelative
        ? cgroupSnapshot(`/sys/fs/cgroup${selfRelative}`)
        : null,
      user: cgroupSnapshot(userRoot),
      engines: summarizeScopes(
        snapshots.filter((scope) => scope.unit.startsWith("opensession-oc-")),
      ),
      previews: summarizeScopes(
        snapshots.filter((scope) =>
          scope.unit.startsWith("opensession-preview-"),
        ),
      ),
    };
    cgroupCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    return { error: String((e as Error)?.message || e) };
  }
}

/** Counts of the process fleets that have historically leaked or ballooned
 *  (2026-07-27: 664 mcp-proxies / 42GB RSS, 26 orphaned pi scopes, a
 *  3-day goldenbuild dev stack). Surfacing them here lets the health-monitor
 *  automation name the offender in an alert instead of just "high load".
 *  /proc scan, 60s-cached — RestartOverlay polls this endpoint at 1.5s during
 *  incidents. */
let censusCache: { at: number; data: Record<string, number> } | null = null;
function processCensus(): Record<string, number> {
  if (censusCache && Date.now() - censusCache.at < 60_000)
    return censusCache.data;
  const counts = {
    mcpProxies: 0,
    chrome: 0,
    nextDev: 0,
    gitOps: 0,
    total: 0,
  };
  try {
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      counts.total++;
      let cmd = "";
      try {
        cmd = readFileSync(`/proc/${pid}/cmdline`, "utf-8").replaceAll(
          "\0",
          " ",
        );
      } catch {
        continue; // process exited mid-scan
      }
      if (cmd.includes("mcp-proxy.")) counts.mcpProxies++;
      else if (cmd.includes("/chrome") && cmd.includes("--headless"))
        counts.chrome++;
      // One per dev stack: a `just dev-next` stack spawns ~6 processes whose
      // cmdline mentions "next dev" (bunx/concurrently/sh/bun/node), so count
      // only the next-server root or 2 healthy stacks read as 12 "leaks".
      else if (cmd.startsWith("next-server")) counts.nextDev++;
      else if (/(^|\/)git(-lfs)? /.test(cmd)) counts.gitOps++;
    }
  } catch {}
  censusCache = { at: Date.now(), data: counts };
  return counts;
}
