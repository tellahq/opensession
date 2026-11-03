import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

const cache = new Map<string, Promise<string | null>>();

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function lookup(command: string, path: string): Promise<string | null> {
  if (command.includes("/"))
    return isAbsolute(command) && (await isExecutableFile(command))
      ? command
      : null;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The asynchronous counterpart of `Bun.which`: the first executable named
 * `command` on PATH, or null. `Bun.which` walks PATH with blocking stat
 * calls, so the gateway thread resolves commands here instead. Each
 * command/PATH pair is resolved once and cached for the process lifetime.
 */
export function whichAsync(
  command: string,
  path: string = process.env.PATH ?? "",
): Promise<string | null> {
  const key = `${command}\0${path}`;
  let found = cache.get(key);
  if (!found) {
    found = lookup(command, path);
    cache.set(key, found);
  }
  return found;
}
