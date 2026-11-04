/**
 * Connection status + management for the MCP servers agent sessions
 * run with (mcp-config.json). Targets are sanitized — never expose URL
 * query strings (they can embed tokens) or env values.
 */
import { homeDir } from "./paths";
import { unwatchFile, watchFile } from "fs";
import { copyFile, readFile, stat } from "fs/promises";
import { writeFileAtomicAsync } from "./shared/atomic-write";
import {
  cachedJsonFileShared,
  loadJsonFileShared,
} from "./shared/json-file-cache";
import { configuredPaths } from "./config";
import { resolveTeammate } from "./shared/user-mappings";
import {
  isOauthCapable,
  mcpOauthStatus,
  mcpSharedGrantHeader,
  mcpUserGrantHeader,
  mcpUserGrantToken,
  oauthPresetFor,
  supportsManualToken,
} from "./mcp-oauth";

const HOME = homeDir();

// Cache the parsed MCP config with file-watcher invalidation. Resolve the path
// per access so a live config reload cannot retain the watcher or cached value
// for a previously configured path.
let cachedMcpConfig: { mcpServers: Record<string, any> } | null = null;
let cachedMcpConfigPath: string | null = null;
let watchedMcpConfigPath: string | null = null;

function setupCacheWatcher(configPath: string) {
  if (watchedMcpConfigPath === configPath) return;
  if (watchedMcpConfigPath) unwatchFile(watchedMcpConfigPath);
  watchedMcpConfigPath = configPath;
  try {
    watchFile(configPath, () => {
      console.log("[mcp-cache] config changed, reloading");
      void loadMcpConfig(configPath);
    });
  } catch (e) {
    watchedMcpConfigPath = null;
    console.warn("[mcp-cache] failed to set up file watcher:", e);
  }
}

// Bumped by every local write, so a disk read that started before the write
// cannot replace the newer in-memory config when it lands.
let mcpConfigRevision = 0;
// Writes run one at a time in call order, so the last one to land carries the
// latest config.
let mcpConfigWrite: Promise<unknown> = Promise.resolve();

/**
 * Read mcp-config.json into the cache readMcpConfig serves. Runs at import
 * and whenever the file watcher sees a change; a test that repoints or
 * rewrites the file awaits it before reading.
 */
export async function loadMcpConfig(
  configPath = configuredPaths().mcpConfig,
): Promise<void> {
  // A local write in flight is newer than whatever the file holds now, and
  // one that starts while this read runs makes the read stale (revision).
  const revision = mcpConfigRevision;
  await mcpConfigWrite;
  let config: { mcpServers: Record<string, any> };
  try {
    config = JSON.parse(await readFile(configPath, "utf-8")) as {
      mcpServers: Record<string, any>;
    };
  } catch {
    config = { mcpServers: {} };
  }
  // A newer local write, or a path that is no longer the configured one
  // (a watcher event for a previous path), must not replace the cache.
  if (revision !== mcpConfigRevision) return;
  if (configPath !== configuredPaths().mcpConfig) return;
  cachedMcpConfig = config;
  cachedMcpConfigPath = configPath;
}

/** The loaded MCP config, without I/O (see loadMcpConfig). A configured path
 * not loaded yet starts loading and reads as empty until it lands. */
export function readMcpConfig(): { mcpServers: Record<string, any> } {
  const configPath = configuredPaths().mcpConfig;
  setupCacheWatcher(configPath);
  if (cachedMcpConfig && cachedMcpConfigPath === configPath)
    return cachedMcpConfig;
  void loadMcpConfig(configPath);
  return { mcpServers: {} };
}

const LINEAR_AGENT_TOKENS_PATH = `${HOME}/.linear-agent-tokens.json`;

/**
 * Overlay credentials that rotate outside this process. Linear runs as the
 * bot via the linear-agent's OAuth token (actor=app, refreshed by
 * that service) so issues/comments attribute to the bot, not a person. When
 * the token file is missing or stale, the static header in mcp-config.json
 * (personal API key) applies instead. Read per run — never persisted back.
 */
export function withDynamicCredentials(
  servers: Record<string, any>,
  /** Grant identities in priority order (e.g. [session creator, prompter]);
   *  a bare string is treated as a one-element list. First personal grant
   *  wins, then the workspace grant. */
  user?: string | Array<string | undefined>,
): Record<string, any> {
  let out = servers;
  const linear = servers.linear;
  if (linear?.url?.includes("mcp.linear.app")) {
    try {
      // Rotated by the linear-agent service; loaded at import and refreshed
      // in the background, at most a second behind the file.
      const tokens: any = cachedJsonFileShared(LINEAR_AGENT_TOKENS_PATH);
      const t: any = Object.values(tokens)[0];
      if (
        t?.accessToken &&
        (!t.expiresAt || t.expiresAt > Date.now() + 60_000)
      ) {
        out = {
          ...out,
          linear: {
            ...linear,
            headers: {
              ...linear.headers,
              Authorization: `Bearer ${t.accessToken}`,
            },
          },
        };
      }
    } catch {}
  }
  // OAuth-connected HTTP servers (src/server/mcp-oauth.ts): inject the run
  // user's own grant first (per-user MCP identity), else the shared grant.
  // Servers with a static Authorization header keep it unless a grant exists.
  try {
    for (const [name, cfg] of Object.entries(out)) {
      if (!cfg || typeof cfg !== "object") continue;
      const c: any = cfg;
      const isHttp = c.type === "http" || c.type === "sse" || !!c.url;
      if (!isHttp) {
        // Stdio servers with a preset OAuth (slack): inject the grant token
        // as the preset's env var (creator-first order) and name the person
        // the run acts for. Slack still posts as its bot: the grant only
        // widens reads, and the person is credited with a "via" line.
        const preset = oauthPresetFor(name);
        if (preset?.envVar && c.command) {
          const candidates = (Array.isArray(user) ? user : [user]).filter(
            (u): u is string => !!u,
          );
          const token =
            candidates
              .map((u) => mcpUserGrantToken(name, u))
              .find((t) => !!t) ??
            mcpSharedGrantHeader(name)?.replace(/^Bearer\s+/i, "");
          const sender = preset.senderEnvVar && candidates[0];
          if (token || sender)
            out = {
              ...out,
              [name]: {
                ...c,
                env: {
                  ...c.env,
                  ...(token ? { [preset.envVar]: token } : {}),
                  ...(sender
                    ? {
                        [preset.senderEnvVar!]:
                          resolveTeammate(sender)?.slackId || sender,
                      }
                    : {}),
                },
              },
            };
        }
        continue;
      }
      const candidates = (Array.isArray(user) ? user : [user]).filter(
        (u): u is string => !!u,
      );
      const header =
        candidates.map((u) => mcpUserGrantHeader(name, u)).find((h) => !!h) ??
        mcpSharedGrantHeader(name);
      if (!header) continue;
      out = {
        ...out,
        [name]: { ...c, headers: { ...c.headers, Authorization: header } },
      };
    }
  } catch (e) {
    console.error("[connections] mcp-oauth header injection failed:", e);
  }
  return out;
}

function writeMcpConfig(config: {
  mcpServers: Record<string, any>;
}): Promise<void> {
  const configPath = configuredPaths().mcpConfig;
  mcpConfigRevision++;
  cachedMcpConfig = config;
  cachedMcpConfigPath = configPath;
  cache = null;
  const run = mcpConfigWrite.then(async () => {
    // Keep one backup so a bad edit is always recoverable
    try {
      await copyFile(configPath, `${configPath}.bak`);
    } catch {}
    await writeFileAtomicAsync(
      configPath,
      JSON.stringify(config, null, 2) + "\n",
    );
  });
  mcpConfigWrite = run.catch(() => {});
  return run;
}

export interface AddMcpInput {
  name: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Optional per-user allowlist. When set (non-empty), only sessions whose user
   * resolves (via user-mappings) to one of these people get this server's tools;
   * everyone else's runs never see it. Omitted/empty = available to every
   * session (the default). Entries can be first names, full names, emails,
   * GitHub logins, or Slack ids — matched by userMatchesAny.
   */
  allowedUsers?: string[];
}

/** Normalize an allowedUsers list: trim, drop blanks, dedupe. */
function cleanAllowedUsers(users?: string[]): string[] | undefined {
  if (!Array.isArray(users)) return undefined;
  const out = Array.from(
    new Set(users.map((u) => (u || "").trim()).filter(Boolean)),
  );
  return out.length ? out : undefined;
}

/** Credentialed first-party release tools must never become fleet-wide. */
export function requiresAllowedUsers(name: string): boolean {
  return name.trim().toLowerCase() === "apple-release";
}

export function hasValidRequiredAllowedUsers(
  value: unknown,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((user) => typeof user === "string" && Boolean(user.trim()))
  );
}

export async function addMcpServer(
  input: AddMcpInput,
): Promise<{ ok: true } | { error: string }> {
  const name = (input.name || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(name)) {
    return { error: "Name must be alphanumeric (dashes/underscores allowed)" };
  }

  const allowedUsers = cleanAllowedUsers(input.allowedUsers);
  if (requiresAllowedUsers(name) && !allowedUsers) {
    return {
      error: 'Server "apple-release" requires at least one allowed user',
    };
  }

  const config = readMcpConfig();
  if (config.mcpServers[name]) {
    return { error: `Server "${name}" already exists — remove it first` };
  }

  let entry: any;
  if (input.transport === "http") {
    let parsed: URL;
    try {
      parsed = new URL(input.url || "");
    } catch {
      return { error: "Invalid URL" };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { error: "URL must be http(s)" };
    }
    entry = { type: "http", url: input.url };
  } else {
    const command = (input.command || "").trim();
    if (!command) return { error: "Command is required for stdio servers" };
    entry = { command };
    const args = (input.args || []).map((a) => a.trim()).filter(Boolean);
    if (args.length > 0) entry.args = args;
    const env = input.env || {};
    if (Object.keys(env).length > 0) entry.env = env;
  }

  if (allowedUsers) entry.allowedUsers = allowedUsers;

  config.mcpServers[name] = entry;
  await writeMcpConfig(config);
  return { ok: true };
}

/**
 * Install a server entry that is already an entry: the installable-package
 * path (src/server/plugins.ts, scripts/lib/plugins.ts).
 *
 * `addMcpServer` above is the Connections FORM: it builds the entry from
 * typed fields and deliberately drops anything it was not asked for, headers
 * included. A package's entry arrives whole and has already been validated to
 * carry credential REFERENCES (`${NAME}`) rather than values, so it is
 * written through as-is. `allowedUsers` is the installing operator's call and
 * never the package's, so any allowlist on the incoming entry is discarded in
 * favour of the one passed here.
 */
export async function addMcpServerEntry(
  name: string,
  entry: Record<string, unknown>,
  opts: { allowedUsers?: string[] } = {},
): Promise<{ ok: true } | { error: string }> {
  const clean = (name || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(clean)) {
    return { error: "Name must be alphanumeric (dashes/underscores allowed)" };
  }
  const allowedUsers = cleanAllowedUsers(opts.allowedUsers);
  if (requiresAllowedUsers(clean) && !allowedUsers) {
    return {
      error: 'Server "apple-release" requires at least one allowed user',
    };
  }
  const config = readMcpConfig();
  if (config.mcpServers[clean]) {
    return { error: `Server "${clean}" already exists, remove it first` };
  }
  const { allowedUsers: _ignored, ...rest } = entry;
  config.mcpServers[clean] = allowedUsers ? { ...rest, allowedUsers } : rest;
  await writeMcpConfig(config);
  return { ok: true };
}

/**
 * Set (or clear, with an empty/undefined list) the per-user allowlist on an
 * existing MCP server. Lets you restrict a server after it's been added — e.g.
 * lock a sensitive server down to specific teammates — without re-entering its secrets.
 */
export async function setMcpAllowedUsers(
  name: string,
  allowedUsers?: string[],
): Promise<{ ok: true; allowedUsers?: string[] } | { error: string }> {
  const config = readMcpConfig();
  const entry = config.mcpServers[name];
  if (!entry) return { error: `Server "${name}" not found` };
  const cleaned = cleanAllowedUsers(allowedUsers);
  if (requiresAllowedUsers(name) && !cleaned) {
    return {
      error: 'Server "apple-release" requires at least one allowed user',
    };
  }
  if (cleaned) entry.allowedUsers = cleaned;
  else delete entry.allowedUsers;
  await writeMcpConfig(config);
  return { ok: true, allowedUsers: cleaned };
}

export async function replaceMcpServerEntries(
  updates: Record<string, Record<string, unknown> | undefined>,
): Promise<{ ok: true } | { error: string }> {
  const config = readMcpConfig();
  for (const [name, entry] of Object.entries(updates)) {
    const allowedUsers = cleanAllowedUsers(
      Array.isArray(entry?.allowedUsers)
        ? (entry.allowedUsers as string[])
        : undefined,
    );
    if (entry && requiresAllowedUsers(name) && !allowedUsers) {
      return {
        error: `Server "${name}" requires at least one allowed user`,
      };
    }
  }
  for (const [name, entry] of Object.entries(updates)) {
    if (entry) config.mcpServers[name] = entry;
    else delete config.mcpServers[name];
  }
  await writeMcpConfig(config);
  return { ok: true };
}

export async function removeMcpServer(
  name: string,
): Promise<{ ok: true } | { error: string }> {
  const config = readMcpConfig();
  if (!config.mcpServers[name]) return { error: `Server "${name}" not found` };
  delete config.mcpServers[name];
  await writeMcpConfig(config);
  return { ok: true };
}

export interface McpConnection {
  name: string;
  transport: "http" | "stdio";
  target: string; // sanitized: origin+path for http, command for stdio
  envKeys: string[];
  status:
    | "connected"
    | "ready"
    | "needs-env"
    | "needs-auth"
    | "unreachable"
    | "missing";
  detail?: string;
  /** Per-user allowlist, if this server is restricted (empty/absent = everyone). */
  allowedUsers?: string[];
}

let cache: { data: McpConnection[]; ts: number } | null = null;
const TTL = 60_000;

export async function getConnections(force = false): Promise<McpConnection[]> {
  if (!force && cache && Date.now() - cache.ts < TTL) return cache.data;

  const servers = readMcpConfig().mcpServers;
  const results = await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      const conn = await checkServer(name, cfg);
      const allowedUsers = cleanAllowedUsers(cfg?.allowedUsers);
      if (allowedUsers) conn.allowedUsers = allowedUsers;
      return conn;
    }),
  );

  cache = { data: results, ts: Date.now() };
  return results;
}

async function checkServer(name: string, cfg: any): Promise<McpConnection> {
  const isHttp = cfg.type === "http" || cfg.type === "sse" || !!cfg.url;

  if (isHttp) {
    let target = cfg.url || "";
    try {
      const u = new URL(cfg.url);
      target = `${u.origin}${u.pathname}`;
    } catch {}

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      // Any HTTP response (incl. 401/405) means the endpoint is up;
      // MCP servers typically reject bare GETs but still answer.
      const res = await fetch(cfg.url, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timer);
      // Reachable, but an OAuth-protected server with no grant and no static
      // Authorization header isn't usable yet — surface "Sign in required"
      // instead of a misleading "Connected" (the GET's 401/405 only proves
      // the endpoint is up). Use the same resource discovery as Connect.
      if (!cfg.headers?.Authorization) {
        try {
          const st = mcpOauthStatus(name);
          if (!st.shared && st.users.length === 0) {
            if (supportsManualToken(name)) {
              return {
                name,
                transport: "http",
                target,
                envKeys: Object.keys(cfg.env || {}),
                status: "needs-auth",
                detail: "API token required. Connect from this card's menu",
              };
            }
            if (await isOauthCapable(cfg.url)) {
              return {
                name,
                transport: "http",
                target,
                envKeys: Object.keys(cfg.env || {}),
                status: "needs-auth",
                detail:
                  "OAuth sign-in required — Connect from this card's menu",
              };
            }
          }
        } catch {}
      }
      return {
        name,
        transport: "http",
        target,
        envKeys: Object.keys(cfg.env || {}),
        status: "connected",
        detail: `HTTP ${res.status}`,
      };
    } catch (e: any) {
      return {
        name,
        transport: "http",
        target,
        envKeys: Object.keys(cfg.env || {}),
        status: "unreachable",
        detail:
          e.name === "AbortError"
            ? "timeout"
            : (e.message || "fetch failed").slice(0, 80),
      };
    }
  }

  // stdio: verify the executable / script exists and required env is present
  const command: string = cfg.command || "";
  const args: string[] = cfg.args || [];
  const envKeys = Object.keys(cfg.env || {});
  const target = [command, ...args].join(" ");

  // Resolve what must exist on disk: absolute command, or first absolute arg
  // (covers "bun run /path/to/script.ts")
  const pathsToCheck = [command, ...args].filter((p) => p.startsWith("/"));
  const exists = await Promise.all(
    pathsToCheck.map((p) =>
      stat(p).then(
        () => true,
        () => false,
      ),
    ),
  );
  const missing = pathsToCheck.find((_, i) => !exists[i]);
  if (missing) {
    return {
      name,
      transport: "stdio",
      target,
      envKeys,
      status: "missing",
      detail: `not found: ${missing}`,
    };
  }

  const missingEnv = envKeys.filter((k) => {
    const v = cfg.env?.[k];
    // Values like "${PLAIN_API_KEY}" or empty mean: must come from process env
    const isRef = typeof v === "string" && (v === "" || v.includes("${"));
    return isRef ? !process.env[k] : false;
  });
  if (missingEnv.length > 0) {
    return {
      name,
      transport: "stdio",
      target,
      envKeys,
      status: "needs-env",
      detail: `missing: ${missingEnv.join(", ")}`,
    };
  }

  return { name, transport: "stdio", target, envKeys, status: "ready" };
}

await Promise.all([
  loadMcpConfig(),
  loadJsonFileShared(LINEAR_AGENT_TOKENS_PATH).catch(() => undefined),
]);
