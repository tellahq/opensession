/**
 * Parsed JSON state files, loaded and refreshed without blocking the thread.
 *
 * Small registries (accounts, providers, credentials, the run journal) are
 * read on hot gateway paths, some dozens of times a second. A synchronous
 * `stat` per read was cheap until the disk was busy: then every one of them
 * waited on the filesystem journal on the gateway's only thread.
 *
 * Two ways in:
 *   - `loadJsonFileShared` / `loadJsonFileCopy` (async): a fresh answer. One
 *     async `stat` answers "unchanged" and returns the parse from last time;
 *     concurrent loads of the same path share one read. Use these from
 *     anything that can await, and always before a read-modify-write.
 *   - `cachedJsonFileShared` / `cachedJsonFileCopy` (sync): the last loaded
 *     snapshot, with no I/O at all. A read older than REFRESH_MS starts one
 *     coalesced background refresh, so an edit from another process is seen
 *     within about a second. A path must be loaded once first (modules await
 *     their store at import, as config.ts does); an unloaded path throws
 *     JsonFileNotLoadedError and starts loading it.
 *
 * Writers in this process call publishJsonFile after their write lands, so
 * their own change is visible at once. The identity covers device, inode,
 * size, mtime and ctime: every writer here replaces files by rename, which
 * changes the inode, and an in-place write changes mtime/ctime.
 *
 * `readJsonFileShared` / `readJsonFileCopy` are the older synchronous
 * stat-validated reads, kept only until their remaining callers move to the
 * API above.
 */
import { readFileSync, statSync, type Stats } from "fs";
import { readFile, stat } from "fs/promises";

type State =
  | { kind: "missing" }
  | { kind: "value"; value: unknown }
  | { kind: "error"; error: unknown };

type Entry = {
  fingerprint?: string;
  state?: State;
  checkedAt: number;
  revision: number;
  pending?: Promise<void>;
  /** Local writes published but not yet on disk; refreshes wait for them. */
  unlanded?: number;
};

const REFRESH_MS = 1_000;
const entries = new Map<string, Entry>();

export class JsonFileNotLoadedError extends Error {
  constructor(path: string) {
    super(`${path} is not loaded yet; await loadJsonFileShared() first`);
    this.name = "JsonFileNotLoadedError";
  }
}

function fingerprintOf(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function entryFor(path: string): Entry {
  let entry = entries.get(path);
  if (!entry) {
    entry = { checkedAt: -Infinity, revision: 0 };
    entries.set(path, entry);
  }
  return entry;
}

function refresh(path: string, entry: Entry): Promise<void> {
  if (entry.pending) return entry.pending;
  // The disk still holds what a published local write is replacing.
  if (entry.unlanded) return Promise.resolve();
  const revision = entry.revision;
  const settle = (state: State, fingerprint?: string) => {
    // A local publish that landed meanwhile wins over this older disk read.
    if (revision !== entry.revision) return;
    entry.state = state;
    entry.fingerprint = fingerprint;
  };
  entry.pending = (async () => {
    try {
      const fingerprint = fingerprintOf(await stat(path));
      if (entry.state && fingerprint === entry.fingerprint) return;
      const text = await readFile(path, "utf8");
      let state: State;
      try {
        state = { kind: "value", value: JSON.parse(text) as unknown };
      } catch (error) {
        state = { kind: "error", error };
      }
      settle(state, fingerprint);
    } catch (error) {
      settle(isMissing(error) ? { kind: "missing" } : { kind: "error", error });
    } finally {
      entry.checkedAt = performance.now();
      entry.pending = undefined;
    }
  })();
  return entry.pending;
}

function unwrap<T>(state: State): T | undefined {
  if (state.kind === "missing") return undefined;
  if (state.kind === "error") throw state.error;
  return state.value as T;
}

/**
 * The parsed file, or `undefined` when it does not exist, fresh from disk.
 * Invalid JSON and other read errors reject, as `JSON.parse(await
 * readFile(path))` would.
 *
 * The value is SHARED with every other caller: never mutate it. Use
 * loadJsonFileCopy when the caller patches what it read.
 */
export async function loadJsonFileShared<T = unknown>(
  path: string,
): Promise<T | undefined> {
  const entry = entryFor(path);
  await refresh(path, entry);
  return unwrap<T>(entry.state!);
}

/** loadJsonFileShared, as a private copy the caller may mutate. */
export async function loadJsonFileCopy<T = unknown>(
  path: string,
): Promise<T | undefined> {
  const value = await loadJsonFileShared<T>(path);
  return value === undefined ? undefined : structuredClone(value);
}

/**
 * The last loaded parse, or `undefined` when the file did not exist, with no
 * I/O. Throws JsonFileNotLoadedError for a path never loaded, and the parse
 * error for invalid JSON. The value is SHARED: never mutate it.
 */
export function cachedJsonFileShared<T = unknown>(path: string): T | undefined {
  const entry = entryFor(path);
  if (!entry.state) {
    void refresh(path, entry);
    throw new JsonFileNotLoadedError(path);
  }
  if (performance.now() - entry.checkedAt >= REFRESH_MS)
    void refresh(path, entry);
  return unwrap<T>(entry.state);
}

/** cachedJsonFileShared, as a private copy the caller may mutate. */
export function cachedJsonFileCopy<T = unknown>(path: string): T | undefined {
  const value = cachedJsonFileShared<T>(path);
  return value === undefined ? undefined : structuredClone(value);
}

/** Whether a sync read of `path` would answer from a loaded snapshot. */
export function jsonFileLoaded(path: string): boolean {
  return !!entries.get(path)?.state;
}

/**
 * Record what this process wrote (or `undefined` after a delete), so the next
 * sync read sees it without waiting for a refresh. Call it after the write
 * landed, or pass the pending write as `landed`: until it settles, no
 * background refresh reads the old file back over the published value.
 */
export function publishJsonFile(
  path: string,
  value: unknown,
  landed?: Promise<unknown>,
): void {
  const entry = entryFor(path);
  entry.revision++;
  entry.state =
    value === undefined
      ? { kind: "missing" }
      : { kind: "value", value: structuredClone(value) };
  entry.fingerprint = undefined;
  entry.checkedAt = performance.now();
  if (!landed) return;
  entry.unlanded = (entry.unlanded ?? 0) + 1;
  void landed
    .catch(() => {})
    .then(() => {
      entry.unlanded!--;
      entry.checkedAt = performance.now();
    });
}

/** Drop one path's snapshot, so the next sync read treats it as unloaded. */
export function forgetJsonFile(path: string): void {
  entries.delete(path);
}

type SyncEntry = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  value: unknown;
};

const syncEntries = new Map<string, SyncEntry>();

/**
 * Synchronous stat-validated read: the parsed file, or `undefined` when it
 * does not exist. Blocks the calling thread on the disk; prefer
 * loadJsonFileShared or cachedJsonFileShared.
 */
export function readJsonFileShared<T = unknown>(path: string): T | undefined {
  let stats: Stats;
  try {
    stats = statSync(path);
  } catch (error) {
    if (isMissing(error)) {
      syncEntries.delete(path);
      return undefined;
    }
    throw error;
  }
  const hit = syncEntries.get(path);
  if (
    hit &&
    hit.dev === stats.dev &&
    hit.ino === stats.ino &&
    hit.size === stats.size &&
    hit.mtimeMs === stats.mtimeMs &&
    hit.ctimeMs === stats.ctimeMs
  )
    return hit.value as T;
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  syncEntries.set(path, {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    value,
  });
  return value as T;
}

/** readJsonFileShared, as a private copy the caller may mutate. */
export function readJsonFileCopy<T = unknown>(path: string): T | undefined {
  const value = readJsonFileShared<T>(path);
  return value === undefined ? undefined : structuredClone(value);
}

/** Test seam: forget every cached parse. */
export function __clearJsonFileCacheForTest(): void {
  entries.clear();
  syncEntries.clear();
}
