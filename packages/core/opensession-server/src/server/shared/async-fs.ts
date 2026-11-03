/**
 * Small async filesystem helpers for gateway-reachable code. The gateway
 * thread must never wait on the disk (see scripts/check-gateway-sync-io.ts),
 * so "does it exist, then read it" becomes one read that treats a missing
 * file as absent.
 */
import { constants as fsConstants } from "fs";
import { access, readFile, stat } from "fs/promises";
import { delimiter, join } from "path";

export function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The file's text, or `undefined` when it does not exist. Other read
 *  errors throw. */
export async function readTextIfExists(
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

/** Parsed JSON, or `undefined` when the file is missing, unreadable or
 *  not valid JSON. */
export async function readJsonOrUndefined<T = unknown>(
  path: string,
): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

/** Whether anything exists at `path` (async `existsSync`). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A per-key promise chain: each call runs after every earlier call for the
 *  same key, whether that one succeeded or failed. Keeps an async
 *  read-modify-write of one file from interleaving with another. */
export function keyedOrder(): <T>(
  key: string,
  fn: () => Promise<T>,
) => Promise<T> {
  const chains = new Map<string, Promise<unknown>>();
  return (key, fn) => {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    chains.set(key, next);
    next
      .catch(() => {})
      .finally(() => {
        if (chains.get(key) === next) chains.delete(key);
      });
    return next;
  };
}

const whichHits = new Map<string, Promise<string | null>>();

/** Async `Bun.which`: the first executable `name` on PATH, or null. A hit is
 *  cached for the process lifetime; a miss is looked up again next time, so
 *  a tool installed after boot is still found. */
export function whichAsync(name: string): Promise<string | null> {
  const cached = whichHits.get(name);
  if (cached) return cached;
  const lookup = findOnPath(name);
  whichHits.set(name, lookup);
  void lookup.then((found) => {
    if (!found && whichHits.get(name) === lookup) whichHits.delete(name);
  });
  return lookup;
}

async function findOnPath(name: string): Promise<string | null> {
  if (name.includes("/")) {
    return (await isExecutableFile(name)) ? name : null;
  }
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
