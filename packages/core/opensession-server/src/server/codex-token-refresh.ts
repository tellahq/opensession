/**
 * Codex (ChatGPT-subscription) token upkeep — keeps idle pool accounts'
 * OAuth tokens fresh in-process, replacing the external codex-plan-refresh
 * cron (unregistered 2026-08-06: credential refreshing should live in
 * opensession, not in side-channel crons).
 *
 * ChatGPT access tokens live ~10 days and the codex CLI only refreshes them
 * when a turn actually runs, so an idle account's token expires and every
 * OpenAI-model run on it fails until a human intervenes. This module sweeps
 * the registered CODEX_HOME accounts (kind "home") and refreshes any access
 * token inside REFRESH_AHEAD_MS of expiry via the same OAuth refresh grant
 * the CLI uses.
 *
 * OpenAI ROTATES the refresh token on every successful refresh — one rotating
 * family per login (see pi-openai-auth.ts for the full hazard writeup).
 * The rules that keep this safe:
 *  - CODEX_HOME/auth.json stays the single source of truth: we refresh with
 *    ITS refresh token and write the rotated pair straight back (atomic,
 *    0600), exactly like the CLI does. The file is re-read immediately before
 *    the network call so a concurrent CLI refresh's rotation is picked up
 *    rather than double-spent.
 *  - Refresh only near expiry (a 24h window on a ~10-day token): an account
 *    with live codex traffic is refreshed by the CLI long before we would
 *    touch it, so this effectively only ever fires for idle accounts — where
 *    there is no concurrent writer to race.
 *  - In-flight coalescing per file, and an hour's backoff after a failure so
 *    a dead refresh token doesn't get hammered (account-health alerts on it).
 */

import { chmodSync, existsSync, readFileSync } from "fs";
import { writeFileAtomic } from "./shared/atomic-write";
import { listCodexAccounts } from "./codex-accounts";
import { withCodexAuthLock } from "./codex-auth-lock";

// The Codex CLI's public OAuth client id — the same family the CLI refreshes.
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
// Access tokens last ~10 days; refresh within a day of expiry.
const REFRESH_AHEAD_MS = 24 * 60 * 60 * 1000;
const FAILED_REFRESH_WAIT_MS = 60 * 60 * 1000;

const refreshBlockedUntil = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();

/** ms-epoch expiry from a JWT's `exp` claim, or null if unparseable. */
function jwtExpMs(jwt: string): number | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf-8"),
    );
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

function readTokens(
  path: string,
): { access?: string; refresh?: string; raw: any } | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return {
      access: raw?.tokens?.access_token,
      refresh: raw?.tokens?.refresh_token,
      raw,
    };
  } catch {
    return null; // unreadable auth.json is account-health's problem, not ours
  }
}

/** Whether the file's access token is expiring soon enough to act on. */
function needsRefresh(access: string | undefined): boolean {
  if (typeof access !== "string" || !access) return false; // API-key style login
  const exp = jwtExpMs(access);
  return exp !== null && exp <= Date.now() + REFRESH_AHEAD_MS;
}

async function doRefresh(path: string, name: string): Promise<void> {
  // Re-read right before the network call: a codex turn (or a parallel
  // sweep in another process) may have refreshed — and rotated the family —
  // since the caller looked. Spending a stale refresh token here would
  // invalidate the CLI's fresh one.
  const current = readTokens(path);
  if (!current?.refresh) return;
  if (!needsRefresh(current.access)) return; // already refreshed elsewhere
  let res: Response;
  try {
    res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: current.refresh,
        client_id: OAUTH_CLIENT_ID,
        scope: "openid profile email",
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e: any) {
    refreshBlockedUntil.set(path, Date.now() + FAILED_REFRESH_WAIT_MS);
    console.warn(
      `[codex-refresh] ${name}: token refresh failed: ${e?.message || e}`,
    );
    return;
  }
  if (!res.ok) {
    refreshBlockedUntil.set(path, Date.now() + FAILED_REFRESH_WAIT_MS);
    console.warn(
      `[codex-refresh] ${name}: token refresh failed: HTTP ${res.status}`,
    );
    return;
  }
  const body: any = await res.json().catch(() => null);
  if (!body?.access_token) {
    refreshBlockedUntil.set(path, Date.now() + FAILED_REFRESH_WAIT_MS);
    console.warn(
      `[codex-refresh] ${name}: refresh response carried no access token`,
    );
    return;
  }
  // Merge onto yet another fresh read so only the token fields move.
  const latest = readTokens(path);
  const raw = latest?.raw ?? current.raw;
  raw.tokens = {
    ...raw.tokens,
    access_token: body.access_token,
    ...(body.id_token ? { id_token: body.id_token } : {}),
    ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
  };
  raw.last_refresh = new Date().toISOString();
  writeFileAtomic(path, JSON.stringify(raw, null, 2) + "\n");
  chmodSync(path, 0o600);
  refreshBlockedUntil.delete(path);
  console.log(`[codex-refresh] ${name}: ChatGPT tokens refreshed`);
}

/**
 * One sweep over the registered CODEX_HOME accounts. Called from the hourly
 * account-health sweep (before detection, so a successful refresh clears a
 * would-be expiry warning in the same pass). Sequential and coalesced;
 * failures back off for an hour and are surfaced by account-health's
 * existing expiry alerts.
 */
export async function refreshIdleCodexTokens(): Promise<void> {
  for (const a of listCodexAccounts()) {
    if (a.kind !== "home") continue;
    const path = `${a.value}/auth.json`;
    if (!existsSync(path)) continue;
    if (Date.now() < (refreshBlockedUntil.get(path) ?? 0)) continue;
    const tokens = readTokens(path);
    if (!tokens?.refresh || !needsRefresh(tokens.access)) continue;
    const existing = inFlight.get(path);
    if (existing) {
      await existing;
      continue;
    }
    const p = withCodexAuthLock(a.value, () => doRefresh(path, a.name)).finally(
      () => inFlight.delete(path),
    );
    inFlight.set(path, p);
    await p;
  }
}
