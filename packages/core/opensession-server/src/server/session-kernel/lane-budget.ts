import { readFileSync } from "node:fs";

/**
 * Upper bound for a scaled lane budget. The gateway RPC client gives up after
 * 15 s (actor-client.ts); the lane must still time out, quarantine, and restart
 * inside that window so the client sees one retryable error instead of a
 * dead transport.
 */
export const LANE_BUDGET_MAX_MS = 12_000;
/** IO pressure (`some avg10` percent) at which the budget reaches its cap. */
const IO_PRESSURE_FULL_SCALE = 50;
const REFRESH_MS = 1_000;

export function readIoSomeAvg10(
  read: (path: string) => string = readProcFile,
): number | null {
  const match = /some avg10=([\d.]+)/.exec(read("/proc/pressure/io"));
  return match ? Number(match[1]) : null;
}

/**
 * Actor turns are bounded SQLite reductions, so a turn that overruns its
 * budget on a quiet host is a stuck actor and the lane must restart. On a host
 * thrashing on swap or a throttled disk (2026-09-07: the root volume was cut
 * from 16000 to 3000 IOPS, and every kernel fail-stop that followed was a
 * healthy lane waiting on IO), the same overrun is only latency. Stretch the
 * budget linearly with host IO pressure so slow turns finish instead of
 * restarting lanes and fail-stopping the service.
 */
export function scaledLaneBudgetMs(
  baseMs: number,
  ioSomeAvg10: number | null,
  maxMs = LANE_BUDGET_MAX_MS,
): number {
  const cap = Math.max(baseMs, maxMs);
  if (ioSomeAvg10 === null || !Number.isFinite(ioSomeAvg10) || ioSomeAvg10 <= 0)
    return baseMs;
  const scale = Math.min(1, ioSomeAvg10 / IO_PRESSURE_FULL_SCALE);
  return Math.round(baseMs + (cap - baseMs) * scale);
}

/**
 * Budget getter for the lane pump. PSI averages move slowly, so one
 * `/proc/pressure/io` read per second is enough and keeps the pump off the
 * filesystem on every turn.
 */
export function createLaneBudget(options: {
  baseMs: number;
  maxMs?: number;
  readIoPressure?: () => number | null;
  now?: () => number;
}): () => number {
  const readIoPressure = options.readIoPressure ?? (() => readIoSomeAvg10());
  const now = options.now ?? Date.now;
  const maxMs = options.maxMs ?? LANE_BUDGET_MAX_MS;
  if (maxMs <= options.baseMs) return () => options.baseMs;
  let refreshedAt = -Infinity;
  let budgetMs = options.baseMs;
  return () => {
    const at = now();
    if (at - refreshedAt >= REFRESH_MS) {
      refreshedAt = at;
      budgetMs = scaledLaneBudgetMs(options.baseMs, readIoPressure(), maxMs);
    }
    return budgetMs;
  };
}

function readProcFile(path: string): string {
  try {
    // Failures (macOS, containers without PSI) simply disable the signal.
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
