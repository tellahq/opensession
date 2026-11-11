/**
 * `opensession-usage` — how much of each model subscription is left.
 *
 * One read tool over the three account pools (Claude, Codex, SuperGrok): for
 * every account the calling run may use, each limit it runs against as a used
 * and remaining percentage with its reset time, whether the picker would hand
 * it out right now, and how old the numbers are. Agents use it to plan work:
 * which model has headroom, whether a big fan-out fits before a window resets,
 * when a sidelined pool comes back.
 *
 * Only accounts the run could be given are listed, through the same owner
 * gate the pickers apply: shared pool accounts, plus personal accounts owned
 * by the run's user. A run without a user (an automation) sees the pool only.
 * Tokens, the email field and credential paths never leave this module.
 *
 * Held to the automation in-process bar like opensession-health: aggregate
 * numbers, no writes. The one lever, `refresh`, re-polls the providers'
 * usage endpoints at most once per REFRESH_COOLDOWN_MS per provider for the
 * whole instance, so untrusted text cannot use it to hammer them.
 */

import { z } from "zod";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import {
  listAccountsPublic,
  refreshAllUsage,
  type ClaudeAccountPublic,
} from "./claude-accounts";
import {
  listCodexAccountsPublic,
  refreshAllCodexUsage,
  type CodexAccountPublic,
} from "./codex-accounts";
import {
  listXaiAccountsPublic,
  refreshXaiUsage,
  type XaiAccountPublic,
} from "./xai-accounts";
import { userMatchesAny } from "./shared/user-mappings";

type Provider = "claude" | "codex" | "xai";
const PROVIDERS: readonly Provider[] = ["claude", "codex", "xai"];

/** A forced refresh within this long of the last one serves the cache. */
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
/** How long a call waits on a refresh before answering from the cache. */
const REFRESH_WAIT_MS = 30 * 1000;

export interface UsageLimit {
  /** "5h", "7d", "Fable weekly", "GPT-5 7d", "billing period". */
  name: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  /** A cap on one model rather than the whole account. */
  modelScoped?: boolean;
}

export interface UsageAccount {
  provider: Provider;
  id: string;
  name: string;
  plan?: string;
  mode: "shared" | "personal";
  /** The picker would hand this account to a new run right now. */
  usable: boolean;
  /** Benched after a limit error or a wedge until this time. */
  sidelinedUntil?: string;
  usageFetchedAt?: string;
  usageError?: string;
  /** No usage numbers are available for this account at all. */
  usageUnknown?: boolean;
  limits: UsageLimit[];
  /** Extra headroom past the subscription limits (paid credits). */
  overflow?: string;
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * A window whose reset has passed is provably stale, so it reads as empty
 * rather than pinning a just-reset account at its old percentage until the
 * next poll (the same rule as currentUtilization in claude-accounts.ts).
 */
function limit(
  name: string,
  utilization: number | null | undefined,
  resetsAt: string | null | undefined,
  now: number,
  modelScoped = false,
): UsageLimit {
  let used = utilization ?? null;
  let resets = resetsAt ?? null;
  if (used !== null && resets) {
    const t = Date.parse(resets);
    if (Number.isFinite(t) && t <= now) {
      used = 0;
      resets = null;
    }
  }
  return {
    name,
    usedPercent: used === null ? null : round(used),
    remainingPercent: used === null ? null : round(Math.max(0, 100 - used)),
    resetsAt: resets,
    ...(modelScoped ? { modelScoped: true } : {}),
  };
}

/** "5h", "7d", "90m" from a window length in minutes. */
export function windowName(mins: number | null): string {
  if (!mins || mins <= 0) return "window";
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

function base(
  provider: Provider,
  a: {
    id: string;
    name: string;
    label?: string;
    plan?: string;
    mode: "shared" | "personal";
    usable: boolean;
    exhaustedUntil: string | null;
  },
): Omit<UsageAccount, "limits"> {
  return {
    provider,
    id: a.id,
    name: a.label || a.name,
    ...(a.plan ? { plan: a.plan } : {}),
    mode: a.mode,
    usable: a.usable,
    ...(a.exhaustedUntil ? { sidelinedUntil: a.exhaustedUntil } : {}),
  };
}

export function claudeUsageAccount(
  a: ClaudeAccountPublic,
  now = Date.now(),
): UsageAccount {
  const u = a.usage;
  const limits: UsageLimit[] = [];
  if (u) {
    if (u.fiveHour)
      limits.push(limit("5h", u.fiveHour.utilization, u.fiveHour.resetsAt, now));
    if (u.sevenDay)
      limits.push(limit("7d", u.sevenDay.utilization, u.sevenDay.resetsAt, now));
    for (const s of u.scopedLimits ?? [])
      limits.push(
        limit(`${s.label} weekly`, s.utilization, s.resetsAt, now, true),
      );
  }
  const extra = u?.extraUsage;
  return {
    ...base("claude", a),
    ...(u?.fetchedAt ? { usageFetchedAt: u.fetchedAt } : {}),
    ...(u?.error ? { usageError: u.error } : {}),
    ...(!u || a.noUsageScope ? { usageUnknown: true } : {}),
    limits,
    ...(extra?.enabled
      ? {
          overflow: `extra usage on: ${extra.usedCredits} of ${extra.monthlyLimit} monthly credits used`,
        }
      : {}),
  };
}

export function codexUsageAccount(
  a: CodexAccountPublic,
  now = Date.now(),
): UsageAccount {
  const u = a.usage;
  const multiBucket = (u?.buckets.length ?? 0) > 1;
  const limits: UsageLimit[] = [];
  const overflow: string[] = [];
  for (const b of u?.buckets ?? []) {
    const prefix = multiBucket ? `${b.label || b.id} ` : "";
    for (const w of [b.primary, b.secondary])
      if (w)
        limits.push(
          limit(
            `${prefix}${windowName(w.windowDurationMins)}`,
            w.utilization,
            w.resetsAt,
            now,
            multiBucket,
          ),
        );
    if (b.credits?.unlimited) overflow.push(`${prefix}unlimited credits`);
    else if (b.credits?.hasCredits)
      overflow.push(`${prefix}credits ${b.credits.balance ?? "available"}`);
    if (b.spendLimit)
      overflow.push(
        `${prefix}spend ${b.spendLimit.used} of ${b.spendLimit.limit}`,
      );
  }
  return {
    ...base("codex", a),
    ...(u?.fetchedAt ? { usageFetchedAt: u.fetchedAt } : {}),
    ...(u?.error ? { usageError: u.error } : {}),
    ...(!u ? { usageUnknown: true } : {}),
    limits,
    ...(overflow.length ? { overflow: overflow.join("; ") } : {}),
  };
}

export function xaiUsageAccount(
  a: XaiAccountPublic,
  now = Date.now(),
): UsageAccount {
  const u = a.usage;
  const limits: UsageLimit[] = [];
  if (u?.creditUsagePercent !== undefined)
    limits.push(
      limit(
        u.periodType ? `${u.periodType} credits` : "billing period credits",
        u.creditUsagePercent,
        u.periodEnd,
        now,
      ),
    );
  for (const p of u?.productUsage ?? [])
    limits.push(limit(p.product, p.usagePercent, u?.periodEnd, now, true));
  return {
    ...base("xai", { ...a, plan: u?.subscriptionTier }),
    ...(u?.fetchedAt ? { usageFetchedAt: u.fetchedAt } : {}),
    ...(u?.error || a.refreshError
      ? { usageError: u?.error || a.refreshError }
      : {}),
    ...(!u ? { usageUnknown: true } : {}),
    limits,
    ...(u?.onDemandEnabled
      ? {
          overflow: `on-demand on${
            u.onDemandUsedCents !== undefined
              ? `: $${(u.onDemandUsedCents / 100).toFixed(2)}${
                  u.onDemandCapCents !== undefined
                    ? ` of $${(u.onDemandCapCents / 100).toFixed(2)}`
                    : ""
                } used`
              : ""
          }`,
        }
      : {}),
  };
}

// ── Refresh, rate-bounded for the whole instance ────────────────────────────

const REFRESHERS: Record<Provider, () => Promise<void>> = {
  claude: refreshAllUsage,
  codex: refreshAllCodexUsage,
  xai: () => refreshXaiUsage(),
};
const lastRefreshAt = new Map<Provider, number>();
const inFlight = new Map<Provider, Promise<void>>();

/** Start (or join) a refresh unless one ran within the cooldown. */
function refresh(provider: Provider, now: number): Promise<void> {
  const running = inFlight.get(provider);
  if (running) return running;
  if (now - (lastRefreshAt.get(provider) ?? 0) < REFRESH_COOLDOWN_MS)
    return Promise.resolve();
  lastRefreshAt.set(provider, now);
  const p = REFRESHERS[provider]()
    .catch((e) => console.error(`[usage-mcp] ${provider} refresh failed:`, e))
    .finally(() => inFlight.delete(provider));
  inFlight.set(provider, p);
  return p;
}

// ── Report ──────────────────────────────────────────────────────────────────

export interface UsageReportInput {
  /** The run's user; undefined means pool accounts only. */
  user?: string;
  providers?: readonly Provider[];
  now?: number;
  /** Test seam: the public account lists. */
  lists?: {
    claude: ClaudeAccountPublic[];
    codex: CodexAccountPublic[];
    xai: XaiAccountPublic[];
  };
}

/** The tightest limit left on an account, the one that stops it first. */
function tightest(a: UsageAccount): UsageLimit | undefined {
  return a.limits
    .filter((l) => l.remainingPercent !== null && !l.modelScoped)
    .sort((x, y) => x.remainingPercent! - y.remainingPercent!)[0];
}

export function buildUsageReport(input: UsageReportInput) {
  const now = input.now ?? Date.now();
  const lists = input.lists ?? {
    claude: listAccountsPublic(),
    codex: listCodexAccountsPublic(),
    xai: listXaiAccountsPublic(),
  };
  const visible = (a: { owner?: string }) =>
    !a.owner || (!!input.user && userMatchesAny(input.user, [a.owner]));
  const builders = {
    claude: () =>
      lists.claude.filter(visible).map((a) => claudeUsageAccount(a, now)),
    codex: () =>
      lists.codex.filter(visible).map((a) => codexUsageAccount(a, now)),
    xai: () => lists.xai.filter(visible).map((a) => xaiUsageAccount(a, now)),
  };
  const providers: Record<string, unknown> = {};
  for (const p of input.providers?.length ? input.providers : PROVIDERS) {
    const accounts = builders[p]();
    const usable = accounts.filter((a) => a.usable);
    const best = usable
      .map((a) => tightest(a)?.remainingPercent)
      .filter((n): n is number => n != null);
    const nextReturn = accounts
      .filter((a) => !a.usable && a.sidelinedUntil)
      .map((a) => a.sidelinedUntil!)
      .sort()[0];
    providers[p] = {
      accounts: accounts.length,
      usableNow: usable.length,
      ...(best.length ? { bestRemainingPercent: Math.max(...best) } : {}),
      ...(nextReturn ? { nextSidelineEnds: nextReturn } : {}),
      list: accounts,
    };
  }
  return {
    now: new Date(now).toISOString(),
    ...(input.user ? {} : { scope: "shared pool accounts only" }),
    notes: [
      "remainingPercent is per limit; an account stops at its tightest one. bestRemainingPercent is the most headroom any usable account has on its tightest account-wide limit.",
      "Claude: new runs avoid an account at 97% of its 5h window; a model-scoped weekly cap (e.g. Fable) only blocks that model, at 100%.",
      "Usage is polled hourly; check usageFetchedAt, or pass refresh: true for fresh numbers.",
    ],
    providers,
  };
}

export function createUsageMcpServer(opts: { user?: string } = {}) {
  const tools = [
    tool(
      "read_subscription_usage",
      "Read how much of each model subscription (Claude, Codex/ChatGPT, SuperGrok) is used and left, so you can plan work: for every account this run may use, each limit (Claude 5h and 7d windows plus per-model weekly caps, Codex windows per model bucket, SuperGrok period credits) as used and remaining percent with its reset time, whether the account is usable right now or sidelined and until when, paid overflow (extra usage, credits), and when the numbers were fetched. Also a per-provider summary: usable account count and the best remaining headroom. Usage is polled hourly; pass refresh: true to re-poll first (rate-limited to once per 5 minutes per provider).",
      {
        provider: z
          .enum(["claude", "codex", "xai"])
          .optional()
          .describe("Only this provider. Default: all."),
        refresh: z
          .boolean()
          .optional()
          .describe(
            "Re-poll the providers first. Waits up to 30 seconds, then answers from the cache.",
          ),
      },
      async ({ provider, refresh: wantRefresh }) => {
        const providers = provider ? [provider] : PROVIDERS;
        if (wantRefresh) {
          const now = Date.now();
          await Promise.race([
            Promise.all(providers.map((p) => refresh(p, now))),
            new Promise((r) => setTimeout(r, REFRESH_WAIT_MS).unref?.()),
          ]);
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                buildUsageReport({ user: opts.user, providers }),
                null,
                2,
              ),
            },
          ],
        };
      },
    ),
  ];
  return createSdkMcpServer({
    name: "opensession-usage",
    version: "1.0.0",
    tools,
  });
}
