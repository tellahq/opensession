/**
 * Connection status + management for the MCP servers agent sessions
 * run with (mcp-config.json). Targets are sanitized — never expose URL
 * query strings (they can embed tokens) or env values.
 */
import { homeDir } from "./paths";
import { existsSync, readFileSync, copyFileSync, watchFile } from "fs";
import { writeFileAtomic } from "./shared/atomic-write";
import { configuredPaths } from "./config";
import { mcpOauthStatus, mcpSharedGrantHeader, mcpUserGrantHeader, mcpUserGrantToken, oauthPresetFor } from "./mcp-oauth";
import { resolveTeammate } from "./shared/user-mappings";

const HOME = homeDir();
// mcp-config.json location. OPENSESSION_MCP_CONFIG env → config
// `paths.mcpConfig` → this repo's checkout — unchanged when neither is set.
const CONFIG_PATH = configuredPaths().mcpConfig;

// Cache the parsed MCP config with file-watcher invalidation
let cachedMcpConfig: { mcpServers: Record<string, any> } | null = null;
let cacheWatcherSetUp = false;

function setupCacheWatcher() {
  if (cacheWatcherSetUp) return;
  cacheWatcherSetUp = true;
  try {
    watchFile(CONFIG_PATH, () => {
      cachedMcpConfig = null;
      console.log("[mcp-cache] config changed, invalidating cache");
    });
  } catch (e) {
    console.warn("[mcp-cache] failed to set up file watcher:", e);
  }
}

export function readMcpConfig(): { mcpServers: Record<string, any> } {
  if (!cacheWatcherSetUp) setupCacheWatcher();
  if (cachedMcpConfig) return cachedMcpConfig;

  try {
    cachedMcpConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as {
      mcpServers: Record<string, any>;
    };
  } catch {
    cachedMcpConfig = { mcpServers: {} };
  }
  return cachedMcpConfig;
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
      const tokens = JSON.parse(readFileSync(LINEAR_AGENT_TOKENS_PATH, "utf-8"));
      const t: any = Object.values(tokens)[0];
      if (t?.accessToken && (!t.expiresAt || t.expiresAt > Date.now() + 60_000)) {
        out = {
          ...out,
          linear: {
            ...linear,
            headers: { ...linear.headers, Authorization: `Bearer ${t.accessToken}` },
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
        // as the preset's env var — the run then acts AS THE PERSON
        // (creator-first order), falling back to the static bot token.
        const preset = oauthPresetFor(name);
        if (preset?.envVar && c.command) {
          const candidates = (Array.isArray(user) ? user : [user]).filter(
            (u): u is string => !!u,
          );
          const personal = candidates
            .map((identity) => ({
              identity,
              token: mcpUserGrantToken(name, identity),
            }))
            .find(({ token }) => !!token);
          const token =
            personal?.token ??
            mcpSharedGrantHeader(name)?.replace(/^Bearer\s+/i, "");
          const actorIdentity = personal?.identity ?? candidates[0];
          const actor = actorIdentity
            ? resolveTeammate(actorIdentity)?.name ?? actorIdentity
            : undefined;
          const attributionEnv =
            name === "slack" && actor
              ? {
                  OPENSESSION_SLACK_ACTOR: actor,
                  OPENSESSION_SLACK_PERSONAL: personal ? "1" : "0",
                }
              : {};
          if (token || Object.keys(attributionEnv).length)
            out = {
              ...out,
              [name]: {
                ...c,
                env: {
                  ...c.env,
                  ...(token ? { [preset.envVar]: token } : {}),
                  ...attributionEnv,
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
        candidates
          .map((u) => mcpUserGrantHeader(name, u))
          .find((h) => !!h) ?? mcpSharedGrantHeader(name);
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

function writeMcpConfig(config: { mcpServers: Record<string, any> }): void {
  // Keep one backup so a bad edit is always recoverable
  try {
    copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
  } catch {}
  writeFileAtomic(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  cache = null;
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
    new Set(users.map((u) => (u || "").trim()).filter(Boolean))
  );
  return out.length ? out : undefined;
}

export function addMcpServer(input: AddMcpInput): { ok: true } | { error: string } {
  const name = (input.name || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(name)) {
    return { error: "Name must be alphanumeric (dashes/underscores allowed)" };
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

  const allowedUsers = cleanAllowedUsers(input.allowedUsers);
  if (allowedUsers) entry.allowedUsers = allowedUsers;

  config.mcpServers[name] = entry;
  writeMcpConfig(config);
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
export function addMcpServerEntry(
  name: string,
  entry: Record<string, unknown>,
  opts: { allowedUsers?: string[] } = {}
): { ok: true } | { error: string } {
  const clean = (name || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(clean)) {
    return { error: "Name must be alphanumeric (dashes/underscores allowed)" };
  }
  const config = readMcpConfig();
  if (config.mcpServers[clean]) {
    return { error: `Server "${clean}" already exists, remove it first` };
  }
  const { allowedUsers: _ignored, ...rest } = entry;
  const allowedUsers = cleanAllowedUsers(opts.allowedUsers);
  config.mcpServers[clean] = allowedUsers ? { ...rest, allowedUsers } : rest;
  writeMcpConfig(config);
  return { ok: true };
}

/**
 * Set (or clear, with an empty/undefined list) the per-user allowlist on an
 * existing MCP server. Lets you restrict a server after it's been added — e.g.
 * lock a sensitive server down to specific teammates — without re-entering its secrets.
 */
export function setMcpAllowedUsers(
  name: string,
  allowedUsers?: string[]
): { ok: true; allowedUsers?: string[] } | { error: string } {
  const config = readMcpConfig();
  const entry = config.mcpServers[name];
  if (!entry) return { error: `Server "${name}" not found` };
  const cleaned = cleanAllowedUsers(allowedUsers);
  if (cleaned) entry.allowedUsers = cleaned;
  else delete entry.allowedUsers;
  writeMcpConfig(config);
  return { ok: true, allowedUsers: cleaned };
}

export function removeMcpServer(name: string): { ok: true } | { error: string } {
  const config = readMcpConfig();
  if (!config.mcpServers[name]) return { error: `Server "${name}" not found` };
  delete config.mcpServers[name];
  writeMcpConfig(config);
  return { ok: true };
}

export interface McpConnection {
  name: string;
  transport: "http" | "stdio";
  target: string; // sanitized: origin+path for http, command for stdio
  envKeys: string[];
  status: "connected" | "ready" | "needs-env" | "needs-auth" | "unreachable" | "missing";
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
    })
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
      const res = await fetch(cfg.url, { method: "GET", signal: controller.signal });
      clearTimeout(timer);
      // Reachable, but an OAuth-protected server with no grant and no static
      // Authorization header isn't usable yet — surface "Sign in required"
      // instead of a misleading "Connected" (the GET's 401/405 only proves
      // the endpoint is up). Detection = the origin publishes RFC 9728
      // protected-resource metadata.
      if (!cfg.headers?.Authorization) {
        try {
          const st = mcpOauthStatus(name);
          if (!st.shared && st.users.length === 0) {
            const pr = await fetch(
              `${new URL(cfg.url).origin}/.well-known/oauth-protected-resource`,
              { signal: AbortSignal.timeout(3000) },
            );
            if (pr.ok) {
              return {
                name,
                transport: "http",
                target,
                envKeys: Object.keys(cfg.env || {}),
                status: "needs-auth",
                detail: "OAuth sign-in required — Connect from this card's menu",
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
        detail: e.name === "AbortError" ? "timeout" : (e.message || "fetch failed").slice(0, 80),
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
  const missing = pathsToCheck.find((p) => !existsSync(p));
  if (missing) {
    return { name, transport: "stdio", target, envKeys, status: "missing", detail: `not found: ${missing}` };
  }

  const missingEnv = envKeys.filter((k) => {
    const v = cfg.env?.[k];
    // Values like "${PLAIN_API_KEY}" or empty mean: must come from process env
    const isRef = typeof v === "string" && (v === "" || v.includes("${"));
    return isRef ? !process.env[k] : false;
  });
  if (missingEnv.length > 0) {
    return {
      name, transport: "stdio", target, envKeys,
      status: "needs-env",
      detail: `missing: ${missingEnv.join(", ")}`,
    };
  }

  return { name, transport: "stdio", target, envKeys, status: "ready" };
}
