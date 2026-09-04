/**
 * ChatGPT-plan usage for registered CODEX_HOME accounts.
 *
 * Codex exposes its authenticated rate-limit view through the supported
 * app-server JSON-RPC surface (`account/rateLimits/read`). Probe each account
 * with its own CODEX_HOME so token refresh and workspace selection stay owned
 * by the same auth.json that runs already use. API-key accounts deliberately
 * stay out: their spend belongs to an OpenAI Platform organization, not an
 * individual key, and needs a separate organization-level integration.
 */

import { readFileSync } from "fs";
import type { CodexAccount } from "./codex-accounts";
import { withCodexAuthLock } from "./codex-auth-lock";
import { homeDir } from "./paths";

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
export function codexAccessTokenNeedsRefresh(
  codexHome: string,
  now = Date.now(),
): boolean {
  try {
    const access = JSON.parse(readFileSync(`${codexHome}/auth.json`, "utf-8"))
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
  // Name the pipes in the type as well as the options: the bare spawn return
  // type describes the DEFAULT stdio, where stdin is an inherited fd rather
  // than the FileSink this writes to and stdout is not async-iterable.
  let proc: Bun.Subprocess<"pipe", "pipe", "ignore">;
  try {
    proc = Bun.spawn([executable, "app-server"], {
      env: appServerEnv(codexHome),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch (error: any) {
    return usageError(
      `Couldn't start Codex usage probe: ${error?.message || error}`,
    );
  }

  return await new Promise<CodexAccountUsage>((resolve) => {
    let settled = false;
    let buffer = "";
    // A failed refresh is worth naming only if the limits read fails too:
    // a still-valid token reads fine regardless.
    let refreshError: string | null = null;
    const decoder = new TextDecoder();
    const finish = (usage: CodexAccountUsage, kill = true) => {
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
      resolve(usage);
    };
    const send = (message: unknown) => {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const timer = setTimeout(
      () => finish(usageError("Codex usage check timed out")),
      timeoutMs,
    );

    void (async () => {
      try {
        for await (const chunk of proc.stdout) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 1_000_000) {
            finish(usageError("Codex usage response was too large"));
            return;
          }
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            if (!line) continue;
            const message = JSON.parse(line);
            if (message.id === 1) {
              if (message.error) {
                finish(
                  usageError(
                    message.error.message ||
                      "Codex usage initialization failed",
                  ),
                );
                return;
              }
              send({ method: "initialized", params: {} });
              // The limits read does not refresh an expired access token on
              // its own; it just fails. Ask the app-server to refresh first
              // when the token is near expiry, through the same code path
              // and auth.json write the CLI uses.
              send({
                method: "account/read",
                id: 2,
                params: {
                  refreshToken: codexAccessTokenNeedsRefresh(codexHome),
                },
              });
            }
            if (message.id === 2) {
              if (message.error) {
                refreshError =
                  message.error.message || "Codex account read failed";
              }
              send({ method: "account/rateLimits/read", id: 3, params: {} });
            }
            if (message.id === 3) {
              finish(
                message.error
                  ? usageError(
                      (message.error.message || "Codex usage check failed") +
                        (refreshError
                          ? ` (token refresh: ${refreshError})`
                          : ""),
                    )
                  : normalizeCodexRateLimits(message.result),
              );
              return;
            }
          }
        }
        finish(usageError("Codex usage process ended before replying"), false);
      } catch (error: any) {
        finish(
          usageError(`Couldn't read Codex usage: ${error?.message || error}`),
        );
      }
    })();

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "opensession",
          title: "Open Session",
          version: "1.0.0",
        },
      },
    });
  });
}

export function codexUsageFor(accountId: string): CodexAccountUsage | null {
  return usageCache.get(accountId) || null;
}

export function clearCodexUsage(accountId: string): void {
  usageCache.delete(accountId);
}

export async function refreshCodexUsage(
  accounts: CodexAccount[],
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
    const next = await probeCodexUsage(account.value);
    // Keep the last good meters through a transient subprocess/network error.
    if (next.error && previous && !previous.error) continue;
    usageCache.set(account.id, next);
  }
}

export function startCodexUsagePolling(accounts: () => CodexAccount[]): void {
  if (pollTimer) return;
  const refresh = () =>
    refreshCodexUsage(accounts()).catch((error) =>
      console.error("[codex-usage] poll failed:", error),
    );
  void refresh();
  pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
  console.log("[codex-usage] poller started (hourly)");
}
