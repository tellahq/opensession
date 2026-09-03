import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIsPhone } from "../hooks/useIsPhone";
import { useNavigation } from "../hooks/useNavigation";
import { useSidebarDnd } from "../hooks/useSidebarDnd";
import { useSidebarPeopleActivityNow } from "../hooks/useSidebarPeopleActivityNow";
import { useSidebarSources } from "../hooks/useSidebarSources";
import { useSidebarStickyHeadings } from "../hooks/useSidebarStickyHeadings";
import { useSidebarWorkspaceController } from "../hooks/useSidebarWorkspaceController";
import { closePrPreviewApi } from "../lib/api";
import { mobileFilterBtn } from "../lib/app-header-classes";
import { useAutomationOverview } from "../lib/automation-overview";
import {
  clearHides,
  getHides,
  onHidesChanged,
  partitionHidden,
} from "../lib/hides";
import { getLane, getLanes, onLanesChanged } from "../lib/lanes";
import { mentionFor, onMentionsChanged } from "../lib/mentions";
import { usePeople } from "../lib/people";
import { getReads, isUnread, markUnread, onReadsChanged } from "../lib/reads";
import { getRecents, onRecentsChanged } from "../lib/recents";
import { setRepoOrder } from "../lib/repo-order";
import type { ReviewQueueItem } from "../lib/review-queue";
import { personKey } from "../lib/review-queue";
import { canonicalNames } from "../lib/session-owner";
import {
  SIDEBAR_DENSITY_VARS,
  SIDEBAR_GROUP,
  SIDEBAR_INDEPENDENT_SECTION,
  SIDEBAR_LIST,
  SIDEBAR_NAV_X,
} from "../lib/sidebar-classes";
import { createSidebarCollapseController } from "../lib/sidebar-collapse-controller";
import {
  getSidebarDensity,
  onSidebarDensityChanged,
} from "../lib/sidebar-density";
import {
  automationActivityKey,
  buildAutomationGroups,
  completeSidebarRepoOrder,
  deriveSidebarPrRows,
  deriveSidebarProjectBands,
  deriveWorkspacePlacement,
  discoverSidebarRepos,
  latestSupportSessionsByThread,
  orderedSidebarRepos,
  pinnedWorkspaceRows,
  personLensName as resolvePersonLensName,
  sidebarPeople,
  sortSnoozedWorkspaceRows,
  supportThreadsFromFeedItems,
  withAgentPerson,
  workspaceRowIsFeedOnly,
} from "../lib/sidebar-derived";
import { filterSidebarFeedItems } from "../lib/sidebar-feed-filter";
import { createSidebarFeedRenderers } from "./sidebar/sidebar-feed-renderers";
import {
  onSidebarFeedsChanged,
  readHiddenSidebarFeeds,
  setSidebarFeedVisible,
} from "../lib/sidebar-feeds";
import {
  getSidebarSubagentsPref,
  onSidebarSubagentsChanged,
} from "../lib/sidebar-subagents-pref";
import {
  DEFAULT_PROJECT,
  readExpanded,
  sessionRepo,
  setFilter,
  useSidebarFilter,
} from "../lib/sidebar-filter";
import { sortInboxByCreation } from "../lib/sidebar-inbox";
import { deriveSidebarInventory } from "../lib/sidebar-inventory";
import { isClaimed } from "../lib/sidebar-lanes";
import { nextRenderedSidebarItem } from "../lib/sidebar-next";
import { rowsAtPlacement } from "../lib/sidebar-placement";
import { createSupportRenderer } from "./sidebar/sidebar-support-renderer";
import {
  getSidebarToolOrder,
  onSidebarToolsChanged,
  readHiddenSidebarTools,
  replaceVisibleSidebarToolOrder,
  setSidebarToolOrder,
  setSidebarToolVisible,
} from "../lib/sidebar-tools";
import { createSidebarToolsModel } from "./sidebar/sidebar-tools-model";
import {
  MINE_STATUS_META,
  type MineStatus,
  type OpenNextSidebarItem,
  type PersonalBandPinnedEntry,
  type Props,
  type SidebarHandle,
  type WsRow,
} from "../lib/sidebar-types";
import { createWorkspaceGroupingRenderers } from "./sidebar/sidebar-workspace-renderers";
import {
  ASK_BAND,
  isAskWorkspace,
  isScratchWorkspace,
  sessionShipsDirectlyToMain,
  workspaceRowShipsDirectlyToMain,
} from "../lib/sidebar-workspaces";
import {
  clearSnooze,
  getSnoozes,
  onSnoozesChanged,
  setSnooze,
  snoozeIsActive,
} from "../lib/snoozes";
import { setSupportSurface } from "../lib/support-surface";
import type {
  FeedDescriptor,
  FeedItem,
  SupportThread,
  UnifiedSession,
} from "../lib/types";
import { getWsTimePref, onWsTimeChanged } from "../lib/workspace-time";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { useConfirm } from "../ui/confirm";
import { ContextMenu } from "../ui/menu";
import { EmptyState, ListSkeleton } from "../ui/state";
import { IconFilter, IconMessages } from "./icons";
import { PrRow } from "./PrRow";
import { AutomationsBand } from "./sidebar/AutomationsBand";
import { DraftRow } from "./sidebar/DraftRow";
import { FeedRow } from "./sidebar/FeedRows";
import { FilterPopover, RepoFilterChip } from "./sidebar/Filters";
import { PeopleBand } from "./sidebar/PeopleBand";
import { PersonalBand } from "./sidebar/PersonalBand";
import { ProjectBands } from "./sidebar/ProjectBands";
import { SetupWidget } from "./sidebar/SetupWidget";
import { SidebarChrome } from "./sidebar/SidebarChrome";
import { SidebarCustomizeDialog } from "./sidebar/SidebarCustomizeDialog";
import { SidebarItem } from "./sidebar/SidebarItem";
import { SidebarToolsMenu } from "./sidebar/SidebarToolsMenu";
import { WorkspaceContextMenu } from "./sidebar/WorkspaceContextMenu";
import { useTeamPresence } from "./TeamPresence";
import { githubLoginFor } from "./UserAvatar";
import { useCurrentUser } from "./UserPicker";

// Re-exported for App.tsx, which holds the sidebar ref.
export type { SidebarHandle } from "../lib/sidebar-types";

export const Sidebar = React.forwardRef<SidebarHandle, Props>(function Sidebar(
  {
    sessions,
    registeredRepos,
    directToMainBranches,
    sessionsError,
    sessionsLoading,
    onRetrySessions,
    workspaceDataReady,
    workspaces,
    selectedId,
    prsActive,
    feedActive,
    connected,
    tasksActive,
    taskCount = 0,
    selectedWorkspaceId = null,
    plainActive,
    supportTinderActive,
    reportsActive,
    analyticsActive,
    showDraftRow,
    draftRowActive,
    onRenameWorkspace,
    onDeleteWorkspace,
    archivedActive,
    catchUpActive,
    onNextChatAvailableChange,
    onArchive,
    onArchiveWorkspace,
    onRename,
    onSetStatus,
    teamViewing = [],
    headerActionsEl = null,
    onToast,
  },
  ref,
) {
  const navigation = useNavigation();
  const openSidebarSession = (session: UnifiedSession) => {
    navigation.openSession(session.id);
  };
  const isPhone = useIsPhone();
  const [search, setSearch] = useState("");
  const peopleActivityNow = useSidebarPeopleActivityNow(sessions);
  // Groups are collapsed by default; the expanded set persists per browser
  const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
  const [hiddenTools, setHiddenTools] = useState(readHiddenSidebarTools);
  const [toolOrder, setToolOrderState] = useState(getSidebarToolOrder);
  const [hiddenFeeds, setHiddenFeeds] = useState(readHiddenSidebarFeeds);
  const [showSubagents, setShowSubagents] = useState(getSidebarSubagentsPref);
  const {
    sidebarScrollRef,
    savedRepoOrder,
    repoOrderDraft,
    repoDrag,
    handleRepoAutoScroll,
    stopRepoAutoScroll,
    pins,
    replacePins,
    pinOrderDraft,
    pinDragMeta,
    laneDropHover,
    sessionPinState,
    workspacePinState,
    togglePinKey,
    togglePinnedKeys,
    createPinnedDrag,
  } = useSidebarDnd({ onSetStatus });
  // Per-user workspace snoozes (row key → ISO until). An overlay like pins:
  // actively-snoozed rows park in the Snoozed section; the wake sweep below
  // prunes lapsed entries and marks their rows unread.
  const [snoozes, setSnoozesState] =
    useState<Record<string, string>>(getSnoozes);
  // Per-user sidebar hides (row key → ISO hidden-at). The personal
  // counterpart to Archive, which is global: a hidden row leaves only THIS
  // user's sidebar, and the session keeps running for everyone else.
  const [hides, setHidesState] = useState<Record<string, string>>(getHides);
  const [recents, setRecents] = useState<string[]>(getRecents);
  // Per-session last-read marks, driving the unread dot. Kept in sync via the
  // same event the viewer fires when it marks a session read.
  const [reads, setReads] = useState(getReads);
  const currentUser = useCurrentUser();
  // The team with live status attached, for the Home entry's face pile.
  const team = useTeamPresence({ sessions, teamViewing, currentUser });
  useEffect(
    () =>
      onSidebarToolsChanged(() => {
        setHiddenTools(readHiddenSidebarTools());
        setToolOrderState(getSidebarToolOrder());
      }),
    [],
  );
  useEffect(
    () => onSidebarFeedsChanged(() => setHiddenFeeds(readHiddenSidebarFeeds())),
    [],
  );
  useEffect(
    () =>
      onSidebarSubagentsChanged(() =>
        setShowSubagents(getSidebarSubagentsPref()),
      ),
    [],
  );
  useSidebarStickyHeadings(sidebarScrollRef);

  // Filter popover (group by / repo / sort) — its choices persist together.
  // The person lens is shared with Home's facepile (lib/sidebar-filter), so
  // a face picked there is the sidebar you come back to.
  const filter = useSidebarFilter();
  const [filterOpen, setFilterOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [filterButton, setFilterButton] = useState<HTMLButtonElement | null>(
    null,
  );
  // The phone stand-in for the header filter button (portaled into the top
  // bar next to Search). The popover anchors to whichever button is live.
  const [mobileFilterButton, setMobileFilterButton] =
    useState<HTMLButtonElement | null>(null);
  // The active repo-filter chip prefers to sit inline in the "My sessions"
  // header (right after the title); it drops to its own row only when the
  // sidebar is too narrow to fit it there. `repoInline` is decided by measuring
  // the header against an off-layout probe copy of the chip, so toggling it can't
  // feed back into the measurement (title/actions/probe widths don't depend on
  // where the real chip lands).
  const [repoInline, setRepoInline] = useState(true);
  const headRef = useRef<HTMLDivElement>(null);
  // The heading's own width, whatever is standing in for it: the caption in
  // your own sidebar, the whole person strip in someone else's.
  const titleRef = useRef<HTMLElement | null>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  // Client-observed run starts, keyed by workspace-row key — the fallback when
  // the server hasn't stamped runStartedAt yet (external CLI runs, or the brief
  // gap between isRunning flipping via WS and the next sessions poll). Entries
  // are pruned once a row stops running so a later run starts its clock fresh.
  const [runStartSeen, setRunStartSeen] = useState<Map<string, number>>(
    () => new Map(),
  );
  useLayoutEffect(() => {
    if (filter.repo === "all") return;
    const measure = () => {
      const head = headRef.current;
      const title = titleRef.current;
      const actions = actionsRef.current;
      const probe = probeRef.current;
      if (!head || !title || !actions || !probe) return;
      const GAP = 6; // the header row's own gap-1.5, in px
      const MARGIN = 8; // breathing room so it never crowds the buttons
      const avail =
        head.clientWidth -
        title.offsetWidth -
        actions.offsetWidth -
        GAP * 2 -
        MARGIN;
      setRepoInline(probe.offsetWidth <= avail);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (headRef.current) ro.observe(headRef.current);
    return () => ro.disconnect();
    // filter.person changes the title text ("X's workspaces"), so re-measure.
  }, [filter.repo, filter.person]);

  useEffect(() => onSnoozesChanged(() => setSnoozesState(getSnoozes())), []);
  useEffect(() => onHidesChanged(() => setHidesState(getHides())), []);
  // Per-user lanes (lib/lanes.ts). mineStatus/pinnedLane read the lib cache
  // directly; this state exists to re-render (and re-derive the memos below)
  // when your lanes change.
  const [lanes, setLanesState] = useState<Record<string, string>>(getLanes);
  useEffect(() => onLanesChanged(() => setLanesState(getLanes())), []);
  useEffect(() => onRecentsChanged(() => setRecents(getRecents())), []);
  useEffect(() => onReadsChanged(() => setReads(getReads())), []);
  // Sessions where a teammate tagged you. Server-owned, so it re-renders on
  // the socket push as well as on your own clears. The counter is a render
  // trigger: the rows read mentionFor() during render, so a push that
  // changes nothing else must still rebuild them.
  const [mentionsRev, setMentionsRev] = useState(0);
  useEffect(() => onMentionsChanged(() => setMentionsRev((n) => n + 1)), []);
  // Draft pencils subscribe per workspace row, so typing into one composer does
  // not rebuild the complete sidebar inventory.
  // Opt-in "last used" time badge on workspace rows (off / always / on hover).
  const [wsTimePref, setWsTimePref] = useState(getWsTimePref);
  useEffect(() => onWsTimeChanged(() => setWsTimePref(getWsTimePref())), []);
  const [density, setDensity] = useState(getSidebarDensity);
  useEffect(
    () => onSidebarDensityChanged(() => setDensity(getSidebarDensity())),
    [],
  );

  // Right-click menu on a workspace row (mark unread / pin / status / rename /
  // copy link / delete), and inline rename (double-click the project name).
  const [workspaceMenu, setWorkspaceMenu] = useState<{
    id: string;
    x: number;
    y: number;
    source: HTMLButtonElement;
  } | null>(null);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(
    null,
  );
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  function commitWorkspaceRename() {
    if (editingWorkspaceId) {
      const name = workspaceDraft.trim();
      if (name) onRenameWorkspace(editingWorkspaceId, name);
    }
    setEditingWorkspaceId(null);
  }
  // Inline rename for workspace-less rows (slack/linear/solo sessions). These
  // used window.prompt(), which iOS standalone PWAs silently suppress —
  // Rename tapped, nothing happened. Same inline editor as workspace rows;
  // an empty commit clears the manual title back to the derived one.
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [sessionDraft, setSessionDraft] = useState("");
  function startSessionRename(session: { id: string; title: string }) {
    setSessionDraft(session.title);
    setEditingSessionId(session.id);
  }
  function commitSessionRename(session: UnifiedSession) {
    if (editingSessionId) onRename(session, sessionDraft.trim());
    setEditingSessionId(null);
  }
  /** Is this row's title currently being inline-edited (workspace or session)? */
  function rowRenameEditing(row: WsRow): boolean {
    return row.workspace
      ? editingWorkspaceId === row.workspace.id
      : !!row.sessions[0] && editingSessionId === row.sessions[0].id;
  }
  useEffect(() => {
    if (!workspaceMenu) return;
    const close = () => setWorkspaceMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [workspaceMenu]);

  // Right-click menu on the sidebar itself — a band heading, the gap between
  // rows, the empty space under the list — listing every tool and source so a
  // hidden one can come back. Rows own their own menus and stop the event
  // before it gets here. Without this, hiding the last tool takes the Tools
  // band and its ••• menu off screen with it, and Settings is the only way
  // back. It is a Base UI ContextMenu around the scrollport (SidebarToolsMenu
  // is its popup), so opening, dismissal and the Support submenu are the
  // primitive's rather than a hand-written pair of window listeners.

  // Catch-up badge: how many of *my* unread workspaces the deck would walk
  // through (distinct workspace groups, same grouping the deck uses) — so the
  // count matches the "N Left" it opens on.
  const catchUpCount = (() => {
    const user = currentUser.toLowerCase();
    const groups = new Set<string>();
    for (const s of sessions) {
      if (s.archived || s.automation) continue;
      if (!s.startedBy || s.startedBy.toLowerCase() !== user) continue;
      if (!isUnread(s.id, s.lastActivity, reads)) continue;
      groups.add(s.workspaceId ? `ws:${s.workspaceId}` : `session:${s.id}`);
    }
    return groups.size;
  })();

  const {
    feedFilters,
    feedItems,
    feedSessionByRef,
    feeds,
    openPrs,
    setFeedFilter,
    setFeedItems,
    supportThreads,
    visibleFeeds,
  } = useSidebarSources({ sessions, hiddenFeeds });

  const supportSessionByThread = latestSupportSessionsByThread(sessions);

  const discoveredRepos = discoverSidebarRepos(
    registeredRepos,
    sessions,
    openPrs ?? [],
  );
  const repos = orderedSidebarRepos(
    repoOrderDraft,
    savedRepoOrder,
    discoveredRepos,
  );
  const completeRepoOrder = completeSidebarRepoOrder(
    savedRepoOrder,
    discoveredRepos,
  );
  useEffect(() => {
    if (
      savedRepoOrder.length > 0 &&
      JSON.stringify(completeRepoOrder) !== JSON.stringify(savedRepoOrder)
    )
      setRepoOrder(completeRepoOrder);
  }, [savedRepoOrder, completeRepoOrder]);

  const roster = usePeople();
  const canonical = canonicalNames(roster);
  const people = sidebarPeople(sessions, canonical, openPrs ?? []);

  // A borrowed sidebar: someone else's lanes, everyone's, or the unassigned
  // pile. It looks exactly like your own, so the rail changes shape while you
  // are in one — the tools go, and the person strip becomes the heading.
  const borrowedLens = filter.person !== "me";

  const personLensName = resolvePersonLensName(filter.person, team, people);

  const activityKey = automationActivityKey(sessions);
  const automationOverview = useAutomationOverview(activityKey);

  const peopleWithAgent = withAgentPerson(people, automationOverview);

  const {
    activePersonGroups,
    allWsRows,
    automationRowSelected,
    filtered,
    rowOwnsSelection,
    sorted,
    subagentsByWorkspaceId,
    workspaceSubagentIds,
  } = deriveSidebarInventory({
    sessions,
    workspaces,
    openPrs: openPrs ?? [],
    filter,
    search,
    canonicalNames: canonical,
    selectedId,
    selectedWorkspaceId,
    reads,
    roster,
    currentUser,
    peopleActivityNow,
    automationOverview,
  });

  // ── Hidden rows ─────────────────────────────────────────────────────────
  // "Hide from my sidebar" is the personal counterpart to Archive: archiving
  // is global (archive.ts), so it's the wrong tool when a teammate is still
  // working in the session. A hide drops the row from THIS user's sidebar only,
  // and every band below derives from `wsRows` — so hiding removes it from
  // pins, lanes, review and snoozed in one go.
  //
  // The one exception: a hidden row resurfaces while any of its sessions is
  // blocked on a question, so a hide can never swallow work waiting on you.
  // Resurfacing consumes the entry (see the sweep below), which keeps the
  // rule "it came back because it needed me, and stays back until I hide it
  // again" instead of flickering as questions get asked and answered.
  //
  // Otherwise the viewer offers "Keep in sidebar" when you open a hidden
  // session through a link or ⌘K. There is no Hidden band: hiding is removal
  // from your sidebar, not a folder to browse.
  const { hiddenKeys: hiddenRowKeys, resurfaced: resurfacedRows } =
    partitionHidden(allWsRows, hides);
  // Opening a deep link must not undo a personal hide. The viewer owns the
  // recovery action while the row stays absent.
  const wsRows = allWsRows.filter((r) => !hiddenRowKeys.has(r.key));
  useEffect(() => {
    setRunStartSeen((current) => {
      const next = new Map(current);
      let changed = false;
      for (const row of wsRows) {
        const hasServerStart = row.sessions.some(
          (session) => session.isRunning && session.runStartedAt,
        );
        if (row.running && !hasServerStart && !next.has(row.key)) {
          next.set(row.key, Date.now());
          changed = true;
        } else if ((!row.running || hasServerStart) && next.delete(row.key)) {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [wsRows]);
  // Consume the hide of any row that just resurfaced (blocked on a question),
  // marking its sessions unread so the return reads as fresh activity — the same
  // shape as the snooze wake above. Idempotent: clearHides ignores keys that
  // another tab already dropped.
  useEffect(() => {
    if (!resurfacedRows.length) return;
    for (const r of resurfacedRows) r.sessions.forEach((c) => markUnread(c.id));
    clearHides(resurfacedRows.map((r) => r.key));
  }, [resurfacedRows]);

  const groups = buildAutomationGroups({
    sessions: sorted,
    nestedSubagentIds: workspaceSubagentIds,
    automationOverview,
    filter,
    currentUser,
    isClaimed,
  });

  // The DOM is the source of truth for visual order. Section mode, project
  // grouping, collapse state, pins, PRs and feeds can all put rendered rows in
  // an order that no single data array represents.
  function openNextSidebarItem(
    currentKey: string,
    current: HTMLButtonElement | null = null,
  ): OpenNextSidebarItem {
    return () => {
      const root = sidebarScrollRef.current;
      if (!root) return false;
      const items = Array.from(
        root.querySelectorAll<HTMLButtonElement>("button[data-sidebar-row]"),
      );
      const next = nextRenderedSidebarItem(
        items,
        current?.isConnected ? current : null,
        currentKey,
      );
      if (!next) return false;
      next.click();
      return true;
    };
  }

  function archiveWithNext(
    session: UnifiedSession,
    current: HTMLButtonElement | null = null,
  ) {
    onArchive(session, openNextSidebarItem(`session:${session.id}`, current));
  }
  // Pinned rows (pinned via their own key or a legacy pin on a member session)
  // and the focus person's rows — shared by the list rendering below and by
  // archive-next, so both always agree on what's actually in the sidebar.
  // Rows a teammate flagged for YOUR review (the info panel's Reviewer picker).
  // Explicit teammate filters stay owner-scoped, while the default "Me" view
  // also includes cross-owner work that was sent to or requested by you.
  // ── Snoozed rows ────────────────────────────────────────────────────────
  // A row with an active snooze leaves every band (review, pinned, status
  // lanes) and parks in the Snoozed section, soonest wake first. The sweep
  // below prunes lapsed entries — marking the row's sessions unread first, so
  // the wake surfaces like fresh activity — which re-derives membership.
  const activeSnoozeKeys = (() => {
    const now = Date.now();
    return new Set(
      Object.entries(snoozes)
        .filter(([, until]) => snoozeIsActive(until, now))
        .map(([key]) => key),
    );
  })();
  useEffect(() => {
    if (Object.keys(snoozes).length === 0) return;
    const sweep = () => {
      const now = Date.now();
      for (const [key, until] of Object.entries(snoozes)) {
        if (snoozeIsActive(until, now)) continue;
        const row = wsRows.find((r) => r.key === key);
        row?.sessions.forEach((c) => markUnread(c.id));
        clearSnooze(key);
      }
    };
    sweep();
    const t = setInterval(sweep, 30_000);
    return () => clearInterval(t);
  }, [snoozes, wsRows]);

  // Your person key ("Kent de Bruin" → "kent") is what GitHub's reviewer
  // lists use, unlike the display name used by the Reviewer picker.
  const mePersonKey = personKey(currentUser);
  const feedRefKinds = new Set(feeds.map((feed) => feed.refKind));
  const rowIsFeedOnly = (row: WsRow) =>
    workspaceRowIsFeedOnly(row, feedRefKinds);
  const { placedWsRows, autoCreatedRows } = deriveWorkspacePlacement({
    rows: wsRows,
    filter,
    currentUser,
    activeSnoozeKeys,
    feedRefKinds,
    ownsSelection: rowOwnsSelection,
    isClaimed,
    hasPersonalLane: (sessionId) => !!getLane(sessionId),
  });
  const needsReviewRows = rowsAtPlacement(placedWsRows, "needs-review");
  const approvedReviewRows = rowsAtPlacement(placedWsRows, "approved-review");
  const awaitingReviewRows = rowsAtPlacement(placedWsRows, "awaiting-review");
  const focusWsRows = rowsAtPlacement(placedWsRows, "status");
  const snoozedWsRows = sortSnoozedWorkspaceRows(
    rowsAtPlacement(placedWsRows, "snoozed"),
    snoozes,
  );
  const pinnedWsRows = pinnedWorkspaceRows(wsRows, pins, activeSnoozeKeys);

  // ── Inbox rows ──────────────────────────────────────────────────────────
  // Snoozed rows already left `focusWsRows` through placement. The remaining
  // inbox stays stable by creation time. Pinned is an orthogonal quick-access
  // facet, so a pinned row still keeps its primary Active/status placement.
  const activeFocusWsRows = sortInboxByCreation(focusWsRows);
  // ── PR rows in the project lanes ────────────────────────────────────────
  // The retired standalone Pull-requests band dissolved into the project
  // groups: every open PR classifies into a lane (ready → Ready to merge,
  // attention → In progress, drafts → Backlog, the rest → In progress).
  const githubLogin = githubLoginFor(currentUser);
  const workspaceRowsInView = [
    ...activeFocusWsRows,
    ...pinnedWsRows,
    ...snoozedWsRows,
    ...needsReviewRows,
    ...awaitingReviewRows,
    ...approvedReviewRows,
  ];
  const { reviewQueueItems, workspaceCoveredPrUrls, prRowItems } =
    deriveSidebarPrRows({
      openPrs: openPrs ?? [],
      sessions,
      currentUser,
      githubLogin,
      workspaceRows: workspaceRowsInView,
      workspaceDataReady,
      filter,
      search,
    });

  // Which lane a PR row files under: ready → Ready to merge, everything else
  // → Backlog. In progress is reserved for live runs — a PR that needs a
  // hand signals through its red/yellow glyph and hover card instead.
  function prItemLane(item: ReviewQueueItem): MineStatus {
    return item.bucket === "ready" ? "review" : "pending";
  }

  const [confirm, confirmDialog] = useConfirm();

  // Every draft entry point uses the same styled confirmation instead of the
  // browser's native alert.
  function confirmDeleteDraft(onConfirm: () => void) {
    confirm({
      title: "Delete this draft?",
      description: "This removes the unsent message.",
      confirmLabel: "Delete",
      destructive: true,
      onConfirm,
    });
  }

  // Closing a PR from a row's context menu — optimistic spinner per URL; the
  // PR_CLOSED_EVENT listener above prunes the open-PR list on success.
  const [closingPrUrls, setClosingPrUrls] = useState<Set<string>>(
    () => new Set(),
  );
  function closePrRow(item: ReviewQueueItem) {
    confirm({
      title: `Close PR #${item.pr.number}?`,
      description: "This closes the pull request without merging it.",
      confirmLabel: "Close PR",
      destructive: true,
      onConfirm: () => {
        setClosingPrUrls((current) => new Set(current).add(item.pr.url));
        void closePrPreviewApi(item.pr.repo, item.pr.branch)
          .catch((error) => {
            onToast?.(
              error instanceof Error
                ? error.message
                : `Failed to close PR #${item.pr.number}.`,
            );
          })
          .finally(() => {
            setClosingPrUrls((current) => {
              const next = new Set(current);
              next.delete(item.pr.url);
              return next;
            });
          });
      },
    });
  }

  // A PR row is selected while the open workspace carries its PR.
  function prRowSelected(item: ReviewQueueItem): boolean {
    const ws = selectedWorkspaceId
      ? workspaces.find((p) => p.id === selectedWorkspaceId)
      : null;
    return (
      !!ws &&
      (ws.repo || DEFAULT_PROJECT) === item.pr.repo &&
      (ws.prNumber === item.pr.number || ws.branch === item.pr.branch)
    );
  }

  function renderPrRow(item: ReviewQueueItem) {
    const pinKey = `pr:${item.pr.url}`;
    return (
      <PrRow
        key={item.pr.url}
        item={item}
        selected={prRowSelected(item)}
        pinned={pins.includes(pinKey)}
        onTogglePin={() => togglePinKey(pinKey)}
        onOpen={() => navigation.openPrItem(item)}
        onClose={() => void closePrRow(item)}
        closing={closingPrUrls.has(item.pr.url)}
      />
    );
  }

  function renderAutomationSession(session: UnifiedSession) {
    const pin = sessionPinState(session);
    return (
      <SidebarItem
        key={session.id}
        session={session}
        selected={automationRowSelected(session)}
        unread={
          session.id !== selectedId &&
          isUnread(session.id, session.lastActivity, reads)
        }
        mention={
          session.id !== selectedId ? mentionFor(session.id)?.by : undefined
        }
        mine={
          !!session.startedBy &&
          !session.automation &&
          session.startedBy.toLowerCase() === currentUser.toLowerCase()
        }
        onClick={() => openSidebarSession(session)}
        onArchive={(current) => archiveWithNext(session, current)}
        pinned={pin.pinned}
        onTogglePin={pin.toggle}
        shipsDirectlyToMain={shipsDirectlyToMain(session.repo, session.branch)}
        onRename={(title) => onRename(session, title)}
        onSetStatus={(status) => onSetStatus([session], status)}
      />
    );
  }

  function renderPersonSession(session: UnifiedSession) {
    const pin = sessionPinState(session);
    return (
      <SidebarItem
        key={session.id}
        session={session}
        selected={session.id === selectedId}
        unread={
          session.id !== selectedId &&
          isUnread(session.id, session.lastActivity, reads)
        }
        mention={
          session.id !== selectedId ? mentionFor(session.id)?.by : undefined
        }
        mine={false}
        showOwner={false}
        alwaysShowAddToSidebar
        onClick={() => openSidebarSession(session)}
        onArchive={(current) => archiveWithNext(session, current)}
        pinned={pin.pinned}
        onTogglePin={pin.toggle}
        shipsDirectlyToMain={shipsDirectlyToMain(session.repo, session.branch)}
        onRename={(title) => onRename(session, title)}
        onSetStatus={(status) => onSetStatus([session], status)}
      />
    );
  }

  // GitHub review requests pointed at YOU are a notification, not a lane
  // item: they render in the "Needs review" band at the top, alongside the
  // internal review requests (both are the same ask of you), and stay out of
  // the project lanes below.
  const requestedPrItems = prRowItems.filter(
    (item) => item.source === "requested",
  );
  const lanePrItems = prRowItems.filter((item) => item.source !== "requested");

  // Workspace rows in their primary placement order. This supports operations
  // that need row membership; archive navigation reads the rendered DOM below.
  const wsRowOrder = (() => {
    // Review placements can still overlap Pinned; dedupe by key so the
    // archive-next walk sees each workspace once.
    const seen = new Set<string>();
    return [
      ...needsReviewRows,
      ...approvedReviewRows,
      ...awaitingReviewRows,
      ...pinnedWsRows,
      ...MINE_STATUS_META.flatMap((meta) =>
        activeFocusWsRows.filter((r) => r.status === meta.key),
      ),
      ...snoozedWsRows,
    ].filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
  })();
  // Project bands are independent from the section mode. Inbox, Activity,
  // and Status can each render globally or inside every project.
  const groupsByRepo = filter.byProject;
  const hasWorkspaceFilter =
    !!search ||
    filter.repo !== "all" ||
    filter.person !== "me" ||
    // Hiding auto-created work can empty the list on an instance where most
    // of the work is the agent's, and "no matching workspaces" is the honest
    // thing to say then. "Nothing here yet" would not be.
    filter.autoCreated === "hide";
  const workspaceListEmpty =
    needsReviewRows.length === 0 &&
    awaitingReviewRows.length === 0 &&
    approvedReviewRows.length === 0 &&
    pinnedWsRows.length === 0 &&
    activeFocusWsRows.length === 0 &&
    snoozedWsRows.length === 0 &&
    prRowItems.length === 0;
  const productEmpty = sessions.length === 0 && workspaces.length === 0;
  // The unstarted session's row. App decides WHEN there is nothing at all
  // (its flag waits for the first list request to settle, which the local
  // `productEmpty` above cannot know); this decides where it can be shown.
  const draftRow = !!showDraftRow && !isPhone && !sessionsError;

  // The repo band a workspace row files under. The workspace's own repo wins:
  // it's what the work is *about*, while a session's repo is only the checkout it
  // happens to run from: a PR workspace for one repo whose session runs in
  // another repo's worktree files under the repo it is about. A workspace spanning
  // repos still files under one band (a row in two bands double-counts and
  // reads as two pieces of work); the repo *filter* honours every repo it
  // touches, so it stays findable from the others.
  function wsRowRepo(row: WsRow): string {
    const firstSession = row.sessions[0];
    return (
      row.workspace?.repo ||
      row.workspace?.externalRefs?.[0]?.kind ||
      firstSession?.repo ||
      (firstSession ? sessionRepo(firstSession) : DEFAULT_PROJECT)
    );
  }
  function shipsDirectlyToMain(
    repo: string | undefined,
    branch: string | null | undefined,
  ) {
    return sessionShipsDirectlyToMain({ repo, branch }, directToMainBranches);
  }
  function rowShipsDirectlyToMain(row: WsRow) {
    return workspaceRowShipsDirectlyToMain(
      row,
      wsRowRepo(row),
      directToMainBranches,
    );
  }
  const rowIsScratch = (row: WsRow) => isScratchWorkspace(row.sessions);
  // Repo-less Ask workspaces get their own band above the projects. Checked
  // BEFORE wsRowRepo's fallbacks, which would otherwise file them under the
  // default project (lib/session-repo).
  const rowIsAsk = (row: WsRow) => isAskWorkspace(row.sessions);

  const {
    automationsOpen,
    isOpen,
    peopleOpen,
    toggleBand,
    toggleGroup,
    workspacesOpen,
  } = createSidebarCollapseController({
    search,
    expanded,
    setExpanded,
    borrowedLens,
  });

  // Assignee/label/session filter over the Plain queue; free text rides the
  // sidebar-wide search box (title/customer/preview).
  // Generic feed filtering: sidebar search (title/preview + descriptor
  // searchMeta paths), meta-mode filter specs over item.meta, and the
  // builtin linked-session filter. Arg-mode specs were already applied
  // server-side by the fetch. Replaces filteredSupportThreads.
  function sessionForItem(feed: FeedDescriptor, item: FeedItem) {
    return feed.id === "plain"
      ? supportSessionByThread.get(item.id)
      : feedSessionByRef.get(`${feed.refKind}:${item.id}`);
  }
  function applyFeedFilters(feed: FeedDescriptor, items: FeedItem[]) {
    return filterSidebarFeedItems({
      feed,
      items,
      search,
      values: feedFilters[feed.id] || {},
      sessionForItem,
    });
  }

  const { archivedLink, sidebarMenuSources, sidebarMenuTools, visibleTools } =
    createSidebarToolsModel({
      navigation,
      feedActive,
      prsActive,
      tasksActive,
      taskCount,
      plainActive,
      catchUpActive,
      catchUpCount,
      supportTinderActive,
      reportsActive,
      analyticsActive,
      isPhone,
      toolOrder,
      hiddenTools,
      hiddenFeeds,
      borrowedLens,
      productEmpty,
      feeds,
      archivedActive,
    });
  const setToolVisible = setSidebarToolVisible;

  const {
    archiveWorkspaceWithNext,
    hideRow,
    isDraftWsRow,
    newSessionKeys,
    renderPinnedWsRow,
    renderReviewWsRow,
    renderWsRow,
    renderWsRowImpl,
    rowIsSnoozed,
    toggleWorkspaceSnooze,
    workspaceOverlays,
  } = useSidebarWorkspaceController({
    identity: { currentUser, mePersonKey, teamViewing },
    data: {
      sessions,
      workspaces,
      wsRows,
      wsRowOrder,
      reads,
      activeSnoozeKeys,
      snoozes,
      subagentsByWorkspaceId,
    },
    state: {
      selectedId,
      selectedWorkspaceId,
      isPhone,
      showSubagents,
      groupsByRepo,
      runStartSeen,
      wsTimePref,
      workspaceDraft,
      sessionDraft,
      pins,
    },
    refs: { sidebarScrollRef, ref },
    navigation: { navigation, openSidebarSession, openNextSidebarItem },
    editing: {
      rowRenameEditing,
      setWorkspaceDraft,
      setSessionDraft,
      setEditingWorkspaceId,
      setEditingSessionId,
      setWorkspaceMenu,
      commitWorkspaceRename,
      commitSessionRename,
      startSessionRename,
    },
    rows: {
      rowOwnsSelection,
      wsRowRepo,
      rowIsScratch,
      rowShipsDirectlyToMain,
      workspacePinState,
      togglePinnedKeys,
      togglePinKey,
    },
    actions: {
      confirmDeleteDraft,
      onDeleteWorkspace,
      onArchiveWorkspace,
      onArchive,
      onSetStatus,
      onNextChatAvailableChange,
      onToast,
      confirm,
    },
  });

  const { renderSupportRow, supportThreadActive } = createSupportRenderer({
    currentUser,
    selectedWorkspaceId,
    selectedId,
    workspaces,
    supportSessionByThread,
    pins,
    navigation,
    setFeedItems,
    onTogglePin: togglePinKey,
    onSetStatus,
  });

  // Project bands only hold rows that deriveSidebarProjectBands classifies as
  // project work. Feed-only and scratch rows stay outside those buckets, and
  // the loose scratch list comes from status lanes, which no review row
  // reaches. So under project grouping those rows keep the top-level review
  // band. A review being asked of you must not be what vanishes.
  const rowNestsInRepoBand = (row: WsRow) =>
    !rowIsFeedOnly(row) && !rowIsScratch(row);
  const topBandRows = (rows: WsRow[]) =>
    groupsByRepo ? rows.filter((row) => !rowNestsInRepoBand(row)) : rows;

  // The Snoozed group — the quiet zone, shared by the status lanes (slotted
  // just above Backlog) and the inbox bands (appended last, after Earlier).
  // `ns` keeps each repo's copy collapsible on its own.
  const { renderLabeledBand, renderLabeledLane, renderWorkspaceGrouping } =
    createWorkspaceGroupingRenderers({
      groupBy: filter.groupBy,
      pinDragMeta,
      laneDropHover,
      isOpen,
      onToggleGroup: toggleGroup,
      ownsSelection: rowOwnsSelection,
      prRowSelected,
      prItemLane,
      isDraft: isDraftWsRow,
      renderWorkspaceRow: renderWsRow,
      renderWorkspaceRowImpl: (row, inbox) => renderWsRowImpl(row, inbox),
      renderPrRow,
    });

  // ProjectBands owns presentation. Build its pure row-membership model only
  // for project grouping because deriving it buckets every visible row.
  const projectBands = groupsByRepo
    ? deriveSidebarProjectBands({
        activeRows: activeFocusWsRows,
        snoozedRows: snoozedWsRows,
        needsReviewRows,
        approvedRows: approvedReviewRows,
        awaitingReviewRows,
        lanePrItems,
        requestedPrItems,
        registeredRepos,
        repos,
        savedRepoOrder,
        filter,
        search,
        isPhone,
        askBand: ASK_BAND,
        rowIsFeedOnly,
        rowIsScratch,
        rowIsAsk,
        workspaceRepo: wsRowRepo,
      })
    : null;

  // ── Plain (support) as a project ────────────────────────────────────────
  // The Plain TODO queue rendered as a sibling of the repo bands: a project
  // whose lanes are priorities (Urgent/High/Normal/Low) instead of statuses.
  // Hidden while a repo filter narrows the list — tickets belong to no repo.
  const plainFeedDesc = visibleFeeds.find((f) => f.id === "plain");
  const plainThreadsInView =
    filter.repo === "all" && plainFeedDesc
      ? supportThreadsFromFeedItems(
          applyFeedFilters(plainFeedDesc, feedItems.plain || []),
        )
      : [];

  // The priority lanes, shared by the Plain project band (nested under it)
  // and the flat "Group by: Status" view (appended after the status lanes).
  // `nested` = rendered inside the Plain project band rather than appended to
  // the flat status list; a nested lane pins one row lower, under that band's
  // own header.
  const { feedItemActive, renderFeedBand, renderSupportLanes } =
    createSidebarFeedRenderers({
      feedFilters,
      feedItems,
      plainThreadsInView,
      search,
      filterRepo: filter.repo,
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
    });

  // Resolve every visible pin into one entry before PersonalBand adds the
  // disclosure and drag wrapper. Pinning and drag state stay owned here.
  const personalPinnedBand = (() => {
    const pinnedRows = pinnedWsRows;
    // Pinned sessions that don't map to a workspace row (automation runs).
    const rowSessionIds = new Set(
      wsRows.flatMap((r) => r.sessions.map((c) => c.id)),
    );
    const pinnedLoose = pins
      .filter((e) => !e.startsWith("workspace:"))
      .filter((id) => !rowSessionIds.has(id))
      .map((id) =>
        sessions.find((s) => s.id === id || s.aliasIds?.includes(id)),
      )
      // An archived session must never surface in Pinned — its pin is
      // stale (archiving drops it server-side, but a resurrected or
      // legacy pin can still point at it). Skip it so it can't render
      // as an un-archivable ghost row.
      .filter((s): s is UnifiedSession => !!s && !s.archived)
      .filter((s) => !workspaceSubagentIds.has(s.id))
      // Honor the repo filter — a pinned session from another repo
      // shouldn't leak into a repo-scoped view (workspace pins
      // already drop out via wsRows/filtered).
      .filter((s) => filter.repo === "all" || sessionRepo(s) === filter.repo);
    // Pinned Plain tickets and PRs — resolved against the live
    // queues, so a done ticket / closed PR just stops rendering
    // (its stale pin key is harmless, like an archived session's).
    const pinnedTickets = pins
      .filter((e) => e.startsWith("support:"))
      .map((e) => (supportThreads || []).find((t) => t.id === e.slice(8)))
      .filter((t): t is SupportThread => !!t);
    // Pinned feed items (videos, dashboards):
    // resolved against the live feed items like tickets are.
    const pinnedFeedItems = pins
      .filter((e) => e.startsWith("feed:"))
      .map((e) => {
        const [, refKind, ...idParts] = e.split(":");
        const id = idParts.join(":");
        const feed = feeds.find((f) => f.refKind === refKind);
        const item = feed
          ? (feedItems[feed.id] || []).find((i) => i.id === id)
          : undefined;
        return feed && item ? { feed, item } : null;
      })
      .filter((x): x is { feed: FeedDescriptor; item: FeedItem } => !!x);
    const pinnedPrs = pins
      .filter((e) => e.startsWith("pr:"))
      .map((e) => reviewQueueItems.find((i) => i.pr.url === e.slice(3)))
      .filter((i): i is ReviewQueueItem => !!i)
      // Once a workspace carries this PR, the workspace row is the
      // single place for it, even if an older standalone PR pin remains.
      .filter((item) => !workspaceCoveredPrUrls.has(item.pr.url));
    if (
      !pinnedRows.length &&
      !pinnedLoose.length &&
      !pinnedTickets.length &&
      !pinnedFeedItems.length &&
      !pinnedPrs.length
    )
      return null;
    const pinnedOpen = isOpen("pinned");

    // One flat drag-to-reorder list: every pinned thing (workspace row,
    // loose session, ticket) becomes an entry slotted by its first key's
    // position in the pins array, so reordering is just rewriting that
    // array (reorderPins). `pinKeys` is everything in `pins` that maps
    // to the entry — a workspace can be pinned via its own key AND
    // legacy member-session pins — so a drop moves them as one unit.
    type PinEntry = PersonalBandPinnedEntry;
    const pinIdx = new Map(pins.map((p, i) => [p, i] as const));
    const entries: PinEntry[] = [];
    for (const row of pinnedRows) {
      entries.push({
        key: `ws:${row.key}`,
        pinKeys: [row.key, ...row.sessions.map((c) => c.id)].filter((k) =>
          pinIdx.has(k),
        ),
        repo: wsRowRepo(row),
        sessions: row.sessions,
        node: renderPinnedWsRow(row),
      });
    }
    const seenLoose = new Set<string>();
    for (const s of pinnedLoose) {
      // A session pinned via both its id and an alias maps to the same
      // session twice — render (and reorder) it once.
      if (seenLoose.has(s.id)) continue;
      seenLoose.add(s.id);
      const pin = sessionPinState(s);
      entries.push({
        key: `session:${s.id}`,
        pinKeys: [s.id, ...(s.aliasIds ?? [])].filter((k) => pinIdx.has(k)),
        repo: sessionRepo(s),
        sessions: [s],
        node: (
          <SidebarItem
            session={s}
            selected={automationRowSelected(s)}
            unread={
              s.id !== selectedId && isUnread(s.id, s.lastActivity, reads)
            }
            mention={s.id !== selectedId ? mentionFor(s.id)?.by : undefined}
            mine={
              !!s.startedBy &&
              !s.automation &&
              s.startedBy.toLowerCase() === currentUser.toLowerCase()
            }
            onClick={() => openSidebarSession(s)}
            onArchive={(current) => archiveWithNext(s, current)}
            pinned={pin.pinned}
            onTogglePin={pin.toggle}
            shipsDirectlyToMain={shipsDirectlyToMain(s.repo, s.branch)}
            onRename={(title) => onRename(s, title)}
            onSetStatus={(st) => onSetStatus([s], st)}
          />
        ),
      });
    }
    for (const t of pinnedTickets) {
      entries.push({
        key: `support:${t.id}`,
        pinKeys: [`support:${t.id}`],
        repo: null,
        sessions: [],
        node: renderSupportRow(t),
      });
    }
    for (const { feed, item } of pinnedFeedItems) {
      const pinKey = `feed:${feed.refKind}:${item.id}`;
      const linked = feedSessionByRef.get(`${feed.refKind}:${item.id}`) || null;
      entries.push({
        key: pinKey,
        pinKeys: [pinKey],
        repo: null,
        sessions: [],
        node: (
          <FeedRow
            key={pinKey}
            feed={feed}
            item={item}
            session={linked}
            active={feedItemActive(feed, item)}
            pinned
            onTogglePin={() => togglePinKey(pinKey)}
            onOpen={() => navigation.openFeedItem(feed, item)}
            onSetStatus={
              linked ? (status) => onSetStatus([linked], status) : undefined
            }
          />
        ),
      });
    }
    for (const item of pinnedPrs) {
      entries.push({
        key: `pr:${item.pr.url}`,
        pinKeys: [`pr:${item.pr.url}`],
        repo: null,
        sessions: [],
        node: renderPrRow(item),
      });
    }
    const firstIdx = (e: PinEntry) =>
      e.pinKeys.length
        ? Math.min(...e.pinKeys.map((k) => pinIdx.get(k)!))
        : Infinity;
    entries.sort((a, b) => firstIdx(a) - firstIdx(b));
    // Mid-drag, Motion's in-flight order wins until the drop commits it.
    if (pinOrderDraft) {
      const draftIdx = new Map(pinOrderDraft.map((k, i) => [k, i] as const));
      entries.sort(
        (a, b) =>
          (draftIdx.get(a.key) ?? Infinity) - (draftIdx.get(b.key) ?? Infinity),
      );
    }
    const drag = createPinnedDrag(entries, isPhone);
    return {
      entries,
      open: pinnedOpen,
      onToggle: () => toggleGroup("pinned"),
      ...drag,
    };
  })();

  // The sidebar's fixed head: the organization row, the tool rows, and the
  // Workspaces band heading with its filter and new-session buttons.
  //
  // On desktop this whole block is chrome — it holds its place under the window
  // chrome while only the workspace list below it scrolls, so the top of the
  // rail never slides away and there is no edge for a hairline to mark. The
  // strip that used to name whose sidebar this is went with the same move: the
  // Workspaces band heading says it once.
  //
  // The band used to earn its place by pinning (SIDEBAR_STICKY_BAND, still on
  // it for the phone layout). Out here it does not have to: it is simply above
  // the scrollport, which is what pinning was imitating. That also means the
  // tier-2 lane headers inside the list pin at the scroll's own top rather than
  // one band-slot down — see the `--sidebar-band-slot` override on SIDEBAR_LIST.
  //
  // Phones keep the whole sidebar as one page, so there the same markup is the
  // scroll's first child and scrolls away with the list.
  const sidebarChrome = (
    <SidebarChrome
      state={{
        density,
        connected,
        isPhone,
        borrowedLens,
        workspacesOpen,
        repoInline,
        filterOpen,
        newSessionKeys,
      }}
      tools={{
        tools: visibleTools,
        menuTools: sidebarMenuTools,
        team,
        onSetToolVisible: setToolVisible,
      }}
      identity={{ filter, currentUser, personLensName, repos }}
      refs={{
        headRef,
        titleRef,
        actionsRef,
        probeRef,
        setFilterButton,
      }}
      actions={{
        navigation,
        setFilterOpen,
        onToggleWorkspaces: () => toggleBand("workspaces"),
      }}
    />
  );

  const workspaceMenuWorkspace = workspaceMenu
    ? workspaces.find((workspace) => workspace.id === workspaceMenu.id)
    : undefined;
  const workspaceMenuRow = workspaceMenu
    ? wsRows.find((row) =>
        workspaceMenuWorkspace
          ? row.workspace?.id === workspaceMenuWorkspace.id
          : row.key === workspaceMenu.id,
      )
    : undefined;

  return (
    <>
      {/* Desktop: fixed chrome above the scrollport. It is a sibling of the
		    scroll rather than its first child, so the organization row, the tools
		    and the Workspaces heading hold their place while the list runs under
		    them. */}
      {!isPhone && sidebarChrome}
      {/* The scrollport is the right-click target for the sidebar's own menu.
		    Only the background reaches it, since every row stops the event on its
		    way up to open its own menu. Phones are left alone because row sheets
		    own the long-press gesture there. */}
      <ContextMenu.Root disabled={isPhone}>
        <ContextMenu.Trigger
          render={
            <div
              // One element sets the rail's whole vertical scale and carries the
              // attribute the compact values key off, so density is a property the
              // rows inherit rather than a flag every family has to be handed.
              data-density={density}
              className={cn(
                "flex w-full min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                SIDEBAR_DENSITY_VARS,
                SIDEBAR_NAV_X,
                // Keyboard navigation calls scrollIntoView on the next row. Teach
                // that native scroll where the pinned lane caption ends, otherwise
                // it aligns the row with the scrollport and parks it underneath
                // Active, making a two-row lane look as though it contains one.
                "desktop:scroll-pt-[var(--sidebar-cap-h)]",
                // The whole sidebar scrolls as one on phones, so the tools (and the
                // Workspaces header) scroll away with the list instead of staying
                // pinned above a separately-scrolling list. The top bar floats over
                // it (.app-header-overlay), so pad the scroll's top by the bar height.
                // The tools clear the pills at rest and the list scrolls under them.
                // Fade the list into the bar with a mask, and keep the last section
                // clear of the home indicator.
                isPhone &&
                  "pt-[var(--header-h)] pb-[max(24px,env(safe-area-inset-bottom,0px))] [-webkit-mask-image:linear-gradient(to_bottom,transparent_0,#000_var(--header-h))] [mask-image:linear-gradient(to_bottom,transparent_0,#000_var(--header-h))]",
              )}
              ref={sidebarScrollRef}
              onDragOver={handleRepoAutoScroll}
              onDragLeave={(event) => {
                if (
                  !(event.relatedTarget instanceof Node) ||
                  !event.currentTarget.contains(event.relatedTarget)
                )
                  stopRepoAutoScroll();
              }}
            />
          }
        >
          {isPhone && sidebarChrome}

          <div className="block max-w-full min-w-0 flex-none">
            {/* Fallback row: only when the chip doesn't fit inline. */}
            {filter.repo !== "all" && !repoInline && (
              <div className="mx-4 mt-[-2px] mb-2 flex min-w-0 md:mr-2 md:ml-4">
                <RepoFilterChip
                  repo={filter.repo}
                  repos={repos}
                  onClear={() => setFilter({ repo: "all" })}
                  onSelect={(v) => setFilter({ repo: v })}
                  variant="row"
                />
              </div>
            )}

            {/* On phones the filter button lives in the top bar (next to Search);
			    its popover anchors there. Desktop keeps it in the header. */}
            {isPhone &&
              !borrowedLens &&
              headerActionsEl &&
              createPortal(
                <>
                  <button
                    ref={setMobileFilterButton}
                    className={mobileFilterBtn(filterOpen)}
                    onClick={() => setFilterOpen((o) => !o)}
                    aria-label="Group, filter & sort"
                  >
                    <IconFilter size={22} />
                  </button>
                </>,
                headerActionsEl,
              )}

            {filterOpen && (
              <FilterPopover
                anchor={isPhone ? mobileFilterButton : filterButton}
                filter={filter}
                repos={repos}
                people={peopleWithAgent}
                currentUser={currentUser}
                onChange={setFilter}
                onClose={() => setFilterOpen(false)}
                onCustomize={() => {
                  setFilterOpen(false);
                  setCustomizeOpen(true);
                }}
              />
            )}

            {workspaceMenu && (
              <WorkspaceContextMenu
                menu={workspaceMenu}
                workspace={workspaceMenuWorkspace}
                row={workspaceMenuRow}
                pins={pins}
                currentUser={currentUser}
                activeSnoozeKeys={activeSnoozeKeys}
                snoozes={snoozes}
                hiddenRowKeys={hiddenRowKeys}
                onPinsChange={replacePins}
                onSetStatus={onSetStatus}
                onSnooze={(row, until) =>
                  until ? setSnooze(row.key, until) : clearSnooze(row.key)
                }
                onStartWorkspaceRename={(workspace) => {
                  setWorkspaceDraft(workspace.name);
                  setEditingWorkspaceId(workspace.id);
                }}
                onStartSessionRename={startSessionRename}
                onToast={onToast}
                onOpenReview={navigation.openSessionReview}
                onHide={(row, hidden) =>
                  hidden ? clearHides([row.key]) : hideRow(row)
                }
                onArchive={archiveWorkspaceWithNext}
                onDeleteDraft={(workspace) =>
                  confirmDeleteDraft(() => onDeleteWorkspace(workspace.id))
                }
                onClose={() => setWorkspaceMenu(null)}
              />
            )}
            {workspacesOpen && (
              <div
                className={cn(
                  SIDEBAR_LIST,
                  // The band heading these lanes sit under is fixed chrome above the
                  // scrollport on desktop, not a pinned row inside it, so there is no
                  // band slot for them to clear: a lane pins at the scroll's own top.
                  // Scoped here rather than on the scroll root because the bands BELOW
                  // this list (Automations, People) still pin inside it and their lanes
                  // still have to clear them.
                  "desktop:[--sidebar-band-slot:0px]",
                )}
                data-sidebar-list
              >
                {sessionsLoading && sessions.length === 0 && (
                  <ListSkeleton
                    variant="bare"
                    rows={8}
                    label="Loading sessions"
                    className="py-2"
                    rowClassName="px-2.5 py-[9px] phone:px-2 phone:py-[13px]"
                  />
                )}
                {/* A list that failed to fetch is an empty list with a reason, not a
				    validation error: it takes the same quiet centred treatment as
				    "No matching workspaces" below, one step up in ink, plus the
				    button that fixes it. The red alert box this replaced framed the
				    sidebar's own column in a border and outshouted the rows. */}
                {sessionsError && sessions.length === 0 && !sessionsLoading && (
                  <EmptyState
                    className="mx-4 my-7 gap-1.5 py-0"
                    action={
                      <Button size="sm" onClick={onRetrySessions}>
                        Try again
                      </Button>
                    }
                  >
                    {/* The one red thing: the sentence itself carries the hue, so
						    the failure is legible at a glance without a box around
						    it. EmptyState's own copy colour is `text-dim`, which a
						    class on the wrapper would not beat. */}
                    <span className="text-red">Couldn't load sessions</span>
                  </EmptyState>
                )}
                {workspaceListEmpty &&
                  !sessionsLoading &&
                  !sessionsError &&
                  hasWorkspaceFilter && (
                    <div className="mx-4 my-7 text-center text-label leading-[1.4] text-faint">
                      No matching workspaces
                    </div>
                  )}
                {/* One row even with nothing in the list: the session you have not
				    started yet, whose input is the main panel. It stands in for the
				    "No workspaces yet" line, which said the same thing without
				    offering anything to do about it. Phones keep their own empty
				    state below, where the sidebar is the whole screen and the panel
				    it would point at is a nav push away. */}
                {draftRow && (
                  <DraftRow
                    active={!!draftRowActive}
                    onClick={() => navigation.openDraft()}
                  />
                )}
                {workspaceListEmpty &&
                  !sessionsLoading &&
                  !sessionsError &&
                  !hasWorkspaceFilter &&
                  !draftRow &&
                  (!isPhone || !productEmpty) && (
                    <div className="mx-4 my-7 text-center text-label leading-[1.4] text-faint">
                      No workspaces yet
                    </div>
                  )}
                {productEmpty &&
                  !sessionsLoading &&
                  !sessionsError &&
                  !hasWorkspaceFilter &&
                  isPhone && (
                    <div className="flex min-h-[360px] flex-col items-center justify-center px-7 py-12 text-center">
                      <IconMessages size={30} className="mb-3 text-dim" />
                      <div className="text-section-title leading-[1.15] font-semibold tracking-[-0.02em] text-fg">
                        No sessions
                      </div>
                      <p className="m-0 mt-1 max-w-[26ch] text-body leading-[1.45] text-dim text-pretty">
                        Start one and it shows up here.
                      </p>
                      <div className="mt-4 flex flex-col items-center gap-1">
                        <Button
                          variant="soft"
                          size="md"
                          className="rounded-full px-4"
                          onClick={navigation.openNewWorkspace}
                        >
                          New session
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={navigation.openArchived}
                        >
                          Archived
                        </Button>
                      </div>
                    </div>
                  )}

                <PersonalBand
                  needsReview={renderLabeledBand({
                    label: "Needs review",
                    name: "needsreview",
                    rows: topBandRows(needsReviewRows),
                    prs: groupsByRepo ? [] : requestedPrItems,
                    renderRow: renderReviewWsRow,
                  })}
                  approved={renderLabeledBand({
                    label: "Approved",
                    name: "approvedreview",
                    rows: topBandRows(approvedReviewRows),
                    renderRow: renderReviewWsRow,
                  })}
                  awaitingReview={renderLabeledBand({
                    label: "Awaiting review",
                    name: "awaitingreview",
                    rows: topBandRows(awaitingReviewRows),
                  })}
                  pinned={personalPinnedBand}
                  projects={
                    projectBands ? (
                      <>
                        <ProjectBands
                          projects={projectBands}
                          askBand={ASK_BAND}
                          borrowedLens={borrowedLens}
                          isOpen={isOpen}
                          onToggleGroup={toggleGroup}
                          onOpenNewSessionInRepo={
                            navigation.openNewSessionInRepo
                          }
                          renderers={{
                            workspaceGrouping: renderWorkspaceGrouping,
                            labeledLane: renderLabeledLane,
                            workspaceRow: renderWsRow,
                            reviewWorkspaceRow: renderReviewWsRow,
                            prRow: renderPrRow,
                          }}
                          selection={{
                            workspaceRow: rowOwnsSelection,
                            prRow: prRowSelected,
                          }}
                          drag={repoDrag}
                        />
                        {visibleFeeds.map((descriptor) =>
                          renderFeedBand(descriptor, true),
                        )}
                      </>
                    ) : (
                      [
                        ...renderWorkspaceGrouping(
                          activeFocusWsRows,
                          "",
                          snoozedWsRows,
                          undefined,
                          filter.groupBy === "status" ? lanePrItems : [],
                        ),
                        ...(filter.groupBy === "status"
                          ? [
                              ...renderSupportLanes(plainThreadsInView),
                              ...visibleFeeds
                                .filter(
                                  (descriptor) => descriptor.id !== "plain",
                                )
                                .map((descriptor) =>
                                  renderFeedBand(descriptor, false),
                                ),
                            ]
                          : visibleFeeds.map((descriptor) =>
                              renderFeedBand(descriptor, true),
                            )),
                      ]
                    )
                  }
                  autoCreatedRows={autoCreatedRows}
                  autoCreatedHidden={filter.autoCreated === "hide"}
                  onToggleAutoCreated={() =>
                    setFilter({
                      autoCreated:
                        filter.autoCreated === "hide" ? "show" : "hide",
                    })
                  }
                />
              </div>
            )}
          </div>

          {/* ── Automations (one collapsible band, one group per automation) ── */}
          <AutomationsBand
            groups={groups}
            automationOverview={automationOverview}
            open={automationsOpen}
            hasPeople={activePersonGroups.length > 0}
            isGroupOpen={isOpen}
            onToggleBand={() => toggleBand("automations")}
            onToggleGroup={toggleGroup}
            onOpenAutomation={(name) => navigation.openAutomation(name)}
            onOpenReport={(automationId, reportId) =>
              navigation.openReports({ automationId, reportId })
            }
            renderSession={renderAutomationSession}
          />

          {/* ── Team: independently collapsible active teammates ── */}
          <PeopleBand
            groups={activePersonGroups}
            open={peopleOpen}
            isGroupOpen={isOpen}
            onToggleBand={() => toggleBand("people")}
            onToggleGroup={toggleGroup}
            renderSession={renderPersonSession}
          />

          {/* Archived closes the sidebar, below every section rather than inside
			    the workspace list. It is the end of the list, so anything ordered
			    after the workspaces (Automations and People) used to render past it,
			    which read as "the sidebar ended, and then there was more". */}
          {(!isPhone || !productEmpty || hasWorkspaceFilter) && (
            <div
              // It sits outside the workspace list, so it takes the same inset
              // its other out-of-list siblings do. Without it the row is the one
              // thing in the sidebar whose fill runs edge to edge.
              className={cn(SIDEBAR_INDEPENDENT_SECTION, SIDEBAR_GROUP, "mt-1")}
              style={{ order: 99 }}
            >
              {archivedLink}
            </div>
          )}

          {/* Phones keep setup in the sidebar's normal scroll flow. The bottom
			    margin clears the paired new-session and Desk controls. */}
          {isPhone && (
            <SetupWidget
              placement="phone"
              hasCreatedSession={sessions.length > 0}
              onOpenSettings={navigation.openSettings}
              onNewSession={navigation.openNewWorkspace}
            />
          )}

          {workspaceOverlays}
        </ContextMenu.Trigger>
        <SidebarToolsMenu
          tools={sidebarMenuTools}
          sources={sidebarMenuSources}
          onToggleTool={setToolVisible}
          onSetSupport={setSupportSurface}
          onToggleSource={setSidebarFeedVisible}
          onCustomize={() => setCustomizeOpen(true)}
        />
      </ContextMenu.Root>
      {/* The desktop prompt is a compact footer in the sidebar, like the
		    “View in the app” prompt, rather than floating over the composer. */}
      {!isPhone && (
        <SetupWidget
          placement="desktop"
          hasCreatedSession={sessions.length > 0}
          onOpenSettings={navigation.openSettings}
          onNewSession={navigation.openNewWorkspace}
        />
      )}
      <SidebarCustomizeDialog
        open={customizeOpen}
        onOpenChange={setCustomizeOpen}
        tools={sidebarMenuTools.map((tool) => ({
          id: tool.id,
          label: tool.label,
          icon: tool.icon,
          shown: tool.surface ? tool.surface === "page" : tool.shown,
          onShownChange: (shown: boolean) =>
            tool.surface
              ? setSupportSurface(shown ? "page" : "off")
              : setToolVisible(tool.id, shown),
        }))}
        repositories={repos}
        onToolOrderChange={(next) =>
          setSidebarToolOrder(
            replaceVisibleSidebarToolOrder(getSidebarToolOrder(), next),
          )
        }
        onRepositoryOrderChange={setRepoOrder}
      />
      {confirmDialog}
    </>
  );
});
