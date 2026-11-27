import { useLayoutEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { archiveSessionApi, deleteSessionApi } from "../lib/api";
import type { ActiveViewTab } from "../lib/active-view-tab";
import type { Route } from "../lib/app-route";
import { sessionNeverRan } from "../lib/landing-session";
import type { OpenNextSidebarItem } from "../lib/sidebar-types";
import type { UnifiedSession } from "../lib/types";
import type { WorkspacePaneTab } from "../lib/workspace-pane-tabs";

type SessionLifecycleParams = {
  route: Route;
  navigate: (next: Route, opts?: { replace?: boolean }) => void;
  goBack: () => void;
  currentSession: UnifiedSession | null;
  workspaceSessions: UnifiedSession[];
  activeWorkspaceId: string | null;
  openWsPanes: WorkspacePaneTab[];
  activeViewTab: ActiveViewTab;
  setActiveViewTab: (tab: ActiveViewTab) => void;
  pendingSessionId: string | null;
  pendingTimer: RefObject<ReturnType<typeof setTimeout> | undefined>;
  abandonedSessionCreatesRef: RefObject<Set<string>>;
  suppressWsSeedRef: RefObject<boolean>;
  setPendingSessionId: Dispatch<SetStateAction<string | null>>;
  setOptimisticSession: Dispatch<SetStateAction<UnifiedSession | null>>;
  setHiddenEmptySessionIds: Dispatch<SetStateAction<Set<string>>>;
  patch: (id: string, patch: Partial<UnifiedSession>) => void;
  inject: (session: UnifiedSession, opts?: { sticky?: boolean }) => void;
  remove: (id: string) => void;
  unstick: (id: string) => void;
  refresh: () => void;
  confirmRunningClose: (session: UnifiedSession, onConfirm: () => void) => void;
  confirmRunningCloses: (
    sessions: UnifiedSession[],
    onConfirm: () => void,
  ) => void;
  rememberArchived: (ids: string[]) => void;
  dropStalePins: (sessions: UnifiedSession[]) => void;
  openNewSessionInWorkspace: (
    src: UnifiedSession,
    mode: "share" | "stack" | "ask",
    prompt?: string,
  ) => void;
};

export function useSessionLifecycle({
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
}: SessionLifecycleParams) {
  /** Un-archive a closed session, back among the workspace's tabs. Shared by
   *  the strip's history button and the header ⋯ menu that stands in for it. */
  async function restoreSession(s: UnifiedSession) {
    await (async () => {
      await archiveSessionApi(s.id, false);
    })().catch(async (e) => {
      console.error("Restore failed:", e);
    });
    refresh();
  }

  // Close a tab = archive the session: it leaves the strip and the active list,
  // but stays recoverable from Archived. An empty session that never ran has
  // nothing to recover, so it's deleted outright instead of cluttering
  // Archived. The local list updates before the request returns so closing
  // feels instant. Shared by the tab ×, the tab context menu, and ⌘W.
  const closeSessionNow = async (
    s: UnifiedSession,
    preferredNext?: UnifiedSession,
  ) => {
    const neverRan = s.source === "opensession" && sessionNeverRan(s);
    const pendingCreate = neverRan && s.id === pendingSessionId;
    const wasOpen = currentSession?.id === s.id;
    // No split bookkeeping here: a closed tab stops being live, so the split
    // resolves without it, and collapses on its own once a bar is emptied.
    // Leaving the id in the record means restoring the session later puts it
    // back in the bar it was closed from.
    const next = wasOpen
      ? (preferredNext ?? workspaceSessions.find((c) => c.id !== s.id))
      : null;
    // Closing the last session doesn't have to conjure a new one: a workspace
    // pane (Review, Conversation, Video) renders without a session, so the
    // strip is left holding just that tab. The foregrounded pane wins, so
    // closing the session you were reading Review beside stays on Review.
    const survivingPane =
      wasOpen && !next && activeWorkspaceId
        ? (openWsPanes.find((pane) => pane === activeViewTab) ??
          openWsPanes[0] ??
          null)
        : null;
    const needsNewSessionComposer = wasOpen && !next && !survivingPane;
    if (pendingCreate) {
      // The create response owns cleanup from here. Mark it abandoned before
      // removing the optimistic shell so a late response cannot resurrect it.
      abandonedSessionCreatesRef.current.add(s.id);
      clearTimeout(pendingTimer.current);
      setPendingSessionId(null);
      setOptimisticSession(null);
      unstick(s.id);
    }
    if (neverRan) {
      remove(s.id);
    } else {
      patch(s.id, { archived: true, archivedReason: "manual" });
    }
    if (wasOpen) {
      if (next) navigate({ view: "session", id: next.id });
      else if (survivingPane && activeWorkspaceId) {
        setActiveViewTab(survivingPane);
        // The pane is already open, so the workspace landing has nothing to
        // decide: arm its one-shot suppress.
        suppressWsSeedRef.current = true;
        navigate({
          view: "workspace",
          id: activeWorkspaceId,
          tab: survivingPane,
        });
      }
    }
    try {
      if (neverRan && !pendingCreate) await deleteSessionApi(s.id, false);
      else if (!neverRan) {
        await archiveSessionApi(s.id, true);
        rememberArchived([s.id]);
      }
    } catch (e) {
      console.error("Close failed:", e);
      if (neverRan) {
        setHiddenEmptySessionIds((hidden) => {
          if (!hidden.has(s.id)) return hidden;
          const next = new Set(hidden);
          next.delete(s.id);
          return next;
        });
        inject(s);
      } else {
        patch(s.id, { archived: false, archivedReason: undefined });
      }
      if (wasOpen) navigate({ view: "session", id: s.id });
      return;
    }
    if (wasOpen && needsNewSessionComposer && activeWorkspaceId) {
      navigate({ view: "workspace", id: activeWorkspaceId });
      openNewSessionInWorkspace(s, "share");
    }
    refresh();
  };
  const closeSession = (s: UnifiedSession) =>
    confirmRunningClose(s, () => void closeSessionNow(s));
  const deleteSessionFromTab = async (
    session: UnifiedSession,
    cleanWorktree: boolean,
  ) => {
    const wasOpen = currentSession?.id === session.id;
    const next = wasOpen
      ? workspaceSessions.find((candidate) => candidate.id !== session.id)
      : undefined;
    await deleteSessionApi(session.id, cleanWorktree);
    remove(session.id);
    if (wasOpen) {
      if (next) navigate({ view: "session", id: next.id });
      else if (activeWorkspaceId)
        navigate({ view: "workspace", id: activeWorkspaceId });
      else goBack();
    }
    refresh();
  };

  const archiveSessionFromSidebar = (
    s: UnifiedSession,
    openNext: OpenNextSidebarItem | null,
  ) => {
    const archive = async () => {
      const wasOpen = route.view === "session" && route.id === s.id;
      if (wasOpen && !openNext?.()) goBack();
      patch(s.id, {
        archived: true,
        archivedReason: "manual",
      });
      try {
        await archiveSessionApi(s.id, true);
        rememberArchived([s.id]);
      } catch (e) {
        console.error("Archive failed:", e);
        patch(s.id, {
          archived: false,
          archivedReason: undefined,
        });
        if (wasOpen) navigate({ view: "session", id: s.id });
        return;
      }
      dropStalePins([s]);
      refresh();
    };
    confirmRunningClose(s, () => void archive());
  };

  const archiveSessionsFromCatchUp = (sessions: UnifiedSession[]) => {
    const archive = async () => {
      await (async () => {
        await Promise.all(sessions.map((c) => archiveSessionApi(c.id, true)));
        // Swiping through the deck archives fast — one entry per
        // card keeps ⌘Z an undo of the last swipe, not of the
        // whole session.
        rememberArchived(sessions.map((c) => c.id));
      })().catch(async (e) => {
        console.error("Archive failed:", e);
      });
      refresh();
    };
    confirmRunningCloses(sessions, () => void archive());
  };

  const closeSessionRef = useRef(closeSession);
  useLayoutEffect(() => {
    closeSessionRef.current = closeSession;
  });

  return {
    closeSessionNow,
    closeSession,
    deleteSessionFromTab,
    restoreSession,
    archiveSessionFromSidebar,
    archiveSessionsFromCatchUp,
    closeSessionRef,
  };
}
