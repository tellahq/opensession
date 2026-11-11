/**
 * ChatGPT-plan usage for registered CODEX_HOME accounts.
 *
 * Codex exposes its authenticated rate-limit view through the supported
 * app-server JSON-RPC surface (`account/rateLimits/read`). Probe each account
 * with its own CODEX_HOME so token refresh and workspace selection stay owned
 * by the same auth.json that runs already use. API-key accounts deliberately
 * stay out: their spend belongs to an OpenAI Platform organization, not an
 * individual key, and needs a separate organization-level integration.
 *
 * Each poll also spends a rate-limit reset credit on an account whose weekly
 * limit is fully used and more than two days from resetting by itself.
 */

import { registerMemoryProbe } from "./memory-probes";
import { readFile } from "fs/promises";
import type { CodexAccount } from "./codex-accounts";
import { withCodexAuthLock } from "./codex-auth-lock";
import { homeDir } from "./paths";
import { workloadArgv } from "./workload-scope";

export interface CodexUsageWindow {
  utilization: number | null;
  resetsAt: string | null;
  windowDurationMins: number | null;
}

/** Prepaid credits on the bucket. Only present when the account has some
 * (or an unlimited grant); a bucket without credits carries nothing. */
export interface CodexUsageCredits {
  hasCredits: boolean;
  unlimited: boolean;
  /** Provider-formatted amount, or null when only the presence is known. */
  balance: string | null;
}

/** The spend cap a ChatGPT workspace set on this member. `limit` and `used`
 * are the provider's own formatted amounts, passed through untouched. */
export interface CodexSpendLimit {
  limit: string;
  used: string;
  remainingPercent: number | null;
  resetsAt: string | null;
}

export interface CodexUsageBucket {
  id: string;
  label?: string;
  plan?: string;
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  credits?: CodexUsageCredits;
  spendLimit?: CodexSpendLimit;
  rateLimitReachedType?: string;
}

export interface CodexAccountUsage {
  fetchedAt: string;
  buckets: CodexUsageBucket[];
  resetCreditsAvailable: number | null;
  error?: string;
}

const usageCache: Map<string, CodexAccountUsage> = ((
  globalThis as any
).__codexAccountUsage ??= new Map());
registerMemoryProbe("codex-usage.usage", () => usageCache.size);

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 60 * 60 * 1000;
// Same window codex-token-refresh.ts uses: refresh only near expiry, so an
// account with live codex traffic (which the CLI refreshes itself) is never
// asked to rotate its refresh-token family from here as well.
const REFRESH_AHEAD_MS = 24 * 60 * 60 * 1000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function usageError(message: string): CodexAccountUsage {
  return {
    fetchedAt: new Date().toISOString(),
    buckets: [],
    resetCreditsAvailable: null,
    error: message,
  };
}

function isoFromUnixSeconds(value: unknown): string | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function normalizeWindow(value: any): CodexUsageWindow | null {
  if (!value || typeof value !== "object") return null;
  const used = Number(value.usedPercent);
  const duration = Number(value.windowDurationMins);
  return {
    utilization: Number.isFinite(used) ? used : null,
    resetsAt: isoFromUnixSeconds(value.resetsAt),
    windowDurationMins: Number.isFinite(duration) ? duration : null,
  };
}

function normalizeCredits(value: any): CodexUsageCredits | undefined {
  if (!value || typeof value !== "object") return undefined;
  const hasCredits = value.hasCredits === true;
  const unlimited = value.unlimited === true;
  if (!hasCredits && !unlimited) return undefined;
  return {
    hasCredits,
    unlimited,
    balance:
      typeof value.balance === "string" && value.balance ? value.balance : null,
  };
}

function normalizeSpendLimit(value: any): CodexSpendLimit | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.limit !== "string" || typeof value.used !== "string")
    return undefined;
  const remaining = Number(value.remainingPercent);
  return {
    limit: value.limit,
    used: value.used,
    remainingPercent: Number.isFinite(remaining) ? remaining : null,
    resetsAt: isoFromUnixSeconds(value.resetsAt),
  };
}

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

/** Whether the home's ChatGPT access token is expired or about to be, so the
 * probe should ask the app-server to refresh it before reading limits. An
 * unreadable auth.json or an API-key login answers false: there is nothing
 * for the app-server to refresh, and the read itself reports the real error. */
export async function codexAccessTokenNeedsRefresh(
  codexHome: string,
  now = Date.now(),
): Promise<boolean> {
  try {
    const access = JSON.parse(await readFile(`${codexHome}/auth.json`, "utf-8"))
      ?.tokens?.access_token;
    if (typeof access !== "string" || !access) return false;
    const exp = jwtExpMs(access);
    return exp !== null && exp <= now + REFRESH_AHEAD_MS;
  } catch {
    return false;
  }
}

/** Convert the versioned app-server wire result into the small stable shape
 * the settings UI needs. Supports both the newer multi-bucket map and the
 * backward-compatible singular `rateLimits` field. */
export function normalizeCodexRateLimits(
  result: any,
  fetchedAt = new Date().toISOString(),
): CodexAccountUsage {
  const multi =
    result?.rateLimitsByLimitId &&
    typeof result.rateLimitsByLimitId === "object"
      ? Object.entries(result.rateLimitsByLimitId)
      : [];
  const entries: Array<[string, any]> = multi.length
    ? multi
    : result?.rateLimits
      ? [[result.rateLimits.limitId || "codex", result.rateLimits]]
      : [];
  const buckets = entries.map(([key, raw]): CodexUsageBucket => {
    const credits = normalizeCredits(raw?.credits);
    const spendLimit = normalizeSpendLimit(raw?.individualLimit);
    return {
      id: String(raw?.limitId || key),
      ...(typeof raw?.limitName === "string" && raw.limitName
        ? { label: raw.limitName }
        : {}),
      ...(typeof raw?.planType === "string" && raw.planType
        ? { plan: raw.planType }
        : {}),
      primary: normalizeWindow(raw?.primary),
      secondary: normalizeWindow(raw?.secondary),
      ...(credits ? { credits } : {}),
      ...(spendLimit ? { spendLimit } : {}),
      ...(typeof raw?.rateLimitReachedType === "string" &&
      raw.rateLimitReachedType
        ? { rateLimitReachedType: raw.rateLimitReachedType }
        : {}),
    };
  });
  const available = Number(result?.rateLimitResetCredits?.availableCount);
  return {
    fetchedAt,
    buckets,
    resetCreditsAvailable: Number.isFinite(available) ? available : null,
  };
}

function appServerEnv(codexHome: string): Record<string, string> {
  const env: Record<string, string> = {
    CODEX_HOME: codexHome,
    HOME: homeDir(),
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    TERM: process.env.TERM || "xterm-256color",
  };
  for (const key of [
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

type RpcReply = { result?: any; error?: { message?: string } };

/** One JSON-RPC exchange with a bounded `codex app-server`: the session
 * initializes it, then `run` sends requests in order. Any failure (spawn,
 * timeout, early exit, oversize reply) resolves through `fail`, so callers
 * get a value instead of an exception. The optional executable/timeout are
 * test seams; production always uses the installed `codex` binary. */

async function withAppServer<T>(
  codexHome: string,
  executable: string,
  timeoutMs: number,
  fail: (message: string) => T,
  run: (
    request: (method: string, params: unknown) => Promise<RpcReply>,
  ) => Promise<T>,
): Promise<T> {
  // Name the pipes in the type as well as the options: the bare spawn return
  // type describes the DEFAULT stdio, where stdin is an inherited fd rather
  // than the FileSink this writes to and stdout is not async-iterable.
  let proc: Bun.Subprocess<"pipe", "pipe", "ignore">;
  try {
    proc = Bun.spawn(workloadArgv([executable, "app-server"], "codex-probe"), {
      env: appServerEnv(codexHome),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch (error: any) {
    return fail(`Couldn't start Codex app-server: ${error?.message || error}`);
  }

  return await new Promise<T>((resolve) => {
    let settled = false;
    let nextId = 1;
    const pending = new Map<number, (reply: RpcReply) => void>();
    const finish = (value: T, kill = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc.stdin.end();
      } catch {}
      if (kill) {
        try {
          proc.kill();
        } catch {}
      }
      resolve(value);
    };
    const send = (message: unknown) => {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (method: string, params: unknown) =>
      new Promise<RpcReply>((reply) => {
        const id = nextId++;
        pending.set(id, reply);
        send({ method, id, params });
      });
    const timer = setTimeout(
      () => finish(fail("Codex app-server timed out")),
      timeoutMs,
    );

    void (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      try {
        for await (const chunk of proc.stdout) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 1_000_000) {
            finish(fail("Codex app-server response was too large"));
            return;
          }
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            if (!line) continue;
            const message = JSON.parse(line);
            const reply = pending.get(message.id);
            if (!reply) continue;
            pending.delete(message.id);
            reply({ result: message.result, error: message.error });
          }
          if (settled) return;
        }
        finish(fail("Codex app-server ended before replying"), false);
      } catch (error: any) {
        finish(fail(`Codex app-server failed: ${error?.message || error}`));
      }
    })();

    void (async () => {
      const init = await request("initialize", {
        clientInfo: {
          name: "opensession",
          title: "Open Session",
          version: "1.0.0",
        },
      });
      if (settled) return;
      if (init.error) {
        finish(
          fail(init.error.message || "Codex app-server initialization failed"),
        );
        return;
      }
      send({ method: "initialized", params: {} });
      const value = await run(request);
      finish(value);
    })().catch((error: any) =>
      finish(fail(`Codex app-server failed: ${error?.message || error}`)),
    );
  });
}

/** One bounded app-server probe. The optional executable/timeout are test
 * seams; production always uses the installed `codex` binary. */
export async function probeCodexUsage(
  codexHome: string,
  executable = "codex",
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CodexAccountUsage> {
  return withCodexAuthLock(codexHome, () =>
    probeCodexUsageUnlocked(codexHome, executable, timeoutMs),
  );
}

async function probeCodexUsageUnlocked(
  codexHome: string,
  executable: string,
  timeoutMs: number,
): Promise<CodexAccountUsage> {
  const refreshToken = await codexAccessTokenNeedsRefresh(codexHome);
  return withAppServer(
    codexHome,
    executable,
    timeoutMs,
    usageError,
    async (request) => {
      // The limits read does not refresh an expired access token on its own;
      // it just fails. Ask the app-server to refresh first when the token is
      // near expiry, through the same code path and auth.json write the CLI
      // uses. A failed refresh is worth naming only if the limits read fails
      // too: a still-valid token reads fine regardless.
      const account = await request("account/read", { refreshToken });
      const refreshError = account.error
        ? account.error.message || "Codex account read failed"
        : null;
      const limits = await request("account/rateLimits/read", {});
      return limits.error
        ? usageError(
            (limits.error.message || "Codex usage check failed") +
              (refreshError ? ` (token refresh: ${refreshError})` : ""),
          )
        : normalizeCodexRateLimits(limits.result);
    },
  );
}

export function codexUsageFor(accountId: string): CodexAccountUsage | null {
  return usageCache.get(accountId) || null;
}

export function clearCodexUsage(accountId: string): void {
  usageCache.delete(accountId);
}

// ── Rate-limit reset credits ────────────────────────────────────────────────
//
// ChatGPT plans sometimes grant credits that reset the Codex limits at once.
// Spend one only when it buys real time: the weekly window is fully used and
// will not reset by itself within two days. A weekly limit that frees up
// tomorrow is cheaper to wait out.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Skip the reset when the weekly window frees up by itself this soon. */
export const RESET_CREDIT_MIN_WAIT_MS = 2 * DAY_MS;
const WEEKLY_WINDOW_MINS = 7 * 24 * 60;

/** The weekly window of the Codex bucket the reset credits apply to. */
export function codexWeeklyWindow(
  usage: CodexAccountUsage,
): CodexUsageWindow | null {
  const bucket =
    usage.buckets.find((b) => b.id === "codex") ??
    (usage.buckets.length === 1 ? usage.buckets[0] : undefined);
  if (!bucket) return null;
  const windows = [bucket.primary, bucket.secondary].filter(
    (w): w is CodexUsageWindow => w !== null,
  );
  // Identify it by length. Only when no window states one, fall back to the
  // secondary slot, which is where paid plans report the weekly limit.
  if (windows.some((w) => w.windowDurationMins !== null)) {
    return (
      windows.find(
        (w) =>
          w.windowDurationMins !== null &&
          w.windowDurationMins >= WEEKLY_WINDOW_MINS - 24 * 60,
      ) ?? null
    );
  }
  return bucket.secondary;
}

/**
 * Whether to spend a reset credit on this account now: one is available, the
 * weekly limit is fully used, and its own reset is more than two days away.
 * An unknown reset time counts as "don't": a credit is not worth risking on
 * a window that may be about to clear.
 */
export function shouldUseCodexResetCredit(
  usage: CodexAccountUsage,
  now = Date.now(),
): boolean {
  if (usage.error || !usage.resetCreditsAvailable) return false;
  const weekly = codexWeeklyWindow(usage);
  if (!weekly || weekly.utilization === null || weekly.utilization < 100)
    return false;
  const resetsAt = weekly.resetsAt ? Date.parse(weekly.resetsAt) : NaN;
  return Number.isFinite(resetsAt) && resetsAt - now > RESET_CREDIT_MIN_WAIT_MS;
}

/**
 * Idempotency key for one exhausted weekly window of one account: a retry of
 * the same attempt (a timeout, a restart mid-call) reuses it, so the backend
 * spends at most one credit on it. Rounded to the hour so a reset time that
 * drifts by seconds between reads is still the same window.
 */
export function codexResetCreditKey(
  accountId: string,
  weeklyResetsAt: string,
): string {
  const hour = Math.floor(Date.parse(weeklyResetsAt) / 3_600_000);
  const hex = new Bun.CryptoHasher("sha256")
    .update(`codex-reset-credit:${accountId}:${hour}`)
    .digest("hex");
  // UUID layout (version 8, RFC 9562 variant), as the protocol recommends.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export type CodexResetCreditOutcome =
  | "reset"
  | "nothingToReset"
  | "noCredit"
  | "alreadyRedeemed";

export type CodexResetCreditResult =
  | { outcome: CodexResetCreditOutcome }
  | { error: string };

/** Redeem one reset credit for this CODEX_HOME. Resolves to the backend's
 * outcome, or an error message when the call itself failed. */
export async function consumeCodexResetCredit(
  codexHome: string,
  idempotencyKey: string,
  executable = "codex",
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CodexResetCreditResult> {
  return withCodexAuthLock(codexHome, () =>
    withAppServer<CodexResetCreditResult>(
      codexHome,
      executable,
      timeoutMs,
      (error) => ({ error }),
      async (request) => {
        const reply = await request("account/rateLimitResetCredit/consume", {
          idempotencyKey,
        });
        const outcome = reply.result?.outcome;
        if (reply.error || typeof outcome !== "string")
          return {
            error: reply.error?.message || "Codex reset credit call failed",
          };
        return { outcome: outcome as CodexResetCreditOutcome };
      },
    ),
  );
}

// Windows already settled one way or another, by idempotency key, so the
// hourly poll does not ask again for the same exhausted window. A failed
// call is not recorded: the next poll retries it with the same key.
const settledResetKeys: Map<string, CodexResetCreditOutcome> = ((
  globalThis as any
).__codexSettledResetKeys ??= new Map());
registerMemoryProbe("codex-usage.reset-keys", () => settledResetKeys.size);

export interface CodexUsageRefreshOptions {
  /** Called after a reset credit cleared an account's limits. */
  onResetCredit?: (account: CodexAccount) => void;
  /** Test seam: the `codex` binary to run. */
  executable?: string;
  now?: () => number;
}

async function maybeUseResetCredit(
  account: CodexAccount,
  usage: CodexAccountUsage,
  options: CodexUsageRefreshOptions,
): Promise<CodexAccountUsage> {
  const now = options.now?.() ?? Date.now();
  if (!shouldUseCodexResetCredit(usage, now)) return usage;
  const weekly = codexWeeklyWindow(usage)!;
  const key = codexResetCreditKey(account.id, weekly.resetsAt!);
  if (settledResetKeys.has(key)) return usage;
  const executable = options.executable ?? "codex";
  const result = await consumeCodexResetCredit(account.value, key, executable);
  const name = account.label || account.name || account.id;
  if ("error" in result) {
    console.warn(
      `[codex-usage] ${name}: reset credit failed, retrying next poll: ${result.error}`,
    );
    return usage;
  }
  settledResetKeys.set(key, result.outcome);
  console.log(
    `[codex-usage] ${name}: weekly limit full until ${weekly.resetsAt}; reset credit outcome ${result.outcome}`,
  );
  if (result.outcome !== "reset") return usage;
  options.onResetCredit?.(account);
  const after = await probeCodexUsage(account.value, executable);
  return after.error ? usage : after;
}

export async function refreshCodexUsage(
  accounts: CodexAccount[],
  options: CodexUsageRefreshOptions = {},
): Promise<void> {
  const liveIds = new Set(accounts.map((account) => account.id));
  for (const id of usageCache.keys()) {
    if (!liveIds.has(id)) usageCache.delete(id);
  }
  for (const account of accounts) {
    if (account.kind !== "home") {
      usageCache.delete(account.id);
      continue;
    }
    const previous = usageCache.get(account.id);
    let next = await probeCodexUsage(account.value, options.executable);
    // Keep the last good meters through a transient subprocess/network error.
    if (next.error && previous && !previous.error) continue;
    next = await maybeUseResetCredit(account, next, options);
    usageCache.set(account.id, next);
  }
}

export function startCodexUsagePolling(
  accounts: () => CodexAccount[],
  options: CodexUsageRefreshOptions = {},
): void {
  if (pollTimer) return;
  const refresh = () =>
    refreshCodexUsage(accounts(), options).catch((error) =>
      console.error("[codex-usage] poll failed:", error),
    );
  void refresh();
  pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
  console.log("[codex-usage] poller started (hourly)");
}
