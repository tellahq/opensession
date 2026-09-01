import { BASE_PATH, stripBasePath } from "./lib/base";
import { DEFAULT_REPO_ID, PRODUCT_NAME } from "./lib/brand";
import type { NavigationActions } from "./lib/navigation";
import {
  onSessionTitleResolutionRequested,
  retrySessionTitleResolution,
  setKnownRepos,
  setKnownPrStates,
  setResolvedSessionTitles,
  setSessionTitles,
} from "./lib/markdown";
import { reviewRequestTargetsPerson } from "./lib/review-queue";
import { repoLabel } from "./lib/repo-label";
import { NO_REPO } from "./lib/session-repo";
import { sessionReferenceTitle } from "./lib/session-title";
import {
  ASK_BAND,
  sidebarWorkspaceIdForSession,
} from "./lib/sidebar-workspaces";
import React, {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { EffectRegistryProvider } from "./components/EffectRegistryProvider";
import { MotionConfig } from "motion/react";
import { AppShell } from "./components/AppShell";
import { NavigationProvider } from "./components/NavigationProvider";
import { RunningCloseDialog } from "./components/RunningCloseDialog";
import { SessionPaneProviders } from "./components/SessionPaneProviders";
import { Sidebar, type SidebarHandle } from "./components/Sidebar";
import { Tooltip, TooltipProvider } from "./ui/tooltip";
import { cn } from "./ui/cn";
import {
  APP_BODY,
  DETAIL_TOPBAR,
  DETAIL_TOPBAR_ACTIONS,
  DETAIL_TOPBAR_TITLE,
  DETAIL_TOPBAR_TITLE_TEXT,
  tabSplitDropPreviewClass,
} from "./lib/app-shell-classes";
import {
  appHeader,
  APP_HEADER_ACTIONS,
  APP_HEADER_ACTIONS_DETAIL,
  ARCHIVED_SEARCH_HEADER,
  HEADER_TITLE_COL,
  HEADER_TITLE_MODEL,
  HEADER_TITLE_PILL,
  HEADER_TITLE_PILL_CENTERED,
  HEADER_TITLE_PILL_FADE,
  HEADER_TITLE_PILL_TAPPABLE,
  HEADER_TITLE_REPO,
  HEADER_TITLE_ROW,
  HEADER_TITLE_TEXT,
  MOBILE_SEARCH_BTN,
} from "./lib/app-header-classes";
import { DESK_FAB, MOBILE_FAB } from "./lib/fab-classes";
import { PR_PAGE_COLUMN } from "./lib/pr-list-classes";
import { SIDEBAR_CHROME_BTN } from "./lib/sidebar-classes";
import { ToastHost, toast } from "./ui/toast";
import { Button } from "./ui/button";
import {
  TopBar,
  TopBarActions,
  TopBarBack,
  TopBarLeading,
  TopBarTitle,
} from "./ui/top-bar";
import { OverflowFadeText } from "./ui/overflow-fade-text";
import { SessionViewer } from "./components/SessionViewer";
import { AgentationFeedback } from "./components/AgentationFeedback";
import {
  NewSession,
  type NewSessionCreateDraft,
} from "./components/NewSession";
import { clearDraft, saveDraft, NEW_SESSION_DRAFT_KEY } from "./lib/drafts";
import { dropStagingAttachments } from "./lib/attachments";
import {
  errorMatchesPendingCreate,
  shouldApplyCreatedSessionReply,
  shouldOpenCreatedSession,
} from "./lib/new-session-navigation";
import { consumeNewSessionWorkspaceDraft } from "./lib/new-session-workspace-draft";
import { trackKeyboardInset } from "./lib/keyboard-inset";
import type { CommandPaletteAction } from "./components/SessionSearch";
import {
  CommandMenuHost,
  type CommandMenuHandle,
} from "./components/CommandMenuHost";
import { Prs } from "./components/Prs";
import { Feed } from "./components/Feed";
import { CatchUpDeck } from "./components/CatchUpDeck";
import { SupportTinder } from "./components/SupportTinder";
import { Automations } from "./components/Automations";
import { Security } from "./components/Security";
import { Goals } from "./components/Goals";
import { Archived } from "./components/Archived";
import { Reviews } from "./components/Reviews";
import { PrQueuePreview } from "./components/PrQueuePreview";
import { SupportInbox } from "./components/SupportInbox";
import { SupportPreview } from "./components/SupportPreview";
import { WorkspacePane } from "./components/WorkspacePane";
import { Reports } from "./components/Reports";
import { Analytics } from "./components/Analytics";
import { Tasks } from "./components/Tasks";
import {
  UserGate,
  getCurrentUser,
  useAuthStatus,
  useCurrentUser,
} from "./components/UserPicker";
import { PreviewWait, matchPreviewWaitRoute } from "./components/PreviewWait";
import { TitleBar } from "./components/TitleBar";
import { FirstMile } from "./components/FirstMile";
import { useOnboarding } from "./hooks/useOnboarding";
import { useAppRoute } from "./hooks/useAppRoute";
import { useAppShell } from "./hooks/useAppShell";
import { useArchiveUndo } from "./hooks/useArchiveUndo";
import { useRunningCloseConfirmation } from "./hooks/useRunningCloseConfirmation";
import { useSubagentTabs } from "./hooks/useSubagentTabs";
import { useOnDemandViewTabs } from "./hooks/useOnDemandViewTabs";
import { useNewSessionPalette } from "./hooks/useNewSessionPalette";
import { settingsPaletteActions } from "./lib/settings-sections";
import { SessionTabs } from "./components/SessionTabs";
import type { NewTabMorphOrigin, ViewTab } from "./lib/session-tabs-types";
import { SessionSplit, type SplitSide } from "./components/SessionSplit";
import { RestartOverlay } from "./components/RestartOverlay";
import { MediaLightboxHost } from "./components/MediaLightbox";
import { ChipHoverCards } from "./components/ChipHoverCard";
import { TranscriptMotionLab } from "./components/TranscriptMotionLab";
import { transcriptMotionFixtureOptions } from "./lib/transcript-motion-scenarios";
import { ShortcutCheatSheet } from "./components/ShortcutCheatSheet";
import { UpdatePill } from "./components/UpdatePill";
import { OrganizationSwitcher } from "./components/OrganizationSwitcher";
import { DesktopLinkToast } from "./components/DesktopLinkToast";
import { PERSISTENT_NOTICE_SHELF } from "./lib/notification-classes";
import {
  IconArchive,
  IconUnarchive,
  IconBook,
  IconChart,
  IconChevronRight,
  IconCopy,
  IconDesk,
  IconFile,
  IconGear,
  IconGlobe,
  IconInbox,
  IconListCircles,
  IconMail,
  IconMessages,
  IconMoon,
  IconFeed,
  IconPlus,
  IconPullRequest,
  IconRobot,
  IconSearch,
  IconSidebarLeft,
  IconStack,
  IconWrench,
} from "./components/icons";
import { DeskOverlay } from "./components/DeskOverlay";
import { sidebarSessionsQuery, useSessions } from "./hooks/useSessions";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { useWorkspaceMutations } from "./hooks/useWorkspaceMutations";
import { useSessionLifecycle } from "./hooks/useSessionLifecycle";
import { useGithubConnectionState } from "./hooks/useGithubConnectionState";
import { useHydratedSession } from "./hooks/useHydratedSession";
import { hasDraft } from "./lib/drafts";
import { sessionWasAgentStarted } from "./lib/sidebar-placement";
import { useWebSocket } from "./hooks/useWebSocket";
import { useBackSwipe } from "./hooks/useBackSwipe";
import { useIsPhone } from "./hooks/useIsPhone";
import { useDeskFabPosition } from "./hooks/useDeskFabPosition";
import { useShortcutKeys } from "./hooks/useShortcutBindings";
import { useInputAlerts } from "./hooks/useInputAlerts";
import { useLargeTitleHandoff } from "./hooks/useLargeTitle";
import { initAlerts } from "./lib/notify";
import { registerServiceWorker } from "./lib/push";
import {
  deleteSessionApi,
  fetchSession,
  renameSessionApi,
  setSessionStatusApi,
  newSessionApi,
  fetchWorkspaceArchivedSessions,
  fetchRepos,
  cachedRepos,
  REPOS_CHANGED_EVENT,
  resolveWorkspaceApi,
  type OpenPr,
} from "./lib/api";
import {
  defaultSessionWorkspaceView,
  mainSession,
  newSessionSource,
  workspaceLandingReady,
  workspaceSessionSeed,
  pickLandingSession,
  sessionNeverRan,
} from "./lib/landing-session";
import {
  getWorkspaceLastSession,
  saveWorkspaceLastSession,
} from "./lib/workspace-last-session";
import { sessionCarriesPr, sessionHasPr } from "./lib/session-prs";
import { newClientSessionId } from "./lib/session-id";
import { findPrWorkspaceId } from "./lib/pr-workspace";
import { sessionHasWorkspace } from "./lib/session-workspace";
import type {
  Workspace,
  SupportThread,
  FeedDescriptor,
  FeedItem,
} from "./lib/types";
import { refWebPanel } from "./components/FeedWebPane";
import { ensureFeedMeta } from "./lib/feeds-meta";
import type { ReviewQueueItem } from "./lib/review-queue";
import { setLane, type Lane } from "./lib/lanes";
import { markRead } from "./lib/reads";
import { resolveAnonymousUserPath } from "./lib/auth-ready";
import {
  nextRenderedSidebarChat,
  nextUnreadRenderedWorkspaceItem,
} from "./lib/sidebar-next";
import {
  sessionPath,
  prPath,
  absoluteLink,
  copyToClipboard,
  workspacePanePath,
} from "./lib/share-link";
import {
  getPins,
  togglePin,
  pin,
  unpin,
  reorderPins,
  onPinsChanged,
  getPinNewSessions,
  getPinNewWorkspaces,
  receivePins,
} from "./lib/pins";
import { receiveMention, receiveMentionsCleared } from "./lib/mentions";
import {
  personFilterFor,
  setFilter,
  useSidebarFilter,
} from "./lib/sidebar-filter";
import {
  appendNewTabs,
  applyTabOrder,
  saveTabOrder,
  onTabOrderChanged,
} from "./lib/tab-order";
import { workspaceArchivedSessions } from "./lib/workspace-archive";
import { useWorkspaceArchive } from "./hooks/useWorkspaceArchive";
import {
  clearTabSplit,
  getTabSplit,
  onTabSplitChanged,
  saveTabSplit,
  resolveSplit,
  shouldShowTabStrip,
  type ResolvedSplit,
  type TabSplit,
} from "./lib/split-tabs";
import {
  getActiveViewTab,
  getActiveViewTabKeys,
  saveActiveViewTab,
  type ActiveViewTab,
} from "./lib/active-view-tab";
import {
  getTabColors,
  setTabColor,
  onTabColorsChanged,
} from "./lib/tab-colors";
import { PR_DOT_TONE } from "./lib/session-tab-classes";
import { dedupeViewers, otherViewers } from "./lib/presence";
import { copySessionTranscript } from "./lib/transcript-copy";
import { effectiveTheme, setThemePref } from "./lib/theme";
import { blockingOverlayOpen } from "./lib/blocking-overlay";
import { matchesShortcut, shortcutPrimaryKeys } from "./lib/shortcuts";
import type { UnifiedSession } from "./lib/types";
// Order matters: base.css (tokens, reset, platform chrome) then legacy.css,
// which is now empty and stays imported so the "never add here" contract keeps
// a home. Utilities are linked after both, so they win source-order ties.
import "./styles/base.css";
import "./styles/legacy.css";
import { EmptyState, LoadingState } from "./ui/state";
import {
  isSettingsRoute,
  isToolView,
  parseRoute,
  routePath,
} from "./lib/app-route";
import {
  buildWorkspacePaneTabs,
  sessionlessWorkspacePanes,
  viewTabKind,
  type WorkspacePaneTab,
} from "./lib/workspace-pane-tabs";

function deferred<Props extends object>(
  load: () => Promise<{ default: React.ComponentType<Props> }>,
  fallback: React.ReactNode = null,
): React.ComponentType<Props> {
  const Component = React.lazy(load);
  return function Deferred(props: Props) {
    return (
      <React.Suspense fallback={fallback}>
        <Component {...props} />
      </React.Suspense>
    );
  };
}

type SettingsProps = React.ComponentProps<
  typeof import("./components/Settings").Settings
>;
const Settings = deferred<SettingsProps>(async () => {
  const { Settings: SettingsComponent } = await import("./components/Settings");
  return { default: SettingsComponent };
});

// How long the launch splash may hold the screen while the first session list
// is still in flight. Past this the app takes over and reports for itself.
const SPLASH_MAX_MS = 8000;
const SPLASH_EXIT_MS = 400;

class MissingWorkspaceSessionSourceError extends Error {}

interface AppProps {
  serviceWorker?: boolean;
  initialTeamViewing?: Array<{ user: string; sessionId: string }>;
}

function AppContent({
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
  type PendingCreateDraft = NewSessionCreateDraft & {
    startedAt: string;
    user: string;
    originPath: string;
  };
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
  // Session-reference chips in transcripts (`bks-…`), and the pill the
  // composer projects a draft id into, label themselves from this registry.
  // markdown.ts renders to an HTML string rather than React nodes, so it
  // can't read this from context, so hand it the names we already poll.
  // No-ops unless a name actually changed.
  //
  // Human sessions name the workspace they open, matching the sidebar and
  // viewer header. Worker references are different: their session title says
  // which delegated task the chip opens, while their inherited workspace name
  // would incorrectly repeat the parent session's subject for every worker.
  useEffect(() => {
    setSessionTitles(
      sessions.map(
        (s) =>
          [
            s.id,
            sessionReferenceTitle(s),
            s.isRunning,
            s.title,
            s.aliasIds,
          ] as const,
      ),
    );
    setKnownPrStates(
      sessions.flatMap((session) => [
        ...(session.repo && session.prNumber
          ? [
              {
                repo: session.repo,
                number: session.prNumber,
                state: session.prState,
                isDraft: session.prIsDraft,
                mergeable: session.prMergeable,
                reviewDecision: session.prReviewDecision,
                checks: session.prChecks,
              },
            ]
          : []),
        ...(session.prs ?? []),
      ]),
    );
  }, [sessions]);
  // The live list intentionally omits archived history. Resolve only archived
  // sessions that a visible transcript or draft actually references, rather
  // than restoring the several-thousand-row archived payload to cold start.
  useEffect(
    () =>
      onSessionTitleResolutionRequested((ids) => {
        for (const requestedId of ids) {
          void fetchSession(requestedId)
            .then((session) => {
              setResolvedSessionTitles([
                {
                  requestedId,
                  ...(session
                    ? {
                        id: session.id,
                        title: sessionReferenceTitle(session),
                        tabTitle: session.title,
                        aliases: session.aliasIds,
                        archived: session.archived === true,
                      }
                    : { title: null }),
                },
              ]);
            })
            .catch(() => retrySessionTitleResolution(requestedId));
        }
      }),
    [],
  );
  // Same deal for PR-mention chips (`opensession#128`): markdown.ts only links
  // a qualified mention it can place, so it needs the repos this instance
  // serves — their ids to match on, their GitHub names for the cmd-click
  // escape to github.com. Bare `#5528` mentions don't come through here —
  // those belong to the repo of whatever surface renders them
  // (MarkdownRepoProvider).
  useEffect(() => {
    let live = true;
    const seeded = cachedRepos();
    if (seeded.length) setKnownRepos(seeded);
    const loadRepos = () =>
      fetchRepos()
        .then((repos) => {
          if (live) {
            setKnownRepos(repos);
            setRegisteredRepoInfo(repos);
          }
        })
        .catch(() => {});
    loadRepos();
    window.addEventListener(REPOS_CHANGED_EVENT, loadRepos);
    return () => {
      live = false;
      window.removeEventListener(REPOS_CHANGED_EVENT, loadRepos);
    };
  }, []);
  // Register the service worker at boot, not just when enabling push: it also
  // caches the app shell (sw.js), so a cold start on a flaky tailnet paints
  // the app instead of white-screening.
  useEffect(() => {
    if (serviceWorker) return registerServiceWorker();
  }, [serviceWorker]);
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
  } = useAppShell();
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
  const newTabMorphTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(
    () => () => {
      if (newTabMorphTimer.current) clearTimeout(newTabMorphTimer.current);
    },
    [],
  );
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

  // Track the on-screen keyboard via input focus. It's the only reliable iOS
  // signal: in a standalone PWA visualViewport doesn't shrink, and
  // env(safe-area-inset-bottom) keeps reporting the home-indicator inset even
  // while the keyboard covers that area. A `kb-open` body class lets the
  // composer drop its safe-area bottom padding so it sits snug above the
  // keyboard instead of floating ~34px above it.
  //
  // The same focus is what starts measuring HOW MUCH the keyboard covers
  // (`--kb-inset`, lib/keyboard-inset): the class says a keyboard is up, the
  // variable says how tall it is, and a surface resting on the bottom edge
  // needs both.
  useEffect(() => {
    let releaseInset: (() => void) | null = null;
    const isText = (el: Element | null) =>
      !!el &&
      (el.tagName === "TEXTAREA" ||
        (el.tagName === "INPUT" &&
          ![
            "button",
            "checkbox",
            "radio",
            "submit",
            "file",
            "range",
            "color",
          ].includes((el as HTMLInputElement).type)) ||
        (el as HTMLElement).isContentEditable);
    const onIn = (e: FocusEvent) => {
      if (!isText(e.target as Element)) return;
      document.body.classList.add("kb-open");
      if (releaseInset === null) releaseInset = trackKeyboardInset();
    };
    const onOut = () => {
      // activeElement updates a tick after focusout; defer so moving between
      // fields doesn't flicker the class off and back on.
      setTimeout(() => {
        if (isText(document.activeElement)) return;
        document.body.classList.remove("kb-open");
        releaseInset?.();
        releaseInset = null;
      }, 0);
    };
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
      releaseInset?.();
    };
  }, []);
  useEffect(() => {
    const unsub = onTabColorsChanged(() => setTabColors(getTabColors()));
    setTabColors(getTabColors());
    return unsub;
  }, []);

  // Settings (and the tool surfaces it hosts) render as a full page on
  // desktop, but as a bottom sheet over the root list on phones.
  const settingsActive = isSettingsRoute(route);
  const isPhone = useIsPhone();
  const borrowedSidebar = sidebarFilter.person !== "me";

  // A pushed detail page is showing (anything but the sidebar-root home view).
  // On phones, Settings is a sheet floating over the root page rather than a
  // pushed page — the bar keeps the brand and the sidebar stays underneath.
  const mobileDetail = route.view !== "prs" && !(isPhone && settingsActive);

  const sidebarRef = useRef<SidebarHandle>(null);
  const nextChatRef = useRef<() => void>(() => {});
  const [nextChatAvailable, setNextChatAvailable] = useState(false);
  // Set below, once the review-focus callback it needs exists.
  const openPrRef = useRef<(repo: string, number: number) => void>(() => {});

  // PR-mention chips (markdown.ts) are anchors inside
  // dangerouslySetInnerHTML, so they can't carry a React handler — and they
  // turn up in every markdown surface, not just the transcript. One
  // document-level listener gives them both readings of "open this PR":
  //   - plain click → the review here, navigated in place rather than
  //     reloading the whole SPA to follow the href
  //   - cmd/ctrl-click (and the middle button, which fires `auxclick`) → the
  //     PR on github.com in a new tab. That gesture means "open elsewhere",
  //     and elsewhere for a PR is GitHub — opening a second copy of this app
  //     in a tab is never what it was asked for.
  // A repo with no GitHub name to go to keeps the browser's own behavior.
  useEffect(() => {
    const chipAt = (e: MouseEvent) => {
      if (e.defaultPrevented) return null;
      const target = e.target as HTMLElement | null;
      const el = target?.closest?.("a[data-pr-number]") as HTMLElement | null;
      const repo = el?.dataset.prRepo;
      const number = Number(el?.dataset.prNumber);
      if (!repo || !Number.isInteger(number)) return null;
      return { repo, number, ghRepo: el?.dataset.prGh };
    };
    const openOnGithub = (
      e: MouseEvent,
      chip: NonNullable<ReturnType<typeof chipAt>>,
    ) => {
      if (!chip.ghRepo) return false;
      e.preventDefault();
      window.open(
        `https://github.com/${chip.ghRepo}/pull/${chip.number}`,
        "_blank",
        "noopener,noreferrer",
      );
      return true;
    };
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const chip = chipAt(e);
      if (!chip) return;
      if (e.metaKey || e.ctrlKey) {
        openOnGithub(e, chip);
        return;
      }
      // Shift (new window) and alt (download) are deliberate browser
      // gestures on the href — leave them to it.
      if (e.shiftKey || e.altKey) return;
      e.preventDefault();
      openPrRef.current(chip.repo, chip.number);
    };
    const onAuxClick = (e: MouseEvent) => {
      if (e.button !== 1) return;
      const chip = chipAt(e);
      if (chip) openOnGithub(e, chip);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("auxclick", onAuxClick);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("auxclick", onAuxClick);
    };
  }, []);

  // Automation-id chips carry a real href for browser gestures. Plain clicks
  // stay inside the SPA and open that automation's settings drawer directly.
  const navigateFromDocument = useEffectEvent(navigate);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      )
        return;
      const el = (e.target as HTMLElement | null)?.closest?.(
        "a.automation-link[data-automation-id]",
      ) as HTMLElement | null;
      const id = el?.dataset.automationId;
      if (!id) return;
      e.preventDefault();
      navigateFromDocument({ view: "automations", id });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  // @-mention chips (markdown.ts) are anchors inside dangerouslySetInnerHTML
  // too, so they get the same treatment: one document-level listener, and a
  // click puts the sidebar on that person's sessions. Enter/Space as well —
  // the chip is a role="button", so the keyboard has to reach it.
  useEffect(() => {
    const personAt = (e: Event) => {
      if (e.defaultPrevented) return null;
      const el = (e.target as HTMLElement | null)?.closest?.(
        "a.person-chip[data-person]",
      ) as HTMLElement | null;
      return el?.dataset.person || null;
    };
    const show = (person: string) => {
      setFilter({
        person: personFilterFor(person.toLowerCase(), getCurrentUser()),
      });
    };
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      const person = personAt(e);
      if (!person) return;
      e.preventDefault();
      show(person);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const person = personAt(e);
      if (!person) return;
      e.preventDefault();
      show(person);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Edge-swipe-from-left pops the pushed page back to the sidebar on phones.
  useBackSwipe({
    active: mobileDetail,
    onBack: goBack,
    paneRef: detailPaneRef,
  });

  // Arm audio + request notification permission on the first user gesture.
  useEffect(() => initAlerts(), []);

  // Sound + desktop notification whenever one of *my* sessions newly flips into
  // "needs input" (blocked on a question). Scoped to the current user's own
  // non-automation sessions — the same set as the sidebar's "Needs input" bucket.
  useInputAlerts(sessions, {
    isMine: (s) => {
      const me = getCurrentUser().toLowerCase();
      return !s.automation && !!s.startedBy && s.startedBy.toLowerCase() === me;
    },
    isMyReview: (s) =>
      reviewRequestTargetsPerson(s.reviewRequest, getCurrentUser()) &&
      !s.reviewRequest?.accepted,
    onOpen: (id) => navigate({ view: "session", id }),
    connected,
  });

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

  // A "new tab" while a session is open is a *new session in that same session*, not
  // a whole new session — so it must NOT pop the new-session palette. It's a
  // visual fresh-start (one thread under the hood): bumping this counter tells the
  // open SessionViewer to clear its composer and scroll to the live edge. With no
  // session open there's nothing to stay in, so it falls back to the palette.
  const [newSessionSeq, setNewSessionSeq] = useState(0);
  // Which non-session view-tab is foregrounded. A single field makes "both open
  // at once" unrepresentable; the show-flags derive from it. The selection is
  // restored per workspace below rather than leaking across workspaces —
  // except a sub-agent link, which names its pane in the URL and so arrives
  // with that tab already chosen.
  const [activeViewTab, setActiveViewTabState] = useState<ActiveViewTab>(
    route.view === "session" && route.subagent?.length ? "subagent" : null,
  );
  const reviewActive = activeViewTab === "review";
  const conversationActive = activeViewTab === "conversation";
  const videoActive = activeViewTab === "video";
  const stagingActive = activeViewTab === "staging";
  const assetsActive = activeViewTab === "assets";
  const previewLiveActive = activeViewTab === "preview";
  const portalActive = activeViewTab === "portal";
  const terminalActive = activeViewTab === "terminal";
  const subagentSelected = activeViewTab === "subagent";
  // Workspaces whose Review / Conversation / Preview environment view-tab is
  // present in the strip; empty by default (a tab is added when its pane is
  // first opened).
  const [reviewOpen, setReviewOpen] = useState<Set<string>>(
    () => new Set(getActiveViewTabKeys("review")),
  );
  // PR-backed workspaces (adopted from a PR — the ghpr ones) show Review by
  // default even when you land straight in one of their sessions; this tracks
  // their explicit closes, mirroring conversationClosed below.
  const [reviewClosed, setReviewClosed] = useState<Set<string>>(
    () => new Set(),
  );
  // Conversation is default-PRESENT on any workspace/session linked to a Plain
  // thread (unlike Review, which is opened on demand) — so the state tracks
  // explicit closes, not opens.
  const [conversationClosed, setConversationClosed] = useState<Set<string>>(
    () => new Set(),
  );
  // The Video (feed web-panel) tab is likewise default-PRESENT on workspaces
  // carrying a web-panel ExternalRef (a linked video, dashboard, …): track explicit closes.
  const [videoClosed, setVideoClosed] = useState<Set<string>>(() => new Set());
  const {
    routeSubagentStack,
    openSubagentPath,
    stackFor,
    openSubagent,
    popSubagent,
    closeSubagentTab,
    nameSubagent,
  } = useSubagentTabs({
    route,
    subagentSelected,
    setActiveViewTab: setActiveViewTabState,
  });
  // Bumped when the per-workspace tab order changes (a drag-drop commit, or a
  // storage push from another tab) so the strip re-derives `workspaceSessions` in
  // the new order. The order itself lives in localStorage (lib/tab-order).
  const [, setTabOrderRev] = useState(0);
  useEffect(() => onTabOrderChanged(() => setTabOrderRev((v) => v + 1)), []);
  const [, setTabSplitRev] = useState(0);
  useEffect(
    () => onTabSplitChanged(() => setTabSplitRev((value) => value + 1)),
    [],
  );
  const [splitDropSide, setSplitDropSide] = useState<"left" | "right" | null>(
    null,
  );
  // One-shot: the session whose Review tab should foreground once it lands, set
  // when opening Review from the sidebar. Survives the session-change reset
  // below (a pulse consumed by the effect next to it), then cleared. (Staging
  // only opens from within the already-current session, so it needs no such
  // pending pulse.)
  const [pendingReviewOpen, setPendingReviewOpen] = useState<string | null>(
    null,
  );
  // Which PR the Review pane should land on. A workspace can carry several
  // (a feature shipped as two PRs, a discovered one), and they each get their
  // own sidebar row — so the row you clicked, not the primary, decides.
  // `seq` re-applies the same PR after you've switched targets by hand.
  //
  // Named loosely on purpose: a sidebar row knows the branch, a `repo#123`
  // chip in prose only the number, and the server can fill the branch in
  // only for PRs its caches cover (lib/pr-focus.ts does the matching).
  const [reviewFocusPr, setReviewFocusPr] = useState<{
    repo: string;
    branch?: string;
    number?: number;
    /** The workspace it was resolved against, so a later visit to another
     *  workspace can't be retargeted by an older request. */
    workspaceId?: string;
    seq: number;
  } | null>(null);
  const reviewFocusPrRef = useRef(reviewFocusPr);
  useLayoutEffect(() => {
    reviewFocusPrRef.current = reviewFocusPr;
  });
  // The `seq` the workspace landing effect has already used to pick a session
  // (below). Without it a stale request would keep redirecting every later
  // visit to this workspace's Review.
  const landedFocusSeq = useRef<number | null>(null);
  const focusReviewPr = (pr: {
    repo: string;
    branch?: string;
    number?: number;
    workspaceId?: string;
  }) => {
    setReviewFocusPr((prev) => ({ ...pr, seq: (prev?.seq ?? 0) + 1 }));
  };
  // Open a PR named in prose (a `repo#123` chip) where it belongs: a Review tab
  // in its workspace. The standalone /pr/ route is a page, so routing through it
  // took the whole detail pane, title and tab strip included, for as long as the
  // resolve took, even when the PR's workspace was the one already on screen.
  // Most clicks need no server at all (the workspace and session lists already
  // say where the PR lives), and the ones that do keep the current view up while
  // they wait rather than blanking it. Only an unresolvable PR falls through to
  // the standalone route, which is what says there is no such pull request.
  const openPrByRef = (repo: string, number: number) => {
    const open = (
      workspaceId: string,
      pr: { repo: string; branch?: string; number?: number },
    ) => {
      focusReviewPr({ ...pr, workspaceId });
      navigate({
        view: "workspace",
        id: workspaceId,
        tab: "review",
      });
    };
    const known = findPrWorkspaceId(
      workspacesRef.current,
      sessionsRef.current,
      { repo, number },
    );
    if (known) {
      open(known, { repo, number });
      return;
    }
    resolveWorkspaceApi({ pr: { repo, number } })
      .then(({ workspaceId, pr }) => {
        refreshWorkspaces();
        open(workspaceId, {
          repo: pr?.repo ?? repo,
          branch: pr?.branch,
          number: pr?.number ?? number,
        });
      })
      .catch(() => {
        navigate({ view: "pr", repo, number });
      });
  };
  useLayoutEffect(() => {
    openPrRef.current = openPrByRef;
  });
  // One-shot guard consumed by the workspace default-pane seeding effect (set
  // when closing a view tab replaces the workspace URL — see onCloseView).
  const suppressWsSeedRef = useRef(false);

  // Set for the render right after opening a workspace from the sidebar, so the
  // session it lands on autofocuses its composer (you picked the workspace to
  // type in it). Reset immediately after — a one-shot pulse, not a mode — so
  // sessions opened by any other means don't grab focus.
  const [focusComposerOnOpen, setFocusComposerOnOpen] = useState(false);
  const [sessionComposerPrefills, setSessionComposerPrefills] = useState<
    Record<string, { seq: number; text: string }>
  >({});
  const addToSessionInput = (sessionId: string, text: string) => {
    setSessionComposerPrefills((prev) => ({
      ...prev,
      [sessionId]: { seq: (prev[sessionId]?.seq ?? 0) + 1, text },
    }));
    setFocusComposerOnOpen(true);
    navigate({ view: "session", id: sessionId });
  };
  useEffect(() => {
    if (focusComposerOnOpen) setFocusComposerOnOpen(false);
  }, [focusComposerOnOpen]);

  // The command menu owns its open/query state below App, so toggling it does
  // not reconcile the active route, viewer, and sidebar before the overlay can
  // paint.
  const commandMenuRef = useRef<CommandMenuHandle>(null);
  // The Desk overlay (⌘J / the floating desk button): a standing concierge
  // session on top of whatever view is open. Its entrance origin follows the
  // invocation: the corner launcher is spatial, while the shortcut is not.
  const [deskOverlay, setDeskOverlay] = useState<{
    open: boolean;
    origin: "center" | "bottom-right";
  }>({ open: false, origin: "bottom-right" });
  // The shortcut cheat sheet (⌘/): every chord on one card, over any view.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Open-task count for the Tasks toolbar entry — refreshed on every
  // todos_changed broadcast (the Tasks page, agent tools, or another tab).
  const [taskCount, setTaskCount] = useState(0);
  useEffect(() => {
    let stale = false;
    const load = async () => {
      await (async () => {
        const path = await resolveAnonymousUserPath(
          `${BASE_PATH}/api/todos?user=${encodeURIComponent(getCurrentUser())}`,
        );
        const res = await fetch(path);
        const data = (await res.json()) as { todos?: unknown[] };
        if (!stale) setTaskCount(data.todos?.length ?? 0);
      })().catch(async () => {});
    };
    void load();
    const unsub = addHandler((msg) => {
      if (msg.type === "todos_changed") void load();
    });
    return () => {
      stale = true;
      unsub();
    };
  }, [addHandler]);
  const closePalette = () => {
    hidePalette();
    // A deep link left the URL on <base>/new — return home on close.
    if (stripBasePath(location.pathname) === "/new") goBack();
  };

  const startNewSessionCreate = (started: NewSessionCreateDraft) => {
    const startedAt = new Date().toISOString();
    const user = getCurrentUser();
    const draft: PendingCreateDraft = {
      ...started,
      startedAt,
      user,
      originPath: routePath(getCurrentRoute()),
    };
    pendingCreateDraftRef.current = draft;

    const shell: UnifiedSession = {
      id: started.id,
      claudeSessionId: null,
      source: "opensession",
      branch: started.branch,
      worktreeDir: null,
      startedBy: user,
      title: started.workspaceId ? "New session" : "New workspace",
      lastActivity: startedAt,
      createdAt: startedAt,
      isRunning: true,
      runStartedAt: startedAt,
      transcriptPath: null,
      mode: started.mode,
      repo: started.repo,
      workspaceId: started.workspaceId || null,
      model: started.model,
      archived: false,
      // The server replaces this conservative starting state as soon as
      // session_created confirms whether environment setup is needed.
      workspacePreparing: true,
    };
    flushSync(() => {
      // Every create appears in the sidebar at send time. Background and
      // "Create more" used to wait for session_created even though the open
      // action already had this complete deterministic shell.
      inject(shell, { sticky: true });
      if (started.openImmediately) {
        setOptimisticSession(shell);
        hidePalette();
      }
    });
    if (!started.openImmediately) return;
    // "Open" means the new session's conversation, even when the create
    // adopts the PR workspace whose Review pane is currently foregrounded.
    // Leaving Review selected mounts PrPanel against the client-minted id
    // before the server has persisted it, briefly reporting "Session not
    // found" until the person opens the tab again. Clear both the live pane
    // and the target workspace's remembered selection before navigating.
    setActiveViewTabState(null);
    if (started.workspaceId) saveActiveViewTab(started.workspaceId, null);
    if (started.prompt || started.images?.length) {
      setPendingInitialPrompts((current) => ({
        ...current,
        [started.id]: {
          content: started.prompt,
          user,
          sentAt: new Date(startedAt).getTime(),
          ...(started.images?.length ? { images: started.images } : {}),
        },
      }));
    }
    setPendingSessionId(started.id);
    setPendingNewWorkspace(!started.workspaceId);
    clearTimeout(pendingTimer.current);
    pendingTimer.current = setTimeout(() => {
      setPendingSessionId((pending) =>
        pending === started.id ? null : pending,
      );
      setOptimisticSession((pending) =>
        pending?.id === started.id ? null : pending,
      );
      unstick(started.id);
    }, 120_000);
    navigate({ view: "session", id: started.id });
  };

  // The link ⌘⇧C copies: the open session/workspace, or the open PR preview.
  // Assigned during render (below, once currentSession is known); null when
  // the current view has nothing linkable.
  const copyLinkPathRef = useRef<string | null>(null);

  // ⌘K toggles the command palette; ⌘S starts a session in a new workspace;
  // ⌘⇧C copies a link to the open session/PR.
  // Esc closes whichever palette is open (search's
  // own input also handles Esc, but this covers the case where focus has left
  // it).
  // The three component handlers are read through effect events, so the
  // listener subscribes once and still reaches the latest closures.
  const hotkeyOpenPalette = useEffectEvent(() => openPalette());
  const hotkeyClosePalette = useEffectEvent(() => closePalette());
  const hotkeyToggleSidebar = useEffectEvent(() => toggleSidebarCollapsed());
  const hotkeyToast = useEffectEvent((message: string) => showToast(message));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesShortcut(e, "command-menu")) {
        e.preventDefault();
        commandMenuRef.current?.toggle();
        return;
      }
      if (matchesShortcut(e, "desk")) {
        // Summon/dismiss the Desk overlay. A keyboard summon grows from
        // the center because there is no spatial trigger to connect it to.
        e.preventDefault();
        setDeskOverlay((desk) =>
          desk.open
            ? { ...desk, open: false }
            : { open: true, origin: "center" },
        );
        return;
      }
      if (matchesShortcut(e, "shortcuts-help")) {
        // The one chord whose job is to say what the other chords are, so
        // it opens over whatever is on screen and closes the same way.
        e.preventDefault();
        setShortcutsOpen((o) => !o);
        return;
      }
      if (matchesShortcut(e, "sidebar-toggle")) {
        // Toggle the desktop left sidebar. ⌘B is the panel-toggle
        // convention (VS Code / Slack).
        e.preventDefault();
        hotkeyToggleSidebar();
        return;
      }
      if (matchesShortcut(e, "session-new")) {
        // Start a session in a new workspace — the sidebar "+", by
        // keyboard. ⌘⌥N is the neighbouring chord and deliberately does
        // something else: it opens a sibling session in the workspace you
        // are already in. ⌘S is free to take because there is no document
        // here to save, so the browser's Save does nothing worth keeping.
        e.preventDefault();
        hotkeyOpenPalette();
        return;
      }
      if (matchesShortcut(e, "session-copy-link")) {
        // Let a real text selection copy normally; only hijack the chord
        // when there's a linkable view and nothing is selected. This is
        // why matchesShortcut doesn't preventDefault for us.
        if (window.getSelection?.()?.toString()) return;
        const path = copyLinkPathRef.current;
        if (!path) return;
        e.preventDefault();
        copyToClipboard(absoluteLink(path), () => hotkeyToast("Link copied"));
        return;
      }
      if (e.key === "Escape") {
        if (commandMenuRef.current?.isOpen()) commandMenuRef.current.close();
        else if (paletteOpenRef.current) hotkeyClosePalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpenRef]);

  // The list is the live slice, and archived sessions arrive as summaries, so
  // the row it finds may be missing or partial. Hydrate the route directly,
  // before the list finishes, so a deep link can hand off from the launch
  // splash as soon as its one session is ready.
  const listedSession: UnifiedSession | null =
    route.view === "session"
      ? optimisticSession?.id === route.id
        ? optimisticSession
        : sessions.find(
            (s) => s.id === route.id || s.aliasIds?.includes(route.id),
          ) || null
      : null;
  const currentSession = useHydratedSession(
    route.view === "session" ? route.id : null,
    listedSession,
  );
  // A stale PWA memory yields to home once hydration proves it is archived.
  // Explicit archived deep links have no automatic-restore marker and stay open.
  useEffect(() => {
    if (
      route.view !== "session" ||
      !currentSession?.archived ||
      restoredSessionId !== route.id
    )
      return;
    forgetLastSession();
    navigate({ view: "prs" }, { replace: true });
  }, [
    currentSession?.archived,
    route,
    restoredSessionId,
    forgetLastSession,
    navigate,
  ]);
  const shellLoading = loading && !currentSession;

  // Tear down the launch splash (rendered in index.html) once there is
  // something to draw. Mounting is not that moment: React mounts as soon as the
  // bundle parses, which needs no data, and the app is transparent all the way
  // down (html, body and #root under the desktop shell's window material), so
  // handing the screen over then leaves an empty window rather than a bare one.
  // The desktop shell feels this most, having no service worker to serve the
  // shell or the list from cache, and it shows the window material through the
  // gap: measured at 1.5s on loopback and 9s on a slow poll. The cap keeps a
  // server that never answers from parking anyone behind a splash for good.
  useEffect(() => {
    const splash = document.getElementById("splash");
    let removal: ReturnType<typeof setTimeout> | undefined;
    const hide = () => {
      if (!splash) return;
      splash.classList.add("splash-hide");
      removal = setTimeout(() => splash.remove(), SPLASH_EXIT_MS);
    };
    if (!shellLoading) {
      // The window is only handed over when there is something in it: the
      // desktop shell's vibrancy is gated on this class, and a transparent
      // window with an empty app in it reads as no window at all. The cap
      // below deliberately does not set it, so a server that never answers
      // gets the app's own surface rather than a hole in the desktop.
      document.documentElement.classList.add("app-ready");
      hide();
      return () => clearTimeout(removal);
    }
    const cap = setTimeout(hide, SPLASH_MAX_MS);
    return () => {
      clearTimeout(cap);
      clearTimeout(removal);
    };
  }, [shellLoading]);

  useEffect(() => {
    if (shellLoading) return;
    const timer = setTimeout(() => setLaunchComplete(true), SPLASH_EXIT_MS);
    return () => clearTimeout(timer);
  }, [shellLoading]);

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

  // Stable key the view-tab state (Review/Preview/Assets panes) is stored
  // under: the workspace id, the shared isolated worktree, or the lone session
  // id — the same grouping rule as the tab strip (tabOrderKey below), so a
  // view tab opened in a workspace survives switching between sibling sessions.
  const wsKeyFor = (s: UnifiedSession | null | undefined): string | null =>
    s
      ? s.workspaceId ||
        (s.worktreeDir?.includes("/worktrees/") ? s.worktreeDir : s.id)
      : null;
  // On the session-less workspace route the key is the route's workspace id.
  const routeWorkspaceId = route.view === "workspace" ? route.id : null;
  const routeWorkspace: Workspace | null = routeWorkspaceId
    ? workspaces.find((p) => p.id === routeWorkspaceId) || null
    : null;
  const wsKey = routeWorkspaceId ?? wsKeyFor(currentSession);
  const wsRecord =
    routeWorkspace ??
    (currentSession?.workspaceId
      ? workspaces.find((p) => p.id === currentSession.workspaceId) || null
      : null);
  const reviewDismissed = !!wsKey && reviewClosed.has(wsKey);
  // Review only leads for a session-less PR workspace; with sessions, the main/last
  // session is the landing surface and Review sits at the end of the strip.
  const wsHasLiveSession =
    !!currentSession ||
    (!!wsKey && sessions.some((s) => !s.archived && s.workspaceId === wsKey));
  const defaultSessionView = defaultSessionWorkspaceView(
    wsRecord,
    reviewDismissed,
    wsHasLiveSession,
  );
  const setActiveViewTab = useCallback(
    (tab: ActiveViewTab) => {
      setActiveViewTabState(tab);
      if (wsKey) saveActiveViewTab(wsKey, tab);
    },
    [wsKey],
  );
  const {
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
  } = useOnDemandViewTabs({
    workspaceKey: wsKey,
    activeViewTab,
    setActiveViewTab,
  });
  // Return each workspace to its last foregrounded tab. A workspace without a
  // saved selection still starts on its normal default surface. Switching sessions
  // within a workspace records session as the selection via the tab-strip handler.
  useEffect(() => {
    const remembered = wsKey ? getActiveViewTab(wsKey) : undefined;
    setActiveViewTabState((cur) =>
      // A sub-agent belongs to the open session and is named in the URL, so it
      // isn't this workspace's to restore over. Without this, a link into one
      // lost its pane the moment the workspace record landed and re-ran this.
      cur === "subagent" && routeSubagentStack.length > 0
        ? cur
        : remembered === undefined
          ? defaultSessionView
          : remembered,
    );
  }, [wsKey, defaultSessionView, routeSubagentStack.length]);
  // ...unless we just opened Review for that workspace from the sidebar: once
  // it lands (this render or the one after navigation), foreground Review and
  // consume the pulse. Runs after the reset effect above, so it wins.
  useEffect(() => {
    if (pendingReviewOpen && pendingReviewOpen === wsKey) {
      setActiveViewTab("review");
      setPendingReviewOpen(null);
    }
  }, [wsKey, pendingReviewOpen, setActiveViewTab]);
  // Add the Review view-tab for a workspace. Presence is the OR of reviewOpen
  // and "PR-backed and not in reviewClosed", but reviewClosed alone feeds
  // reviewDismissed (and through it defaultSessionWorkspaceView) — so adding
  // the tab must also clear an earlier dismissal, or the workspace reports a
  // dismissed Review while the Review tab is sitting in the strip.
  function addReviewTab(key: string) {
    setReviewOpen((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    setReviewClosed((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }
  // Landing on the workspace route: foreground its default pane. An explicit
  // /review or /conversation suffix wins; otherwise land in the remembered
  // session (or the main session on first visit). A session-less PR workspace still
  // opens Review. Declared after the wsKey reset effect above so the landing
  // choice wins the same commit.
  // Scalars derived from the route so the effect keys on exactly the values
  // it reacts to (workspace id + explicit tab), not every route object.
  const landingWsKey = route.view === "workspace" ? route.id : null;
  const landingExplicitTab =
    route.view === "workspace" ? (route.tab ?? null) : null;
  useEffect(() => {
    if (
      landingWsKey === null ||
      !workspaceLandingReady(workspacesLoaded, loading)
    )
      return;
    // One-shot: closing the Review tab replaces the URL (dropping /review),
    // which re-runs this effect — without the suppress it would immediately
    // re-seed the default pane and reopen the tab just closed.
    if (suppressWsSeedRef.current) {
      suppressWsSeedRef.current = false;
      return;
    }
    // Ref read: the trigger set is the route + readiness, and the freshest
    // committed list is what a landing decision wants anyway.
    const p = workspacesRef.current.find((x) => x.id === landingWsKey) || null;
    // Default pane by workspace shape: ticket workspaces open on the
    // Conversation; everything else — PR-backed included — lands in its
    // main/last-open session. A PR workspace only defaults to Review when it
    // has no session to land in (the else branch below).
    // Default pane by workspace shape — but a workspace WITH sessions always
    // lands in its main/last-open session (same rule as PR workspaces); the
    // panel (Conversation/Video) is only the landing surface when there is
    // no session to land in. Explicit /conversation-/video URLs still win.
    const hasSession = !!pickLandingSession(
      sessionsRef.current,
      landingWsKey,
      getWorkspaceLastSession(landingWsKey),
    );
    const tab =
      landingExplicitTab ??
      (hasSession
        ? null
        : p?.plainThreadId
          ? "conversation"
          : p?.externalRefs?.some((r) => refWebPanel(r))
            ? "video"
            : null);
    const key = landingWsKey;
    // Landing in the workspace's first session keeps the full session chrome —
    // including the right sidebar — around the foregrounded pane (wsKey is
    // unchanged, so the view-tab reset effect doesn't fire). Session-less
    // workspaces stay on WorkspacePane, which renders its own info panel.
    // An explicit pane URL lands in a LIVE session so the pane keeps the full
    // session chrome. pickLandingSession falls back to the newest archived
    // session to keep a workspace's history reachable, which is right for a
    // bare workspace URL but would resurrect the session a pane-only workspace
    // just closed, so the pane branches take live sessions only.
    const firstSession = () =>
      pickLandingSession(
        sessionsRef.current,
        key,
        getWorkspaceLastSession(key),
      );
    const firstLiveSession = () => {
      const first = firstSession();
      return first && !first.archived ? first : undefined;
    };
    if (tab === "review") {
      addReviewTab(key);
      setActiveViewTab("review");
      const first = firstLiveSession();
      // Something asked for a specific PR (a sidebar row, a `repo#123`
      // chip). The session this workspace normally opens with need not be
      // the one that has it, and the review canvas only offers the PRs of
      // the session it renders — so land on a sibling that carries it.
      // Consumed by seq: only a request made for THIS navigation redirects.
      const focus = reviewFocusPrRef.current;
      const pending =
        focus && landedFocusSeq.current !== focus.seq ? focus : null;
      if (pending) landedFocusSeq.current = pending.seq;
      const carrier =
        pending && first && !sessionCarriesPr(first, pending)
          ? sessionsRef.current.find(
              (s) =>
                !s.archived &&
                s.workspaceId === key &&
                sessionCarriesPr(s, pending),
            )
          : undefined;
      const landOn = carrier ?? first;
      if (landOn)
        navigate({ view: "session", id: landOn.id }, { replace: true });
    } else if (tab === "conversation") {
      setConversationClosed((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setActiveViewTab("conversation");
      const first = firstLiveSession();
      if (first) navigate({ view: "session", id: first.id }, { replace: true });
    } else if (tab === "video") {
      setVideoClosed((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setActiveViewTab("video");
      const first = firstLiveSession();
      if (first) navigate({ view: "session", id: first.id }, { replace: true });
    } else {
      const first = firstSession();
      if (first) {
        // A bare workspace navigation means "open this workspace's session",
        // even if Review was the last non-session pane foregrounded here.
        setActiveViewTab(null);
        navigate({ view: "session", id: first.id }, { replace: true });
      } else if (p && (p.branch || p.prNumber !== undefined)) {
        // Session-less PR/branch workspace: Review is the only meaningful
        // surface, so foreground it like an explicit /review landing.
        addReviewTab(key);
        setActiveViewTab("review");
      }
    }
  }, [
    landingWsKey,
    landingExplicitTab,
    workspacesLoaded,
    loading,
    setActiveViewTab,
    navigate,
  ]);
  // A PR reference (`/pr/<repo>/<number>`) that GitHub doesn't know: the
  // number came out of prose, so it can be a typo or an invention.
  const [prRefMissing, setPrRefMissing] = useState(false);
  // Retired standalone pages (2026-07-24): /pr/…, /support/… and /reviews
  // deep links resolve into the workspace container and redirect (replace).
  // The old components keep rendering as the in-flight/failure fallback, so
  // a failed resolve degrades to the previous behavior instead of a dead
  // link. Bare /reviews goes home — the sidebar bands are the inbox now.
  // Read through an effect event so the redirect doesn't re-run when the
  // refresh closure moves.
  const redirectRefreshWorkspaces = useEffectEvent(refreshWorkspaces);
  useEffect(() => {
    let stale = false;
    const toWorkspace = (
      workspaceId: string,
      tab: "review" | "conversation",
    ) => {
      if (stale) return;
      redirectRefreshWorkspaces();
      navigate({ view: "workspace", id: workspaceId, tab }, { replace: true });
    };
    if (route.view === "pr") {
      setPrRefMissing(false);
      // A deep link (or a fallback that landed here) whose workspace this
      // client already knows resolves without the round-trip, so the review
      // opens rather than the page spending the wait as a spinner.
      const known = findPrWorkspaceId(
        workspacesRef.current,
        sessionsRef.current,
        {
          repo: route.repo,
          ...(route.number !== undefined ? { number: route.number } : {}),
          ...(route.branch !== undefined ? { branch: route.branch } : {}),
        },
      );
      if (known) {
        focusReviewPr({
          repo: route.repo,
          branch: route.branch,
          number: route.number,
          workspaceId: known,
        });
        toWorkspace(known, "review");
        return () => {
          stale = true;
        };
      }
      resolveWorkspaceApi({
        pr: {
          repo: route.repo,
          ...(route.branch !== undefined ? { branch: route.branch } : {}),
          ...(route.number !== undefined ? { number: route.number } : {}),
        },
      })
        .then(({ workspaceId, pr }) => {
          // The workspace is the PR's home, not the PR itself: it holds
          // every PR its sessions opened. Say which one this link meant,
          // or the review opens on whichever came first.
          focusReviewPr({
            repo: pr?.repo ?? route.repo,
            branch: pr?.branch ?? route.branch,
            number: pr?.number ?? route.number,
            workspaceId,
          });
          toWorkspace(workspaceId, "review");
        })
        .catch(() => {
          // Addressed by branch there is still a preview to render; by
          // number alone a failed resolve means no such PR, and the pane
          // has to say so rather than spin.
          if (!stale && route.branch === undefined) setPrRefMissing(true);
        });
    } else if (route.view === "support") {
      resolveWorkspaceApi({ plainThreadId: route.threadId })
        .then(({ workspaceId }) => toWorkspace(workspaceId, "conversation"))
        .catch(() => {});
    } else if (route.view === "reviews") {
      if (!route.id) {
        navigate({ view: "prs" }, { replace: true });
      } else {
        const id = route.id;
        const s = sessionsRef.current.find(
          (x) => x.id === id || x.aliasIds?.includes(id),
        );
        if (s?.workspaceId)
          navigate(
            { view: "workspace", id: s.workspaceId, tab: "review" },
            { replace: true },
          );
        else if (s?.branch)
          resolveWorkspaceApi({
            pr: { repo: s.repo || DEFAULT_REPO_ID, branch: s.branch },
          })
            .then(({ workspaceId }) => toWorkspace(workspaceId, "review"))
            .catch(() => {});
      }
    }
    return () => {
      stale = true;
    };
  }, [route, loading, navigate]);
  // The current code session's Review pane, surfaced as a leftmost view-tab in
  // the top strip (siblings share the worktree/PR, so one Review tab suffices).
  const currentHasWorkspace =
    !!currentSession && sessionHasWorkspace(currentSession);
  // Review renders without a session too: a session-less PR-backed workspace
  // (branch/prNumber on the record) reviews through the preview APIs.
  // A PR is reviewable whether or not the session owns the branch it sits on —
  // a discovered PR (opened on someone else's branch) still has a diff — so it
  // earns the tab on its own.
  const reviewCapable = currentSession
    ? currentHasWorkspace ||
      sessionHasPr(currentSession) ||
      (!!wsRecord && (wsRecord.prNumber !== undefined || !!wsRecord.branch))
    : !!routeWorkspace &&
      Boolean(routeWorkspace.branch || routeWorkspace.prNumber !== undefined);
  // A PR-backed workspace's whole point is its PR, so its Review tab is
  // default-present (leftmost) however you landed — a sidebar PR row, a session
  // deep link, a tab switch — until explicitly dismissed (reviewClosed).
  const prBackedWorkspace =
    !!wsRecord &&
    (wsRecord.prNumber !== undefined || !!wsRecord.key?.startsWith("ghpr-"));
  const conversationThreadId =
    routeWorkspace?.plainThreadId ?? currentSession?.plainThreadId ?? null;
  const [, setFeedMetaTick] = useState(0);
  useEffect(() => {
    void ensureFeedMeta().then(() => setFeedMetaTick((tick) => tick + 1));
  }, []);
  const videoWorkspace =
    routeWorkspace ??
    (currentSession?.workspaceId
      ? (workspaces.find(
          (workspace) => workspace.id === currentSession.workspaceId,
        ) ?? null)
      : null);
  const videoRef = (
    videoWorkspace?.externalRefs ??
    currentSession?.externalRefs ??
    []
  ).find((ref) => refWebPanel(ref));
  const videoPanel = videoRef ? refWebPanel(videoRef) : null;
  const subagentStack = stackFor(currentSession?.id);
  const subagentActive = subagentSelected && subagentStack.length > 0;
  const reviewDotClass = currentSession?.prState
    ? currentSession.prState === "OPEN" &&
      currentSession.prMergeable === "CONFLICTING"
      ? PR_DOT_TONE.CONFLICT
      : (PR_DOT_TONE[currentSession.prState] ?? null)
    : null;
  const paneViewTabs: ViewTab[] = buildWorkspacePaneTabs({
    workspaceKey: wsKey,
    sessionId: currentSession?.id,
    activeViewTab,
    reviewCapable,
    reviewIsDefault: prBackedWorkspace,
    reviewOpen,
    reviewClosed,
    reviewDotClass,
    conversationThreadId,
    conversationClosed,
    videoLabel: videoPanel?.label ?? null,
    videoClosed,
    stagingOpen,
    previewOpen: previewTabOpen,
    portalLabel: currentPortalTarget?.name ?? null,
    assetsOpen,
    terminalOpen,
    subagentLabel: subagentStack.at(-1)?.label ?? null,
  }).map(({ icon, ...tab }) => ({
    ...tab,
    ...(icon === "globe" ? { icon: <IconGlobe size={16} /> } : {}),
  }));

  /**
   * The panes that keep rendering once a workspace has no session left: Review,
   * Conversation and Video hang off the workspace record, so the session-less
   * workspace route (WorkspacePane) can show them alone. Every other tab in the
   * strip is bound to a session and goes with it.
   *
   * Same presence rules as the view tabs above, minus the session. Closing a
   * workspace's last session leaves these behind instead of conjuring a
   * replacement session, and closing the last one of them brings a session back.
   */
  const openWsPanes = sessionlessWorkspacePanes(wsKey, wsRecord, {
    reviewOpen,
    reviewClosed,
    conversationClosed,
    videoClosed,
    hasWebPanel: (workspace) =>
      !!workspace.externalRefs?.some((ref) => refWebPanel(ref)),
  });

  function selectViewTab(id: string) {
    // The workspace home has no pane of its own: it is what the strip shows
    // with no view tab foregrounded.
    if (id.startsWith("home:")) {
      setActiveViewTab(null);
      if (route.view === "workspace" && route.tab)
        navigate({ view: "workspace", id: route.id }, { replace: true });
      return;
    }
    const tab = viewTabKind(id);
    if (!tab) return;
    setActiveViewTab(tab);
    if (
      route.view === "workspace" &&
      (tab === "review" || tab === "conversation" || tab === "video")
    )
      navigate({ view: "workspace", id: route.id, tab }, { replace: true });
  }
  // Foreground/dismiss the Review view-tab; onOpenReview re-adds a dismissed
  // one (fired by the PR status chip / "open PR" affordances in SessionViewer).
  function openReview() {
    if (!wsKey) return;
    // Also un-dismisses a PR-backed workspace's default-present tab.
    addReviewTab(wsKey);
    setActiveViewTab("review");
  }
  function closeReviewTab() {
    if (wsKey) {
      const key = wsKey;
      setReviewOpen((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      // PR-backed workspaces show Review by default — record the dismissal
      // or the tab pops right back.
      setReviewClosed((prev) => {
        if (prev.has(key)) return prev;
        return new Set(prev).add(key);
      });
    }
    // Only fall back to session if Review was the foregrounded pane — closing the
    // Review tab while the Preview environment is active leaves it up.
    if (reviewActive) setActiveViewTab(null);
  }
  // Foreground this workspace's Conversation view-tab (the Plain ticket
  // thread); re-adds a dismissed one.
  function openConversation() {
    if (!wsKey) return;
    const key = wsKey;
    setConversationClosed((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setActiveViewTab("conversation");
  }
  function closeConversationTab() {
    if (wsKey) {
      const key = wsKey;
      setConversationClosed((prev) => {
        if (prev.has(key)) return prev;
        return new Set(prev).add(key);
      });
    }
    if (conversationActive) setActiveViewTab(null);
  }
  function closeVideoTab() {
    if (wsKey) {
      const key = wsKey;
      setVideoClosed((prev) => {
        if (prev.has(key)) return prev;
        return new Set(prev).add(key);
      });
    }
    if (videoActive) setActiveViewTab(null);
  }
  // Sidebar PR row → the PR's ONE workspace (resolve-or-create server-side,
  // adopt-don't-duplicate), landing on THAT PR's Review tab: the row is a pull
  // request, so its diff is what you clicked for. The focus pulse matters when
  // the workspace carries several PRs — each has its own row, and without it
  // they'd all land on the primary. Falls back to the legacy preview routes if
  // the resolve fails, so a click is never dead.
  const openPrWorkspace = async (item: ReviewQueueItem) => {
    await (async () => {
      const { workspaceId } = await resolveWorkspaceApi({
        pr: {
          repo: item.pr.repo,
          number: item.pr.number,
          branch: item.pr.branch,
          title: item.pr.title,
        },
      });
      // The resolved workspace can be session-less, so wait for the active
      // workspace payload to carry it before routing to its Review pane.
      await refreshWorkspaces();
      focusReviewPr({
        repo: item.pr.repo,
        branch: item.pr.branch,
        number: item.pr.number,
        workspaceId,
      });
      navigate({ view: "workspace", id: workspaceId, tab: "review" });
    })().catch(async () => {
      if (item.sessionId) navigate({ view: "reviews", id: item.sessionId });
      else navigate({ view: "pr", repo: item.pr.repo, branch: item.pr.branch });
    });
  };
  const openPrReview = async (pr: OpenPr) => {
    await (async () => {
      const { workspaceId } = await resolveWorkspaceApi({
        pr: {
          repo: pr.repo,
          number: pr.number,
          branch: pr.branch,
          title: pr.title,
        },
      });
      await refreshWorkspaces();
      focusReviewPr({
        repo: pr.repo,
        branch: pr.branch,
        number: pr.number,
        workspaceId,
      });
      navigate({ view: "workspace", id: workspaceId, tab: "review" });
    })().catch(async () => {
      navigate({ view: "pr", repo: pr.repo, branch: pr.branch });
    });
  };
  // Sidebar feed row (a video, a dashboard, …) to the item's ONE workspace, its web
  // panel foregrounded (the feeds design).
  const openFeedItemWorkspace = async (
    feed: FeedDescriptor,
    item: FeedItem,
  ) => {
    await (async () => {
      const { workspaceId } = await resolveWorkspaceApi({
        externalRef: {
          kind: feed.refKind,
          id: item.id,
          ...(item.url ? { url: item.url } : {}),
          title: item.title,
        },
        name: item.title,
      });
      refreshWorkspaces();
      navigate({ view: "workspace", id: workspaceId, tab: "video" });
    })().catch(async (e) => {
      console.error("Feed item open failed:", e);
    });
  };
  // Sidebar Support row → the ticket's ONE workspace, Conversation tab. The
  // row's title rides along as the workspace-name hint (no Plain round-trip).
  const openTicketWorkspace = async (t: SupportThread) => {
    await (async () => {
      const { workspaceId } = await resolveWorkspaceApi({
        plainThreadId: t.id,
        name: t.title || t.customer.name || t.customer.email || undefined,
      });
      refreshWorkspaces();
      navigate({ view: "workspace", id: workspaceId, tab: "conversation" });
    })().catch(async () => {
      navigate({ view: "support", threadId: t.id });
    });
  };
  // Open a session's Review tab from the sidebar: select it and foreground its
  // workspace's Review once it lands (pendingReviewOpen survives the
  // workspace-change reset).
  const openReviewForSession = (session: UnifiedSession) => {
    const key = wsKeyFor(session);
    if (!key) return;
    setReviewOpen((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    setPendingReviewOpen(key);
    navigate({ view: "session", id: session.id });
  };
  useLayoutEffect(() => {
    currentSessionRef.current = currentSession;
  });

  // Mark the open session read up to its latest activity — both when it's first
  // opened and as new activity streams in while it stays open — so the sidebar's
  // unread flag clears for whatever you're currently looking at.
  const currentSessionId = currentSession?.id;
  const currentSessionActivity = currentSession?.lastActivity;
  useEffect(() => {
    if (currentSessionId && currentSessionActivity !== undefined)
      markRead(currentSessionId, currentSessionActivity);
  }, [currentSessionId, currentSessionActivity]);

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
      moved.has(id) ? (queue.shift() as string) : id,
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
      ...(mode === "ask"
        ? {
            branch: null,
            worktreeDir: null,
            mode: "ask" as const,
          }
        : {}),
    };
    // Commit the local shell before changing the route. Without this boundary,
    // the route can render against the previous list and keep the old session's
    // conversation visible until the create response arrives.
    if (newTabMorphTimer.current) clearTimeout(newTabMorphTimer.current);
    flushSync(() => {
      inject(draft, { sticky: true });
      setOptimisticSession(draft);
      setPendingSessionId(id);
      setPendingNewWorkspace(false);
      setNewTabMorph(morphOrigin ? { id, origin: morphOrigin } : null);
    });
    if (morphOrigin)
      newTabMorphTimer.current = setTimeout(() => {
        setNewTabMorph((current) => (current?.id === id ? null : current));
        newTabMorphTimer.current = undefined;
      }, 260);
    clearTimeout(pendingTimer.current);
    pendingTimer.current = setTimeout(() => {
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
    openPrefilledSession({
      ...(prompt ? { prompt } : {}),
      repo: src.repo || workspace?.repo,
      ...(src.workspaceId
        ? {
            workspaceId: src.workspaceId,
            modelWorkspaceId: src.workspaceId,
          }
        : {}),
      // Sharing starts from the workspace's branch. Omitting the branch for
      // a stack keeps NewSession on "New branch", which the create path
      // resolves as a stacked worktree after the first prompt is sent.
      ...(mode === "share" && (src.branch || workspace?.branch)
        ? { branch: src.branch || workspace?.branch }
        : {}),
      ...(mode === "ask" ? { mode: "ask" as const } : {}),
    });
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
      openPrefilledSession({
        workspaceId: route.id,
        repo: workspace?.repo,
        branch: workspace?.branch,
        // Feed workspaces without a repo start in Scratch.
        ...(workspace?.externalRefs?.length && !workspace.repo
          ? { mode: "scratch" as const }
          : {}),
      });
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
        const editable = (e.target as HTMLElement | null)?.closest(
          "input, textarea, select, [contenteditable='true'], [contenteditable='']",
        );
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
  }, [showToast, reopenLastArchivedRef, closeSessionRef]);

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

  // Plain title shown in the top bar for non-session views (session routes let
  // the SessionViewer portal its own header in instead). It names the route,
  // and the page under it still carries its own title: these are pages, not
  // chats. A route left blank here collapses the bar (`.detail-topbar:empty`),
  // which is right only for a page that brings a bar of its own: Reports heads
  // both of its columns, Analytics its charts. Anywhere else a blank leaves the
  // window with no titlebar to drag in the desktop shell.
  const topbarTitle: string =
    route.view === "archived"
      ? "Archived"
      : route.view === "tasks"
        ? "Tasks"
        : route.view === "feed"
          ? "Feed"
          : route.view === "prs"
            ? "Pull requests"
            : route.view === "new"
              ? "New session"
              : // A PR opened by number is on its way to a workspace. It brings no
                // bar of its own while it resolves, so name it here instead of
                // leaving the window with nothing to drag by.
                route.view === "pr" && route.number !== undefined
                ? `${repoLabel(route.repo)} #${route.number}`
                : route.view === "workspace"
                  ? routeWorkspace
                    ? [
                        routeWorkspace.repo
                          ? repoLabel(routeWorkspace.repo)
                          : null,
                        routeWorkspace.name,
                      ]
                        .filter(Boolean)
                        .join(" › ")
                    : "Workspace"
                  : "";

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
  const currentTheme = effectiveTheme();
  const commandActions: CommandPaletteAction[] = [
    {
      id: "new-session",
      label: "New session",
      description: "Start a new ask or code session",
      category: "Actions",
      keywords: ["create", "session", "workspace"],
      shortcut: shortcutPrimaryKeys("session-new") ?? undefined,
      icon: <IconPlus size={18} />,
      run: () => openPalette(),
    },
    ...(currentSession
      ? [
          ...(!currentSession.desk
            ? [
                {
                  id: "new-session-workspace",
                  label: "New session in this workspace",
                  description: "Share the current workspace and worktree",
                  category: "Actions" as const,
                  keywords: ["tab", "conversation", "sibling"],
                  shortcut:
                    shortcutPrimaryKeys("session-new-sibling") ?? undefined,
                  icon: <IconPlus size={18} />,
                  run: () => void handleNewSession("share"),
                },
              ]
            : []),
          ...(nextChatAvailable
            ? [
                {
                  id: "next-unread-workspace",
                  label: "Next chat",
                  description:
                    "Open the next chat, prioritizing work that needs attention",
                  category: "Navigate" as const,
                  keywords: ["next", "unread", "ready", "attention"],
                  shortcut:
                    shortcutPrimaryKeys("workspace-next-unread") ?? undefined,
                  icon: <IconChevronRight size={18} />,
                  run: () => nextChatRef.current(),
                },
              ]
            : []),
          {
            id: "copy-transcript",
            label: "Copy conversation",
            description: "Copy a concise version of the current transcript",
            category: "Actions" as const,
            keywords: ["transcript", "clipboard"],
            shortcut:
              shortcutPrimaryKeys("session-copy-transcript") ?? undefined,
            icon: <IconCopy size={18} />,
            run: () =>
              void copySessionTranscript(currentSession, "concise", showToast),
          },
          {
            id: currentSession.archived
              ? "unarchive-session"
              : "archive-session",
            label: currentSession.archived
              ? "Unarchive current session"
              : "Archive current session",
            description: currentSession.archived
              ? "Return this session to the active workspace"
              : "Close this session and keep it recoverable in Archived",
            category: "Actions" as const,
            keywords: currentSession.archived
              ? ["restore", "open"]
              : ["close", "remove"],
            shortcut: shortcutPrimaryKeys("session-archive") ?? undefined,
            icon: <IconArchive size={18} />,
            run: () =>
              void (currentSession.archived
                ? unarchiveSession(currentSession)
                : closeSession(currentSession)),
          },
        ]
      : []),
    ...(restorableArchived.length
      ? [
          {
            id: "reopen-archived",
            label: "Reopen closed session",
            description:
              restorableArchived.length > 1
                ? `Bring back the ${restorableArchived.length} sessions you just archived`
                : `Bring back "${restorableArchived[0].title || "the session you just archived"}"`,
            category: "Actions" as const,
            keywords: ["unarchive", "restore", "undo", "closed", "reopen"],
            shortcut: shortcutPrimaryKeys("session-reopen") ?? undefined,
            icon: <IconUnarchive size={18} />,
            run: () => void reopenLastArchived(),
          },
        ]
      : []),
    ...(copyLinkPath
      ? [
          {
            id: "copy-link",
            label: "Copy link to current view",
            description:
              "Copy a shareable link to this session, workspace, or PR",
            category: "Actions" as const,
            keywords: ["url", "share", "clipboard"],
            shortcut: shortcutPrimaryKeys("session-copy-link") ?? undefined,
            icon: <IconCopy size={18} />,
            run: () =>
              copyToClipboard(absoluteLink(copyLinkPath), () =>
                showToast("Link copied"),
              ),
          },
        ]
      : []),
    {
      id: "tasks",
      label: "Tasks",
      description: "Open your task list",
      category: "Actions",
      keywords: ["todos", "tasks"],
      icon: <IconListCircles size={18} />,
      run: () => navigate({ view: "tasks" }),
    },
    {
      id: "desk",
      label: "Open Desk",
      description: "Open the standing concierge session",
      category: "Actions",
      keywords: ["concierge", "assistant"],
      shortcut: shortcutPrimaryKeys("desk") ?? undefined,
      icon: <IconDesk size={18} />,
      run: () => setDeskOverlay({ open: true, origin: "center" }),
    },
    {
      id: "toggle-sidebar",
      label: sidebarCollapsed ? "Show sidebar" : "Hide sidebar",
      description: "Toggle the workspace sidebar",
      category: "Actions",
      keywords: ["toggle", "panel", "navigation"],
      shortcut: shortcutPrimaryKeys("sidebar-toggle") ?? undefined,
      icon: <IconSidebarLeft size={18} />,
      run: toggleSidebarCollapsed,
    },
    {
      id: "toggle-theme",
      label: `Switch to ${currentTheme === "dark" ? "light" : "dark"} mode`,
      description: `Current appearance: ${currentTheme}`,
      category: "Actions",
      keywords: ["toggle", "theme", "appearance", "dark", "light"],
      icon: <IconMoon size={18} />,
      run: () => setThemePref(currentTheme === "dark" ? "light" : "dark"),
    },
    {
      id: "system-theme",
      label: "Use system appearance",
      description: "Match your device's light or dark mode",
      category: "Actions",
      keywords: ["system", "automatic", "theme", "appearance"],
      icon: <IconMoon size={18} />,
      run: () => setThemePref("system"),
    },
    {
      id: "prs",
      label: "Pull requests",
      description: "Open the pull request list",
      category: "Navigate",
      icon: <IconPullRequest size={18} />,
      run: () => navigate({ view: "prs" }),
    },
    {
      id: "feed",
      label: "Feed",
      description: "Open what the team has been shipping",
      category: "Navigate",
      icon: <IconFeed size={18} />,
      run: () => navigate({ view: "feed" }),
    },
    // Catch up is offered at phone widths only (lib/sidebar-tools.ts), so
    // the palette doesn't offer it where the sidebar doesn't.
    ...(isPhone
      ? ([
          {
            id: "catch-up",
            label: "Catch up",
            description: "Swipe through unread workspaces",
            category: "Navigate",
            keywords: ["unread", "inbox"],
            icon: <IconStack size={18} />,
            run: () => navigate({ view: "catchup" }),
          },
        ] as CommandPaletteAction[])
      : []),
    ...(isPhone
      ? ([
          {
            id: "support-tinder",
            label: "Support Tinder",
            description: "Triage the Plain todo queue",
            category: "Navigate",
            keywords: ["tickets", "plain", "support"],
            icon: <IconInbox size={18} />,
            run: () => navigate({ view: "supporttinder" }),
          },
        ] as CommandPaletteAction[])
      : []),
    {
      id: "support",
      label: "Support",
      description: "Read and answer Plain tickets",
      category: "Navigate",
      keywords: ["tickets", "plain", "inbox"],
      icon: <IconMail size={18} />,
      run: () => navigate({ view: "plain" }),
    },
    {
      id: "reports",
      label: "Reports",
      description: "Open recurring automation reports",
      category: "Navigate",
      icon: <IconFile size={18} />,
      run: () => navigate({ view: "reports" }),
    },
    {
      id: "analytics",
      label: "Analytics",
      description: "Sessions, tokens, models, and PRs over time",
      category: "Navigate",
      icon: <IconChart size={18} />,
      run: () => navigate({ view: "analytics" }),
    },
    {
      id: "reviews",
      label: "Reviews",
      description: "Open the pull request review queue",
      category: "Navigate",
      keywords: ["pull requests", "code review"],
      icon: <IconListCircles size={18} />,
      run: () => navigate({ view: "reviews" }),
    },
    {
      id: "automations",
      label: "Automations",
      description: "Manage scheduled and event-triggered routines",
      category: "Navigate",
      keywords: ["routines", "scheduled"],
      icon: <IconWrench size={18} />,
      run: () => navigate({ view: "automations" }),
    },
    {
      id: "goals",
      label: "Goals",
      description: "Manage long-running missions",
      category: "Navigate",
      icon: <IconListCircles size={18} />,
      run: () => navigate({ view: "goals" }),
    },
    {
      id: "security",
      label: "Security",
      description: "Open security scans and findings",
      category: "Navigate",
      icon: <IconBook size={18} />,
      run: () => navigate({ view: "security" }),
    },
    {
      id: "archived",
      label: "Archived",
      description: "Browse closed conversations",
      category: "Navigate",
      keywords: ["history", "closed"],
      icon: <IconArchive size={18} />,
      run: () => navigate({ view: "archived" }),
    },
    {
      id: "settings",
      label: "Settings",
      description: `Configure ${PRODUCT_NAME}`,
      category: "Navigate",
      keywords: ["preferences", "appearance", "connections"],
      icon: <IconGear size={18} />,
      run: () => navigate({ view: "settings" }),
    },
    // Every Settings section, straight from the nav's own table — the palette
    // used to reach three of them, and only because those three happen to have
    // their own top-level routes.
    ...settingsPaletteActions({ admin: auth?.admin !== false }).map(
      ({ section, ...action }) => ({
        ...action,
        run: () => navigate({ view: "settings", section }),
      }),
    ),
  ];
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
  ) => {
    const surfaceId = requestedSurfaceId ?? viewerSession.id;
    const pendingSocket = surfaceId === pendingSessionId;
    const sessionSocket = pendingSocket
      ? socket.sessionSocketIgnoringMessages
      : socket.sessionSocket;
    return (
      // A `#5528` written anywhere in this pane's transcript means a PR in the
      // pane's OWN repo — which is why the context is per pane rather than
      // app-wide: a split view can hold two sessions on two different repos.
      <SessionPaneProviders
        key={viewerSession.id}
        repo={viewerSession.repo}
        socket={sessionSocket}
      >
        <SessionViewer
          key={viewerSession.id}
          session={viewerSession}
          composer={{
            setTyping: socket.setTyping,
            resetSeq: focused ? newSessionSeq : 0,
            autoFocus: focused && focusComposerOnOpen,
            prefill: sessionComposerPrefills[viewerSession.id] ?? null,
            onPrefillConsumed: (seq) =>
              setSessionComposerPrefills((prev) => {
                const cur = prev[viewerSession.id];
                if (!cur || cur.seq !== seq) return prev;
                const next = { ...prev };
                delete next[viewerSession.id];
                return next;
              }),
          }}
          availability={{
            canRepairSafety: auth?.admin === true,
            canOpenPr: true,
            canOpenNextChat: focused && nextChatAvailable,
            canStartNewSession: !viewerSession.desk && !emptyWorkspaceSession,
            canOpenNewWorkspace: true,
            canOpenSession: true,
            canOpenReview: true,
            canOpenAssets: true,
            canOpenPortal: true,
            canOpenWorkspace: true,
          }}
          lifecycle={{
            connected: socket.connected && !pendingSocket,
            pendingCreation:
              focused &&
              route.view === "session" &&
              route.id === pendingSessionId,
            optimisticEmpty:
              !pendingNewWorkspace &&
              focused &&
              route.view === "session" &&
              route.id === pendingSessionId,
            initialPending: pendingInitialPrompts[viewerSession.id],
            onArchive: () => {
              if (focused) sidebarRef.current?.archiveSelected();
              else closeSession(viewerSession);
            },
            onArchived: () => {
              // Only fires when the viewer archived on its own — with onArchive
              // passed (a focused pane) it defers to the sidebar path instead, so
              // this can't double-record.
              rememberArchived([viewerSession.id]);
            },
            onRunningChange: handleSessionRunningChange,
            onReviewChange: (id, request) =>
              patch(id, { reviewRequest: request ?? undefined }),
            onRename: async (id, title) => {
              await (async () => {
                await renameSessionApi(id, title);
              })().catch(async (error) => {
                console.error("Rename failed:", error);
              });
              refresh();
            },
          }}
          chrome={{
            focused,
            hideHeader: splitMode && !focused,
            hideRightPanel: splitMode && !focused,
            topbarEl: focused ? topbarEl : null,
            headerActionsEl: focused ? headerActionsEl : null,
            headerModelEl: focused ? headerModelEl : null,
            headerRepoEl: focused ? headerRepoEl : null,
            rightPanelEl: focused ? rightPanelEl : null,
          }}
          workspace={{
            workspaceSessions,
            onSetStatus: setSessionLanes,
            allSessions: sessions,
            // Mirrors SessionTabs' own "render nothing" rule so the header's
            // lone-tab + never doubles up with the strip's — and, just as
            // important, so it APPEARS whenever the strip doesn't. Closed
            // sessions are not part of the rule: they live in the strip's
            // history button when there is a strip and in the header's ⋯ menu
            // when there isn't, so counting them here would leave a lone
            // session with neither + .
            tabStripVisible,
            archivedSessions,
            onRestoreSession: restoreSession,
            workspaceName: activeWorkspaceId
              ? (workspaces.find((project) => project.id === activeWorkspaceId)
                  ?.name ?? viewerSession.workspaceName)
              : undefined,
            onRenameWorkspace: activeWorkspaceId
              ? (name) => renameWorkspace(activeWorkspaceId, name)
              : undefined,
            onArchiveWorkspace: activeWorkspaceId
              ? () => archiveWorkspaceFromHeader(workspaceSessions)
              : undefined,
            onDeleteWorkspace: activeWorkspaceId
              ? () => deleteWorkspaceFromHeader(activeWorkspaceId)
              : undefined,
          }}
          viewTabs={{
            showReview: splitMode
              ? viewTabKind(surfaceId) === "review"
              : focused && reviewActive,
            showConversation: splitMode
              ? viewTabKind(surfaceId) === "conversation"
              : focused && conversationActive,
            conversationThreadId,
            showVideo: splitMode
              ? viewTabKind(surfaceId) === "video"
              : focused && videoActive,
            videoPanel,
            videoTitle: videoRef?.title || null,
            showStaging: splitMode
              ? viewTabKind(surfaceId) === "staging"
              : focused && stagingActive,
            showAssets: splitMode
              ? viewTabKind(surfaceId) === "assets"
              : focused && assetsActive,
            showTerminal: splitMode
              ? viewTabKind(surfaceId) === "terminal"
              : focused && terminalActive,
            // Presence, not foreground: the shells stay mounted behind whatever
            // else is in front, and only unmount when the tab is closed.
            terminalTabOpen: !!wsKey && terminalOpen.has(wsKey),
            showPreviewTab: splitMode
              ? viewTabKind(surfaceId) === "preview"
              : focused && previewLiveActive,
            showPortal: splitMode
              ? viewTabKind(surfaceId) === "portal"
              : focused && portalActive,
            portalTarget: currentPortalTarget,
            reviewFocusPr,
            onCloseStaging: closeStagingTab,
            onClosePreviewTab: closePreviewTab,
            onCloseAssets: closeAssetsTab,
            onCloseTerminal: closeTerminalTab,
          }}
          subagents={{
            // The sub-agent drill-in, opened from this pane's own transcript.
            showSubagent: splitMode
              ? viewTabKind(surfaceId) === "subagent"
              : focused && subagentActive,
            subagentStack: stackFor(viewerSession.id),
            onOpenSubagent: openSubagent,
            onSubagentBack: popSubagent,
            onSubagentLabel: nameSubagent,
            parentSession: viewerSession.parentSessionId
              ? (() => {
                  const parent = sessions.find(
                    (session) => session.id === viewerSession.parentSessionId,
                  );
                  return parent
                    ? {
                        id: parent.id,
                        title: parent.title,
                        model: parent.model,
                      }
                    : null;
                })()
              : null,
            workerSessions: sessions
              .filter((session) => session.parentSessionId === viewerSession.id)
              .map((session) => ({
                id: session.id,
                title: session.title,
                model: session.model,
                isRunning: session.isRunning,
              })),
          }}
        />
      </SessionPaneProviders>
    );
  };

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
            {/* Mobile-only top bar. On the sidebar-root page the organization icon
				    opens the same switcher as the full sidebar row; on a pushed page a Back
				    chevron pops back to the root, iOS-style. On desktop this bar is hidden.
				    The catch-up deck renders its own header (back + "N Left" + new-workspace), so we
				    suppress this one there to avoid a duplicate back bar. */}
            {route.view !== "catchup" && (
              <TopBar
                as="header"
                ref={setAppHeaderEl}
                className={cn(
                  appHeader({
                    detail: mobileDetail,
                    floating:
                      route.view === "prs" ||
                      route.view === "feed" ||
                      route.view === "session",
                  }),
                  route.view === "archived" && ARCHIVED_SEARCH_HEADER,
                )}
              >
                <TopBarLeading className="shrink-0">
                  {mobileDetail ? (
                    <TopBarBack
                      floating
                      onClick={goBack}
                      aria-label={
                        route.view === "session" &&
                        currentSession?.parentSessionId
                          ? "Back to the session that started this one"
                          : "Back to sidebar"
                      }
                    />
                  ) : (
                    <>
                      <OrganizationSwitcher
                        variant="topbar"
                        connected={connected}
                        onOpenSettings={(section) =>
                          navigate({ view: "settings", section })
                        }
                      />
                      <UpdatePill addHandler={addHandler} variant="pill" />
                    </>
                  )}
                </TopBarLeading>
                {/* Centered page title on pushed pages, iOS-sheet style. Sessions
					    show the workspace name (per-session titles live on the tabs) plus a
					    working dot while the engine runs; other views show their plain
					    title. Desktop hides the whole bar.
					    A page that heads itself and leaves `topbarTitle` blank (Analytics,
					    Reports) gets no pill at all: an empty one is a white lozenge with
					    nothing in it.
					    A page that heads itself and DOES have a title here keeps the pill
					    but not its ink: it fades in once its own heading has scrolled
					    under this bar, which is the large-title move on the platform it
					    was borrowed from. A session names a thing rather than a page, so
					    its pill is always up. */}
                {mobileDetail && (route.view === "session" || topbarTitle) && (
                  <span
                    data-shown={
                      route.view === "session" ||
                      phoneTitleHandedOver ||
                      undefined
                    }
                    className={cn(
                      route.view === "session" && currentSession
                        ? `${HEADER_TITLE_PILL_TAPPABLE} session-settings-trigger`
                        : HEADER_TITLE_PILL,
                      route.view !== "session" && HEADER_TITLE_PILL_FADE,
                      route.view === "archived" && HEADER_TITLE_PILL_CENTERED,
                    )}
                    {...(route.view === "session" && currentSession
                      ? {
                          role: "button",
                          tabIndex: 0,
                          onClick: () =>
                            window.dispatchEvent(
                              new Event("opensession:toggle-session-settings"),
                            ),
                        }
                      : {})}
                  >
                    {/* Slack-header layout: the repo tile leads the pill (portaled in
							    by SessionViewer), or the archive mark replaces it for archived
							    sessions. The name sits over model · cost. The whole pill is one
							    tap target that opens the session's deeper info page. */}
                    {route.view === "session" && currentSession && (
                      <span
                        className={HEADER_TITLE_REPO}
                        ref={setHeaderRepoEl}
                      />
                    )}
                    <span className={HEADER_TITLE_COL}>
                      <span className={HEADER_TITLE_ROW}>
                        <OverflowFadeText className={HEADER_TITLE_TEXT}>
                          {route.view === "session"
                            ? // A worker names ITSELF here. The workspace name is what
                              // its parent shows, so borrowing it would leave the two
                              // reading identically with nothing to say you had gone a
                              // level down. Desktop says the same thing as a crumb.
                              currentSession?.parentSessionId
                              ? currentSession.title
                              : (activeWorkspaceId
                                  ? workspaces.find(
                                      (p) => p.id === activeWorkspaceId,
                                    )?.name
                                  : undefined) ||
                                currentSession?.title ||
                                ""
                            : topbarTitle}
                        </OverflowFadeText>
                        {currentSession &&
                          sessionWasAgentStarted(currentSession) && (
                            <IconRobot
                              size={16}
                              className="shrink-0 text-faint"
                              aria-label="Started by an agent"
                            />
                          )}
                      </span>
                      {route.view === "session" &&
                        currentSession && (
                          // Filled by SessionViewer's portal (compact model selector).
                          <span
                            className={HEADER_TITLE_MODEL}
                            ref={setHeaderModelEl}
                          />
                        )}
                    </span>
                  </span>
                )}
                <TopBarActions
                  className={
                    mobileDetail
                      ? APP_HEADER_ACTIONS_DETAIL
                      : APP_HEADER_ACTIONS
                  }
                  ref={setHeaderActionsEl}
                >
                  {/* On the root page the actions slot is otherwise empty (session
						    actions only portal in on pushed pages) — it carries Search,
						    which lives in the top bar on phones instead of the sidebar.
						    The Desk rides the bottom-right FAB cluster instead. */}
                  {!mobileDetail && (
                    <button
                      className={MOBILE_SEARCH_BTN}
                      onClick={() => commandMenuRef.current?.open()}
                      aria-label="Open command menu"
                    >
                      <IconSearch size={22} />
                    </button>
                  )}
                </TopBarActions>
              </TopBar>
            )}

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
                {/* `sidebar-container` stays on the markup as a hook: base.css's
					    platform chrome (html.material-backdrop, the reduced-transparency
					    fallback) paints this surface by name. */}
                <div
                  ref={sidebarColRef}
                  className={cn(
                    "sidebar-container flex min-h-0 shrink-0 flex-col bg-sidebar [--sidebar-icon-left:16px]",
                    // Desktop and the exposed workspace gutter share one chrome
                    // material, so opaque sticky headers scroll over the exact same
                    // surface instead of revealing a gradient seam. No
                    // backdrop-filter: since the shell went opaque the blur sampled
                    // nothing but our own flat background while forcing the
                    // compositor to re-rasterize the whole sidebar on any repaint
                    // behind it (a scroll-flash amplifier).
                    "desktop:[background:linear-gradient(var(--sidebar-material),var(--sidebar-material)),var(--sidebar-bg)]",
                    // On phones the sidebar is the root PAGE of the iOS-style
                    // stack — full bleed under the pushed detail pane — rather than
                    // a fixed-width column.
                    isPhone
                      ? "absolute inset-0 z-[1] w-full"
                      : "relative w-[var(--sidebar-w,280px)]",
                    // Collapsed hides the whole left column; on phones the page
                    // stack owns the sidebar and the class is inert.
                    sidebarCollapsed && "desktop:hidden",
                  )}
                  style={
                    {
                      "--sidebar-w": `${sidebarWidth}px`,
                    } as React.CSSProperties
                  }
                >
                  {/* Desktop chrome row — identical on web and in the desktop shell
						    (the shell additionally insets it past the traffic lights and
						    makes it a drag region): collapse toggle on the left,
						    back/forward + search at the right edge. Organization identity
						    now leads the sidebar itself, above Feed. Hidden on mobile,
						    where navigation uses the floating top bar instead. */}
                  {/* `sidebar-brand` / `sidebar-brand-actions` stay as hooks: base.css
						    drives the WCO/desktop-shell chrome off them (traffic-light
						    inset). `wco-chrome` is what makes the row a window drag
						    region there.
						    The brand trigger carries its own 8px of left padding, so the
						    row pulls its own in to keep the logo on the list icons'
						    --sidebar-icon-left column. */}
                  <div
                    className={cn(
                      "sidebar-brand wco-chrome h-[var(--desktop-header-h)] min-w-0 shrink-0 items-center justify-start gap-2 py-0 pr-3 pl-[calc(var(--sidebar-icon-left)-8px)]",
                      // No scroll hairline: the tools sit fixed below this row and
                      // only the workspace list scrolls, so nothing passes under it.
                      // The brand row (and its account menu) is a desktop
                      // affordance; on phones the top bar carries the brand
                      // instead. Gated in JS rather than at `phone:` because
                      // Tailwind's max-* is `width < 720`, one pixel short of the
                      // `max-width: 720px` the rest of the app means by "phone".
                      isPhone ? "hidden" : "flex",
                    )}
                  >
                    <div className="sidebar-brand-actions flex shrink-0 items-center gap-2">
                      <Tooltip
                        label="Hide sidebar"
                        side="bottom"
                        shortcut={sidebarToggleKeys ?? undefined}
                      >
                        {/* Padding box, matching .viewer-code-icon exactly, so the
									    sidebar's chrome row and the session header's icon
									    cluster read as one system. */}
                        <button
                          className={cn(
                            SIDEBAR_CHROME_BTN,
                            "inline-flex px-[5px] py-[3px]",
                          )}
                          onClick={toggleSidebarCollapsed}
                          aria-label="Hide sidebar"
                        >
                          {panelIcon}
                        </button>
                      </Tooltip>
                    </div>
                    <TitleBar onSearch={() => commandMenuRef.current?.open()} />
                  </div>
                  <Sidebar
                    ref={sidebarRef}
                    sessions={sessions}
                    registeredRepos={registeredRepoInfo.map((repo) => repo.id)}
                    directToMainBranches={Object.fromEntries(
                      registeredRepoInfo
                        .filter((repo) => repo.sharedCheckout)
                        .map((repo) => [repo.id, repo.defaultBranch]),
                    )}
                    sessionsError={sessionsError}
                    sessionsLoading={loading}
                    onRetrySessions={() => void refresh()}
                    workspaceDataReady={!loading && workspacesLoaded}
                    workspaces={workspaces}
                    teamViewing={teamViewing}
                    // Selection is navigation state, not hydrated session data. The
                    // route changes synchronously when a row opens; waiting for detail
                    // hydration makes the old row look selected while the new session
                    // is already loading.
                    selectedId={
                      route.view === "session"
                        ? (listedSession?.id ?? route.id)
                        : null
                    }
                    prsActive={route.view === "prs"}
                    feedActive={route.view === "feed"}
                    connected={connected}
                    tasksActive={route.view === "tasks"}
                    taskCount={taskCount}
                    selectedWorkspaceId={sidebarWorkspaceId}
                    plainActive={route.view === "plain"}
                    supportTinderActive={route.view === "supporttinder"}
                    reportsActive={route.view === "reports"}
                    analyticsActive={route.view === "analytics"}
                    showDraftRow={
                      productEmpty && githubConnectionState !== "loading"
                    }
                    draftRowActive={productEmpty && route.view === "prs"}
                    onRenameWorkspace={renameWorkspaceFromSidebar}
                    onDeleteWorkspace={deleteWorkspaceFromSidebar}
                    onToast={showToast}
                    // Only hand the sidebar the top-bar actions slot on the root
                    // page — on a pushed page (session, etc.) the sidebar is still
                    // mounted underneath and would portal its filter button into
                    // the session's top bar.
                    headerActionsEl={mobileDetail ? null : headerActionsEl}
                    catchUpActive={route.view === "catchup"}
                    onNextChatAvailableChange={setNextChatAvailable}
                    archivedActive={route.view === "archived"}
                    onArchive={archiveSessionFromSidebar}
                    onArchiveWorkspace={archiveWorkspaceFromSidebar}
                    onRename={async (s, title) => {
                      await (async () => {
                        await renameSessionApi(s.id, title);
                      })().catch(async (e) => {
                        console.error("Rename failed:", e);
                      });
                      refresh();
                    }}
                    onSetStatus={setSessionLanes}
                  />
                  {/* Drag the right edge to resize: a hover/active hairline over a
						    wider invisible grab strip. Hidden on mobile, where the drawer
						    is a fixed width. It sits above both primary (20) and nested
						    (15) sticky headers so the hairline stays one uninterrupted
						    edge while the list scrolls. */}
                  <div
                    className={cn(
                      "absolute top-0 right-[-3px] z-30 h-full w-[7px] cursor-col-resize after:absolute after:top-0 after:right-[3px] after:h-full after:w-[2px] after:bg-transparent after:transition-[background] after:content-[''] hover:after:bg-line-strong [body.resizing-sidebar_&]:after:bg-faint",
                      isPhone && "hidden",
                    )}
                    onMouseDown={startSidebarResize}
                    aria-hidden="true"
                  />
                </div>

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
                              route.view === "prs" && "ml-4 flex-1 pl-0",
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
                      style={
                        activeTabSplit
                          ? ({
                              "--split-preview-share": `${
                                (splitDropSide === "left"
                                  ? activeTabSplit.ratio
                                  : 1 - activeTabSplit.ratio) * 100
                              }%`,
                            } as React.CSSProperties)
                          : undefined
                      }
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

export function App(props: AppProps = {}) {
  return (
    <EffectRegistryProvider>
      <AppContent {...props} />
    </EffectRegistryProvider>
  );
}

// The marketing-site preview imports this component into its own fixture root.
// Keep the ordinary SPA bootstrap intact for every production build, including
// servers that still have this file configured as the bundle entry.
const embeddedDemo = (
  window as typeof window & { __OPENSESSION_DEMO__?: boolean }
).__OPENSESSION_DEMO__;
if (!embeddedDemo) {
  // The preview interstitial renders INSTEAD of the app (and outside UserGate —
  // it must work in cold-storage contexts like the iOS PWA's in-app browser).
  const previewWaitSessionId = matchPreviewWaitRoute(location.pathname);
  const transcriptMotionFixture = transcriptMotionFixtureOptions(
    location.pathname,
    location.search,
  );
  // `reducedMotion="user"` makes every `motion.*` component honour the OS
  // setting. Motion's default is "never", so without this the CSS blanket in
  // legacy.css would quietly cover only half the app — Motion animates inline
  // styles off the main thread, where a `transition-duration` override can't
  // reach it. "user" (rather than forcing it off) is also the right shape:
  // Motion keeps opacity and drops transform/layout, which is the "gentler,
  // not zero" behaviour this preference actually asks for.
  createRoot(document.getElementById("root")!).render(
    <MotionConfig reducedMotion="user">
      {transcriptMotionFixture ? (
        <TranscriptMotionLab
          initialSeed={transcriptMotionFixture.seed}
          speed={transcriptMotionFixture.speed}
          profile={transcriptMotionFixture.profile}
        />
      ) : previewWaitSessionId ? (
        <PreviewWait sessionId={previewWaitSessionId} />
      ) : (
        <TooltipProvider>
          <>
            <App />
            <AgentationFeedback />
          </>
        </TooltipProvider>
      )}
    </MotionConfig>,
  );
}
