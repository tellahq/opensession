import { fetchFeeds } from "./api";
import type { FeedDescriptor } from "./types";

/**
 * Module-level cache of the feed descriptors (band identity + panel
 * templates), shared by App's Video-tab derivation, WorkspacePane, and
 * anything else that needs to answer "what panel does this ExternalRef get?"
 * synchronously. App calls ensureFeedMeta() at boot and re-renders when it
 * lands; consumers read the cache via getFeedDescriptors()/panel helpers.
 */
let cached: FeedDescriptor[] = [];
let inflight: Promise<FeedDescriptor[]> | null = null;
let loadedAt = 0;
const TTL = 5 * 60_000;

export function ensureFeedMeta(): Promise<FeedDescriptor[]> {
  if (cached.length && Date.now() - loadedAt < TTL)
    return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = fetchFeeds()
    .then((feeds) => {
      cached = feeds;
      loadedAt = Date.now();
      return feeds;
    })
    .catch(() => cached)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function getFeedDescriptors(): FeedDescriptor[] {
  return cached;
}

export function feedForRefKind(kind: string): FeedDescriptor | undefined {
  return cached.find((f) => f.refKind === kind);
}
