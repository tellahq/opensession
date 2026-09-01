import React from "react";
import { RepoTile } from "../components/RepoTile";
import { IconChevronDown } from "../components/icons";
import { FeedFilterMenu, FeedRow } from "../components/sidebar/FeedRows";
import { cn } from "../ui/cn";
import { ContextMenu } from "../ui/menu";
import type { NavigationActions } from "./navigation";
import {
  SIDEBAR_ATTN_COUNT,
  SIDEBAR_GROUP_CHEVRON,
  SIDEBAR_GROUP_CHEVRON_COLLAPSED,
  SIDEBAR_GROUP_COUNT,
  SIDEBAR_GROUP_HEADER,
  SIDEBAR_GROUP_HEADER_INSET,
  SIDEBAR_GROUP_NAME,
  SIDEBAR_HEADER_ROW,
  SIDEBAR_LANE_COUNT,
  SIDEBAR_LANE_HEADER,
  SIDEBAR_LANE_NAME,
  SIDEBAR_RAIL,
  SIDEBAR_REPO_TILE,
  SIDEBAR_STATUS_GROUP,
  SIDEBAR_STICKY_LANE,
  SIDEBAR_STICKY_LANE_NESTED,
  SIDEBAR_STUCK_BACKING,
} from "./sidebar-classes";
import { setSidebarFeedVisible } from "./sidebar-feeds";
import type { FeedFilterValues } from "./sidebar-filter";
import { dget, SUPPORT_PRIORITY_GROUPS } from "./sidebar-filter";
import type { Props } from "./sidebar-types";
import type {
  FeedDescriptor,
  FeedItem,
  SupportThread,
  UnifiedSession,
  Workspace,
} from "./types";

interface FeedRenderersOptions {
  feedFilters: Record<string, FeedFilterValues>;
  feedItems: Record<string, FeedItem[]>;
  plainThreadsInView: SupportThread[];
  search: string;
  filterRepo: string;
  currentUser: string;
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  selectedId: string | null;
  pins: string[];
  feedSessionByRef: Map<string, UnifiedSession>;
  navigation: NavigationActions;
  isOpen: (key: string) => boolean;
  onToggleGroup: (key: string) => void;
  applyFeedFilters: (feed: FeedDescriptor, items: FeedItem[]) => FeedItem[];
  supportThreadActive: (thread: SupportThread) => boolean;
  renderSupportRow: (thread: SupportThread) => React.ReactNode;
  onTogglePin: (key: string) => void;
  onSetStatus: Props["onSetStatus"];
  onSetFeedFilter: (feed: FeedDescriptor, key: string, value: string) => void;
}

export function createSidebarFeedRenderers({
  feedFilters,
  feedItems,
  plainThreadsInView,
  search,
  filterRepo,
  currentUser,
  workspaces,
  selectedWorkspaceId,
  selectedId,
  pins,
  feedSessionByRef,
  navigation,
  isOpen,
  onToggleGroup: toggleGroup,
  applyFeedFilters,
  supportThreadActive,
  renderSupportRow,
  onTogglePin: togglePinKey,
  onSetStatus,
  onSetFeedFilter: setFeedFilter,
}: FeedRenderersOptions) {
  function renderSupportLanes(threads: SupportThread[], nested = false) {
    return SUPPORT_PRIORITY_GROUPS.map((group) => {
      const items = threads.filter((t) => (t.priority ?? 2) === group.p);
      if (items.length === 0) return null;
      const gkey = `support:prio:${group.p}`;
      const groupIsOpen = isOpen(gkey);
      return (
        <div
          className={SIDEBAR_STATUS_GROUP}
          data-status-group
          key={`support-prio-${group.p}`}
        >
          <button
            className={cn(
              SIDEBAR_GROUP_HEADER,
              SIDEBAR_GROUP_HEADER_INSET,
              SIDEBAR_LANE_HEADER,
              SIDEBAR_STICKY_LANE,
              nested && SIDEBAR_STICKY_LANE_NESTED,
              SIDEBAR_STUCK_BACKING,
            )}
            data-sticky-head
            onClick={() => toggleGroup(gkey)}
          >
            <span
              className={cn(
                SIDEBAR_GROUP_NAME,
                SIDEBAR_LANE_NAME,
                group.p <= 1 && group.cls,
              )}
            >
              {group.label}
            </span>
            <span className={cn(SIDEBAR_LANE_COUNT, group.cls)}>
              {items.length}
            </span>
            <IconChevronDown
              className={cn(
                SIDEBAR_GROUP_CHEVRON,
                "ml-auto",
                !groupIsOpen && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
              )}
              size={20}
              style={{
                transform: groupIsOpen ? "none" : "rotate(-90deg)",
              }}
            />
          </button>
          {items
            .filter((t) => groupIsOpen || supportThreadActive(t))
            .map(renderSupportRow)}
        </div>
      );
    });
  }

  // The Plain queue filter (assignee / label / has-session) — rides the
  // project band's header as a span-rendered menu trigger (the header itself
  // is a button, so a nested <button> trigger is off the table). Free text
  // rides the sidebar-wide search box.
  // Is a feed item's workspace (or its linked session) the open surface?
  function feedItemActive(feed: FeedDescriptor, item: FeedItem) {
    if (selectedWorkspaceId) {
      const ws = workspaces.find((p) => p.id === selectedWorkspaceId);
      if (
        ws?.externalRefs?.some(
          (r) => r.kind === feed.refKind && r.id === item.id,
        )
      )
        return true;
    }
    const session = feedSessionByRef.get(`${feed.refKind}:${item.id}`);
    return !!session && session.id === selectedId;
  }

  // A generic feed band (videos, dashboards, …) styled like the Plain project band:
  // brand tile + name + count, newest-first rows nested under
  // (the feeds design). Hidden while a repo filter is active, like Plain.
  function renderFeedBand(feed: FeedDescriptor, withLanes = false) {
    const isPlain = feed.id === "plain";
    const sortSel =
      (feedFilters[feed.id] || {}).__sort ||
      feed.sortOptions?.[0]?.value ||
      "recent";
    const metaSortPath = sortSel.startsWith("meta:") ? sortSel.slice(5) : null;
    const items = applyFeedFilters(feed, feedItems[feed.id] || []).sort(
      (a, b) =>
        metaSortPath
          ? (Number(dget(b.meta, metaSortPath)) || 0) -
            (Number(dget(a.meta, metaSortPath)) || 0)
          : sortSel === "title"
            ? a.title.localeCompare(b.title)
            : sortSel === "oldest"
              ? (a.ts || 0) - (b.ts || 0)
              : (b.ts || 0) - (a.ts || 0),
    );
    // Plain rows render through the bespoke SupportRow pipeline (hover
    // card, mark-done, filters) inside this generic band container; the
    // filtered thread list is the source of truth for it.
    const plainThreads = isPlain ? plainThreadsInView : null;
    const count = isPlain ? plainThreads!.length : items.length;
    // An active filter (or search) must never hide the band — zero matches
    // with no visible filter menu is a trap you can't click out of. Only a
    // genuinely empty feed (no raw items, nothing filtered away) hides.
    const vals = feedFilters[feed.id] || {};
    const hasActiveFilter =
      Object.entries(vals).some(([k, v]) => v && k !== "__sort") ||
      !!search.trim();
    const rawCount = (feedItems[feed.id] || []).length;
    if (
      (count === 0 && rawCount === 0 && !hasActiveFilter) ||
      filterRepo !== "all"
    )
      return null;
    const gkey = isPlain ? "project:plain" : `project:feed-${feed.id}`;
    const open = isOpen(gkey);
    const renderRow = (item: FeedItem) => {
      const pinKey = `feed:${feed.refKind}:${item.id}`;
      const linked = feedSessionByRef.get(`${feed.refKind}:${item.id}`) || null;
      return (
        <FeedRow
          key={`${feed.id}:${item.id}`}
          feed={feed}
          item={item}
          session={linked}
          active={feedItemActive(feed, item)}
          pinned={pins.includes(pinKey)}
          onTogglePin={() => togglePinKey(pinKey)}
          onOpen={() => navigation.openFeedItem(feed, item)}
          onSetStatus={
            linked ? (status) => onSetStatus([linked], status) : undefined
          }
        />
      );
    };
    // Collapsed band still surfaces the active item/ticket (same rule as
    // the repo bands' selected rows).
    const activeItems = open
      ? []
      : items.filter((i) => feedItemActive(feed, i));
    const activeThreads =
      open || !isPlain ? [] : plainThreads!.filter(supportThreadActive);
    // Attention badge on a collapsed band (e.g. Plain's Urgent lane).
    const attentionCount = feed.attentionLane
      ? isPlain
        ? plainThreads!.filter((t) => (t.priority ?? 2) === 0).length
        : items.filter((i) => i.lane === feed.attentionLane).length
      : 0;
    const noMatches = (
      <div className="px-3 py-2 text-label text-faint">
        No items match the filters
      </div>
    );
    const openBody = isPlain ? (
      <div className="mt-0.5">
        {count === 0
          ? noMatches
          : withLanes
            ? renderSupportLanes(plainThreads!, true)
            : [...plainThreads!]
                .sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2))
                .map(renderSupportRow)}
      </div>
    ) : (
      <div className="mt-0.5">
        {count === 0 ? noMatches : items.map(renderRow)}
      </div>
    );
    const collapsedBody = isPlain
      ? activeThreads.length > 0 && (
          <div className="mt-0.5">{activeThreads.map(renderSupportRow)}</div>
        )
      : activeItems.length > 0 && (
          <div className="mt-0.5">{activeItems.map(renderRow)}</div>
        );
    return (
      <div className="[&:not(:first-child)]:mt-4" key={gkey}>
        <ContextMenu.Root>
          <ContextMenu.Trigger
            render={
              <button
                className={cn(
                  SIDEBAR_GROUP_HEADER,
                  SIDEBAR_GROUP_HEADER_INSET,
                  SIDEBAR_HEADER_ROW,
                  "group transition-colors",
                  SIDEBAR_STICKY_LANE,
                  SIDEBAR_STUCK_BACKING,
                )}
                data-sticky-head
                onClick={() => toggleGroup(gkey)}
              />
            }
          >
            <span className={SIDEBAR_RAIL}>
              <RepoTile name={feed.id} className={SIDEBAR_REPO_TILE} />
            </span>
            <span className="flex min-w-0 flex-[0_1_auto] items-baseline gap-1.5 desktop:gap-[9px]">
              <span
                className={cn(
                  SIDEBAR_GROUP_NAME,
                  "flex-[0_1_auto] font-semibold",
                )}
              >
                {feed.title}
              </span>
              <span className={cn(SIDEBAR_GROUP_COUNT, "shrink-0")}>
                {count}
              </span>
            </span>
            {!open && attentionCount > 0 && (
              <span
                className={cn(SIDEBAR_ATTN_COUNT, "bg-red")}
                aria-label={`${attentionCount} urgent`}
              >
                {attentionCount}
              </span>
            )}
            <IconChevronDown
              className={cn(
                SIDEBAR_GROUP_CHEVRON,
                !open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
              )}
              size={22}
              style={{ transform: open ? "none" : "rotate(-90deg)" }}
            />
            <FeedFilterMenu
              feed={feed}
              values={feedFilters[feed.id] || {}}
              rawItems={feedItems[feed.id] || []}
              currentUser={currentUser}
              onSet={(k, v) => setFeedFilter(feed, k, v)}
              onHide={() => setSidebarFeedVisible(feed.id, false)}
            />
          </ContextMenu.Trigger>
          <ContextMenu.Popup>
            <ContextMenu.Item
              onClick={() => setSidebarFeedVisible(feed.id, false)}
            >
              Hide from sidebar
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Root>
        {open ? openBody : collapsedBody}
      </div>
    );
  }
  return { feedItemActive, renderFeedBand, renderSupportLanes };
}
