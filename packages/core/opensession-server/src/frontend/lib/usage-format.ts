// Number formats shared by the usage readouts: the model menu's usage
// details, the header meter and the composer's usage bar.

import type { SessionUsage } from "./types";

export function fmtUsd(n: number): string {
  if (n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return compact.format(n);
}

/** Every token the conversation has sent or received, cache included. */
export function totalTokens(usage: SessionUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheCreationTokens
  );
}

/** Text tone for a limit's percent used, on the accounts page's thresholds:
 *  yellow from 70% used, red from 90%. Empty below that. */
export function limitTone(used: number): string {
  return used >= 90 ? "text-red" : used >= 70 ? "text-yellow" : "";
}
