// What the usage bar and its compact ring both read: how full the context is,
// what the conversation has spent, and the limits of the account the next
// turn will most likely run on. One function so the two cannot disagree.

import type { ModelOption, ProviderAccountOption } from "./api";
import { sessionLimits, type SessionLimit } from "./account-limits";
import { baseModelId } from "./model-engine";
import { totalTokens } from "./usage-format";
import type { SessionUsage } from "./types";
import { contextFill } from "../components/UsageMeter";

export interface UsageSummaryInput {
  usage: SessionUsage;
  models: ModelOption[];
  model: string;
  defaultModel: string;
  accounts?: ProviderAccountOption[];
  accountId?: string;
}

export interface LimitRow {
  /** "5h" or "Week": the bar's short label. */
  name: string;
  /** "5-hour window", "Weekly", "Fable weekly cap". */
  long: string;
  limit: SessionLimit;
}

export function usageSummary(
  {
    usage,
    models,
    model,
    defaultModel,
    accounts,
    accountId,
  }: UsageSummaryInput,
  viewer: string,
) {
  const fill = contextFill(usage);
  const effective = baseModelId(model || defaultModel);
  const provider = models.find((m) => m.id === effective)?.accountProvider;
  const limits = accounts
    ? sessionLimits({ accounts, viewer, provider, model: effective, accountId })
    : undefined;
  const limitRows: LimitRow[] = [];
  if (limits?.short)
    limitRows.push({ name: "5h", long: "5-hour window", limit: limits.short });
  if (limits?.week)
    limitRows.push({
      name: "Week",
      long: limits.week.scope ? `${limits.week.scope} weekly cap` : "Weekly",
      limit: limits.week,
    });
  return {
    fill,
    // The tone reads the window itself, as the header meter's does: only a
    // prompt near the real ceiling is a problem.
    nearlyFull: fill.tone.text === "text-red",
    tokens: totalTokens(usage),
    limits,
    limitRows,
  };
}

/** Bar fill for a limit's percent used, on the accounts page's thresholds. */
export function limitFill(used: number): string {
  return used >= 90 ? "bg-red" : used >= 70 ? "bg-yellow" : "bg-faint";
}
