/**
 * xAI (SuperGrok) subscription account pool, the third sibling of
 * claude-accounts.ts and codex-accounts.ts.
 *
 * One credential kind: an xAI OAuth token pair from the device-code sign-in
 * (xai-device-login.ts). Runs on `pi/xai-oauth/<model>` pick an account here,
 * refresh its access token in-process when it is near expiry, and send every
 * request through the cli-chat-proxy so it draws on the subscription's quota
 * rather than billed API credits. Pay-per-token xAI keys stay under
 * Settings → Your own providers as the separate `xai` provider.
 *
 * Store: ~/.opensession/xai-accounts.json (0600). The refresh token family is
 * ours alone (no external CLI shares it), so a refresh writes the rotated pair
 * straight back. Two processes (gateway and executor) read the same file, so
 * the token is re-read immediately before a refresh and a failed refresh
 * re-reads once more before giving up, in case the other side rotated first.
 *
 * Sandboxes only ever hold a copy that cannot rotate the grant: Docker mounts
 * this store read-only and remote hosts receive buildXaiRemoteUpload's
 * access-token-only projection. Either copy refuses to refresh and fails
 * loudly at expiry, while the host keeps its tokens ahead of expiry with a
 * periodic upkeep tick so those copies always find a live one.
 */

import { accessSync, chmodSync, constants, existsSync, readFileSync } from "fs";
import { writeFileAtomic } from "./shared/atomic-write";
import { stateDir } from "./paths";
import { userMatchesAny } from "./shared/user-mappings";
import { hrwScore } from "./codex-accounts";
import {
  XAI_CLI_PROXY_BASE_URL,
  XAI_OAUTH_PROVIDER,
  XaiOAuthError,
  fetchXaiCatalog,
  fetchXaiUsage,
  jwtEmail,
  refreshXaiTokens,
  xaiProxyHeaders,
  type XaiCatalogEntry,
  type XaiOAuthTokens,
  type XaiUsageSnapshot,
} from "./xai-oauth";

let STORE_PATH = stateDir("xai-accounts.json");
let STATE_PATH = STORE_PATH.replace(/\.json$/, "-state.json");
let CATALOG_PATH = stateDir("xai-catalog.json");
const DEFAULT_EXHAUST_MS = 60 * 60 * 1000;
/** Refresh when the stored expiry (already skewed) is this close. */
const REFRESH_WINDOW_MS = 60 * 1000;
const FAILED_REFRESH_WAIT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 60 * 60 * 1000;
/** Host-side token upkeep: every tick, any access token this close to expiry
 * is refreshed, so a read-only sandbox mount never picks a dead token. xAI
 * tokens last an hour, hence the short cadence. */
const UPKEEP_INTERVAL_MS = 10 * 60 * 1000;
const UPKEEP_AHEAD_MS = 20 * 60 * 1000;
/** A remote guest cannot refresh at all, so an upload carries a token with
 * as much of its hour left as a refresh can give it. */
const REMOTE_UPLOAD_AHEAD_MS = 45 * 60 * 1000;
/** The refresh slot of a guest copy: the real grant never leaves the host,
 * so a sandbox refresh can neither rotate nor kill it. */
export const XAI_REMOTE_SEED_REFRESH = "opensession-remote-seed";
/** Cached usage older than this no longer gates picking. */
const USAGE_GATE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export interface XaiAccount {
  id: string;
  name: string;
  /** xAI account identity from the id token or the proxy's /user. */
  email?: string;
  /** Personal account: only this person's runs may use it, and their runs
   *  prefer it over the shared pool. Unset = shared pool account. */
  owner?: string;
  createdAt: string;
  access: string;
  refresh: string;
  /** ms epoch when the access token needs refreshing (already skewed). */
  expires: number;
  lastRefreshAt?: string;
}

export interface XaiAccountPublic {
  id: string;
  name: string;
  email?: string;
  kind: "oauth";
  owner?: string;
  mode: "shared" | "personal";
  createdAt: string;
  exhaustedUntil: string | null;
  usable: boolean;
  /** The last refresh failure, when the pool needs a human to sign in again. */
  refreshError?: string;
  reloginRequired: boolean;
  usage: XaiUsageSnapshot | null;
}

// ── Store ───────────────────────────────────────────────────────────────────

function readStore(): XaiAccount[] {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    return Array.isArray(parsed?.accounts) ? parsed.accounts : [];
  } catch (e) {
    console.error("[xai-accounts] Failed to read store:", e);
    return [];
  }
}

function writeStore(accounts: XaiAccount[]): void {
  writeFileAtomic(STORE_PATH, JSON.stringify({ accounts }, null, 2) + "\n");
  chmodSync(STORE_PATH, 0o600);
}

/** Test seam: isolate the account, sideline and catalog stores. */
export function __setXaiAccountsPathForTest(path: string): string {
  const previous = STORE_PATH;
  STORE_PATH = path;
  STATE_PATH = path.replace(/\.json$/, "-state.json");
  CATALOG_PATH = path.replace(/\.json$/, "-catalog.json");
  exhaustedUntil.clear();
  lastPickedAt.clear();
  refreshErrors.clear();
  refreshBlockedUntil.clear();
  usageCache.clear();
  discovered = null;
  return previous;
}

// ── Sideline state (persisted, like codex-accounts) ─────────────────────────

const exhaustedUntil = new Map<string, number>();
const lastPickedAt = new Map<string, number>();
const refreshErrors = new Map<
  string,
  { message: string; reloginRequired: boolean }
>();
const refreshBlockedUntil = new Map<string, number>();
const refreshInFlight = new Map<string, Promise<XaiAccount>>();

function persistExhausted(): void {
  try {
    const out: Record<string, number> = {};
    const now = Date.now();
    for (const [k, until] of exhaustedUntil) if (until > now) out[k] = until;
    writeFileAtomic(STATE_PATH, JSON.stringify({ exhaustedUntil: out }) + "\n");
    chmodSync(STATE_PATH, 0o600);
  } catch (e) {
    console.warn("[xai-accounts] sideline persist failed:", e);
  }
}

try {
  if (existsSync(STATE_PATH)) {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    const now = Date.now();
    for (const [k, until] of Object.entries(parsed?.exhaustedUntil || {})) {
      if (typeof until === "number" && until > now)
        exhaustedUntil.set(k, until);
    }
  }
} catch {}

function exhaustionKey(id: string, model?: string): string {
  return model ? `${id}:${model}` : id;
}

function isExhaustionKeyActive(key: string): boolean {
  const until = exhaustedUntil.get(key);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    exhaustedUntil.delete(key);
    return false;
  }
  return true;
}

function isExhausted(id: string, model?: string): boolean {
  return (
    isExhaustionKeyActive(exhaustionKey(id)) ||
    (model ? isExhaustionKeyActive(exhaustionKey(id, model)) : false)
  );
}

/** Sideline an account after a run hit its quota or rate limit. */
export function markXaiExhausted(id: string, model?: string): void {
  const account = readStore().find((a) => a.id === id);
  const until = Date.now() + DEFAULT_EXHAUST_MS;
  exhaustedUntil.set(exhaustionKey(id, model), until);
  persistExhausted();
  console.warn(
    `[xai-accounts] ${account?.name || id}${model ? ` (${model})` : ""} marked exhausted until ${new Date(until).toISOString()}`,
  );
}

// ── Usage ───────────────────────────────────────────────────────────────────

const usageCache: Map<string, XaiUsageSnapshot> = ((
  globalThis as any
).__xaiAccountUsage ??= new Map());
let pollTimer: ReturnType<typeof setInterval> | null = null;
let upkeepTimer: ReturnType<typeof setInterval> | null = null;

export function xaiUsageFor(accountId: string): XaiUsageSnapshot | null {
  return usageCache.get(accountId) || null;
}

/** Cached usage says the subscription's included credits are spent and
 * nothing on-demand backs them. A stale or ended period never gates. */
function usageExhausted(account: XaiAccount, now = Date.now()): boolean {
  const usage = usageCache.get(account.id);
  if (!usage || usage.error) return false;
  if ((usage.creditUsagePercent ?? 0) < 100) return false;
  if (usage.onDemandEnabled) return false;
  const fetchedAt = Date.parse(usage.fetchedAt);
  if (!Number.isFinite(fetchedAt) || now - fetchedAt > USAGE_GATE_MAX_AGE_MS)
    return false;
  const periodEnd = usage.periodEnd ? Date.parse(usage.periodEnd) : NaN;
  return Number.isFinite(periodEnd) ? periodEnd > now : true;
}

// ── Public projection ───────────────────────────────────────────────────────

function toPublic(a: XaiAccount): XaiAccountPublic {
  const until = exhaustedUntil.get(a.id);
  const refreshError = refreshErrors.get(a.id);
  return {
    id: a.id,
    name: a.name,
    ...(a.email ? { email: a.email } : {}),
    kind: "oauth",
    ...(a.owner ? { owner: a.owner } : {}),
    mode: a.owner ? "personal" : "shared",
    createdAt: a.createdAt,
    exhaustedUntil:
      until !== undefined && until > Date.now()
        ? new Date(until).toISOString()
        : null,
    usable:
      !isExhausted(a.id) &&
      !usageExhausted(a) &&
      !refreshError?.reloginRequired,
    ...(refreshError ? { refreshError: refreshError.message } : {}),
    reloginRequired: !!refreshError?.reloginRequired,
    usage: usageCache.get(a.id) || null,
  };
}

export function listXaiAccountsPublic(): XaiAccountPublic[] {
  return readStore().map(toPublic);
}

/** All configured accounts (with secrets — server-side use only). */
export function listXaiAccounts(): XaiAccount[] {
  return readStore();
}

export function hasXaiAccounts(): boolean {
  return readStore().length > 0;
}

export function getXaiAccountById(id: string): XaiAccount | undefined {
  return readStore().find((account) => account.id === id);
}

export function addXaiAccount(input: {
  tokens: XaiOAuthTokens;
  email?: string;
  name?: string;
  owner?: string;
}): XaiAccountPublic | { error: string } {
  const email = input.email?.trim() || jwtEmail(input.tokens.idToken);
  const name = email || input.name?.trim();
  if (!name)
    return { error: "Could not read an email address from this xAI login" };
  const accounts = readStore();
  if (accounts.some((a) => a.name === name)) {
    return { error: `An account named "${name}" already exists` };
  }
  if (accounts.some((a) => a.refresh === input.tokens.refresh)) {
    return { error: "This login is already registered" };
  }
  const account: XaiAccount = {
    id: crypto.randomUUID(),
    name,
    ...(email ? { email } : {}),
    ...(input.owner?.trim() ? { owner: input.owner.trim() } : {}),
    createdAt: new Date().toISOString(),
    access: input.tokens.access,
    refresh: input.tokens.refresh,
    expires: input.tokens.expires,
  };
  writeStore([...accounts, account]);
  console.log(`[xai-accounts] Added account ${name}`);
  return toPublic(account);
}

export function removeXaiAccount(id: string): boolean {
  const accounts = readStore();
  const next = accounts.filter((a) => a.id !== id);
  if (next.length === accounts.length) return false;
  writeStore(next);
  exhaustedUntil.delete(id);
  lastPickedAt.delete(id);
  refreshErrors.delete(id);
  refreshBlockedUntil.delete(id);
  usageCache.delete(id);
  return true;
}

/** Set or clear (empty/undefined) an account's personal owner. */
export function setXaiAccountOwner(
  id: string,
  owner: string | undefined,
): XaiAccountPublic | null {
  const accounts = readStore();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const next = { ...accounts[idx] };
  const trimmed = owner?.trim() || undefined;
  if (trimmed) next.owner = trimmed;
  else delete next.owner;
  accounts[idx] = next;
  writeStore(accounts);
  return toPublic(next);
}

// ── Picking ─────────────────────────────────────────────────────────────────

export interface PickXaiAccountOptions {
  model?: string;
  /** Rendezvous key: the same session keeps its account until it is sidelined. */
  sessionKey?: string;
  user?: string;
  pinnedId?: string;
  strict?: boolean;
  /** Designated account ids in preference order (bridge.xaiAccounts), the
   *  sibling of the Codex pool's openaiAccounts. Empty = the whole pool. */
  restrictIds?: string[];
  exclude?: ReadonlySet<string>;
  out?: { reason?: string };
}

/**
 * Pick an account for a run, mirroring pickOpenaiAccount + pickCodexAccount:
 * an eligible pin first (a strict pin never widens into the pool), then the
 * designated list in order when one is configured, then the run user's own
 * personal accounts, then the shared pool. Other people's personal accounts
 * are never eligible, and a run with no user (automations, one-shots) sees
 * shared accounts only. Session affinity is the pinned rendezvous hash
 * shared with the Codex pool; account-less callers get the least recently
 * picked account.
 */
export function pickXaiAccount(
  options: PickXaiAccountOptions = {},
): XaiAccount | { error: string } {
  const { model, sessionKey, user, pinnedId, strict, exclude, out } = options;
  const restrictIds = options.restrictIds?.length
    ? options.restrictIds
    : undefined;
  const all = readStore();
  if (!all.length) {
    return { error: "no SuperGrok accounts are configured" };
  }
  const allowedOwner = (account: XaiAccount) =>
    !account.owner || (!!user && userMatchesAny(user, [account.owner]));
  const designated = (id: string) => !restrictIds || restrictIds.includes(id);
  const usable = (account: XaiAccount) =>
    !exclude?.has(account.id) &&
    !isExhausted(account.id, model) &&
    !usageExhausted(account) &&
    !refreshErrors.get(account.id)?.reloginRequired;
  if (pinnedId) {
    const pinned = all.find((a) => a.id === pinnedId);
    if (
      pinned &&
      usable(pinned) &&
      allowedOwner(pinned) &&
      designated(pinned.id)
    ) {
      if (out) out.reason = "pinned";
      lastPickedAt.set(pinned.id, Date.now());
      return pinned;
    }
    if (strict) {
      return {
        error: `pinned account ${pinned?.name || pinnedId} is not currently usable (hard pin — not falling back to the pool)`,
      };
    }
  }
  if (restrictIds) {
    for (const id of restrictIds) {
      const account = all.find((a) => a.id === id);
      if (account && usable(account) && allowedOwner(account)) {
        if (out) out.reason = "designated";
        lastPickedAt.set(account.id, Date.now());
        return account;
      }
    }
    return {
      error: `no designated SuperGrok account is usable (${restrictIds.join(", ")})`,
    };
  }
  const candidatesAll = all.filter(usable);
  const personal = user
    ? candidatesAll.filter((a) => a.owner && userMatchesAny(user, [a.owner]))
    : [];
  const candidates = personal.length
    ? personal
    : candidatesAll.filter((a) => !a.owner);
  if (!candidates.length) {
    return { error: "no usable SuperGrok account is available" };
  }
  let picked: XaiAccount;
  if (sessionKey) {
    picked = candidates
      .map((a) => ({ a, s: hrwScore(sessionKey, a.id) }))
      .sort((x, y) => y.s - x.s || (x.a.id < y.a.id ? -1 : 1))[0].a;
    if (out) out.reason = picked.owner ? "personal-hrw" : "sticky-hrw";
  } else {
    picked = candidates
      .map((a) => ({ a, picked: lastPickedAt.get(a.id) ?? 0 }))
      .sort((x, y) => x.picked - y.picked)[0].a;
    if (out) out.reason = picked.owner ? "personal-lru" : "pool-lru";
  }
  lastPickedAt.set(picked.id, Date.now());
  return picked;
}

export function maskXaiAccount(
  account: Pick<XaiAccount, "id" | "name">,
): string {
  return `${account.name} (${account.id.slice(0, 8)}, ${XAI_OAUTH_PROVIDER})`;
}

// ── Token upkeep ────────────────────────────────────────────────────────────

function needsRefresh(
  account: XaiAccount,
  aheadMs = REFRESH_WINDOW_MS,
  now = Date.now(),
): boolean {
  return account.expires <= now + aheadMs;
}

/** Why this copy of the store must not refresh: a guest projection holds no
 * grant, and a read-only mount (Docker) could not keep a rotated pair, which
 * would strand the host's copy. Null on the host. */
function refreshRefusal(account: XaiAccount): string | null {
  if (account.refresh === XAI_REMOTE_SEED_REFRESH) {
    return "this sandbox copy holds an access token only; the host refreshes it before each launch";
  }
  try {
    accessSync(STORE_PATH, constants.W_OK);
  } catch {
    return "the account store is read-only here; the host refreshes it on its own";
  }
  return null;
}

function persistTokens(id: string, tokens: XaiOAuthTokens): XaiAccount | null {
  const accounts = readStore();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const next: XaiAccount = {
    ...accounts[idx],
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
    lastRefreshAt: new Date().toISOString(),
  };
  accounts[idx] = next;
  try {
    writeStore(accounts);
  } catch (e) {
    // A read-only store (a sandbox mount) still gets the fresh token for
    // this process; the host copy refreshes on its own next pick.
    console.warn(
      `[xai-accounts] could not persist refreshed tokens for ${next.name}:`,
      e,
    );
  }
  return next;
}

async function refreshOnce(id: string, aheadMs: number): Promise<XaiAccount> {
  // Re-read right before the network call: the other host process may have
  // rotated the pair since the caller looked.
  const current = readStore().find((a) => a.id === id);
  if (!current) throw new XaiOAuthError("account was removed", true);
  if (!needsRefresh(current, aheadMs)) return current;
  const refusal = refreshRefusal(current);
  if (refusal) {
    throw new XaiOAuthError(
      `access token has expired and cannot be refreshed: ${refusal}`,
    );
  }
  try {
    const tokens = await refreshXaiTokens(current.refresh);
    refreshErrors.delete(id);
    refreshBlockedUntil.delete(id);
    const persisted = persistTokens(id, tokens);
    console.log(`[xai-accounts] ${current.name}: tokens refreshed`);
    return persisted ?? { ...current, ...tokens };
  } catch (error) {
    // The other process may have won a race with the same refresh token.
    const latest = readStore().find((a) => a.id === id);
    if (latest && !needsRefresh(latest)) return latest;
    const message = error instanceof Error ? error.message : String(error);
    const reloginRequired =
      error instanceof XaiOAuthError && error.reloginRequired;
    refreshErrors.set(id, { message, reloginRequired });
    refreshBlockedUntil.set(id, Date.now() + FAILED_REFRESH_WAIT_MS);
    console.warn(`[xai-accounts] ${current.name}: ${message}`);
    throw error instanceof XaiOAuthError
      ? error
      : new XaiOAuthError(message, false);
  }
}

/**
 * The account with a usable access token: the stored one when it has time
 * left, otherwise a refreshed pair. Concurrent callers for one account share
 * a single refresh. A failed refresh backs off ten minutes and, when the
 * grant is dead, marks the account as needing a fresh sign-in. `aheadMs`
 * widens "time left" for callers that need the token to outlive a run.
 */
export async function ensureFreshXaiAccount(
  account: XaiAccount,
  aheadMs = REFRESH_WINDOW_MS,
): Promise<XaiAccount> {
  const stored = readStore().find((a) => a.id === account.id) ?? account;
  if (!needsRefresh(stored, aheadMs)) return stored;
  const blocked = refreshBlockedUntil.get(account.id) ?? 0;
  if (Date.now() < blocked) {
    const last = refreshErrors.get(account.id);
    throw new XaiOAuthError(
      last?.message || "xAI token refresh recently failed",
      last?.reloginRequired ?? false,
    );
  }
  const existing = refreshInFlight.get(account.id);
  if (existing) return existing;
  const run = refreshOnce(account.id, aheadMs).finally(() =>
    refreshInFlight.delete(account.id),
  );
  refreshInFlight.set(account.id, run);
  return run;
}

/** Host upkeep tick: refresh every token that would otherwise expire before
 * the next tick, so a read-only guest copy always finds a live one. */
export async function refreshXaiTokensAhead(): Promise<void> {
  for (const account of readStore()) {
    if (!needsRefresh(account, UPKEEP_AHEAD_MS)) continue;
    if (refreshErrors.get(account.id)?.reloginRequired) continue;
    await ensureFreshXaiAccount(account, UPKEEP_AHEAD_MS).catch(
      () => undefined,
    );
  }
}

export interface XaiRemoteUpload {
  accounts: XaiAccount[];
  skipped: Array<{ account: XaiAccount; reason: string }>;
}

/**
 * The scoped, rotation-proof store a remote sandbox receives, the sibling of
 * Claude's accountsForRemoteUpload and Codex's buildOpenaiRemoteSeedUpload.
 * An explicit pin narrows the set to that one account when this run may use
 * it (a missing or foreign pin falls back to the scoped set, never wider);
 * otherwise the run user's own and the shared accounts, limited to the
 * designated ids. Every record is rebuilt field by field with a freshly
 * refreshed access token and the placeholder refresh, so neither the grant
 * nor an unknown future host field crosses the trust boundary.
 */
export async function buildXaiRemoteUpload(input: {
  user?: string;
  accountId?: string;
  restrictIds?: string[];
}): Promise<XaiRemoteUpload> {
  const allowedOwner = (account: XaiAccount) =>
    !account.owner ||
    (!!input.user && userMatchesAny(input.user, [account.owner]));
  const all = readStore();
  const designated = input.restrictIds?.length
    ? input.restrictIds
        .map((id) => all.find((account) => account.id === id))
        .filter((account): account is XaiAccount => !!account)
    : all;
  const pinned = input.accountId
    ? designated.find((account) => account.id === input.accountId)
    : undefined;
  const eligible =
    pinned && allowedOwner(pinned) ? [pinned] : designated.filter(allowedOwner);
  const accounts: XaiAccount[] = [];
  const skipped: XaiRemoteUpload["skipped"] = [];
  for (const account of eligible) {
    if (refreshErrors.get(account.id)?.reloginRequired) {
      skipped.push({ account, reason: "needs a fresh sign-in" });
      continue;
    }
    let fresh: XaiAccount;
    try {
      fresh = await ensureFreshXaiAccount(account, REMOTE_UPLOAD_AHEAD_MS);
    } catch (error) {
      skipped.push({
        account,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (fresh.expires <= Date.now()) {
      skipped.push({ account, reason: "access token has expired" });
      continue;
    }
    accounts.push({
      id: fresh.id,
      name: fresh.name,
      ...(fresh.email ? { email: fresh.email } : {}),
      ...(fresh.owner ? { owner: fresh.owner } : {}),
      createdAt: fresh.createdAt,
      access: fresh.access,
      refresh: XAI_REMOTE_SEED_REFRESH,
      expires: fresh.expires,
    });
  }
  return { accounts, skipped };
}

/** Accounts whose last refresh failed, for the health sweep. */
export function xaiRefreshFailures(): Array<{
  account: XaiAccountPublic;
  message: string;
  reloginRequired: boolean;
}> {
  return readStore().flatMap((account) => {
    const failure = refreshErrors.get(account.id);
    return failure ? [{ account: toPublic(account), ...failure }] : [];
  });
}

// ── Usage polling ───────────────────────────────────────────────────────────

export async function refreshXaiUsage(
  accounts: XaiAccount[] = readStore(),
): Promise<void> {
  const liveIds = new Set(accounts.map((account) => account.id));
  for (const id of usageCache.keys())
    if (!liveIds.has(id)) usageCache.delete(id);
  let catalogRefreshed = false;
  for (const account of accounts) {
    const previous = usageCache.get(account.id);
    let next: XaiUsageSnapshot;
    try {
      const fresh = await ensureFreshXaiAccount(account);
      next = await fetchXaiUsage(fresh.access);
      if (!catalogRefreshed) {
        catalogRefreshed = true;
        await refreshXaiCatalog(fresh.access).catch(() => undefined);
      }
    } catch (error) {
      next = {
        fetchedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // Keep the last good meters through a transient network error.
    if (next.error && previous && !previous.error) continue;
    usageCache.set(account.id, next);
  }
}

/** Start the hourly usage and catalog poller plus the token upkeep tick
 * (boot-wired beside the other pools' pollers). */
export function startXaiUsagePoller(): void {
  if (pollTimer || upkeepTimer) return;
  const refresh = () =>
    refreshXaiUsage().catch((error) =>
      console.error("[xai-accounts] usage poll failed:", error),
    );
  void refresh();
  pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
  upkeepTimer = setInterval(
    () => void refreshXaiTokensAhead(),
    UPKEEP_INTERVAL_MS,
  );
  console.log(
    "[xai-accounts] usage poller started (hourly, token upkeep every 10 minutes)",
  );
}

// ── Model catalog ───────────────────────────────────────────────────────────

export interface XaiModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  /** Accepts `reasoning.effort` (low/medium/high/xhigh). */
  effortCapable: boolean;
}

// $/M tokens from xAI's public pricing page; cacheWrite is unpublished.
const COST_BUILD = { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 };
const COST_420 = { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 };
const COST_45 = { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 };
// Unknown pricing must under-report, never guess.
const COST_UNKNOWN = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const EFFORT_CAPABLE_PREFIXES = [
  "grok-3-mini",
  "grok-4.20-multi-agent",
  "grok-4.3",
  "grok-4.5",
  "grok-4.6",
];

function effortCapableId(id: string): boolean {
  const lower = id.toLowerCase();
  return EFFORT_CAPABLE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Known subscription models, used until the proxy's live catalog lands and
 * as the source of cost and reasoning facts the catalog does not carry. */
export const XAI_FALLBACK_MODELS: readonly XaiModelConfig[] = [
  {
    id: "grok-4.6",
    name: "Grok 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: COST_45,
    contextWindow: 500_000,
    maxTokens: 131_072,
    effortCapable: true,
  },
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    reasoning: true,
    input: ["text", "image"],
    cost: COST_45,
    contextWindow: 500_000,
    maxTokens: 131_072,
    effortCapable: true,
  },
  {
    id: "grok-4.3",
    name: "Grok 4.3",
    reasoning: true,
    input: ["text", "image"],
    cost: COST_420,
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    effortCapable: true,
  },
  {
    id: "grok-composer-2.5-fast",
    name: "Composer 2.5",
    reasoning: true,
    input: ["text", "image"],
    cost: COST_BUILD,
    contextWindow: 200_000,
    maxTokens: 30_000,
    effortCapable: false,
  },
  {
    id: "grok-build",
    name: "Grok Build",
    reasoning: true,
    input: ["text", "image"],
    cost: COST_BUILD,
    contextWindow: 500_000,
    maxTokens: 30_000,
    effortCapable: false,
  },
  {
    id: "grok-4.20-0309-reasoning",
    name: "Grok 4.20 Reasoning",
    reasoning: true,
    input: ["text", "image"],
    cost: COST_420,
    contextWindow: 2_000_000,
    maxTokens: 131_072,
    effortCapable: false,
  },
  {
    id: "grok-4.20-0309-non-reasoning",
    name: "Grok 4.20 Non-Reasoning",
    reasoning: false,
    input: ["text", "image"],
    cost: COST_420,
    contextWindow: 2_000_000,
    maxTokens: 131_072,
    effortCapable: false,
  },
  {
    id: "grok-4.20-multi-agent-0309",
    name: "Grok 4.20 Multi-Agent",
    reasoning: true,
    input: ["text", "image"],
    cost: COST_420,
    contextWindow: 2_000_000,
    maxTokens: 131_072,
    effortCapable: true,
  },
];

let discovered: { fetchedAt: number; models: XaiCatalogEntry[] } | null = null;

function readCatalogCache(): void {
  if (discovered || !existsSync(CATALOG_PATH)) return;
  try {
    const parsed = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));
    if (
      typeof parsed?.fetchedAt === "number" &&
      Array.isArray(parsed?.models)
    ) {
      discovered = {
        fetchedAt: parsed.fetchedAt,
        models: parsed.models.filter(
          (row: unknown): row is XaiCatalogEntry =>
            !!row &&
            typeof row === "object" &&
            typeof (row as { id?: unknown }).id === "string",
        ),
      };
    }
  } catch {}
}

/** Pure: the proxy's list enriches the fallback (windows, names, new ids);
 * fallback rows the proxy omitted stay at the end. */
export function mergeXaiCatalog(
  base: readonly XaiModelConfig[],
  live: readonly XaiCatalogEntry[],
): XaiModelConfig[] {
  const byId = new Map(base.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const merged: XaiModelConfig[] = [];
  for (const entry of live) {
    seen.add(entry.id);
    const existing = byId.get(entry.id);
    const effortCapable =
      entry.supportsReasoningEffort ??
      existing?.effortCapable ??
      effortCapableId(entry.id);
    merged.push(
      existing
        ? {
            ...existing,
            name: entry.name ?? existing.name,
            contextWindow: entry.contextWindow ?? existing.contextWindow,
            maxTokens: entry.maxTokens ?? existing.maxTokens,
            effortCapable,
          }
        : {
            id: entry.id,
            name: entry.name ?? entry.id,
            reasoning: true,
            input: ["text", "image"],
            cost: COST_UNKNOWN,
            contextWindow: entry.contextWindow ?? 1_000_000,
            maxTokens: entry.maxTokens ?? 30_000,
            effortCapable,
          },
    );
  }
  for (const row of base) if (!seen.has(row.id)) merged.push(row);
  return merged;
}

export async function refreshXaiCatalog(access: string): Promise<void> {
  const models = await fetchXaiCatalog(access);
  if (!models.length) return;
  discovered = { fetchedAt: Date.now(), models };
  try {
    writeFileAtomic(CATALOG_PATH, JSON.stringify(discovered) + "\n");
  } catch (e) {
    console.warn("[xai-accounts] catalog cache write failed:", e);
  }
}

export function xaiSubscriptionModels(): XaiModelConfig[] {
  readCatalogCache();
  return mergeXaiCatalog(XAI_FALLBACK_MODELS, discovered?.models ?? []);
}

function xaiModel(modelId: string): XaiModelConfig | undefined {
  const lower = modelId.toLowerCase();
  return xaiSubscriptionModels().find((m) => m.id.toLowerCase() === lower);
}

/** Picker ids for the subscription catalog, or none without a pool. */
export function xaiSubscriptionPickerModels(): string[] {
  if (!hasXaiAccounts()) return [];
  return xaiSubscriptionModels().map((m) => `pi/${XAI_OAUTH_PROVIDER}/${m.id}`);
}

export function xaiSubscriptionModelName(modelId: string): string {
  return xaiModel(modelId)?.name || "";
}

export function xaiSubscriptionModelEfforts(
  modelId: string,
): Array<"low" | "medium" | "high" | "xhigh"> {
  const model = xaiModel(modelId);
  const capable = model ? model.effortCapable : effortCapableId(modelId);
  return capable ? ["low", "medium", "high", "xhigh"] : [];
}

/** The runner's whole account step for a `pi/xai-oauth` turn: pick, make
 * sure the access token has time left, and build the provider registration.
 * A dry pool or a dead grant reads as "this pool can't serve" so the caller's
 * fallback walk moves on. */
export async function bindXaiAccount(input: {
  modelID: string;
  affinityKey: string;
  unifiedSessionId: string;
  user?: string;
  accountId?: string;
  accountStrict?: boolean;
  restrictIds?: string[];
  excluded: ReadonlySet<string>;
  out?: { reason?: string };
}): Promise<
  | {
      account: XaiAccount;
      access: string;
      provider: ReturnType<typeof xaiProviderRegistration>;
    }
  | { error: string; account?: XaiAccount }
> {
  const picked = pickXaiAccount({
    model: input.modelID,
    sessionKey: input.affinityKey,
    user: input.user,
    pinnedId: input.accountId,
    strict: input.accountStrict,
    restrictIds: input.restrictIds,
    exclude: input.excluded,
    out: input.out,
  });
  if ("error" in picked) return { error: picked.error };
  try {
    const fresh = await ensureFreshXaiAccount(picked);
    return {
      account: fresh,
      access: fresh.access,
      provider: xaiProviderRegistration(input.modelID, input.unifiedSessionId),
    };
  } catch (error) {
    return {
      error: `SuperGrok account "${picked.name}": ${error instanceof Error ? error.message : String(error)}`,
      account: picked,
    };
  }
}

/** Pi provider registration for one run: every row routed through the CLI
 * proxy with its identity headers, the selected model included even when
 * the catalog does not know it yet. `x-grok-conv-id` scopes the proxy's
 * conversation state to this session. */
export function xaiProviderRegistration(modelId: string, sessionId: string) {
  const known = xaiSubscriptionModels();
  const rows = known.some((m) => m.id === modelId)
    ? known
    : [
        ...known,
        {
          id: modelId,
          name: modelId,
          reasoning: true,
          input: ["text", "image"] as Array<"text" | "image">,
          cost: COST_UNKNOWN,
          contextWindow: 1_000_000,
          maxTokens: 30_000,
          effortCapable: effortCapableId(modelId),
        },
      ];
  return {
    name: "xAI (SuperGrok subscription)",
    api: "openai-responses" as const,
    baseUrl: XAI_CLI_PROXY_BASE_URL,
    headers: { ...xaiProxyHeaders(), "x-grok-conv-id": sessionId },
    models: rows.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: m.input,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      headers: xaiProxyHeaders(m.id),
      // Effort-capable models reject `effort: none`; hide "off" and opt into
      // xhigh. Models without the dial get no reasoning param at all.
      ...(m.reasoning
        ? {
            thinkingLevelMap: m.effortCapable
              ? { off: null, minimal: null, xhigh: "xhigh" }
              : { off: null },
          }
        : {}),
    })),
  };
}
