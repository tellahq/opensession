import type { RefObject } from "react";
import {
  createElement,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useState,
} from "react";
import { refWebPanel } from "../components/FeedWebPane";
import { IconGlobe } from "../components/icons";
import {
  getActiveViewTab,
  saveActiveViewTab,
  type ActiveViewTab,
} from "../lib/active-view-tab";
import { resolveWorkspaceApi, type OpenPr } from "../lib/api";
import type { Route } from "../lib/app-route";
import { DEFAULT_REPO_ID } from "../lib/brand";
import { ensureFeedMeta } from "../lib/feeds-meta";
import {
  defaultSessionWorkspaceView,
  pickLandingSession,
  workspaceLandingReady,
} from "../lib/landing-session";
import { findPrWorkspaceId } from "../lib/pr-workspace";
import { markRead } from "../lib/reads";
import type { ReviewQueueItem } from "../lib/review-queue";
import { sessionCarriesPr, sessionHasPr } from "../lib/session-prs";
import { PR_DOT_TONE } from "../lib/session-tab-classes";
import type { ViewTab } from "../lib/session-tabs-types";
import { sessionHasWorkspace } from "../lib/session-workspace";
import type {
  FeedDescriptor,
  FeedItem,
  SupportThread,
  UnifiedSession,
  Workspace,
} from "../lib/types";
import { getWorkspaceLastSession } from "../lib/workspace-last-session";
import { addReviewTab, requestReviewFocus } from "../lib/workspace-pane-state";
import {
  buildWorkspacePaneTabs,
  sessionlessWorkspacePanes,
  viewTabKind,
} from "../lib/workspace-pane-tabs";
import type { useAppRoute } from "./useAppRoute";
import type { useAppViewState } from "./useAppViewState";
import { useOnDemandViewTabs } from "./useOnDemandViewTabs";

interface UseWorkspacePanesOptions {
  route: Route;
  navigate: ReturnType<typeof useAppRoute>["navigate"];
  sessions: UnifiedSession[];
  workspaces: Workspace[];
  currentSession: UnifiedSession | null;
  loading: boolean;
  workspacesLoaded: boolean;
  refreshWorkspaces: () => Promise<void>;
  sessionsRef: RefObject<UnifiedSession[]>;
  workspacesRef: RefObject<Workspace[]>;
  currentSessionRef: RefObject<UnifiedSession | null>;
  viewState: ReturnType<typeof useAppViewState>;
}

export function useWorkspacePanes({
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
  viewState,
}: UseWorkspacePanesOptions) {
  const {
    activeViewTab,
    setActiveViewTabState,
    reviewActive,
    conversationActive,
    videoActive,
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
    stackFor,
    pendingReviewOpen,
    setPendingReviewOpen,
    setReviewFocusPr,
    takePendingReviewFocus,
    focusReviewPr,
    suppressWsSeedRef,
  } = viewState;
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
    [wsKey, setActiveViewTabState],
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
  }, [
    wsKey,
    defaultSessionView,
    routeSubagentStack.length,
    setActiveViewTabState,
  ]);
  // ...unless we just opened Review for that workspace from the sidebar: once
  // it lands (this render or the one after navigation), foreground Review and
  // consume the pulse. Runs after the reset effect above, so it wins.
  useEffect(() => {
    if (pendingReviewOpen && pendingReviewOpen === wsKey) {
      setActiveViewTab("review");
      setPendingReviewOpen(null);
    }
  }, [wsKey, pendingReviewOpen, setActiveViewTab, setPendingReviewOpen]);
  // Add the Review view-tab for a workspace. Presence is the OR of reviewOpen
  // and "PR-backed and not in reviewClosed", but reviewClosed alone feeds
  // reviewDismissed (and through it defaultSessionWorkspaceView) — so adding
  // the tab must also clear an earlier dismissal, or the workspace reports a
  // dismissed Review while the Review tab is sitting in the strip.
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
  // Read through an effect event: takePendingReviewFocus consumes a one-shot
  // request set by a sidebar click, and its identity is not part of what
  // should re-run this landing effect (only the route/readiness trigger set
  // below does).
  const takePendingReviewFocusEvent = useEffectEvent(takePendingReviewFocus);
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
      addReviewTab(setReviewOpen, setReviewClosed, key);
      setActiveViewTab("review");
      const first = firstLiveSession();
      // Something asked for a specific PR (a sidebar row, a `repo#123`
      // chip). The session this workspace normally opens with need not be
      // the one that has it, and the review canvas only offers the PRs of
      // the session it renders — so land on a sibling that carries it.
      // Consumed by seq: only a request made for THIS navigation redirects.
      const pending = takePendingReviewFocusEvent();
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
        addReviewTab(setReviewOpen, setReviewClosed, key);
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
    suppressWsSeedRef,
    workspacesRef,
    sessionsRef,
    setReviewOpen,
    setReviewClosed,
    setConversationClosed,
    setVideoClosed,
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
      const prIdentity = {
        repo: route.repo,
        number: route.number,
        branch: route.branch,
      };
      const known = findPrWorkspaceId(
        workspacesRef.current,
        sessionsRef.current,
        prIdentity,
      );
      if (known) {
        requestReviewFocus(setReviewFocusPr, {
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
      resolveWorkspaceApi({ pr: prIdentity })
        .then(({ workspaceId, pr }) => {
          // The workspace is the PR's home, not the PR itself: it holds
          // every PR its sessions opened. Say which one this link meant,
          // or the review opens on whichever came first.
          requestReviewFocus(setReviewFocusPr, {
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
  }, [route, loading, navigate, workspacesRef, sessionsRef, setReviewFocusPr]);
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
  }).map(({ icon, ...tab }) =>
    icon === "globe"
      ? { ...tab, icon: createElement(IconGlobe, { size: 16 }) }
      : tab,
  );

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
    addReviewTab(setReviewOpen, setReviewClosed, wsKey);
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
          url: item.url,
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

  return {
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
  };
}
