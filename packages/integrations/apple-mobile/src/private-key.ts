import type { Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

/** Throws when the resolved key file is not a private file outside the
 *  project. Pure: callers resolve and stat the path. */
export function checkPrivateKeyFile(
  path: string,
  stats: Stats,
  projectDir?: string,
): void {
  if (!stats.isFile())
    throw new Error("APPLE_ASC_PRIVATE_KEY_PATH must be a file");
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      "APPLE_ASC_PRIVATE_KEY_PATH must not be accessible by group or others",
    );
  }
  if (projectDir && isWithin(projectDir, path)) {
    throw new Error(
      "APPLE_ASC_PRIVATE_KEY_PATH must be outside the project being released",
    );
  }
}

/** resolvePrivateKeyPath (security.ts) without blocking the caller's thread,
 *  for the Open Session gateway's setup route. */
export async function resolvePrivateKeyPathAsync(
  input: string,
  projectDir?: string,
): Promise<string> {
  if (!input) throw new Error("APPLE_ASC_PRIVATE_KEY_PATH is required");
  const path = await realpath(resolve(input));
  checkPrivateKeyFile(path, await stat(path), projectDir);
  return path;
}
