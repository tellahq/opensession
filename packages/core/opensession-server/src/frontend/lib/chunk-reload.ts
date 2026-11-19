/*
 * Recovery for a lazy chunk that is gone from the server.
 *
 * Chunks are content-hashed and only the last few releases stay servable, so a
 * tab that kept running an older bundle through several deploys can ask for a
 * chunk the server no longer has. The import then rejects, and a rejected
 * React.lazy unmounts the whole app. A reload loads the current bundle, whose
 * chunks are all present, so that is the fix: reload once, and leave the
 * import pending meanwhile so nothing renders the failure.
 *
 * A second failure soon after a reload means the current build itself is
 * missing the chunk, so the error is rethrown instead of reloading in a loop.
 */

const RELOAD_KEY = "os1-chunk-reload-at";
const RELOAD_GUARD_MS = 30_000;

// Chrome: "Failed to fetch dynamically imported module", Firefox: "error
// loading dynamically imported module", Safari: "Importing a module script
// failed".
const CHUNK_ERROR_RE =
  /dynamically imported module|importing a module script failed/i;

export function isChunkLoadError(error: Error): boolean {
  return CHUNK_ERROR_RE.test(error.message);
}

type ReloadEnv = {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  now: () => number;
  reload: () => void;
};

function browserEnv(): ReloadEnv {
  let storage: ReloadEnv["storage"] = null;
  try {
    storage = window.sessionStorage;
  } catch {}
  return {
    storage,
    now: Date.now,
    reload: () => window.location.reload(),
  };
}

/** Reload for a missing chunk unless one already happened within the guard
 *  window. True when the page is reloading. */
export function reloadForMissingChunk(env: ReloadEnv = browserEnv()): boolean {
  const now = env.now();
  let last = Number.NaN;
  try {
    last = Number(env.storage?.getItem(RELOAD_KEY));
  } catch {}
  if (now - last < RELOAD_GUARD_MS) return false;
  try {
    env.storage?.setItem(RELOAD_KEY, String(now));
  } catch {}
  env.reload();
  return true;
}

/** Run a dynamic import; a missing chunk reloads the page instead of
 *  rejecting. */
export async function importOrReload<T>(
  load: () => Promise<T>,
  env?: ReloadEnv,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (
      error instanceof Error &&
      isChunkLoadError(error) &&
      reloadForMissingChunk(env)
    ) {
      return new Promise<T>(() => {});
    }
    throw error;
  }
}
