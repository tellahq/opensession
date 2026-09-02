import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Analytics } from "./components/Analytics";
import { AppMobileHeader } from "./components/AppMobileHeader";
import { AppSessionPane } from "./components/AppSessionPane";
import { AppShell } from "./components/AppShell";
import { AppSidebar } from "./components/AppSidebar";
import { Archived } from "./components/Archived";
import { Automations } from "./components/Automations";
import { CatchUpDeck } from "./components/CatchUpDeck";
import { ChipHoverCards } from "./components/ChipHoverCard";
import { CommandMenuHost } from "./components/CommandMenuHost";
import { DeferredSettings as Settings } from "./components/DeferredSettings";
import { DeskOverlay } from "./components/DeskOverlay";
import { DesktopLinkToast } from "./components/DesktopLinkToast";
import { Feed } from "./components/Feed";
import { refWebPanel } from "./components/FeedWebPane";
import { FirstMile } from "./components/FirstMile";
import { Goals } from "./components/Goals";
import { IconDesk, IconSidebarLeft } from "./components/icons";
import { MediaLightboxHost } from "./components/MediaLightbox";
import { NavigationProvider } from "./components/NavigationProvider";
import { NewSession } from "./components/NewSession";
import { PrQueuePreview } from "./components/PrQueuePreview";
import { Prs } from "./components/Prs";
import { Reports } from "./components/Reports";
import { RestartOverlay } from "./components/RestartOverlay";
import { Reviews } from "./components/Reviews";
import { RunningCloseDialog } from "./components/RunningCloseDialog";
import { Security } from "./components/Security";
import { SessionSplit } from "./components/SessionSplit";
import { ShortcutCheatSheet } from "./components/ShortcutCheatSheet";
import { SupportInbox } from "./components/SupportInbox";
import { SupportPreview } from "./components/SupportPreview";
import { SupportTinder } from "./components/SupportTinder";
import { Tasks } from "./components/Tasks";
import { UpdatePill } from "./components/UpdatePill";
import {
  UserGate,
  getCurrentUser,
  useAuthStatus,
  useCurrentUser,
} from "./components/UserPicker";
import { WorkspacePane } from "./components/WorkspacePane";
import { useActiveSession } from "./hooks/useActiveSession";
import { useAppDocumentInteractions } from "./hooks/useAppDocumentInteractions";
import { useAppGlobalHotkeys } from "./hooks/useAppGlobalHotkeys";
import { useAppRegistries } from "./hooks/useAppRegistries";
import { useAppRoute } from "./hooks/useAppRoute";
import { useAppShell } from "./hooks/useAppShell";
import { useAppViewState } from "./hooks/useAppViewState";
import { useGithubConnectionState } from "./hooks/useGithubConnectionState";
import { useLargeTitleHandoff } from "./hooks/useLargeTitle";
import { useNewSessionCreateStart } from "./hooks/useNewSessionCreateStart";
import { useNewSessionPalette } from "./hooks/useNewSessionPalette";
import { useNewTabMorphTimer } from "./hooks/useNewTabMorphTimer";
import { useOnboarding } from "./hooks/useOnboarding";
import { sidebarSessionsQuery, useSessions } from "./hooks/useSessions";
import { useSessionTabs } from "./hooks/useSessionTabs";
import { useShortcutKeys } from "./hooks/useShortcutBindings";
import { useWebSocket } from "./hooks/useWebSocket";
import { useWorkspacePanes } from "./hooks/useWorkspacePanes";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { getActiveViewTab, saveActiveViewTab } from "./lib/active-view-tab";
import { cachedRepos, resolveWorkspaceApi } from "./lib/api";
import { buildAppCommandActions } from "./components/app-command-actions";
import { isToolView, parseRoute, routePath } from "./lib/app-route";
import {
  APP_BODY,
  DETAIL_TOPBAR,
  DETAIL_TOPBAR_ACTIONS,
  DETAIL_TOPBAR_TITLE,
  DETAIL_TOPBAR_TITLE_TEXT,
  tabSplitDropPreviewClass,
} from "./lib/app-shell-classes";
import { appTopbarTitle } from "./lib/app-topbar-title";
import type { AppProps, PendingCreateDraft } from "./lib/app-types";
import { dropStagingAttachments } from "./lib/attachments";
import { NEW_SESSION_DRAFT_KEY, clearDraft, saveDraft } from "./lib/drafts";
import { DESK_FAB, MOBILE_FAB } from "./lib/fab-classes";
import { pickLandingSession } from "./lib/landing-session";
import { receiveMention, receiveMentionsCleared } from "./lib/mentions";
import type { NavigationActions } from "./lib/navigation";
import {
  errorMatchesPendingCreate,
  shouldApplyCreatedSessionReply,
  shouldOpenCreatedSession,
} from "./lib/new-session-navigation";
import { consumeNewSessionWorkspaceDraft } from "./lib/new-session-workspace-draft";
import { PERSISTENT_NOTICE_SHELF } from "./lib/notification-classes";
import {
  getPinNewSessions,
  getPinNewWorkspaces,
  getPins,
  onPinsChanged,
  pin,
  receivePins,
  unpin,
} from "./lib/pins";
import { PR_PAGE_COLUMN } from "./lib/pr-list-classes";
import { repoLabel } from "./lib/repo-label";
import { NO_REPO } from "./lib/session-repo";
import type { NewTabMorphOrigin } from "./lib/session-tabs-types";
import { SIDEBAR_CHROME_BTN } from "./lib/sidebar-classes";
import { useSidebarFilter } from "./lib/sidebar-filter";
import {
  nextRenderedSidebarChat,
  nextUnreadRenderedWorkspaceItem,
} from "./lib/sidebar-next";
import { ASK_BAND } from "./lib/sidebar-workspaces";
import { saveTabSplit } from "./lib/split-tabs";
import { getTabColors } from "./lib/tab-colors";
import { tabSplitPreviewStyle } from "./lib/tab-split-preview";
import { effectiveTheme } from "./lib/theme";
import type { UnifiedSession } from "./lib/types";
import { getWorkspaceLastSession } from "./lib/workspace-last-session";
import {
  sessionlessWorkspacePanes,
  viewTabKind,
} from "./lib/workspace-pane-tabs";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { EmptyState, LoadingState } from "./ui/state";
import { ToastHost, toast } from "./ui/toast";
import { Tooltip } from "./ui/tooltip";
import { TopBar, TopBarActions, TopBarTitle } from "./ui/top-bar";

export function AppContent({
  serviceWorker = true,
  initialTeamViewing = [],
}: AppProps = {}) {
  // The worker-parent bridge has to exist before routing initializes. Session
  // hydration happens later, and every Back entry point reads its latest value.
  const currentSessionRef = useRef<UnifiedSession | null>(null);
  const {
    route,
    getCurrentRoute,
    navigate,
    goBack: goBackRoute,
    leaveDeck,
    leaveSettings,
    forceFirstMile,
    requireFirstMile,
    openFirstMile,
    finishFirstMileNavigation,
    restoredSessionId,
    forgetLastSession,
    canonicalizePath,
  } = useAppRoute({ serviceWorker, currentUser: getCurrentUser });
  const goBack = () =>
    goBackRoute(currentSessionRef.current?.parentSessionId ?? undefined);
  const currentUser = useCurrentUser();
  const sidebarFilter = useSidebarFilter();
  const liveSessionsQuery = sidebarSessionsQuery({
    user: currentUser,
    person: sidebarFilter.person,
    repo: sidebarFilter.repo,
    autoCreated: sidebarFilter.autoCreated,
    ...(route.view === "session" ? { selectedSessionId: route.id } : {}),
    ...(route.view === "workspace" ? { selectedWorkspaceId: route.id } : {}),
  });
  const mainSocket = useWebSocket();
  const { connected, send, setTyping, addHandler } = mainSocket;
  const {
    sessions,
    loading,
    error: sessionsError,
    archivedLoaded,
    refreshArchived,
    refresh,
    inject,
    unstick,
    patch,
    remove,
  } = useSessions({
    loadArchived: route.view === "archived",
    liveQuery: liveSessionsQuery,
    socket: mainSocket,
  });
  const [launchComplete, setLaunchComplete] = useState(false);
  // Seeded from the repos this browser saw last (lib/repo-cache): PR-mention
  // chips need the registered set to resolve, so without it the first paint of
  // a transcript renders `opensession#128` as plain text and relinks a beat later.
  const [registeredRepoInfo, setRegisteredRepoInfo] = useState(cachedRepos);
  const onboarding = useOnboarding();
  const auth = useAuthStatus();
  const githubConnectionState = useGithubConnectionState(route.view);
  const sessionsRef = useRef(sessions);
  useLayoutEffect(() => {
    sessionsRef.current = sessions;
  });
  const pendingCreateDraftRef = useRef<PendingCreateDraft | null>(null);
  const [pendingInitialPrompts, setPendingInitialPrompts] = useState<
    Record<
      string,
      { content: string; user: string; sentAt: number; images?: string[] }
    >
  >({});
  // Transient toasts (e.g. "Link copied", "Archived · stopped the running
  // turn") route through the global toast store — stacked, animated, and
  // firable from anywhere without threading a prop. This wrapper keeps the
  // existing `onToast`/`showToast` call sites working.
  const showToast = useCallback((message: string) => {
    toast(message);
  }, []);
  useAppRegistries({ sessions, serviceWorker, setRegisteredRepoInfo });
  const appShell = useAppShell();
  const {
    pane: { detailPaneRef, detailPaneEl, captureDetailPane },
    sidebar: {
      sidebarCollapsed,
      toggleSidebarCollapsed,
      sidebarWidth,
      sidebarColRef,
      startSidebarResize,
    },
    desktopTopbar: {
      topbarEl,
      setTopbarEl,
      topbarActionsEl,
      setTopbarActionsEl,
    },
    mobileTopbar: {
      appHeaderEl,
      setAppHeaderEl,
      headerModelEl,
      setHeaderModelEl,
      headerRepoEl,
      setHeaderRepoEl,
      headerActionsEl,
      setHeaderActionsEl,
    },
    rightPanel: { rightPanelEl, setRightPanelEl },
  } = appShell;
  // A session we've just navigated to that may not be in the polled list yet
  // (create → navigate races the async refresh; the server persists the file
  // before session_created, so this window is just one list fetch). While
  // pending, the detail pane shows a "Starting…" state instead of flashing
  // "Session not found". pendingNewWorkspace words it for a brand-new
  // workspace vs. a session added to an existing one.
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [newTabMorph, setNewTabMorph] = useState<{
    id: string;
    origin: NewTabMorphOrigin;
  } | null>(null);
  const { clearNewTabMorphTimer, startNewTabMorphTimer } =
    useNewTabMorphTimer(setNewTabMorph);
  // Keep the complete local shell beside the route until persistence lands.
  // The session list and detail fetches are independent, so neither should be
  // allowed to substitute the previous session while this id is still local.
  const [optimisticSession, setOptimisticSession] =
    useState<UnifiedSession | null>(null);
  // A deleted blank can reappear in a sessions poll that started before its
  // DELETE finished. Hide it for this page's lifetime so leaving stays final.
  const [hiddenEmptySessionIds, setHiddenEmptySessionIds] = useState<
    Set<string>
  >(() => new Set());
  const [pendingNewWorkspace, setPendingNewWorkspace] = useState(false);
  // Who's viewing what, app-wide (from global_presence).
  const [teamViewing, setTeamViewing] =
    useState<Array<{ user: string; sessionId: string }>>(initialTeamViewing);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const replacePendingTimer = (callback: () => void, delay: number) => {
    clearTimeout(pendingTimer.current);
    pendingTimer.current = setTimeout(callback, delay);
  };
  const [pins, setPins] = useState<string[]>(getPins);
  const [tabColors, setTabColors] =
    useState<Record<string, string>>(getTabColors);
  // Workspaces (containers that group sessions) power the sidebar rows and the
  // workspace-scoped tab strip.
  const {
    workspaces,
    loaded: workspacesLoaded,
    refresh: refreshWorkspaces,
  } = useWorkspaces();
  // Read by the PR-link opener, which runs from a document-level listener and
  // therefore can't close over the render's value.
  const workspacesRef = useRef(workspaces);
  useLayoutEffect(() => {
    workspacesRef.current = workspaces;
  });
  const productEmpty =
    !loading &&
    workspacesLoaded &&
    sessions.length === 0 &&
    workspaces.length === 0;
  const firstMileActive = forceFirstMile || onboarding.state === "required";
  useEffect(() => {
    if (onboarding.state !== "required" || forceFirstMile) return;
    requireFirstMile();
  }, [onboarding.state, forceFirstMile, requireFirstMile]);

  async function finishFirstMile() {
    try {
      await onboarding.complete();
    } catch (cause) {
      toast(
        cause instanceof Error ? cause.message : "Could not finish onboarding",
        {
          variant: "error",
        },
      );
      return;
    }
    finishFirstMileNavigation();
  }

  // Subscribe to the per-user pin/color stores. Both hydrate async at module
  // load, and on a fast localhost that load() can resolve (and emit) before
  // this effect ever subscribes — so re-sync once here, or the initial empty
  // state sticks and pinned tabs vanish until the next change event.
  useEffect(() => {
    const unsub = onPinsChanged(() => setPins(getPins()));
    setPins(getPins());
    return unsub;
  }, []);

  // Drop the pins made stale by archiving `justArchived`, mirroring the
  // server's unpinArchivedSessions: each session's own id + alias ids, plus a
  // `workspace:<id>` pin once none of that workspace's sessions are live anymore.
  // The server already does this, but our pin cache is optimistic and never
  // hears about that write — without this a later savePinsApi re-uploads the
  // stale list and resurrects the archived pin as an unreachable ghost row.
  const dropStalePins = (justArchived: UnifiedSession[]) => {
    if (!justArchived.length) return;
    const archivedIds = new Set(justArchived.map((s) => s.id));
    const all = sessionsRef.current;
    const keys: string[] = [];
    const workspaceIds = new Set<string>();
    for (const s of justArchived) {
      keys.push(s.id, ...(s.aliasIds || []));
      if (s.workspaceId) workspaceIds.add(s.workspaceId);
    }
    for (const pid of workspaceIds) {
      const hasLive = all.some(
        (s) => s.workspaceId === pid && !s.archived && !archivedIds.has(s.id),
      );
      if (!hasLive) keys.push(`workspace:${pid}`);
    }
    setPins(unpin(keys));
  };

  const documentInteractions = useAppDocumentInteractions({
    route,
    sidebarFilter,
    navigate,
    goBack,
    detailPaneRef,
    sessions,
    connected,
    setTabColors,
  });
  const {
    settingsActive,
    isPhone,
    borrowedSidebar,
    mobileDetail,
    sidebarRef,
    nextChatRef,
    nextChatAvailable,
    setNextChatAvailable,
    openPrRef,
  } = documentInteractions;

  // The "new session" ⌘K palette. It's an overlay driven by its own state (not a
  // route), so it can open over any view; the <base>/new route still opens it
  // so old links keep working.
  const modelWorkspaceId =
    route.view === "workspace"
      ? route.id
      : route.view === "session"
        ? (sessions.find((session) => session.id === route.id)?.workspaceId ??
          undefined)
        : undefined;
  const {
    palette,
    paletteOpenRef,
    openPalette,
    openPrefilledSession,
    hidePalette,
    restorePalette: restorePaletteState,
  } = useNewSessionPalette({
    initiallyOpen: route.view === "new",
    initialPrompt: route.view === "new" ? route.prompt : undefined,
    modelWorkspaceId,
  });
  const restorePalette = useEffectEvent(restorePaletteState);
  // Bumped by the sidebar's draft row to put the caret back in the empty
  // state's session input. The row and that card are the same unstarted
  // session seen from two places.
  const [draftFocusSeq, setDraftFocusSeq] = useState(0);

  const appViewState = useAppViewState({
    route,
    navigate,
    sessionsRef,
    workspacesRef,
    refreshWorkspaces,
    openPrRef,
    addHandler,
  });
  const {
    newSessionSeq,
    activeViewTab,
    setActiveViewTabState,
    reviewActive,
    conversationActive,
    videoActive,
    stagingActive,
    assetsActive,
    previewLiveActive,
    portalActive,
    terminalActive,
    subagentSelected,
    reviewOpen,
    setReviewOpen,
    reviewClosed,
    setReviewClosed,
    conversationClosed,
    setConversationClosed,
    videoClosed,
    setVideoClosed,
    routeSubagentStack,
    openSubagentPath,
    stackFor,
    openSubagent,
    popSubagent,
    closeSubagentTab,
    nameSubagent,
    splitDropSide,
    setSplitDropSide,
    pendingReviewOpen,
    setPendingReviewOpen,
    reviewFocusPr,
    focusReviewPr,
    suppressWsSeedRef,
    focusComposerOnOpen,
    setFocusComposerOnOpen,
    sessionComposerPrefills,
    setSessionComposerPrefills,
    addToSessionInput,
    commandMenuRef,
    deskOverlay,
    setDeskOverlay,
    shortcutsOpen,
    setShortcutsOpen,
    taskCount,
  } = appViewState;
  const { closePalette, startNewSessionCreate } = useNewSessionCreateStart({
    getCurrentRoute,
    navigate,
    goBack,
    hidePalette,
    inject,
    unstick,
    pendingCreateDraftRef,
    pendingTimer,
    setActiveViewTabState,
    setOptimisticSession,
    setPendingInitialPrompts,
    setPendingNewWorkspace,
    setPendingSessionId,
  });

  const copyLinkPathRef = useAppGlobalHotkeys({
    commandMenuRef,
    paletteOpenRef,
    openPalette,
    closePalette,
    toggleSidebarCollapsed,
    showToast,
    setDeskOverlay,
    setShortcutsOpen,
  });

  const { listedSession, currentSession } = useActiveSession({
    route,
    sessions,
    optimisticSession,
    loading,
    restoredSessionId,
    forgetLastSession,
    navigate,
    setLaunchComplete,
  });

  // When a session is created from the New Session form or Ask box, jump straight into it
  // The handler reads `inject`/`navigate` through effect events, so the
  // subscription doesn't re-arm just because their closures moved.
  const socketInject = useEffectEvent(inject);
  const socketNavigate = useEffectEvent(navigate);
  const socketGetCurrentRoute = useEffectEvent(getCurrentRoute);
  useEffect(() => {
    return addHandler((msg) => {
      if (msg.type === "error") {
        const draft = pendingCreateDraftRef.current;
        const errorSessionId = "sessionId" in msg ? msg.sessionId : undefined;
        if (draft && errorMatchesPendingCreate(errorSessionId, draft.id)) {
          pendingCreateDraftRef.current = null;
          clearTimeout(pendingTimer.current);
          setPendingSessionId((pending) =>
            pending === draft.id ? null : pending,
          );
          setOptimisticSession((pending) =>
            pending?.id === draft.id ? null : pending,
          );
          setPendingInitialPrompts((current) => {
            if (!current[draft.id]) return current;
            const next = { ...current };
            delete next[draft.id];
            return next;
          });
          unstick(draft.id);
          remove(draft.id);
          if (draft.openImmediately) {
            // The accepted send cleared the global composer immediately. Put
            // its submitted payload back before reopening only when creation
            // itself fails, so recovery never holds the normal path hostage.
            saveDraft(NEW_SESSION_DRAFT_KEY, {
              text: draft.prompt,
              images: draft.images ?? [],
              files: draft.files ?? [],
            });
            const currentRoute = socketGetCurrentRoute();
            if (currentRoute.view === "session" && currentRoute.id === draft.id)
              socketNavigate(parseRoute(draft.originPath));
            restorePalette();
            toast(msg.message || "Couldn't create the session.");
          }
          return;
        }
      }
      if (msg.type === "pins_changed") {
        receivePins(msg.user, msg.pins);
        return;
      }
      if (msg.type === "mention") {
        receiveMention(msg.user, msg.mention);
        return;
      }
      if (msg.type === "mentions_cleared") {
        receiveMentionsCleared(msg.user, msg.sessionId);
        return;
      }
      if (msg.type === "global_presence") {
        setTeamViewing(msg.viewing);
        return;
      }
      if (msg.type === "session_created") {
        const pendingDraft = pendingCreateDraftRef.current;
        // A session-room announcement can arrive from restart recovery through
        // a watch that was in flight while the person changed routes. It is not
        // the reply to this browser's create, so it neither consumes that draft
        // nor gets to take the foreground.
        const roomScoped = "sessionId" in msg;
        const draft = pendingDraft?.id === msg.id ? pendingDraft : null;
        if (draft) {
          pendingCreateDraftRef.current = null;
          // The default create unmounts NewSession before this reply. Consume
          // its parked workspace here so the next global create cannot reuse it
          // as an existing workspace and appear as another tab.
          if (draft.workspaceId)
            consumeNewSessionWorkspaceDraft(draft.workspaceId);
        }
        if (!shouldApplyCreatedSessionReply(msg.replayed, !!draft)) {
          // The durable command outbox replayed a create that this page already
          // finished. Its real row may be live or archived; either way the lists,
          // not a repo-less optimistic shell, are the authority now.
          refresh();
          refreshWorkspaces();
          return;
        }
        const openedOptimistically =
          draft?.openImmediately === true && draft.id === msg.id;
        if (openedOptimistically) {
          clearDraft(NEW_SESSION_DRAFT_KEY);
          dropStagingAttachments(NEW_SESSION_DRAFT_KEY);
          clearTimeout(pendingTimer.current);
          setPendingSessionId((pending) =>
            pending === msg.id ? null : pending,
          );
          setPendingNewWorkspace(false);
          setOptimisticSession((pending) =>
            pending?.id === msg.id ? null : pending,
          );
          patch(msg.id, {
            workspaceId: msg.workspaceId || draft.workspaceId || null,
            workspacePreparing: !!msg.preparingWorkspace,
          });
        }
        const stillOwnsForeground = shouldOpenCreatedSession(
          draft,
          routePath(socketGetCurrentRoute()),
          paletteOpenRef.current,
          roomScoped,
        );
        // Pin the just-created session for its creator (this WS reply is
        // creator-only, so it never pins a teammate's new session onto my bar).
        // Per-browser prefs in Settings: new sessions/sessions pin on by
        // default; new workspaces are heavier, so they have their own
        // pref that's off by default.
        const shouldPin = msg.newWorkspace
          ? getPinNewWorkspaces()
          : getPinNewSessions();
        if (shouldPin) setPins(pin(msg.id));
        if (!sessionsRef.current.some((s) => s.id === msg.id)) {
          const now = new Date().toISOString();
          const user = draft?.user || getCurrentUser();
          const createdAt = draft?.startedAt || now;
          socketInject(
            {
              id: msg.id,
              claudeSessionId: null,
              source: "opensession",
              branch: draft?.branch ?? null,
              worktreeDir: null,
              startedBy: user,
              title: msg.newWorkspace
                ? "New workspace"
                : draft?.workspaceId
                  ? "New session"
                  : "New session",
              lastActivity: now,
              createdAt,
              isRunning: true,
              runStartedAt: now,
              transcriptPath: null,
              mode: draft?.mode,
              repo: draft?.repo,
              workspaceId: msg.workspaceId || draft?.workspaceId || null,
              model: draft?.model,
              archived: false,
              // Worktree prep still running server-side — the viewer opens
              // straight into its "Waiting for workspace" state.
              workspacePreparing: !!msg.preparingWorkspace,
            },
            // Keep the optimistic copy alive across polls until the server
            // registers it, so the new tab renders straight away instead of
            // flashing "Starting…" — matters most for a new workspace, whose
            // worktree prep can take several polls to land.
            { sticky: true },
          );
        }
        if (draft?.prompt || draft?.images?.length) {
          setPendingInitialPrompts((prev) => ({
            ...prev,
            [msg.id]: {
              content: draft.prompt,
              user: draft.user,
              sentAt: new Date(draft.startedAt).getTime(),
              ...(draft.images?.length ? { images: draft.images } : {}),
            },
          }));
          window.setTimeout(() => {
            setPendingInitialPrompts((prev) => {
              if (!prev[msg.id]) return prev;
              const next = { ...prev };
              delete next[msg.id];
              return next;
            });
          }, 120_000);
        }
        if (!openedOptimistically) {
          // Mark it pending so the viewer shows "Starting…" until the poll
          // catches up; a fallback timeout clears it so a failed create can't
          // stick — including dropping the sticky optimistic copy above.
          setPendingSessionId(msg.id);
          setPendingNewWorkspace(!!msg.newWorkspace);
          clearTimeout(pendingTimer.current);
          pendingTimer.current = setTimeout(() => {
            setPendingSessionId(null);
            unstick(msg.id);
          }, 30000);
        }
        refresh();
        refreshWorkspaces();
        if (stillOwnsForeground)
          socketNavigate({ view: "session", id: msg.id });
      }
    });
  }, [
    addHandler,
    paletteOpenRef,
    patch,
    refresh,
    refreshWorkspaces,
    remove,
    unstick,
  ]);

  // Drop the pending flag once we've navigated away from the pending session (its
  // fallback timeout clears it otherwise). We deliberately DON'T clear it the
  // instant the session first shows up in the list: a poll that predates the
  // create can momentarily drop the just-injected copy again, and clearing here
  // would flash "Session not found" in that gap. Keeping the flag set masks the
  // gap with the "Starting…" state until the next poll re-adds the session (or
  // the timeout fires on a genuinely failed create).
  useEffect(() => {
    if (
      pendingSessionId &&
      !(route.view === "session" && route.id === pendingSessionId)
    ) {
      setPendingSessionId(null);
      clearTimeout(pendingTimer.current);
      // Drop its sticky status now that we've left (and cancelled the 30s
      // fallback). A real session is retained by the next poll; a phantom
      // from a failed create is reconciled away instead of lingering.
      unstick(pendingSessionId);
      setOptimisticSession((pending) =>
        pending?.id === pendingSessionId ? null : pending,
      );
    }
  }, [route, pendingSessionId, unstick]);

  const workspacePanes = useWorkspacePanes({
    route,
    navigate,
    sessions,
    workspaces,
    currentSession,
    loading,
    workspacesLoaded,
    refreshWorkspaces,
    sessionsRef,
    workspacesRef,
    currentSessionRef,
    viewState: appViewState,
  });
  const {
    wsKeyFor,
    routeWorkspaceId,
    routeWorkspace,
    wsKey,
    wsRecord,
    setActiveViewTab,
    stagingOpen,
    previewTabOpen,
    assetsOpen,
    terminalOpen,
    currentPortalTarget,
    openStaging,
    closeStagingTab,
    openPreviewTab,
    closePreviewTab,
    openAssets,
    closeAssetsTab,
    openTerminal,
    closeTerminalTab,
    openPortal,
    closePortalTab,
    prRefMissing,
    conversationThreadId,
    videoRef,
    videoPanel,
    subagentStack,
    subagentActive,
    paneViewTabs,
    openWsPanes,
    selectViewTab,
    openReview,
    closeReviewTab,
    closeConversationTab,
    closeVideoTab,
    openPrWorkspace,
    openPrReview,
    openFeedItemWorkspace,
    openTicketWorkspace,
    openReviewForSession,
  } = workspacePanes;

  const sessionTabs = useSessionTabs({
    routing: {
      route,
      navigate,
      getCurrentRoute,
      canonicalizePath,
      forgetLastSession,
      goBack,
    },
    source: {
      currentSession,
      currentSessionRef,
      sessions,
      sessionsRef,
      workspaces,
      currentUser,
      teamViewing,
    },
    layout: { isPhone, detailPaneRef, tabColors, setTabColors },
    localTabs: {
      hiddenEmptySessionIds,
      setHiddenEmptySessionIds,
      newTabMorph,
      setNewTabMorph,
      clearNewTabMorphTimer,
      startNewTabMorphTimer,
    },
    pending: {
      pendingTimer,
      replacePendingTimer,
      pendingSessionId,
      setPendingSessionId,
      setPendingNewWorkspace,
      setOptimisticSession,
      copyLinkPathRef,
    },
    sessionStore: { inject, patch, refresh, remove, unstick },
    actions: {
      refreshWorkspaces,
      openPrefilledSession,
      showToast,
      dropStalePins,
    },
    view: {
      activeViewTab: appViewState.activeViewTab,
      setActiveViewTabState: appViewState.setActiveViewTabState,
      subagentSelected: appViewState.subagentSelected,
      openSubagentPath: appViewState.openSubagentPath,
      closeSubagentTab: appViewState.closeSubagentTab,
      splitDropSide: appViewState.splitDropSide,
      setSplitDropSide: appViewState.setSplitDropSide,
      suppressWsSeedRef: appViewState.suppressWsSeedRef,
    },
    panes: {
      state: {
        routeWorkspaceId: workspacePanes.routeWorkspaceId,
        routeWorkspace: workspacePanes.routeWorkspace,
        wsKey: workspacePanes.wsKey,
        wsRecord: workspacePanes.wsRecord,
        paneViewTabs: workspacePanes.paneViewTabs,
        openWsPanes: workspacePanes.openWsPanes,
        subagentStack: workspacePanes.subagentStack,
      },
      actions: {
        setActiveViewTab: workspacePanes.setActiveViewTab,
        selectViewTab: workspacePanes.selectViewTab,
        closeStagingTab: workspacePanes.closeStagingTab,
        closeAssetsTab: workspacePanes.closeAssetsTab,
        closeTerminalTab: workspacePanes.closeTerminalTab,
        closePreviewTab: workspacePanes.closePreviewTab,
        closePortalTab: workspacePanes.closePortalTab,
        closeConversationTab: workspacePanes.closeConversationTab,
        closeVideoTab: workspacePanes.closeVideoTab,
        closeReviewTab: workspacePanes.closeReviewTab,
      },
    },
  });
  const {
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
  } = sessionTabs;

  const topbarTitle = appTopbarTitle(route, routeWorkspace);

  // Whether the bar is holding that name yet. It stays quiet while the page
  // below heads itself with the same word, and picks the name up once that
  // heading has scrolled under it. A route whose page does not name itself
  // (a workspace, or the New session dialog over whatever page was already
  // open) reads true from the start and is labelled as it always was.
  const titleHandedOver = useLargeTitleHandoff(topbarEl, topbarTitle);
  const phoneTitleHandedOver = useLargeTitleHandoff(appHeaderEl, topbarTitle);

  // The "toggle left sidebar" panel glyph — a framed rectangle with a divider
  // marking the collapsible left column. Reused by the brand-row collapse button
  // and the floating re-open control. Sized to match the right-panel toggle
  // (IconSidebarRight) in the session header, and to carry the same visual
  // weight as the fuller play/globe glyphs there (a framed rectangle reads a
  // hair lighter than a filled triangle / globe at the same nominal size).
  const panelIcon = <IconSidebarLeft size={24} />;
  const sidebarToggleKeys = useShortcutKeys("sidebar-toggle");
  // Rendered rows are the navigation order. Filters, grouping and collapsed
  // sections all change that order, so backing session arrays cannot answer
  // which chat is actually next on screen. Ready unread work stays the priority;
  // when none exists, continue from the selected chat instead.
  const openNextChat = () => {
    const sidebar = document.querySelector("[data-sidebar-list]");
    const workspaceItems = Array.from(
      sidebar?.querySelectorAll<HTMLButtonElement>("button[data-ws-row]") ?? [],
    );
    const renderedItems = Array.from(
      sidebar?.querySelectorAll<HTMLButtonElement>(
        "button[data-sidebar-row]",
      ) ?? [],
    );
    const next =
      nextUnreadRenderedWorkspaceItem(workspaceItems) ??
      nextRenderedSidebarChat(renderedItems);
    if (!next) return;
    next.scrollIntoView({ block: "nearest" });
    next.click();
  };
  const currentTheme = effectiveTheme();
  const commandActions = buildAppCommandActions({
    auth,
    currentSession,
    currentTheme,
    copyLinkPath,
    isPhone,
    nextChatAvailable,
    openNextChat,
    restorableArchived,
    sidebarCollapsed,
    navigate,
    openPalette,
    handleNewSession,
    closeSession,
    unarchiveSession,
    reopenLastArchived,
    setDeskOverlay,
    toggleSidebarCollapsed,
    showToast,
  });
  const openSession = (id: string, created?: UnifiedSession | null) => {
    // Opening a session means foregrounding its chat tab. Callers inside a
    // workspace pane can navigate to the already-current id, so navigation
    // alone would leave Review (or another pane) selected.
    setActiveViewTab(null);
    const known = sessions.some(
      (session) => session.id === id || session.aliasIds?.includes(id),
    );
    if (!known) {
      // A caller that just created the session (Auto-fix) hands us the server's
      // own copy — its file is written before the response — so drop it
      // straight into the list and open the real session as a new tab instead of
      // flashing "Starting a new session…" until the next poll. Sticky so an
      // in-flight poll that predates the create can't take it away again.
      if (created) inject(created, { sticky: true });
      else {
        setPendingSessionId(id);
        setPendingNewWorkspace(false);
        clearTimeout(pendingTimer.current);
        pendingTimer.current = setTimeout(
          () => setPendingSessionId(null),
          30000,
        );
      }
      refresh();
    }
    navigate({ view: "session", id });
  };
  const openWorkspace = (id: string, preferredSessionId?: string) => {
    // A bold workspace row names the unread session explicitly. Otherwise
    // restore the session tab that was last active in this workspace.
    const session = pickLandingSession(
      sessions,
      id,
      preferredSessionId ?? getWorkspaceLastSession(id),
    );
    const opensPreferredSession = session?.id === preferredSessionId;
    // Every session closed but a pane still open: land on the pane rather than
    // resurrecting the newest archived session (pickLandingSession's history fallback).
    const panes = session?.archived
      ? sessionlessWorkspacePanes(
          id,
          workspaces.find((workspace) => workspace.id === id) ?? null,
          {
            reviewOpen,
            reviewClosed,
            conversationClosed,
            videoClosed,
            hasWebPanel: (workspace) =>
              !!workspace.externalRefs?.some((ref) => refWebPanel(ref)),
          },
        )
      : [];
    const remembered = getActiveViewTab(id);
    const pane = panes.find((item) => item === remembered) ?? panes[0] ?? null;
    if (pane && !opensPreferredSession) {
      setActiveViewTabState(pane);
      setFocusComposerOnOpen(false);
      navigate({ view: "workspace", id, tab: pane });
    } else if (session) {
      const rememberedTab = opensPreferredSession
        ? null
        : (getActiveViewTab(id) ?? null);
      setActiveViewTabState(rememberedTab);
      if (opensPreferredSession) saveActiveViewTab(id, null);
      setFocusComposerOnOpen(rememberedTab === null);
      navigate({ view: "session", id: session.id });
    } else {
      const workspace = workspaces.find((item) => item.id === id);
      // A draft workspace has no session and no other pane, but it isn't
      // "nothing to open": WorkspacePane is its home, prefilled from the draft.
      if (workspace?.draft) {
        navigate({ view: "workspace", id });
        return;
      }
      // Default the new session onto the workspace's branch when it has one.
      openPrefilledSession({
        workspaceId: id,
        repo: workspace?.repo,
        branch: workspace?.branch,
        ...(workspace?.externalRefs?.length && !workspace?.repo
          ? { mode: "scratch" as const }
          : {}),
      });
    }
  };
  const openNewSessionInRepo = (repo: string) => {
    // The Ask band's "+" is not a repo: open Ask with the repo turned off.
    openPrefilledSession(
      repo === ASK_BAND ? { repo: NO_REPO, mode: "ask" as const } : { repo },
    );
  };
  const openDraft = () => {
    // The row and panel card are one unstarted session. Return to the panel and
    // focus its composer when another view is open.
    if (route.view !== "prs") navigate({ view: "prs" });
    setDraftFocusSeq((seq) => seq + 1);
  };
  useLayoutEffect(() => {
    nextChatRef.current = openNextChat;
  });
  const renderSessionPane = (
    viewerSession: UnifiedSession,
    socket: ReturnType<typeof useWebSocket>,
    focused: boolean,
    splitMode: boolean,
    requestedSurfaceId?: string,
  ) => (
    <AppSessionPane
      surface={{
        viewerSession,
        socket,
        focused,
        splitMode,
        requestedSurfaceId,
      }}
      pending={{
        route,
        auth,
        nextChatAvailable,
        pendingSessionId,
        pendingNewWorkspace,
      }}
      data={{
        pendingInitialPrompts,
        sidebarRef,
        sessions,
        workspaces,
        patch,
        refresh,
      }}
      portals={{
        topbarEl,
        headerActionsEl,
        headerModelEl,
        headerRepoEl,
        rightPanelEl,
      }}
      composer={{
        newSessionSeq: appViewState.newSessionSeq,
        focusComposerOnOpen: appViewState.focusComposerOnOpen,
        sessionComposerPrefills: appViewState.sessionComposerPrefills,
        setSessionComposerPrefills: appViewState.setSessionComposerPrefills,
      }}
      visibility={{
        reviewActive: appViewState.reviewActive,
        conversationActive: appViewState.conversationActive,
        videoActive: appViewState.videoActive,
        stagingActive: appViewState.stagingActive,
        assetsActive: appViewState.assetsActive,
        terminalActive: appViewState.terminalActive,
        previewLiveActive: appViewState.previewLiveActive,
        portalActive: appViewState.portalActive,
        reviewFocusPr: appViewState.reviewFocusPr,
      }}
      subagents={{
        openSubagent: appViewState.openSubagent,
        popSubagent: appViewState.popSubagent,
        nameSubagent: appViewState.nameSubagent,
        stackFor: appViewState.stackFor,
      }}
      panes={{
        wsKey: workspacePanes.wsKey,
        conversationThreadId: workspacePanes.conversationThreadId,
        videoPanel: workspacePanes.videoPanel,
        videoRef: workspacePanes.videoRef,
        currentPortalTarget: workspacePanes.currentPortalTarget,
        subagentActive: workspacePanes.subagentActive,
        terminalOpen: workspacePanes.terminalOpen,
        closeStagingTab: workspacePanes.closeStagingTab,
        closePreviewTab: workspacePanes.closePreviewTab,
        closeAssetsTab: workspacePanes.closeAssetsTab,
        closeTerminalTab: workspacePanes.closeTerminalTab,
      }}
      tabs={{
        context: {
          activeWorkspaceId,
          workspaceSessions,
          emptyWorkspaceSession,
        },
        archive: { archivedSessions, restoreSession, rememberArchived },
        sessions: {
          setSessionLanes,
          closeSession,
          handleSessionRunningChange,
        },
        workspaces: {
          renameWorkspace,
          archiveWorkspaceFromHeader,
          deleteWorkspaceFromHeader,
        },
        tabStripVisible,
      }}
    />
  );

  const navigationActions = {
    goBack,
    openNextChat,
    openPrs: () => navigate({ view: "prs" }),
    openFeed: () => navigate({ view: "feed" }),
    openSettings: (section) => navigate({ view: "settings", section }),
    openTasks: () => navigate({ view: "tasks" }),
    openAutomation: (name) => navigate({ view: "automations", id: name }),
    openPrItem: openPrWorkspace,
    openPlain: () => navigate({ view: "plain" }),
    openSupportTinder: () => navigate({ view: "supporttinder" }),
    openReports: (target) => navigate({ view: "reports", ...target }),
    openAnalytics: () => navigate({ view: "analytics" }),
    openArchived: () => navigate({ view: "archived" }),
    openCatchUp: () => navigate({ view: "catchup" }),
    openSession,
    openWorkspace,
    openSessionReview: openReviewForSession,
    openTicket: openTicketWorkspace,
    openFeedItem: openFeedItemWorkspace,
    openPr: (repo, branch) => navigate({ view: "pr", repo, branch }),
    openNewWorkspace: () => openPalette(),
    openNewSessionInRepo,
    openDraft,
    openNewSessionInWorkspace: (mode, origin) =>
      handleNewSession(mode, null, origin),
    duplicateSession: () => handleNewSession("share", null, undefined, true),
    startNewChat: (session, prompt) =>
      openNewSessionInWorkspace(session, "share", prompt),
    openPrefilledSession,
    openReview,
    openStaging,
    openPreview: openPreviewTab,
    openPortal,
    openAssets,
    openTerminal,
    openCurrentWorkspace: () => setActiveViewTab(null),
  } satisfies NavigationActions;

  const content = (
    <UserGate>
      <RestartOverlay connected={connected} addHandler={addHandler} />
      <MediaLightboxHost />
      <ToastHost container={settingsActive ? null : detailPaneEl} />
      <RunningCloseDialog {...runningCloseDialog} />
      <div className="app">
        {!forceFirstMile && onboarding.state === "loading" ? (
          <div className="flex h-[100dvh] items-center justify-center bg-bg">
            <LoadingState>Preparing Open Session…</LoadingState>
          </div>
        ) : !forceFirstMile && onboarding.state === "failed" ? (
          <div className="flex h-[100dvh] flex-col items-center justify-center gap-4 bg-bg px-6 text-center">
            <LoadingState>Couldn&rsquo;t check onboarding.</LoadingState>
            <Button onClick={() => void onboarding.refetch()}>Try again</Button>
          </div>
        ) : firstMileActive ? (
          <FirstMile onDone={finishFirstMile} />
        ) : (
          <>
            <AppMobileHeader
              route={route}
              mobileDetail={mobileDetail}
              currentSession={currentSession}
              activeWorkspaceId={activeWorkspaceId}
              workspaces={workspaces}
              connected={connected}
              addHandler={addHandler}
              navigate={navigate}
              goBack={goBack}
              topbarTitle={topbarTitle}
              phoneTitleHandedOver={phoneTitleHandedOver}
              commandMenuRef={commandMenuRef}
              setAppHeaderEl={setAppHeaderEl}
              setHeaderRepoEl={setHeaderRepoEl}
              setHeaderModelEl={setHeaderModelEl}
              setHeaderActionsEl={setHeaderActionsEl}
            />

            {settingsActive && (
              <Settings
                onBack={leaveSettings}
                onOpenOnboarding={openFirstMile}
                workspace={
                  settingsWorkspaceId
                    ? workspaces.find(
                        (workspace) => workspace.id === settingsWorkspaceId,
                      )
                    : undefined
                }
                section={
                  route.view === "settings"
                    ? route.section
                    : isToolView(route.view)
                      ? route.view
                      : undefined
                }
                onShowRoot={() => navigate({ view: "settings" })}
                onSelect={(key) =>
                  isToolView(key)
                    ? navigate({ view: key })
                    : navigate({ view: "settings", section: key })
                }
              >
                {route.view === "automations" ? (
                  <Automations
                    onOpenSession={(id) => navigate({ view: "session", id })}
                    selectedId={route.id}
                    onSelect={(id) =>
                      navigate({ view: "automations", id: id || undefined })
                    }
                  />
                ) : route.view === "security" ? (
                  <Security
                    onOpenSession={(id) => navigate({ view: "session", id })}
                  />
                ) : route.view === "goals" ? (
                  <Goals
                    onOpenSession={(id) => navigate({ view: "session", id })}
                    selectedId={route.id}
                    onSelect={(id) =>
                      navigate({ view: "goals", id: id || undefined })
                    }
                  />
                ) : null}
              </Settings>
            )}
            {/* On phones the app-body stays mounted beneath the Settings sheet
				    (the sheet floats over the root list); on desktop Settings is a
				    full page and replaces it. */}
            {(!settingsActive || isPhone) && (
              <div
                className={cn(
                  APP_BODY,
                  /* `mobile-detail` / `mobile-root` and `sidebar-collapsed` stay as
						   state hooks: the pane, the workspace shell and the session
						   header all read them from an ancestor, and base.css hides the
						   WCO nav pane by the same pair. */
                  mobileDetail ? "mobile-detail" : "mobile-root",
                  sidebarCollapsed && "sidebar-collapsed",
                )}
              >
                <AppSidebar
                  data={{
                    route,
                    sessions,
                    registeredRepoInfo,
                    sessionsError,
                    loading,
                    refresh,
                    workspacesLoaded,
                    workspaces,
                    teamViewing,
                    listedSession,
                    connected,
                    productEmpty,
                    githubConnectionState,
                  }}
                  appearance={{
                    mobileDetail,
                    showToast,
                    panelIcon,
                    sidebarToggleKeys,
                  }}
                  shell={{
                    sidebarCollapsed,
                    toggleSidebarCollapsed,
                    sidebarWidth,
                    sidebarColRef,
                    startSidebarResize,
                    headerActionsEl,
                  }}
                  interactions={{
                    isPhone,
                    sidebarRef,
                    setNextChatAvailable,
                  }}
                  navigation={{
                    taskCount: appViewState.taskCount,
                    commandMenuRef: appViewState.commandMenuRef,
                    sidebarWorkspaceId,
                    renameWorkspaceFromSidebar,
                    deleteWorkspaceFromSidebar,
                    archiveSessionFromSidebar,
                    archiveWorkspaceFromSidebar,
                    setSessionLanes,
                  }}
                />
                <AppShell
                  paneRef={captureDetailPane}
                  rightPanelRef={setRightPanelEl}
                >
                  {/* Floating re-open control, shown only while the desktop sidebar
						    is collapsed (CSS-gated). Mirrors the brand-row toggle so the
						    sidebar can always be brought back. */}
                  <Tooltip
                    label="Show sidebar"
                    side="right"
                    shortcut={["⌘", "B"]}
                  >
                    {/* `sidebar-reopen` stays as a hook: base.css exempts it from the
							    desktop shell's drag region and re-anchors it past the
							    traffic lights. `top` matches the open row's center,
							    accounting for its 1px bottom divider; `left` is the same 8px
							    anchor the open sidebar's brand row uses. */}
                    <button
                      className={cn(
                        SIDEBAR_CHROME_BTN,
                        "sidebar-reopen absolute top-[calc((var(--desktop-header-h)-35px)/2)] left-2 z-20 hidden size-[34px] p-0",
                        sidebarCollapsed && "desktop:inline-flex",
                      )}
                      onClick={toggleSidebarCollapsed}
                      aria-label="Show sidebar"
                    >
                      {panelIcon}
                    </button>
                  </Tooltip>
                  {/* Top bar: session name + actions (portaled in by SessionViewer)
						    on session routes, a plain title otherwise. Sits above the tab
						    strip so the session identity reads first, tabs below it. */}
                  <TopBar className={DETAIL_TOPBAR} ref={setTopbarEl}>
                    {route.view !== "session" &&
                      // A workspace portals in the same header row a session
                      // does (WorkspacePane) rather than taking the plain title.
                      !(route.view === "workspace" && routeWorkspace) &&
                      topbarTitle && (
                        // Where you are, not the page's heading: these routes are
                        // pages, and a page keeps its name in its body. The bar picks
                        // that name up once it has scrolled out of sight, the way the
                        // chat header names the session. See hooks/useLargeTitle.ts.
                        <TopBarTitle
                          className={cn(
                            DETAIL_TOPBAR_TITLE,
                            (route.view === "prs" || route.view === "feed") &&
                              PR_PAGE_COLUMN,
                          )}
                        >
                          <span
                            className={DETAIL_TOPBAR_TITLE_TEXT}
                            data-shown={titleHandedOver || undefined}
                          >
                            {topbarTitle}
                          </span>
                          {/* Filled by the page, if it has controls to put here. */}
                          <TopBarActions
                            className={cn(
                              DETAIL_TOPBAR_ACTIONS,
                              (route.view === "prs" ||
                                route.view === "archived") &&
                                "ml-4 flex-1 pl-0",
                            )}
                            ref={setTopbarActionsEl}
                          />
                        </TopBarTitle>
                      )}
                  </TopBar>
                  {!activeTabSplit && tabStripVisible && renderTabBar(null)}
                  {splitDropSide && (
                    <div
                      className={tabSplitDropPreviewClass(splitDropSide)}
                      // Once there IS a split, the preview outlines the column the
                      // tab would join at its real width — the even halves it
                      // defaults to are only right for the drop that creates one.
                      style={tabSplitPreviewStyle(
                        splitDropSide,
                        activeTabSplit,
                      )}
                      aria-hidden="true"
                    />
                  )}
                  {route.view === "workspace" ? (
                    routeWorkspace ? (
                      <WorkspacePane
                        key={route.id}
                        onOpenPr={(repo, branch) =>
                          navigate({ view: "pr", repo, branch })
                        }
                        focusPr={reviewFocusPr ?? undefined}
                        workspace={routeWorkspace}
                        workspaceSessions={workspaceSessions}
                        sessions={sessions}
                        tabStripVisible={tabStripVisible}
                        onNewSession={
                          workspaceSessions.some((session) => session.desk) ||
                          emptyWorkspaceSession
                            ? undefined
                            : (origin) =>
                                void handleNewSession("share", null, origin)
                        }
                        tab={
                          reviewActive
                            ? "review"
                            : conversationActive
                              ? "conversation"
                              : videoActive
                                ? "video"
                                : null
                        }
                        connected={connected}
                        send={send}
                        addHandler={addHandler}
                        onOpenSession={openSession}
                        topbarEl={topbarEl}
                        headerActionsEl={headerActionsEl}
                        onRenameWorkspace={(name) =>
                          renameWorkspace(routeWorkspace.id, name)
                        }
                        archivedSessions={archivedSessions}
                        onRestoreSession={restoreSession}
                        onArchiveWorkspace={() =>
                          archiveWorkspaceFromHeader(workspaceSessions)
                        }
                        onDeleteWorkspace={() =>
                          deleteWorkspaceFromHeader(routeWorkspace.id)
                        }
                        rightPanelEl={rightPanelEl}
                      />
                    ) : workspacesLoaded ? (
                      <EmptyState>Workspace not found.</EmptyState>
                    ) : (
                      <LoadingState>Loading workspace…</LoadingState>
                    )
                  ) : route.view === "pr" ? (
                    route.branch === undefined ? (
                      // Number-only: nothing to preview until the resolve above
                      // finds the PR's workspace and replaces this route.
                      prRefMissing ? (
                        <EmptyState>{`${repoLabel(route.repo)} has no pull request #${route.number}.`}</EmptyState>
                      ) : (
                        <LoadingState>{`Opening #${route.number}…`}</LoadingState>
                      )
                    ) : (
                      <PrQueuePreview
                        key={`${route.repo}:${route.branch}`}
                        repo={route.repo}
                        branch={route.branch}
                        sessions={sessions}
                        onOpenSession={(id) =>
                          navigate({ view: "session", id })
                        }
                        onOpenPr={(repo, branch) =>
                          navigate({ view: "pr", repo, branch })
                        }
                        send={send}
                        addHandler={addHandler}
                      />
                    )
                  ) : route.view === "reports" ? (
                    <Reports
                      selectedAutomationId={route.automationId}
                      selectedReportId={route.reportId}
                      onSelect={(automationId, reportId) =>
                        navigate(
                          { view: "reports", automationId, reportId },
                          { replace: true },
                        )
                      }
                      onBack={() =>
                        navigate({ view: "reports" }, { replace: true })
                      }
                      onOpenSession={(id) => navigate({ view: "session", id })}
                      onOpenSupport={(threadId) =>
                        navigate({ view: "support", threadId })
                      }
                      onOpenNewSession={openPrefilledSession}
                      addHandler={addHandler}
                    />
                  ) : route.view === "analytics" ? (
                    <Analytics />
                  ) : route.view === "feed" ? (
                    <Feed
                      sessions={sessions}
                      teamViewing={teamViewing}
                      headerActionsEl={topbarActionsEl}
                      onSelect={(id) => navigate({ view: "session", id })}
                    />
                  ) : route.view === "tasks" ? (
                    <Tasks
                      addHandler={addHandler}
                      onOpenSession={(id) => navigate({ view: "session", id })}
                    />
                  ) : route.view === "plain" ? (
                    <SupportInbox
                      threadId={route.threadId ?? null}
                      sessions={sessions}
                      onSelectThread={(threadId) =>
                        navigate({ view: "plain", threadId })
                      }
                      onOpenSession={(id) => navigate({ view: "session", id })}
                    />
                  ) : route.view === "support" ? (
                    <SupportPreview
                      key={route.threadId}
                      threadId={route.threadId}
                      connected={connected}
                      send={send}
                      addHandler={addHandler}
                      onOpenSession={(id) => navigate({ view: "session", id })}
                    />
                  ) : route.view === "reviews" ? (
                    <Reviews
                      sessions={sessions}
                      selectedId={route.id ?? null}
                      onSelect={(id) => navigate({ view: "reviews", id })}
                      onOpenSession={(id) => navigate({ view: "session", id })}
                      onOpenPr={(repo, branch) =>
                        navigate({ view: "pr", repo, branch })
                      }
                      onAddToInput={addToSessionInput}
                      send={send}
                      addHandler={addHandler}
                    />
                  ) : route.view === "archived" ? (
                    <Archived
                      sessions={sessions}
                      loaded={archivedLoaded}
                      onSelect={(s) => navigate({ view: "session", id: s.id })}
                      onChanged={refresh}
                      topbarActionsEl={topbarActionsEl}
                      mobileActionsEl={headerActionsEl}
                    />
                  ) : route.view === "supporttinder" ? (
                    <SupportTinder
                      onExit={leaveDeck}
                      onOpenSession={(id) => navigate({ view: "session", id })}
                    />
                  ) : route.view === "catchup" ? (
                    <CatchUpDeck
                      sessions={sessions}
                      workspaces={workspaces}
                      send={send}
                      connected={connected}
                      onArchive={archiveSessionsFromCatchUp}
                      onOpenSession={(id) => navigate({ view: "session", id })}
                      onNewWorkspace={() => openPalette()}
                      onExit={leaveDeck}
                    />
                  ) : route.view === "session" ? (
                    currentSession ? (
                      activeTabSplit ? (
                        <SessionSplit
                          focusedSide={focusedSide}
                          ratio={activeTabSplit.ratio}
                          onFocusSide={(side) => {
                            const id = activeIdFor(side);
                            if (!id) return;
                            if (viewTabKind(id)) selectViewTab(id);
                            else {
                              setActiveViewTab(null);
                              navigate(
                                { view: "session", id },
                                { replace: true },
                              );
                            }
                          }}
                          onRatioChange={(ratio) =>
                            tabOrderKey &&
                            saveTabSplit(tabOrderKey, {
                              ...toStoredSplit(activeTabSplit),
                              ratio,
                            })
                          }
                          renderColumn={(side, socket, focused) => {
                            const id = activeIdFor(side);
                            const session =
                              sessions.find(
                                (candidate) => candidate.id === id,
                              ) ?? currentSession;
                            return (
                              <>
                                {renderTabBar(side)}
                                {renderSessionPane(
                                  session,
                                  socket,
                                  focused,
                                  true,
                                  id ?? session.id,
                                )}
                              </>
                            );
                          }}
                        />
                      ) : (
                        renderSessionPane(
                          currentSession,
                          mainSocket,
                          true,
                          false,
                        )
                      )
                    ) : (
                      <div className="flex flex-1 items-center justify-center">
                        {(() => {
                          const isLoading =
                            loading || route.id === pendingSessionId;
                          if (sessionsError && !isLoading) {
                            return (
                              <EmptyState
                                title="Couldn't load this session"
                                action={
                                  <Button
                                    size="sm"
                                    onClick={() => void refresh()}
                                  >
                                    Try again
                                  </Button>
                                }
                              >
                                Check the connection to this server.
                              </EmptyState>
                            );
                          }
                          const title = !isLoading
                            ? "Session not found"
                            : route.id === pendingSessionId
                              ? pendingNewWorkspace
                                ? "Starting a new workspace…"
                                : "Starting a new session…"
                              : "Loading session…";
                          return isLoading ? (
                            <LoadingState>{title}</LoadingState>
                          ) : (
                            <EmptyState title={title}>
                              It may have been deleted.
                            </EmptyState>
                          );
                        })()}
                      </div>
                    )
                  ) : sessionsError && sessions.length === 0 && !loading ? (
                    <EmptyState
                      title="Couldn't load sessions"
                      action={
                        <Button size="sm" onClick={() => void refresh()}>
                          Try again
                        </Button>
                      }
                    >
                      Check the connection to this server.
                    </EmptyState>
                  ) : productEmpty && githubConnectionState === "loading" ? (
                    <LoadingState className="min-h-0 flex-1">
                      Checking GitHub…
                    </LoadingState>
                  ) : productEmpty ? (
                    /* With nothing to open, the page IS the new-session card: the
							   same palette rendered in place, so the empty state is
							   something you can type into rather than a button that opens
							   somewhere else. The sidebar carries the matching row for the
							   session this will become.

							   The overlay still wins when it is open (⌘K, a /new link, the
							   sidebar +): one instance at a time, and since both persist
							   the same "new-session" draft, whatever was typed here is
							   already in the one that opens. */
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-5 py-8">
                      <div className="flex w-full max-w-[680px] flex-col">
                        {!palette.open && (
                          <NewSession
                            inline
                            focusSeq={draftFocusSeq}
                            onBack={() => {}}
                            send={send}
                            addHandler={addHandler}
                            connected={connected}
                            workspaces={workspaces}
                            sessions={sessions}
                            onCreateStarted={startNewSessionCreate}
                          />
                        )}
                      </div>
                    </div>
                  ) : !isPhone ? (
                    /* Phones never see this pane: the fullscreen sidebar is the
							   root page and sits over the detail shell. Mounting Prs
							   beneath it built a ~50k-element tree on every return to
							   the root, freezing the back-swipe for seconds. */
                    <Prs
                      sessions={sessions}
                      send={send}
                      addHandler={addHandler}
                      onSelect={(s) => navigate({ view: "session", id: s.id })}
                      onNewSession={() => openPalette()}
                      onShowArchived={refreshArchived}
                      onOpenAnalytics={() => navigate({ view: "analytics" })}
                      onAddToSidebar={async (pr) => {
                        const { workspaceId } = await resolveWorkspaceApi({
                          pr: {
                            repo: pr.repo,
                            branch: pr.branch,
                            number: pr.number,
                            title: pr.title,
                          },
                        });
                        refreshWorkspaces();
                        return workspaceId;
                      }}
                      onOpenWorkspace={(workspaceId, pr) => {
                        focusReviewPr({
                          repo: pr.repo,
                          branch: pr.branch,
                          number: pr.number,
                          workspaceId,
                        });
                        navigate({
                          view: "workspace",
                          id: workspaceId,
                          tab: "review",
                        });
                      }}
                      topbarActionsEl={topbarActionsEl}
                    />
                  ) : null}
                </AppShell>
              </div>
            )}

            {/* Durable prompts use a separate shelf from transient feedback. The
				    desktop shelf stays clear of the composer; phones put the compact
				    equivalent in the app header instead. */}
            {!isPhone && (
              <div className={PERSISTENT_NOTICE_SHELF}>
                {launchComplete && <DesktopLinkToast />}
                <UpdatePill addHandler={addHandler} />
              </div>
            )}

            {/* Mobile-only floating + on your root list page. */}
            {!mobileDetail && !borrowedSidebar && (
              <button
                className={MOBILE_FAB}
                onClick={() => openPalette()}
                aria-label="New session"
              >
                <svg
                  width="26"
                  height="26"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M8 2.5v11M2.5 8h11"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )}

            {/* The Desk trigger — desktop: a quiet floating button in the
				    bottom-right corner; phones: a second FAB beside the new-session +
				    on the root page (see .desk-fab). ⌘J and the command palette still
				    summon it too. */}
            {(!isPhone || !mobileDetail) && (
              <Tooltip label="Desk" side="left" shortcut={["⌘", "J"]}>
                <button
                  className={DESK_FAB}
                  style={
                    deskFabPosition
                      ? {
                          left: deskFabPosition.left,
                          right: "auto",
                          bottom: deskFabPosition.bottom,
                        }
                      : undefined
                  }
                  onClick={() =>
                    setDeskOverlay({ open: true, origin: "bottom-right" })
                  }
                  aria-label="Open the Desk"
                >
                  <IconDesk size={24} />
                </button>
              </Tooltip>
            )}

            {/* ⌘J Desk overlay — standing concierge session. */}
            <DeskOverlay
              open={deskOverlay.open}
              openOrigin={deskOverlay.origin}
              onClose={() =>
                setDeskOverlay((desk) => ({ ...desk, open: false }))
              }
              phone={isPhone}
              onOpenSession={(id) => navigate({ view: "session", id })}
            />

            {/* ⌘K command palette — actions, PRs, and sessions across every view. */}
            <CommandMenuHost
              ref={commandMenuRef}
              sessions={sessions}
              actions={commandActions}
              onSelectSession={(id) => navigate({ view: "session", id })}
              onSelectPr={(pr) => void openPrReview(pr)}
              onOpenWithMcp={(server) => openPalette(undefined, [server])}
            />

            {/* New-session palette overlays every view. */}
            {palette.open && (
              <NewSession
                onBack={closePalette}
                send={send}
                addHandler={addHandler}
                connected={connected}
                prefillPrompt={palette.prompt}
                workspaceId={palette.workspaceId}
                modelWorkspaceId={palette.modelWorkspaceId}
                forceRepo={palette.repo}
                forceBranch={palette.branch}
                forceMode={palette.mode}
                initialMcpServers={palette.mcpServers}
                workspaces={workspaces}
                sessions={sessions}
                onCreateStarted={startNewSessionCreate}
              />
            )}

            {/* ⌘/ cheat sheet — every chord, with the reader's own bindings. */}
            <ShortcutCheatSheet
              open={shortcutsOpen}
              onOpenChange={setShortcutsOpen}
              onCustomize={() => {
                setShortcutsOpen(false);
                navigate({ view: "settings", section: "shortcuts" });
              }}
            />

            {/* Hover cards for the session and PR chips inside rendered
				    markdown. One watcher for the whole app: the chips are HTML
				    strings, so they can't each own a popover. */}
            <ChipHoverCards sessions={sessions} />
          </>
        )}
      </div>
    </UserGate>
  );
  return (
    <NavigationProvider actions={navigationActions}>
      {content}
    </NavigationProvider>
  );
}
