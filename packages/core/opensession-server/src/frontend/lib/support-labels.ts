/**
 * Filtering the Support page's queue by one Plain label, the way Plain's own
 * Labels list narrows its inbox.
 *
 * The pick is stored where the sidebar's Plain band keeps its Label filter
 * (`opensession-feed-filters` → `plain.label`, matched on the label's name),
 * so moving Support between the sidebar and its own page keeps the same view.
 */

import { FEED_FILTERS_KEY, readFeedFilters } from "./sidebar-filter";
import { PLAIN_ID } from "./support-surface";
import type { SupportThread } from "./types";

const LABEL_KEY = "label";

export interface SupportLabelOption {
  name: string;
  count: number;
}

/** Every label on the queue with how many tickets carry it, most used first. */
export function supportLabelOptions(
  threads: SupportThread[],
): SupportLabelOption[] {
  const counts = new Map<string, number>();
  for (const t of threads) {
    const names = new Set((t.labels || []).map((l) => l.name).filter(Boolean));
    for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** The tickets carrying `label`, or all of them when no label is picked. */
export function filterSupportThreadsByLabel(
  threads: SupportThread[],
  label: string,
): SupportThread[] {
  if (!label) return threads;
  return threads.filter((t) => (t.labels || []).some((l) => l.name === label));
}

export function readSupportLabel(): string {
  return readFeedFilters()[PLAIN_ID]?.[LABEL_KEY] || "";
}

export function writeSupportLabel(label: string): void {
  const all = readFeedFilters();
  all[PLAIN_ID] = { ...(all[PLAIN_ID] || {}), [LABEL_KEY]: label };
  try {
    localStorage.setItem(FEED_FILTERS_KEY, JSON.stringify(all));
  } catch {}
}
