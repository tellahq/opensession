/**
 * Per-user GitHub authentication (opt-in): interactive sessions run `gh` as
 * the session owner's own GitHub account, so PRs they open are authored by
 * the human — not the bot login the machine's gh CLI is signed into.
 *
 * Opt-in via config (`integrations.github` in ~/.opensession/config.json):
 *
 *   "integrations": {
 *     "github": {
 *       "userPrAuth": true,
 *       "oauthClientId": "<GitHub App client id>",
 *       "oauthClientSecret": "<GitHub App client secret>",
 *       "appSlug": "<GitHub App slug>",
 *       "installationOwner": "<organization>"
 *     }
 *   }
 *
 * userPrAuth + client id activate sign-in. The same App's slug, installation
 * owner, secret, and private key complete bot identity, token refresh, and
 * installation-token auth. OPENSESSION_GITHUB_* environment values win.
 *
 * Tokens come from GitHub's OAuth device flow (the same mechanism `gh auth
 * login` uses), and that is the only sign-in there is: start → the person
 * enters a code at github.com/login/device → poll for the access token. The
 * app must have "Enable Device Flow" checked. Getting a token needs no client
 * secret; keeping one alive does, because the refresh grant below is
 * confidential. Tokens are stored per GitHub login
 * in ~/.opensession/github-auth.json (0600), are never returned by the API,
 * and are injected only as GH_TOKEN/GITHUB_TOKEN into interactive,
 * non-least-privilege runs (see pi-runner.ts) — automation runs and
 * anything carrying deniedTools never see them, the same fail-closed posture
 * as `allowedUsers` MCP servers. The run's user resolves to a GitHub login
 * through the SAME identity table as commit attribution (identity.team in
 * config.json → user-mappings.ts), so the mapping is config, not code.
 *
 * With a GitHub App installed only on the configured organization, each user
 * token is limited to the intersection of the user's
 * access and the app's installation, so it structurally cannot write to
 * public/third-party repos — the enforcement the gh-guard shims used to
 * approximate. App tokens expire (~8h) and come with a rotating refresh
 * token; the refresh ticker below keeps stored tokens fresh so the sync
 * getters (githubAuthEnv, githubCredentialForLogin) can stay sync. Getters
 * never hand out an expired token — they fail closed to the bot credential
 * (runner) or a 403 (web mutation routes).
 */

import { stateDir } from "./paths";
import { isDevInstance } from "./dev-mode";
import { chmodSync, readFileSync, statSync } from "fs";
import { audit } from "./audit";
import { configuredIdentity, getConfig } from "./config";
import { writeJsonAtomic } from "./shared/atomic-write";
import { fetchWithTimeout } from "./shared/fetch-with-timeout";
import { githubGitCredentialEnv } from "./github-git-credential";

/** Env override is for tests/sandboxes; read per call so it can change. */
function storePath(): string {
  return (
    process.env.OPENSESSION_GITHUB_AUTH_STORE || stateDir("github-auth.json")
  );
}

/** Classic OAuth needs `repo` for private-repository PR writes and
 * `read:org` for the one-time organization member import during setup. */
const DEVICE_FLOW_SCOPE = "repo read:org";

export interface GithubUserAuthSettings {
  /** Feature switch (config `integrations.github.userPrAuth`). */
  enabled: boolean;
  /** App client id; null = not configured. */
  clientId: string | null;
  /** App client secret. Signing in never needs it (the device flow is a
   *  public client), but the refresh grant does, so without it a GitHub App's
   *  user tokens stop at their ~8h expiry and everyone reconnects by hand. */
  clientSecret: string | null;
}

export interface GithubConnectedAccount {
  login: string;
  /** GitHub profile display name at connect time. */
  name?: string;
  scopes?: string;
  /** App device flow is the only accepted source. Older refresh-backed App
   * grants predate this discriminator and remain valid. */
  source?: "device";
  connectedAt: string;
  /** GitHub has permanently rejected the stored refresh token, so the access
   *  token can no longer be renewed. Nothing server-side can revive it — the
   *  person has to connect again. */
  needsReconnect?: boolean;
}

interface StoredAccount extends GithubConnectedAccount {
  token: string;
  /** GitHub App user tokens expire in roughly eight hours. */
  expiresAt?: string;
  /** Rotates on every refresh — the stored value is always the newest one. */
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  /** When the refresh grant was rejected for good (`bad_refresh_token`, or the
   *  refresh token itself lapsed). Set = stop retrying and ask for a reconnect;
   *  cleared by connecting again, which writes a fresh record. */
  refreshFailedAt?: string;
}

interface Store {
  users: Record<string, StoredAccount>; // keyed by lowercased login
}

/** Refresh when a token is inside this window of its expiry (covers the
 *  longest turn a run can make plus clock slack). */
const REFRESH_SKEW_MS = 40 * 60_000;

function tokenUsable(account: StoredAccount): boolean {
  const appGrant =
    account.source === "device" ||
    (!account.source && !!account.expiresAt && !!account.refreshToken);
  if (!account.token || !appGrant) return false;
  if (!account.expiresAt) return true; // legacy non-expiring token
  return Date.parse(account.expiresAt) > Date.now();
}

/** `integrations.github` as a plain object (the config value is untyped). */
function githubIntegrationConfig(): Record<string, unknown> {
  const raw = getConfig().integrations?.github;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

export function githubUserAuthSettings(): GithubUserAuthSettings {
  const o = githubIntegrationConfig();
  // env → config: this client id feeds githubUserAuthActive()/webAuthRequired().
  // It mirrors githubAppIdentity()'s client id resolution, kept separate so the
  // two never drift into changing each other's meaning.
  const clientId =
    process.env.OPENSESSION_GITHUB_CLIENT_ID ||
    (typeof o.oauthClientId === "string" && o.oauthClientId.trim()
      ? o.oauthClientId.trim()
      : null);
  const clientSecret =
    process.env.OPENSESSION_GITHUB_CLIENT_SECRET ||
    (typeof o.oauthClientSecret === "string" && o.oauthClientSecret.trim()
      ? o.oauthClientSecret.trim()
      : null);
  return { enabled: o.userPrAuth === true, clientId, clientSecret };
}

/** Feature is usable: switched on AND a client id to run the device flow. */
export function githubUserAuthActive(): boolean {
  const s = githubUserAuthSettings();
  return s.enabled && !!s.clientId;
}

// ── The GitHub App device flow ───────────────────────────────────────────────
//
// Simple-mode connect is a user's own GitHub App: they create one (the setup
// wizard, or an operator env var), and the device flow issues a user-to-server
// token scoped to the repos the app is installed on. It is opt-in: NO app is
// shipped and there is no baked client id, so this path stays invisible until a
// client id is configured.
//
// The client id and slug are public identifiers, not credentials. A client
// secret is configured alongside them: the device flow itself needs none (its
// token exchange takes client_id + device_code), but refreshing the ~8h
// user-to-server token does, so without a secret the connection would lapse.
export interface GithubAppIdentity {
  /** Public OAuth client id; null = not configured (device flow unavailable). */
  clientId: string | null;
  /** App slug, for the install URL; null = not configured. */
  slug: string | null;
}

function trimmedEnv(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

function trimmedConfig(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * The operator's configured GitHub App identity, resolved env → config, with no
 * baked default (nothing ships). Deliberately does NOT feed
 * githubUserAuthActive() / webAuthRequired(): configuring an App must never flip
 * an operator's sign-in gate. It is the client id for the device flow and the
 * slug for the install URL only.
 */
export function githubAppIdentity(): GithubAppIdentity {
  const o = githubIntegrationConfig();
  return {
    clientId:
      trimmedEnv("OPENSESSION_GITHUB_CLIENT_ID") ??
      trimmedConfig(o, "oauthClientId"),
    slug:
      trimmedEnv("OPENSESSION_GITHUB_APP_SLUG") ?? trimmedConfig(o, "appSlug"),
  };
}

/**
 * The device-flow connect path is on offer — only when an operator has
 * configured a GitHub App client id, and INDEPENDENT of
 * webAuthRequired()/userPrAuth. Simple mode's always-available connect is the
 * pasted token, not this.
 */
export function githubConnectAvailable(): boolean {
  return !!githubAppIdentity().clientId;
}

/**
 * The org an install was told to set the App up under (install `--org`, or the
 * setup wizard with owner=Organization). Config-only — it is captured intent,
 * not a live credential, and NEVER feeds githubUserAuthActive()/webAuthRequired().
 * Null when the install was single-user (no org).
 */
export function githubAppOrg(): string | null {
  return trimmedConfig(githubIntegrationConfig(), "appOrg");
}

/**
 * The install/app-setup recorded that connecting should also turn on per-user
 * sign-in (config `integrations.github.authOnConnect`). This is INTENT only: it
 * has zero effect until the simple-mode device-connect handler consumes it and
 * clears it (routes/connections.ts), so a box carrying it set-but-unconsumed
 * behaves exactly like one without it. It deliberately does not touch
 * userPrAuth, so it can never gate the app on its own.
 */
export function githubAuthOnConnect(): boolean {
  return githubIntegrationConfig().authOnConnect === true;
}

/**
 * Where the App client id came from, so the UI can name the exact thing to
 * unset when it explains which App setting is externally managed. env wins over
 * config, mirroring githubAppIdentity()'s resolution; null when no App is set.
 */
export function githubAppConfigSource(): "env" | "config" | null {
  if (trimmedEnv("OPENSESSION_GITHUB_CLIENT_ID")) return "env";
  if (trimmedConfig(githubIntegrationConfig(), "oauthClientId"))
    return "config";
  return null;
}

/** Where a user picks which repos the App (and so their user-to-server token)
 *  may reach. Null unless a configured App's slug is known. */
export function githubAppInstallUrl(): string | null {
  const { slug } = githubAppIdentity();
  return slug ? `https://github.com/apps/${slug}/installations/new` : null;
}

function readStore(): Store {
  try {
    const raw = JSON.parse(readFileSync(storePath(), "utf-8"));
    const users = raw?.users && typeof raw.users === "object" ? raw.users : {};
    return { users };
  } catch {
    return { users: {} };
  }
}

function writeStore(store: Store): void {
  writeJsonAtomic(storePath(), store);
  invalidateReconnectCache();
  try {
    chmodSync(storePath(), 0o600);
  } catch {}
}

// ── Device flow ──────────────────────────────────────────────────────────────

export interface DeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds between polls GitHub asks for. */
  interval: number;
  expiresIn: number;
}

/**
 * GitHub refuses the whole flow when the app doesn't have "Enable Device Flow"
 * ticked, and answers with the bare code `device_flow_disabled`. That is the
 * one setup mistake that locks everyone out at once, since the device flow is
 * the only sign-in there is, so it gets a sentence naming the switch and where
 * it lives rather than GitHub's word for its own error.
 */
const DEVICE_FLOW_DISABLED =
  "This GitHub app does not have Device Flow enabled, so nobody can sign in. " +
  'Tick "Enable Device Flow" in the app\'s settings on GitHub, then try again.';
const GITHUB_DEVICE_VERIFICATION_URI = "https://github.com/login/device";

export async function startGithubDeviceFlow(): Promise<
  DeviceFlowStart | { error: string }
> {
  // The device flow uses the configured App client id from environment or config.
  // Without an App, authentication is unavailable. Who may reach this is the route's
  // job (operator mode: signed in; simple mode: App configured), not the
  // flow's — starting a device code is a read-only call to GitHub.
  const clientId = githubAppIdentity().clientId;
  if (!clientId)
    return { error: "GitHub connect is not configured (no client id)" };
  const res = await fetchWithTimeout("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: DEVICE_FLOW_SCOPE }),
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok || !body?.device_code) {
    if (body?.error === "device_flow_disabled")
      return { error: DEVICE_FLOW_DISABLED };
    return {
      error:
        body?.error_description ||
        body?.error ||
        `GitHub device flow failed (${res.status})`,
    };
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    // GitHub's documented browser entry point is fixed. Do not forward an
    // unexpected response URL such as the internal POST-only /authorize path.
    verificationUri: GITHUB_DEVICE_VERIFICATION_URI,
    interval: typeof body.interval === "number" ? body.interval : 5,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 900,
  };
}

export type DeviceFlowPoll =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "ok"; login: string; name?: string }
  | { status: "error"; error: string };

/** Public view of a stored account. Every credential is destructured away by
 *  name rather than spread through — the refresh token mints new access tokens
 *  for months, so it must never reach an API response. */
function stripStoredAccount({
  token: _token,
  refreshToken: _refreshToken,
  refreshTokenExpiresAt: _refreshTokenExpiresAt,
  expiresAt: _expiresAt,
  refreshFailedAt,
  ...rest
}: StoredAccount): GithubConnectedAccount {
  return { ...rest, ...(refreshFailedAt ? { needsReconnect: true } : {}) };
}

export function connectedGithubAccount(
  login: string,
): GithubConnectedAccount | null {
  const account = readStore().users[login.toLowerCase()];
  return account ? stripStoredAccount(account) : null;
}

export function validateGithubTokenLogin(
  actualLogin: string,
  expectedLogin?: string | null,
): { ok: true } | { ok: false; error: string } {
  if (
    !expectedLogin ||
    actualLogin.toLowerCase() === expectedLogin.toLowerCase()
  )
    return { ok: true };
  return {
    ok: false,
    error: `GitHub authorized @${actualLogin}, but the signed-in user is @${expectedLogin}`,
  };
}

/**
 * One poll of the device-flow token endpoint. On success, fetches the token's
 * own /user to learn WHO authorized (the login is ground truth from GitHub —
 * never client-supplied) and stores the token under that login.
 */
export async function pollGithubDeviceFlow(
  deviceCode: string,
  expectedLogin?: string | null,
): Promise<DeviceFlowPoll> {
  const { clientId } = githubAppIdentity();
  if (!clientId)
    return { status: "error", error: "No OAuth client id configured" };
  const res = await fetchWithTimeout(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    },
  );
  const body: any = await res.json().catch(() => null);
  if (!body)
    return {
      status: "error",
      error: `GitHub token endpoint failed (${res.status})`,
    };
  if (body.error === "authorization_pending") return { status: "pending" };
  if (body.error === "slow_down") {
    return {
      status: "slow_down",
      interval: typeof body.interval === "number" ? body.interval : 10,
    };
  }
  if (body.error) {
    return { status: "error", error: body.error_description || body.error };
  }
  const token: string | undefined = body.access_token;
  if (!token)
    return { status: "error", error: "GitHub returned no access token" };
  return identifyAndStoreToken(token, body, expectedLogin);
}

// ── Server-driven device-flow completion ──
// The device code is entered OUTSIDE the requesting client (Safari, the
// GitHub app, another machine), and mobile clients get suspended or killed
// exactly while that happens — a client-driven poll loop dies with them.
// That's how sign-ins were getting lost: the GitHub grant landed, but nobody
// was polling anymore (or the one response carrying the minted session never
// reached the suspended app). So the SERVER owns the poll loop: the auth
// route calls watchGithubDeviceFlow after starting a flow, the outcome parks
// here until the code's expiry, and the client's /poll just consults it —
// idempotent, so a lost response is simply re-delivered on the next ask.
// Parked on globalThis so a bun --hot reload doesn't strand in-flight flows.

export type DeviceFlowServerState =
  | { status: "pending" }
  | { status: "ok"; login: string; name?: string }
  | { status: "error"; error: string };

type WatchedFlow = DeviceFlowServerState & { expiresAt: number };

const watchedFlows: Map<string, WatchedFlow> = ((
  globalThis as any
).__osWatchedDeviceFlows ??= new Map());

function sweepWatchedFlows(): void {
  const now = Date.now();
  for (const [code, flow] of watchedFlows) {
    if (flow.expiresAt < now) watchedFlows.delete(code);
  }
}

/** Poll a just-started device flow to completion server-side. */
export function watchGithubDeviceFlow(flow: DeviceFlowStart): void {
  sweepWatchedFlows();
  if (watchedFlows.has(flow.deviceCode)) return;
  // Results stay retrievable for 10 min past the code's own expiry so a
  // client that resumes late still gets a definitive answer.
  const codeExpiresAt = Date.now() + flow.expiresIn * 1000;
  const keepUntil = codeExpiresAt + 10 * 60_000;
  watchedFlows.set(flow.deviceCode, {
    status: "pending",
    expiresAt: keepUntil,
  });
  console.log(
    `[auth] device flow ${flow.userCode} (…${flow.deviceCode.slice(-6)}) started — watching server-side`,
  );
  void (async () => {
    let interval = Math.max(flow.interval, 5);
    while (Date.now() < codeExpiresAt) {
      await new Promise((r) => setTimeout(r, interval * 1000));
      let result: DeviceFlowPoll;
      try {
        result = await pollGithubDeviceFlow(flow.deviceCode);
      } catch {
        continue; // transient — GitHub unreachable etc.
      }
      if (result.status === "pending") continue;
      if (result.status === "slow_down") {
        interval = Math.max(result.interval, interval);
        continue;
      }
      if (result.status === "ok") {
        watchedFlows.set(flow.deviceCode, {
          status: "ok",
          login: result.login,
          name: result.name,
          expiresAt: keepUntil,
        });
        console.log(
          `[auth] device flow ${flow.userCode} authorized by @${result.login}`,
        );
      } else {
        watchedFlows.set(flow.deviceCode, {
          status: "error",
          error: result.error,
          expiresAt: keepUntil,
        });
        console.log(
          `[auth] device flow ${flow.userCode} failed: ${result.error}`,
        );
      }
      return;
    }
    watchedFlows.set(flow.deviceCode, {
      status: "error",
      error: "The sign-in code expired — try again.",
      expiresAt: keepUntil,
    });
    console.log(`[auth] device flow ${flow.userCode} expired unused`);
  })();
}

/** Outcome of a server-watched flow (null: unknown code, or pre-watch flow). */
export function githubDeviceFlowResult(
  deviceCode: string,
): DeviceFlowServerState | null {
  sweepWatchedFlows();
  const flow = watchedFlows.get(deviceCode);
  if (!flow) return null;
  const { expiresAt: _expiresAt, ...state } = flow;
  return state;
}

/** The expiry/refresh fields of a token-endpoint response (GitHub App user
 *  tokens carry them; classic OAuth app responses don't). */
interface TokenGrant {
  access_token?: string;
  scope?: unknown;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

function grantExpiryFields(body: TokenGrant): Partial<StoredAccount> {
  const now = Date.now();
  return {
    ...(typeof body.expires_in === "number"
      ? { expiresAt: new Date(now + body.expires_in * 1000).toISOString() }
      : {}),
    ...(typeof body.refresh_token === "string" && body.refresh_token
      ? { refreshToken: body.refresh_token }
      : {}),
    ...(typeof body.refresh_token_expires_in === "number"
      ? {
          refreshTokenExpiresAt: new Date(
            now + body.refresh_token_expires_in * 1000,
          ).toISOString(),
        }
      : {}),
  };
}

/** Shared tail of both OAuth flows: learn WHO the token belongs to (GET /user
 *  with the token itself — the login is ground truth from GitHub, never
 *  client-supplied) and store it under that login. */
async function identifyAndStoreToken(
  token: string,
  grant: TokenGrant,
  expectedLogin?: string | null,
): Promise<DeviceFlowPoll> {
  const scope = grant.scope;
  const userRes = await fetchWithTimeout("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "opensession",
    },
  });
  const user: any = await userRes.json().catch(() => null);
  const login: string | undefined = user?.login;
  if (!userRes.ok || !login) {
    return {
      status: "error",
      error: "Token issued but GET /user failed — not stored",
    };
  }

  const ownership = validateGithubTokenLogin(login, expectedLogin);
  if (!ownership.ok) return { status: "error", error: ownership.error };

  const store = readStore();
  const record: StoredAccount = {
    login,
    token,
    ...(typeof user.name === "string" && user.name ? { name: user.name } : {}),
    ...(typeof scope === "string" && scope ? { scopes: scope } : {}),
    source: "device",
    connectedAt: new Date().toISOString(),
    ...grantExpiryFields(grant),
  };
  // Simple mode holds exactly one account: soleGithubAccount()/soleGithubLogin()
  // are one-account-or-nothing, so a reconnect that authorizes a DIFFERENT login
  // must REPLACE the previous record, not accumulate. Two usable accounts strand
  // both getters at null, which also leaves the DELETE route no way to recover.
  // Operator mode keeps one record per signed-in team member.
  if (githubUserAuthActive()) {
    store.users[login.toLowerCase()] = record;
  } else {
    store.users = { [login.toLowerCase()]: record };
  }
  writeStore(store);
  audit({ kind: "github_auth_connect", login, scopes: scope });
  return { status: "ok", login, ...(user.name ? { name: user.name } : {}) };
}

// ── Token refresh (GitHub App user tokens) ───────────────────────────────────

/** Flag an account whose refresh grant is unrecoverable. The stored tokens stay
 *  put (the getters already fail closed on the expired access token) — this only
 *  stops the sweep from retrying and lets the UI surface the reconnect. */
function markRefreshDead(key: string, error: string): void {
  const store = readStore();
  const account = store.users[key];
  if (!account || account.refreshFailedAt) return;
  store.users[key] = { ...account, refreshFailedAt: new Date().toISOString() };
  writeStore(store);
  audit({ kind: "github_auth_refresh_dead", login: account.login, error });
}

/** Refresh one account's token via the refresh-token grant. GitHub rotates
 *  the refresh token on every use, so the stored pair is always replaced
 *  together. Returns false when the account has nothing to refresh or the
 *  grant is rejected (person must reconnect — getters already fail closed on
 *  the expired access token). */
export async function refreshGithubToken(login: string): Promise<boolean> {
  const { clientId, clientSecret } = githubUserAuthSettings();
  if (!clientId || !clientSecret) return false;
  const key = login.toLowerCase();
  const account = readStore().users[key];
  if (!account?.refreshToken) return false;
  if (account.refreshFailedAt) return false; // already known dead — see markRefreshDead
  if (
    account.refreshTokenExpiresAt &&
    Date.parse(account.refreshTokenExpiresAt) <= Date.now()
  ) {
    markRefreshDead(key, "refresh token expired");
    return false;
  }
  const res = await fetchWithTimeout(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
      }),
    },
  );
  const body: TokenGrant & { error?: string; error_description?: string } =
    (await res.json().catch(() => null)) ?? {};
  if (body.error || !body.access_token) {
    const error = body.error_description || body.error || `HTTP ${res.status}`;
    audit({ kind: "github_auth_refresh_failed", login, error });
    // `bad_refresh_token` is GitHub's final answer: the grant is gone and no
    // amount of retrying brings it back (it was retried every 20 minutes for
    // four days before this existed). Record it so the sweep gives up and the
    // Connections UI can ask for a reconnect instead of failing silently.
    if (body.error === "bad_refresh_token") markRefreshDead(key, error);
    return false;
  }
  // Re-read inside the write to keep the window for clobbering a concurrent
  // connect as small as possible (single-process, so this is belt only).
  const store = readStore();
  const current = store.users[key];
  if (!current) return false;
  const { refreshFailedAt: _cleared, ...kept } = current;
  store.users[key] = {
    ...kept,
    token: body.access_token,
    ...grantExpiryFields(body),
  };
  writeStore(store);
  audit({ kind: "github_auth_refresh", login });
  return true;
}

/** One sweep: refresh every stored token that expires inside the skew window.
 *  Kept cheap (no-op for legacy tokens and far-from-expiry ones) so it can
 *  run on boot and on a short interval. */
export async function refreshExpiringGithubTokens(): Promise<void> {
  // Gate on the App credentials the refresh grant itself needs, NOT on web
  // sign-in. A personal App in simple mode keeps userPrAuth (and so
  // githubUserAuthActive) off, yet still mints ~8h user-to-server tokens and
  // stores a client secret for exactly this refresh. Bailing on
  // githubUserAuthActive() left those tokens to expire and drop out of
  // soleGithubAccount() until a manual reconnect.
  const { clientId, clientSecret } = githubUserAuthSettings();
  if (!clientId || !clientSecret) return;
  for (const account of Object.values(readStore().users)) {
    if (!account.refreshToken || !account.expiresAt) continue;
    if (account.refreshFailedAt) continue; // dead grant — only a reconnect fixes it
    if (Date.parse(account.expiresAt) - Date.now() > REFRESH_SKEW_MS) continue;
    try {
      await refreshGithubToken(account.login);
    } catch {
      // transient (GitHub unreachable) — next sweep retries
    }
  }
}

/** Ticker parked on globalThis so bun --hot reloads don't stack intervals.
 *  20 min cadence + 40 min skew ⇒ a token is always refreshed well before an
 *  8h expiry; runs one sweep immediately for tokens that expired while the
 *  server was down (the refresh token lives ~6 months). */
const REFRESH_TICK_MS = 20 * 60_000;
/**
 * Arm the refresher. Called once from opensession.ts's boot block.
 *
 * Never at module scope, and never from a second process: a refresh ROTATES
 * the shared refresh-token string, so anything racing the server's ticker
 * invalidates the user's grant (dead until they reconnect). This module is
 * imported by pi-runner, pi-runner, web-auth and half the routes, so at
 * module scope every run host, script and one-off bun process rotated live
 * grants the moment it started. Dev instances skip it for the same reason.
 */
export function startGithubTokenRefresher(): void {
  const g = globalThis as any;
  if (isDevInstance()) return;
  if (g.__osGithubTokenRefresher) clearInterval(g.__osGithubTokenRefresher);
  g.__osGithubTokenRefresher = setInterval(() => {
    void refreshExpiringGithubTokens();
  }, REFRESH_TICK_MS);
  void refreshExpiringGithubTokens();
}

// ── Store queries ────────────────────────────────────────────────────────────

/** Connected accounts, tokens stripped (UI/API safe). */
export function connectedGithubAccounts(): GithubConnectedAccount[] {
  return Object.values(readStore().users)
    .map(stripStoredAccount)
    .sort((a, b) => a.login.localeCompare(b.login));
}

// ── The reconnect gate ───────────────────────────────────────────────────────

/** Cached because the sign-in gate asks on EVERY request (opensession.ts) and
 *  the store is a file read and a JSON parse. Validated by the store's path and
 *  mtime rather than by a TTL, so it is never stale by a window: a `stat` is
 *  what a request pays, and `writeStore` clears it outright, which is what
 *  makes a reconnect take effect in the same breath rather than a beat later. */
let reconnectCache: {
  path: string;
  stamp: number;
  logins: Set<string>;
} | null = null;

function invalidateReconnectCache(): void {
  reconnectCache = null;
}

function refreshDeadLogins(): Set<string> {
  const path = storePath();
  let stamp = 0;
  try {
    stamp = statSync(path).mtimeMs;
  } catch {} // no store yet: nobody has connected, so nobody is dead
  if (reconnectCache?.path === path && reconnectCache.stamp === stamp) {
    return reconnectCache.logins;
  }
  const logins = new Set<string>();
  for (const account of Object.values(readStore().users)) {
    if (account.refreshFailedAt) logins.add(account.login.toLowerCase());
  }
  reconnectCache = { path, stamp, logins };
  return logins;
}

/**
 * This person has to authorize GitHub again before anything can act as them.
 *
 * A web session is not an independent credential: it is a 90-day cache of one
 * GitHub authorize (routes/auth.ts: "one authorize covers both"), and the
 * sign-in screen's promise is that pull requests are authored by you. Once
 * GitHub permanently rejects the refresh grant, the thing the session attests
 * to is gone, so the sign-in gate refuses it and the person goes back through
 * the flow that repairs both halves at once.
 *
 * Two limits are deliberate. Only a grant that WAS connected and is now dead
 * counts (`refreshFailedAt`); never-connected and deliberately-disconnected
 * people are a different state and are not worth blocking the app over. And it
 * fails open by construction, because `readStore` swallows an unreadable file
 * and returns no users. A GitHub outage must not lock the team out of reading
 * their own sessions. The security boundary stays downstream, where the getters
 * refuse to hand out a token that has expired.
 */
export function githubReconnectRequired(
  login: string | null | undefined,
): boolean {
  if (!login || !githubUserAuthActive()) return false;
  return refreshDeadLogins().has(login.toLowerCase());
}

export function removeGithubAccount(login: string): boolean {
  const store = readStore();
  const key = login.toLowerCase();
  if (!store.users[key]) return false;
  delete store.users[key];
  writeStore(store);
  audit({ kind: "github_auth_disconnect", login });
  return true;
}

/**
 * The GitHub login a run's user maps to IF the feature is active and that
 * person has connected — i.e. "this run authenticates as them". Null keeps
 * the bot behavior.
 */
export function githubUserLoginForRun(user?: string | null): string | null {
  if (!githubUserAuthActive()) return null;
  const key = user
    ?.trim()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/^@/, "")
    .toLowerCase();
  if (!key) return null;
  const member = configuredIdentity().team.find((candidate) => {
    const aliases =
      candidate.aliases?.map((alias) => alias.toLowerCase()) ?? [];
    return (
      candidate.github?.toLowerCase() === key ||
      candidate.slackId?.toLowerCase() === key ||
      candidate.email?.toLowerCase() === key ||
      candidate.linearEmails?.some((email) => email.toLowerCase() === key) ||
      candidate.name.toLowerCase() === key ||
      candidate.name.split(" ")[0]?.toLowerCase() === key ||
      aliases.includes(key)
    );
  });
  const login = member?.github ?? null;
  if (!login) return null;
  const account = readStore().users[login.toLowerCase()];
  return account && tokenUsable(account) ? login : null;
}

/**
 * Env for a run that should act as its owner on GitHub: GH_TOKEN (gh CLI's
 * highest-precedence credential) + GITHUB_TOKEN (octokit-style tooling).
 * Empty when the feature is off, the user is unknown/unmapped, or they never
 * connected — callers can spread it unconditionally. Callers are responsible
 * for the trust gate (interactive, non-least-privilege runs only).
 */
export function githubAuthEnv(user?: string | null): Record<string, string> {
  const credential = githubCredentialForRun(user);
  const token = credential?.env.GH_TOKEN;
  return token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {};
}

/** A remote sandbox cannot read the server's per-user grant store. Its trusted
 * launcher writes only this run's access token to a private file and points the
 * host at it. The token never enters the persisted RunHostSpec or launch command. */
export const GITHUB_RUN_AUTH_FILE_ENV = "OPENSESSION_GITHUB_RUN_AUTH_FILE";

function projectedGithubAuthEnv(): Record<string, string> {
  const path = process.env[GITHUB_RUN_AUTH_FILE_ENV];
  if (!path) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<
      string,
      unknown
    >;
    const token =
      typeof parsed.GH_TOKEN === "string"
        ? parsed.GH_TOKEN
        : typeof parsed.GITHUB_TOKEN === "string"
          ? parsed.GITHUB_TOKEN
          : "";
    return token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {};
  } catch {
    return {};
  }
}

function githubProcessEnv(
  auth: Record<string, string>,
): Record<string, string> {
  // Empty authority still rewrites GitHub SSH remotes to non-interactive HTTPS.
  // A missing projected user token must fail closed, never inherit a host key.
  return githubGitCredentialEnv(auth.GH_TOKEN || "");
}

/** Consume only the private run-scoped file projected by a remote launcher.
 * Unlike githubRunEnv(), this can never consult a connected human account. */
export function projectedGithubRunEnv(): Record<string, string> {
  return githubProcessEnv(projectedGithubAuthEnv());
}

/** GitHub environment for one interactive run. Besides the API variables, set
 * a process-local Git credential helper so HTTPS remotes can push without
 * persisting the short-lived user token in .git/config or ~/.config/gh. */
export function githubRunEnv(user?: string | null): Record<string, string> {
  const auth = githubAuthEnv(user);
  return githubProcessEnv(
    Object.keys(auth).length ? auth : projectedGithubAuthEnv(),
  );
}

export interface GithubCredential {
  kind: "service" | "user";
  /** Durable, non-secret selector. Raw tokens must never be persisted. */
  principal: string;
  /** Ephemeral child-process capability, including a process-local Git helper. */
  env: Record<string, string>;
}

export const serviceGithubCredential: GithubCredential = {
  kind: "service",
  principal: "service",
  env: {},
};

/** Materialize the operator-selected credential for server-owned gh calls.
 * Interactive user credentials pass through unchanged. */
export async function resolveGithubCredential(
  credential: GithubCredential,
  opts: { write?: boolean; repo?: string } = {},
): Promise<GithubCredential> {
  if (credential.kind !== "service" || credential.env.GH_TOKEN)
    return credential;
  const { githubToken } = await import("./github-app");
  const token = await githubToken(opts);
  if (!token)
    throw new Error("The selected GitHub bot credential is unavailable");
  return {
    ...credential,
    env: githubProcessEnv({ GH_TOKEN: token, GITHUB_TOKEN: token }),
  };
}

function credentialForAccount(account: StoredAccount): GithubCredential {
  return {
    kind: "user",
    principal: `user:${account.login.toLowerCase()}`,
    env: githubGitCredentialEnv(account.token),
  };
}

function usableAccountForLogin(login: string): StoredAccount | null {
  const account = readStore().users[login.toLowerCase()];
  return account?.token && tokenUsable(account) ? account : null;
}

/** Exact-login lookup for an already authenticated web request. */
export function githubCredentialForLogin(
  login: string,
): GithubCredential | null {
  if (!githubUserAuthActive()) return null;
  const account = usableAccountForLogin(login);
  return account ? credentialForAccount(account) : null;
}

/** Resolve the current token for a server-minted durable selector. This lookup
 * deliberately ignores the current simple/operator mode: recovery must retain
 * the exact original identity, never switch to whichever account is sole now. */
export function githubCredentialForPrincipal(
  principal?: string | null,
): GithubCredential | null {
  if (principal === "service") return serviceGithubCredential;
  if (!principal?.startsWith("user:")) return null;
  const login = principal.slice("user:".length);
  if (!login) return null;
  const account = usableAccountForLogin(login);
  return account ? credentialForAccount(account) : null;
}

/** Credential for a trusted interactive run. Callers still own the trust gate. */
export function githubCredentialForRun(
  user?: string | null,
): GithubCredential | null {
  const login = githubUserLoginForRun(user);
  if (login) {
    const account = usableAccountForLogin(login);
    return account ? credentialForAccount(account) : null;
  }
  return soleGithubAccount();
}

/** The usable stored accounts (token present and not expired). */
function usableAccounts(): StoredAccount[] {
  return Object.values(readStore().users).filter(
    (a) => a.token && tokenUsable(a),
  );
}

/**
 * The acting GitHub identity in SIMPLE MODE — one install, one user, so the
 * single connected App account IS the identity, resolved without any web session (there is none: webAuthRequired()
 * is false, so no authUser exists to scope by). Null when sign-in is active
 * (operator mode resolves by authUser via githubCredentialForLogin instead) or
 * when the usable-account count isn't exactly one — zero (nobody connected) and
 * more than one (ambiguous) both fail closed so a caller never guesses whose
 * token to act with.
 */
export function soleGithubAccount(): GithubCredential | null {
  if (githubUserAuthActive()) return null; // operator mode scopes by authUser
  const usable = usableAccounts();
  if (usable.length !== 1) return null;
  const account = usable[0]!;
  return credentialForAccount(account);
}

/** The sole connected login in simple mode (for routes that manage it by
 *  name), on the same one-account-or-nothing rule as soleGithubAccount. */
export function soleGithubLogin(): string | null {
  if (githubUserAuthActive()) return null;
  const usable = usableAccounts();
  return usable.length === 1 ? usable[0]!.login : null;
}
