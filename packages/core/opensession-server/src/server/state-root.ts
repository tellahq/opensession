/**
 * The state-root inputs that need no filesystem answer, in a leaf module
 * with no top-level await.
 *
 * paths.ts reads the state directories asynchronously before it resolves
 * the session store, so it finishes loading asynchronously. A module that is
 * loaded through `require()` (the offline session scanner) must not have it
 * in its import graph, and uses this module instead.
 */
import { homedir } from "os";
import { join } from "path";

/** The current user's home directory ($HOME wins so tests can repoint it). */
export function homeDir(): string {
  return process.env.HOME || homedir();
}

/** statePath for a name with no legacy alternative (anything that is not a
 * standard `.opensession-<name>` entry): under a non-empty
 * OPENSESSION_STATE_DIR, else under the home directory. */
export function plainStatePath(rel: string): string {
  const stateRoot = process.env.OPENSESSION_STATE_DIR || undefined;
  return join(stateRoot || homeDir(), rel);
}

let sessionsDirBinding: (() => string) | undefined;

/** Called once by paths.ts with its OPENSESSION_SESSIONS_DIR binding. */
export function registerSessionsDirBinding(read: () => string): void {
  sessionsDirBinding = read;
}

/** paths.ts's OPENSESSION_SESSIONS_DIR (the load-time store, or what a test
 * seam set), for modules that cannot import paths.ts. */
export function registeredSessionsDir(): string {
  if (!sessionsDirBinding)
    throw new Error(
      "The session store is not resolved yet: import ./paths before scanning",
    );
  return sessionsDirBinding();
}
