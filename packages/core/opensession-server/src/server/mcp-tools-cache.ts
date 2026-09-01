/**
 * Per-config MCP tool-catalog cache.
 *
 * MCP has no offline discovery: `tools/list` needs a live connection, so
 * building a run's tool surface connected EVERY resolved server — spawning a
 * stdio child or dialling an HTTP endpoint for all of them, on every turn,
 * whether or not the model went on to touch one. This caches each external
 * server's raw `tools/list` output, keyed on a hash of that server's own
 * config entry, so a warm server contributes its tools with no connection at
 * all and the connect moves to first real use (the bridge's per-tool
 * `ensure()` was always lazy, so that half needed no change).
 *
 * This is the item pi-mcp-bridge.ts's own doc deferred out of v1 ("the
 * 'unused stdio servers never spawn' ideal is unreachable while the tool
 * catalog must exist up front; per-config catalog caching would fix it").
 *
 * Deliberate scope and invariants:
 *  - EXTERNAL servers only. In-process servers connect over an
 *    InMemoryTransport inside this process, so listing them costs a function
 *    call; caching those would buy nothing and add staleness across deploys.
 *  - The cache stores RAW upstream output. Every policy filter
 *    (filterMcpServers before the entry is even offered here, isDeniedTool
 *    after) still runs on each build, so a cached entry can never widen what
 *    a run may see. This is a latency cache, never an access grant.
 *  - Keyed on the config entry, so editing a server's command/args/env/url
 *    invalidates it at once. A TTL bounds drift for a server that changed
 *    its own tool list without a config change.
 *  - A stale entry costs a bad CALL, never a bad turn: a tool that vanished
 *    upstream throws from that one call (the bridge already degrades a dead
 *    server to absent tools rather than a failed turn), and the entry is
 *    rewritten the next time that server is listed for real.
 *  - Concurrent runs share one file. Writes are atomic (rename), so a reader
 *    never sees a torn file; two runs racing can lose one update, which
 *    costs exactly one re-list. Not worth a lock.
 *
 * Kill switch: OPENSESSION_MCP_TOOLS_CACHE=0 restores connect-on-build.
 */
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";

export interface CachedToolCatalog {
  /** Hash of the config entry this listing was taken under. */
  hash: string;
  /** Raw `tools/list` output, exactly as the server returned it. */
  tools: Array<Record<string, unknown>>;
  /** Epoch ms the listing was taken. */
  at: number;
}

interface CacheFile {
  version: number;
  servers: Record<string, CachedToolCatalog>;
}

const VERSION = 1;
/** Bounds drift for a server that changes its tools without a config change. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Tool descriptions are not secret, but the file is ours alone. */
const FILE_MODE = 0o600;

/** Resolved PER CALL: statePath reads the env when asked, so a test pointing
 *  OPENSESSION_STATE_DIR at a scratch dir is actually isolated (a module-load
 *  constant here would pin whichever test imported this file first). */
function cachePath(): string {
  return stateDir("mcp-tools-cache.json");
}

export function toolsCacheEnabled(): boolean {
  return process.env.OPENSESSION_MCP_TOOLS_CACHE !== "0";
}

/** Stable stringify — object keys sorted at every depth, so a config entry
 *  differing only in key order hashes the same. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

/** Cache key for one server's config entry (command/args/env/url/headers…). */
export function toolsCacheKey(cfg: unknown): string {
  return createHash("sha256").update(stable(cfg)).digest("hex").slice(0, 32);
}

function readFile(): CacheFile {
  try {
    const path = cachePath();
    if (!existsSync(path)) return { version: VERSION, servers: {} };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile | null;
    if (
      !parsed ||
      parsed.version !== VERSION ||
      typeof parsed.servers !== "object"
    ) {
      return { version: VERSION, servers: {} };
    }
    return { version: VERSION, servers: parsed.servers ?? {} };
  } catch {
    // A corrupt or unreadable cache is a cold cache, never an error.
    return { version: VERSION, servers: {} };
  }
}

/**
 * The cached listing for `server` if one was taken under this exact config
 * hash and is still inside the TTL. Undefined means "connect and list".
 */
export function readCachedTools(
  server: string,
  hash: string,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
): Array<Record<string, unknown>> | undefined {
  if (!toolsCacheEnabled()) return undefined;
  const entry = readFile().servers[server];
  if (!entry || entry.hash !== hash || !Array.isArray(entry.tools))
    return undefined;
  if (!Number.isFinite(entry.at) || now - entry.at > ttlMs) return undefined;
  // A server that legitimately exposes no tools would re-list every build;
  // that is one cheap connect against never trusting an empty listing.
  return entry.tools.length ? entry.tools : undefined;
}

/** Record a fresh listing. No-op when nothing changed, to keep parallel runs
 *  from rewriting the file on every turn. */
export function writeCachedTools(
  server: string,
  hash: string,
  tools: Array<Record<string, unknown>>,
  now = Date.now(),
): void {
  if (!toolsCacheEnabled() || !Array.isArray(tools) || !tools.length) return;
  try {
    const file = readFile();
    const prev = file.servers[server];
    if (prev?.hash === hash && stable(prev.tools) === stable(tools)) {
      // Same listing under the same config: only the timestamp would move,
      // and refreshing it is what keeps a live server from expiring.
      if (now - prev.at < DEFAULT_TTL_MS / 4) return;
    }
    file.servers[server] = { hash, tools, at: now };
    writeJsonAtomic(cachePath(), file, true, FILE_MODE);
  } catch {
    // Caching is an optimization; a failed write must never fail a run.
  }
}

/** Drop one server's entry (or the whole cache when no server is named). */
export function forgetCachedTools(server?: string): void {
  try {
    const file = readFile();
    if (server) delete file.servers[server];
    else file.servers = {};
    writeJsonAtomic(cachePath(), file, true, FILE_MODE);
  } catch {}
}
