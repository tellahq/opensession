/**
 * Insert into a process-lifetime cache Map without letting it grow with the
 * number of distinct keys ever seen (sessions, worktrees, branches).
 *
 * The key is re-inserted so Map order is write recency, then the oldest
 * entries are evicted until the map is within `maxEntries` and, when `weigh`
 * is given, within `maxWeight` total (for example the characters of cached
 * patches). The entry just written is never evicted, so one oversized value is
 * still served once instead of being refetched on every call.
 */
export function setBounded<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  limits: {
    maxEntries: number;
    maxWeight?: number;
    weigh?: (value: V) => number;
  },
): void {
  map.delete(key);
  map.set(key, value);
  const { maxEntries, maxWeight, weigh } = limits;
  let weight = 0;
  if (weigh && maxWeight !== undefined)
    for (const v of map.values()) weight += weigh(v);
  for (const [oldest, v] of map) {
    const overCount = map.size > maxEntries;
    const overWeight =
      weigh !== undefined && maxWeight !== undefined && weight > maxWeight;
    if ((!overCount && !overWeight) || oldest === key) break;
    map.delete(oldest);
    if (weigh) weight -= weigh(v);
  }
}

/** Drop entries a predicate marks as expired. */
export function pruneWhere<K, V>(
  map: Map<K, V>,
  expired: (value: V, key: K) => boolean,
): void {
  for (const [key, value] of map) if (expired(value, key)) map.delete(key);
}

/**
 * Limits for the in-memory PR diff caches (pr-info.ts, codestorage/pr-host.ts).
 * A cached diff is the PR's whole patch, keyed by branch, so without a bound
 * every PR reviewed since boot stayed resident. Diffs are cheap to refetch and
 * the stale-on-error fallback only matters for recently viewed PRs.
 */
export const PR_DIFF_CACHE_LIMITS = {
  maxEntries: 64,
  /** Characters of patch text across all cached diffs. */
  maxWeight: 48 * 1024 * 1024,
  weigh: (entry: { data: { patch?: string } | null }) =>
    entry.data?.patch?.length ?? 0,
};
