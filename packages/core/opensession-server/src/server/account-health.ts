/**
 * Account-auth health monitor — Slack notifications for credential expiry.
 *
 * The Claude subscription pool and the codex (OpenAI) pool both authenticate
 * runs with credentials a human must occasionally renew, and until now they
 * rotted silently: a codex account's auth.json sat expired for 10+ days
 * (2026-07-12) and only surfaced when the model-fallback chain dead-ended on
 * it mid-outage. This module sweeps both pools hourly and DMs the person who
 * can fix each problem:
 *
 *  - Claude account with an `owner` (personal sub) → DM that teammate
 *    (resolved through the same identity table as commit attribution).
 *  - Pool Claude accounts and all codex accounts → DM the instance owner.
 *
 * Detected issues: unreadable/expired Claude OAuth credential files, revoked
 * setup-tokens (401 from the usage endpoint), Claude refresh tokens within a
 * week of expiry, and codex ChatGPT access tokens expired or within a day of
 * expiry. The sweep first runs refreshIdleCodexTokens (codex-token-refresh.ts)
 * so a codex expiry alert only ever fires when the in-process refresh itself
 * failed (dead refresh token, endpoint trouble).
 *
 * Alerts dedupe through a state file: a standing issue re-alerts daily, and
 * clears silently once fixed. Transient poller noise (rate-limit cooldowns)
 * is never alerted.
 */

import { existsSync, readFileSync } from "fs";
import { listAccountsPublic } from "./claude-accounts";
import { listCodexAccountsPublic } from "./codex-accounts";
import { refreshIdleCodexTokens } from "./codex-token-refresh";
import { stateDir } from "./paths";
import { resolveTeammate } from "./shared/user-mappings";
import { writeFileAtomic } from "./shared/atomic-write";
import { openDirectMessage, sendSlackMessage } from "../agents/slack/slack-api";
import { audit } from "./audit";
import {
  configuredIdentity,
  configuredIntegration,
  githubBotLogins,
  githubWriteOwners,
  personaName,
} from "./config";

const STATE_PATH = stateDir("account-health.json");
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
// Let the usage poller populate its cache before the first sweep reads it.
const FIRST_SWEEP_DELAY_MS = 10 * 60 * 1000;
const REALERT_MS = 24 * 60 * 60 * 1000;
const CLAUDE_REFRESH_WARN_MS = 7 * 24 * 60 * 60 * 1000;
const CODEX_ACCESS_WARN_MS = 24 * 60 * 60 * 1000;
const configuredHealthOwner = configuredIntegration("accountHealth").notifyUser;
// Pool-wide alerts go to the configured owner, then the first directory entry.
const FALLBACK_TEAMMATE =
  (typeof configuredHealthOwner === "string" ? configuredHealthOwner : "") ||
  configuredIdentity().team[0]?.aliases?.[0] ||
  configuredIdentity().team[0]?.name ||
  "";

interface Issue {
  /** Stable dedupe key: pool:accountId:kind. */
  key: string;
  /** Slack-DM body (already prefixed with the configured persona). */
  message: string;
  /** Teammate ref to DM (name/alias/Slack id); pool issues use the fallback. */
  notify: string;
}

interface HealthState {
  alerts: Record<string, { lastSentAt: string }>;
}

function readState(): HealthState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    return {
      alerts:
        parsed?.alerts && typeof parsed.alerts === "object"
          ? parsed.alerts
          : {},
    };
  } catch {
    return { alerts: {} };
  }
}

function writeState(state: HealthState): void {
  writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
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

function days(ms: number): string {
  const d = ms / (24 * 60 * 60 * 1000);
  return d >= 2
    ? `${Math.floor(d)} days`
    : `${Math.max(1, Math.round(ms / (60 * 60 * 1000)))}h`;
}

function claudeIssues(): Issue[] {
  const issues: Issue[] = [];
  for (const a of listAccountsPublic()) {
    const who = a.owner || FALLBACK_TEAMMATE;
    const identity = a.email?.trim() || a.name;
    const label = a.owner
      ? `your personal Claude sub "${identity}"`
      : `pool Claude account "${identity}"`;
    const err = a.usage?.error || "";
    const relogin = a.credentialsPath?.includes(".opensession-claude-oauth")
      ? `Reconnect usage in Settings → Providers → account menu → "Connect usage".`
      : a.credentialsPath
        ? `Re-login on the VPS: \`CLAUDE_CONFIG_DIR=${a.credentialsPath.replace(/\/credentials\.json$/, "")} claude login\`, or switch to the web flow in Settings → Providers → account menu → "Connect usage".`
        : "Generate a fresh token with `claude setup-token` and update it in Settings → Providers.";

    if (a.usage?.errorStatus === 401) {
      issues.push({
        key: `claude:${a.id}:${a.credentialsPath ? "usage-revoked" : "revoked"}`,
        message: a.credentialsPath
          ? `It's ${personaName()}. Usage tracking for ${label} needs a new Claude sign-in. Model runs keep using its setup token. ${relogin}`
          : `It's ${personaName()}. ${label} has a revoked or invalid setup token (401 from Anthropic), so model runs on it will fail. ${relogin}`,
        notify: who,
      });
      continue;
    }
    if (err.includes("Couldn't read OAuth credentials")) {
      issues.push({
        key: `claude:${a.id}:creds-missing`,
        message: `It's ${personaName()} — ${label} points at an OAuth credentials file I can't read (${a.credentialsPath}). Usage tracking is blind for it. ${relogin}`,
        notify: who,
      });
      continue;
    }
    if (err.includes("expired and refresh failed")) {
      issues.push({
        key: `claude:${a.id}:creds-expired`,
        message: `It's ${personaName()} — ${label}: its OAuth credentials expired and the refresh failed. ${relogin}`,
        notify: who,
      });
      continue;
    }
    // Look-ahead: a refresh token near expiry means a forced re-login soon.
    if (a.credentialsPath && existsSync(a.credentialsPath)) {
      try {
        const creds = JSON.parse(
          readFileSync(a.credentialsPath, "utf-8"),
        )?.claudeAiOauth;
        const refreshExp = Number(creds?.refreshTokenExpiresAt) || 0;
        if (refreshExp > 0) {
          const left = refreshExp - Date.now();
          if (left <= 0) {
            issues.push({
              key: `claude:${a.id}:refresh-expired`,
              message: `It's ${personaName()} — ${label}: its OAuth refresh token has expired; the next access-token refresh will fail. ${relogin}`,
              notify: who,
            });
          } else if (left < CLAUDE_REFRESH_WARN_MS) {
            issues.push({
              key: `claude:${a.id}:refresh-expiring`,
              message: `It's ${personaName()} — heads-up: ${label}'s OAuth refresh token expires in ${days(left)}. ${relogin}`,
              notify: who,
            });
          }
        }
      } catch {
        // Unreadable file is caught by the poller error branch above next sweep.
      }
    }
  }
  return issues;
}

function codexIssues(): Issue[] {
  const issues: Issue[] = [];
  for (const a of listCodexAccountsPublic()) {
    if (a.kind !== "home") continue; // API keys don't expire on a clock.
    const identity = a.email?.trim() || a.name;
    const home = a.valueMasked; // for kind=home this is the CODEX_HOME path
    const fix = `Fix on the VPS: \`CODEX_HOME=${home} codex login\` (or copy a fresh ~/.codex/auth.json into ${home}/).`;
    const authPath = `${home}/auth.json`;
    if (!existsSync(authPath)) {
      issues.push({
        key: `codex:${a.id}:auth-missing`,
        message: `It's ${personaName()} — codex account "${identity}" has no auth.json at ${authPath}; OpenAI-model runs on it will fail. ${fix}`,
        notify: FALLBACK_TEAMMATE,
      });
      continue;
    }
    let access: string | undefined;
    try {
      access = JSON.parse(readFileSync(authPath, "utf-8"))?.tokens
        ?.access_token;
    } catch {
      issues.push({
        key: `codex:${a.id}:auth-unreadable`,
        message: `It's ${personaName()} — codex account "${identity}": ${authPath} isn't valid JSON; OpenAI-model runs on it will fail. ${fix}`,
        notify: FALLBACK_TEAMMATE,
      });
      continue;
    }
    if (!access) continue; // API-key style login; nothing to expire.
    const exp = jwtExpMs(access);
    if (exp === null) continue;
    const left = exp - Date.now();
    if (left <= 0) {
      issues.push({
        key: `codex:${a.id}:access-expired`,
        message: `It's ${personaName()} — codex account "${identity}"'s ChatGPT access token is expired, so OpenAI-model runs (and the Fable→Sol fallback) fail on it. ${fix}`,
        notify: FALLBACK_TEAMMATE,
      });
    } else if (left < CODEX_ACCESS_WARN_MS) {
      issues.push({
        key: `codex:${a.id}:access-expiring`,
        message: `It's ${personaName()} — heads-up: codex account "${identity}"'s ChatGPT access token expires in ${days(left)} and only refreshes when a codex turn runs. ${fix}`,
        notify: FALLBACK_TEAMMATE,
      });
    }
  }
  return issues;
}

async function dmTeammate(
  teammateRef: string,
  message: string,
): Promise<boolean> {
  const teammate =
    resolveTeammate(teammateRef) ?? resolveTeammate(FALLBACK_TEAMMATE);
  if (!teammate) return false;
  const channel = await openDirectMessage(teammate.slackId);
  if (!channel) return false;
  const res = await sendSlackMessage(channel, message);
  return !!res?.ok;
}

/** Detection only, no DMs/state — for dry runs and tests. */
export function detectAccountIssues(): Issue[] {
  return [...claudeIssues(), ...codexIssues()];
}

/**
 * The GitHub App is the credential the bot now rides on most installs. If it is
 * configured (client id + key) but cannot mint an installation token — a revoked
 * key, an uninstalled App, a wrong installation owner — every bot gh/PR flow is
 * down. Warn on that. Skipped when no App identity has been configured yet.
 */
async function githubAppIssues(): Promise<Issue[]> {
  const { githubAppConfigured, githubToken } = await import("./github-app");
  if (!githubAppConfigured()) return [];
  if (await githubToken()) return [];
  const agent = personaName();
  const owner = githubWriteOwners()[0] || "the configured owner";
  return [
    {
      key: "github:app:dead",
      message:
        `${agent} here — the GitHub App is configured but cannot mint an ` +
        `installation token: every bot gh/PR flow is down. Check the App is still ` +
        `installed on ${owner}'s repositories and that its private key is valid.`,
      notify: FALLBACK_TEAMMATE,
    },
  ];
}

/** Check the App installation token used for all service traffic. */
export async function selectedGithubCredentialIssues(): Promise<Issue[]> {
  return githubAppIssues();
}

/** One sweep: detect, dedupe against state, DM, persist. Exported for tests/manual runs. */
export async function sweepAccountHealth(): Promise<Issue[]> {
  // Repair before detecting: refresh idle codex accounts' ChatGPT tokens so
  // an expiry that a refresh can fix never becomes an alert.
  await refreshIdleCodexTokens().catch((e) =>
    console.warn("[account-health] codex token refresh failed:", e),
  );
  const issues = [
    ...detectAccountIssues(),
    ...(await selectedGithubCredentialIssues()),
  ];
  const state = readState();
  const now = Date.now();
  const live = new Set(issues.map((i) => i.key));
  // Drop cleared issues so a relapse re-alerts immediately.
  for (const key of Object.keys(state.alerts)) {
    if (!live.has(key)) delete state.alerts[key];
  }
  for (const issue of issues) {
    const last = Date.parse(state.alerts[issue.key]?.lastSentAt || "") || 0;
    if (now - last < REALERT_MS) continue;
    const sent = await dmTeammate(issue.notify, issue.message);
    audit({
      msg: "account_health_alert",
      issue: issue.key,
      notify: issue.notify,
      delivered: sent,
    });
    if (sent)
      state.alerts[issue.key] = { lastSentAt: new Date(now).toISOString() };
    else
      console.warn(
        `[account-health] failed to DM ${issue.notify} about ${issue.key}`,
      );
  }
  writeState(state);
  return issues;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Start the hourly sweep. Call once from the __opensessionBooted block. */
export function startAccountHealthMonitor(): void {
  if (sweepTimer) return;
  setTimeout(() => {
    void sweepAccountHealth().catch((e) =>
      console.error("[account-health] sweep failed:", e),
    );
  }, FIRST_SWEEP_DELAY_MS);
  sweepTimer = setInterval(() => {
    void sweepAccountHealth().catch((e) =>
      console.error("[account-health] sweep failed:", e),
    );
  }, SWEEP_INTERVAL_MS);
  console.log(
    `[account-health] monitor started (hourly sweep, first in ${FIRST_SWEEP_DELAY_MS / 60000}m)`,
  );
}
