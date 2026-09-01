/**
 * Shared on-disk paths for the session store.
 *
 * State roots resolve at CALL time (statePath, stateDir, sessionsDir), so a
 * process that repoints OPENSESSION_STATE_DIR gets one consistent answer
 * everywhere. `OPENSESSION_SESSIONS_DIR` is the one exception: it is a
 * load-time snapshot, kept for the ~50 modules that read it as a binding.
 * Anything resolving a path itself should call sessionsDir(). Never mix the
 * two: reading one input live and the other pinned is how a dev instance ends
 * up matching its own state root but writing into the live store.
 */

import { existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { randomUUIDv7 } from "bun";

/** The current user's home directory ($HOME wins so tests can repoint it). */
export function homeDir(): string {
  return process.env.HOME || homedir();
}

/** The historical top-level name for a state entry. */
function legacyStateName(base: string): string {
  return `.opensession-${base}`;
}

/**
 * Resolve a state path relative to the state root.
 *
 * Standard `.opensession-<name>` entries now live together as
 * `~/.opensession/<name>`. Existing installations continue using a legacy
 * top-level entry when it exists and the new path does not, which avoids
 * silently splitting a store during an upgrade. A fresh installation has no
 * legacy entries, so every new store starts under `~/.opensession/`.
 *
 * A non-empty OPENSESSION_STATE_DIR is an isolated namespace (dev/demo
 * instances, src/server/dev-mode.ts). It retains the literal relative names
 * for compatibility and never falls back to live home-directory state. Other
 * relative paths, notably `.opensession/config.json` and `.opensession.env`,
 * also retain their literal layout.
 */
export function statePath(rel: string): string {
  const stateRoot = process.env.OPENSESSION_STATE_DIR;
  const standardBase = rel.startsWith(".opensession-")
    ? rel.slice(".opensession-".length)
    : null;
  if (stateRoot) return join(stateRoot, rel);

  const home = homeDir();
  if (!standardBase) return join(home, rel);

  const current = join(home, ".opensession", standardBase);
  const legacy = join(home, rel);
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
}

/** Sugar for standard state: `stateDir("audit")` → `~/.opensession/audit`.
 * Works for files too (`stateDir("pins.json")`). */
export function stateDir(base: string): string {
  return statePath(legacyStateName(base));
}

function resolveSessionsDir(): string {
  // Env override first (test/verify/conformance suites point it at a scratch
  // dir so sbxtest state files, run dirs and kill-switch checks never touch
  // the live store — set it BEFORE importing any src/server module).
  const fromEnv = process.env.OPENSESSION_SESSIONS_DIR;
  if (fromEnv) return fromEnv;
  // Isolated state namespace (dev/demo instances — see statePath):
  // everything lives under OPENSESSION_STATE_DIR. The run-rpc unix socket
  // derives from this dir, so the isolation also keeps a second instance off
  // the live instance's socket.
  return stateDir("sessions");
}

/** The active session-store dir, snapshotted at load. */
export let OPENSESSION_SESSIONS_DIR = resolveSessionsDir();

/**
 * The active session-store dir, resolved per call. Shaped like
 * workspacesDir() (src/server/workspaces.ts) and draftsDir() for the same
 * reason: a live env has to beat a load-time pin, or a repointed state root
 * gets a store that belongs to another instance. Falls back to the exported
 * binding (the load-time value, or whatever __setSessionsDirForTest last set)
 * when neither env var is in play, so the test seam keeps working.
 */
export function sessionsDir(): string {
  return (
    process.env.OPENSESSION_SESSIONS_DIR ||
    (process.env.OPENSESSION_STATE_DIR
      ? stateDir("sessions")
      : OPENSESSION_SESSIONS_DIR)
  );
}

/**
 * Test seam (bun tests only): repoint the session store AFTER this module has
 * been evaluated. ES module bindings are live, so consumers that read
 * `OPENSESSION_SESSIONS_DIR` at THEIR load time (e.g. sessions.ts, which the
 * tests re-import cache-busted) pick the new value up — the env override above
 * only works when it's set before the first import of this module, which a bun
 * test file can't guarantee (file execution order is not alphabetical, and
 * any earlier test file importing the server graph evaluates this module).
 * Returns the previous value so afterAll can restore it.
 */
export function __setSessionsDirForTest(dir: string): string {
  const prev = OPENSESSION_SESSIONS_DIR;
  OPENSESSION_SESSIONS_DIR = dir;
  return prev;
}

/**
 * Names the session store has had. Absolute paths were persisted verbatim by
 * whatever the store was called at the time — walkthrough stills and demo
 * videos, staged composer uploads, `OPENSESSION_VIDEO:` markers in transcripts,
 * media links spliced into PR descriptions — so each rename orphaned every one
 * of them: the path is still in the record, the directory it names is gone.
 */
const LEGACY_SESSIONS_DIR_NAMES = [
  ".opensession-sessions",
  ".opensession-chats",
  ".backstage-chats",
];

/**
 * Map a stored absolute path under a former session-store dir onto the active
 * one. Only rewrites when the stored path is genuinely gone and the remapped
 * one exists, so a legacy dir that still has its own contents keeps winning,
 * and a path outside the store is returned untouched. Callers keep doing their
 * own scoping checks — this resolves a name, it does not grant access.
 */
export function resolveLegacySessionsPath(p: string): string {
  if (!p.startsWith("/")) return p;
  // Both sides come from the same sessionsDir() call: the former store sat
  // where the active one sits, so the prefix to match is derived from it
  // rather than re-read from the env. Mixing a live root with a pinned store
  // makes the function disagree with itself: an isolated instance would match
  // its own state root and then remap into the live store.
  const active = sessionsDir();
  const roots = [dirname(active)];
  const home = homeDir();
  if (!roots.includes(home)) roots.push(home);
  for (const name of LEGACY_SESSIONS_DIR_NAMES) {
    for (const root of roots) {
      if (!root) continue;
      const prefix = `${root}/${name}/`;
      if (!p.startsWith(prefix)) continue;
      const remapped = `${active}/${p.slice(prefix.length)}`;
      if (remapped !== p && !existsSync(p) && existsSync(remapped))
        return remapped;
      return p;
    }
  }
  return p;
}

/**
 * Native Open Session session ids are minted as `os-<uuidv7>`. Sessions
 * created before the 2026-08-05 rename carry the original `bks-` prefix —
 * ids are opaque keys into persisted state and external links, so they are
 * never rewritten. This is the ONLY place code may care about the prefix;
 * everything else treats session ids as opaque strings.
 */
export function isNativeSessionId(id: string): boolean {
  return id.startsWith("os-") || id.startsWith("bks-");
}

/** A client-minted native id that can safely name an optimistic session. */
export function isClientSessionId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    /^os-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  );
}

/** Mint a native session id. */
export function newSessionId(): string {
  return `os-${randomUUIDv7()}`;
}
