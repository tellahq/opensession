/**
 * Parsed JSON state files, re-read only when the file changes.
 *
 * Small registries (accounts, providers, credentials, the run journal) are
 * read on hot gateway paths, some dozens of times a second. Reading and
 * parsing them every time kept the event loop busy with identical work. One
 * `stat` now answers "unchanged" and returns the parse from last time.
 *
 * The identity covers device, inode, size, mtime and ctime. Every writer in
 * this codebase replaces files by rename (writeJsonAtomic), which changes the
 * inode, and an in-place write changes mtime/ctime, so a write from this or
 * any other process is seen on the next read.
 */
import { readFileSync, statSync, type Stats } from "fs";

type Entry = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  value: unknown;
};

const entries = new Map<string, Entry>();

function sameFile(entry: Entry, stats: Stats): boolean {
  return (
    entry.dev === stats.dev &&
    entry.ino === stats.ino &&
    entry.size === stats.size &&
    entry.mtimeMs === stats.mtimeMs &&
    entry.ctimeMs === stats.ctimeMs
  );
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The parsed file, or `undefined` when it does not exist. Invalid JSON and
 * other read errors throw, as `JSON.parse(readFileSync(path))` would.
 *
 * The value is SHARED with every other caller: never mutate it. Use
 * readJsonFileCopy when the caller patches what it read.
 */
export function readJsonFileShared<T = unknown>(path: string): T | undefined {
  let stats: Stats;
  try {
    stats = statSync(path);
  } catch (error) {
    if (isMissing(error)) {
      entries.delete(path);
      return undefined;
    }
    throw error;
  }
  const hit = entries.get(path);
  if (hit && sameFile(hit, stats)) return hit.value as T;
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  entries.set(path, {
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
}
