import type { Dispatch, RefObject, SetStateAction } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { SplitSide } from "../components/SessionSplit";
import { SessionTabs } from "../components/SessionTabs";
import { getCurrentUser } from "../components/UserPicker";
import type { ActiveViewTab } from "../lib/active-view-tab";
import {
  deleteSessionApi,
  fetchWorkspaceArchivedSessions,
  newSessionApi,
  renameSessionApi,
  setSessionStatusApi,
} from "../lib/api";
import type { Route } from "../lib/app-route";
import { routePath } from "../lib/app-route";
import { BASE_PATH } from "../lib/base";
import { blockingOverlayOpen } from "../lib/blocking-overlay";
import { hasDraft } from "../lib/drafts";
import {
  newSessionSource,
  sessionNeverRan,
  workspaceSessionSeed,
} from "../lib/landing-session";
import { setLane, type Lane } from "../lib/lanes";
import { dedupeViewers, otherViewers } from "../lib/presence";
import { newClientSessionId } from "../lib/session-id";
import type { NewTabMorphOrigin, ViewTab } from "../lib/session-tabs-types";
import { sessionPath, workspacePanePath } from "../lib/share-link";
import { matchesShortcut } from "../lib/shortcuts";
import { sidebarWorkspaceIdForSession } from "../lib/sidebar-workspaces";
import {
  clearTabSplit,
  getTabSplit,
  resolveSplit,
  saveTabSplit,
  shouldShowTabStrip,
  type ResolvedSplit,
  type TabSplit,
} from "../lib/split-tabs";
import { setTabColor } from "../lib/tab-colors";
import { appendNewTabs, applyTabOrder, saveTabOrder } from "../lib/tab-order";
import { copySessionTranscript } from "../lib/transcript-copy";
import type { UnifiedSession, Workspace } from "../lib/types";
import { workspaceArchivedSessions } from "../lib/workspace-archive";
import { saveWorkspaceLastSession } from "../lib/workspace-last-session";
import type { WorkspacePaneTab } from "../lib/workspace-pane-tabs";
import type { useAppRoute } from "./useAppRoute";
import type { useAppViewState } from "./useAppViewState";
import { useArchiveUndo } from "./useArchiveUndo";
import { useDeskFabPosition } from "./useDeskFabPosition";
import { useRunningCloseConfirmation } from "./useRunningCloseConfirmation";
import { useSessionLifecycle } from "./useSessionLifecycle";
import type { useSessions } from "./useSessions";
import { useWorkspaceArchive } from "./useWorkspaceArchive";
import { useWorkspaceMutations } from "./useWorkspaceMutations";
import type { useWorkspacePanes } from "./useWorkspacePanes";

class MissingWorkspaceSessionSourceError extends Error {}

interface UseSessionTabsOptions {
  routing: {
    route: Route;
    navigate: ReturnType<typeof useAppRoute>["navigate"];
    getCurrentRoute: ReturnType<typeof useAppRoute>["getCurrentRoute"];
    canonicalizePath: ReturnType<typeof useAppRoute>["canonicalizePath"];
    forgetLastSession: ReturnType<typeof useAppRoute>["forgetLastSession"];
    goBack: () => void;
  };
  source: {
    currentSession: UnifiedSession | null;
    currentSessionRef: RefObject<UnifiedSession | null>;
    sessions: UnifiedSession[];
    sessionsRef: RefObject<UnifiedSession[]>;
    workspaces: Workspace[];
    currentUser: string;
    teamViewing: Array<{ user: string; sessionId: string }>;
  };
  layout: {
    isPhone: boolean;
    detailPaneRef: RefObject<HTMLElement | null>;
    tabColors: Record<string, string>;
    setTabColors: Dispatch<SetStateAction<Record<string, string>>>;
  };
  localTabs: {
    hiddenEmptySessionIds: Set<string>;
    setHiddenEmptySessionIds: Dispatch<SetStateAction<Set<string>>>;
    newTabMorph: { id: string; origin: NewTabMorphOrigin } | null;
    setNewTabMorph: Dispatch<
      SetStateAction<{ id: string; origin: NewTabMorphOrigin } | null>
    >;
    clearNewTabMorphTimer: () => void;
    startNewTabMorphTimer: (id: string) => void;
  };
  pending: {
    pendingTimer: RefObject<ReturnType<typeof setTimeout> | undefined>;
    replacePendingTimer: (callback: () => void, delay: number) => void;
    pendingSessionId: string | null;
    setPendingSessionId: Dispatch<SetStateAction<string | null>>;
    setPendingNewWorkspace: Dispatch<SetStateAction<boolean>>;
    setOptimisticSession: Dispatch<SetStateAction<UnifiedSession | null>>;
    copyLinkPathRef: RefObject<string | null>;
  };
  sessionStore: {
    inject: ReturnType<typeof useSessions>["inject"];
    patch: ReturnType<typeof useSessions>["patch"];
    refresh: ReturnType<typeof useSessions>["refresh"];
    remove: ReturnType<typeof useSessions>["remove"];
    unstick: ReturnType<typeof useSessions>["unstick"];
  };
  actions: {
    refreshWorkspaces: () => Promise<void>;
    openPrefilledSession: ReturnType<
      typeof import("./useNewSessionPalette").useNewSessionPalette
    >["openPrefilledSession"];
    showToast: (message: string) => void;
    dropStalePins: (sessions: UnifiedSession[]) => void;
  };
  view: Pick<
    ReturnType<typeof useAppViewState>,
    | "activeViewTab"
    | "setActiveViewTabState"
    | "subagentSelected"
    | "openSubagentPath"
    | "closeSubagentTab"
    | "splitDropSide"
    | "setSplitDropSide"
    | "suppressWsSeedRef"
  >;
  panes: {
    state: Pick<
      ReturnType<typeof useWorkspacePanes>,
      | "routeWorkspaceId"
      | "routeWorkspace"
      | "wsKey"
      | "wsRecord"
      | "paneViewTabs"
      | "openWsPanes"
      | "subagentStack"
    >;
    actions: Pick<
      ReturnType<typeof useWorkspacePanes>,
      | "setActiveViewTab"
      | "selectViewTab"
      | "closeStagingTab"
      | "closeAssetsTab"
      | "closeTerminalTab"
      | "closePreviewTab"
      | "closePortalTab"
      | "closeConversationTab"
      | "closeVideoTab"
      | "closeReviewTab"
    >;
  };
}

export function useSessionTabs({
  routing,
  source,
  layout,
  localTabs,
  pending,
  sessionStore,
  actions,
  view,
  panes,
}: UseSessionTabsOptions) {
  const {
    route,
    navigate,
    getCurrentRoute,
    canonicalizePath,
    forgetLastSession,
    goBack,
  } = routing;
  const {
    currentSession,
    currentSessionRef,
    sessions,
    sessionsRef,
    workspaces,
    currentUser,
    teamViewing,
  } = source;
  const { isPhone, detailPaneRef, tabColors, setTabColors } = layout;
  const {
    hiddenEmptySessionIds,
    setHiddenEmptySessionIds,
    newTabMorph,
    setNewTabMorph,
    clearNewTabMorphTimer,
    startNewTabMorphTimer,
  } = localTabs;
  const {
    pendingTimer,
    replacePendingTimer,
    pendingSessionId,
    setPendingSessionId,
    setPendingNewWorkspace,
    setOptimisticSession,
    copyLinkPathRef,
  } = pending;
  const { inject, patch, refresh, remove, unstick } = sessionStore;
  const { refreshWorkspaces, openPrefilledSession, showToast, dropStalePins } =
    actions;
  const {
    activeViewTab,
    setActiveViewTabState,
    subagentSelected,
    openSubagentPath,
    closeSubagentTab,
    splitDropSide,
    setSplitDropSide,
    suppressWsSeedRef,
  } = view;
  const {
    state: {
      routeWorkspaceId,
      routeWorkspace,
      wsKey,
      wsRecord,
      paneViewTabs,
      openWsPanes,
      subagentStack,
    },
    actions: {
      setActiveViewTab,
      selectViewTab,
      closeStagingTab,
      closeAssetsTab,
      closeTerminalTab,
      closePreviewTab,
      closePortalTab,
      closeConversationTab,
      closeVideoTab,
      closeReviewTab,
    },
  } = panes;
  // The tab strip is scoped to the open session's workspace: its sibling sessions
  // (same workspaceId), oldest first. Sessions with no workspace (slack/linear
  // sources — their files are read-only, so the migration couldn't wrap them)
  // fall back to grouping by shared isolated worktree, so a bks- sibling made
  // via + shows up next to its slack source. Failing that, the open session alone
  // still gets a strip (one tab + the + button).
  const activeWorkspaceId =
    routeWorkspaceId ?? (currentSession?.workspaceId || null);
  // A worker may run inside a temporary workspace, but its sidebar context is
  // still the root session that spawned it. Keep the worker's own workspace
  // active for panes and tools while selecting and expanding the root row.
  const sidebarWorkspaceId = currentSession
    ? sidebarWorkspaceIdForSession(sessions, currentSession)
    : activeWorkspaceId;
  const [settingsWorkspaceId, setSettingsWorkspaceId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (activeWorkspaceId) setSettingsWorkspaceId(activeWorkspaceId);
  }, [activeWorkspaceId]);

  // Feed the ⌘⇧C copy-link shortcut: the open session (workspace-scoped when it
  // has one, and drilled into a sub-agent when that's what's on screen), the
  // open workspace/PR preview, or nothing linkable.
  const activeWorkspacePane =
    activeWorkspaceId &&
    (activeViewTab === "review" ||
      activeViewTab === "conversation" ||
      activeViewTab === "video")
      ? workspacePanePath(activeWorkspaceId, activeViewTab)
      : null;
  const copyLinkPath =
    activeWorkspacePane ??
    (route.view === "session" && currentSession
      ? sessionPath(currentSession) + openSubagentPath
      : route.view === "workspace" || route.view === "pr"
        ? routePath(route)
        : null);
  useLayoutEffect(() => {
    copyLinkPathRef.current = copyLinkPath;
  });

  // Canonicalize the open session's URL to /workspace/<wsId>/session/<sessionId> once
  // its workspace is known (replaceState: same history depth, so Back and the
  // mobile page-stack are unaffected). Workspace-less sessions keep /session/<id>.
  // This is also where a sub-agent drill-in reaches the address bar: the tab is
  // what's on screen, so the URL trails it and a copied link opens the pane the
  // sender was reading. Refining the same panel, so it replaces rather than
  // stacking an entry, exactly like the workspace's own tab suffix.
  useEffect(() => {
    if (route.view !== "session" || !currentSession) return;
    // Remember the open session as its workspace's landing tab, so re-entering
    // the workspace (sidebar, bare /workspace/<id> URL) returns here. A worker
    // session is not a tab (see `viewingWorker`), so it never becomes the
    // workspace's landing spot — re-entering lands on the session that spawned it.
    if (activeWorkspaceId && !currentSession.parentSessionId)
      saveWorkspaceLastSession(activeWorkspaceId, route.id);
    const canonical =
      activeWorkspacePane ??
      (activeWorkspaceId
        ? `${BASE_PATH}/workspace/${encodeURIComponent(activeWorkspaceId)}/session/${encodeURIComponent(route.id)}`
        : `${BASE_PATH}/session/${encodeURIComponent(route.id)}`) +
        openSubagentPath;
    if (location.pathname !== canonical) canonicalizePath(canonical);
  }, [
    route,
    currentSession,
    activeWorkspaceId,
    activeWorkspacePane,
    openSubagentPath,
    canonicalizePath,
  ]);
  const byCreated = (a: UnifiedSession, b: UnifiedSession) =>
    (a.createdAt || "").localeCompare(b.createdAt || "");
  // Archived (closed) sessions leave the strip — except the one you're actively
  // viewing (e.g. opened from Archived), which keeps its tab.
  const liveTab = (s: UnifiedSession) =>
    !s.archived || s.id === currentSession?.id;
  /**
   * A worker session (one another session spawned through create_session) is a
   * drill-in, not a tab. Tabs are what a person opened; nobody opened this one.
   * It used to claim a temporary tab while you were inside it, so the strip grew
   * a tab on the way in and lost it on the way out, and what it showed was no
   * longer the workspace. While a worker is open the strip stays out of the way
   * entirely and the header breadcrumb (repo > session > worker) is what says
   * where you are and how to get back up.
   */
  const viewingWorker = !!currentSession?.parentSessionId;
  // The strip's natural order (createdAt asc), before any user reordering.
  const naturalSessions: UnifiedSession[] = activeWorkspaceId
    ? sessions
        .filter(
          (s) =>
            liveTab(s) &&
            !hiddenEmptySessionIds.has(s.id) &&
            s.workspaceId === activeWorkspaceId &&
            // Workers never take a tab — they are reached from the header's
            // worker menu and read as a level below their parent.
            !s.parentSessionId,
        )
        .sort(byCreated)
    : currentSession?.worktreeDir?.includes("/worktrees/")
      ? sessions
          .filter(
            (s) =>
              liveTab(s) &&
              !hiddenEmptySessionIds.has(s.id) &&
              s.worktreeDir === currentSession.worktreeDir &&
              !s.parentSessionId,
          )
          .sort(byCreated)
      : currentSession
        ? [currentSession]
        : [];
  // The stable workspace key the tab order is saved under: the workspace id, or
  // the shared isolated-worktree path for workspace-less (slack/linear) groups.
  // Empty ⇒ a lone standalone session, which has nothing to reorder.
  const tabOrderKey = activeWorkspaceId
    ? activeWorkspaceId
    : currentSession?.worktreeDir?.includes("/worktrees/")
      ? currentSession.worktreeDir
      : "";
  // Apply the user's saved left-to-right order (drag-drop). Unknown/new sessions
  // fall to the end in natural order; a stale saved id matches nothing.
  const workspaceSessions: UnifiedSession[] = (() => {
    if (!tabOrderKey || naturalSessions.length < 2) return naturalSessions;
    const byId = new Map(naturalSessions.map((s) => [s.id, s] as const));
    return applyTabOrder(
      tabOrderKey,
      naturalSessions.map((s) => s.id),
    )
      .map((id) => byId.get(id))
      .filter((s): s is UnifiedSession => !!s);
  })();
  // An untouched session is the workspace's reusable draft tab. While it
  // exists the + disappears, and shortcut/menu creates focus this tab instead.
  const emptyWorkspaceSession = workspaceSessions.find(
    (session) => session.source === "opensession" && sessionNeverRan(session),
  );
  // This workspace's closed sessions, fetched scoped rather than pulled out of
  // the whole archived index (which the app doesn't hold outside Archived).
  // The live tab count is the refetch trigger: an archive, a restore and a new
  // session all move it, and nothing else has to.
  const workspaceArchive = useWorkspaceArchive(
    activeWorkspaceId,
    naturalSessions.length,
  );
  /**
   * A workspace always has at least one tab. Close its last session and dismiss
   * its last pane and there is nothing left to put in the strip, so the
   * workspace home, the composer that starts the next session, takes the slot
   * rather than leaving a workspace with no tabs at all. It is the only tab
   * whenever it exists, which is why it carries no × of its own.
   */
  const homeViewTabs: ViewTab[] =
    wsKey && routeWorkspace && !workspaceSessions.length && !paneViewTabs.length
      ? [
          {
            id: `home:${wsKey}`,
            label: "New session",
            active: true,
            dotClass: null,
            closable: false,
          },
        ]
      : [];
  const viewTabs: ViewTab[] = [...paneViewTabs, ...homeViewTabs];
  // A sub-agent tab whose stack just went away (its session switched, or the tab
  // was closed) is no longer in the strip, and the session is what's rendered —
  // so treat it as no view tab rather than leaving the strip with nothing lit
  // for the frame before the reset effect below runs.
  const activeViewTabShown: ActiveViewTab =
    subagentSelected && subagentStack.length === 0 ? null : activeViewTab;
  const focusedTopTabId = activeViewTabShown
    ? (viewTabs.find((tab) => tab.active)?.id ?? null)
    : (currentSession?.id ?? null);
  // Every tab in the strip, in its natural order: sessions first, then the view
  // panes…
  const naturalStripTabIds = [
    ...workspaceSessions.map((session) => session.id),
    ...viewTabs.map((tab) => tab.id),
  ];
  // …then the arrangement the user dragged them into. Sessions and panes share
  // ONE saved order, so a Review or Assets tab can sit in front of a session; a
  // tab the saved order doesn't mention falls to the end in natural order.
  const stripTabIds = tabOrderKey
    ? applyTabOrder(tabOrderKey, naturalStripTabIds)
    : naturalStripTabIds;
  const previousStripRef = useRef<{ key: string; ids: string[] } | null>(null);
  useLayoutEffect(() => {
    const previous = previousStripRef.current;
    if (!tabOrderKey || previous?.key !== tabOrderKey) {
      previousStripRef.current = { key: tabOrderKey, ids: stripTabIds };
      return;
    }
    const appended = appendNewTabs(previous.ids, stripTabIds);
    previousStripRef.current = { key: tabOrderKey, ids: appended };
    if (appended.some((id, index) => id !== stripTabIds[index]))
      saveTabOrder(tabOrderKey, appended);
  }, [tabOrderKey, stripTabIds]);
  // Teammates per tab, your own devices removed and one entry per person, so
  // the strip can say WHICH session someone is in — the sidebar's workspace
  // faces only say they are in this workspace somewhere.
  const tabViewers: Record<string, string[]> = {};
  for (const session of workspaceSessions) {
    const here = dedupeViewers(
      otherViewers(
        teamViewing
          .filter((v) => v.sessionId === session.id)
          .map((v) => v.user),
        currentUser,
      ),
    ).map((v) => v.name);
    if (here.length) tabViewers[session.id] = here;
  }
  const storedTabSplit = tabOrderKey ? getTabSplit(tabOrderKey) : null;
  // The split projected onto the tabs that exist right now. Null once either
  // bar runs out of tabs — that's what collapses the strip back to one bar.
  const tabSplit = isPhone ? null : resolveSplit(storedTabSplit, stripTabIds);
  // A worker fills the pane on its own: it is not in the strip, so it is not in
  // either column of a split either. The split is kept, not cleared — going back
  // up to the parent restores it.
  const activeTabSplit = currentSession && !viewingWorker ? tabSplit : null;
  const tabStripVisible = shouldShowTabStrip(
    stripTabIds.length,
    !!activeTabSplit,
    !!viewingWorker,
  );
  const deskFabPosition = useDeskFabPosition(
    !isPhone && !activeViewTabShown,
    `${focusedTopTabId ?? ""}:${activeTabSplit?.rightActive ?? ""}:${activeTabSplit?.ratio ?? ""}`,
  );
  const toStoredSplit = (split: ResolvedSplit): TabSplit => ({
    right: split.right,
    leftActive: split.leftActive,
    rightActive: split.rightActive,
    ratio: split.ratio,
  });
  const otherSide = (side: SplitSide): SplitSide =>
    side === "left" ? "right" : "left";
  /** Which bar owns a tab. The left bar is every tab's default home. */
  const sideOf = (id: string): SplitSide =>
    activeTabSplit?.right.includes(id) ? "right" : "left";
  // The focused bar is whichever holds the routed tab, so its active tab is
  // the one the URL already reflects; the other bar's is remembered below.
  const focusedSide: SplitSide = focusedTopTabId
    ? sideOf(focusedTopTabId)
    : "left";
  const activeIdFor = (side: SplitSide): string | null => {
    if (!activeTabSplit) return focusedTopTabId;
    if (side === focusedSide) return focusedTopTabId;
    return side === "left"
      ? activeTabSplit.leftActive
      : activeTabSplit.rightActive;
  };
  // Remember each bar's active tab so refocusing the other bar restores what
  // was open there rather than snapping to its first tab.
  useEffect(() => {
    if (!tabOrderKey || !activeTabSplit || !focusedTopTabId) return;
    const stored =
      focusedSide === "left"
        ? activeTabSplit.leftActive
        : activeTabSplit.rightActive;
    if (stored === focusedTopTabId) return;
    saveTabSplit(tabOrderKey, {
      ...toStoredSplit(activeTabSplit),
      ...(focusedSide === "left"
        ? { leftActive: focusedTopTabId }
        : { rightActive: focusedTopTabId }),
    });
  });

  /**
   * Which bar a dragged tab would land in: the pane's left/right half when
   * there is no split yet (the drop that creates one), or the column actually
   * under the pointer once there is. Null when the drop would be a no-op.
   */
  function splitSideAt(
    draggedId: string,
    point: { x: number; y: number },
  ): SplitSide | null {
    if (isPhone || !currentSession || !stripTabIds.includes(draggedId))
      return null;
    const pane = detailPaneRef.current?.getBoundingClientRect();
    if (
      !pane ||
      point.x < pane.left ||
      point.x > pane.right ||
      point.y > pane.bottom
    )
      return null;
    if (activeTabSplit) {
      const side: SplitSide =
        point.x < pane.left + pane.width * activeTabSplit.ratio
          ? "left"
          : "right";
      // Dropping a tab back into the bar it already lives in changes nothing.
      return side === sideOf(draggedId) ? null : side;
    }
    // No split yet: the drop has to clear the strip, and needs a tab to leave
    // behind — splitting off the only tab would just move the whole bar over.
    const strip = detailPaneRef.current
      ?.querySelector<HTMLElement>(".session-tabs")
      ?.getBoundingClientRect();
    if (!strip || point.y < strip.bottom + 8 || stripTabIds.length < 2)
      return null;
    return point.x < pane.left + pane.width / 2 ? "left" : "right";
  }

  /** Move a tab into `side`'s bar, creating or collapsing the split as needed. */
  function moveTabToSide(draggedId: string, side: SplitSide) {
    if (!tabOrderKey) return;
    setSplitDropSide(null);
    const right = activeTabSplit
      ? side === "right"
        ? [...activeTabSplit.right, draggedId]
        : activeTabSplit.right.filter((id) => id !== draggedId)
      : // First split: the dragged tab takes the half it was dropped on, alone.
        side === "right"
        ? [draggedId]
        : stripTabIds.filter((id) => id !== draggedId);
    // A bar that would hold every tab (or none) is just one bar again.
    if (!right.length || right.length === stripTabIds.length) {
      clearTabSplit(tabOrderKey);
      return;
    }
    saveTabSplit(tabOrderKey, {
      ...(activeTabSplit ? toStoredSplit(activeTabSplit) : { ratio: 0.5 }),
      right,
      ...(side === "right"
        ? { rightActive: draggedId }
        : { leftActive: draggedId }),
    });
  }

  /**
   * A bar only ever reorders its OWN tabs, but the order is saved per
   * workspace — so splice the bar's new sequence back into the positions it
   * occupies in the full strip, leaving the other column's arrangement (and
   * any tab the bar doesn't hold) exactly where it was.
   */
  function mergeBarOrder(barIds: string[]): string[] {
    const moved = new Set(barIds);
    const queue = [...barIds];
    const merged = stripTabIds.map((id) =>
      moved.has(id) ? (queue.shift() ?? id) : id,
    );
    // `barIds` is a subset of the strip, so the queue drains — unless a tab
    // appeared mid-drag, in which case it lands at the end rather than lost.
    return [...merged, ...queue];
  }

  /**
   * Closing a workspace pane can empty the strip: a workspace whose sessions
   * are all closed has nothing else in it. Reopen the workspace composer from
   * its most recent session settings instead of creating an empty session.
   * Returns whether it opened that composer, since its navigation replaces the
   * caller's.
   */
  function reopenSessionAfterPaneClose(closed: WorkspacePaneTab): boolean {
    if (currentSession || workspaceSessions.length) return false;
    // `openWsPanes` is this render's list, so it still holds the closing pane.
    if (openWsPanes.some((pane) => pane !== closed)) return false;
    const wsId = activeWorkspaceId;
    if (!wsId) return false;
    // `archivedSessions` is this workspace's own closed list (scoped
    // fetch + whatever was archived here), newest first. Its worktree
    // settings make the new-session composer a sibling when a person next
    // sends a prompt, without materializing an empty durable session now.
    const src = archivedSessions[0];
    if (src) openNewSessionInWorkspace(src, "share");
    dropPaneUrlSuffix(closed);
    return true;
  }

  /**
   * Drop a closed pane's URL suffix (/review, /conversation, /video). The
   * replace re-runs the workspace seeding effect, so arm its one-shot suppress
   * or it reopens the tab that was just closed.
   */
  function dropPaneUrlSuffix(closed: WorkspacePaneTab) {
    if (route.view !== "workspace" || route.tab !== closed) return;
    suppressWsSeedRef.current = true;
    navigate({ view: "workspace", id: route.id }, { replace: true });
  }

  /**
   * One tab bar. `side` is null when there is no split (a single bar owning
   * every tab); otherwise the bar renders only its own side's tabs, keeps its
   * own active tab and its own "+", and only the rightmost bar carries the
   * archived-sessions menu.
   */
  function renderTabBar(side: SplitSide | null) {
    const ids =
      side && activeTabSplit
        ? side === "left"
          ? activeTabSplit.left
          : activeTabSplit.right
        : null;
    const inBar = ids ? new Set(ids) : null;
    const barSessions = inBar
      ? workspaceSessions.filter((session) => inBar.has(session.id))
      : workspaceSessions;
    const barActive = side ? activeIdFor(side) : focusedTopTabId;
    const barViews = (
      inBar ? viewTabs.filter((tab) => inBar.has(tab.id)) : viewTabs
    ).map((tab) => (side ? { ...tab, active: tab.id === barActive } : tab));
    return (
      <SessionTabs
        content={{
          sessions: barSessions,
          archivedSessions,
          activeSessionId:
            barActive && barSessions.some((session) => session.id === barActive)
              ? barActive
              : null,
          colors: tabColors,
          viewers: tabViewers,
          order: stripTabIds,
          views: barViews,
        }}
        layout={{
          inSplit: !!side,
          showHistory: side !== "left",
          moveAcrossSide: side ? otherSide(side) : undefined,
          emptySessionId: emptyWorkspaceSession?.id,
          morphingSessionId: newTabMorph?.id,
          morphOrigin: newTabMorph?.origin,
        }}
        actions={{
          selectSession: selectSessionTab,
          setColor: (key, color) => setTabColors(setTabColor(key, color)),
          reorder: (ids) => saveTabOrder(tabOrderKey, mergeBarOrder(ids)),
          previewSplit: (id, point) => {
            setSplitDropSide(id && point ? splitSideAt(id, point) : null);
          },
          dropIntoSplit: (id, point) => {
            const target = splitSideAt(id, point);
            setSplitDropSide(null);
            if (!target) return false;
            moveTabToSide(id, target);
            return true;
          },
          moveAcross: side
            ? (id) => moveTabToSide(id, otherSide(side))
            : undefined,
          selectView: selectViewTab,
          closeView: (id) => {
            if (id.startsWith("subagent:"))
              closeSubagentTab(id.slice("subagent:".length));
            else if (id.startsWith("staging:")) closeStagingTab();
            else if (id.startsWith("assets:")) closeAssetsTab();
            else if (id.startsWith("terminal:")) closeTerminalTab();
            else if (id.startsWith("preview:")) closePreviewTab();
            else if (id.startsWith("portal:")) closePortalTab();
            else {
              const closingTab = id.startsWith("conversation:")
                ? ("conversation" as const)
                : id.startsWith("video:")
                  ? ("video" as const)
                  : ("review" as const);
              if (closingTab === "conversation") closeConversationTab();
              else if (closingTab === "video") closeVideoTab();
              else closeReviewTab();
              // A workspace always shows something: closing its last pane
              // while every session is closed reopens one, and its
              // navigation stands in for dropping the tab suffix.
              if (!reopenSessionAfterPaneClose(closingTab))
                dropPaneUrlSuffix(closingTab);
            }
          },
          newSession:
            barSessions.some((session) => session.desk) || emptyWorkspaceSession
              ? undefined
              : (mode, origin) => handleNewSession(mode, side, origin),
          rename: async (id, title) => {
            await (async () => {
              await renameSessionApi(id, title);
            })().catch(async (e) => {
              console.error("Rename failed:", e);
            });
            refresh();
          },
          close: closeSession,
          delete: deleteSessionFromTab,
          toast: showToast,
          restore: restoreSession,
        }}
      />
    );
  }
  // The strip's history menu: closed sessions of the same workspace, newest
  // activity first. Grouping is not the workspace id alone — see
  // lib/workspace-archive, which also adopts the sessions a duplicate
  // workspace record holds for the same worktree.
  const archivedSessions: UnifiedSession[] = workspaceArchivedSessions({
    sessions,
    fetched: workspaceArchive,
    workspaceId: activeWorkspaceId,
    worktreeDir: wsRecord?.worktreeDir ?? currentSession?.worktreeDir,
    excludeId: currentSession?.id,
  });

  // A create can still be in flight when its blank tab is left. Remember that
  // local id so the response is discarded and its just-created file removed.
  const abandonedSessionCreatesRef = useRef<Set<string>>(new Set());

  async function createNewSessionFrom(
    src: UnifiedSession,
    mode: "share" | "stack" | "ask",
    id: string,
    morphOrigin?: NewTabMorphOrigin,
    persistedSource: Promise<UnifiedSession> = Promise.resolve(src),
    duplicate = false,
  ): Promise<string> {
    const now = new Date().toISOString();
    const user = getCurrentUser();
    const draft: UnifiedSession = {
      ...src,
      id,
      source: "opensession",
      claudeSessionId: null,
      codexThreadId: undefined,
      ...(duplicate
        ? { duplicatedFromSessionId: src.id, title: src.title }
        : { title: "New session" }),
      createdAt: now,
      lastActivity: now,
      isRunning: false,
      // This shell has no engine yet. A duplicate's copied transcript arrives
      // with the create response, while an ordinary sibling stays blank.
      ran: false,
      transcriptPath: null,
      startedBy: user,
      archived: false,
      waitingForInput: false,
      queuedCount: 0,
      prUrl: undefined,
      prState: undefined,
      automation: undefined,
      plainThreadId: undefined,
      goal: undefined,
      loop: undefined,
      // This sibling reuses an already-ready workspace. The disconnected pane
      // holds messages locally until the server has persisted the session.
      workspacePreparing: false,
    };
    if (mode === "ask") {
      draft.branch = null;
      draft.worktreeDir = null;
      draft.mode = "ask";
    }
    // Commit the local shell before changing the route. Without this boundary,
    // the route can render against the previous list and keep the old session's
    // conversation visible until the create response arrives.
    clearNewTabMorphTimer();
    flushSync(() => {
      inject(draft, { sticky: true });
      setOptimisticSession(draft);
      setPendingSessionId(id);
      setPendingNewWorkspace(false);
      setNewTabMorph(morphOrigin ? { id, origin: morphOrigin } : null);
    });
    if (morphOrigin) startNewTabMorphTimer(id);
    replacePendingTimer(() => {
      setPendingSessionId(null);
      setOptimisticSession((pending) => (pending?.id === id ? null : pending));
      unstick(id);
    }, 30_000);
    navigate({ view: "session", id });

    return await (async () => {
      const source = await persistedSource;
      const created = await newSessionApi(source.id, user, mode, id, duplicate);
      const createdId = created.id;
      if (abandonedSessionCreatesRef.current.delete(id)) {
        unstick(id);
        remove(id);
        setPendingSessionId((pending) => (pending === id ? null : pending));
        setOptimisticSession((pending) =>
          pending?.id === id ? null : pending,
        );
        // A different id belongs to another window's reusable tab. Only delete
        // the session this request actually created.
        if (createdId === id)
          await deleteSessionApi(createdId, false).catch((error) =>
            console.error("Abandoned empty session cleanup failed:", error),
          );
        refresh();
        return createdId;
      }
      if (createdId !== id) {
        // Another window won the one-empty-tab race. Drop this optimistic
        // shell and focus the reusable tab the server returned.
        unstick(id);
        remove(id);
      }
      inject(
        created.session ?? {
          ...draft,
          id: createdId,
          workspacePreparing: false,
        },
        { sticky: true },
      );
      clearTimeout(pendingTimer.current);
      setPendingSessionId((pending) => (pending === id ? null : pending));
      setOptimisticSession((pending) => (pending?.id === id ? null : pending));
      if (createdId !== id) navigate({ view: "session", id: createdId });
      refresh();
      return createdId;
    })().catch(async (error) => {
      clearTimeout(pendingTimer.current);
      setPendingSessionId((pending) => (pending === id ? null : pending));
      setOptimisticSession((pending) => (pending?.id === id ? null : pending));
      unstick(id);
      remove(id);
      const currentRoute = getCurrentRoute();
      if (currentRoute.view === "session" && currentRoute.id === id) {
        if (src.id.startsWith("workspace:") && src.workspaceId) {
          navigate({ view: "workspace", id: src.workspaceId, tab: "review" });
        } else {
          navigate({ view: "session", id: src.id });
        }
      }
      throw error;
    });
  }

  function openNewSessionInWorkspace(
    src: UnifiedSession,
    mode: "share" | "stack" | "ask",
    prompt?: string,
  ): void {
    const workspace = src.workspaceId
      ? workspaces.find((item) => item.id === src.workspaceId)
      : undefined;
    const prefill: Parameters<typeof openPrefilledSession>[0] = {
      repo: src.repo || workspace?.repo,
    };
    if (prompt) prefill.prompt = prompt;
    if (src.workspaceId) {
      prefill.workspaceId = src.workspaceId;
      prefill.modelWorkspaceId = src.workspaceId;
    }
    // Sharing starts from the workspace's branch. Omitting the branch for
    // a stack keeps NewSession on "New branch", which the create path
    // resolves as a stacked worktree after the first prompt is sent.
    const branch = src.branch || workspace?.branch;
    if (mode === "share" && branch) prefill.branch = branch;
    if (mode === "ask") prefill.mode = "ask";
    openPrefilledSession(prefill);
  }

  // Open a real sibling tab immediately. Its first prompt starts the engine, so
  // the lightweight create does no model work and keeps the interaction quick.
  const siblingCreateRef = useRef<string | null>(null);
  const handleNewSession = async (
    mode: "share" | "stack" | "ask",
    side: SplitSide | null = null,
    morphOrigin?: NewTabMorphOrigin,
    duplicate = false,
  ) => {
    if (emptyWorkspaceSession && !duplicate) {
      setActiveViewTab(null);
      navigate({ view: "session", id: emptyWorkspaceSession.id });
      return;
    }

    const openSessionlessWorkspaceComposer = () => {
      if (route.view !== "workspace") return;
      const workspace = workspaces.find((item) => item.id === route.id);
      const prefill: Parameters<typeof openPrefilledSession>[0] = {
        workspaceId: route.id,
        repo: workspace?.repo,
        branch: workspace?.branch,
      };
      // Feed workspaces without a repo start in Scratch.
      if (workspace?.externalRefs?.length && !workspace.repo) {
        prefill.mode = "scratch";
      }
      openPrefilledSession(prefill);
    };

    let src = newSessionSource(
      currentSession,
      naturalSessions,
      archivedSessions,
    );
    let persistedSource: Promise<UnifiedSession> | undefined;
    if (!src && activeWorkspaceId && wsRecord) {
      // Paint and route the local tab now. The cold archived-session lookup can
      // take several seconds, but it is needed only when the server persists it.
      src = workspaceSessionSeed(wsRecord, getCurrentUser());
      persistedSource = (async () => {
        await (async () => {
          const archived =
            await fetchWorkspaceArchivedSessions(activeWorkspaceId);
          const source = newSessionSource(null, [], archived);
          if (source) return source;
        })().catch(async () => {
          // Fall through to the existing session-less composer below.
        });
        throw new MissingWorkspaceSessionSourceError();
      })();
    }
    if (!src) {
      openSessionlessWorkspaceComposer();
      return;
    }
    if (siblingCreateRef.current) return;
    // The new session is the tab the + opens. Clear Review (or any other pane)
    // before routing so its persisted workspace suffix cannot keep winning.
    setActiveViewTab(null);
    const optimisticId = newClientSessionId();
    siblingCreateRef.current = optimisticId;
    await (async () => {
      const id = await createNewSessionFrom(
        src,
        mode,
        optimisticId,
        morphOrigin,
        persistedSource,
        duplicate,
      );
      if (side === "right" && tabOrderKey && activeTabSplit)
        saveTabSplit(tabOrderKey, {
          ...toStoredSplit(activeTabSplit),
          right: [...activeTabSplit.right, id],
          rightActive: id,
        });
    })()
      .catch(async (error) => {
        if (error instanceof MissingWorkspaceSessionSourceError) {
          openSessionlessWorkspaceComposer();
        } else {
          console.error("New session failed:", error);
          showToast("Couldn't create a new tab.");
        }
      })
      .finally(async () => {
        if (siblingCreateRef.current === optimisticId)
          siblingCreateRef.current = null;
      });
  };
  const handleNewSessionRef = useRef(handleNewSession);
  useLayoutEffect(() => {
    handleNewSessionRef.current = handleNewSession;
  });

  // Lanes are per-user (lib/lanes.ts): setting one moves the row in YOUR
  // sidebar only, so teammates can hold the same workspace in their own
  // lanes. Clearing also drops any legacy global override, so "Auto" (and
  // "Stop keeping in sidebar") releases rows pinned before lanes went
  // per-user. Shared by the sidebar rows' menus and the viewer's ⋯ menu.
  const setSessionLanes = (sessions: UnifiedSession[], status: Lane | null) => {
    for (const c of sessions) {
      setLane(c.id, status);
      if (c.manualStatus) {
        patch(c.id, { manualStatus: undefined });
        setSessionStatusApi(c.id, null).catch(() => {});
      }
    }
  };

  // ⌘Z (legacy ⌘⇧T) reopens what you just archived. Every archive path
  // pushes the sessions it tucked away as one entry, so a press undoes one
  // action: closing a tab brings that session back, archiving a workspace brings
  // the whole row back. Ids only — the session objects go stale on the next
  // refresh, so entries resolve against the live list when they're restored.
  const {
    rememberArchived,
    unarchiveSession,
    restorableArchived,
    reopenLastArchived,
    reopenLastArchivedRef,
  } = useArchiveUndo({
    sessions,
    patch,
    refresh,
    navigate,
    showToast,
    forgetLastSession,
  });
  const {
    confirmRunningClose,
    confirmRunningCloses,
    dialog: runningCloseDialog,
  } = useRunningCloseConfirmation();
  const {
    renameWorkspace,
    renameWorkspaceFromSidebar,
    archiveWorkspaceFromHeader,
    archiveWorkspaceFromSidebar,
    deleteWorkspaceFromHeader,
    deleteWorkspaceFromSidebar,
  } = useWorkspaceMutations({
    route,
    navigate,
    goBack,
    patch,
    refreshSessions: refresh,
    refreshWorkspaces,
    confirmRunningCloses,
    rememberArchived,
    dropStalePins,
  });
  const {
    closeSessionNow,
    closeSession,
    deleteSessionFromTab,
    restoreSession,
    archiveSessionFromSidebar,
    archiveSessionsFromCatchUp,
    closeSessionRef,
  } = useSessionLifecycle({
    route,
    navigate,
    goBack,
    currentSession,
    workspaceSessions,
    activeWorkspaceId,
    openWsPanes,
    activeViewTab,
    setActiveViewTab,
    pendingSessionId,
    pendingTimer,
    abandonedSessionCreatesRef,
    suppressWsSeedRef,
    setPendingSessionId,
    setOptimisticSession,
    setHiddenEmptySessionIds,
    patch,
    inject,
    remove,
    unstick,
    refresh,
    confirmRunningClose,
    confirmRunningCloses,
    rememberArchived,
    dropStalePins,
    openNewSessionInWorkspace,
  });
  const selectSessionTab = (next: UnifiedSession) => {
    const empty =
      currentSession &&
      currentSession.id !== next.id &&
      currentSession.source === "opensession" &&
      sessionNeverRan(currentSession) &&
      !hasDraft(`session:${currentSession.id}`)
        ? currentSession
        : null;
    setActiveViewTab(null);
    if (!empty) {
      navigate({ view: "session", id: next.id });
      return;
    }
    setHiddenEmptySessionIds((hidden) => new Set(hidden).add(empty.id));
    void closeSessionNow(empty, next);
  };

  /**
   * Foreground a tab by its strip id — a session or a pane, since the strip
   * holds both in one order. Mirrors what SessionTabs' own onSelect and
   * onSelectView do, so the keyboard lands exactly where a click would.
   */
  function activateStripTab(id: string): boolean {
    const session = workspaceSessions.find((s) => s.id === id);
    if (session) {
      setActiveViewTab(null);
      navigate({ view: "session", id: session.id });
      return true;
    }
    if (!viewTabs.some((tab) => tab.id === id)) return false;
    selectViewTab(id);
    return true;
  }
  /** Walk the strip, wrapping at the ends. False when there is no strip. */
  function stepStripTab(delta: number): boolean {
    if (stripTabIds.length < 2) return false;
    const at = focusedTopTabId ? stripTabIds.indexOf(focusedTopTabId) : -1;
    // Nothing in the strip is focused (a pane the order doesn't know):
    // enter from whichever end the direction comes from.
    const from = at < 0 ? (delta > 0 ? -1 : 0) : at;
    const next =
      stripTabIds[(from + delta + stripTabIds.length) % stripTabIds.length];
    return !!next && activateStripTab(next);
  }
  /** Foreground the nth tab (0-based). False when there is no nth tab. */
  function jumpStripTab(index: number): boolean {
    if (stripTabIds.length < 2) return false;
    const id = stripTabIds[index];
    if (!id) return false;
    // Already there: report it handled anyway, so the chord never falls
    // through and types the Option character it stands for on a Mac.
    if (id === focusedTopTabId) return true;
    return activateStripTab(id);
  }
  const tabNavRef = useRef({ stepStripTab, jumpStripTab });
  useLayoutEffect(() => {
    tabNavRef.current = { stepStripTab, jumpStripTab };
  });

  // ⌘⌥←/→ walk the workspace's tab strip (⌃⌥ on Chromium, which takes the ⌘⌥
  // pair for its own tabs), and ⌥1…⌥9 jump straight to one. Both read the
  // strip's left-to-right order, panes included, so what the keyboard
  // reaches is what the eye reads. They fire with the composer focused:
  // moving between tabs without leaving the keyboard is the whole point, and
  // unlike the sidebar's ⌘↑/⌘↓ these chords take no caret move from a draft.
  //
  // The digits are hard-coded rather than nine registry commands. Matching
  // is exact on the whole chord, so a command per digit is the only shape
  // the registry could hold, and the modifier — the one part anyone would
  // want to rebind — is not something a chord list can express. They are
  // listed on the shortcuts page as a reference row instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const dir = matchesShortcut(e, "tab-next")
        ? 1
        : matchesShortcut(e, "tab-prev")
          ? -1
          : 0;
      // Read the digit off `e.code`: Option rewrites `e.key` (⌥1 is "¡"
      // on a Mac), and a non-Latin layout would hide it too.
      const digit =
        !dir &&
        e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        /^Digit[1-9]$/.test(e.code)
          ? Number(e.code.slice(5))
          : 0;
      if (!dir && !digit) return;
      if (blockingOverlayOpen()) return;
      // Only claim the keystroke once there is a tab to move to, so a
      // workspace with no strip leaves the chord to whatever wants it.
      const acted = dir
        ? tabNavRef.current.stepStripTab(dir)
        : tabNavRef.current.jumpStripTab(digit - 1);
      if (acted) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Tab shortcuts matching the strip's context-menu hints: ⌘⌥C copies the
  // concise transcript, ⌘W closes (archives) the tab, ⌘⌥N opens a new tab
  // (sibling session) in the workspace, and ⌘Z (or the legacy ⌘⇧T) reopens what
  // you just archived — a session, or a whole workspace row.
  // Refs keep this mount-once listener reading fresh state. A browser that
  // reserves these for itself (Chrome) never delivers the keydown — there the
  // browser tab opens/closes as always, and the palette's "Reopen closed session"
  // covers the undo; where the event does arrive (Safari, the installed PWA,
  // the desktop shell), we take it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Reopen undoes the last archive. Unlike the archive chords, every
      // editable keeps it — including the composer textarea, where undoing
      // what you typed is exactly what ⌘Z should do. Sits above the
      // no-open-session bail because archiving the workspace you were in
      // can leave you on Home with nothing selected. (⌘⇧Z is redo
      // everywhere else, so it is deliberately not one of the defaults.)
      if (matchesShortcut(e, "session-reopen")) {
        const editable =
          e.target instanceof Element
            ? e.target.closest(
                "input, textarea, select, [contenteditable='true'], [contenteditable='']",
              )
            : null;
        if (editable) return;
        e.preventDefault();
        void reopenLastArchivedRef.current();
        return;
      }
      const s = currentSessionRef.current;
      if (!s) return;
      if (matchesShortcut(e, "session-copy-transcript")) {
        e.preventDefault();
        void copySessionTranscript(s, "concise", showToast);
      } else if (matchesShortcut(e, "session-close")) {
        e.preventDefault();
        void closeSessionRef.current(s);
      } else if (!s.desk && matchesShortcut(e, "session-new-sibling")) {
        e.preventDefault();
        void handleNewSessionRef.current("share");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showToast, reopenLastArchivedRef, closeSessionRef, currentSessionRef]);

  const handleSessionRunningChange = (id: string, isRunning: boolean) => {
    // Keep the existing run-start stamp when the session was already running:
    // the viewer relays a session_status on every (re)open, and re-stamping
    // here reset the sidebar's elapsed ticker to zero on each session switch.
    const prev = sessionsRef.current.find((s) => s.id === id);
    // The watch handshake repeats the current state on every open. Avoid
    // replacing a list row, and re-rendering its workspace, when it agrees.
    if (
      prev?.isRunning === isRunning &&
      (isRunning ? !!prev.runStartedAt : !prev.runStartedAt)
    )
      return;
    patch(id, {
      isRunning,
      runStartedAt: isRunning
        ? (prev?.isRunning ? prev.runStartedAt : undefined) ||
          new Date().toISOString()
        : undefined,
    });
  };

  return {
    context: {
      activeWorkspaceId,
      sidebarWorkspaceId,
      settingsWorkspaceId,
      copyLinkPath,
      workspaceSessions,
      emptyWorkspaceSession,
    },
    strip: {
      activeTabSplit,
      tabStripVisible,
      deskFabPosition,
      toStoredSplit,
      focusedSide,
      activeIdFor,
      renderTabBar,
      tabOrderKey,
    },
    archive: {
      archivedSessions,
      rememberArchived,
      unarchiveSession,
      restorableArchived,
      reopenLastArchived,
      reopenLastArchivedRef,
      runningCloseDialog,
      restoreSession,
      archiveSessionsFromCatchUp,
    },
    sessionActions: {
      handleNewSession,
      openNewSessionInWorkspace,
      setSessionLanes,
      closeSession,
      archiveSessionFromSidebar,
      handleSessionRunningChange,
    },
    workspaceActions: {
      renameWorkspace,
      renameWorkspaceFromSidebar,
      archiveWorkspaceFromHeader,
      archiveWorkspaceFromSidebar,
      deleteWorkspaceFromHeader,
      deleteWorkspaceFromSidebar,
    },
  };
}
