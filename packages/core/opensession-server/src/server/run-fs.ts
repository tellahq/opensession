/**
 * Async filesystem helpers for run, worktree, runner and portal code on the
 * gateway thread, which must never wait on the disk synchronously.
 */
import { access, readFile, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { constants } from "node:fs";
import { writeJsonAtomicAsync } from "./shared/atomic-write";

/** True when `path` exists (any type), following symlinks like existsSync. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** File contents, or undefined when it is missing or unreadable. */
export async function readTextOrUndefined(
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Async equivalent of Bun.which: the first executable `bin` on PATH. */
export async function whichAsync(
  bin: string,
  pathEnv = process.env.PATH ?? "",
): Promise<string | null> {
  if (bin.includes("/")) return (await isExecutableFile(bin)) ? bin : null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const whichCache = new Map<string, Promise<string | null>>();

/** whichAsync resolved once per binary for the life of the process. */
export function cachedWhich(bin: string): Promise<string | null> {
  let hit = whichCache.get(bin);
  if (!hit) {
    hit = whichAsync(bin);
    whichCache.set(bin, hit);
  }
  return hit;
}

/**
 * A JSON file this process alone writes, kept in memory after one async
 * read. `load` hands out a copy, so callers keep the snapshot semantics of a
 * fresh read; `save` updates memory at once and writes the file in order.
 * Run every load/mutate/save sequence inside `exclusive`, so two of them
 * never interleave across an await. The cache follows `path()`, so a changed
 * state directory reads again.
 */
export function cachedJsonStore<T>(
  path: () => string,
  parse: (raw: unknown) => T,
) {
  let cache: { path: string; value: Promise<T> } | undefined;
  let writes: Promise<unknown> = Promise.resolve();
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (file: string): Promise<T> => {
    let raw: unknown = undefined;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch {}
    return parse(raw);
  };
  return {
    async load(): Promise<T> {
      const file = path();
      if (cache?.path !== file) cache = { path: file, value: read(file) };
      return structuredClone(await cache.value);
    },
    save(value: T): Promise<void> {
      const file = path();
      const snapshot = structuredClone(value);
      cache = { path: file, value: Promise.resolve(snapshot) };
      const write = writes
        .catch(() => {})
        .then(() => writeJsonAtomicAsync(file, snapshot));
      writes = write;
      return write;
    },
    exclusive<R>(fn: () => Promise<R>): Promise<R> {
      const run = queue.catch(() => {}).then(fn);
      queue = run;
      return run;
    },
  };
}
