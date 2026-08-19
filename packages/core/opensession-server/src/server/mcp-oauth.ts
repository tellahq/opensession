/**
 * Browser-based OAuth for HTTP MCP servers (the feeds design — "easy to
 * connect any MCP, per user as well").
 *
 * Replaces the unusable headless flow (opencode's CLI OAuth listens on the
 * VPS's 127.0.0.1, unreachable from the user's browser): Open Session runs the
 * OAuth 2.1 + PKCE flow itself with a redirect to
 * `<publicBaseUrl>/api/connections/mcp-oauth/callback`, so a
 * Connect button works from any signed-in device (iPhone PWA included).
 *
 * Grants are encrypted per server in ~/.opensession-mcp-oauth.json (0600):
 * one optional `shared` grant (workspace-wide identity, like the Linear/Plain
 * servers today) and per-user grants keyed by canonical team name (same
 * identity table as commit attribution — the github-auth.ts pattern). At run
 * time server-side MCP proxies resolve the run user's own grant when they have
 * one, else the shared grant. Provider tokens never enter an engine config or
 * environment; rotation happens here (lazy kick + 2-min ticker parked on
 * globalThis, refresh-on-first-use).
 *
 * Discovery follows the MCP auth spec: RFC 9728 protected-resource metadata
 * on the server origin → authorization server → RFC 8414 AS metadata →
 * dynamic client registration (RFC 7591, token_endpoint_auth_method "none").
 */
import { readFileSync, writeFileSync, existsSync, rmSync, openSync, closeSync } from "fs";
import { randomBytes, createHash, createCipheriv, createDecipheriv } from "crypto";
import { configuredPaths, configuredServer, productName } from "./config";
import { statePath } from "./paths";
import { resolveTeammate } from "./shared/user-mappings";
import { writeFileAtomic } from "./shared/atomic-write";
import { audit } from "./audit";

const STORE_NAME = ".opensession-mcp-oauth.json";
const KEY_NAME = ".opensession-mcp-oauth.key";
const STORE_AAD = "opensession:mcp-oauth:v2";

interface EncryptedStore {
  version: 2;
  algorithm: "aes-256-gcm";
  nonce: string;
  tag: string;
  ciphertext: string;
}

function storePath(): string {
  return statePath(STORE_NAME);
}

/** Where the store's key comes from, in preference order.
 *
 *  1. A systemd credential (`LoadCredential=mcp-oauth-key`), when an operator
 *     has set one up. PID 1 puts it in the unit's private mount, so it is not
 *     in the filesystem the way the key file below is.
 *  2. A 0600 key file beside the store, minted on first use.
 *
 *  (2) is what a rootless install gets, and it is deliberately not sold as
 *  more than it is: it means the STORE is ciphertext at rest, which is what
 *  keeps tokens out of backups, snapshots, syncs and a stray copy of the file,
 *  and it is the substrate a per-use broker would sit on later. It is NOT a
 *  boundary against a process already running as this user, which can read the
 *  key exactly as the server does. Closing that needs a second uid, which
 *  needs root, which most installs deliberately do not have. See
 *  docs/security-model.md. */
function encryptionKey(): Buffer {
  const credentialDir = process.env.CREDENTIALS_DIRECTORY;
  if (credentialDir) {
    try {
      const key = readFileSync(`${credentialDir}/mcp-oauth-key`);
      if (key.length === 32) return key;
      throw new Error(
        "The mcp-oauth-key credential has an invalid length; expected 32 bytes.",
      );
    } catch (error) {
      // A credential directory without OUR credential in it is the ordinary
      // case on a host that mounts some other credential, so fall through to
      // the key file rather than failing the whole feature.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
  const path = statePath(KEY_NAME);
  try {
    const key = readFileSync(path);
    if (key.length !== 32) {
      throw new Error(
        `The personal MCP encryption key at ${path} has an invalid length. ` +
          "Move it aside and reconnect the affected tools to mint a new one.",
      );
    }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  // First use: mint one. `wx` so two racing writers cannot each mint a key and
  // leave the store encrypted under whichever lost, and 0600 from the open
  // rather than a later chmod, so it is never briefly world-readable.
  const key = randomBytes(32);
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, key);
    } finally {
      closeSync(fd);
    }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      return readFileSync(path);
    }
    throw error;
  }
}

function isEncryptedStore(value: unknown): value is EncryptedStore {
  const v = value as Partial<EncryptedStore> | null;
  return (
    !!v &&
    v.version === 2 &&
    v.algorithm === "aes-256-gcm" &&
    typeof v.nonce === "string" &&
    typeof v.tag === "string" &&
    typeof v.ciphertext === "string"
  );
}

function encryptStore(store: Store): EncryptedStore {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(STORE_AAD));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(store), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 2,
    algorithm: "aes-256-gcm",
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptStore(envelope: EncryptedStore): Store {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(envelope.nonce, "base64"),
    );
    decipher.setAAD(Buffer.from(STORE_AAD));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as Store;
  } catch {
    throw new Error(
      "The personal MCP credential store could not be decrypted. " +
        "The encrypted file was left unchanged.",
    );
  }
}

interface OauthEndpoints {
  authorize: string;
  token: string;
  register?: string;
}

interface Grant {
  tokens: {
    accessToken: string;
    refreshToken?: string;
    /** ms epoch; absent = no known expiry. */
    expiresAt?: number;
  };
  updatedAt: string;
  /** Team member (or GitHub login fallback) who completed the flow. */
  connectedBy?: string;
}

interface ServerAuth {
  serverUrl: string;
  resource?: string;
  /** scopes_supported from RFC 9728 metadata — some ASes (Cognito, e.g.
   *  Plain's) reject unknown scopes, so the authorize request must stick to
   *  what the resource advertises. */
  scopes?: string[];
  endpoints: OauthEndpoints;
  clientInfo: { clientId: string };
  binding?: ServerBinding;
  shared?: Grant;
  users?: Record<string, Grant>;
}

type Store = Record<string, ServerAuth>;

type ServerBinding =
  | { kind: "http"; url: string }
  | {
      kind: "stdio";
      command: string;
      /** The command RESOLVED to an absolute path when the grant was issued.
       *  The configured name is usually bare ("bunx"), and the transport would
       *  otherwise resolve it through PATH at launch, which on a normal install
       *  runs through directories this user can write (~/.bun/bin, a checkout's
       *  node_modules/.bin). Shadowing the name there captures the token
       *  without touching mcp-config.json, so the pin has to be the path, and
       *  the launch has to use it rather than resolve again. */
      commandPath: string;
      args: string[];
      /** Canonicalized env. The transport runs the command THROUGH this env,
       *  so pinning only command+args leaves the execution hijackable: keep
       *  `command: "bun"` and point PATH at a workspace directory holding a
       *  replacement `bun`, and the replacement receives the decrypted token. */
      env: string;
    };

/** Stable string for an stdio server's env: sorted, so key order in the config
 *  file cannot change the binding, and every variable counts because any of
 *  them (PATH, NODE_OPTIONS, LD_PRELOAD, ...) can redirect the executable. */
function canonicalEnv(env: unknown): string {
  if (!env || typeof env !== "object" || Array.isArray(env)) return "";
  return JSON.stringify(
    Object.entries(env as Record<string, unknown>)
      .map(([k, v]) => [k, String(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** Absolute path for a configured stdio command, or undefined when it cannot
 *  be resolved. Absolute configured commands are taken as-is; a bare name is
 *  resolved once, here, so the answer is recorded rather than recomputed from
 *  whatever PATH the launch happens to inherit. */
function resolveCommandPath(command: string): string | undefined {
  if (command.startsWith("/")) return existsSync(command) ? command : undefined;
  // Pass PATH explicitly: Bun.which() otherwise reads the PATH captured at
  // process start, which would make the pin ignore the environment the server
  // is actually running with.
  return Bun.which(command, { PATH: process.env.PATH ?? "" }) ?? undefined;
}

function configuredBinding(name: string): ServerBinding | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(configuredPaths().mcpConfig, "utf8"),
    ) as { mcpServers?: Record<string, Record<string, unknown>> };
    const cfg = parsed.mcpServers?.[name];
    if (!cfg) return undefined;
    if (typeof cfg.url === "string") {
      return { kind: "http", url: new URL(cfg.url).toString() };
    }
    if (typeof cfg.command === "string") {
      const resolved = resolveCommandPath(cfg.command);
      if (!resolved) return undefined;
      return {
        kind: "stdio",
        command: cfg.command,
        commandPath: resolved,
        args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
        env: canonicalEnv(cfg.env),
      };
    }
  } catch {}
  return undefined;
}

/**
 * Which grant slot on a ServerAuth we're talking about: the workspace-wide
 * one, or one team member's. Addressing a slot by name only ("shared" vs a
 * team name in the same string) let a caller pair one identity's grant with
 * another identity's slot, so a refresh could write a token into a slot it
 * never read from. The union keeps the two together.
 */
type GrantSlot = { kind: "shared" } | { kind: "user"; teamName: string };

/** A grant plus the slot it was read from — the expiry decision and the
 *  refreshed token's destination can no longer disagree. */
type GrantRef = GrantSlot & { grant: Grant };

/** Team name from a pending flow: absent = the shared grant. */
function slotFor(teamName?: string): GrantSlot {
  return teamName ? { kind: "user", teamName } : { kind: "shared" };
}

function slotLabel(slot: GrantSlot): string {
  return slot.kind === "shared" ? "shared" : slot.teamName;
}

function grantRef(
  auth: ServerAuth | undefined,
  slot: GrantSlot,
): GrantRef | undefined {
  const grant =
    slot.kind === "shared" ? auth?.shared : auth?.users?.[slot.teamName];
  return grant ? { ...slot, grant } : undefined;
}

function writeGrant(entry: ServerAuth, slot: GrantSlot, grant: Grant): void {
  if (slot.kind === "shared") entry.shared = grant;
  else entry.users = { ...(entry.users || {}), [slot.teamName]: grant };
}

function readStore(): Store {
  if (process.env.OPENSESSION_PERSONAL_MCP === "0") {
    throw new Error("Personal MCP connections are disabled by the operator.");
  }
  purgeLegacyRelayStore();
  const path = storePath();
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(
      "The personal MCP credential store is unreadable. It was left unchanged.",
    );
  }
  if (isEncryptedStore(parsed)) return decryptStore(parsed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The legacy personal MCP credential store has an invalid shape.");
  }

  // One-way migration: the first read after the protected system credential is
  // installed atomically replaces the plaintext v1 document with ciphertext.
  const legacy = parsed as Store;
  for (const [name, auth] of Object.entries(legacy)) {
    auth.binding ||= configuredBinding(name);
  }
  writeStore(legacy);
  audit({
    kind: "mcp_oauth_store_migrated",
    server_count: Object.keys(legacy).length,
  });
  return legacy;
}

function tryReadStore(): Store {
  if (process.env.OPENSESSION_PERSONAL_MCP === "0") return {};
  const g = globalThis as any;
  const path = storePath();
  try {
    const store = readStore();
    (g.__osMcpOauthReadFailures as Set<string> | undefined)?.delete(path);
    return store;
  } catch {
    const warned: Set<string> = (g.__osMcpOauthReadFailures ??= new Set<string>());
    if (!warned.has(path)) {
      warned.add(path);
      console.warn(
        "[mcp-oauth] personal connections are unavailable; the encrypted store was left unchanged",
      );
      audit({ kind: "mcp_oauth_store_unavailable" });
    }
    return {};
  }
}

/** The absolute executable a granted stdio server is pinned to. The proxy
 *  launches THIS rather than the configured name, so PATH cannot decide which
 *  binary receives the token. */
export function mcpOauthStdioCommand(name: string): string | undefined {
  const stored = tryReadStore()[name]?.binding;
  return stored?.kind === "stdio" ? stored.commandPath : undefined;
}

export function mcpOauthBindingMatches(
  name: string,
  cfg: Record<string, unknown>,
): boolean {
  const stored = tryReadStore()[name]?.binding;
  if (!stored) return false;
  if (stored.kind === "http") {
    if (typeof cfg.url !== "string") return false;
    try {
      return new URL(cfg.url).toString() === stored.url;
    } catch {
      return false;
    }
  }
  return (
    cfg.command === stored.command &&
    JSON.stringify(Array.isArray(cfg.args) ? cfg.args.map(String) : []) ===
      JSON.stringify(stored.args) &&
    // A binding written before env was pinned compares as an EMPTY env, so a
    // server that has since grown one fails closed and asks for a reconnect.
    // Accepting "unpinned means anything" would leave exactly the PATH-swap
    // this field exists to stop.
    canonicalEnv(cfg.env) === (stored.env ?? "") &&
    // A binding from before the path was pinned fails closed and asks for a
    // reconnect, rather than being trusted against a name PATH still resolves.
    !!stored.commandPath &&
    resolveCommandPath(String(cfg.command)) === stored.commandPath
  );
}

function purgeLegacyRelayStore(): void {
  const g = globalThis as any;
  const path = statePath(".opensession-mcp-relay.json");
  const purged: Set<string> = (g.__osMcpRelayPurged ??= new Set<string>());
  if (purged.has(path)) return;
  if (!existsSync(path)) {
    purged.add(path);
    return;
  }
  try {
    rmSync(path);
    purged.add(path);
    audit({ kind: "mcp_oauth_legacy_relays_revoked" });
  } catch {
    throw new Error("Legacy MCP relay capabilities could not be revoked.");
  }
}

function writeStore(store: Store): void {
  const envelope = encryptStore(store);
  writeFileAtomic(
    storePath(),
    JSON.stringify(envelope, null, 2) + "\n",
    0o600,
  );
}

/**
 * Preset OAuth providers — servers whose OAuth is NOT the MCP spec (no RFC
 * 9728 discovery / dynamic registration). Slack: fixed app credentials from
 * the env, user-scope consent, token in authed_user.access_token (xoxp-,
 * "send messages as them"). The grant store/refresh/injection is shared
 * with MCP-spec grants; only start/complete differ.
 */
interface OauthPreset {
  authorize: string;
  token: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Query params for the authorize URL (slack: user_scope). */
  authorizeParams: Record<string, string>;
  /** Pull the token out of the exchange response. */
  extract(res: any): {
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
  };
  /** Env var the grant token is injected as for stdio MCP servers. */
  envVar?: string;
}

const OAUTH_PRESETS: Record<string, OauthPreset> = {
  slack: {
    authorize: "https://slack.com/oauth/v2/authorize",
    token: "https://slack.com/api/oauth.v2.access",
    clientIdEnv: "SLACK_OAUTH_CLIENT_ID",
    clientSecretEnv: "SLACK_OAUTH_CLIENT_SECRET",
    authorizeParams: {
      user_scope:
        "channels:read,groups:read,channels:history,groups:history,chat:write,files:write,users:read,search:read",
    },
    extract: (res) => ({
      accessToken: res?.authed_user?.access_token,
      refreshToken: res?.authed_user?.refresh_token,
      expiresIn: res?.authed_user?.expires_in,
    }),
    envVar: "SLACK_BOT_TOKEN",
  },
};

export function oauthPresetFor(name: string): OauthPreset | undefined {
  const p = OAUTH_PRESETS[name];
  if (!p) return undefined;
  return process.env[p.clientIdEnv] && process.env[p.clientSecretEnv]
    ? p
    : undefined;
}

function callbackUrl(): string {
  return `${configuredServer().publicBaseUrl}/api/connections/mcp-oauth/callback`;
}

/** RFC 9728 → RFC 8414 discovery for an MCP server URL. */
async function discover(serverUrl: string): Promise<{
  resource?: string;
  scopes?: string[];
  endpoints: OauthEndpoints;
}> {
  const origin = new URL(serverUrl).origin;
  let asBase = origin;
  let resource: string | undefined;
  let scopes: string[] | undefined;
  try {
    const pr = (await (
      await fetch(`${origin}/.well-known/oauth-protected-resource`, {
        signal: AbortSignal.timeout(10_000),
      })
    ).json()) as {
      resource?: string;
      authorization_servers?: string[];
      scopes_supported?: string[];
    };
    if (pr.authorization_servers?.[0]) asBase = pr.authorization_servers[0];
    resource = pr.resource;
    if (Array.isArray(pr.scopes_supported) && pr.scopes_supported.length)
      scopes = pr.scopes_supported;
  } catch {}
  for (const wk of [
    `${asBase.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
    `${asBase.replace(/\/$/, "")}/.well-known/openid-configuration`,
  ]) {
    try {
      const meta = (await (
        await fetch(wk, { signal: AbortSignal.timeout(10_000) })
      ).json()) as Record<string, string>;
      if (meta.authorization_endpoint && meta.token_endpoint)
        return {
          resource,
          scopes,
          endpoints: {
            authorize: meta.authorization_endpoint,
            token: meta.token_endpoint,
            register: meta.registration_endpoint,
          },
        };
    } catch {}
  }
  throw new Error(`No OAuth authorization-server metadata for ${serverUrl}`);
}

/** Ensure a registered public client for this server (cached in the store). */
async function ensureServerAuth(
  name: string,
  serverUrl: string,
): Promise<ServerAuth> {
  const store = readStore();
  const cur = store[name];
  if (cur?.clientInfo?.clientId && cur.serverUrl === serverUrl) {
    if (!cur.binding) {
      cur.binding = configuredBinding(name);
      writeStore(store);
    }
    return cur;
  }
  const { resource, scopes, endpoints } = await discover(serverUrl);
  if (!endpoints.register)
    throw new Error(
      `${name}: authorization server offers no dynamic client registration`,
    );
  const registrationUrl = new URL(endpoints.register);
  const registrationResponse = await fetch(endpoints.register, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: productName(),
      redirect_uris: [callbackUrl()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const registrationText = await registrationResponse.text();
  if (!registrationResponse.ok) {
    if (
      registrationResponse.status === 403 &&
      registrationUrl.hostname === "api.figma.com"
    ) {
      throw new Error(
        "Figma does not currently allow Open Session to connect. Its remote MCP server accepts only clients listed in the Figma MCP Catalog.",
      );
    }
    const detail = registrationText.trim().slice(0, 200);
    throw new Error(
      `${name}: client registration failed (HTTP ${registrationResponse.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  let reg: { client_id?: string; error_description?: string };
  try {
    reg = JSON.parse(registrationText);
  } catch {
    throw new Error(`${name}: client registration returned invalid JSON`);
  }
  if (!reg.client_id)
    throw new Error(
      `${name}: client registration failed (${reg.error_description || "no client_id"})`,
    );
  const next: ServerAuth = {
    serverUrl,
    resource,
    ...(scopes ? { scopes } : {}),
    endpoints,
    clientInfo: { clientId: reg.client_id },
    binding: configuredBinding(name),
    ...(cur ? { shared: cur.shared, users: cur.users } : {}),
  };
  const fresh = readStore();
  fresh[name] = next;
  writeStore(fresh);
  return next;
}

// Pending flows keyed by state (10-min TTL); parked on globalThis so a
// frontend-triggered hot reload doesn't strand an in-flight consent.
interface PendingFlow {
  name: string;
  verifier: string;
  teamName?: string; // absent = shared grant
  initiatedBy: string;
  createdAt: number;
}
const pending: Map<string, PendingFlow> = ((globalThis as any).__osMcpOauth ??=
  new Map<string, PendingFlow>());
const PENDING_TTL_MS = 10 * 60_000;

/** Which server a callback's state belongs to, for the result page's brand mark. */
export function pendingFlowServer(state: string): string | undefined {
  return pending.get(state)?.name;
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint the authorize URL for a server. `forUser` (any user ref — name,
 * github login, slack id) makes it a per-user grant; absent = shared.
 */
export async function startMcpOauthFlow(
  name: string,
  serverUrl: string,
  forUser?: string,
  initiatedBy?: string,
): Promise<{ url: string }> {
  if (!initiatedBy) throw new Error("Sign in before connecting a personal tool.");
  const canonicalInitiator = resolveTeammate(initiatedBy)?.name || initiatedBy;
  const teamName = forUser ? resolveTeammate(forUser)?.name : undefined;
  if (forUser && !teamName)
    throw new Error(`"${forUser}" doesn't resolve to a configured teammate`);
  const preset = oauthPresetFor(name);
  if (preset) {
    const state = b64url(randomBytes(24));
    pending.set(state, {
      name,
      verifier: "",
      teamName,
      initiatedBy: canonicalInitiator,
      createdAt: Date.now(),
    });
    const url = new URL(preset.authorize);
    url.searchParams.set("client_id", process.env[preset.clientIdEnv]!);
    url.searchParams.set("redirect_uri", callbackUrl());
    url.searchParams.set("state", state);
    for (const [k, v] of Object.entries(preset.authorizeParams))
      url.searchParams.set(k, v);
    // Ensure a store entry exists so grants have a home.
    const store = readStore();
    store[name] = store[name] || {
      serverUrl,
      endpoints: { authorize: preset.authorize, token: preset.token },
      clientInfo: { clientId: process.env[preset.clientIdEnv]! },
      binding: configuredBinding(name),
    };
    store[name].binding ||= configuredBinding(name);
    writeStore(store);
    return { url: url.toString() };
  }
  const auth = await ensureServerAuth(name, serverUrl);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  for (const [k, v] of pending)
    if (Date.now() - v.createdAt > PENDING_TTL_MS) pending.delete(k);
  pending.set(state, {
    name,
    verifier,
    teamName,
    initiatedBy: canonicalInitiator,
    createdAt: Date.now(),
  });
  const url = new URL(auth.endpoints.authorize);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", auth.clientInfo.clientId);
  url.searchParams.set("redirect_uri", callbackUrl());
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  // Scope to what the resource advertises when it does (strict ASes like
  // Cognito reject unknown scopes); the permissive default otherwise.
  url.searchParams.set(
    "scope",
    auth.scopes?.join(" ") || "openid profile email offline_access",
  );
  url.searchParams.set("prompt", "consent");
  if (auth.resource) url.searchParams.set("resource", auth.resource);
  return { url: url.toString() };
}

/** Complete a flow from the callback redirect. Returns what got connected. */
export async function completeMcpOauthFlow(
  state: string,
  code: string,
  completedBy?: string,
): Promise<{ name: string; teamName?: string }> {
  const flow = pending.get(state);
  if (!flow || Date.now() - flow.createdAt > PENDING_TTL_MS)
    throw new Error("This connect link expired. Start again from Connections.");
  const canonicalCompleter = completedBy
    ? resolveTeammate(completedBy)?.name || completedBy
    : undefined;
  if (
    !canonicalCompleter ||
    flow.initiatedBy.toLowerCase() !== canonicalCompleter.toLowerCase()
  ) {
    pending.delete(state);
    throw new Error("This connect link belongs to a different signed-in account.");
  }
  pending.delete(state);
  const preset = oauthPresetFor(flow.name);
  if (preset) {
    const body = new URLSearchParams({
      code,
      client_id: process.env[preset.clientIdEnv]!,
      client_secret: process.env[preset.clientSecretEnv]!,
      redirect_uri: callbackUrl(),
    });
    const res = (await (
      await fetch(preset.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15_000),
      })
    ).json()) as any;
    const tok = preset.extract(res);
    if (!tok.accessToken)
      throw new Error(
        `Token exchange failed: ${res?.error || "no user token in response"}`,
      );
    const grant: Grant = {
      tokens: {
        accessToken: tok.accessToken,
        ...(tok.refreshToken ? { refreshToken: tok.refreshToken } : {}),
        ...(tok.expiresIn
          ? { expiresAt: Date.now() + tok.expiresIn * 1000 }
          : {}),
      },
      updatedAt: new Date().toISOString(),
      ...(completedBy ? { connectedBy: completedBy } : {}),
    };
    const fresh = readStore();
    const entry = fresh[flow.name];
    if (!entry) throw new Error(`Registration for ${flow.name} vanished`);
    writeGrant(entry, slotFor(flow.teamName), grant);
    writeStore(fresh);
    audit({
      kind: "mcp_oauth_grant_connected",
      server: flow.name,
      slot: flow.teamName || "shared",
    });
    return { name: flow.name, teamName: flow.teamName };
  }
  const store = readStore();
  const auth = store[flow.name];
  if (!auth) throw new Error(`No pending registration for ${flow.name}`);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(),
    client_id: auth.clientInfo.clientId,
    code_verifier: flow.verifier,
  });
  if (auth.resource) body.set("resource", auth.resource);
  const res = (await (
    await fetch(auth.endpoints.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    })
  ).json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };
  if (!res.access_token)
    throw new Error(
      `Token exchange failed: ${res.error_description || res.error || "no access_token"}`,
    );
  const grant: Grant = {
    tokens: {
      accessToken: res.access_token,
      ...(res.refresh_token ? { refreshToken: res.refresh_token } : {}),
      ...(res.expires_in
        ? { expiresAt: Date.now() + res.expires_in * 1000 }
        : {}),
    },
    updatedAt: new Date().toISOString(),
    ...(completedBy ? { connectedBy: completedBy } : {}),
  };
  const fresh = readStore();
  const entry = fresh[flow.name];
  if (!entry) throw new Error(`Registration for ${flow.name} vanished`);
  writeGrant(entry, slotFor(flow.teamName), grant);
  writeStore(fresh);
  audit({
    kind: "mcp_oauth_grant_connected",
    server: flow.name,
    slot: flow.teamName || "shared",
  });
  return { name: flow.name, teamName: flow.teamName };
}

const REFRESH_AHEAD_MS = 5 * 60_000;
const refreshes = new Map<string, Promise<void>>();

async function refreshGrant(
  name: string,
  auth: ServerAuth,
  ref: GrantRef,
): Promise<void> {
  const { grant } = ref;
  if (!grant.tokens.refreshToken) return;
  const refreshKey = `${name}\0${slotLabel(ref)}`;
  const running = refreshes.get(refreshKey);
  if (running) return running;
  const operation = refreshGrantOnce(name, auth, ref).finally(() => {
    if (refreshes.get(refreshKey) === operation) refreshes.delete(refreshKey);
  });
  refreshes.set(refreshKey, operation);
  return operation;
}

async function refreshGrantOnce(
  name: string,
  auth: ServerAuth,
  ref: GrantRef,
): Promise<void> {
  const { grant } = ref;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: grant.tokens.refreshToken!,
    client_id: auth.clientInfo.clientId,
  });
  if (auth.resource) body.set("resource", auth.resource);
  try {
    const res = (await (
      await fetch(auth.endpoints.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15_000),
      })
    ).json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!res.access_token) return;
    const next: Grant = {
      ...grant,
      tokens: {
        accessToken: res.access_token,
        refreshToken: res.refresh_token || grant.tokens.refreshToken,
        ...(res.expires_in
          ? { expiresAt: Date.now() + res.expires_in * 1000 }
          : {}),
      },
      updatedAt: new Date().toISOString(),
    };
    const store = readStore();
    const entry = store[name];
    if (!entry) return;
    // A disconnect or reconnect while the network request was in flight wins.
    // Never resurrect an old grant or overwrite a newer account's tokens.
    const current = grantRef(entry, ref)?.grant;
    if (
      !current ||
      current.tokens.accessToken !== grant.tokens.accessToken ||
      current.tokens.refreshToken !== grant.tokens.refreshToken
    )
      return;
    writeGrant(entry, ref, next);
    writeStore(store);
    audit({
      kind: "mcp_oauth_grant_refreshed",
      server: name,
      slot: slotLabel(ref),
    });
  } catch (e) {
    // Provider errors can echo request material. Keep logs to fixed metadata.
    console.error(`[mcp-oauth] refresh failed for ${name}/${slotLabel(ref)}`);
  }
}

async function refreshExpiring(): Promise<void> {
  const store = readStore();
  for (const [name, auth] of Object.entries(store)) {
    const slots: GrantSlot[] = [
      ...(auth.shared ? [{ kind: "shared" } as const] : []),
      ...Object.keys(auth.users || {}).map(
        (teamName) => ({ kind: "user", teamName }) as const,
      ),
    ];
    for (const slot of slots) {
      const ref = grantRef(auth, slot);
      const exp = ref?.grant.tokens.expiresAt;
      if (
        ref?.grant.tokens.refreshToken &&
        exp &&
        exp - Date.now() < REFRESH_AHEAD_MS
      )
        await refreshGrant(name, auth, ref);
    }
  }
}

// Lazy 2-minute refresh ticker (parked on globalThis; started on first store
// use, so no entry-file side-effect import is needed).
function ensureTicker(): void {
  const g = globalThis as any;
  if (g.__osMcpOauthTicker) return;
  g.__osMcpOauthTicker = setInterval(() => {
    refreshExpiring().catch(() => {});
  }, 2 * 60_000);
  refreshExpiring().catch(() => {});
}

/**
 * The Authorization header value for a server, for a run by `user` — the
 * user's own grant first (per-user MCP identity), else the shared grant.
 * Sync (called from filterMcpServers); a stale token still gets returned
 * while the ticker refreshes in the background — the server 401s at worst,
 * which reads as "tools unavailable this turn", never a crashed run.
 */
export function mcpAuthHeader(name: string, user?: string): string | undefined {
  return mcpUserGrantHeader(name, user) ?? mcpSharedGrantHeader(name);
}

/** Await a refresh when necessary, then return one fresh server-side header. */
export async function mcpAuthHeaderFresh(
  name: string,
  users?: Array<string | undefined>,
): Promise<{ header: string; slot: string } | undefined> {
  ensureTicker();
  const store = readStore();
  const auth = store[name];
  if (!auth) return undefined;
  const slots: GrantSlot[] = (users || [])
    .filter((u): u is string => !!u)
    .map((u) => resolveTeammate(u)?.name)
    .filter((u): u is string => !!u)
    .map((teamName) => ({ kind: "user", teamName }));
  slots.push({ kind: "shared" });
  for (const slot of slots) {
    let ref = grantRef(auth, slot);
    if (!ref) continue;
    const exp = ref.grant.tokens.expiresAt;
    if (exp && exp - Date.now() < REFRESH_AHEAD_MS && ref.grant.tokens.refreshToken) {
      await refreshGrant(name, auth, ref);
      const freshAuth = readStore()[name];
      ref = grantRef(freshAuth, slot);
    }
    if (!ref) continue;
    if (ref.grant.tokens.expiresAt && ref.grant.tokens.expiresAt! < Date.now()) continue;
    return {
      header: `Bearer ${ref.grant.tokens.accessToken}`,
      slot: slotLabel(ref),
    };
  }
  return undefined;
}

/** The user's own grant ONLY (no shared fallback) — lets callers order
 *  identities explicitly (e.g. session creator first, then prompter). */
export function mcpUserGrantHeader(
  name: string,
  user?: string,
): string | undefined {
  if (!user) return undefined;
  const teamName = resolveTeammate(user)?.name;
  if (!teamName) return undefined;
  return grantHeader(name, { kind: "user", teamName });
}

/** The workspace-wide grant ONLY. */
export function mcpSharedGrantHeader(name: string): string | undefined {
  return grantHeader(name, { kind: "shared" });
}

function grantHeader(name: string, slot: GrantSlot): string | undefined {
  ensureTicker();
  const auth = tryReadStore()[name];
  const ref = grantRef(auth, slot);
  if (!auth || !ref) return undefined;
  const { accessToken, expiresAt, refreshToken } = ref.grant.tokens;
  if (expiresAt && expiresAt - Date.now() < REFRESH_AHEAD_MS && refreshToken)
    refreshGrant(name, auth, ref).catch(() => {});
  if (expiresAt && expiresAt < Date.now()) return undefined;
  return `Bearer ${accessToken}`;
}

/** Connection status for the UI: who's connected on each grant. */
export function mcpOauthStatus(
  name: string,
): { shared?: { connectedBy?: string; updatedAt: string }; users: string[] } {
  const auth = tryReadStore()[name];
  return {
    ...(auth?.shared
      ? {
          shared: {
            connectedBy: auth.shared.connectedBy,
            updatedAt: auth.shared.updatedAt,
          },
        }
      : {}),
    users: Object.keys(auth?.users || {}),
  };
}

// OAuth-capability probe (RFC 9728 protected-resource metadata on the
// server origin) — drives "Connect my account" visibility for servers that
// run on a static workspace key today (e.g. posthog).
//
// The answer is kept on disk, not only in memory, because it decides
// MEMBERSHIP of the Account list rather than one row's state: a cold
// process cannot say which tools belong on that list at all, so the panel
// would have to wait on a probe per configured server before it could draw a
// single row. Whether an origin publishes OAuth metadata is a stable fact
// about that service, so the last answer is a good one to show while a fresh
// probe runs behind it.
//
// A probe that never got an answer is remembered in memory only, and briefly:
// a network blip must not persist "this tool has no personal sign-in" and drop
// the row from everyone's list for an hour.
const CAPABLE_PATH = statePath(".opensession-mcp-capable.json");
const CAPABLE_TTL_MS = 60 * 60_000;
const CAPABLE_ERROR_TTL_MS = 60_000;

/** `soft`: the probe errored, so this is a placeholder that keeps us from
 *  hammering an unreachable origin, not a fact worth persisting. */
interface Capability {
  capable: boolean;
  ts: number;
  soft?: boolean;
}

let capableCache: Map<string, Capability> | null = null;
const capableInflight = new Map<string, Promise<boolean>>();

function capabilities(): Map<string, Capability> {
  if (capableCache) return capableCache;
  capableCache = new Map();
  try {
    const raw = JSON.parse(readFileSync(CAPABLE_PATH, "utf8")) as Record<
      string,
      Capability
    >;
    for (const [origin, e] of Object.entries(raw))
      if (typeof e?.capable === "boolean" && typeof e?.ts === "number")
        capableCache.set(origin, { capable: e.capable, ts: e.ts });
  } catch {}
  return capableCache;
}

function capabilityFresh(e: Capability): boolean {
  return Date.now() - e.ts < (e.soft ? CAPABLE_ERROR_TTL_MS : CAPABLE_TTL_MS);
}

function originOf(serverUrl: string): string | undefined {
  try {
    return new URL(serverUrl).origin;
  } catch {
    return undefined;
  }
}

function probeCapable(origin: string): Promise<boolean> {
  const running = capableInflight.get(origin);
  if (running) return running;
  const p = (async () => {
    let capable = false;
    let answered = false;
    try {
      const res = await fetch(
        `${origin}/.well-known/oauth-protected-resource`,
        { signal: AbortSignal.timeout(6_000) },
      );
      capable = res.ok;
      answered = true;
    } catch {}
    capabilities().set(origin, {
      capable,
      ts: Date.now(),
      ...(answered ? {} : { soft: true }),
    });
    if (answered) persistCapabilities();
    return capable;
  })().finally(() => capableInflight.delete(origin));
  capableInflight.set(origin, p);
  return p;
}

function persistCapabilities(): void {
  const out: Record<string, Capability> = {};
  for (const [origin, e] of capabilities()) if (!e.soft) out[origin] = e;
  try {
    writeFileSync(CAPABLE_PATH, JSON.stringify(out, null, 2) + "\n");
  } catch {}
}

/**
 * The last known capability answer, refreshing a stale one in the background.
 * `undefined` means no probe has ever finished for this origin, which the
 * caller should report as still checking rather than as "no personal sign-in
 * here" — the two look identical to a reader and only one of them is true.
 */
export function cachedOauthCapable(serverUrl: string): boolean | undefined {
  const origin = originOf(serverUrl);
  if (!origin) return false;
  const hit = capabilities().get(origin);
  if (!hit || !capabilityFresh(hit)) probeCapable(origin).catch(() => {});
  return hit?.capable;
}

export async function isOauthCapable(serverUrl: string): Promise<boolean> {
  const origin = originOf(serverUrl);
  if (!origin) return false;
  const hit = capabilities().get(origin);
  if (hit && capabilityFresh(hit)) return hit.capable;
  return probeCapable(origin);
}

/** Raw grant token (no "Bearer " prefix) — stdio env injection. */
export function mcpUserGrantToken(
  name: string,
  user?: string,
): string | undefined {
  const h = mcpUserGrantHeader(name, user);
  return h?.replace(/^Bearer\s+/i, "");
}

/** Any grant at all for this server (shared or any user's)? */
export function hasMcpOauthGrant(name: string, user?: string): boolean {
  if (user) return hasMcpOauthGrantForUsers(name, [user]);
  const auth = tryReadStore()[name];
  return !!auth?.shared || Object.keys(auth?.users || {}).length > 0;
}

/** Grant presence, independent of token expiry. Mount decisions must not fall
 * through to a workspace credential while a refreshable personal slot exists. */
export function hasMcpOauthGrantForUsers(
  name: string,
  users: Array<string | undefined>,
): boolean {
  const auth = tryReadStore()[name];
  if (!auth) return false;
  for (const user of users) {
    if (!user) continue;
    const teamName = resolveTeammate(user)?.name;
    if (teamName && auth.users?.[teamName]) return true;
  }
  return !!auth.shared;
}

/** Drop a grant (Disconnect in the UI). */
export function removeMcpOauthGrant(name: string, forUser?: string): boolean {
  const store = readStore();
  const auth = store[name];
  if (!auth) return false;
  if (forUser) {
    const teamName = resolveTeammate(forUser)?.name;
    if (!teamName || !auth.users?.[teamName]) return false;
    delete auth.users[teamName];
  } else {
    if (!auth.shared) return false;
    delete auth.shared;
  }
  writeStore(store);
  audit({
    kind: "mcp_oauth_grant_disconnected",
    server: name,
    slot: forUser ? resolveTeammate(forUser)?.name || "user" : "shared",
  });
  return true;
}

/** Remove registration and every grant when its configured server is removed. */
export function removeAllMcpOauthGrants(name: string): boolean {
  const store = readStore();
  if (!store[name]) return false;
  delete store[name];
  writeStore(store);
  audit({ kind: "mcp_oauth_server_grants_revoked", server: name });
  return true;
}
