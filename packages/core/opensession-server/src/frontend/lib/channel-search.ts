// Search results as the Search page lists them: grouped by conversation,
// the groups in the order their best match came.

import type { SearchResult } from "./api/slack-channels";

export interface SearchGroup {
  channelId: string;
  results: SearchResult[];
}

export function groupSearchResults(
  results: readonly SearchResult[],
): SearchGroup[] {
  const groups = new Map<string, SearchGroup>();
  for (const result of results) {
    const group = groups.get(result.channelId);
    if (group) group.results.push(result);
    else
      groups.set(result.channelId, {
        channelId: result.channelId,
        results: [result],
      });
  }
  return [...groups.values()];
}
