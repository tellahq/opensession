import { request } from "./request";
import type { FeedDescriptor, FeedItem } from "../types";

/** The sidebar's generic feed bands (videos, … — the feeds design). */
export async function fetchFeeds(): Promise<FeedDescriptor[]> {
  const body = await request<{ feeds?: FeedDescriptor[] }>("/feeds", {
    label: "Failed to fetch feeds",
  });
  return body?.feeds || [];
}

/** One feed band's items (server-cached ~60s). Arg-mode filter selections
 *  ride as f_<key> params and reach the backing list tool. */
export async function fetchFeedItems(
  feedId: string,
  argFilters?: Record<string, string>,
): Promise<FeedItem[]> {
  const qs = Object.entries(argFilters || {})
    .filter(([, v]) => v)
    .map(([k, v]) => `f_${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const body = await request<{ items?: FeedItem[] }>(
    `/feeds/${encodeURIComponent(feedId)}/items${qs ? `?${qs}` : ""}`,
    { label: "Failed to fetch feed items" },
  );
  return body?.items || [];
}

/** Options for one of a feed's filter controls (viewer's grant). */
export async function fetchFeedFilterOptions(
  feedId: string,
  key: string,
): Promise<{ value: string; label: string }[]> {
  const body = await request<{ options?: { value: string; label: string }[] }>(
    `/feeds/${encodeURIComponent(feedId)}/filters/${encodeURIComponent(key)}/options`,
    { label: "Failed to fetch filter options" },
  );
  return body?.options || [];
}
