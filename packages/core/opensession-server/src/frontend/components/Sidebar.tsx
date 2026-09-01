import React, {
  useState,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import type {
  UnifiedSession,
  SupportThread,
  FeedDescriptor,
  FeedItem,
} from "../lib/types";
import {
  SIDEBAR_ATTN_COUNT,
  SIDEBAR_BAND_CHEVRON,
  SIDEBAR_BAND_CHEVRON_COLLAPSED,
  SIDEBAR_GROUP,
  SIDEBAR_GROUP_CHEVRON,
  SIDEBAR_GROUP_CHEVRON_COLLAPSED,
  SIDEBAR_GROUP_COUNT,
  SIDEBAR_GROUP_HEADER,
  SIDEBAR_GROUP_HEADER_INSET,
  SIDEBAR_GROUP_NAME,
  SIDEBAR_LANE_COUNT,
  SIDEBAR_LANE_HEADER,
  SIDEBAR_LANE_NAME,
  SIDEBAR_DENSITY_VARS,
  SIDEBAR_HEADER_BTN,
  SIDEBAR_HEADER_BTN_DESKTOP,
  SIDEBAR_HEADER_BTN_PHONE,
  SIDEBAR_HEADER_ROW,
  SIDEBAR_HOVER_LAYER,
  SIDEBAR_INDEPENDENT_SECTION,
  SIDEBAR_LANE_DROP_HOVER,
  SIDEBAR_LANE_EMPTY,
  SIDEBAR_LIST,
  SIDEBAR_NAV_X,
  SIDEBAR_RAIL,
  SIDEBAR_REPO_TILE,
  SIDEBAR_STATUS_DOT,
  SIDEBAR_STATUS_GROUP,
  SIDEBAR_STICKY_BAND,
  SIDEBAR_STICKY_BAND_ROW,
  SIDEBAR_STICKY_LANE,
  SIDEBAR_STICKY_LANE_NESTED,
  SIDEBAR_STUCK_BACKING,
  SIDEBAR_SWIPE_ACTION,
  SIDEBAR_SWIPE_ACTION_ARCHIVE,
  SIDEBAR_SWIPE_ACTION_OPEN,
  SIDEBAR_SWIPE_ACTION_STAR,
  SIDEBAR_SWIPE_ACTION_STAR_ON,
  SIDEBAR_SWIPE_ACTION_TRANSITION,
  SIDEBAR_SWIPE_ROW,
  SIDEBAR_WS_ACTION,
  SIDEBAR_WS_ACTIONS,
  SIDEBAR_WS_ACTIONS_HOVER,
  SIDEBAR_WS_FACE,
  SIDEBAR_WS_FACES,
  SIDEBAR_WS_ROW,
  SIDEBAR_WS_TIME,
  SIDEBAR_WS_TIME_HOVER,
} from "../lib/sidebar-classes";
import { mobileFilterBtn } from "../lib/app-header-classes";
import {
  ASK_BAND,
  isAskWorkspace,
  isScratchWorkspace,
  sessionShipsDirectlyToMain,
  subagentsByWorkspace,
  subagentsForSelectedWorkspace,
  workspaceMainSession,
  workspaceRowOwnsSelection,
  workspaceRowShipsDirectlyToMain,
} from "../lib/sidebar-workspaces";
import type { ReviewQueueItem } from "../lib/review-queue";
import {
  fetchOpenPrs,
  fetchFeeds,
  fetchFeedItems,
  closePrPreviewApi,
  PR_CLOSED_EVENT,
  PR_REVIEW_SUBMITTED_EVENT,
  setPlainThreadStatusApi,
  type PrClosedDetail,
  type OpenPr,
} from "../lib/api";
import { sameOpenPrSnapshot } from "../lib/open-pr-snapshot";
import { useCurrentUser } from "./UserPicker";
import { getLane, getLanes, onLanesChanged } from "../lib/lanes";
import {
  SNOOZE_SOMEDAY,
  clearSnooze,
  getSnoozes,
  onSnoozesChanged,
  setSnooze,
  snoozeIsActive,
} from "../lib/snoozes";
import { activityBandFor, type ActivityBand } from "../lib/sidebar-activity";
import { sortInboxByCreation } from "../lib/sidebar-inbox";
import {
  clearHides,
  getHides,
  onHidesChanged,
  partitionHidden,
  setHide,
} from "../lib/hides";
import { getRecents, onRecentsChanged } from "../lib/recents";
import {
  getReads,
  isUnread,
  markRead,
  markUnread,
  onReadsChanged,
} from "../lib/reads";
import {
  pickUnreadWorkspaceSession,
  shouldEmphasizeUnread,
} from "../lib/sidebar-unread-session";
import { mentionFor, onMentionsChanged } from "../lib/mentions";
import { setPendingSessionFork } from "../lib/pending-session-fork";
import { useTeamPresence } from "./TeamPresence";
import { sessionPath, absoluteLink, copyToClipboard } from "../lib/share-link";
import { getWsTimePref, onWsTimeChanged } from "../lib/workspace-time";
import {
  getSidebarDensity,
  onSidebarDensityChanged,
} from "../lib/sidebar-density";
import { setRepoOrder } from "../lib/repo-order";
import { UserAvatar, githubLoginFor } from "./UserAvatar";
import { facepileAvatarStyle, otherViewers } from "../lib/presence";
import { shortTime } from "../lib/time";
import {
  IconChevronDown,
  IconArchive,
  IconMoon,
  IconFilter,
  IconX,
  IconInbox,
  IconPlus,
  IconStack,
  IconPin,
  IconMail,
  IconTrash,
  IconChart,
  IconFile,
  IconListCircles,
  IconMessages,
  IconFeed,
  IconPeople,
  IconPullRequest,
} from "./icons";
import { Button } from "../ui/button";
import { useConfirm } from "../ui/confirm";
import { Tooltip } from "../ui/tooltip";
import { ContextMenu } from "../ui/menu";
import { Popover } from "../ui/popover";
import { cn } from "../ui/cn";
import { RowCardPopup } from "./SidebarRowCards";
import { pointerCanHover } from "../lib/pointer";
import { RepoTile } from "./RepoTile";
import { useIsPhone } from "../hooks/useIsPhone";
import { useNavigation } from "../hooks/useNavigation";
import { useShortcutKeys } from "../hooks/useShortcutBindings";
import { useSidebarDnd } from "../hooks/useSidebarDnd";
import { blockingOverlayOpen } from "../lib/blocking-overlay";
import { matchesShortcut } from "../lib/shortcuts";
import { PrRow } from "./PrRow";
import {
  personKey,
  reviewAskerFor,
  wsPrRequestsReviewFrom,
} from "../lib/review-queue";
import { usePeople } from "../lib/people";
import { canonicalNames } from "../lib/session-owner";
import {
  PERSON_RECENT_ACTIVITY_MS,
  sidebarPersonSessions,
} from "../lib/sidebar-people";
import {
  rowOriginSource,
  rowWasAgentStarted,
  rowsAtPlacement,
} from "../lib/sidebar-placement";
import { ReviewAskerFace } from "./ReviewAskerFace";
import {
  readHiddenSidebarTools,
  getSidebarToolOrder,
  mergeSidebarToolOrder,
  replaceVisibleSidebarToolOrder,
  setSidebarToolOrder,
  setSidebarToolVisible,
  onSidebarToolsChanged,
  toolFitsViewport,
  SIDEBAR_TOOL_LABELS,
} from "../lib/sidebar-tools";
import {
  onSidebarFeedsChanged,
  readHiddenSidebarFeeds,
  setSidebarFeedVisible,
} from "../lib/sidebar-feeds";
import {
  PLAIN_ID,
  setSupportSurface,
  supportSurfaceOf,
} from "../lib/support-surface";
import {
  DEFAULT_PROJECT,
  EXPANDED_KEY,
  FEED_FILTERS_KEY,
  SUPPORT_PRIORITY_GROUPS,
  dget,
  personLensFilter,
  personLensValue,
  readExpanded,
  readFeedFilters,
  setFilter,
  useSidebarFilter,
  sessionRepo,
  type FeedFilterValues,
} from "../lib/sidebar-filter";
import { useAutomationOverview } from "../lib/automation-overview";
import {
  isClaimed,
  mineStatus,
  ownedBy,
  pinnedLane,
  prLaneForSessions,
  stripPrTitlePrefix,
  workspaceRunNeedingAttention,
} from "../lib/sidebar-lanes";
import { sessionHasPr } from "../lib/session-prs";
import { sessionHasWorkspace } from "../lib/session-workspace";
import {
  nextRenderedSidebarChat,
  nextRenderedSidebarItem,
  nextUnreadRenderedWorkspaceItem,
} from "../lib/sidebar-next";
import { previewSidebarSelection } from "../lib/sidebar-selection";
import {
  LONG_PRESS_MS,
  LONG_PRESS_SLOP,
  SWIPE_AXIS_LOCK_PX,
  SWIPE_COMMIT_MS,
  SWIPE_OPEN_THRESHOLD,
  SWIPE_REVEAL_PX,
  clampSwipe,
  editableOwnsCaretChord,
  editableSwallowsArchiveChord,
  fullSwipeThreshold,
  swipeActionForOffset,
  swipeCommitOffset,
  type SwipeAction,
  type SwipeState,
} from "../lib/sidebar-swipe";
import {
  MINE_STATUS_META,
  type GroupBand,
  type MineStatus,
  type OpenNextSidebarItem,
  type PersonalBandPinnedEntry,
  type Props,
  type SidebarHandle,
  type WsRow,
} from "../lib/sidebar-types";
import { FeedFilterMenu, FeedRow, SupportRow } from "./sidebar/FeedRows";
import { FilterPopover, RepoFilterChip } from "./sidebar/Filters";
import {
  RunTicker,
  SnoozeBadge,
  WsCardBody,
  WsMobileSheet,
  WsPrStatusMark,
  WsStatusMark,
} from "./sidebar/HoverCards";
import { AutoCreatedMark } from "./sidebar/AutoCreatedMark";
import { KeepInSidebarMark } from "./sidebar/KeepInSidebarMark";
import { OriginMark } from "./sidebar/OriginMark";
import { AutomationsBand } from "./sidebar/AutomationsBand";
import { PersonalBand } from "./sidebar/PersonalBand";
import { PeopleBand } from "./sidebar/PeopleBand";
import { ProjectBands } from "./sidebar/ProjectBands";
import { SubagentRows } from "./sidebar/SubagentRows";
import { DraftRow } from "./sidebar/DraftRow";
import { WorkspaceDraftIndicator } from "./sidebar/WorkspaceDraftIndicator";
import { WorkspaceContextMenu } from "./sidebar/WorkspaceContextMenu";
import { SidebarToolsMenu } from "./sidebar/SidebarToolsMenu";
import {
  SidebarToolsNav,
  type SidebarToolsNavItem,
} from "./sidebar/SidebarToolsNav";
import { SidebarCustomizeDialog } from "./sidebar/SidebarCustomizeDialog";
import { SetupWidget } from "./sidebar/SetupWidget";
import { buildWorkspaceRows } from "../lib/sidebar-workspace-rows";
import {
  automationActivityKey,
  buildAutomationGroups,
  completeSidebarRepoOrder,
  deriveSidebarPrRows,
  deriveSidebarProjectBands,
  deriveWorkspacePlacement,
  discoverSidebarRepos,
  filterSidebarSessions,
  latestSupportSessionsByThread,
  orderedSidebarRepos,
  personLensName as resolvePersonLensName,
  pinnedWorkspaceRows,
  sidebarPeople,
  sortSidebarSessions,
  sortSnoozedWorkspaceRows,
  supportThreadsFromFeedItems,
  withAgentPerson,
  workspaceRowIsFeedOnly,
} from "../lib/sidebar-derived";
import { EmptyState, ListSkeleton } from "../ui/state";
import {
  SIDEBAR_ROW,
  SIDEBAR_ROW_TITLE,
  SidebarItem,
} from "./sidebar/SidebarItem";

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
  // The compact People list has one real-time boundary: an idle run leaves it
  // fifteen minutes after its last activity. Wake only at the next boundary
  // rather than polling and rebuilding this large sidebar every minute.
  const [peopleActivityNow, setPeopleActivityNow] = useState(Date.now);
  useEffect(() => {
    const now = Date.now();
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const session of sessions) {
      if (session.isRunning || !session.ran) continue;
      const lastActivity = Date.parse(session.lastActivity || "");
      if (!Number.isFinite(lastActivity)) continue;
      const expiry = lastActivity + PERSON_RECENT_ACTIVITY_MS;
      if (expiry > now && expiry < nextExpiry) nextExpiry = expiry;
    }
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(
      () => setPeopleActivityNow(Date.now()),
      Math.min(2_147_483_647, Math.max(0, nextExpiry - now + 50)),
    );
    return () => window.clearTimeout(timer);
  }, [sessions, peopleActivityNow]);
  // Groups are collapsed by default; the expanded set persists per browser
  const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
  const [hiddenTools, setHiddenTools] = useState(readHiddenSidebarTools);
  const [toolOrder, setToolOrderState] = useState(getSidebarToolOrder);
  const [hiddenFeeds, setHiddenFeeds] = useState(readHiddenSidebarFeeds);
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
  // CSS has no interoperable :stuck selector. Track the shared sidebar
  // scrollport instead so section/lane labels can stay transparent in-flow and
  // gain an opaque surface only while position:sticky is actively pinning them.
  useLayoutEffect(() => {
    const root = sidebarScrollRef.current;
    if (!root) return;
    let frame = 0;
    // Every heading that can pin marks itself with `data-sticky-head`, so
    // this listener never has to know which family it belongs to (band,
    // lane, repo, status) — or survive the class names being restyled.
    const selector = "[data-sticky-head]";
    // What a header's own styles say: whether it pins at all, and the offset
    // it pins at. A scroll frame cannot change either, and reading them is a
    // style recalc per header, so they are cached here and re-read only when
    // the list, the rail or the density actually changes. `stuck` is the
    // attribute as last applied, so an unchanged header costs no write.
    type StickyHead = {
      el: HTMLElement;
      parent: HTMLElement;
      sticky: boolean;
      top: number;
      stuck: boolean;
    };
    let heads: StickyHead[] = [];
    let stale = true;
    const rescan = () => {
      stale = false;
      const applied = new Map(heads.map((h) => [h.el, h.stuck]));
      heads = [];
      for (const el of root.querySelectorAll<HTMLElement>(selector)) {
        const style = getComputedStyle(el);
        const parent = el.parentElement;
        heads.push({
          el,
          parent: parent ?? el,
          sticky: style.position === "sticky" && !!parent,
          top: Number.parseFloat(style.top) || 0,
          // React owns className and rewrites it on rerender. The dedicated
          // data attribute is not part of that managed value, so it preserves
          // the backing while the scroll position remains unchanged.
          stuck: applied.get(el) ?? el.hasAttribute("data-stuck"),
        });
      }
    };

    const update = () => {
      frame = 0;
      if (stale) rescan();
      // One read pass, then one write pass. A toggle between two rect
      // reads dirties layout for every header still to be measured, which
      // is what made a scroll frame over ~80 headers cost as much as it
      // did.
      const rootTop = root.getBoundingClientRect().top;
      const next: boolean[] = [];
      for (const head of heads) {
        if (!head.sticky) {
          next.push(false);
          continue;
        }
        const rect = head.el.getBoundingClientRect();
        const pinned = rect.top <= rootTop + head.top + 0.5;
        // Pin-line position alone also matches a header that naturally
        // RESTS at its sticky offset (the first section at scrollTop 0 —
        // the solid-pill-while-unscrolled bug), so additionally require
        // real displacement from the parent. All of these headers sit
        // flush with their parent's top in static layout, so a positive
        // delta means sticky is actively holding the header back. (Don't
        // try offsetTop for this: Chromium reports the displaced sticky
        // position there, not static layout.)
        const displaced =
          rect.top - head.parent.getBoundingClientRect().top > 1.5;
        next.push(pinned && displaced);
      }
      for (let i = 0; i < heads.length; i++) {
        const head = heads[i]!;
        const stuck = next[i]!;
        if (head.stuck === stuck) continue;
        head.stuck = stuck;
        head.el.toggleAttribute("data-stuck", stuck);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    // Mark rather than re-read: a burst of row updates in one frame then
    // costs one scan at rAF time instead of one per mutation record.
    const invalidate = () => {
      stale = true;
      schedule();
    };

    update();
    root.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", invalidate);
    const resizeObserver = new ResizeObserver(invalidate);
    resizeObserver.observe(root);
    const mutationObserver = new MutationObserver(invalidate);
    mutationObserver.observe(root, { childList: true, subtree: true });
    // Density retunes the offsets these headers pin at (--sidebar-band-slot)
    // without touching the list, so the cache has to be re-read for it too.
    const densityObserver = new MutationObserver(invalidate);
    densityObserver.observe(root, {
      attributes: true,
      attributeFilter: ["data-density"],
    });

    return () => {
      root.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", invalidate);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      densityObserver.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [sidebarScrollRef]);

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

  const selectedSession =
    sessions.find(
      (session) =>
        session.id === selectedId ||
        session.aliasIds?.includes(selectedId || ""),
    ) || null;
  const filtered = filterSidebarSessions({
    sessions,
    workspaces,
    filter,
    search,
    canonicalNames: canonical,
    selectedSession,
    selectedWorkspaceId,
  });
  const sorted = sortSidebarSessions(filtered, filter.sort);

  // Child sessions belong to their root workspace, not to whichever temporary
  // workspace they created. Derive every family from the complete live list,
  // then keep only groups whose root row survives the current lens. A worker
  // therefore stays nested after its run or pull request finishes.
  const visibleWorkspaceIds = new Set(
    filtered.flatMap((session) =>
      session.workspaceId ? [session.workspaceId] : [],
    ),
  );
  const subagentsByWorkspaceId = new Map(
    Array.from(subagentsByWorkspace(sessions)).filter(([workspaceId]) =>
      visibleWorkspaceIds.has(workspaceId),
    ),
  );
  const workspaceSubagentIds = new Set(
    Array.from(subagentsByWorkspaceId.values()).flatMap((items) =>
      items.map(({ session }) => session.id),
    ),
  );

  // Team activity is deliberately independent of the workspace lens above it:
  // repo/person/search filters must not make a running teammate disappear from
  // the complete live list at the bottom. The server's sidebar projection adds
  // every live or just-finished run to `sessions`; the directory boundary here
  // turns only real teammates into headings and files unowned automations under
  // the Agent person. A session kept in a personal lane leaves Team, so every
  // row here can always offer “Add to your sidebar” without rendering twice.
  const activePersonGroups = sidebarPersonSessions(
    sessions,
    roster,
    currentUser,
    peopleActivityNow,
    new Map(
      Array.from(automationOverview, ([name, overview]) => [
        name,
        overview.owner,
      ]),
    ),
    new Set(
      sessions
        .filter((session) => isClaimed(session))
        .map((session) => session.id),
    ),
  );

  const allWsRows = buildWorkspaceRows({
    sessions: filtered,
    workspaces,
    openPrs: openPrs ?? [],
    nestedSubagentIds: workspaceSubagentIds,
    selectedWorkspaceId,
    selectedSessionId: selectedId,
    reads,
    canonicalNames: canonical,
    sort: filter.sort,
    isClaimed,
    statusForSession: mineStatus,
    pinnedLaneForSession: pinnedLane,
    prLaneForSessions,
    mentionForSession: mentionFor,
  });
  const rowOwnsSelection = (row: WsRow) =>
    workspaceRowOwnsSelection(row, selectedSession, selectedWorkspaceId);
  const selectionBelongsToWorkspaceRow = allWsRows.some(rowOwnsSelection);
  const automationRowSelected = (session: UnifiedSession) =>
    session.id === selectedId && !selectionBelongsToWorkspaceRow;

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

  // A draft workspace row (the composer sitting there prefilled, no session
  // yet) has nothing to archive: see mkRow's draft loop above, the only
  // place a sessionless row is ever pushed. Its removal action is delete,
  // not archive.
  function isDraftWsRow(row: WsRow): boolean {
    return !!row.workspace?.draft && row.sessions.length === 0;
  }

  const wsSwipeOffset = useRef(0);

  function deleteDraftWsRow(row: WsRow) {
    const ws = row.workspace;
    if (!ws) return;
    Promise.resolve(onDeleteWorkspace(ws.id)).catch(() => {
      // Delete failed: bring the row back instead of leaving it slid
      // off-screen and pointing at a workspace that is still there.
      setWsSwipe(null);
      wsSwipeOffset.current = 0;
    });
  }

  function rowIsSnoozed(row: WsRow): boolean {
    return activeSnoozeKeys.has(row.key);
  }

  function toggleWorkspaceSnooze(row: WsRow) {
    if (rowIsSnoozed(row)) clearSnooze(row.key);
    else setSnooze(row.key, SNOOZE_SOMEDAY);
  }

  function archiveWorkspaceWithNext(
    row: WsRow,
    current: HTMLButtonElement | null = null,
  ) {
    onArchiveWorkspace(
      row.sessions,
      openNextSidebarItem(`workspace:${row.key}`, current),
    );
  }

  /**
   * Hide a row from THIS user's sidebar, leaving the sessions untouched for
   * everyone else (the point of the feature — see `hiddenRowKeys`). Drops the
   * row's pins and any snooze first: a pinned-but-hidden row would snap to the
   * top of Pinned the moment it resurfaced, and a snooze wake would resurface
   * a row the user just hid. Lane membership is deliberately kept, so a
   * restored row returns to where it was.
   */
  function hideRow(row: WsRow) {
    const pinnedKeys = [
      row.key,
      ...row.sessions.flatMap((c) => [c.id, ...(c.aliasIds || [])]),
    ].filter((k, i, a) => pins.includes(k) && a.indexOf(k) === i);
    if (pinnedKeys.length) togglePinnedKeys(pinnedKeys);
    clearSnooze(row.key);
    // Keep something open if the row being hidden owns the active session.
    if (row.sessions.some((c) => c.id === selectedId)) {
      const candidates = wsRowOrder.filter((r) => r.sessions.length > 0);
      const idx = candidates.findIndex((r) => r.key === row.key);
      const rest = candidates.filter((r) => r.key !== row.key);
      const next =
        idx >= 0
          ? (rest[Math.min(idx, rest.length - 1)] ?? null)
          : (rest[0] ?? null);
      if (next) openSidebarSession(next.sessions[0]);
    }
    setHide(row.key);
  }

  // Archive just the open session and pick what becomes active. A workspace
  // with another tab stays on that workspace. When its last tab goes away, the
  // rendered list decides what opens next.
  function archiveOpenSessionWithNext() {
    const row = wsRowOrder.find((candidate) =>
      candidate.sessions.some((session) => session.id === selectedId),
    );
    if (!row) {
      // The open session can be hidden by the current person/repo/search lens.
      // Archiving the active session must not depend on it being rendered.
      const session = sessions.find((s) => s.id === selectedId && !s.archived);
      if (session)
        onArchive(session, openNextSidebarItem(`session:${session.id}`));
      return;
    }
    const session = row.sessions.find(
      (candidate) => candidate.id === selectedId,
    );
    if (!session) return;
    const siblings = row.sessions.filter(
      (candidate) => candidate.id !== selectedId,
    );
    if (siblings.length > 0) {
      const sessionIdx = row.sessions.findIndex(
        (candidate) => candidate.id === selectedId,
      );
      const sibling =
        siblings[Math.min(sessionIdx, siblings.length - 1)] ?? null;
      onArchive(
        session,
        sibling
          ? () => {
              openSidebarSession(sibling);
              return true;
            }
          : null,
      );
      return;
    }
    onArchive(session, openNextSidebarItem(`workspace:${row.key}`));
  }

  React.useImperativeHandle(ref, () => ({
    archiveSelected: archiveOpenSessionWithNext,
  }));

  const reportedNextChatAvailable = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const sidebar = sidebarScrollRef.current?.querySelector(
      "[data-sidebar-list]",
    );
    const workspaceItems = Array.from(
      sidebar?.querySelectorAll<HTMLButtonElement>("button[data-ws-row]") ?? [],
    );
    const renderedItems = Array.from(
      sidebar?.querySelectorAll<HTMLButtonElement>(
        "button[data-sidebar-row]",
      ) ?? [],
    );
    const available = !!(
      nextUnreadRenderedWorkspaceItem(workspaceItems) ??
      nextRenderedSidebarChat(renderedItems)
    );
    if (reportedNextChatAvailable.current === available) return;
    reportedNextChatAvailable.current = available;
    onNextChatAvailableChange?.(available);
  });

  // Advertised keycaps, read through the registry so a rebind in Settings
  // repaints the hints instead of leaving them describing the old chord.
  const newSessionKeys = useShortcutKeys("session-new");
  const pinShortcutKeys = useShortcutKeys("session-pin");
  const archiveShortcutKeys = useShortcutKeys("session-archive");

  // ── Workspace hover card ────────────────────────────────────────────────
  // The same card every sidebar row raises, driven by hand: workspace rows
  // come out of a render function rather than a component, so one card serves
  // the whole list (only one row can be dwelled on at a time) and the hovered
  // row is its anchor. The card carries actions (Archive, PR link,
  // thumbnails), so leaving the row schedules the close with a short grace
  // period and entering the card cancels it — the pointer can travel the 8px
  // gap without the card vanishing under it.
  const wsHoverOpenT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsHoverCloseT = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The row element itself is the anchor — the popover tracks it, so a
  // scrolling list repositions the card instead of dropping it.
  const [wsHover, setWsHover] = useState<{
    row: WsRow;
    el: HTMLElement;
  } | null>(null);
  // Mobile long-press sheet (the touch stand-in for the hover card).
  const [wsSheet, setWsSheet] = useState<{
    row: WsRow;
    source: HTMLButtonElement;
  } | null>(null);

  const cancelWsHoverTimers = () => {
    if (wsHoverOpenT.current) clearTimeout(wsHoverOpenT.current);
    if (wsHoverCloseT.current) clearTimeout(wsHoverCloseT.current);
    wsHoverOpenT.current = null;
    wsHoverCloseT.current = null;
  };
  function wsRowHoverEnter(row: WsRow, el: HTMLElement) {
    if (rowRenameEditing(row) || !pointerCanHover()) return;
    cancelWsHoverTimers();
    if (wsHover) {
      setWsHover({ row, el });
      return;
    }
    wsHoverOpenT.current = setTimeout(() => {
      setWsHover({ row, el });
    }, 380);
  }
  function scheduleWsHoverClose() {
    if (wsHoverOpenT.current) clearTimeout(wsHoverOpenT.current);
    wsHoverOpenT.current = null;
    if (wsHoverCloseT.current) clearTimeout(wsHoverCloseT.current);
    wsHoverCloseT.current = setTimeout(() => setWsHover(null), 140);
  }
  function closeWsHover() {
    cancelWsHoverTimers();
    setWsHover(null);
  }
  useEffect(() => cancelWsHoverTimers, []);

  // ⌘E (or the legacy ⌘⇧A) archives the open session and lands on the next entry
  // in the sidebar, rather than dropping back to Home. This lives here (not in
  // the viewer) because the sidebar owns the row ordering that defines "next".
  // The viewer keeps the same chord only for the unarchive toggle on an
  // already-archived session — that session isn't in this list, so this
  // handler no-ops on it and the two never both fire. ⌘⌥⇧A below escalates to
  // the whole workspace.
  const handleArchiveSessionKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || !matchesShortcut(e, "session-archive")) return;
    if (blockingOverlayOpen()) return;
    if (editableSwallowsArchiveChord(e.target)) return;
    const canArchive = sessions.some((s) => s.id === selectedId && !s.archived);
    if (!canArchive) return;
    e.preventDefault();
    closeWsHover();
    archiveOpenSessionWithNext();
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => handleArchiveSessionKey(e);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ⌘⌥⇧A escalates the session archive (⌘E/⌘⇧A) to the whole active workspace.
  // The Alt modifier is the only thing that separates the two handlers, so
  // exactly one fires. Targets the workspace holding the open session.
  const handleArchiveWorkspaceKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || !matchesShortcut(e, "workspace-archive")) return;
    if (editableSwallowsArchiveChord(e.target)) return;
    const row = wsRowOrder.find(
      (r) =>
        r.sessions.length > 0 && r.sessions.some((c) => c.id === selectedId),
    );
    if (!row) return;
    e.preventDefault();
    closeWsHover();
    archiveWorkspaceWithNext(row);
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => handleArchiveWorkspaceKey(e);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ⌘P pins the open session's workspace ROW, so the chord and the row's own
  // pin button move the same pin. They used to move different ones: the button
  // pins the workspace key (plus any legacy member-session pins), the viewer's
  // chord pins the session id, so a row pinned by click and then unpinned by
  // chord stayed pinned and the keypress looked dead.
  // The viewer keeps the chord for sessions this list doesn't render — an
  // archived one, or one the current lens filters out. Capture phase, so this
  // runs before the viewer's window listener whatever order they mounted in,
  // and `preventDefault` is what tells it we took the key.
  const handlePinWorkspaceKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || !matchesShortcut(e, "session-pin")) return;
    if (blockingOverlayOpen()) return;
    // Decline inside a text field rather than swallowing the key: the
    // viewer's own handler still sees it, so this only ever adds row
    // semantics, never removes the chord from where it worked before.
    if (editableSwallowsArchiveChord(e.target)) return;
    const row = wsRowOrder.find(rowOwnsSelection);
    if (!row) return;
    e.preventDefault();
    workspacePinState(row).toggle();
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => handlePinWorkspaceKey(e);
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // ⌘↓/⌘↑ cycle through the sidebar's rendered items in visual order (down =
  // next row), wrapping at the ends. Reading the DOM here is intentional: each
  // section owns its filtering and collapsed state, so rendered buttons are the
  // single source of truth for what keyboard navigation can reach.
  // Declines inside a text field, the composer included: there ⌘↑/⌘↓ are the
  // caret's own moves to the start and end of the draft, and taking them for
  // workspace cycling costs more than it gives. An empty composer is the one
  // exception, and editableOwnsCaretChord carries the reason. Alt is excluded
  // so ⌘⌥ arrows stay free for the reasoning-effort chord (SessionViewer);
  // Shift so ⌘⇧-arrow text selection keeps working.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      const dir = matchesShortcut(e, "sidebar-next")
        ? 1
        : matchesShortcut(e, "sidebar-prev")
          ? -1
          : 0;
      if (dir === 0) return;
      if (editableOwnsCaretChord(e.target)) return;
      if (blockingOverlayOpen()) return;
      const candidates = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          "[data-sidebar-list] button[data-sidebar-row]",
        ),
      );
      if (candidates.length === 0) return;
      const idx = candidates.findIndex((item) =>
        item.hasAttribute("data-selected"),
      );
      // No selected sidebar item (e.g. Home): enter from the edge.
      const next =
        idx < 0
          ? dir === 1
            ? candidates[0]
            : candidates[candidates.length - 1]
          : candidates[(idx + dir + candidates.length) % candidates.length];
      if (!next) return;
      e.preventDefault();
      closeWsHover();
      next.scrollIntoView({ block: "nearest" });
      next.click();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Mobile: tap-to-open a workspace row fires from `touchend`, not the
  // synthesized click — same trick as SessionRow. The row has :hover styles
  // (the reveal-on-hover pin/archive swap, the hover background) plus a
  // mouseenter hover card, and iOS treats the first tap on such an element as
  // a hover-in, swallowing the click — so a click-driven open needs a second
  // tap. A hold that stays roughly in place for LONG_PRESS_MS opens the
  // workspace menu (the touch stand-in for right-click); real finger travel
  // (a scroll) cancels both. Only one touch happens at a time, so one set of
  // refs serves every row.
  const wsPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsPressOrigin = useRef<{ x: number; y: number } | null>(null);
  const wsLongPressed = useRef(false);
  const wsMoved = useRef(false);
  const wsSwipeOrigin = useRef<{ x: number; y: number; width: number } | null>(
    null,
  );
  const wsSwiping = useRef(false);
  const [wsSwipe, setWsSwipe] = useState<SwipeState | null>(null);
  const [wsDraggingKey, setWsDraggingKey] = useState<string | null>(null);
  // Which action the in-flight drag is revealing. Split from wsSwipe so a
  // touchmove only re-renders when the side FLIPS — the per-frame offset is
  // written straight to the DOM in wsRowTouchMove.
  const [wsDragSide, setWsDragSide] = useState<SwipeAction | null>(null);
  useEffect(() => {
    if (!isPhone) {
      setWsSwipe(null);
      wsSwipeOffset.current = 0;
      setWsDraggingKey(null);
      setWsDragSide(null);
    }
  }, [isPhone]);
  useEffect(() => {
    setWsSwipe(null);
    wsSwipeOffset.current = 0;
    setWsDraggingKey(null);
    setWsDragSide(null);
  }, [selectedId]);

  function clearWsPress() {
    if (wsPressTimer.current) clearTimeout(wsPressTimer.current);
    wsPressTimer.current = null;
    wsPressOrigin.current = null;
  }
  function wsRowTouchStart(row: WsRow, e: React.TouchEvent) {
    if (rowRenameEditing(row)) return;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    wsLongPressed.current = false;
    wsMoved.current = false;
    wsSwiping.current = false;
    clearWsPress();
    if (wsSwipe?.key && wsSwipe.key !== row.key) setWsSwipe(null);
    // After clearWsPress (which nulls it) so it survives to move/end.
    wsPressOrigin.current = { x: t.clientX, y: t.clientY };
    wsSwipeOrigin.current = {
      x: t.clientX - (wsSwipe?.key === row.key ? wsSwipe.offset : 0),
      y: t.clientY,
      width: e.currentTarget.clientWidth,
    };
    const source = e.currentTarget as HTMLButtonElement;
    wsPressTimer.current = setTimeout(() => {
      wsLongPressed.current = true;
      closeWsHover();
      navigator.vibrate?.(10);
      // The touch stand-in for both the hover card AND right-click: a
      // bottom sheet with the overview block plus every workspace action.
      setWsSheet({ row, source });
    }, LONG_PRESS_MS);
  }
  function wsRowTouchMove(row: WsRow, e: React.TouchEvent) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const swipeO = wsSwipeOrigin.current;
    if (swipeO && !wsLongPressed.current) {
      const dx = t.clientX - swipeO.x;
      const dy = t.clientY - swipeO.y;
      if (
        wsSwiping.current ||
        (Math.abs(dx) > SWIPE_AXIS_LOCK_PX && Math.abs(dx) > Math.abs(dy))
      ) {
        wsSwiping.current = true;
        wsMoved.current = true;
        setWsDraggingKey(row.key);
        clearWsPress();
        e.preventDefault();
        const offset = clampSwipe(dx, swipeO.width);
        wsSwipeOffset.current = offset;
        // Per-frame position goes straight to the DOM: a setState here
        // re-rendered the entire sidebar on every touchmove, which
        // phones can't do at 60fps. React only hears about drag start
        // and side flips; touchend reconciles the committed state.
        const btn = e.currentTarget as HTMLElement;
        btn.style.setProperty("--swipe-x", `${offset}px`);
        btn.parentElement?.style.setProperty(
          "--swipe-action-w",
          `${Math.max(SWIPE_REVEAL_PX, Math.abs(offset))}px`,
        );
        setWsDragSide(swipeActionForOffset(offset));
        return;
      }
    }
    const o = wsPressOrigin.current;
    if (!o) return;
    if (
      Math.abs(t.clientX - o.x) > LONG_PRESS_SLOP ||
      Math.abs(t.clientY - o.y) > LONG_PRESS_SLOP
    ) {
      wsMoved.current = true;
      clearWsPress();
    }
  }
  // A bold row points to unread activity, so that tab wins over the row's lane
  // or remembered tab. Rows with no unread activity keep their normal routing.
  function openWsRow(row: WsRow, review: boolean) {
    const mainSession = workspaceMainSession(row);
    const unreadSession = pickUnreadWorkspaceSession(
      row.sessions,
      selectedId,
      reads,
    );
    if (unreadSession) {
      if (row.workspace)
        navigation.openWorkspace(row.workspace.id, unreadSession.id);
      else openSidebarSession(unreadSession);
      return;
    }
    // Only open Review when there is something to inspect: a PR, or a branch or
    // worktree that can produce a diff. Otherwise use the normal workspace path.
    const reviewable =
      row.workspace?.prNumber !== undefined ||
      row.sessions.some((s) => sessionHasPr(s) || sessionHasWorkspace(s));
    if (review && reviewable && mainSession)
      navigation.openSessionReview(mainSession);
    else if (row.workspace) navigation.openWorkspace(row.workspace.id);
    // Pre-migration grouped rows have no workspace record to restore through.
    else if (mainSession) openSidebarSession(mainSession);
  }
  function wsRowTouchEnd(row: WsRow, e: React.TouchEvent, review = false) {
    const hadOrigin = wsPressOrigin.current !== null;
    const wasSwiping = wsSwiping.current;
    const rowWidth =
      wsSwipeOrigin.current?.width ?? e.currentTarget.clientWidth;
    // Read the committed distance straight off the ref (like SessionRow),
    // gated on the `wasSwiping` ref — NOT the `wsSwipe` state. Touch events are
    // continuous, so React can batch the last touchmove's setWsSwipe and not
    // re-render before touchend; a `wsSwipe?.key === row.key` gate would then
    // read stale state, collapse the offset to 0, and silently drop the swipe
    // (the intermittent "slide didn't archive"). The ref is always current.
    const swipeOffset = isPhone && wasSwiping ? wsSwipeOffset.current : 0;
    clearWsPress();
    wsSwipeOrigin.current = null;
    wsSwiping.current = false;
    setWsDraggingKey(null);
    setWsDragSide(null);
    // The drag wrote --swipe-x / --swipe-action-w straight onto the DOM;
    // React never owned them, so a re-render with an undefined style prop
    // won't remove them. Clear here; the committed wsSwipe state (if any)
    // re-applies them through the style props on this same flush.
    const rowEl = e.currentTarget as HTMLButtonElement;
    rowEl.style.removeProperty("--swipe-x");
    rowEl.parentElement?.style.removeProperty("--swipe-action-w");
    if (rowRenameEditing(row)) return;
    if (wasSwiping) {
      e.preventDefault();
      if (Math.abs(swipeOffset) >= fullSwipeThreshold(rowWidth)) {
        const action = swipeActionForOffset(swipeOffset);
        if (!action) return;
        setWsSwipe({
          key: row.key,
          offset: swipeCommitOffset(action, rowWidth),
          action,
        });
        window.setTimeout(() => {
          if (action === "archive") {
            if (isDraftWsRow(row)) deleteDraftWsRow(row);
            else archiveWorkspaceWithNext(row, rowEl);
          } else {
            workspacePinState(row).toggle();
            setWsSwipe({ key: row.key, offset: 0, action });
            window.setTimeout(() => setWsSwipe(null), SWIPE_COMMIT_MS);
          }
          wsSwipeOffset.current = 0;
        }, SWIPE_COMMIT_MS);
        return;
      }
      setWsSwipe(
        (() => {
          const snapped =
            Math.abs(swipeOffset) > SWIPE_OPEN_THRESHOLD
              ? swipeOffset > 0
                ? SWIPE_REVEAL_PX
                : -SWIPE_REVEAL_PX
              : 0;
          wsSwipeOffset.current = snapped;
          return snapped ? { key: row.key, offset: snapped } : null;
        })(),
      );
      return;
    }
    // A clean tap: started on this row, never became a long-press, never
    // turned into a scroll. Open now and swallow the ghost click — which
    // also keeps the synthesized mouseenter from opening the hover card.
    if (hadOrigin && !wsLongPressed.current && !wsMoved.current) {
      e.preventDefault();
      if (wsSwipe?.key === row.key && wsSwipe.offset !== 0) {
        setWsSwipe(null);
        wsSwipeOffset.current = 0;
        return;
      }
      openWsRow(row, review);
    } else if (wsLongPressed.current) {
      // Release after a long-press: the workspace sheet is already up —
      // swallow any ghost click so it can't land on the sheet (or its
      // backdrop's close handler) and immediately dismiss it.
      e.preventDefault();
    }
  }

  // Repo, review, project, support and person groups are open by default
  // (grouping is itself the point), so we track their *collapsed* state under
  // a "collapsed:" key; every other group is closed by default and tracked
  // directly. This list must match isOpen's — a key toggled here but read
  // bare there (or vice versa) makes its chevron a no-op.
  const collapseKey = (key: string) =>
    key.startsWith("repo:") ||
    key.startsWith("review:") ||
    key.startsWith("project:") ||
    key.startsWith("support:") ||
    key.startsWith("lifecycle:") ||
    key.startsWith("inbox:") ||
    key.startsWith("person:")
      ? `collapsed:${key}`
      : key;

  function toggleGroup(key: string) {
    const stored = collapseKey(key);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(stored)) next.delete(stored);
      else next.add(stored);
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  // While searching, show everything that matched.
  const isOpen = (key: string) => {
    if (search.trim().length > 0) return true;
    if (
      key.startsWith("repo:") ||
      key.startsWith("review:") ||
      key.startsWith("support:") ||
      key.startsWith("lifecycle:") ||
      key.startsWith("project:") ||
      key.startsWith("inbox:") ||
      key.startsWith("person:")
    )
      return !expanded.has(`collapsed:${key}`);
    return expanded.has(key);
  };

  // Collapsible bands are open by default, so — like
  // repo groups — their *collapsed* state is what's persisted. Collapsing one
  // hides every group within that band. Searching forces them open.
  const bandOpen = (band: GroupBand | "workspaces") =>
    search.trim().length > 0 ? true : !expanded.has(`collapsed:band:${band}`);
  // A borrowed sidebar is its workspaces list: the tools are gone and the
  // heading is the strip that gets you back out, so there is no caption left
  // to click and nothing to leave behind if the band stayed collapsed. Your
  // own collapse comes back with your own sidebar.
  const workspacesOpen = bandOpen("workspaces") || borrowedLens;
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
    let list = items;
    const q = search.trim().toLowerCase();
    if (q)
      list = list.filter((i) =>
        [
          i.title,
          i.preview,
          ...(feed.searchMeta || []).map((p) => dget(i.meta, p)),
        ].some((v) => typeof v === "string" && v.toLowerCase().includes(q)),
      );
    const vals = feedFilters[feed.id] || {};
    for (const spec of feed.filters || []) {
      if (spec.mode !== "meta") continue;
      const sel = vals[spec.key];
      if (!sel) continue;
      list = list.filter((i) => {
        const v = dget(i.meta, spec.field);
        if (v == null || (Array.isArray(v) && v.length === 0))
          return sel === "__unassigned__";
        const els = Array.isArray(v) ? v : [v];
        return els.some(
          (el) => String(dget(el, spec.optionsFromItems?.value) ?? el) === sel,
        );
      });
    }
    if (vals.__session === "with")
      list = list.filter((i) => !!sessionForItem(feed, i));
    else if (vals.__session === "without")
      list = list.filter((i) => !sessionForItem(feed, i));
    return list;
  }
  const automationsOpen = bandOpen("automations");
  const peopleOpen = bandOpen("people");
  function toggleBand(band: GroupBand | "tools" | "workspaces") {
    const key = `collapsed:band:${band}`;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  // The rows below call `onClick()` with no arguments rather than handing the
  // reference to the button. A handler that takes an optional argument is
  // assignable to `() => void`, so wiring one straight to a DOM `onClick`
  // type-checks and then receives the click event: that is what left Reports
  // dead, because a mouse event carries `view` (the window, from UIEvent) and
  // it overwrote the route's own view.
  const tools: SidebarToolsNavItem[] = [
    {
      id: "feed",
      label: SIDEBAR_TOOL_LABELS.feed,
      icon: <IconFeed />,
      active: feedActive,
      onClick: navigation.openFeed,
      title: "What the team has been shipping",
    },
    {
      id: "prs",
      label: SIDEBAR_TOOL_LABELS.prs,
      icon: <IconPullRequest className="translate-x-px -translate-y-px" />,
      active: prsActive,
      onClick: navigation.openPrs,
      title: "Pull request worktrees",
    },
    {
      id: "tasks",
      label: SIDEBAR_TOOL_LABELS.tasks,
      icon: <IconListCircles />,
      active: tasksActive,
      onClick: navigation.openTasks,
      title: "Your open tasks",
      count: taskCount,
    },
    {
      id: "plain",
      label: SIDEBAR_TOOL_LABELS.plain,
      icon: <IconMail />,
      active: plainActive,
      onClick: navigation.openPlain,
      title: "Support tickets waiting in Plain",
    },
    {
      id: "catchup",
      label: SIDEBAR_TOOL_LABELS.catchup,
      icon: <IconStack />,
      active: catchUpActive,
      onClick: navigation.openCatchUp,
      title: "Swipe through your unread workspaces",
      count: catchUpCount,
    },
    {
      id: "supporttinder",
      label: SIDEBAR_TOOL_LABELS.supporttinder,
      icon: <IconInbox />,
      active: supportTinderActive,
      onClick: navigation.openSupportTinder,
      title: "Swipe through the Plain Todo queue",
    },
    {
      id: "reports",
      label: SIDEBAR_TOOL_LABELS.reports,
      icon: <IconFile />,
      active: reportsActive,
      // Called with no target: the row opens the list of reports, while an
      // automation's own report row below passes the one it names.
      onClick: () => navigation.openReports(),
      title: "Recurring automation reports",
    },
    {
      id: "analytics",
      label: SIDEBAR_TOOL_LABELS.analytics,
      icon: <IconChart />,
      active: analyticsActive,
      onClick: navigation.openAnalytics,
      title: "Sessions, tokens, models & PRs over time",
    },
  ];
  // Tools this width offers at all — the switches below only choose among
  // these, so a tool that doesn't fit the viewport is never listed as off.
  const viewportTools = tools.filter((tool) =>
    toolFitsViewport(tool.id, isPhone),
  );
  const fittingTools = mergeSidebarToolOrder(
    toolOrder,
    viewportTools.map((tool) => tool.id),
  ).flatMap((id) => {
    const tool = viewportTools.find((candidate) => candidate.id === id);
    return tool ? [tool] : [];
  });
  // None of the tools belong to the person whose sidebar you are borrowing:
  // Tasks and Catch up are yours, and Feed, Pull requests and Analytics are
  // the whole team's. Under a heading with someone else's name on it they
  // read as theirs, so a borrowed sidebar is their workspaces and nothing
  // else. Another teammate, or your own sidebar back, is a click away in
  // "Group, filter & sort" — and the strip at the top is the way out.
  // Support is the one tool whose visibility is not its own: it and the Plain
  // band are two doors onto one queue, and both at once would list the same
  // tickets twice. The tool wins when the independent stored lists say both,
  // because it is the default placement and the band is the alternate.
  const supportSurface = supportSurfaceOf(
    !hiddenTools.has(PLAIN_ID),
    !hiddenFeeds.has(PLAIN_ID),
  );
  const visibleTools = borrowedLens
    ? []
    : fittingTools.filter(
        (tool) =>
          !hiddenTools.has(tool.id) &&
          !(productEmpty && tool.id === "prs") &&
          !(tool.id === PLAIN_ID && supportSurface !== "page"),
      );

  const setToolVisible = setSidebarToolVisible;

  // What the sidebar's own right-click menu offers (SidebarToolsMenu): every
  // tool and every source, ticked when it's showing.
  //
  // Support is the exception, and the reason that menu is a real one: where
  // the others tick on or off, it names which of two surfaces its queue lives
  // on, so it is a submenu of three states rather than a tick. No Plain feed
  // means no queue to place, so the row drops out entirely.
  const plainQueueExists = feeds.some((feed) => feed.id === PLAIN_ID);
  const sidebarMenuTools = fittingTools
    .filter((tool) => tool.id !== PLAIN_ID || plainQueueExists)
    .map((tool) => ({
      id: tool.id,
      label: tool.label,
      icon: tool.icon,
      shown: !hiddenTools.has(tool.id),
      ...(tool.id === PLAIN_ID ? { surface: supportSurface } : {}),
    }));
  const sidebarMenuSources = feeds
    .filter((feed) => feed.id !== PLAIN_ID)
    .map((feed) => ({
      id: feed.id,
      label: feed.title,
      icon: <RepoTile name={feed.id} className={SIDEBAR_REPO_TILE} />,
      shown: !hiddenFeeds.has(feed.id),
    }));

  // Archived is a destination, not another live workspace group. Keeping it to
  // one row means the sidebar never needs the archive index or its inline rows.
  // The shared rail centres its 20px glyph on the same line as the 18px repo tiles.
  const archivedLink = (
    <button
      className={cn(
        SIDEBAR_GROUP_HEADER,
        SIDEBAR_GROUP_HEADER_INSET,
        SIDEBAR_HEADER_ROW,
        // The one heading that navigates, so the one heading that paints a
        // fill. Its neighbours in the rail collapse a group instead and
        // deliberately take none. See the two signals in sidebar-classes.ts.
        SIDEBAR_HOVER_LAYER,
        "transition-colors",
        archivedActive && "bg-selected text-fg",
      )}
      data-selected={archivedActive || undefined}
      onClick={navigation.openArchived}
      title="View archived sessions"
    >
      <span className={SIDEBAR_RAIL}>
        <IconArchive size={20} />
      </span>
      <span className={cn(SIDEBAR_GROUP_NAME, "font-semibold")}>Archived</span>
    </button>
  );

  // One sidebar row per workspace: status dot (most urgent session), name, session
  // count, unread dot. Click opens the first session (or the workspace itself for
  // real workspaces — App resolves that to its first session / scoped New palette).
  // Right-click opens the workspace menu (pin / color / rename / delete);
  // double-click renames inline.
  function renderWsRow(row: WsRow) {
    return renderWsRowImpl(row, false);
  }

  // The "Needs review" band's rows: identical in every way except that a click
  // opens the workspace's Review tab (see openWsRow).
  function renderReviewWsRow(row: WsRow) {
    return renderWsRowImpl(row, false, true);
  }

  // Pinned is the row's visible placement while it is pinned. Its children stay
  // hidden here, keeping one visible subagent row per session.
  function renderPinnedWsRow(row: WsRow) {
    return renderWsRowImpl(row, false, false, false);
  }

  // `inbox` renders the Inbox-mode variant of the same row — a repo tile in
  // front of the title, idle timestamp on every row — with identical behavior
  // (click, swipe, context menu, pin, archive).
  // Separate impl rather than an optional param because `.map(renderWsRow)`
  // callers would pass the array index into it.
  //
  // `review` marks a row under the "Needs review" band, whose click opens the
  // Review tab instead of the session.
  function renderWsRowImpl(
    row: WsRow,
    inbox: boolean,
    review = false,
    includeSubagents = true,
  ) {
    const active = rowOwnsSelection(row);
    const editing = rowRenameEditing(row);
    const hasQuestion = row.sessions.some((session) => session.waitingForInput);
    const failed = !hasQuestion && !!workspaceRunNeedingAttention(row.sessions);
    // A manually pinned Needs input lane remains blue, but a failed top-level
    // run gets its own red marker rather than masquerading as a question.
    const waiting = !failed && row.status === "needsinput";
    // A review GitHub is still asking you for. Blocked on you, like an
    // unanswered question, so it wears the same blue mark — and it wears it in
    // every band, not only under Needs review, because the whole point is that
    // you can see you were asked without opening anything.
    const needsMyReview = wsPrRequestsReviewFrom(row, mePersonKey);
    // Who is waiting. Covers the Reviewer picker's request as well as the
    // GitHub one: "somebody is waiting on you" is a poor prompt to act on
    // until you know which somebody.
    const reviewAsker = reviewAskerFor(row, currentUser);
    // The "in progress" ticker start: the earliest running session's start, so a
    // workspace with several live sessions shows how long it's been busy overall.
    // Done/idle sessions don't count — only sessions actually running feed the clock.
    // Prefer the server's runStartedAt (survives refresh); fall back to the
    // first moment we saw this row running. Pruned when the row goes idle.
    let runStartMs: number | null = null;
    if (row.running) {
      const stamps = row.sessions
        .filter((c) => c.isRunning && c.runStartedAt)
        .map((c) => Date.parse(c.runStartedAt!))
        .filter((n) => !Number.isNaN(n));
      if (stamps.length) runStartMs = Math.min(...stamps);
      else runStartMs = runStartSeen.get(row.key) ?? null;
    }
    // The yellow duration is a live status, not a sort key. Stable creation
    // ordering makes that distinction honest without taking the useful timer
    // away from Inbox and Project layouts.
    const showRunDuration = runStartMs !== null;
    const snoozed = rowIsSnoozed(row);
    const swipeOffset =
      isPhone && wsSwipe?.key === row.key ? wsSwipe.offset : 0;
    const swipeAction =
      isPhone && wsSwipe?.key === row.key ? wsSwipe.action : null;
    const draggingRow = wsDraggingKey === row.key;
    // Which underlay to show: the in-flight drag reveals its side via
    // wsDragSide (per-frame offsets live only in the DOM now), an open or
    // committing row falls back to the reconciled wsSwipe state.
    const swipeSide: SwipeAction | null = draggingRow
      ? wsDragSide
      : swipeAction === "archive" || swipeOffset < 0
        ? "archive"
        : swipeAction === "star" || swipeOffset > 0
          ? "star"
          : null;
    const rowPin = workspacePinState(row);
    const pinned = rowPin.pinned;
    const toggleRowPin = rowPin.toggle;
    const claimed = row.sessions.some((session) => isClaimed(session));
    const naturallyInSidebar = row.sessions.some(
      (session) =>
        !session.spawnedBy &&
        !session.automation &&
        ownedBy(session, currentUser),
    );
    const canKeepInSidebar =
      row.sessions.length > 0 && !claimed && !naturallyInSidebar;
    // Active snooze → the row wears a wake countdown instead of the idle time.
    const snoozeIso = activeSnoozeKeys.has(row.key)
      ? (snoozes[row.key] ?? null)
      : null;
    // Scratch workspaces are the one group with no heading over them (they
    // have no project, and they sit above the bands rather than in one), so
    // their rows carry a full status mark instead of the plain dot.
    const noSectionHeading = rowIsScratch(row);
    const subagents = includeSubagents
      ? subagentsForSelectedWorkspace(
          subagentsByWorkspaceId,
          row.workspace?.id,
          selectedWorkspaceId,
        )
      : [];
    const workspaceRow = (
      <div
        key={row.key}
        className={SIDEBAR_SWIPE_ROW}
        data-swipe-row=""
        style={
          swipeOffset
            ? ({
                "--swipe-action-w": `${Math.max(
                  SWIPE_REVEAL_PX,
                  Math.abs(swipeOffset),
                )}px`,
              } as React.CSSProperties)
            : undefined
        }
      >
        {isPhone && row.sessions.length > 0 && (
          <button
            className={cn(
              SIDEBAR_SWIPE_ACTION,
              SIDEBAR_SWIPE_ACTION_ARCHIVE,
              swipeSide === "archive" && SIDEBAR_SWIPE_ACTION_OPEN,
              draggingRow ? "transition-none" : SIDEBAR_SWIPE_ACTION_TRANSITION,
            )}
            data-swipe-action="archive"
            onClick={(e) => {
              e.stopPropagation();
              setWsSwipe(null);
              archiveWorkspaceWithNext(row);
            }}
            title="Archive workspace"
          >
            <IconArchive size={22} />
            <span>Archive</span>
          </button>
        )}
        {/* A draft row's left swipe deletes instead: it has no session
				    lifecycle yet, and the confirm-on-delete elsewhere (right-click,
				    long-press sheet) would defeat the point of a swipe. */}
        {isPhone && isDraftWsRow(row) && (
          <button
            className={cn(
              SIDEBAR_SWIPE_ACTION,
              SIDEBAR_SWIPE_ACTION_ARCHIVE,
              swipeSide === "archive" && SIDEBAR_SWIPE_ACTION_OPEN,
              draggingRow ? "transition-none" : SIDEBAR_SWIPE_ACTION_TRANSITION,
            )}
            data-swipe-action="delete"
            onClick={(e) => {
              e.stopPropagation();
              setWsSwipe(null);
              deleteDraftWsRow(row);
            }}
            title="Delete draft"
          >
            <IconTrash size={22} />
            <span>Delete</span>
          </button>
        )}
        {isPhone && (
          <button
            className={cn(
              SIDEBAR_SWIPE_ACTION,
              pinned ? SIDEBAR_SWIPE_ACTION_STAR_ON : SIDEBAR_SWIPE_ACTION_STAR,
              swipeSide === "star" && SIDEBAR_SWIPE_ACTION_OPEN,
              draggingRow ? "transition-none" : SIDEBAR_SWIPE_ACTION_TRANSITION,
            )}
            data-swipe-action="star"
            onClick={(e) => {
              e.stopPropagation();
              setWsSwipe(null);
              toggleRowPin();
            }}
            title={pinned ? "Unpin workspace" : "Pin workspace"}
          >
            <IconPin size={22} fill={pinned ? "currentColor" : "none"} />
            <span>{pinned ? "Unpin" : "Pin"}</span>
          </button>
        )}
        <button
          className={cn(
            SIDEBAR_ROW,
            // Inside a swipe row: the wrapper carries the 2px gap and the
            // row carries the slide. The drag writes --swipe-x straight onto
            // the node, so the transform reads it rather than a React style.
            SIDEBAR_WS_ROW,
            // The reserve follows the chips that actually appear. Keep sits
            // rightmost after Archive, adding one chip; an unpinned row without
            // it still reveals only Snooze + Archive.
            pinned && canKeepInSidebar
              ? "hover:pr-[128px]"
              : !pinned && !canKeepInSidebar
                ? "hover:pr-[68px]"
                : null,
            "z-1 mt-0 touch-pan-y transform-[translateX(var(--swipe-x,0))]",
            SIDEBAR_HOVER_LAYER,
            // "Needs you" paints no fill of its own: it is a question
            // waiting, not a failure, and the row's one background slot
            // belongs to selection. The blue mark in the rail and the bold
            // title carry it — same as the native app.
            active && "bg-selected",
            draggingRow
              ? "transition-none"
              : swipeSide
                ? "transition-transform duration-(--dur-micro)"
                : "transition-transform duration-(--dur)",
            (draggingRow || swipeSide) && "will-change-transform",
          )}
          data-sidebar-row=""
          data-ws-row=""
          data-sidebar-item-key={`workspace:${row.key}`}
          data-selected={active || undefined}
          data-waiting={waiting || undefined}
          data-running={row.running || undefined}
          data-unread={row.unread || undefined}
          data-finished-unread={
            shouldEmphasizeUnread(row.unread, row.running) || undefined
          }
          style={
            swipeOffset
              ? ({ "--swipe-x": `${swipeOffset}px` } as React.CSSProperties)
              : undefined
          }
          onClick={(e) => {
            // Touch taps open from touchend (their ghost click is
            // preventDefault'd), so this is the mouse/desktop path. Still
            // swallow a click that ends a long-press, belt-and-suspenders.
            if (wsLongPressed.current) {
              wsLongPressed.current = false;
              e.preventDefault();
              return;
            }
            if (editing) return;
            // Keyboard activation has no mousedown. Give it the same immediate
            // selection feedback before the route render reconciles the sidebar.
            previewSidebarSelection(sidebarScrollRef.current, e.currentTarget);
            openWsRow(row, review);
          }}
          onMouseEnter={(e) => wsRowHoverEnter(row, e.currentTarget)}
          onMouseLeave={scheduleWsHoverClose}
          onMouseDown={(e) => {
            closeWsHover();
            if (e.button === 0 && !editing)
              previewSidebarSelection(
                sidebarScrollRef.current,
                e.currentTarget,
              );
          }}
          onTouchStart={(e) => wsRowTouchStart(row, e)}
          onTouchMove={(e) => wsRowTouchMove(row, e)}
          onTouchEnd={(e) => wsRowTouchEnd(row, e, review)}
          onTouchCancel={(e) => {
            clearWsPress();
            wsSwipeOrigin.current = null;
            wsSwiping.current = false;
            setWsDraggingKey(null);
            setWsDragSide(null);
            const rowEl = e.currentTarget as HTMLElement;
            rowEl.style.removeProperty("--swipe-x");
            rowEl.parentElement?.style.removeProperty("--swipe-action-w");
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            // The sidebar's background carries a menu of its own, so this
            // row's has to claim the event rather than let both open.
            e.stopPropagation();
            // On touch this is the long-press callout: our long-press already
            // opened the menu, so don't stack a second one (or the native
            // text-selection callout) on top of it.
            if (wsLongPressed.current || wsPressOrigin.current) return;
            closeWsHover();
            setWorkspaceMenu({
              id: row.workspace ? row.workspace.id : row.key,
              x: e.clientX,
              y: e.clientY,
              source: e.currentTarget,
            });
          }}
          // The button's label replaces its content for assistive tech, so
          // the blocked state — now carried visually by the row's wash —
          // rides here rather than on a marker element.
          aria-label={
            failed
              ? `${row.name}, last run failed`
              : waiting
                ? `${row.name}, needs your attention`
                : needsMyReview
                  ? `${row.name}, needs your review`
                  : row.name
          }
        >
          {/* A question or requested review is blue. A stopped run is red, so
				    the marker states what happened instead of implying a reply exists. */}
          <span className={SIDEBAR_RAIL}>
            {waiting || needsMyReview ? (
              <span
                className={`size-2 shrink-0 rounded-full ${SIDEBAR_STATUS_DOT.waiting}`}
              />
            ) : failed ? (
              <span
                className={`size-2 shrink-0 rounded-full ${SIDEBAR_STATUS_DOT.failed}`}
              />
            ) : noSectionHeading ? (
              <WsStatusMark row={row} size={18} />
            ) : row.running ? (
              <span
                className={`size-2 shrink-0 rounded-full ${SIDEBAR_STATUS_DOT.running}`}
              />
            ) : (
              <WsPrStatusMark
                sessions={row.sessions}
                size={18}
                workspace={row.workspace}
                shipsDirectlyToMain={rowShipsDirectlyToMain(row)}
              />
            )}
          </span>
          {/* Inbox rows name their repo with the tile alone, in front of the
				    title — the repo/branch meta line it replaces cost a second line
				    per row for two words most of the list repeats. */}
          {inbox && !editing && !rowIsScratch(row) && (
            <RepoTile name={wsRowRepo(row)} size={14} />
          )}
          {editing ? (
            <input
              className="min-w-0 flex-1 rounded-md border border-[var(--accent,#6b8afd)] bg-bg px-[3px] text-body font-medium text-inherit outline-none desktop:text-item-title"
              value={row.workspace ? workspaceDraft : sessionDraft}
              autoFocus
              onChange={(e) =>
                row.workspace
                  ? setWorkspaceDraft(e.target.value)
                  : setSessionDraft(e.target.value)
              }
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onBlur={() =>
                row.workspace
                  ? commitWorkspaceRename()
                  : commitSessionRename(row.sessions[0])
              }
              onKeyDown={(e) => {
                if (e.key === "Enter")
                  row.workspace
                    ? commitWorkspaceRename()
                    : commitSessionRename(row.sessions[0]);
                else if (e.key === "Escape")
                  row.workspace
                    ? setEditingWorkspaceId(null)
                    : setEditingSessionId(null);
                e.stopPropagation();
              }}
            />
          ) : (
            <span
              // Same class as a session row's title, so workspace rows pick up
              // the shared type scale (incl. the phone bump) and the
              // selected/waiting/unread emphasis from the row's data attributes.
              // Unread only gains weight after the aggregate run has finished.
              className={SIDEBAR_ROW_TITLE}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (row.workspace) {
                  setWorkspaceDraft(row.workspace.name);
                  setEditingWorkspaceId(row.workspace.id);
                } else if (row.sessions[0]) {
                  // Solo session rows rename the session itself.
                  startSessionRename(row.sessions[0]);
                }
              }}
            >
              {stripPrTitlePrefix(row.name)}
            </span>
          )}
          {/* Machine origin stays passive beside the title. Keep belongs with
				    the row's other actions at the right edge. */}
          {!editing && rowWasAgentStarted(row) && <AutoCreatedMark />}
          {/* Where the work came from, when the whole row came from one place:
				    a Slack thread, a Linear issue. Same slot and ink as the mark
				    above (SidebarItem carries the session-row half). */}
          {!editing && <OriginMark source={rowOriginSource(row)} />}
          {row.mention &&
            !editing && (
              // Same badge as a session row (SidebarItem): the face of whoever
              // tagged you, with an accent @ so it can't read as a viewer.
              // Clicking it jumps to the member session the mention lives on —
              // the row's own click can open a different sibling, and opening
              // the exact session is what clears the badge (lib/mentions.ts).
              <span
                className="relative ml-1 flex shrink-0 cursor-pointer items-center"
                title={`${row.mention} mentioned you — open`}
                aria-label={`${row.mention} mentioned you — open`}
                onClick={
                  row.mentionSessionId
                    ? (e) => {
                        e.stopPropagation();
                        if (wsLongPressed.current) return;
                        const target = row.mentionSessionId;
                        if (!target) return;
                        if (row.workspace)
                          navigation.openWorkspace(row.workspace.id, target);
                        else navigation.openSession(target);
                      }
                    : undefined
                }
              >
                <UserAvatar name={row.mention} size={16} className="shrink-0" />
                <span
                  aria-hidden="true"
                  className="absolute -right-1 -bottom-1 flex size-3 items-center justify-center rounded-full bg-accent text-[8px] font-bold leading-none text-on-accent ring-2 ring-panel"
                >
                  @
                </span>
              </span>
            )}
          {reviewAsker && !editing && <ReviewAskerFace asker={reviewAsker} />}
          {/* Teammates currently focused on a session in this workspace. */}
          {!editing &&
            (() => {
              const viewers = otherViewers(
                teamViewing
                  .filter((v) =>
                    row.sessions.some((session) => session.id === v.sessionId),
                  )
                  .map((v) => v.user),
                currentUser,
              );
              if (!viewers.length) return null;
              return (
                <span
                  className={SIDEBAR_WS_FACES}
                  aria-label={`Viewing: ${viewers.join(", ")}`}
                >
                  {viewers.slice(0, 3).map((viewer, index, shown) => (
                    <UserAvatar
                      key={viewer}
                      name={viewer}
                      size={16}
                      className={SIDEBAR_WS_FACE}
                      style={facepileAvatarStyle(
                        index,
                        shown.length,
                        "var(--sidebar-face-ring)",
                      )}
                      title={`${viewer} is here`}
                    />
                  ))}
                </span>
              );
            })()}
          {/* The yellow timer is live status in every layout. It no longer
				    competes with a moving activity sort because Active is creation-stable. */}
          {showRunDuration && runStartMs !== null && (
            <RunTicker startMs={runStartMs} />
          )}
          {snoozeIso &&
            !editing && (
              // A ticker ahead of it has already pushed the cluster right; a
              // second auto margin would split the free space between them.
              <SnoozeBadge
                until={snoozeIso}
                className={showRunDuration ? "ml-1.5" : undefined}
              />
            )}
          {/* The optional last-used preference remains useful context, but it is
				    no longer the Active list's sort key. A running row gives this slot
				    to its yellow duration instead. */}
          {(inbox || groupsByRepo || !row.workspace) &&
            !snoozeIso &&
            wsTimePref !== "off" &&
            row.lastActivity && (
              <span
                className={cn(
                  SIDEBAR_WS_TIME,
                  wsTimePref === "hover" && SIDEBAR_WS_TIME_HOVER,
                  // The "hover" mode (the default) shows the badge only under
                  // the pointer. On touch there is no hover, so it shows inline
                  // like "always". A running row keeps its duration instead.
                  showRunDuration && "hidden",
                  wsTimePref === "hover" &&
                    !showRunDuration &&
                    "[@media(hover:none)]:inline-flex",
                )}
                data-ws-time=""
                aria-label={new Date(row.lastActivity).toLocaleString()}
              >
                {shortTime(row.lastActivity)}
              </span>
            )}
          {/* Slack-style pencil: a session here holds an unsent draft — come back
				    and finish it. Yields to the hover actions like the count/time. */}
          <WorkspaceDraftIndicator
            sessionIdsKey={row.sessions.map((session) => session.id).join("\0")}
            pushed={showRunDuration || Boolean(snoozeIso)}
          />
          {/* Hover actions stay in one predictable order: Pin, Snooze, Archive, Keep. */}
          <span
            className={cn(
              SIDEBAR_WS_ACTIONS,
              // A revealed swipe action owns the row's right edge, so the
              // hover cluster stays out of it entirely rather than being
              // hidden again by a more specific rule further down the sheet.
              swipeSide ? "hidden" : SIDEBAR_WS_ACTIONS_HOVER,
            )}
            data-ws-actions=""
          >
            {/* Pin is not one of the row's standing actions: an unpinned row
					    offers snooze and archive, the two moves you make constantly,
					    and pinning stays in the context menu, the ⌘P chord and the
					    swipe. Once a row IS pinned the chip comes back, because
					    unpinning has to be reachable from the thing it marks. */}
            {pinned && (
              <Tooltip
                label="Unpin workspace"
                // Only on the row the chord would actually hit: ⌘P pins the
                // workspace holding the OPEN session, so advertising it on
                // every row would promise a key that lands elsewhere.
                shortcut={active ? (pinShortcutKeys ?? undefined) : undefined}
              >
                <span
                  role="button"
                  tabIndex={0}
                  // One colour, picked here rather than stacking two `text-*`
                  // utilities, whose winner would be Tailwind's ordering: a
                  // pinned action keeps its accent under the pointer.
                  className={cn(SIDEBAR_WS_ACTION, "text-accent")}
                  aria-label="Unpin workspace"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleRowPin();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation();
                      toggleRowPin();
                    }
                  }}
                >
                  <IconPin size={19} fill="currentColor" />
                </span>
              </Tooltip>
            )}
            {row.sessions.length > 0 ? (
              <>
                <Tooltip
                  label={
                    snoozed
                      ? "Unsnooze workspace"
                      : "Snooze workspace until Someday"
                  }
                >
                  <span
                    role="button"
                    tabIndex={0}
                    className={cn(
                      SIDEBAR_WS_ACTION,
                      "text-faint hover:text-fg",
                    )}
                    aria-label={
                      snoozed ? "Unsnooze workspace" : "Snooze workspace"
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleWorkspaceSnooze(row);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        toggleWorkspaceSnooze(row);
                      }
                    }}
                  >
                    <IconMoon size={19} />
                  </span>
                </Tooltip>
                <Tooltip
                  label="Archive workspace"
                  shortcut={
                    active ? (archiveShortcutKeys ?? undefined) : undefined
                  }
                >
                  <span
                    role="button"
                    tabIndex={0}
                    className={cn(
                      SIDEBAR_WS_ACTION,
                      "text-faint hover:text-fg",
                    )}
                    aria-label="Archive workspace"
                    onClick={(e) => {
                      e.stopPropagation();
                      archiveWorkspaceWithNext(
                        row,
                        e.currentTarget.closest<HTMLButtonElement>(
                          "button[data-sidebar-row]",
                        ),
                      );
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        archiveWorkspaceWithNext(
                          row,
                          e.currentTarget.closest<HTMLButtonElement>(
                            "button[data-sidebar-row]",
                          ),
                        );
                      }
                    }}
                  >
                    <IconArchive size={19} />
                  </span>
                </Tooltip>
              </>
            ) : row.workspace?.draft ? (
              <Tooltip label="Delete draft">
                <span
                  role="button"
                  tabIndex={0}
                  className={cn(SIDEBAR_WS_ACTION, "text-faint hover:text-red")}
                  aria-label="Delete draft"
                  onClick={(e) => {
                    e.stopPropagation();
                    confirmDeleteDraft(() => deleteDraftWsRow(row));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation();
                      confirmDeleteDraft(() => deleteDraftWsRow(row));
                    }
                  }}
                >
                  <IconTrash size={19} />
                </span>
              </Tooltip>
            ) : null}
            {canKeepInSidebar && (
              <KeepInSidebarMark
                className={SIDEBAR_WS_ACTION}
                onKeep={() => onSetStatus(row.sessions, "mine")}
              />
            )}
          </span>
        </button>
      </div>
    );
    return (
      <React.Fragment key={row.key}>
        {workspaceRow}
        <SubagentRows
          items={subagents}
          selectedId={selectedId}
          onSelect={openSidebarSession}
          onArchive={(session) => onArchive(session, null)}
        />
      </React.Fragment>
    );
  }

  // Quick "mark done" straight from a Support row — optimistic removal (the
  // ticket leaves Plain's Todo queue), restored by a refetch if Plain says no.
  async function markSupportRowDone(threadId: string) {
    setFeedItems((prev) => ({
      ...prev,
      plain: (prev.plain || []).filter((x) => x.id !== threadId),
    }));
    try {
      await setPlainThreadStatusApi(threadId, "done", { user: currentUser });
    } catch {
      try {
        const items = await fetchFeedItems("plain");
        setFeedItems((prev) => ({ ...prev, plain: items }));
      } catch {
        // The scheduled feed refresh will reconcile the optimistic removal.
      }
    }
  }

  // A Support row: one TODO Plain ticket. The dot wears the linked session's
  // status (faint when no session exists yet); click opens the session, or the
  // session-less ticket preview when there isn't one. Hovering reveals the
  // one-click "mark done" button at the row's right edge.
  function supportThreadActive(t: SupportThread) {
    // The ticket's workspace is open (session-less route or one of its sessions)…
    if (selectedWorkspaceId) {
      const ws = workspaces.find((p) => p.id === selectedWorkspaceId);
      if (ws?.plainThreadId === t.id) return true;
    }
    // …or its linked session is the open session (pre-workspace sessions).
    const session = supportSessionByThread.get(t.id);
    return !!session && session.id === selectedId;
  }

  // A Support row in the workspace rows' shape — see SupportRow for the
  // markup; this binds it to the sidebar's state and handlers.
  function renderSupportRow(t: SupportThread) {
    const pinKey = `support:${t.id}`;
    const linked = supportSessionByThread.get(t.id) || null;
    return (
      <SupportRow
        key={pinKey}
        thread={t}
        session={linked}
        active={supportThreadActive(t)}
        pinned={pins.includes(pinKey)}
        onTogglePin={() => togglePinKey(pinKey)}
        onOpen={() => navigation.openTicket(t)}
        onMarkDone={() => markSupportRowDone(t.id)}
        onSetStatus={
          linked ? (status) => onSetStatus([linked], status) : undefined
        }
      />
    );
  }

  // The repo band a workspace row files under. The workspace's own repo wins:
  // it's what the work is *about*, while a session's repo is only the checkout it
  // happens to run from: a PR workspace for one repo whose session runs in
  // another repo's worktree files under the repo it is about. A workspace spanning
  // repos still files under one band (a row in two bands double-counts and
  // reads as two pieces of work); the repo *filter* honours every repo it
  // touches, so it stays findable from the others.
  function wsRowRepo(row: WsRow): string {
    return (
      row.workspace?.repo ||
      row.workspace?.externalRefs?.[0]?.kind ||
      row.sessions[0]?.repo ||
      sessionRepo(row.sessions[0] || ({} as UnifiedSession))
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
  function renderSnoozedGroup(rows: WsRow[], ns = "", nested = false) {
    const gkey = `${ns}status:snoozed`;
    const open = isOpen(gkey);
    return (
      <div className={SIDEBAR_STATUS_GROUP} data-status-group key={gkey}>
        <button
          className={cn(
            SIDEBAR_GROUP_HEADER,
            SIDEBAR_GROUP_HEADER_INSET,
            SIDEBAR_LANE_HEADER,
            "transition-colors",
            SIDEBAR_STICKY_LANE,
            nested && SIDEBAR_STICKY_LANE_NESTED,
            SIDEBAR_STUCK_BACKING,
          )}
          data-sticky-head
          onClick={() => toggleGroup(gkey)}
        >
          <span className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME)}>
            Snoozed
          </span>
          <span className={SIDEBAR_LANE_COUNT}>{rows.length}</span>
          <IconChevronDown
            className={cn(
              SIDEBAR_GROUP_CHEVRON,
              !open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
            )}
            size={12}
            style={{ transform: open ? "none" : "rotate(-90deg)" }}
          />
        </button>
        {rows.filter((r) => open || rowOwnsSelection(r)).map(renderWsRow)}
      </div>
    );
  }

  // A labeled flat lane: a caption, a count, its rows. The review lanes
  // (Needs review, Approved, Awaiting review). Under a repo
  // grouping each one rides inside its project's band, beside that project's
  // status lanes, rather than stacked above every band, so the work sits with
  // the rest of the project it belongs to. The repo-less groupings have no
  // band to nest in, so there the same lane stands on its own
  // (renderLabeledBand). `ns` keeps each repo's copy collapsible on its own.
  // Needs review draws its rows with renderReviewWsRow, whose click opens the
  // Review tab, and is the only lane that also carries session-less PR rows:
  // the GitHub review requests pointed at you.
  function renderLabeledLane({
    label,
    name,
    rows,
    prs = [],
    ns = "",
    renderRow = renderWsRow,
  }: {
    label: string;
    name: string;
    rows: WsRow[];
    prs?: ReviewQueueItem[];
    ns?: string;
    renderRow?: (row: WsRow) => React.ReactNode;
  }) {
    if (rows.length === 0 && prs.length === 0) return null;
    const gkey = `${ns}${name}`;
    const open = isOpen(gkey);
    return (
      <div className={SIDEBAR_STATUS_GROUP} data-status-group key={gkey}>
        <button
          className={cn(
            SIDEBAR_GROUP_HEADER,
            SIDEBAR_GROUP_HEADER_INSET,
            SIDEBAR_LANE_HEADER,
            "transition-colors",
            SIDEBAR_STICKY_LANE,
            ns && SIDEBAR_STICKY_LANE_NESTED,
            SIDEBAR_STUCK_BACKING,
          )}
          data-sticky-head
          onClick={() => toggleGroup(gkey)}
        >
          <span className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME)}>
            {label}
          </span>
          <span className={SIDEBAR_LANE_COUNT}>{rows.length + prs.length}</span>
          <IconChevronDown
            className={cn(
              SIDEBAR_GROUP_CHEVRON,
              !open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
            )}
            size={12}
            style={{ transform: open ? "none" : "rotate(-90deg)" }}
          />
        </button>
        {rows
          .filter((r) => open || rowOwnsSelection(r))
          .map((r) => renderRow(r))}
        {prs.filter((i) => open || prRowSelected(i)).map(renderPrRow)}
      </div>
    );
  }

  // The same lane standing on its own above the project bands: the shape the
  // repo-less groupings use, and what holds the rows no band can (topBandRows).
  // Renders nothing when empty, so a group's gap never opens on an absent band.
  function renderLabeledBand(params: Parameters<typeof renderLabeledLane>[0]) {
    const lane = renderLabeledLane(params);
    return lane && <div className={SIDEBAR_GROUP}>{lane}</div>;
  }

  // The Conductor-style status lanes (Needs input / In progress / …) over a set
  // of workspace rows. `ns` keeps each repo's lane collapse state independent.
  // `snoozedRows` (when given) render as a Snoozed group slotted just above
  // the final Backlog lane: the quiet zone, per the T3-style snooze design.
  function renderStatusLanes(
    rows: WsRow[],
    ns = "",
    snoozedRows?: WsRow[],
    laneRepo?: string,
    prItems: ReviewQueueItem[] = [],
  ) {
    // While an eligible Pinned row is mid-drag these lanes double as drop
    // targets: per-repo lanes only for the row's own repo, and empty lanes
    // materialize (dimmed) so every status can take the drop.
    const dropEligible =
      !!pinDragMeta &&
      pinDragMeta.sessions.length > 0 &&
      (!laneRepo || laneRepo === pinDragMeta.repo);
    const lanes = MINE_STATUS_META.map((meta) => {
      const items = rows.filter((r) => r.status === meta.key);
      // Session-less PR rows share the lanes since the PR-band dissolution.
      const prs = prItems.filter((i) => prItemLane(i) === meta.key);
      if (items.length === 0 && prs.length === 0 && !dropEligible) return null;
      const gkey = `${ns}status:${meta.key}`;
      const open = isOpen(gkey);
      const dropHover = dropEligible && laneDropHover?.gkey === gkey;
      return (
        <div
          className={cn(
            SIDEBAR_STATUS_GROUP,
            dropEligible &&
              items.length === 0 &&
              prs.length === 0 &&
              SIDEBAR_LANE_EMPTY,
            dropHover && SIDEBAR_LANE_DROP_HOVER,
          )}
          data-status-group
          key={gkey}
          data-lane-drop={dropEligible ? gkey : undefined}
          data-lane-status={dropEligible ? meta.key : undefined}
          data-lane-repo={dropEligible && laneRepo ? laneRepo : undefined}
        >
          <button
            className={cn(
              SIDEBAR_GROUP_HEADER,
              SIDEBAR_GROUP_HEADER_INSET,
              SIDEBAR_LANE_HEADER,
              "transition-colors",
              SIDEBAR_STICKY_LANE,
              !!laneRepo && SIDEBAR_STICKY_LANE_NESTED,
              SIDEBAR_STUCK_BACKING,
            )}
            data-sticky-head
            onClick={() => toggleGroup(gkey)}
          >
            <span className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME)}>
              {meta.label}
            </span>
            <span className={SIDEBAR_LANE_COUNT}>
              {items.length + prs.length}
            </span>
            <IconChevronDown
              className={cn(
                SIDEBAR_GROUP_CHEVRON,
                !open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
              )}
              size={12}
              style={{ transform: open ? "none" : "rotate(-90deg)" }}
            />
          </button>
          {items
            .filter((r) => open || rowOwnsSelection(r))
            .map((r) => renderWsRowImpl(r, false))}
          {prs.filter((i) => open || prRowSelected(i)).map(renderPrRow)}
        </div>
      );
    });
    if (snoozedRows && snoozedRows.length > 0) {
      // Snoozed slots directly after Backlog ("pending") — the quiet zone
      // sits with the parked work, ahead of Ready to merge / Done.
      lanes.splice(
        MINE_STATUS_META.findIndex((m) => m.key === "pending") + 1,
        0,
        renderSnoozedGroup(snoozedRows, ns, !!laneRepo),
      );
    }
    return lanes;
  }

  // Activity sections separate live work from idle work, then keep attention and
  // draft rows ahead of the date bands. Rows rank by activity inside each band.
  function renderInboxBands(
    rows: WsRow[],
    ns = "",
    snoozedRows: WsRow[] = [],
    prItems: ReviewQueueItem[] = [],
    nested = false,
  ) {
    const sorted = [...rows].sort((a, b) =>
      (b.lastActivity || "").localeCompare(a.lastActivity || ""),
    );
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const todayMs = dayStart.getTime();
    const yesterdayMs = todayMs - 24 * 60 * 60 * 1000;
    const bands: Array<{
      key: ActivityBand;
      label: string;
      rows: WsRow[];
      prs: ReviewQueueItem[];
    }> = [
      { key: "inprogress", label: "In progress", rows: [], prs: [] },
      { key: "needsaction", label: "Needs action", rows: [], prs: [] },
      { key: "drafts", label: "Drafts", rows: [], prs: [] },
      { key: "recent", label: "Recent", rows: [], prs: [] },
      { key: "yesterday", label: "Yesterday", rows: [], prs: [] },
      { key: "earlier", label: "Earlier", rows: [], prs: [] },
    ];
    const bandFor = (key: ActivityBand) =>
      bands.find((band) => band.key === key)!;
    for (const row of sorted) {
      const key = activityBandFor(row, todayMs, isDraftWsRow(row));
      bandFor(key).rows.push(row);
    }
    for (const item of [...prItems].sort((a, b) =>
      (b.pr.updatedAt || "").localeCompare(a.pr.updatedAt || ""),
    )) {
      const time = Date.parse(item.pr.updatedAt || "");
      if (time >= todayMs) bandFor("recent").prs.push(item);
      else if (time >= yesterdayMs) bandFor("yesterday").prs.push(item);
      else bandFor("earlier").prs.push(item);
    }
    const nodes = bands
      .filter((band) => band.rows.length > 0 || band.prs.length > 0)
      .map((band) => {
        const gkey = `${ns}inbox:${band.key}`;
        const open = isOpen(gkey);
        return (
          <div className={SIDEBAR_STATUS_GROUP} data-status-group key={gkey}>
            <button
              className={cn(
                SIDEBAR_GROUP_HEADER,
                SIDEBAR_GROUP_HEADER_INSET,
                SIDEBAR_LANE_HEADER,
                "transition-colors",
                SIDEBAR_STICKY_LANE,
                nested && SIDEBAR_STICKY_LANE_NESTED,
                SIDEBAR_STUCK_BACKING,
              )}
              data-sticky-head
              onClick={() => toggleGroup(gkey)}
            >
              <span className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME)}>
                {band.label}
              </span>
              <span className={SIDEBAR_LANE_COUNT}>
                {band.rows.length + band.prs.length}
              </span>
              <IconChevronDown
                className={cn(
                  SIDEBAR_GROUP_CHEVRON,
                  !open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
                )}
                size={12}
                style={{ transform: open ? "none" : "rotate(-90deg)" }}
              />
            </button>
            {band.rows
              .filter((row) => open || rowOwnsSelection(row))
              .map((row) => renderWsRowImpl(row, !ns))}
            {band.prs
              .filter((item) => open || prRowSelected(item))
              .map(renderPrRow)}
          </div>
        );
      });
    if (snoozedRows.length > 0)
      nodes.push(renderSnoozedGroup(snoozedRows, ns, nested));
    return nodes;
  }

  // ── Inbox Active section ───────────────────────────────────────────────
  // Snoozed uses the shared section below; Active keeps its stable creation
  // order and the same compact row density.
  function renderActiveSection(rows: WsRow[], ns = "", nested = false) {
    const label = "Active";
    if (rows.length === 0) return null;
    const gkey = `${ns}inbox:${label.toLowerCase()}`;
    const open = isOpen(gkey);
    return (
      <div className={SIDEBAR_STATUS_GROUP} data-status-group key={gkey}>
        <button
          className={cn(
            SIDEBAR_GROUP_HEADER,
            SIDEBAR_GROUP_HEADER_INSET,
            SIDEBAR_LANE_HEADER,
            "transition-colors",
            SIDEBAR_STICKY_LANE,
            nested && SIDEBAR_STICKY_LANE_NESTED,
            SIDEBAR_STUCK_BACKING,
          )}
          data-sticky-head
          onClick={() => toggleGroup(gkey)}
        >
          <span className={cn(SIDEBAR_GROUP_NAME, SIDEBAR_LANE_NAME)}>
            {label}
          </span>
          <span className={SIDEBAR_LANE_COUNT}>{rows.length}</span>
          <IconChevronDown
            className={cn(
              SIDEBAR_GROUP_CHEVRON,
              !open && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
            )}
            size={12}
            style={{ transform: open ? "none" : "rotate(-90deg)" }}
          />
        </button>
        {rows
          .filter((row) => open || rowOwnsSelection(row))
          .map((row) => renderWsRowImpl(row, !ns))}
      </div>
    );
  }

  function renderWorkspaceGrouping(
    rows: WsRow[],
    ns = "",
    snoozedRows: WsRow[] = [],
    laneRepo?: string,
    prItems: ReviewQueueItem[] = [],
  ) {
    const nested = !!laneRepo;
    if (filter.groupBy === "activity")
      return renderInboxBands(rows, ns, snoozedRows, prItems, nested);
    if (filter.groupBy === "status")
      return renderStatusLanes(rows, ns, snoozedRows, laneRepo, prItems);
    const active = sortInboxByCreation(rows);
    return [
      renderActiveSection(active, ns, nested),
      ...prItems.map(renderPrRow),
      ...(snoozedRows.length > 0
        ? [renderSnoozedGroup(snoozedRows, ns, nested)]
        : []),
    ];
  }

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
      filter.repo !== "all"
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
    <div
      // Desktop lifts this strip out of the scrollport, so it sets the rail's
      // own scales here rather than inheriting them from the scroll root. On
      // phones it is still the scroll's first child and reads the same values
      // twice, which costs nothing: they are one string either way.
      data-density={density}
      className={cn(
        "block max-w-full min-w-0 flex-none",
        SIDEBAR_DENSITY_VARS,
        SIDEBAR_NAV_X,
      )}
      style={{ order: 0 }}
    >
      {/* The tools carry no heading. "Tools" named a handful of self-evident
	    destinations (Home, Reviews, Tasks) sitting at the very top of the
	    rail, where nothing else can be confused for them, and it cost a
	    caption plus the gap around it before the first thing you can
	    click. Phones already listed them bare; desktop matches now.

	    Its two jobs moved rather than went: the collapse is gone (it hid
	    at most a few rows and a collapsed band left the top of the
	    sidebar looking empty), and the ••• menu that chose which tools
	    show is now in the right-click menu on any tool row, beside the
	    "Remove from toolbar" that already lived there. Take the last
	    tool off and the organization selector remains; the sidebar's own
	    right-click menu still lists every tool. */}
      <SidebarToolsNav
        connected={connected}
        isPhone={isPhone}
        tools={visibleTools}
        menuTools={sidebarMenuTools}
        team={team}
        personLensValue={personLensValue(filter.person, currentUser)}
        personLensName={personLensName}
        onOpenSettings={navigation.openSettings}
        onSetToolVisible={setToolVisible}
        onSetSupportSurface={setSupportSurface}
        onPickPerson={(next) =>
          setFilter({ person: personLensFilter(next, currentUser) })
        }
      />

      <div
        className={cn(
          // SIDEBAR_STICKY_BAND_ROW folds this into one fixed slot, but it is
          // desktop-gated, so on phones the raw `mt-1 pt-3` stands. With the
          // caption hidden and the chevron invisible-but-in-layout, that was a
          // near-empty band between the tool cards and the first project, which
          // read as the strip being bottom-heavy. Nothing to set off there.
          "mt-1 pb-0.5 pt-3 phone:mt-0 phone:pt-0",
          // A borrowed lens hides the tools strip, so this bar becomes the
          // first thing in the phone scroll. Give it enough air to clear the
          // floating top bar's fade instead of letting its top edge wash out.
          borrowedLens && "phone:pt-4",
          // A caption starts on the rail's 16px text column; the borrowed
          // lens's strip is a filled bar, so it takes the rows' own 8px
          // inset instead and lines up with the workspace pills under it.
          borrowedLens ? "px-2" : "px-[16px] pr-[7px]",
          SIDEBAR_STICKY_BAND,
          SIDEBAR_STICKY_BAND_ROW,
          SIDEBAR_STUCK_BACKING,
        )}
        data-sticky-head
      >
        <div
          className={cn(
            "group/wshead flex min-w-0 items-center gap-1.5 desktop:w-full",
            // In someone else's sidebar this row IS the strip: one bar that
            // names whose lanes these are, takes you back out, and carries
            // the header's own actions. The name was being said twice —
            // once by a strip above the tools, once by this heading — and
            // each said it with its own ✕.
            borrowedLens &&
              "min-h-10 w-full rounded-row bg-blue-soft pl-3 pr-1 phone:min-h-12 phone:pl-3.5 desktop:h-full desktop:min-h-0",
          )}
          ref={headRef}
        >
          {borrowedLens ? (
            <>
              {/* The bar reports the active lens. Closing it is a separate
					    action at the far edge, so the label stays visually stable and
					    the close control gets a full touch target. */}
              <div
                className="flex min-w-0 flex-1 items-center gap-2 text-sm text-fg phone:text-base"
                ref={titleRef as React.RefObject<HTMLDivElement | null>}
              >
                {filter.person === "everyone" ? (
                  <IconPeople
                    size={20}
                    className="shrink-0 translate-y-[0.5px] text-dim phone:-translate-y-px"
                  />
                ) : (
                  filter.person !== "unassigned" && (
                    <UserAvatar
                      name={personLensName}
                      size={20}
                      className="shrink-0"
                    />
                  )
                )}
                <span className="min-w-0 truncate font-semibold">
                  {filter.person === "everyone"
                    ? "Everyone"
                    : filter.person === "unassigned"
                      ? "Unassigned"
                      : personLensName}
                </span>
              </div>
              <Tooltip label="Back to your workspaces">
                <button
                  className="relative flex size-10 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-dim transition-[color,scale] before:absolute before:inset-2 before:rounded-md before:transition-colors before:content-[''] hover:text-fg hover:before:bg-hover active:scale-[0.96] phone:size-11 motion-reduce:transform-none [&>*]:relative [&>*]:z-[1]"
                  onClick={() => setFilter({ person: "me" })}
                  aria-label="Back to your workspaces"
                >
                  <IconX size={18} aria-hidden="true" />
                </button>
              </Tooltip>
            </>
          ) : (
            <button
              className={cn(
                "group/wstoggle flex min-w-0 items-center gap-[5px] [font:inherit]",
                // On phones the caption is hidden and the chevron only paints on
                // hover, so while the band is open this button is a 22px row of
                // nothing between the tool cards and the first project. That row
                // is most of what made the strip read bottom-heavy, and an
                // invisible tap target is not an affordance worth its space.
                // Collapsed it stays: the chevron IS visible then
                // (SIDEBAR_BAND_CHEVRON_COLLAPSED), and it is the only way to
                // open the band back up.
                isPhone && workspacesOpen && "hidden",
              )}
              onClick={() => toggleBand("workspaces")}
              aria-expanded={workspacesOpen}
              title={
                workspacesOpen ? "Collapse workspaces" : "Expand workspaces"
              }
            >
              {/* The heading takes the same inset every other glyphless label
				    does, so it starts on the column its repo tiles and lane
				    captions do (see
				    the band toggle). The sidebar header already reads as
				    "Workspaces" on phones, so the in-header title is redundant
				    there. */}
              <span
                className={cn(
                  // The band caption, same as SIDEBAR_BAND_LABEL wears one
                  // section down: this heading is written inline rather than
                  // composed from it only because of the strip above.
                  "shrink-0 text-label font-semibold text-dim group-hover/wshead:text-fg",
                  isPhone && "hidden",
                )}
                ref={titleRef as React.RefObject<HTMLSpanElement | null>}
              >
                Workspaces
              </span>
              <IconChevronDown
                className={cn(
                  SIDEBAR_BAND_CHEVRON,
                  "group-hover/wstoggle:visible",
                  !workspacesOpen && SIDEBAR_BAND_CHEVRON_COLLAPSED,
                )}
                size={18}
                style={{
                  transform: workspacesOpen ? "none" : "rotate(-90deg)",
                }}
              />
            </button>
          )}
          {/* Repo filter chip, inline behind the title when it fits. */}
          {filter.repo !== "all" && repoInline && (
            <RepoFilterChip
              repo={filter.repo}
              repos={repos}
              onClear={() => setFilter({ repo: "all" })}
              onSelect={(v) => setFilter({ repo: v })}
              variant="inline"
            />
          )}
          {/* The active lens label already grows to push its close control to
			    this edge. Your own sidebar still needs the flexible spacer. */}
          {!borrowedLens && <div className="min-w-0 flex-1" />}
          {/* Grouped so the pair's combined width can be measured when deciding
			    whether the repo chip fits inline. Gone on phones, where filter
			    moves to the top bar and the red FAB covers new-session. Gone in a
			    borrowed lens too: both act on YOUR sidebar, so grouping or
			    starting a session from inside someone else's bar is either a
			    no-op you can't see or work filed somewhere you didn't mean. The
			    bar keeps the one action that belongs to it, which is leaving. */}
          <div
            className={cn(
              "shrink-0 items-center gap-1.5",
              isPhone || borrowedLens ? "hidden" : "flex",
            )}
            ref={actionsRef}
          >
            <Tooltip label="Group, filter & sort">
              <button
                ref={setFilterButton}
                className={cn(
                  SIDEBAR_HEADER_BTN,
                  isPhone
                    ? cn(SIDEBAR_HEADER_BTN_PHONE, "min-h-[38px] min-w-[38px]")
                    : SIDEBAR_HEADER_BTN_DESKTOP,
                  "inline-flex items-center justify-center",
                  // The open state paints the stronger wash and the hover now
                  // layers OVER it (SIDEBAR_HOVER_LAYER), so the button no
                  // longer has to withhold its hover to keep from washing
                  // itself back out while open.
                  SIDEBAR_HOVER_LAYER,
                  filterOpen && "border-line-strong bg-pressed",
                  // A set filter is already spelled out in the header (the repo
                  // chip) and in the popover itself, so the button stays a plain
                  // glyph: full contrast under the pointer or while open.
                  filterOpen ? "text-fg" : "text-dim hover:text-fg",
                )}
                // A Base UI tooltip is a DESCRIPTION, not a name, so an
                // icon-only trigger still needs one of its own. The phone twin
                // below always carried this; the desktop button did not.
                aria-label="Group, filter & sort"
                onClick={() => setFilterOpen((o) => !o)}
              >
                {/* 22, the scale's standalone step: these are section-header
					    actions, not the primary buttons or window chrome that take
					    24. At 24 the plus drew a 16px span against the 15.5 of the
					    search glyph in the titlebar row right above, and the filter
					    is filled bars, so the pair read a step larger than the row
					    they sit under. */}
                <IconFilter size={22} />
              </button>
            </Tooltip>
            {/* ⌘S, not the ⌘⌥N this used to advertise: that chord opens a
				    sibling session inside the workspace you have open, while
				    this button (onNewSession → the palette) starts one in a new
				    workspace. */}
            <Tooltip label="New session" shortcut={newSessionKeys ?? undefined}>
              <button
                className={cn(
                  SIDEBAR_HEADER_BTN,
                  isPhone
                    ? SIDEBAR_HEADER_BTN_PHONE
                    : SIDEBAR_HEADER_BTN_DESKTOP,
                  "inline-flex items-center justify-center text-dim hover:bg-hover hover:text-fg",
                )}
                onClick={navigation.openNewWorkspace}
              >
                <IconPlus size={22} />
              </button>
            </Tooltip>
          </div>
          {/* Off-layout probe: measures the chip's natural width so the effect
			    above can decide whether it fits inline (never rendered visibly). */}
          {filter.repo !== "all" && (
            <RepoFilterChip repo={filter.repo} variant="probe" ref={probeRef} />
          )}
        </div>
      </div>
    </div>
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
                  !event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
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
                selectedSessionId={selectedId}
                onDuplicateSession={(session) => {
                  setPendingSessionFork(session.id);
                  navigation.openSession(session.id);
                }}
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

          {/* One card for the whole workspace list: the rows come out of a plain
			    render function, not a component, so they can't each own a popover.
			    The hovered row is the anchor instead — same shell, same card. */}
          <Popover.Root
            open={!!wsHover}
            onOpenChange={(open) => {
              if (!open) closeWsHover();
            }}
          >
            {wsHover && (
              <RowCardPopup anchor={wsHover.el}>
                <div
                  onMouseEnter={cancelWsHoverTimers}
                  onMouseLeave={scheduleWsHoverClose}
                >
                  <WsCardBody
                    row={wsHover.row}
                    snoozed={rowIsSnoozed(wsHover.row)}
                    onToggleSnooze={() => {
                      closeWsHover();
                      toggleWorkspaceSnooze(wsHover.row);
                    }}
                    onOpen={(session) => {
                      closeWsHover();
                      openSidebarSession(session);
                    }}
                  />
                </div>
              </RowCardPopup>
            )}
          </Popover.Root>
          {wsSheet &&
            (() => {
              const { row, source } = wsSheet;
              const ws = row.workspace;
              // Same pin resolution as the row's star and the right-click menu: a
              // row can be pinned via its own key or a legacy pin on any member
              // session (incl. alias ids) — unpin must clear all of them.
              const pinKey = ws ? `workspace:${ws.id}` : row.key;
              const pinnedKeys = [
                pinKey,
                row.key,
                ...row.sessions.flatMap((c) => [c.id, ...(c.aliasIds || [])]),
              ].filter((k, i, a) => pins.includes(k) && a.indexOf(k) === i);
              const pinned = pinnedKeys.length > 0;
              return (
                <WsMobileSheet
                  row={row}
                  pinned={pinned}
                  onTogglePin={() => {
                    if (pinned) togglePinnedKeys(pinnedKeys);
                    else togglePinKey(pinKey);
                  }}
                  onClose={() => setWsSheet(null)}
                  onArchive={() => archiveWorkspaceWithNext(row, source)}
                  onSetStatus={(status) => onSetStatus(row.sessions, status)}
                  snoozeUntil={
                    activeSnoozeKeys.has(row.key)
                      ? (snoozes[row.key] ?? null)
                      : null
                  }
                  onSnooze={(until) =>
                    until ? setSnooze(row.key, until) : clearSnooze(row.key)
                  }
                  onOpen={(session) => openSidebarSession(session)}
                  onRename={() => {
                    if (ws) {
                      setWorkspaceDraft(ws.name);
                      setEditingWorkspaceId(ws.id);
                    } else if (row.sessions[0]) {
                      // Solo session rows rename the session itself.
                      startSessionRename(row.sessions[0]);
                    }
                  }}
                  claimed={
                    row.sessions.length === 0
                      ? null
                      : row.sessions.some((c) => isClaimed(c))
                        ? true
                        : row.sessions.some((c) => ownedBy(c, currentUser))
                          ? null
                          : false
                  }
                  unread={row.unread}
                  onToggleRead={
                    row.sessions.length > 0
                      ? () =>
                          row.sessions.forEach((c) =>
                            row.unread
                              ? markRead(c.id, c.lastActivity)
                              : markUnread(c.id),
                          )
                      : null
                  }
                  onCopyLink={
                    row.sessions[0]
                      ? () =>
                          copyToClipboard(
                            absoluteLink(sessionPath(row.sessions[0])),
                            () => onToast?.("Link copied"),
                          )
                      : null
                  }
                  onDelete={
                    ws
                      ? () => {
                          if (row.sessions.length === 0) {
                            confirmDeleteDraft(() => onDeleteWorkspace(ws.id));
                            return;
                          }
                          confirm({
                            title: `Delete workspace "${ws.name}"?`,
                            description:
                              "All sessions in this workspace will be permanently deleted.",
                            confirmLabel: "Delete",
                            destructive: true,
                            onConfirm: () => onDeleteWorkspace(ws.id),
                          });
                        }
                      : null
                  }
                />
              );
            })()}
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
