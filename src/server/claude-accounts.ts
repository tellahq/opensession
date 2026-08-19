/**
 * Claude account pool for opensession runs.
 *
 * Each account is a long-lived OAuth token from `claude setup-token` (valid
 * ~1 year, tied to a Max subscription). Runs get the token injected as
 * CLAUDE_CODE_OAUTH_TOKEN in the child env, so switching accounts never
 * touches ~/.claude/.credentials.json — interactive CLI sessions on the VPS
 * keep whatever account they logged in with.
 *
 * Tokens live in ~/.opensession-claude-accounts.json (mode 0600). Usage per
 * account is polled from the OAuth usage endpoint every POLL_INTERVAL_MS and
 * kept in memory; the UI reads it via the /api/claude-accounts routes.
 */

import { homeDir } from "./paths";
import { chmodSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { writeFileAtomic } from "./shared/atomic-write";
import { userMatchesAny } from "./shared/user-mappings";
import { stateDir } from "./paths";

const HOME = homeDir();
// The env override is a test seam — bun tests point it at a temp store so they
// never read (or clobber) the real account pool. Resolved per call, not at
// module load, so the override works regardless of import order.
function storePath(): string {
  return (
    process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH ||
    stateDir("claude-accounts.json")
  );
}
// Sideline state lives beside the account store, in its own file so it can
// never corrupt the accounts themselves.
function sidelineStatePath(): string {
  return storePath().replace(/\.json$/, "-state.json");
}
// Keep this conservative: the usage endpoint rate-limits per token with
// ~hour-long lockouts (observed Retry-After of ~50m after 10-minute polling).
const POLL_INTERVAL_MS = 60 * 60 * 1000;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
// Claude Code's public OAuth client id — the one the CLI itself refreshes with.
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Refresh a credentials-file access token this long before it expires.
const TOKEN_REFRESH_SLACK_MS = 5 * 60 * 1000;
// When a run hits a limit but the usage endpoint gives no reset time,
// sideline the account for this long before retrying it.
const DEFAULT_EXHAUST_MS = 60 * 60 * 1000;
// Bridge-wedge sideline: much shorter than a usage-limit window — wedges
// usually clear once the account's proxy respawns.
const WEDGE_SIDELINE_MS = 5 * 60 * 1000;
// Treat an account as unusable for new runs at/above this 5-hour utilization.
const EXHAUSTED_UTILIZATION = 97;
// Weekly scoped caps (Fable) only sideline an account when fully spent: the
// percentage is integer-rounded and Anthropic keeps serving right up to the
// cap (verified live at 97%), and a real limit error still sidelines the
// account via markExhausted. The 5-hour buffer above stays conservative.
const SCOPED_EXHAUSTED_UTILIZATION = 100;

export interface ClaudeAccount {
  id: string;
  name: string;
  token: string;
  email?: string;
  plan?: string;
  createdAt: string;
  /**
   * Personal subscription: when set, only runs whose user resolves to this
   * person (same identity table as commit attribution / MCP allowedUsers) use
   * the account — and their runs prefer it over the shared pool, falling back
   * to the pool when it's exhausted. Unset = shared pool account, used by
   * everyone and by automations (which run with no user).
   */
  owner?: string;
  // "missing" once the usage endpoint has returned 403 for this token
  // (`claude setup-token` tokens lack the user:profile scope). Persisted so
  // we never poll such accounts again, across restarts.
  usageScope?: "missing";
  // Optional path to a full OAuth credentials file (same shape as
  // ~/.claude/.credentials.json — the snapshots `claude-plan` keeps under
  // ~/.claude/accounts/<name>/credentials.json). Login credentials carry the
  // user:profile scope that setup-tokens lack, so when set, usage is polled
  // with this file's access token instead of `token`, refreshing it via the
  // OAuth refresh flow and writing rotated tokens back to the file. Runs
  // still use `token`; this only restores usage visibility.
  credentialsPath?: string;
}

interface UsageWindow {
  utilization: number | null;
  resetsAt: string | null;
}

export interface AccountUsage {
  fetchedAt: string;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  // Per-model weekly caps (e.g. Fable) that are separate from the general
  // 5h/7-day windows — an account can be 100% on one of these while its overall
  // capacity is barely touched, which is exactly what makes it look "fine" in
  // the UI while runs on that model get turned away. `label` is the model name.
  scopedLimits?: { label: string; utilization: number | null; resetsAt: string | null }[];
  extraUsage?: { enabled: boolean; usedCredits: number; monthlyLimit: number } | null;
  // Set when the snapshot came from a live Meridian proxy's /v1/usage/quota
  // (SDK-observed rate-limit events) rather than the OAuth usage endpoint —
  // the fallback for setup-token accounts that 403 on USAGE_URL.
  source?: "meridian";
  error?: string;
  errorStatus?: number;
}

export interface ClaudeAccountPublic {
  id: string;
  name: string;
  tokenMasked: string;
  email?: string;
  plan?: string;
  createdAt: string;
  owner?: string;
  mode: "shared" | "personal";
  usage: AccountUsage | null;
  noUsageScope: boolean;
  credentialsPath?: string;
  exhaustedUntil: string | null;
  usable: boolean;
}

const usageCache = new Map<string, AccountUsage>();
// One map for both sideline scopes, keyed by exhaustionKey(id, model?): the
// same shape as codex-accounts.ts.
const exhaustedUntil = new Map<string, number>();
const lastPickedAt = new Map<string, number>();
// After a 429 from the usage endpoint, don't hit that same account again until
// this passes. The endpoint rate-limits per token; one account must not hide
// usage for every other account in the dashboard.
const usageRateLimitedUntil = new Map<string, number>();
const credentialsRefreshBlockedUntil = new Map<string, number>();
const MAX_RATE_LIMIT_WAIT_MS = 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 10 * 60 * 1000;
const FAILED_REFRESH_WAIT_MS = 60 * 60 * 1000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ── Sidelines ────────────────────────────────────────────────────────────────
// Sideline state is load-bearing for rotation (codex-accounts.ts learned this
// on 2026-07-17: a restart cleared the in-memory map and the picker
// immediately re-handed out an exhausted account), and this instance restarts
// after every backend change, so it persists across restarts AND hot reloads.
// Hydration is lazy and keyed on the resolved path because storePath() honours
// a per-call env override; a module-load read would latch the wrong file.
let sidelinesHydratedFrom: string | null = null;

function sidelines(): Map<string, number> {
  const path = sidelineStatePath();
  if (sidelinesHydratedFrom === path) return exhaustedUntil;
  sidelinesHydratedFrom = path;
  exhaustedUntil.clear();
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      const now = Date.now();
      for (const [k, until] of Object.entries(parsed?.exhaustedUntil || {})) {
        if (typeof until === "number" && until > now) exhaustedUntil.set(k, until);
      }
    }
  } catch {}
  return exhaustedUntil;
}

function persistSidelines(): void {
  try {
    const out: Record<string, number> = {};
    const now = Date.now();
    for (const [k, until] of sidelines()) if (until > now) out[k] = until;
    const path = sidelineStatePath();
    writeFileAtomic(path, JSON.stringify({ exhaustedUntil: out }) + "\n");
    chmodSync(path, 0o600);
  } catch (e) {
    console.warn("[claude-accounts] sideline persist failed:", e);
  }
}

/** Test seam: drop the in-memory sidelines and re-read them from disk, which
 *  is what a process restart does. */
export function __reloadSidelinesForTest(): void {
  sidelinesHydratedFrom = null;
  sidelines();
}

function exhaustionKey(id: string, model?: string): string {
  return model ? `${id}:${model}` : id;
}

function isExhaustionKeyActive(key: string): boolean {
  const map = sidelines();
  const until = map.get(key);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    map.delete(key);
    return false;
  }
  return true;
}

/**
 * Fresh usage data can disprove a sideline before it times out, so a poll that
 * shows headroom returns the account early. The two scopes need different
 * evidence: the account-level entry answers to the 5-hour window, while a
 * model-scoped entry answers to that model's own weekly cap, and 5-hour
 * headroom says nothing about a spent Fable week.
 */
function releaseDisprovenSidelines(
  account: ClaudeAccount,
  usage: AccountUsage,
  via = "",
): void {
  const map = sidelines();
  let changed = false;
  if (map.has(exhaustionKey(account.id))) {
    const u = usage.fiveHour?.utilization;
    if (u !== null && u !== undefined && u < EXHAUSTED_UTILIZATION) {
      map.delete(exhaustionKey(account.id));
      changed = true;
      console.log(`[claude-accounts] ${account.name} usable again (5h at ${u}%${via})`);
    }
  }
  const prefix = `${account.id}:`;
  for (const key of [...map.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const model = key.slice(prefix.length);
    const scoped = scopedLimitForModel(usage, model);
    if (scoped !== null && scoped < SCOPED_EXHAUSTED_UTILIZATION) {
      map.delete(key);
      changed = true;
      console.log(
        `[claude-accounts] ${account.name} usable again for ${model} (${scoped}%${via})`
      );
    }
  }
  if (changed) persistSidelines();
}

function fetchWithTimeout(
  url: string,
  token: string,
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
    },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
}

function readStore(): ClaudeAccount[] {
  if (!existsSync(storePath())) return [];
  try {
    const parsed = JSON.parse(readFileSync(storePath(), "utf-8"));
    return Array.isArray(parsed.accounts) ? parsed.accounts : [];
  } catch (e) {
    console.error("[claude-accounts] Failed to read store:", e);
    return [];
  }
}

function writeStore(accounts: ClaudeAccount[]): void {
  writeFileAtomic(storePath(), JSON.stringify({ accounts }, null, 2) + "\n");
  chmodSync(storePath(), 0o600);
}

export function maskToken(token: string): string {
  if (token.length <= 16) return "…";
  return `${token.slice(0, 12)}…${token.slice(-4)}`;
}

async function fetchUsage(
  token: string,
  rateLimitKey: string,
  signal?: AbortSignal,
): Promise<AccountUsage> {
  const rateLimitedUntil = usageRateLimitedUntil.get(rateLimitKey) ?? 0;
  if (Date.now() < rateLimitedUntil) {
    return {
      fetchedAt: new Date().toISOString(),
      fiveHour: null,
      sevenDay: null,
      error: `usage endpoint rate-limited, retrying after ${new Date(rateLimitedUntil).toLocaleTimeString("en-GB", { timeZone: "UTC" })} UTC`,
      errorStatus: 429,
    };
  }
  try {
    const res = await fetchWithTimeout(USAGE_URL, token, 10_000, signal);
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, MAX_RATE_LIMIT_WAIT_MS)
            : DEFAULT_RATE_LIMIT_WAIT_MS;
        usageRateLimitedUntil.set(rateLimitKey, Date.now() + waitMs);
        console.warn(`[claude-accounts] usage endpoint rate-limited for ${rateLimitKey}; backing off ${Math.round(waitMs / 60000)}m`);
      }
      return {
        fetchedAt: new Date().toISOString(),
        fiveHour: null,
        sevenDay: null,
        error: `usage endpoint returned ${res.status}`,
        errorStatus: res.status,
      };
    }
    const body: any = await res.json();
    const window = (w: any): UsageWindow | null =>
      w ? { utilization: w.utilization ?? null, resetsAt: w.resets_at ?? null } : null;
    // The `limits` array carries per-model weekly caps (kind "weekly_scoped",
    // e.g. Fable) that the top-level five_hour/seven_day fields don't expose.
    const scopedLimits = Array.isArray(body.limits)
      ? body.limits
          .filter((l: any) => l?.kind === "weekly_scoped")
          .map((l: any) => ({
            label: l?.scope?.model?.display_name || l?.scope?.surface || "scoped",
            utilization: typeof l?.percent === "number" ? l.percent : null,
            resetsAt: l?.resets_at ?? null,
          }))
      : [];
    return {
      fetchedAt: new Date().toISOString(),
      fiveHour: window(body.five_hour),
      sevenDay: window(body.seven_day),
      scopedLimits: scopedLimits.length ? scopedLimits : undefined,
      extraUsage: body.extra_usage
        ? {
            enabled: !!body.extra_usage.is_enabled,
            usedCredits: body.extra_usage.used_credits ?? 0,
            monthlyLimit: body.extra_usage.monthly_limit ?? 0,
          }
        : null,
    };
  } catch (e: any) {
    if (signal?.aborted) throw e;
    return {
      fetchedAt: new Date().toISOString(),
      fiveHour: null,
      sevenDay: null,
      error: e?.message || String(e),
    };
  }
}

// ── Meridian-observed usage (accounts blind to the OAuth endpoint) ──────────
//
// Registered by opencode-runner at module load (injection — that module
// imports this one, so the dependency can't point back). Every live
// meridian-mode opencode server exposes its proxy's GET /v1/usage/quota,
// whose SDK-observed half populates from rate-limit events on live requests
// — so it works even for `claude setup-token` accounts whose token 403s on
// USAGE_URL (usageScope "missing"). Those accounts get their usage picture
// from here instead of staying dark until a run dies on a limit error.
// Meridian reports utilization as a 0..1 fraction and resetsAt as epoch ms;
// our AccountUsage uses 0..100 and ISO strings — converted at this boundary.
type MeridianQuotaEndpoint = { accountId: string; url: string; key: string };
let meridianQuotaProvider: (() => MeridianQuotaEndpoint[]) | null = null;
export function registerMeridianQuotaProvider(fn: () => MeridianQuotaEndpoint[]): void {
  meridianQuotaProvider = fn;
}

const MERIDIAN_SCOPED_LABELS: Record<string, string> = {
  seven_day_opus: "Opus",
  seven_day_sonnet: "Sonnet",
  seven_day_fable: "Fable",
};

function meridianBucketWindow(b: any): UsageWindow {
  return {
    utilization:
      typeof b?.utilization === "number" ? Math.round(b.utilization * 1000) / 10 : null,
    resetsAt: typeof b?.resetsAt === "number" ? new Date(b.resetsAt).toISOString() : null,
  };
}

async function fetchMeridianUsage(
  accountId: string,
  signal?: AbortSignal,
): Promise<AccountUsage | null> {
  const endpoints = (meridianQuotaProvider?.() ?? []).filter((e) => e.accountId === accountId);
  for (const ep of endpoints.slice(0, 2)) {
    try {
      const res = await fetch(`${ep.url}/v1/usage/quota`, {
        headers: { "x-api-key": ep.key },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
          : AbortSignal.timeout(5_000),
      });
      if (!res.ok) continue;
      const body: any = await res.json();
      const buckets: any[] = Array.isArray(body?.buckets) ? body.buckets : [];
      const has = (b: any) => typeof b?.utilization === "number";
      const fiveHour = buckets.find((b) => b?.type === "five_hour");
      const sevenDay = buckets.find((b) => b?.type === "seven_day");
      const scoped = buckets
        .filter((b) => typeof b?.type === "string" && b.type.startsWith("seven_day_") && has(b))
        .map((b) => ({
          label:
            MERIDIAN_SCOPED_LABELS[b.type] || b.type.slice("seven_day_".length).replace(/_/g, " "),
          ...meridianBucketWindow(b),
        }));
      // Nothing observed yet (fresh server, no requests served) — not a snapshot.
      if (!has(fiveHour) && !has(sevenDay) && !scoped.length) continue;
      return {
        fetchedAt: new Date().toISOString(),
        fiveHour: has(fiveHour) ? meridianBucketWindow(fiveHour) : null,
        sevenDay: has(sevenDay) ? meridianBucketWindow(sevenDay) : null,
        scopedLimits: scoped.length ? scoped : undefined,
        extraUsage: body?.extraUsage
          ? {
              enabled: !!body.extraUsage.isEnabled,
              usedCredits: body.extraUsage.usedCredits ?? 0,
              monthlyLimit: body.extraUsage.monthlyLimit ?? 0,
            }
          : null,
        source: "meridian",
      };
    } catch {
      if (signal?.aborted) return null;
      // Server died between listing and fetch, or timed out — try the next.
    }
  }
  return null;
}

/** Best-effort usage refresh from a live Meridian proxy, for accounts whose
 *  own token can't read the OAuth usage endpoint. Mirrors refreshAccountUsage's
 *  exhausted-clear so a sidelined blind account comes back once observed
 *  utilization drops. */
async function refreshMeridianUsage(
  account: ClaudeAccount,
  signal?: AbortSignal,
): Promise<void> {
  const usage = await fetchMeridianUsage(account.id, signal);
  if (!usage) return;
  usageCache.set(account.id, usage);
  releaseDisprovenSidelines(account, usage, " via meridian");
}

async function fetchProfile(token: string): Promise<{ email?: string; plan?: string }> {
  try {
    const res = await fetchWithTimeout(PROFILE_URL, token);
    if (!res.ok) return {};
    const body: any = await res.json();
    return {
      email: body.account?.email || undefined,
      plan: body.organization?.rate_limit_tier || body.organization?.organization_type || undefined,
    };
  } catch {
    return {};
  }
}

interface OauthCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function readCredsFile(path: string): OauthCreds | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf-8"))?.claudeAiOauth;
    if (!o?.accessToken || !o?.refreshToken) return null;
    return {
      accessToken: o.accessToken,
      refreshToken: o.refreshToken,
      expiresAt: Number(o.expiresAt) || 0,
    };
  } catch (e) {
    console.warn(`[claude-accounts] Failed to read credentials file ${path}:`, e);
    return null;
  }
}

/**
 * Refresh the access token in a credentials file, writing rotated tokens
 * back (Anthropic rotates refresh tokens on use — the write-back is what
 * keeps the file usable for the next refresh, ours or `claude-plan`'s).
 *
 * Concurrent callers for the same file coalesce onto one in-flight refresh:
 * two simultaneous refreshes would both spend the same refresh token, and the
 * loser's rotation can invalidate the whole token family (that's one way the
 * usage login gets "lost"). For files shared with other writers (claude-plan
 * snapshots), the file is also re-read just before the network call — if the
 * cron rotated it moments ago, we use its fresh tokens instead of burning the
 * stale ones we were called with.
 */
const credsRefreshInFlight = new Map<string, Promise<OauthCreds | null>>();

function refreshCredsFile(path: string, creds: OauthCreds): Promise<OauthCreds | null> {
  const inFlight = credsRefreshInFlight.get(path);
  if (inFlight) return inFlight;
  const p = doRefreshCredsFile(path, creds).finally(() => credsRefreshInFlight.delete(path));
  credsRefreshInFlight.set(path, p);
  return p;
}

async function doRefreshCredsFile(path: string, staleCreds: OauthCreds): Promise<OauthCreds | null> {
  const blockedUntil = credentialsRefreshBlockedUntil.get(path) ?? 0;
  if (Date.now() < blockedUntil) return null;
  const creds = readCredsFile(path) ?? staleCreds;
  if (creds.expiresAt > Date.now() + TOKEN_REFRESH_SLACK_MS) return creds;
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        res.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, MAX_RATE_LIMIT_WAIT_MS)
          : res.status === 429
            ? DEFAULT_RATE_LIMIT_WAIT_MS
            : FAILED_REFRESH_WAIT_MS;
      credentialsRefreshBlockedUntil.set(path, Date.now() + waitMs);
      console.warn(`[claude-accounts] Token refresh for ${path} failed: HTTP ${res.status}`);
      return null;
    }
    const body: any = await res.json();
    if (!body?.access_token) return null;
    const next: OauthCreds = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || creds.refreshToken,
      expiresAt: Date.now() + (Number(body.expires_in) || 28_800) * 1000,
    };
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.claudeAiOauth = { ...raw.claudeAiOauth, ...next };
    writeFileAtomic(path, JSON.stringify(raw, null, 2) + "\n");
    chmodSync(path, 0o600);
    credentialsRefreshBlockedUntil.delete(path);
    return next;
  } catch (e) {
    credentialsRefreshBlockedUntil.set(path, Date.now() + DEFAULT_RATE_LIMIT_WAIT_MS);
    console.warn(`[claude-accounts] Token refresh for ${path} failed:`, e);
    return null;
  }
}

/**
 * The token to poll usage with, and where it came from. Prefers the
 * credentials file (login scope) when configured, falling back to the
 * setup-token unless that's already known to lack the usage scope.
 */
async function usageToken(
  account: ClaudeAccount,
  signal?: AbortSignal,
): Promise<{ token: string; source: "credentials" | "setup-token" } | { error: string } | null> {
  if (account.credentialsPath) {
    const creds = readCredsFile(account.credentialsPath);
    if (creds) {
      if (creds.expiresAt > Date.now() + TOKEN_REFRESH_SLACK_MS) {
        return { token: creds.accessToken, source: "credentials" };
      }
      if (signal?.aborted) return null;
      const refresh = refreshCredsFile(account.credentialsPath, creds);
      const fresh = signal
        ? await new Promise<OauthCreds | null>((resolve) => {
            const aborted = () => resolve(null);
            signal.addEventListener("abort", aborted, { once: true });
            void refresh.then((value) => {
              signal.removeEventListener("abort", aborted);
              resolve(value);
            });
          })
        : await refresh;
      if (signal?.aborted) return null;
      if (fresh) return { token: fresh.accessToken, source: "credentials" };
      // Refresh failed but the stored token may still have a few minutes left.
      if (creds.expiresAt > Date.now()) {
        return { token: creds.accessToken, source: "credentials" };
      }
      const blockedUntil = credentialsRefreshBlockedUntil.get(account.credentialsPath) ?? 0;
      if (Date.now() < blockedUntil) {
        return {
          error: `OAuth token refresh is cooling down after a failed refresh; retrying after ${new Date(blockedUntil).toLocaleTimeString("en-GB", { timeZone: "UTC" })} UTC.`,
        };
      }
      return {
        error:
          "OAuth credentials expired and refresh failed. Reconnect usage from Settings → Usage (account menu → Sign in with Claude), or re-login on the VPS and update the credentials path.",
      };
    }
    return { error: `Couldn't read OAuth credentials at ${account.credentialsPath}` };
  }
  if (account.usageScope === "missing") return null;
  return { token: account.token, source: "setup-token" };
}

/** Persist that this account's token can't read the usage endpoint. */
function markUsageScopeMissing(id: string): void {
  const accounts = readStore();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx === -1 || accounts[idx].usageScope === "missing") return;
  accounts[idx] = { ...accounts[idx], usageScope: "missing" };
  writeStore(accounts);
  console.log(`[claude-accounts] ${accounts[idx].name} token lacks user:profile scope; usage polling disabled`);
}

/** Refresh cached usage for one account; clears exhausted state once reset has passed. */
async function refreshAccountUsage(
  account: ClaudeAccount,
  signal?: AbortSignal,
): Promise<AccountUsage | null> {
  const tok = await usageToken(account, signal);
  if (!tok) return null;
  if ("error" in tok) {
    // Broken usage credentials: keep the actionable error (the account-health
    // monitor's owner DMs key off it) but fill the windows from a live
    // Meridian proxy when one is running, so the picker and UI still see
    // real utilization instead of nothing.
    const observed = await fetchMeridianUsage(account.id, signal);
    const usage = {
      ...(observed ?? { fetchedAt: new Date().toISOString(), fiveHour: null, sevenDay: null }),
      error: tok.error,
    };
    usageCache.set(account.id, usage);
    return usage;
  }
  const cached = usageCache.get(account.id);

  const usage = await fetchUsage(tok.token, account.id, signal);
  if (usage.errorStatus === 403) {
    // Only a setup-token 403 means the scope is permanently missing; a 403
    // on login credentials would be an anomaly worth surfacing, not latching.
    if (tok.source === "setup-token") {
      markUsageScopeMissing(account.id);
      usageCache.delete(account.id);
      return null;
    }
  }
  // On a transient failure (rate limit, 5xx, timeout), keep showing the last
  // good snapshot instead of blanking it with an error.
  if (usage.error && cached && !cached.error) return cached;
  usageCache.set(account.id, usage);

  if (!usage.error) releaseDisprovenSidelines(account, usage);
  return usage;
}

export async function refreshAllUsage(): Promise<void> {
  // Sequential, not Promise.all — the endpoint rate-limits aggressively and a
  // burst of N simultaneous requests from one IP makes that worse.
  for (const account of readStore()) {
    if (account.usageScope === "missing" && !account.credentialsPath) {
      // Blind to the OAuth endpoint — Meridian-observed fallback (local, cheap).
      await refreshMeridianUsage(account);
      continue;
    }
    await refreshAccountUsage(account);
  }
}

export function startUsagePoller(): void {
  if (pollTimer) return;
  const accounts = readStore();
  if (accounts.length > 0) {
    void refreshAllUsage();
  }
  pollTimer = setInterval(() => {
    void refreshAllUsage().catch((e) => console.error("[claude-accounts] Poll failed:", e));
  }, POLL_INTERVAL_MS);
  console.log(`[claude-accounts] Usage poller started (${accounts.length} account(s), every ${POLL_INTERVAL_MS / 60000}m)`);
}

function isExhausted(id: string): boolean {
  return isExhaustionKeyActive(exhaustionKey(id));
}

function isModelExhausted(id: string, model?: string): boolean {
  if (!model) return false;
  return isExhaustionKeyActive(exhaustionKey(id, model));
}

/**
 * Whether this account can keep running past its subscription limits by
 * billing usage-credits: extra usage is turned on (at claude.ai) and the
 * monthly credit cap isn't spent yet. A monthlyLimit of 0 counts as no
 * headroom — this gate exists to bound spend, so it fails closed.
 */
function hasCreditHeadroom(a: ClaudeAccount): boolean {
  const extra = usageCache.get(a.id)?.extraUsage;
  return !!extra?.enabled && extra.monthlyLimit > 0 && extra.usedCredits < extra.monthlyLimit;
}

// Model families that can carry their own weekly cap, matched against the
// scoped-limit labels (OAuth `display_name` like "Fable", or the label mapped
// from Meridian's seven_day_* window types). Mythos rides the Fable tier.
const SCOPED_MODEL_FAMILIES = ["fable", "opus", "sonnet", "haiku"];

function scopedEntryForModel(
  usage: AccountUsage | undefined,
  model?: string
): { label: string; utilization: number | null; resetsAt: string | null } | null {
  if (!usage?.scopedLimits?.length || !model) return null;
  const m = model.toLowerCase();
  const family = m.includes("mythos")
    ? "fable"
    : SCOPED_MODEL_FAMILIES.find((f) => m.includes(f));
  if (!family) return null;
  return usage.scopedLimits.find((l) => l.label.toLowerCase().includes(family)) ?? null;
}

/**
 * Cached utilization, unless the window's own resetsAt has already passed —
 * then the cache is provably stale (the window rolled since the last poll)
 * and the real utilization restarted near zero. Without this, an account
 * sidelined at 97%+ stays out of the pool for up to a full POLL_INTERVAL_MS
 * after its window resets, which is what let a dry pool cascade for hours.
 */
function currentUtilization(
  w: { utilization: number | null; resetsAt: string | null } | null | undefined
): number {
  if (!w) return 0;
  if (w.resetsAt) {
    const t = Date.parse(w.resetsAt);
    if (Number.isFinite(t) && t <= Date.now()) return 0;
  }
  return w.utilization ?? 0;
}

function scopedLimitForModel(usage: AccountUsage | undefined, model?: string): number | null {
  const entry = scopedEntryForModel(usage, model);
  if (!entry) return null;
  if (entry.utilization === null) return null;
  return currentUtilization(entry);
}

export type ClaudeModelRequirement = string | readonly string[];

function requiredModels(model?: ClaudeModelRequirement): Array<string | undefined> {
  if (Array.isArray(model)) {
    const unique = [...new Set(model.filter(Boolean))];
    return unique.length ? unique : [undefined];
  }
  return [model as string | undefined];
}

function accountUtilization(a: ClaudeAccount, model?: ClaudeModelRequirement): number {
  const usage = usageCache.get(a.id);
  // Meridian reconstructs these windows from SDK rate-limit events. They are
  // useful telemetry, but not authoritative account state: its scoped bucket
  // can remain at 100% after the real Claude account has reset, even while
  // live turns succeed. Actual provider limit errors still call markExhausted.
  if (usage?.source === "meridian") return 0;
  const fiveHour = currentUtilization(usage?.fiveHour);
  return Math.max(
    fiveHour,
    ...requiredModels(model).map((required) => scopedLimitForModel(usage, required) ?? 0)
  );
}

/**
 * `allowExtraUsage` (per-run policy, e.g. an automation's usageCredits flag)
 * lets an account stay usable past the utilization ceiling as long as it has
 * usage-credits headroom — that's what "keep running on credits" means at the
 * picker layer. Run-observed exhaustion (a limit error from an actual run)
 * still sidelines it: that error only happens when credits are unavailable too.
 */
function isAccountUsableFor(
  a: ClaudeAccount,
  model?: ClaudeModelRequirement,
  allowExtraUsage?: boolean
): boolean {
  if (isExhausted(a.id)) return false;
  const models = requiredModels(model);
  if (models.some((required) => isModelExhausted(a.id, required))) return false;
  const usage = usageCache.get(a.id);
  // A multi-model Dial turn must be able to run its scarce Fable oracle, not
  // merely its main model. Fail closed when Fable headroom is unknown or
  // capped: otherwise a blind/inferred account gets picked, the main turn
  // starts, and the later oracle request hangs instead of allowing the whole
  // preset to fall through to Sol before any work begins. Standalone model
  // picks retain the tolerant Meridian policy below.
  if (
    Array.isArray(model) &&
    models.length > 1 &&
    models.some((required) => required?.includes("fable"))
  ) {
    const fable = scopedLimitForModel(usage, "claude-fable-5");
    if (fable === null || fable >= SCOPED_EXHAUSTED_UTILIZATION) {
      return !!allowExtraUsage && hasCreditHeadroom(a);
    }
  }
  // See accountUtilization: inferred Meridian percentages must not sideline a
  // healthy account before the provider gets a chance to accept the request.
  if (usage?.source === "meridian") return true;
  const fiveHour = currentUtilization(usage?.fiveHour);
  const scopedUsable = models.every((required) => {
    const scoped = scopedLimitForModel(usage, required);
    return scoped === null || scoped < SCOPED_EXHAUSTED_UTILIZATION;
  });
  if (fiveHour < EXHAUSTED_UTILIZATION && scopedUsable) {
    return true;
  }
  return !!allowExtraUsage && hasCreditHeadroom(a);
}

function toPublic(a: ClaudeAccount): ClaudeAccountPublic {
  const usage = usageCache.get(a.id) || null;
  const until = sidelines().get(exhaustionKey(a.id));
  const fiveHour = usage?.fiveHour?.utilization ?? null;
  return {
    id: a.id,
    name: a.name,
    tokenMasked: maskToken(a.token),
    email: a.email,
    plan: a.plan,
    createdAt: a.createdAt,
    owner: a.owner,
    mode: a.owner ? "personal" : "shared",
    usage,
    noUsageScope: a.usageScope === "missing" && !a.credentialsPath,
    credentialsPath: a.credentialsPath,
    exhaustedUntil: until !== undefined && until > Date.now() ? new Date(until).toISOString() : null,
    usable:
      !isExhausted(a.id) &&
      (usage?.source === "meridian" || fiveHour === null || fiveHour < EXHAUSTED_UTILIZATION),
  };
}

export function listAccountsPublic(): ClaudeAccountPublic[] {
  return readStore().map(toPublic);
}

/**
 * A session can pin a specific subscription (see NativeSessionFile.accountId).
 * Return it when it exists and is currently usable for `model`; undefined when
 * it's gone or exhausted, so the caller falls back to the normal pool pick
 * (a pin is a preference, never a hard requirement that could wedge a run).
 *
 * Owner-BLIND on purpose: this answers "is this account usable", not "may this
 * run use it". Never compose it into a selector by itself — a personal
 * subscription would then serve someone else's run. Selectors go through
 * resolveAccount, which applies the owner gate on every path.
 */
export function getUsableAccountById(
  id: string,
  model?: ClaudeModelRequirement,
  allowExtraUsage?: boolean
): ClaudeAccount | undefined {
  const a = readStore().find((x) => x.id === id);
  return a && isAccountUsableFor(a, model, allowExtraUsage) ? a : undefined;
}

/** The raw account record, usable or not — for validating pins and telling a
 *  deleted account apart from an exhausted one. */
export function getAccountById(id: string): ClaudeAccount | undefined {
  return readStore().find((x) => x.id === id);
}

export function hasAccounts(): boolean {
  return readStore().length > 0;
}

export async function addAccount(
  name: string,
  token: string,
  owner?: string,
  credentialsPath?: string
): Promise<ClaudeAccountPublic | { error: string }> {
  const trimmedName = name.trim();
  // Strip ALL whitespace, not just the ends — a token copied from the
  // `claude setup-token` terminal output often arrives with line-wrap
  // newlines in the middle.
  const trimmedToken = token.replace(/\s+/g, "");
  const trimmedOwner = owner?.trim() || undefined;
  const trimmedCredentialsPath = credentialsPath?.trim() || undefined;
  if (!trimmedName) return { error: "Name is required" };
  if (!/^sk-ant-/.test(trimmedToken)) {
    return { error: "Token doesn't look like a Claude OAuth token (expected sk-ant-…). Generate one with `claude setup-token`." };
  }
  const accounts = readStore();
  if (accounts.some((a) => a.name === trimmedName)) {
    return { error: `An account named "${trimmedName}" already exists` };
  }
  if (accounts.some((a) => a.token === trimmedToken)) {
    return { error: "This token is already registered" };
  }

  // Best-effort validation via the usage endpoint. Only a 401 proves the
  // token is bad: `claude setup-token` tokens get a 403 here (no user:profile
  // scope) and the endpoint 429s aggressively — neither means the token can't
  // run Claude Code.
  const usage = await fetchUsage(trimmedToken, `add:${trimmedName}`);
  if (usage.errorStatus === 401) {
    return { error: `Token validation failed: ${usage.error}` };
  }
  if (usage.error) {
    console.warn(`[claude-accounts] Adding ${trimmedName} without usage validation: ${usage.error}`);
  }
  const profile = await fetchProfile(trimmedToken);

  const account: ClaudeAccount = {
    id: crypto.randomUUID(),
    name: trimmedName,
    token: trimmedToken,
    email: profile.email,
    plan: profile.plan,
    createdAt: new Date().toISOString(),
    ...(trimmedOwner ? { owner: trimmedOwner } : {}),
    ...(trimmedCredentialsPath ? { credentialsPath: trimmedCredentialsPath } : {}),
    ...(usage.errorStatus === 403 ? { usageScope: "missing" as const } : {}),
  };
  writeStore([...accounts, account]);
  if (!usage.error) usageCache.set(account.id, usage);
  console.log(
    `[claude-accounts] Added account ${trimmedName} (${profile.email || "unknown email"})${trimmedOwner ? ` — personal sub of ${trimmedOwner}` : " — shared pool"}`
  );
  return toPublic(account);
}

/**
 * Seed the pool from the environment or a staged file, for unattended
 * installs (cloud-init, the install harness, "paste this into an agent").
 * Order: OPENSESSION_CLAUDE_TOKEN, then ~/.opensession-claude-token (one
 * line, written 0600 by the installer). A token already in the store is
 * left alone; the file is removed once imported so the secret lives in one
 * place. Called from the boot block, never at import.
 */
export async function seedAccountFromEnvOrFile(): Promise<void> {
  const filePath = join(homeDir(), ".opensession-claude-token");
  let token = (process.env.OPENSESSION_CLAUDE_TOKEN || "").replace(/\s+/g, "");
  let source = token ? "OPENSESSION_CLAUDE_TOKEN" : "";
  if (!token && existsSync(filePath)) {
    try {
      token = readFileSync(filePath, "utf8").replace(/\s+/g, "");
      source = filePath;
    } catch {}
  }
  if (!token) return;
  if (readStore().some((a) => a.token === token)) {
    if (source === filePath) rmSync(filePath, { force: true });
    return;
  }
  const result = await addAccount("default", token);
  if ("error" in result) {
    console.error(`[claude-accounts] could not import the token from ${source}: ${result.error}`);
    return;
  }
  console.log(`[claude-accounts] imported the Claude token from ${source} into the shared pool`);
  if (source === filePath) rmSync(filePath, { force: true });
}

/** Set or clear (empty/undefined) an account's personal owner. */
export function setAccountOwner(
  id: string,
  owner: string | undefined,
  credentialsPath?: string | undefined
): ClaudeAccountPublic | null {
  const accounts = readStore();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const trimmed = owner?.trim() || undefined;
  const next = { ...accounts[idx] };
  if (trimmed) next.owner = trimmed;
  else delete next.owner;
  if (credentialsPath !== undefined) {
    const trimmedPath = credentialsPath.trim();
    if (trimmedPath) next.credentialsPath = trimmedPath;
    else delete next.credentialsPath;
    usageCache.delete(id);
    if (accounts[idx].credentialsPath) credentialsRefreshBlockedUntil.delete(accounts[idx].credentialsPath);
    if (trimmedPath) credentialsRefreshBlockedUntil.delete(trimmedPath);
  }
  accounts[idx] = next;
  writeStore(accounts);
  console.log(
    `[claude-accounts] ${next.name} is now ${trimmed ? `the personal sub of ${trimmed}` : "a shared pool account"}`
  );
  return toPublic(next);
}

/**
 * Attach freshly minted usage OAuth credentials (see claude-oauth-login.ts)
 * to an account: point credentialsPath at the opensession-owned file, clear
 * any latched usageScope "missing" (the login token CAN read the usage
 * endpoint), adopt the sign-in email when the account had none, and kick an
 * immediate usage refresh so the UI fills in without waiting for the poller.
 */
export function setAccountUsageCredentials(
  id: string,
  path: string,
  email?: string
): ClaudeAccountPublic | null {
  const accounts = readStore();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const next: ClaudeAccount = { ...accounts[idx], credentialsPath: path };
  delete next.usageScope;
  if (email && !next.email) next.email = email;
  accounts[idx] = next;
  writeStore(accounts);
  usageCache.delete(id);
  credentialsRefreshBlockedUntil.delete(path);
  void refreshAccountUsage(next);
  return toPublic(next);
}

export function removeAccount(id: string): boolean {
  const accounts = readStore();
  const next = accounts.filter((a) => a.id !== id);
  if (next.length === accounts.length) return false;
  writeStore(next);
  usageCache.delete(id);
  const map = sidelines();
  map.delete(exhaustionKey(id));
  for (const key of [...map.keys()]) {
    if (key.startsWith(`${id}:`)) map.delete(key);
  }
  persistSidelines();
  return true;
}

/**
 * Pick the best account for a new run.
 *
 * Personal subs first: when `user` is set and owns accounts (matched through
 * the same identity table as commit attribution), the least-used of those
 * wins — the shared pool is their backup once the personal sub is exhausted
 * or sidelined. Runs with no `user` (automations) and users with no personal
 * sub draw from the pool (owner-less accounts) only; another user's personal
 * account is never eligible.
 *
 * Within each group: lowest cached 5-hour utilization wins, but accounts in
 * the same 10%-utilization bucket round-robin on least-recently-picked. (The
 * usage cache refreshes every poll interval, so without the tiebreak
 * concurrent runs between polls would all pile onto one account.) Returns
 * undefined when nothing eligible is configured or all of it is sidelined.
 */
function selectAccount(
  exclude?: Set<string>,
  user?: string,
  model?: ClaudeModelRequirement,
  allowExtraUsage?: boolean,
  recordPick = true,
): ClaudeAccount | undefined {
  const eligible = readStore().filter(
    (a) => !exclude?.has(a.id) && isAccountUsableFor(a, model, allowExtraUsage)
  );
  const best = (list: ClaudeAccount[]): ClaudeAccount | undefined =>
    list
      .map((a) => ({
        a,
        bucket: Math.floor(accountUtilization(a, model) / 10),
        picked: lastPickedAt.get(a.id) ?? 0,
      }))
      // Credit-headroom accounts sort by their (high) utilization bucket, so
      // subscription capacity is always drained before paid credits.
      .filter(({ a, bucket }) => bucket * 10 < EXHAUSTED_UTILIZATION || (!!allowExtraUsage && hasCreditHeadroom(a)))
      .sort((x, y) => x.bucket - y.bucket || x.picked - y.picked)[0]?.a;
  const personal = user
    ? best(eligible.filter((a) => a.owner && userMatchesAny(user, [a.owner])))
    : undefined;
  const picked = personal ?? best(eligible.filter((a) => !a.owner));
  if (picked && recordPick) lastPickedAt.set(picked.id, Date.now());
  return picked;
}

export function pickAccount(
  exclude?: Set<string>,
  user?: string,
  model?: ClaudeModelRequirement,
  allowExtraUsage?: boolean,
): ClaudeAccount | undefined {
  return selectAccount(exclude, user, model, allowExtraUsage, true);
}

/** Non-mutating availability probe for dispatch circuit breakers. It uses the
 * exact picker eligibility rules without consuming the round-robin turn. */
export function peekAccount(
  exclude?: Set<string>,
  user?: string,
  model?: ClaudeModelRequirement,
  allowExtraUsage?: boolean,
): ClaudeAccount | undefined {
  return selectAccount(exclude, user, model, allowExtraUsage, false);
}

/** Which step of the ordered policy produced the account — for callers that
 *  log or report the route a run authenticated by. */
export type PickReason = "pinned" | "sticky" | "designated" | "personal" | "pool";

/**
 * Why nothing could serve, structured rather than worded. The engine runners
 * classify usage-limit shapes by substring against their OWN messages
 * (isPiUsageLimitShape in pi-runner.ts keys on "no designated bridge account"
 * and "no usable claude account"), and a config problem must stay
 * distinguishable from exhaustion, so the phrasing belongs to each caller and
 * this layer must never normalize it.
 */
export type AccountRefusal =
  | { kind: "none-configured" }
  | { kind: "pool-dry" }
  | { kind: "pin-unusable"; pinnedId: string; pinName: string }
  | { kind: "pin-not-designated"; pinnedId: string; pinName: string }
  | { kind: "designated-dry"; tried: string };

export type AccountResolution =
  | { account: ClaudeAccount; reason: PickReason }
  | { refusal: AccountRefusal };

export interface AccountRequest {
  /** Run user, matched against `owner` through the same identity table as
   *  commit attribution. Absent = an automation: pool accounts only. */
  user?: string;
  model?: ClaudeModelRequirement;
  /** The session's pinned subscription (NativeSessionFile.accountId). */
  pinnedId?: string;
  /** Hard pin: refuse instead of continuing down the order. */
  strictPin?: boolean;
  /** The account this session is already on — its running engine server, or
   *  the account whose isolated config dir owns the conversation being
   *  resumed. Preferred so a turn doesn't respawn/replay for nothing. */
  stickyId?: string;
  /** When non-empty, ONLY these accounts may serve, walked in list order. */
  designatedIds?: readonly string[];
  allowExtraUsage?: boolean;
  /** Accounts this caller has already burned THIS turn, skipped on every path
   *  (pin, sticky, designated, pool). An in-turn account walk needs this on
   *  top of the sideline, because some refusals deliberately do not sideline:
   *  the pi provider's rolling hourly cap is local admission control that
   *  frees within the hour, and its sideline map is shared with opencode, so
   *  it must never bench a healthy account cross-engine. Without an explicit
   *  exclusion the re-pick hands back the account that just refused. */
  excludeIds?: readonly string[];
  /** false = peek: judge eligibility without consuming the round-robin turn. */
  recordPick?: boolean;
}

/**
 * The ordered account policy, in one place: pin → sticky → designated → pool,
 * with the owner gate on EVERY path. A personal subscription (`owner` set)
 * only ever serves runs whose user resolves to that person — including when
 * it is pinned, sticky, or named in `designatedIds` — and runs with no user
 * (automations) only ever see shared pool accounts. Fail closed, the same
 * rule accountsForRemoteUpload applies to off-box uploads.
 */
export function resolveAccount(req: AccountRequest): AccountResolution {
  const { user, model, allowExtraUsage } = req;
  const ids = req.designatedIds;
  const ownedByUser = (a: ClaudeAccount) =>
    !a.owner || (!!user && userMatchesAny(user, [a.owner]));
  const designated = (id: string) => !ids?.length || ids.includes(id);
  const nameOf = (id: string) => getAccountById(id)?.name || id;
  const excluded = req.excludeIds?.length ? new Set(req.excludeIds) : undefined;
  const usableForRun = (id: string): ClaudeAccount | undefined => {
    if (excluded?.has(id)) return undefined;
    const a = getUsableAccountById(id, model, allowExtraUsage);
    return a && ownedByUser(a) ? a : undefined;
  };

  if (req.pinnedId) {
    if (!designated(req.pinnedId)) {
      if (req.strictPin) {
        return {
          refusal: {
            kind: "pin-not-designated",
            pinnedId: req.pinnedId,
            pinName: nameOf(req.pinnedId),
          },
        };
      }
      // Non-strict pin outside the designation: ignore it, walk the list.
    } else {
      const pinned = usableForRun(req.pinnedId);
      if (pinned) return { account: pinned, reason: "pinned" };
      if (req.strictPin) {
        return {
          refusal: {
            kind: "pin-unusable",
            pinnedId: req.pinnedId,
            pinName: nameOf(req.pinnedId),
          },
        };
      }
    }
  }
  if (req.stickyId && designated(req.stickyId)) {
    const sticky = usableForRun(req.stickyId);
    if (sticky) return { account: sticky, reason: "sticky" };
  }
  if (ids?.length) {
    for (const id of ids) {
      const a = usableForRun(id);
      if (a) return { account: a, reason: "designated" };
    }
    return { refusal: { kind: "designated-dry", tried: ids.map(nameOf).join(", ") } };
  }
  const picked = selectAccount(excluded, user, model, allowExtraUsage, req.recordPick ?? true);
  if (picked) return { account: picked, reason: picked.owner ? "personal" : "pool" };
  return { refusal: hasAccounts() ? { kind: "pool-dry" } : { kind: "none-configured" } };
}

/**
 * The subset of the account store a specific run is allowed to see off-box —
 * used by the remote-sandbox launcher (src/server/sandbox/adapters/bootstrap.ts)
 * to upload a SCOPED pool file instead of the whole store: other people's
 * personal subscriptions must never land on third-party compute.
 *
 * Rules (mirrors pickAccount's personal-first/pool-fallback eligibility):
 *  - `accountId` pinned and usable by this run (shared pool account, or the
 *    run user's own personal account) → ONLY that account.
 *  - otherwise → every shared pool (owner-less) account, plus the run user's
 *    own personal accounts. Another user's personal account is never included;
 *    runs with no user (automations — refused sandboxing anyway) get pool only.
 */
export function accountsForRemoteUpload(user?: string, accountId?: string): ClaudeAccount[] {
  const allowed = (a: ClaudeAccount) => !a.owner || (!!user && userMatchesAny(user, [a.owner]));
  const all = readStore();
  if (accountId) {
    const pinned = all.find((a) => a.id === accountId);
    if (pinned && allowed(pinned)) return [pinned];
    // Pin missing or not this run's to use — fall through to the scoped set
    // (fail-closed: never widen to someone else's personal account).
  }
  return all.filter(allowed);
}

/** Test seam: inject a usage snapshot for an account (bun tests only). */
export function __setUsageCacheForTest(id: string, usage: AccountUsage): void {
  usageCache.set(id, usage);
}

// ── Near-limit steering (targeted on-demand refresh) ─────────────────────────
// The hourly poll leaves a window where an account's cached usage looks fine
// while its real 5h/scoped utilization has already hit the cap — a turn that
// starts there dies mid-run on the limit error and redoes all its work on the
// next account (2026-07-16: a 14-minute turn burned this way). Before a run
// commits to an account whose CACHED utilization is already high, spend one
// targeted usage poll so the pick decides on fresh data. Tiered staleness
// gates plus a hard per-account cooldown keep the extra polling well inside
// the endpoint's rate limits (hour-long lockouts were observed at ~6 polls/
// hour/token; this adds at most 3/hour, and only while an account is
// simultaneously near-limit and being picked for turns).
const NEAR_LIMIT_TIERS: { utilization: number; maxCacheAgeMs: number }[] = [
  { utilization: 90, maxCacheAgeMs: 5 * 60 * 1000 },
  { utilization: 75, maxCacheAgeMs: 20 * 60 * 1000 },
];
const NEAR_LIMIT_REFRESH_COOLDOWN_MS = 20 * 60 * 1000;
const nearLimitRefreshAt = new Map<string, number>();
type UsageRefresher = (
  a: ClaudeAccount,
  signal?: AbortSignal,
) => Promise<AccountUsage | null>;
let nearLimitRefresher: UsageRefresher = refreshAccountUsage;

/**
 * One bounded, targeted usage refresh for an account the picker is about to
 * commit a turn to, when its cached utilization is near the cap and the
 * snapshot is stale. Returns true when a refresh actually ran — the caller
 * should re-pick afterwards; the same account comes back unless the fresh
 * data shows it genuinely at the cap (isAccountUsableFor reads the updated
 * cache). No-op for accounts whose usage can't be polled.
 */
export async function refreshUsageIfNearLimit(
  id: string,
  model?: ClaudeModelRequirement,
  signal?: AbortSignal,
): Promise<boolean> {
  const account = readStore().find((x) => x.id === id);
  if (!account) return false;
  // Blind accounts refresh from a live Meridian proxy instead (same tier and
  // cooldown gating below — they need a prior observed snapshot to qualify).
  const blind = account.usageScope === "missing" && !account.credentialsPath;
  const cached = usageCache.get(id);
  if (!cached || cached.error) return false;
  const utilization = accountUtilization(account, model);
  const age = Date.now() - Date.parse(cached.fetchedAt);
  const tier = NEAR_LIMIT_TIERS.find((t) => utilization >= t.utilization);
  // NaN age (unparsable fetchedAt) fails the comparison → no refresh.
  if (!tier || !(age > tier.maxCacheAgeMs)) return false;
  const last = nearLimitRefreshAt.get(id) ?? 0;
  if (Date.now() - last < NEAR_LIMIT_REFRESH_COOLDOWN_MS) return false;
  if (signal?.aborted) return false;
  const refreshStartedAt = Date.now();
  nearLimitRefreshAt.set(id, refreshStartedAt);
  try {
    if (blind) await refreshMeridianUsage(account, signal);
    else await nearLimitRefresher(account, signal);
    return !signal?.aborted;
  } finally {
    if (
      signal?.aborted &&
      nearLimitRefreshAt.get(id) === refreshStartedAt
    ) {
      nearLimitRefreshAt.delete(id);
    }
  }
}

/** Test seam: replace the network refresh (null restores the real one). */
export function __setNearLimitRefresherForTest(fn: UsageRefresher | null): void {
  nearLimitRefresher = fn ?? refreshAccountUsage;
  nearLimitRefreshAt.clear();
}

/**
 * Sideline an account after a run hit its usage limit. Uses the 5-hour reset
 * time when known (refreshes usage in the background to confirm), otherwise a
 * fixed cool-off.
 */
export function markExhausted(
  id: string,
  model?: string,
  /** Reset time the account's own limit message stated, when it stated one
   *  (usageLimitResetAt in runner-shared parses it). Passed as an argument
   *  rather than imported so this module keeps its small dependency set.
   *  Only ever LENGTHENS the sideline: a weekly limit resetting in two days
   *  used to be benched for an hour, so the account returned to the pool
   *  every hour, was picked, failed, and was benched again. That made the
   *  pool look larger than it was and spent a request each time proving it. */
  statedResetAt?: number,
): void {
  const account = readStore().find((a) => a.id === id);
  const cached = usageCache.get(id);
  const scoped = scopedEntryForModel(cached, model);
  const resetsAt = scoped?.resetsAt
    ? Date.parse(scoped.resetsAt)
    : cached?.fiveHour?.resetsAt
      ? Date.parse(cached.fiveHour.resetsAt)
      : NaN;
  const cachedUntil = Number.isFinite(resetsAt) && resetsAt > Date.now()
    ? resetsAt
    : Date.now() + DEFAULT_EXHAUST_MS;
  // Attribute provider limits to the model that returned them. A bare id
  // benches the subscription for every model, even when only one independent
  // weekly bucket is spent. Callers without a model retain that account-wide
  // fallback for failures that cannot be attributed.
  const until =
    statedResetAt && statedResetAt > cachedUntil ? statedResetAt : cachedUntil;
  sidelines().set(exhaustionKey(id, model), until);
  persistSidelines();
  console.warn(
    `[claude-accounts] ${account?.name || id}${model ? ` (${model})` : ""} marked exhausted until ${new Date(until).toISOString()}`
  );
  if (account) void refreshAccountUsage(account);
}

/**
 * Briefly sideline an account whose engine bridge wedged (new provider
 * requests hang while established streams keep flowing). The wedge is
 * account-scoped — every model through the same bridge hangs — so retries and
 * other sessions' picks must land elsewhere. Account-level key: no model
 * scoping. Returns false without touching an existing longer sideline, so the
 * caller's clearWedge rollback can never shorten a usage-limit sideline.
 */
export function markWedged(id: string): boolean {
  const until = Date.now() + WEDGE_SIDELINE_MS;
  const map = sidelines();
  const existing = map.get(exhaustionKey(id));
  if (existing !== undefined && existing >= until) return false;
  const account = readStore().find((a) => a.id === id);
  map.set(exhaustionKey(id), until);
  persistSidelines();
  console.warn(
    `[claude-accounts] ${account?.name || id} sidelined until ${new Date(until).toISOString()} after a bridge wedge`
  );
  return true;
}

/** Rollback partner of markWedged for the no-alternative case: with no other
 *  account to rotate to, a same-account respawn retry beats a dry pool. Only
 *  call after markWedged returned true. */
export function clearWedge(id: string): void {
  sidelines().delete(exhaustionKey(id));
  persistSidelines();
}

// ── Dry-pool backpressure ────────────────────────────────────────────────────

/**
 * Earliest known time an account that could serve (user, model) comes back
 * into the pool: the min over every candidate's sideline timestamps and its
 * cached usage-window resets. Candidates are the shared pool plus the user's
 * own personal subs — the same set pickAccount draws from. Returns Date.now()
 * when something is usable right now, null when NO candidate exists at all
 * (none configured, or only other people's personal accounts — nothing to
 * wait for), and falls back to now + DEFAULT_EXHAUST_MS when every candidate
 * is sidelined without a known reset.
 */
export function earliestPoolReset(
  user?: string,
  model?: ClaudeModelRequirement,
  accountId?: string,
  allowExtraUsage?: boolean,
  allowedAccountIds?: string[],
): number | null {
  const now = Date.now();
  const candidates = readStore().filter(
    (a) =>
      (!accountId || a.id === accountId) &&
      (!allowedAccountIds?.length || allowedAccountIds.includes(a.id)) &&
      (!a.owner || (!!user && userMatchesAny(user, [a.owner]))),
  );
  if (candidates.length === 0) return null;
  let min: number | null = null;
  const consider = (t: number | null | undefined) => {
    if (typeof t === "number" && Number.isFinite(t) && t > now && (min === null || t < min)) {
      min = t;
    }
  };
  for (const a of candidates) {
    if (isAccountUsableFor(a, model, allowExtraUsage)) return now;
    consider(sidelines().get(exhaustionKey(a.id)));
    for (const required of requiredModels(model)) {
      if (required) {
        consider(sidelines().get(exhaustionKey(a.id, required)));
      }
    }
    const usage = usageCache.get(a.id);
    if (usage?.fiveHour?.resetsAt) consider(Date.parse(usage.fiveHour.resetsAt));
    for (const required of requiredModels(model)) {
      const scoped = scopedEntryForModel(usage, required);
      if (scoped?.resetsAt) consider(Date.parse(scoped.resetsAt));
    }
  }
  return min ?? now + DEFAULT_EXHAUST_MS;
}

/** One global throttle for the dry-pool usage refresh: many runs wait on the
 *  same dry pool at once, and the usage endpoint rate-limits aggressively —
 *  they must share one refresh, not each mint their own. */
let lastDryPoolRefreshAt = 0;
const DRY_POOL_REFRESH_MS = 5 * 60 * 1000;

async function refreshSidelinedAccounts(
  user?: string,
  model?: ClaudeModelRequirement,
  signal?: AbortSignal,
): Promise<void> {
  if (Date.now() - lastDryPoolRefreshAt < DRY_POOL_REFRESH_MS) return;
  const refreshStartedAt = Date.now();
  lastDryPoolRefreshAt = refreshStartedAt;
  try {
    for (const a of readStore()) {
      if (signal?.aborted) return;
      if (a.owner && !(user && userMatchesAny(user, [a.owner]))) continue;
      if (a.usageScope === "missing" && !a.credentialsPath) continue;
      if (isAccountUsableFor(a, model)) continue;
      // Sequential on purpose — see refreshAllUsage.
      await refreshAccountUsage(a, signal);
    }
  } finally {
    // A cancelled waiter did not complete the shared refresh; let another
    // waiter try immediately instead of suppressing everyone for five minutes.
    if (signal?.aborted && lastDryPoolRefreshAt === refreshStartedAt)
      lastDryPoolRefreshAt = 0;
  }
}

/**
 * Backpressure for a dry pool: instead of the caller aborting the run the
 * instant no account is usable (the 2026-07-14 cascade — 117 aborts in a
 * day), poll `pick` until it yields an account or the budget runs out.
 * Recovery comes from three directions while we wait: sideline timestamps
 * expire on their own, `currentUtilization` frees accounts the moment their
 * cached window's resetsAt passes, and a throttled usage refresh catches
 * early recoveries. Returns null immediately when there is nothing to wait
 * for (no candidate accounts) or the earliest known reset is beyond the
 * budget — callers should fall through to their existing failure path.
 */
export async function waitForUsableAccount(opts: {
  pick: () => ClaudeAccount | null;
  user?: string;
  model?: ClaudeModelRequirement;
  maxWaitMs: number;
  pollMs?: number;
  signal?: AbortSignal;
  accountId?: string;
  allowExtraUsage?: boolean;
  allowedAccountIds?: string[];
  onWaitStart?: (earliestReset: number) => void;
}): Promise<ClaudeAccount | null> {
  const { pick, user, model, maxWaitMs } = opts;
  if (maxWaitMs <= 0) return null;
  const reset = earliestPoolReset(
    user,
    model,
    opts.accountId,
    opts.allowExtraUsage,
    opts.allowedAccountIds,
  );
  if (reset === null) return null;
  const deadline = Date.now() + maxWaitMs;
  if (reset > deadline) return null;
  opts.onWaitStart?.(reset);
  // Jittered poll so a fleet of waiters doesn't stampede the picker (and the
  // freed account) in lockstep the moment a reset lands.
  const pollMs = opts.pollMs ?? 15_000 + Math.floor(Math.random() * 10_000);
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return null;
    await refreshSidelinedAccounts(user, model, opts.signal).catch(() => {});
    if (opts.signal?.aborted) return null;
    const picked = pick();
    if (picked) return picked;
    const remaining = deadline - Date.now();
    if (remaining <= 1000) break;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(pollMs, remaining));
      opts.signal?.addEventListener("abort", done, { once: true });
    });
  }
  return null;
}
