/**
 * Asynchronous, cached replacement for `Bun.which` on the gateway thread.
 *
 * `Bun.which` walks every PATH entry with synchronous `stat` calls, which can
 * park the event loop behind a busy filesystem journal. This walks PATH with
 * `fs/promises` instead. A found executable is cached for the life of the
 * process (keyed by PATH, so a changed PATH looks again); a miss is cached
 * briefly, so an operator who installs a tool sees it within a minute without
 * a restart. Concurrent lookups for the same name share one walk.
 */
import { constants } from "fs";
import { access, stat } from "fs/promises";
import { delimiter, join } from "path";

const MISS_TTL_MS = 60_000;

const found = new Map<string, string>();
const missedAt = new Map<string, number>();
const inflight = new Map<string, Promise<string | null>>();

async function executableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function search(name: string, path: string): Promise<string | null> {
  if (name.includes("/")) return (await executableFile(name)) ? name : null;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (await executableFile(candidate)) return candidate;
  }
  return null;
}

/** The absolute path of executable `name` on PATH, or null. */
export async function findExecutable(name: string): Promise<string | null> {
  const path = process.env.PATH ?? "";
  const key = `${path}\0${name}`;
  const hit = found.get(key);
  if (hit) return hit;
  const missed = missedAt.get(key);
  if (missed !== undefined && Date.now() - missed < MISS_TTL_MS) return null;
  let lookup = inflight.get(key);
  if (!lookup) {
    lookup = search(name, path)
      .then((result) => {
        if (result) found.set(key, result);
        else missedAt.set(key, Date.now());
        return result;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, lookup);
  }
  return lookup;
}
