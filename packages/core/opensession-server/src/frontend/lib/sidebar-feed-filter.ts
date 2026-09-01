import { dget, type FeedFilterValues } from "./sidebar-filter";
import type { FeedDescriptor, FeedItem, UnifiedSession } from "./types";

interface SidebarFeedFilterOptions {
  feed: FeedDescriptor;
  items: FeedItem[];
  search: string;
  values: FeedFilterValues;
  sessionForItem: (
    feed: FeedDescriptor,
    item: FeedItem,
  ) => UnifiedSession | undefined;
}

export function filterSidebarFeedItems({
  feed,
  items,
  search,
  values,
  sessionForItem,
}: SidebarFeedFilterOptions) {
  let list = items;
  const query = search.trim().toLowerCase();
  if (query)
    list = list.filter((item) =>
      [
        item.title,
        item.preview,
        ...(feed.searchMeta || []).map((path) => dget(item.meta, path)),
      ].some(
        (value) =>
          typeof value === "string" && value.toLowerCase().includes(query),
      ),
    );
  for (const spec of feed.filters || []) {
    if (spec.mode !== "meta") continue;
    const selected = values[spec.key];
    if (!selected) continue;
    list = list.filter((item) => {
      const value = dget(item.meta, spec.field);
      if (value == null || (Array.isArray(value) && value.length === 0))
        return selected === "__unassigned__";
      const elements = Array.isArray(value) ? value : [value];
      return elements.some(
        (element) =>
          String(dget(element, spec.optionsFromItems?.value) ?? element) ===
          selected,
      );
    });
  }
  if (values.__session === "with")
    list = list.filter((item) => !!sessionForItem(feed, item));
  else if (values.__session === "without")
    list = list.filter((item) => !sessionForItem(feed, item));
  return list;
}
