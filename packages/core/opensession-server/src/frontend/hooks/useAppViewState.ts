import type { RefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CommandMenuHandle } from "../components/CommandMenuHost";
import { getCurrentUser } from "../components/UserPicker";
import {
  getActiveViewTabKeys,
  type ActiveViewTab,
} from "../lib/active-view-tab";
import { resolveWorkspaceApi } from "../lib/api";
import type { Route } from "../lib/app-route";
import { resolveAnonymousUserPath } from "../lib/auth-ready";
import { BASE_PATH } from "../lib/base";
import { findPrWorkspaceId } from "../lib/pr-workspace";
import { onTabSplitChanged } from "../lib/split-tabs";
import { onTabOrderChanged } from "../lib/tab-order";
import type { UnifiedSession, Workspace } from "../lib/types";
import {
  requestReviewFocus,
  type ReviewFocus,
} from "../lib/workspace-pane-state";
import { useSubagentTabs } from "./useSubagentTabs";
import type { useWebSocket } from "./useWebSocket";

interface UseAppViewStateOptions {
  route: Route;
  navigate: ReturnType<typeof import("./useAppRoute").useAppRoute>["navigate"];
  sessionsRef: RefObject<UnifiedSession[]>;
  workspacesRef: RefObject<Workspace[]>;
  refreshWorkspaces: () => Promise<void>;
  openPrRef: RefObject<(repo: string, number: number) => void>;
  addHandler: ReturnType<typeof useWebSocket>["addHandler"];
}

export function useAppViewState({
  route,
  navigate,
  sessionsRef,
  workspacesRef,
  refreshWorkspaces,
  openPrRef,
  addHandler,
}: UseAppViewStateOptions) {
  // A "new tab" while a session is open is a *new session in that same session*, not
  // a whole new session — so it must NOT pop the new-session palette. It's a
  // visual fresh-start (one thread under the hood): bumping this counter tells the
  // open SessionViewer to clear its composer and scroll to the live edge. With no
  // session open there's nothing to stay in, so it falls back to the palette.
  const [newSessionSeq] = useState(0);
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
  /** The workspace it was resolved against, so a later visit to another
   *  workspace can't be retargeted by an older request. */
  const [reviewFocusPr, setReviewFocusPr] = useState<ReviewFocus | null>(null);
  const reviewFocusPrRef = useRef(reviewFocusPr);
  useLayoutEffect(() => {
    reviewFocusPrRef.current = reviewFocusPr;
  });
  // The `seq` the workspace landing effect has already used to pick a session
  // (below). Without it a stale request would keep redirecting every later
  // visit to this workspace's Review.
  const landedFocusSeq = useRef<number | null>(null);
  const takePendingReviewFocus = () => {
    const focus = reviewFocusPrRef.current;
    if (!focus || landedFocusSeq.current === focus.seq) return null;
    landedFocusSeq.current = focus.seq;
    return focus;
  };
  const focusReviewPr = (focus: Omit<ReviewFocus, "seq">) => {
    requestReviewFocus(setReviewFocusPr, focus);
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
        const data: unknown = await res.json();
        const todos =
          typeof data === "object" && data !== null && "todos" in data
            ? data.todos
            : undefined;
        if (!stale) setTaskCount(Array.isArray(todos) ? todos.length : 0);
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

  return {
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
    setReviewFocusPr,
    takePendingReviewFocus,
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
  };
}
