/**
 * Reading the limits an account runs against.
 *
 * A Claude account reports three or four (a 5-hour window, a 7-day window, and
 * per-model weekly caps the provider names, today "Fable"); a Codex account
 * reports one or two per model bucket. Any of them can be the one that stops a
 * run, and they run out at different times, so the accounts page draws them
 * all. This module decides which of them are real numbers.
 */

export interface UsageWindow {
  utilization: number | null;
  resetsAt: string | null;
}

/** One limit an account runs against, named for how it reads in the list. */
export interface LimitWindow extends UsageWindow {
  label: string;
  /** A cap on one model rather than an account-wide window, so it sidelines
   *  the account for that model alone. Listed after the windows. */
  scoped?: boolean;
}

/** The shape of `usage` the Claude accounts route returns. */
export interface ClaudeUsageLimits {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  scopedLimits?: {
    label: string;
    utilization: number | null;
    resetsAt: string | null;
  }[];
}

const EMPTY: UsageWindow = { utilization: null, resetsAt: null };

/**
 * Mirrors the server's own read (`currentUtilization` in claude-accounts.ts):
 * a window whose reset has already passed is provably stale, so it counts as
 * empty instead of pinning a just-reset account at 100% until the next poll.
 */
export function liveUtilization(
  w: LimitWindow,
  now = Date.now(),
): number | null {
  if (w.utilization === null) return null;
  if (w.resetsAt) {
    const t = Date.parse(w.resetsAt);
    if (Number.isFinite(t) && t <= now) return 0;
  }
  return w.utilization;
}

/** A limit that reports a number, so a meter can draw it. */
export interface LiveLimit extends LimitWindow {
  utilization: number;
}

/**
 * Every limit an account reports a number for, account-wide windows first and
 * per-model caps after. A window the account reports nothing for is left out
 * rather than drawn empty: "unknown" and "nothing used" are different states,
 * and an empty bar claims the second.
 */
export function liveLimits(
  windows: LimitWindow[],
  now = Date.now(),
): LiveLimit[] {
  const accountWide: LiveLimit[] = [];
  const perModel: LiveLimit[] = [];
  for (const w of windows) {
    const utilization = liveUtilization(w, now);
    if (utilization === null) continue;
    (w.scoped ? perModel : accountWide).push({ ...w, utilization });
  }
  return [...accountWide, ...perModel];
}

/** Every limit a Claude account reports: the two rolling windows, plus the
 *  per-model weekly caps the `limits` array carries separately. */
export function claudeLimits(
  usage: ClaudeUsageLimits | null | undefined,
): LimitWindow[] {
  if (!usage) return [];
  return [
    { label: "5h", ...(usage.fiveHour ?? EMPTY) },
    { label: "7d", ...(usage.sevenDay ?? EMPTY) },
    ...(usage.scopedLimits ?? []).map((s) => ({ ...s, scoped: true })),
  ];
}
