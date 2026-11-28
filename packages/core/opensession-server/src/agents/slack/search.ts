/**
 * Search in the Channels place: Slack's search.messages with the person's
 * own grant, so results are what they may read. search.messages is a tier 2
 * method (about 20 calls a minute), so answers are cached per person and
 * query for a minute and identical requests share one call.
 */
import { slackApiGet } from "./slack-api";
import { searchedMessage, type SearchedMessage } from "./my-threads";

const TTL_MS = 60 * 1000;
const MAX_ENTRIES = 100;
export const SEARCH_PAGE_SIZE = 20;

export type SearchSort = "score" | "timestamp";

export interface SearchPage {
  matches: Array<{ found: SearchedMessage; raw: unknown }>;
  total: number;
  page: number;
  pages: number;
}

const cache = new Map<string, { at: number; value: Promise<SearchPage> }>();

/** One page of matches for `query`, best or newest first. */
export function searchSlack(
  caller: string,
  token: string,
  query: string,
  opts: { page?: number; sort?: SearchSort } = {},
): Promise<SearchPage> {
  const page = Math.max(1, Math.min(opts.page ?? 1, 100));
  const sort = opts.sort ?? "score";
  const key = `${caller}\n${sort}\n${page}\n${query}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = slackApiGet(
    "search.messages",
    { query, sort, sort_dir: "desc", count: SEARCH_PAGE_SIZE, page },
    token,
  ).then((data): SearchPage => {
    if (!data?.ok) throw new Error(data?.error || "search failed");
    const matches: SearchPage["matches"] = [];
    for (const raw of data.messages?.matches || []) {
      const found = searchedMessage(raw);
      if (found) matches.push({ found, raw });
    }
    const paging = data.messages?.paging || {};
    return {
      matches,
      total: Number(paging.total) || matches.length,
      page: Number(paging.page) || page,
      pages: Number(paging.pages) || 1,
    };
  });
  // A failure is not cached: the next try asks Slack again.
  value.catch(() => cache.delete(key));
  cache.set(key, { at: Date.now(), value });
  for (const old of cache.keys()) {
    if (cache.size <= MAX_ENTRIES) break;
    cache.delete(old);
  }
  return value;
}
