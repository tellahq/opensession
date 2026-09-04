/**
 * The weekly budget each subscription account has left, read the way the model
 * menu shows it: one line per account, the day it refills, and what remains.
 *
 * Each provider reports its limits in its own shape (`ClaudeUsageLimits`, Codex
 * buckets, SuperGrok credit periods). This module flattens the public account
 * records into one `AccountLimit` list per account, then picks the weekly ones
 * for the overview: the 5-hour window is what stops a turn, but the week is
 * what decides which account to run the day on.
 */
import { z } from "zod";
import { liveUtilization } from "./account-usage";
import { ownerMatchesPerson } from "./automation-audience";

/** One limit an account runs against, as the account list carries it. */
export interface AccountLimit {
  /** Model the cap is scoped to ("Fable"), or undefined for the account. */
  scope?: string;
  utilization: number | null;
  resetsAt: string | null;
  /** True for the window that refills once a week. */
  weekly: boolean;
}

const windowSchema = z
  .object({
    utilization: z.number().nullable().optional(),
    resetsAt: z.string().nullable().optional(),
    windowDurationMins: z.number().nullable().optional(),
  })
  .nullable()
  .optional();

/**
 * The `usage` field of a public account record, every provider's fields side
 * by side: Claude fills `sevenDay`/`scopedLimits`, Codex `buckets`, SuperGrok
 * `creditUsagePercent`/`periodEnd`. Parsed where the account list is fetched;
 * a usage blob this does not recognise reads as unknown rather than failing
 * the whole account list, because the pin picker still needs the accounts.
 */
export const accountUsageSchema = z
  .object({
    sevenDay: windowSchema,
    scopedLimits: z
      .array(
        z.object({
          label: z.string(),
          utilization: z.number().nullable().optional(),
          resetsAt: z.string().nullable().optional(),
        }),
      )
      .optional(),
    buckets: z
      .array(
        z.object({
          label: z.string().optional(),
          primary: windowSchema,
          secondary: windowSchema,
        }),
      )
      .optional(),
    creditUsagePercent: z.number().optional(),
    periodEnd: z.string().optional(),
  })
  .nullable()
  .optional()
  .catch(undefined);

export type AccountUsageRecord = z.infer<typeof accountUsageSchema>;

const WEEK_MINUTES = 7 * 24 * 60;

/** Flatten a parsed account record's `usage` into its limits. Unknown or
 *  missing usage yields nothing rather than a row that claims "0% used". */
export function accountLimitsFromUsage(
  provider: "claude" | "codex" | "xai",
  usage: AccountUsageRecord,
): AccountLimit[] {
  if (!usage) return [];
  if (provider === "claude") {
    const out: AccountLimit[] = [];
    const week = usage.sevenDay;
    if (week && week.utilization != null)
      out.push({
        utilization: week.utilization,
        resetsAt: week.resetsAt ?? null,
        weekly: true,
      });
    for (const s of usage.scopedLimits ?? [])
      if (s.utilization != null)
        out.push({
          scope: s.label,
          utilization: s.utilization,
          resetsAt: s.resetsAt ?? null,
          weekly: true,
        });
    return out;
  }
  if (provider === "codex") {
    const out: AccountLimit[] = [];
    for (const bucket of usage.buckets ?? [])
      for (const w of [bucket.primary, bucket.secondary])
        if (w && w.utilization != null)
          out.push({
            scope: bucket.label,
            utilization: w.utilization,
            resetsAt: w.resetsAt ?? null,
            weekly: (w.windowDurationMins ?? 0) >= WEEK_MINUTES,
          });
    return out;
  }
  if (usage.creditUsagePercent === undefined) return [];
  // SuperGrok budgets a billing period rather than a week; it is still the
  // number that decides whether the account has anything left to give.
  return [
    {
      utilization: usage.creditUsagePercent,
      resetsAt: usage.periodEnd ?? null,
      weekly: true,
    },
  ];
}

export interface AccountLimitSource {
  id: string;
  name: string;
  provider: "claude" | "codex" | "xai";
  owner?: string;
  usable?: boolean;
  limits?: AccountLimit[];
}

/** One line of the overview. */
export interface WeeklyRemainingRow {
  accountId: string;
  provider: "claude" | "codex" | "xai";
  /** Model the cap is scoped to ("Fable"), or undefined for the account. */
  scope?: string;
  /** Account name, with the model a scoped cap applies to. */
  label: string;
  /** Weekday the window refills, or "" when unknown. */
  day: string;
  /** Exact refill time for a hover, or undefined when unknown. */
  resetTitle?: string;
  /** Whole percent left, 0-100. */
  remaining: number;
  tone: "low" | "warn" | "ok";
  /** The viewer's name as the account records it when it is their personal
   *  subscription; undefined for a shared-pool account. */
  owner?: string;
}

/** Percent left → tone, on the same thresholds the accounts page uses for
 *  utilization (90% used is red, 70% used is yellow). */
export function remainingTone(remaining: number): WeeklyRemainingRow["tone"] {
  return remaining <= 10 ? "low" : remaining <= 30 ? "warn" : "ok";
}

function weekday(resetsAt: string | null, now: number): string {
  if (!resetsAt) return "";
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) return "";
  if (t <= now) return "now";
  return new Date(t).toLocaleDateString([], { weekday: "short" });
}

function resetTitle(resetsAt: string | null): string | undefined {
  if (!resetsAt) return undefined;
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) return undefined;
  return `Resets ${new Date(t).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

/** Can `viewer` run on this account: it sits in the shared pool, or it is
 *  their own personal subscription. Someone else's personal account is not
 *  theirs to spend, so its budget is noise here. */
export function accountAvailableTo(
  account: Pick<AccountLimitSource, "owner">,
  viewer: string,
): boolean {
  return !account.owner || ownerMatchesPerson(account.owner, viewer);
}

/**
 * The weekly overview: every account `viewer` can use that reports a weekly
 * number, in the order the list gives them, soonest-to-refill first within an
 * account. A window whose reset already passed reads as full, as it does
 * everywhere else.
 */
export function weeklyRemainingRows(
  accounts: AccountLimitSource[],
  viewer: string,
  now = Date.now(),
): WeeklyRemainingRow[] {
  const rows: WeeklyRemainingRow[] = [];
  for (const account of accounts) {
    if (!accountAvailableTo(account, viewer)) continue;
    for (const limit of account.limits ?? []) {
      if (!limit.weekly) continue;
      const used = liveUtilization(
        { label: "", utilization: limit.utilization, resetsAt: limit.resetsAt },
        now,
      );
      if (used === null) continue;
      const remaining = Math.max(0, Math.min(100, Math.round(100 - used)));
      const row: WeeklyRemainingRow = {
        accountId: account.id,
        provider: account.provider,
        label: limit.scope ? `${account.name} · ${limit.scope}` : account.name,
        day: weekday(limit.resetsAt, now),
        resetTitle: resetTitle(limit.resetsAt),
        remaining,
        tone: remainingTone(remaining),
        owner: account.owner,
      };
      if (limit.scope) row.scope = limit.scope;
      rows.push(row);
    }
  }
  // Your own subscriptions first: they are the ones routing spends before the
  // pool, so they are the numbers you want at a glance.
  return rows.sort((a, b) => Number(!!b.owner) - Number(!!a.owner));
}

/** The tightest weekly budget among `rows`, for the menu row's readout. */
export function lowestRemaining(
  rows: WeeklyRemainingRow[],
): WeeklyRemainingRow | undefined {
  let lowest: WeeklyRemainingRow | undefined;
  for (const row of rows)
    if (!lowest || row.remaining < lowest.remaining) lowest = row;
  return lowest;
}

const CLAUDE_SCOPED_MODEL_FAMILIES = ["fable", "opus", "sonnet", "haiku"];

/** Pick the limit that can stop `model` on one account. A Claude model with a
 * dedicated weekly bucket uses that bucket instead of the general 7-day one. */
function rowsForModel(
  rows: WeeklyRemainingRow[],
  model: string,
): WeeklyRemainingRow[] {
  if (rows[0]?.provider !== "claude") return rows;
  const normalizedModel = model.toLowerCase();
  const family = normalizedModel.includes("mythos")
    ? "fable"
    : CLAUDE_SCOPED_MODEL_FAMILIES.find((candidate) =>
        normalizedModel.includes(candidate),
      );
  if (!family) return rows.filter((row) => !row.scope);
  const scoped = rows.filter((row) =>
    row.scope?.toLowerCase().includes(family),
  );
  return scoped.length > 0 ? scoped : rows.filter((row) => !row.scope);
}

interface WeeklyReadoutOptions {
  rows: WeeklyRemainingRow[];
  accounts: AccountLimitSource[];
  viewer: string;
  provider?: AccountLimitSource["provider"];
  model: string;
  accountId?: string;
}

/**
 * The weekly number for the account automatic routing will use: a usable pin,
 * otherwise the viewer's personal subscription before the shared pool. Within
 * a group, prefer the account with the most model-specific headroom, matching
 * the pool's least-used choice closely enough without exposing runner state.
 */
export function weeklyRemainingReadout({
  rows,
  accounts,
  viewer,
  provider,
  model,
  accountId,
}: WeeklyReadoutOptions): WeeklyRemainingRow | undefined {
  const providerRows = provider
    ? rows.filter((row) => row.provider === provider)
    : rows;
  const candidates = accounts
    .filter(
      (account) =>
        (!provider || account.provider === provider) &&
        accountAvailableTo(account, viewer),
    )
    .map((account) => ({
      account,
      row: lowestRemaining(
        rowsForModel(
          providerRows.filter((row) => row.accountId === account.id),
          model,
        ),
      ),
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        account: AccountLimitSource;
        row: WeeklyRemainingRow;
      } => !!candidate.row,
    );

  const available = candidates.filter(
    ({ account, row }) => account.usable !== false && row.remaining > 0,
  );
  const best = (choices: typeof candidates) =>
    choices.reduce<(typeof candidates)[number] | undefined>(
      (current, candidate) =>
        !current || candidate.row.remaining > current.row.remaining
          ? candidate
          : current,
      undefined,
    )?.row;

  if (accountId) {
    const pinned = available.find(
      ({ account }) => account.id === accountId,
    )?.row;
    if (pinned) return pinned;
  }

  const personal = available.filter(({ account }) => !!account.owner);
  const pool = available.filter(({ account }) => !account.owner);
  return (
    best(personal) ??
    best(pool) ??
    best(candidates.filter(({ account }) => !!account.owner)) ??
    best(candidates.filter(({ account }) => !account.owner)) ??
    lowestRemaining(providerRows)
  );
}
