import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  fetchFeedItems,
  fetchFeeds,
  fetchOpenPrs,
  PR_CLOSED_EVENT,
  PR_REVIEW_SUBMITTED_EVENT,
  type OpenPr,
  type PrClosedDetail,
} from "../lib/api";
import { sameOpenPrSnapshot } from "../lib/open-pr-snapshot";
import { supportThreadsFromFeedItems } from "../lib/sidebar-derived";
import {
  FEED_FILTERS_KEY,
  readFeedFilters,
  type FeedFilterValues,
} from "../lib/sidebar-filter";
import type { FeedDescriptor, FeedItem, UnifiedSession } from "../lib/types";

export function useSidebarSources({
  sessions,
  hiddenFeeds,
}: {
  sessions: UnifiedSession[];
  hiddenFeeds: Set<string>;
}) {
  // The repo-wide open-PR list (every open PR, session or not), from the
  // server's batched cache. Null until the first fetch lands — the rows memo
  // falls back to session-derived PRs so the section still renders if the
  // endpoint is unreachable.
  const [openPrs, setOpenPrs] = useState<OpenPr[] | null>(null);
  const prCloseGeneration = useRef(0);
  const closedPrTombstones = useRef(new Map<string, number>());
  const openPrRequestSequence = useRef(0);
  const latestOpenPrResponse = useRef(0);
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return Promise.resolve();
      const requestSequence = ++openPrRequestSequence.current;
      const requestGeneration = prCloseGeneration.current;
      return fetchOpenPrs()
        .then((prs) => {
          if (!alive) return;
          if (requestSequence < latestOpenPrResponse.current) return;
          latestOpenPrResponse.current = requestSequence;
          for (const [url, closeGeneration] of closedPrTombstones.current) {
            if (closeGeneration <= requestGeneration)
              closedPrTombstones.current.delete(url);
          }
          const next = prs.filter(
            (pr) => !closedPrTombstones.current.has(pr.url),
          );
          setOpenPrs((current) =>
            sameOpenPrSnapshot(current, next) ? current : next,
          );
        })
        .catch(() => {});
    };
    load();
    const onReviewSubmitted = () => void load();
    window.addEventListener(PR_REVIEW_SUBMITTED_EVENT, onReviewSubmitted);
    // The response is backed by the server's PR cache, but also carries live
    // Open Session review state. Poll it often enough that a PR moves in and out
    // of "Review running" promptly without triggering extra GitHub requests.
    const onVisibilityChange = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener(PR_REVIEW_SUBMITTED_EVENT, onReviewSubmitted);
    };
  }, []);
  useEffect(() => {
    const onClosed = (event: Event) => {
      const { repo, branch, url } = (event as CustomEvent<PrClosedDetail>)
        .detail;
      if (url) {
        prCloseGeneration.current++;
        closedPrTombstones.current.set(url, prCloseGeneration.current);
      }
      setOpenPrs(
        (current) =>
          current?.filter(
            (pr) =>
              !(url && pr.url === url) &&
              !(!url && repo === pr.repo && branch === pr.branch),
          ) ?? null,
      );
    };
    window.addEventListener(PR_CLOSED_EVENT, onClosed);
    return () => window.removeEventListener(PR_CLOSED_EVENT, onClosed);
  }, []);

  // Generic feed bands (videos, dashboards, … the feeds design): descriptors
  // once on mount. Hidden feeds remain available to Settings but do not poll.
  const [feeds, setFeeds] = useState<FeedDescriptor[]>([]);
  const [feedItems, setFeedItems] = useState<Record<string, FeedItem[]>>({});
  useEffect(() => {
    let alive = true;
    fetchFeeds()
      .then((descriptors) => {
        if (!alive) return;
        setFeeds(descriptors);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const visibleFeeds = feeds.filter((feed) => !hiddenFeeds.has(feed.id));

  // The Support queue now arrives through the generic feeds poll: the plain
  // feed's items carry the full SupportThreadSummary in meta, so all the
  // bespoke Support UI (SupportRow, filters, Tinder hand-offs) keeps working
  // off the same derived shape (the feeds design W5).
  const supportThreads = feedItems.plain
    ? supportThreadsFromFeedItems(feedItems.plain)
    : null;

  // Newest live session per feed item (keyed `<kind>:<id>`) — a feed row with
  // one wears that session's status dot.
  const feedSessionByRef = (() => {
    const m = new Map<string, UnifiedSession>();
    for (const s of sessions) {
      if (s.archived || !s.externalRefs?.length) continue;
      for (const r of s.externalRefs) {
        const key = `${r.kind}:${r.id}`;
        const prev = m.get(key);
        if (!prev || s.lastActivity > prev.lastActivity) m.set(key, s);
      }
    }
    return m;
  })();

  // Per-feed filter selections (generic — see FeedFilterMenu). Arg-mode
  // changes refetch that feed immediately; meta/builtin ones just re-derive.
  const [feedFilters, setFeedFiltersState] =
    useState<Record<string, FeedFilterValues>>(readFeedFilters);
  const argFiltersFor = (
    feed: FeedDescriptor,
    all: Record<string, FeedFilterValues>,
  ) =>
    Object.fromEntries(
      (feed.filters || [])
        .filter((f) => f.mode !== "meta")
        .map((f) => [f.key, (all[feed.id] || {})[f.key] || ""])
        .filter(([, v]) => v),
    ) as Record<string, string>;
  const setFeedFilter = (feed: FeedDescriptor, key: string, value: string) => {
    setFeedFiltersState((prev) => {
      const next = {
        ...prev,
        [feed.id]: { ...(prev[feed.id] || {}), [key]: value },
      };
      try {
        localStorage.setItem(FEED_FILTERS_KEY, JSON.stringify(next));
      } catch {}
      const spec = (feed.filters || []).find((f) => f.key === key);
      if (spec && spec.mode !== "meta")
        fetchFeedItems(feed.id, argFiltersFor(feed, next))
          .then((items) => setFeedItems((p) => ({ ...p, [feed.id]: items })))
          .catch(() => {});
      return next;
    });
  };
  // Items use the same gentle 60s cadence as Support (the server caches ~60s).
  // Re-enabling a source loads it immediately; hiding one tears its timer down.
  // Filter changes already fetch their feed in setFeedFilter; interval ticks
  // read the latest filters without restarting every feed's timer.
  const refreshEnabledFeeds = useEffectEvent(
    (enabledFeeds: FeedDescriptor[], isAlive: () => boolean) => {
      for (const feed of enabledFeeds) {
        fetchFeedItems(feed.id, argFiltersFor(feed, feedFilters))
          .then((items) => {
            if (isAlive())
              setFeedItems((prev) => ({ ...prev, [feed.id]: items }));
          })
          .catch(() => {});
      }
    },
  );
  useEffect(() => {
    const enabledFeeds = feeds.filter((feed) => !hiddenFeeds.has(feed.id));
    if (enabledFeeds.length === 0) return;
    let alive = true;
    const load = () => refreshEnabledFeeds(enabledFeeds, () => alive);
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [feeds, hiddenFeeds]);
  return {
    feedFilters,
    feedItems,
    feedSessionByRef,
    feeds,
    openPrs,
    setFeedFilter,
    setFeedItems,
    supportThreads,
    visibleFeeds,
  };
}
