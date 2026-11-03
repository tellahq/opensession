/**
 * `Bun.which` without blocking the thread.
 *
 * `Bun.which` walks every PATH directory with a synchronous syscall each, so
 * on a busy disk one lookup can hold the gateway thread for as long as the
 * slowest directory takes to answer. This walks PATH with async `stat` and
 * `access` calls and caches the answer per PATH. A found binary is cached for
 * the life of the process; a miss is re-checked after MISS_TTL_MS, so a CLI
 * installed while the server runs is picked up without a restart.
 */
import { access, constants, stat } from "fs/promises";
import { join } from "path";

const MISS_TTL_MS = 30_000;
const cache = new Map<
  string,
  { at: number; result: Promise<string | null>; settled?: string | null }
>();

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function lookup(command: string, path: string): Promise<string | null> {
  if (command.includes("/"))
    return (await isExecutableFile(command)) ? command : null;
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** Absolute path of `command` on PATH (or `path`), or null when absent. */
export function whichAsync(
  command: string,
  path: string = process.env.PATH ?? "",
): Promise<string | null> {
  const key = `${path}\0${command}`;
  const hit = cache.get(key);
  if (hit) {
    const fresh = performance.now() - hit.at < MISS_TTL_MS;
    if (fresh) return hit.result;
    // Past the miss TTL: a hit stays, a miss is looked up again.
    return hit.result.then((found) =>
      found !== null ? found : refresh(key, command, path),
    );
  }
  return refresh(key, command, path);
}

function refresh(
  key: string,
  command: string,
  path: string,
): Promise<string | null> {
  const result = lookup(command, path);
  const entry: {
    at: number;
    result: Promise<string | null>;
    settled?: string | null;
  } = {
    at: performance.now(),
    result,
  };
  const previous = cache.get(key);
  // Until the new lookup lands, the synchronous reader keeps the last answer.
  if (previous && "settled" in previous) entry.settled = previous.settled;
  cache.set(key, entry);
  void result.then((found) => {
    entry.settled = found;
  });
  return result;
}

/**
 * The last answer whichAsync resolved for `command`, without waiting: a path,
 * null when it was not found, or undefined when no lookup has finished yet.
 * Starts (or renews) the lookup in the background, so await whichAsync once
 * at startup for a synchronous reader that must be right from the start.
 */
export function whichCached(
  command: string,
  path: string = process.env.PATH ?? "",
): string | null | undefined {
  void whichAsync(command, path);
  const entry = cache.get(`${path}\0${command}`);
  return entry && "settled" in entry ? entry.settled : undefined;
}

/** Test seam: forget every cached lookup. */
export function __clearWhichCacheForTest(): void {
  cache.clear();
}
