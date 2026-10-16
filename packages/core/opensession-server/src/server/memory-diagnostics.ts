/**
 * Gateway memory diagnostics.
 *
 * Reports what an operator needs to tell where a long-running gateway's
 * resident memory went: process.memoryUsage(), JavaScriptCore heap statistics,
 * the allocator's view, and the size of every process-lifetime structure that
 * registered a probe (memory-probes.ts). Served only on explicit request
 * (routes/memory-diagnostics.ts, `opensession memory`), never on a timer.
 *
 * A heap snapshot is also explicit. Generating one pauses the gateway thread
 * for as long as the heap walk takes and holds the serialized snapshot in
 * memory while it is written, so it is single-flight and the file is written
 * with async I/O. Snapshots contain every string on the heap, including
 * credentials, so the directory and files are owner-only and only the newest
 * few are kept.
 */
import { heapStats, memoryUsage as jscMemoryUsage } from "bun:jsc";
import {
  chmod,
  mkdir,
  readdir,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { readMemoryProbes } from "./memory-probes";
import { stateDir } from "./paths";

/** Heap object types reported, largest counts first. */
const TOP_OBJECT_TYPES = 30;
/** Snapshots kept in the state directory; older ones are deleted. */
export const KEEP_HEAP_SNAPSHOTS = 3;
/** Free space left after a snapshot is written, so it cannot fill the disk
 *  the gateway's own state lives on. */
export const SNAPSHOT_FREE_SPACE_MARGIN_BYTES = 256 * 1024 * 1024;
const PARTIAL_SUFFIX = ".partial";

export const heapSnapshotDir = () => stateDir("heap-snapshots");

function topCounts(
  counts: Record<string, number> | undefined,
  limit: number,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit),
  );
}

/** The allocator fields that explain RSS the JS heap does not account for. */
function mimallocSummary(raw: unknown): Record<string, number> | undefined {
  const stats = raw as
    | {
        reserved?: { current?: number };
        committed?: { current?: number; peak?: number };
        pages_abandoned?: { current?: number };
        threads?: { current?: number };
      }
    | undefined;
  if (!stats || typeof stats !== "object") return undefined;
  const out: Record<string, number> = {};
  const put = (key: string, value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  };
  put("reservedBytes", stats.reserved?.current);
  put("committedBytes", stats.committed?.current);
  put("committedPeakBytes", stats.committed?.peak);
  put("abandonedPages", stats.pages_abandoned?.current);
  put("threads", stats.threads?.current);
  return out;
}

export interface MemoryDiagnostics {
  at: string;
  pid: number;
  uptimeSeconds: number;
  /** process.memoryUsage(): rss covers every thread, including workers. */
  process: NodeJS.MemoryUsage;
  /** JavaScriptCore heap of the gateway thread only. */
  heap: {
    heapSize: number;
    heapCapacity: number;
    extraMemorySize: number;
    objectCount: number;
    protectedObjectCount: number;
    globalObjectCount: number;
    protectedGlobalObjectCount: number;
    objectTypeCounts: Record<string, number>;
    protectedObjectTypeCounts: Record<string, number>;
  };
  allocator: {
    jsc: ReturnType<typeof jscMemoryUsage>;
    mimalloc?: Record<string, number>;
  };
  /** Sizes of process-lifetime maps, sets and caches, by `<module>.<name>`. */
  structures: ReturnType<typeof readMemoryProbes>;
}

export function memoryDiagnostics(): MemoryDiagnostics {
  const stats = heapStats() as ReturnType<typeof heapStats> & {
    mimalloc?: unknown;
  };
  return {
    at: new Date().toISOString(),
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    process: process.memoryUsage(),
    heap: {
      heapSize: stats.heapSize,
      heapCapacity: stats.heapCapacity,
      extraMemorySize: stats.extraMemorySize,
      objectCount: stats.objectCount,
      protectedObjectCount: stats.protectedObjectCount,
      globalObjectCount: stats.globalObjectCount,
      protectedGlobalObjectCount: stats.protectedGlobalObjectCount,
      objectTypeCounts: topCounts(stats.objectTypeCounts, TOP_OBJECT_TYPES),
      protectedObjectTypeCounts: topCounts(
        stats.protectedObjectTypeCounts,
        TOP_OBJECT_TYPES,
      ),
    },
    allocator: {
      jsc: jscMemoryUsage(),
      mimalloc: mimallocSummary(stats.mimalloc),
    },
    structures: readMemoryProbes(),
  };
}

export interface HeapSnapshotResult {
  path: string;
  bytes: number;
  durationMs: number;
}

let snapshotInFlight: Promise<HeapSnapshotResult> | null = null;

/** Whether a snapshot is being generated or written right now. */
export function heapSnapshotInFlight(): boolean {
  return snapshotInFlight !== null;
}

/**
 * Write a V8-format heap snapshot (loadable in Chrome DevTools) to the state
 * directory. Concurrent callers share one snapshot.
 */
export function writeHeapSnapshot(
  options: {
    dir?: string;
    generate?: () => string;
    now?: () => Date;
    /** Bytes free in `dir`; defaults to statfs. */
    freeBytes?: (dir: string) => Promise<number>;
    write?: (path: string, data: string) => Promise<void>;
  } = {},
): Promise<HeapSnapshotResult> {
  if (snapshotInFlight) return snapshotInFlight;
  const run = (async () => {
    const dir = options.dir ?? heapSnapshotDir();
    const started = performance.now();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    // Yield once so the request that asked for this is not the only thing
    // the event loop has done since; generation itself is synchronous.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const generate =
      options.generate ?? (() => Bun.generateHeapSnapshot("v8") as string);
    const freeBytes =
      options.freeBytes ??
      (async (target: string) => {
        const fs = await statfs(target);
        return fs.bavail * fs.bsize;
      });
    const write =
      options.write ??
      ((target: string, data: string) =>
        writeFile(target, data, { mode: 0o600, flag: "wx" }));
    const stamp = (options.now?.() ?? new Date())
      .toISOString()
      .replace(/[:.]/g, "-");
    const path = join(dir, `gateway-${stamp}-${process.pid}.heapsnapshot`);
    // Written under a name retention and readers ignore, then renamed, so a
    // failed write never leaves a truncated snapshot behind.
    const partial = `${path}${PARTIAL_SUFFIX}`;
    try {
      let snapshot: string | null = generate();
      const bytes = Buffer.byteLength(snapshot);
      const free = await freeBytes(dir);
      if (free < bytes + SNAPSHOT_FREE_SPACE_MARGIN_BYTES)
        throw new Error(
          `not enough free disk space for a ${Math.ceil(bytes / 1024 / 1024)} MB snapshot`,
        );
      try {
        await write(partial, snapshot);
        snapshot = null;
        await rename(partial, path);
      } catch (error) {
        await rm(partial, { force: true }).catch(() => {});
        throw error;
      }
      return {
        path,
        bytes,
        durationMs: Math.round(performance.now() - started),
      };
    } finally {
      await pruneSnapshots(dir).catch((error) =>
        console.warn("[memory-diagnostics] snapshot cleanup failed:", error),
      );
    }
  })();
  snapshotInFlight = run;
  const clear = () => {
    if (snapshotInFlight === run) snapshotInFlight = null;
  };
  run.then(clear, clear);
  return run;
}

/** Keep the newest snapshots and drop partial files a crashed write left. */
async function pruneSnapshots(dir: string): Promise<void> {
  const names = await readdir(dir);
  for (const name of names)
    if (name.endsWith(PARTIAL_SUFFIX))
      await rm(join(dir, name), { force: true });
  const files = names.filter((name) => name.endsWith(".heapsnapshot")).sort();
  for (const old of files.slice(
    0,
    Math.max(0, files.length - KEEP_HEAP_SNAPSHOTS),
  ))
    await rm(join(dir, old), { force: true });
}
